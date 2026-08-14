import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGraphServiceProcessLauncher,
  type GraphServiceConnection,
} from "../../packages/service-client/src/index.js";
import { connectToGraphServiceWithCacheRootForTests } from "../../packages/service-client/src/connection.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";
import { openSqliteGraphStore } from "../../packages/adapters/store-sqlite/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";

const roots: string[] = [];
const clients: GraphServiceConnection[] = [];
const requireFromStorePackage = createRequire(
  path.resolve("packages/adapters/store-sqlite/package.json"),
);

/** 进程级写竞争测试所需的最小原生 SQLite 连接。 */
interface RawSqliteDatabase {
  close: () => void;
  exec: (source: string) => RawSqliteDatabase;
  pragma: (source: string) => unknown;
  prepare: (source: string) => {
    run: (...parameters: unknown[]) => unknown;
  };
}

/** 从 store-sqlite 自身依赖边界解析的原生 SQLite 构造器。 */
interface RawSqliteConstructor {
  new (databasePath: string): RawSqliteDatabase;
}

const RawSqlite = requireFromStorePackage("better-sqlite3") as RawSqliteConstructor;

afterEach(async () => {
  const trackedClients = clients.splice(0);
  const servicePids = [...new Set(trackedClients.map((client) => client.metadata.pid))];
  let shutdownRequested = false;
  for (const client of trackedClients) {
    if (!shutdownRequested) {
      try {
        await client.shutdown();
        shutdownRequested = true;
        continue;
      } catch {
        /** 当前连接可能已因断言失败关闭；继续尝试同一服务的其他已跟踪连接。 */
      }
    }
    await client.close().catch(() => undefined);
  }
  await Promise.all(trackedClients.map((client) => client.close().catch(() => undefined)));
  for (const servicePid of servicePids) {
    await stopTrackedTestService(servicePid);
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  })));
}, 40_000);

