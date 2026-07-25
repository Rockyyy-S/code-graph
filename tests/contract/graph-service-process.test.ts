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
}

/** 从 store-sqlite 自身依赖边界解析的原生 SQLite 构造器。 */
interface RawSqliteConstructor {
  new (databasePath: string): RawSqliteDatabase;
}

const RawSqlite = requireFromStorePackage("better-sqlite3") as RawSqliteConstructor;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

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
      const status = await waitForTerminalStatus(second);
      expect(status).toMatchObject({
        availability: "available",
        committed: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: 2,
          indexedFileCount: 1,
          nodeCount: 3,
        },
        lastIndexJob: { state: "succeeded" },
      });
      expect(status.committed?.excludedPathCount).toBeGreaterThanOrEqual(
        excludedDirectories.length,
      );

      const workspacePaths = createWorkspacePaths(first.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
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
      const store = openSqliteGraphStore({
        databasePath: path.join(workspacePaths.workspaceDirectory, "graph.sqlite"),
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

      await client.startRebuild();
      const status = await waitForTerminalStatus(client);
      expect(status).toMatchObject({
        availability: "absent",
        committed: null,
        lastIndexJob: {
          error: { code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED" },
          state: "failed",
        },
      });
      const workspacePaths = createWorkspacePaths(client.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
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
          requestTimeoutMs: 10_000,
          startTimeoutMs: 10_000,
          trust: { isTrusted: true },
        },
        cacheRoot,
      );
      clients.push(client);
      const workspacePaths = createWorkspacePaths(client.identity.workspaceKey, {
        cacheRoot,
        platform: process.platform,
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
        lastIndexJob: null,
      });

      await client.startRebuild();
      const status = await waitForTerminalStatus(client);
      expect(status).toMatchObject({
        availability: "available",
        committed: {
          edgeCount: 0,
          indexedFileCount: 0,
          nodeCount: 1,
        },
        completeness: "empty",
        freshness: "fresh",
        lastIndexJob: { state: "succeeded" },
      });
      expect(status.committed?.excludedPathCount).toBeGreaterThanOrEqual(1);
      await client.shutdown();
      await waitForMissing(workspacePaths.metadataPath);
    },
    30_000,
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
          });
          await controller.shutdown().catch(async () => controller?.close());
          await waitForMissing(workspacePaths.metadataPath).catch(() => undefined);
        }
      }
    },
    30_000,
  );
});

/** 创建满足 Hosted UDS 100 字节预算的独立短临时目录。 */
async function createShortTempRoot(slot: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `cg-${slot}-`));
}

/** 轮询共享权威状态，直到当前 Job 进入 terminal。 */
async function waitForTerminalStatus(client: GraphServiceConnection) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await client.status();
    if (status.lastIndexJob?.state === "succeeded" || status.lastIndexJob?.state === "failed") {
      return status;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待索引 Job terminal 状态超时。");
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