describe("real graph-service process", () => {
  it(
    "runs public rebuild through a shared process and persists only builtin-filtered hierarchy",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      await access(graphServiceEntry);
      const indexingRoot = await createShortTempRoot("r1");
      const cacheRoot = await createShortTempRoot("c1");
      const outsideRoot = await createShortTempRoot("o1");
      roots.push(indexingRoot, cacheRoot, outsideRoot);
      await mkdir(path.join(indexingRoot, "src"));
      await writeFile(path.join(indexingRoot, "src", "index.ts"), "export {};\n");
      const excludedDirectories = [
        ".git",
        ".pnpm/pkg",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".cache",
        ".generated",
        "__generated__",
        "build",
        "coverage",
        "dist",
        "generated",
        "node_modules/pkg",
        "out",
      ];
      for (const relativeDirectory of excludedDirectories) {
        const absoluteDirectory = path.join(
          indexingRoot,
          ...relativeDirectory.split("/"),
        );
        await mkdir(absoluteDirectory, { recursive: true });
        await writeFile(path.join(absoluteDirectory, "excluded.js"), "x\n");
      }
      await writeFile(path.join(outsideRoot, "secret.ts"), "export {};\n");
      await symlink(
        outsideRoot,
        path.join(indexingRoot, "outside-link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      const common = {
        clientVersion: "0.0.0-bootstrap-process-test",
        indexingRoot,
        launcher,
        pollIntervalMs: 10,
        startTimeoutMs: 10_000,
        trust: { isTrusted: true },
      } as const;
      const first = await connectToGraphServiceWithCacheRootForTests(common, cacheRoot);
      const second = await connectToGraphServiceWithCacheRootForTests(common, cacheRoot);
      clients.push(first, second);

      const queued = await first.startRebuild();
      expect(queued.job).toMatchObject({ kind: "initial-index", state: "queued" });
      const status = await waitForTerminalStatus(second, queued.job.id);
      expect(status).toMatchObject({
        availability: "available",
        committed: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: 2,
          graphRevision: 1,
          indexedFileCount: 1,
          nodeCount: 3,
        },
        lastIndexJob: { state: "succeeded" },
        graphRevision: 1,
      });
      expect(status.committed?.excludedPathCount).toBeGreaterThanOrEqual(
        excludedDirectories.length,
      );

      const workspacePaths = createWorkspacePaths(first.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
        rootBindingKey: first.identity.physicalRootKey,
      });
      const publicPayload = JSON.stringify({ queued, status });
      expect(publicPayload).not.toContain(indexingRoot);
      expect(publicPayload).not.toContain(cacheRoot);
      expect(publicPayload).not.toContain("export {}");
      const serviceLog = await readFile(
        path.join(workspacePaths.workspaceDirectory, "service.log"),
        "utf8",
      );
      expect(serviceLog).not.toContain(indexingRoot);
      expect(serviceLog).not.toContain(cacheRoot);
      expect(serviceLog).not.toContain("export {}");
      await first.shutdown();
      await waitForMissing(workspacePaths.metadataPath);
      const store = await openSqliteGraphStore({
        databasePath: path.join(workspacePaths.workspaceDirectory, "graph.sqlite"),
        digestPort: { digest: sha256CanonicalJson },
        workspaceKey: first.identity.workspaceKey,
      });
      try {
        expect(store.listNodePaths()).toEqual(["", "src", "src/index.ts"]);
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "persists extends and paths module facts through the real process and keeps failures atomic",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      await access(graphServiceEntry);
      const indexingRoot = await createShortTempRoot("r6");
      const cacheRoot = await createShortTempRoot("c6");
      roots.push(indexingRoot, cacheRoot);
      await mkdir(path.join(indexingRoot, "configs"), { recursive: true });
      await mkdir(path.join(indexingRoot, "src"), { recursive: true });
      const baseConfigPath = path.join(indexingRoot, "configs", "base.json");
      await writeFile(baseConfigPath, JSON.stringify({
        compilerOptions: {
          baseUrl: "..",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          paths: { "@dep": ["src/dep.ts"] },
        },
      }));
      await writeFile(
        path.join(indexingRoot, "tsconfig.json"),
        JSON.stringify({ extends: "./configs/base.json", include: ["src/**/*.ts"] }),
      );
      await writeFile(
        path.join(indexingRoot, "src", "index.ts"),
        "import { value } from '@dep';\nvoid value;\n",
      );
      await writeFile(path.join(indexingRoot, "src", "dep.ts"), "export const value = 1;\n");
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      const client = await connectToGraphServiceWithCacheRootForTests(
        {
          clientVersion: "0.0.0-module-process-test",
          indexingRoot,
          launcher,
          pollIntervalMs: 10,
          requestTimeoutMs: 15_000,
          startTimeoutMs: 10_000,
          trust: { isTrusted: true },
        },
        cacheRoot,
      );
      clients.push(client);
      const workspacePaths = createWorkspacePaths(client.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
        rootBindingKey: client.identity.physicalRootKey,
      });

      const initial = await client.startRebuild();
      // 公共状态保留 hierarchy 树计数；模块 edge 与 Evidence 在下方直接读取 SQLite 验证。
      expect(await waitForTerminalStatus(client, initial.job.id)).toMatchObject({
        committed: {
          edgeCount: 3,
          graphRevision: 1,
          indexedFileCount: 2,
          nodeCount: 4,
        },
        freshness: "current",
        graphRevision: 1,
        lastIndexJob: { state: "succeeded" },
      });

      // 根外 baseUrl 必须经公共进程协议分类为扫描失败，并保留已提交模块 revision。
      await writeFile(baseConfigPath, JSON.stringify({
        compilerOptions: {
          baseUrl: "../..",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          paths: { "@dep": ["outside/dep.ts"] },
        },
      }));
      const failedJob = await client.startRebuild();
      expect(await waitForTerminalStatus(client, failedJob.job.id)).toMatchObject({
        committed: { graphRevision: 1 },
        freshness: "stale",
        graphRevision: 1,
        lastIndexJob: {
          error: { code: "GRAPH_SCAN_FAILED" },
          resultGraphRevision: 1,
          state: "failed",
        },
      });

      await client.shutdown();
      await waitForMissing(workspacePaths.metadataPath);
      const store = await openSqliteGraphStore({
        databasePath: path.join(workspacePaths.workspaceDirectory, "graph.sqlite"),
        digestPort: { digest: sha256CanonicalJson },
        workspaceKey: client.identity.workspaceKey,
      });
      try {
        const snapshot = store.readCommittedSnapshot();
        const dependencyNode = snapshot.allNodes?.find((node) =>
          node.kind === "file" && node.relativePath === "src/dep.ts");
        expect(dependencyNode).toBeDefined();
        expect(snapshot.graphRevision).toBe(1);
        expect(snapshot.allEdges?.filter((edge) => edge.relationType === "imports"))
          .toEqual([expect.objectContaining({ toId: dependencyNode?.id })]);
        expect(snapshot.allEvidence).toHaveLength(1);
        expect(store.readBootstrapState()).toMatchObject({
          committed: { graphRevision: 1 },
          freshness: "stale",
          lastJob: {
            id: failedJob.job.id,
            resultGraphRevision: 1,
            state: "failed",
          },
        });
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "keeps the control plane available but fails first rebuild for .codegraphignore",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      await access(graphServiceEntry);
      const indexingRoot = await createShortTempRoot("r2");
      const cacheRoot = await createShortTempRoot("c2");
      roots.push(indexingRoot, cacheRoot);
      await writeFile(path.join(indexingRoot, ".codegraphignore"), "dist/\n", "utf8");
      await writeFile(path.join(indexingRoot, "index.ts"), "export {};\n", "utf8");
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      const client = await connectToGraphServiceWithCacheRootForTests(
        {
          clientVersion: "0.0.0-ignore-process-test",
          indexingRoot,
          launcher,
          pollIntervalMs: 10,
          startTimeoutMs: 10_000,
          trust: { isTrusted: true },
        },
        cacheRoot,
      );
      clients.push(client);

      await expect(client.startRebuild()).rejects.toMatchObject({
        code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
      });
      await expect(client.status()).resolves.toMatchObject({
        availability: "absent",
        committed: null,
        currentIndexJob: null,
        lastIndexJob: {
          error: { code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED" },
          state: "failed",
        },
      });
      const workspacePaths = createWorkspacePaths(client.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
        rootBindingKey: client.identity.physicalRootKey,
      });
      await client.shutdown();
      await waitForMissing(workspacePaths.metadataPath);
    },
    30_000,
  );

  it(
    "reports a process-level write failure, then persists an empty builtin-filtered rebuild",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      await access(graphServiceEntry);
      const indexingRoot = await createShortTempRoot("r3");
      const cacheRoot = await createShortTempRoot("c3");
      roots.push(indexingRoot, cacheRoot);
      await mkdir(path.join(indexingRoot, "node_modules", "pkg"), { recursive: true });
      await writeFile(path.join(indexingRoot, "node_modules", "pkg", "index.js"), "x\n");
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      const client = await connectToGraphServiceWithCacheRootForTests(
        {
          clientVersion: "0.0.0-empty-process-test",
          indexingRoot,
          launcher,
          pollIntervalMs: 10,
          requestTimeoutMs: 30_000,
          startTimeoutMs: 10_000,
          trust: { isTrusted: true },
        },
        cacheRoot,
      );
      clients.push(client);
      const workspacePaths = createWorkspacePaths(client.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
        rootBindingKey: client.identity.physicalRootKey,
      });
      const competingWriter = new RawSqlite(
        path.join(workspacePaths.workspaceDirectory, "graph.sqlite"),
      );
      competingWriter.pragma("journal_mode = WAL");
      competingWriter.exec("BEGIN IMMEDIATE");
      try {
        await expect(client.startRebuild()).rejects.toMatchObject({
          code: "GRAPH_WRITE_FAILED",
        });
      } finally {
        competingWriter.exec("ROLLBACK");
        competingWriter.close();
      }
      expect(await client.status()).toMatchObject({
        availability: "absent",
        committed: null,
        currentIndexJob: null,
        lastIndexJob: {
          error: { code: "GRAPH_WRITE_FAILED" },
          state: "failed",
        },
      });

      const queued = await client.startRebuild();
      const status = await waitForTerminalStatus(client, queued.job.id);
      expect(status).toMatchObject({
        availability: "available",
        committed: {
          edgeCount: 0,
          indexedFileCount: 0,
          nodeCount: 1,
        },
        completeness: "empty",
        freshness: "current",
        graphRevision: 1,
        lastIndexJob: { state: "succeeded" },
      });
      expect(status.committed?.excludedPathCount).toBeGreaterThanOrEqual(1);
      await client.shutdown();
      await waitForMissing(workspacePaths.metadataPath);
    },
    60_000,
  );

  it(
    "reuses one Windows Named Pipe service across two independent client processes",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      const serviceClientEntry = path.resolve("packages/service-client/dist/index.js");
      const workerEntry = path.resolve("tests/fixtures/service-client-process.mjs");
      await access(graphServiceEntry);
      await access(serviceClientEntry);
      const indexingRoot = await createShortTempRoot("r4");
      const cacheRoot = await createShortTempRoot("c4");
      roots.push(indexingRoot, cacheRoot);
      const config = { cacheRoot, graphServiceEntry, indexingRoot };
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      let controller: GraphServiceConnection | null = null;
      try {
        const [first, second] = await Promise.all([
          runClientProcess(workerEntry, config),
          runClientProcess(workerEntry, config),
        ]);

        expect(first.pid).toBe(second.pid);
        expect(first.serviceInstanceId).toBe(second.serviceInstanceId);
        expect(first.statusEpoch).toBe(second.statusEpoch);
        expect(first.endpointKind).toBe(
          process.platform === "win32" ? "named-pipe" : "unix-socket",
        );

        controller = await connectToGraphServiceWithCacheRootForTests(
          {
            clientVersion: "0.0.0-controller-test",
            indexingRoot,
            launcher,
            pollIntervalMs: 10,
            startTimeoutMs: 10_000,
            trust: { isTrusted: true },
          },
          cacheRoot,
        );
        expect(controller.metadata.pid).toBe(first.pid);
        expect(controller.initializeResult.serviceStatus.serviceInstanceId).toBe(
          first.serviceInstanceId,
        );
      } finally {
        controller ??= await connectToGraphServiceWithCacheRootForTests(
          {
            clientVersion: "0.0.0-cleanup-test",
            indexingRoot,
            launcher,
            pollIntervalMs: 10,
            startTimeoutMs: 10_000,
            trust: { isTrusted: true },
          },
          cacheRoot,
        ).catch(() => null);
        if (controller !== null) {
          const workspacePaths = createWorkspacePaths(controller.identity.workspaceKey, {
            cacheRoot,
            platform: process.platform,
            rootBindingKey: controller.identity.physicalRootKey,
          });
          await controller.shutdown().catch(async () => controller?.close());
          await waitForMissing(workspacePaths.metadataPath).catch(() => undefined);
        }
      }
    },
    30_000,
  );

  it(
    "keeps the old revision readable across stale CAS, failure, atomic switch, and shutdown cancel",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      await access(graphServiceEntry);
      const indexingRoot = await createShortTempRoot("r5");
      const cacheRoot = await createShortTempRoot("c5");
      roots.push(indexingRoot, cacheRoot);
      await mkdir(path.join(indexingRoot, "src"));
      await writeFile(path.join(indexingRoot, "src", "index.ts"), "export const value = 1;\n");
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      const common = {
        clientVersion: "0.0.0-revision-process-test",
        indexingRoot,
        launcher,
        pollIntervalMs: 10,
        requestTimeoutMs: 15_000,
        startTimeoutMs: 15_000,
        trust: { isTrusted: true },
      } as const;
      const first = await connectToGraphServiceWithCacheRootForTests(common, cacheRoot);
      const second = await connectToGraphServiceWithCacheRootForTests(common, cacheRoot);
      clients.push(first, second);
      const workspacePaths = createWorkspacePaths(first.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
        rootBindingKey: first.identity.physicalRootKey,
      });
      let serviceStopped = false;
      try {
      const initial = await first.startRebuild();
      expect(await waitForTerminalStatus(second, initial.job.id)).toMatchObject({
        graphRevision: 1,
        lastIndexJob: { state: "succeeded" },
      });

      // 扩大真实扫描窗口，在 running 状态后推进持久 base revision，强制 store CAS stale 重排。
      for (let index = 0; index < 8; index += 1) {
        await writeFile(
          path.join(indexingRoot, "src", `generated-${index}.ts`),
          Buffer.alloc(64 * 1024, index),
        );
      }
      const staleJob = await first.startRebuild();
      const running = await waitForRunningStatus(second, staleJob.job.id);
      expect(running).toMatchObject({
        committed: { graphRevision: 1 },
        graphRevision: 1,
      });
      const competingWriter = new RawSqlite(
        path.join(workspacePaths.workspaceDirectory, "graph.sqlite"),
      );
      competingWriter.pragma("journal_mode = WAL");
      competingWriter.prepare(`
        UPDATE workspace SET graph_revision = graph_revision + 1 WHERE workspace_key = ?
      `).run(first.identity.workspaceKey);
      competingWriter.close();
      const staleRecovered = await waitForTerminalStatus(second, staleJob.job.id);
      expect(staleRecovered).toMatchObject({
        committed: { graphRevision: 3 },
        freshness: "current",
        graphRevision: 3,
        lastIndexJob: {
          baseGraphRevision: 1,
          resultGraphRevision: 3,
          state: "succeeded",
        },
      });

      const oversizedPath = path.join(indexingRoot, "src", "oversized.ts");
      await writeFile(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1));
      const failedJob = await first.startRebuild();
      const failed = await waitForTerminalStatus(second, failedJob.job.id);
      expect(failed).toMatchObject({
        committed: { graphRevision: 3 },
        freshness: "stale",
        graphRevision: 3,
        lastIndexJob: {
          error: { code: "GRAPH_SCAN_LIMIT_EXCEEDED" },
          resultGraphRevision: 3,
          state: "failed",
        },
      });

      await rm(oversizedPath);
      await writeFile(
        path.join(indexingRoot, "src", "atomic-switch.ts"),
        "export const switched = true;\n",
      );
      const nextJob = await first.startRebuild();
      const observedRevisions = new Set<number | null>([3]);
      let switchedStatus: Awaited<ReturnType<GraphServiceConnection["status"]>> | undefined;
      /** composite Worker rebuild 仍必须只暴露旧/新 revision，等待窗口覆盖冷启动。 */
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const status = await second.status();
        observedRevisions.add(status.graphRevision);
        if (status.lastIndexJob?.id === nextJob.job.id && status.lastIndexJob.state === "succeeded") {
          switchedStatus = status;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(switchedStatus).toMatchObject({
        committed: { graphRevision: 4 },
        freshness: "current",
        graphRevision: 4,
        lastIndexJob: { resultGraphRevision: 4, state: "succeeded" },
      });
      expect([...observedRevisions].every((revision) => revision === 3 || revision === 4)).toBe(true);

      await writeFile(
        path.join(indexingRoot, "src", "cancel-window.ts"),
        Buffer.alloc(10 * 1024 * 1024),
      );
      const cancelledJob = await first.startRebuild();
      await first.shutdown();
      await waitForMissing(workspacePaths.metadataPath);
      serviceStopped = true;
      const store = await openSqliteGraphStore({
        databasePath: path.join(workspacePaths.workspaceDirectory, "graph.sqlite"),
        digestPort: { digest: sha256CanonicalJson },
        workspaceKey: first.identity.workspaceKey,
      });
      try {
        expect(store.readBootstrapState()).toMatchObject({
          committed: { graphRevision: 4 },
          lastJob: {
            id: cancelledJob.job.id,
            resultGraphRevision: 4,
            state: "cancelled",
          },
        });
      } finally {
        store.close();
      }
      } finally {
        if (!serviceStopped) {
          await first.shutdown().catch(async () => second.shutdown()).catch(() => undefined);
          await waitForMissing(workspacePaths.metadataPath).catch(() => undefined);
        }
      }
    },
    60_000,
  );
});

/** 创建满足 Hosted UDS 100 字节预算的独立短临时目录。 */
async function createShortTempRoot(slot: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `cg-${slot}-`));
}

/** 轮询共享权威状态，直到当前 Job 进入 terminal。 */
async function waitForTerminalStatus(client: GraphServiceConnection, expectedJobId: string) {
  /** 真实 TypeScript Worker 与双重 read-set 封口在并行 CI 下需要覆盖冷启动窗口。 */
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const status = await client.status();
    if (
      status.lastIndexJob?.id === expectedJobId &&
      (["cancelled", "failed", "partial", "succeeded"] as const).includes(
        status.lastIndexJob.state,
      )
    ) {
      return status;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待索引 Job terminal 状态超时。");
}

/** 等待 Job 真正进入 running，确保后续外部 revision 注入发生在 snapshot 读取之后。 */
async function waitForRunningStatus(client: GraphServiceConnection, expectedJobId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await client.status();
    if (status.currentIndexJob?.id === expectedJobId && status.currentIndexJob.state === "running") {
      return status;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待索引 Job running 状态超时。");
}

/** 等待 shutdown 删除服务 metadata，避免数据库仍被子进程持有。 */
async function waitForMissing(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待 graph-service 清理 metadata 超时。");
}

/**
 * 等待本用例启动的 graph-service 退出；协议关闭失效时只终止已记录的测试 PID。
 *
 * @param servicePid graph-service 在握手 metadata 中发布的进程号。
 */
async function stopTrackedTestService(servicePid: number): Promise<void> {
  if (await waitForProcessExit(servicePid)) {
    return;
  }
  try {
    process.kill(servicePid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
  if (!await waitForProcessExit(servicePid)) {
    throw new Error(`测试 graph-service 进程 ${servicePid} 未能退出。`);
  }
}

/** 在有界窗口内观察指定测试子进程退出。 */
async function waitForProcessExit(servicePid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      process.kill(servicePid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

/** 子进程夹具完成后返回的标准输出与退出状态。 */
interface ProcessResult {
  endpointKind: "named-pipe" | "unix-socket";
  pid: number;
  serviceInstanceId: string;
  statusEpoch: string;
}

/** 启动独立 Node 客户端进程并读取唯一 JSON 结果。 */
async function runClientProcess(
  workerEntry: string,
  config: { cacheRoot: string; graphServiceEntry: string; indexingRoot: string },
  timeoutMs = 15_000,
): Promise<ProcessResult> {
  const child = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      CODEGRAPH_TEST_CLIENT_CONFIG: JSON.stringify(config),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let exitCode: number | null | undefined;
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exitCode = code;
      resolve(code);
    });
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const completedCode = await Promise.race([
      exitPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("独立客户端进程执行超时。")),
          timeoutMs,
        );
      }),
    ]);
    if (completedCode !== 0) {
      throw new Error(`独立客户端进程失败：${stderr.trim()}`);
    }
    return JSON.parse(stdout.trim()) as ProcessResult;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (exitCode === undefined) {
      await killAndReap(child, exitPromise);
    }
  }
}

/** 终止挂起的测试 worker，并在升级强杀后有界等待 exit。 */
async function killAndReap(
  child: ReturnType<typeof spawn>,
  exitPromise: Promise<number | null>,
): Promise<void> {
  child.kill("SIGTERM");
  if (await waitForExit(exitPromise, 250)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForExit(exitPromise, 250))) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    throw new Error("测试 worker 在强制终止后仍未退出。");
  }
}

/** 在短界限内等待测试子进程退出。 */
async function waitForExit(
  exitPromise: Promise<number | null>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
