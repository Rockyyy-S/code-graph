import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sha256CanonicalJson,
  validateServiceStatusV1,
} from "../../packages/contracts/src/index.js";
import {
  openSqliteGraphStore as openSqliteGraphStoreWithDigest,
  type OpenSqliteGraphStoreOptions,
  type SqliteGraphStore,
} from "../../packages/adapters/store-sqlite/src/index.js";
import {
  AnalyzerFailureError,
  buildGraphEntityId,
  buildHierarchyFactBatch,
  buildHierarchyGraphPatch,
  compareCanonicalGraphText,
} from "../../packages/application/src/index.js";
import { createAnalyzerSemanticContextCapture } from "../../apps/graph-service/src/analyzer-config.js";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  createIndexJobRuntime,
  createVerifiedIndexJobRuntime,
  GraphServiceRequestError,
  MAX_PENDING_EXPLICIT_JOBS,
  MAX_STARTUP_READ_SET_STABILITY_ATTEMPTS,
  MAX_STALE_REQUEUE_ATTEMPTS,
} from "../../apps/graph-service/src/index-job-runtime.js";
import { createIndexReadSetProvider } from "../../apps/graph-service/src/index-read-set.js";
import {
  scanWorkspace,
  WorkspaceScanCancelledError,
  WorkspaceScanError,
} from "../../apps/graph-service/src/workspace-scanner.js";
import { createTypeScriptAnalyzer } from "../../packages/adapters/analyzer-typescript/src/index.js";

const roots: string[] = [];

/** 生产组合根注入同一 JCS/SHA-256 实现；测试包装器避免每个夹具重复声明。 */
function openSqliteGraphStore(
  options: Omit<OpenSqliteGraphStoreOptions, "digestPort">,
): Promise<SqliteGraphStore> {
  return openSqliteGraphStoreWithDigest({
    ...options,
    digestPort: { digest: sha256CanonicalJson },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建真实 indexing root 与 SQLite 缓存目录。 */
async function createFixture() {
  const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-runtime-root-"));
  const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-runtime-cache-"));
  roots.push(indexingRoot, cacheRoot);
  const workspaceKey = "f".repeat(64);
  return {
    cacheRoot,
    indexingRoot,
    workspaceKey,
  };
}

/** 为真实 SQLite CAS 竞争测试构造并提交一个已进入 running 的 hierarchy Job。 */
function commitPreparedGraph(
  store: SqliteGraphStore,
  workspaceKey: string,
  jobId: string,
  relativePaths: readonly string[],
  completedAt: string,
): void {
  const snapshot = store.readCommittedSnapshot();
  const manifest = [...relativePaths]
    .sort(compareCanonicalGraphText)
    .map((relativePath) => ({
      contentHash: sha256CanonicalJson({ relativePath }),
      path: relativePath,
    }));
  const manifestDigest = sha256CanonicalJson(manifest);
  const inputDigest = sha256CanonicalJson({ manifest });
  const effectiveIgnoreDigest = sha256CanonicalJson({ rules: "builtin-ignore-v1" });
  const configDigest = sha256CanonicalJson({
    ignore: { effectiveDigest: effectiveIgnoreDigest, version: 1 },
    producer: { kind: "hierarchy", version: "hierarchy-v1" },
  });
  const readSet = {
    baseGraphRevision: snapshot.graphRevision,
    bootstrapGeneration: 0,
    configDigest,
    effectiveIgnoreSnapshot: {
      builtinRulesVersion: "builtin-ignore-v1" as const,
      contentHash: null,
      effectiveDigest: effectiveIgnoreDigest,
      effectiveRules: ["/.git/"],
      generation: 0,
      lastValidDigest: effectiveIgnoreDigest,
      userRules: [],
      validity: "valid" as const,
      version: 1 as const,
    },
    inputDigest,
    manifest,
    manifestDigest,
    statusEpoch: "epoch-competing-commit",
  };
  const batch = buildHierarchyFactBatch({
    configDigest,
    coverage: "complete",
    inputDigest,
    manifestDigest,
    producerVersion: "hierarchy-v1",
    relativePaths,
    workspaceKey,
  });
  const patch = buildHierarchyGraphPatch({
    batch,
    digestPort: { digest: sha256CanonicalJson },
    readSet,
    snapshot,
  });
  const result = store.commitAtomicGraphUpdate({
    completedAt,
    expectedSnapshot: snapshot,
    finalReadSetFence: (commitMutation) => {
      commitMutation();
      return true;
    },
    jobId,
    patch,
    summary: {
      builtinRulesVersion: "builtin-ignore-v1",
      edgeCount: batch.edges.length,
      excludedPathCount: 0,
      generatedAt: completedAt,
      indexedFileCount: relativePaths.length,
      nodeCount: batch.nodes.length,
    },
  });
  if (result.kind === "stale") {
    throw new Error("测试竞争提交不应 stale。");
  }
}

describe("index job runtime", () => {
  it("commits hierarchy and Worker module facts in one composite revision", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.indexingRoot, "src"), { recursive: true });
    await writeFile(
      path.join(fixture.indexingRoot, "src", "index.ts"),
      "import path from 'node:path';\nimport { value } from './dep.js';\nvoid path;\nvoid value;\n",
    );
    await writeFile(
      path.join(fixture.indexingRoot, "src", "dep.ts"),
      "export const value = 1;\n",
    );
    await writeFile(
      path.join(fixture.indexingRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const analyzer = createTypeScriptAnalyzer({
      workerUrl: pathToFileURL(path.resolve(
        "packages/adapters/analyzer-typescript/dist/analyzer-worker.js",
      )),
    });
    const runtime = createIndexJobRuntime({
      analyzer,
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-module-composite-runtime",
      statusEpoch: "epoch-module-composite-runtime",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"),
        { timeout: 20_000 },
      );
      const snapshot = store.readCommittedSnapshot();
      expect(snapshot.graphRevision).toBe(1);
      expect(snapshot.allEdges?.filter((edge) => edge.relationType === "imports")).toHaveLength(2);
      expect(snapshot.allEvidence).toHaveLength(2);
      expect(snapshot.allNodes).toContainEqual(expect.objectContaining({
        id: "node:path",
        kind: "node-builtin",
      }));
      expect(store.readBootstrapState().committed).toMatchObject({ graphRevision: 1 });
      expect(runtime.getStatus().committed).toMatchObject({ edgeCount: 3, nodeCount: 4 });
      expect(validateServiceStatusV1(runtime.getStatus())).toBe(true);

      await writeFile(
        path.join(fixture.indexingRoot, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".." } }),
      );
      const failed = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: failed.job.id,
          state: "failed",
        }),
        { timeout: 20_000 },
      );
      expect(runtime.getStatus()).toMatchObject({
        committed: { graphRevision: 1 },
        freshness: "stale",
        graphRevision: 1,
        lastIndexJob: {
          baseGraphRevision: 1,
          error: { code: "GRAPH_SCAN_FAILED" },
          resultGraphRevision: 1,
          state: "failed",
        },
      });
      expect(validateServiceStatusV1(runtime.getStatus())).toBe(true);
      expect(store.readCommittedSnapshot()).toMatchObject({
        allEdges: snapshot.allEdges,
        allEvidence: snapshot.allEvidence,
        allNodes: snapshot.allNodes,
        graphRevision: 1,
      });

      await writeFile(
        path.join(fixture.indexingRoot, "src", "index.ts"),
        "export const local = 1;\n",
      );
      await writeFile(
        path.join(fixture.indexingRoot, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
      );
      const second = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: second.job.id,
          state: "succeeded",
        }),
        { timeout: 20_000 },
      );
      const replaced = store.readCommittedSnapshot();
      expect(replaced.graphRevision).toBe(2);
      expect(replaced.allEdges?.filter((edge) => edge.relationType === "imports")).toEqual([]);
      expect(replaced.allEvidence).toEqual([]);
      /** Story 1.5 只移除 source facts；共享节点最后引用回收由 Story 1.7 负责。 */
      expect(replaced.allNodes).toContainEqual(expect.objectContaining({ id: "node:path" }));
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("rolls back consulted config changes inside the SQLite commit fence and reanalyzes paths", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.indexingRoot, "configs"), { recursive: true });
    await mkdir(path.join(fixture.indexingRoot, "src"), { recursive: true });
    const baseConfigPath = path.join(fixture.indexingRoot, "configs", "base.json");
    const configFor = (target: string): string => JSON.stringify({
      compilerOptions: {
        baseUrl: "..",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "@dep": [target] },
      },
    });
    await writeFile(baseConfigPath, configFor("src/dep-a.ts"));
    await writeFile(
      path.join(fixture.indexingRoot, "tsconfig.json"),
      JSON.stringify({ extends: "./configs/base.json", include: ["src/**/*.ts"] }),
    );
    await writeFile(
      path.join(fixture.indexingRoot, "src", "index.ts"),
      "import { value } from '@dep';\nvoid value;\n",
    );
    await writeFile(
      path.join(fixture.indexingRoot, "src", "dep-a.ts"),
      "export const value = 'a';\n",
    );
    await writeFile(
      path.join(fixture.indexingRoot, "src", "dep-b.ts"),
      "export const value = 'b';\n",
    );
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer = createTypeScriptAnalyzer({
      workerUrl: pathToFileURL(path.resolve(
        "packages/adapters/analyzer-typescript/dist/analyzer-worker.js",
      )),
    });
    const provider = createIndexReadSetProvider({
      captureAnalyzerSemanticContext: createAnalyzerSemanticContextCapture({
        analyzer,
        effectiveIgnoreSnapshot: ignoreState.snapshot,
        indexingRoot: fixture.indexingRoot,
        workspaceKey: fixture.workspaceKey,
      }),
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-consulted-config-commit-fence",
      watchWorkspaceChanges: true,
    });
    let commitMutations = 0;
    let injected = false;
    const runtime = createIndexJobRuntime({
      analyzer,
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: {
        ...provider,
        runCommitFence: (expected, prepared, commitMutation) => provider.runCommitFence(
          expected,
          prepared,
          () => {
            commitMutations += 1;
            if (!injected) {
              injected = true;
              // 精确落在 SQLite transaction 内，证明 consulted hash 变化会回滚全部 composite facts。
              writeFileSync(baseConfigPath, configFor("src/dep-b.ts"), "utf8");
            }
            commitMutation();
          },
        ),
      },
      serviceInstanceId: "instance-consulted-config-commit-fence",
      statusEpoch: "epoch-consulted-config-commit-fence",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      const started = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: started.job.id,
          state: "succeeded",
        }),
        { timeout: 20_000 },
      );

      const snapshot = store.readCommittedSnapshot();
      const depAId = buildGraphEntityId(fixture.workspaceKey, "file", "src/dep-a.ts");
      const depBId = buildGraphEntityId(fixture.workspaceKey, "file", "src/dep-b.ts");
      const importEdges = snapshot.allEdges?.filter((edge) => edge.relationType === "imports");
      expect(commitMutations).toBe(2);
      expect(snapshot.graphRevision).toBe(1);
      expect(importEdges).toEqual([expect.objectContaining({ toId: depBId })]);
      expect(importEdges).not.toContainEqual(expect.objectContaining({ toId: depAId }));
      expect(snapshot.allEvidence).toHaveLength(1);
      const current = await provider.capture(1);
      expect(current.analyzerContext?.configSnapshot.consultedFiles)
        .toContainEqual(expect.objectContaining({ path: "configs/base.json" }));
      expect(snapshot.committedReadSet?.configDigest).toBe(current.readSet.configDigest);
      expect(runtime.getStatus()).toMatchObject({ freshness: "current", graphRevision: 1 });
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("persists a real empty success distinct from never built", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-empty-runtime",
      statusEpoch: "epoch-empty-runtime",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(runtime.getStatus()).toMatchObject({ availability: "absent", committed: null });
      expect(runtime.startJob({ kind: "rebuild" })).toMatchObject({
        accepted: true,
        job: { kind: "initial-index", state: "queued" },
      });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"),
        { timeout: 5_000 },
      );
      expect(runtime.getStatus()).toMatchObject({
        availability: "available",
        committed: { indexedFileCount: 0, nodeCount: 1 },
        completeness: "empty",
        freshness: "current",
      });
      expect(store.readBootstrapState()).toMatchObject({
        committed: { indexedFileCount: 0 },
        lastJob: { state: "succeeded" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("fails closed for unsupported user ignore without hierarchy rows", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, ".codegraphignore"), "dist/\n", "utf8");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const runtime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-ignore-runtime",
      statusEpoch: "epoch-ignore-runtime",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(() => runtime.startJob({ kind: "rebuild" })).toThrow(
        expect.objectContaining({ code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED" }),
      );
      expect(runtime.getStatus()).toMatchObject({
        availability: "absent",
        committed: null,
        currentIndexJob: null,
        lastIndexJob: {
          error: { code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED" },
          state: "failed",
        },
      });
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
      expect(store.readBootstrapState().lastJob).toMatchObject({
        errorCode: "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
        state: "failed",
      });
    } finally {
      await runtime.close();
    }
  });

  it("publishes an in-memory failed Job when queued persistence itself fails", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const createJob = vi.fn(() => {
      throw Object.assign(new Error("disk unavailable"), { code: "SQLITE_IOERR" });
    });
    const runtime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-queued-write-failure",
      statusEpoch: "epoch-queued-write-failure",
      store: {
        close: () => store.close(),
        commitAtomicGraphUpdate: (input) => store.commitAtomicGraphUpdate(input),
        createJob,
        markJobCancelled: (jobId, completedAt) => store.markJobCancelled(jobId, completedAt),
        markJobCancelledAndWorkspaceStale: (jobId, completedAt) =>
          store.markJobCancelledAndWorkspaceStale(jobId, completedAt),
        markJobFailed: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailed(jobId, completedAt, errorCode, errorLogId),
        markJobFailedAndWorkspaceStale: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailedAndWorkspaceStale(jobId, completedAt, errorCode, errorLogId),
        markJobPartial: (jobId, completedAt) => store.markJobPartial(jobId, completedAt),
        markJobRunning: (jobId, startedAt) => store.markJobRunning(jobId, startedAt),
        markWorkspaceStale: () => store.markWorkspaceStale(),
        readBootstrapState: () => store.readBootstrapState(),
        readCommittedSnapshot: () => store.readCommittedSnapshot(),
      },
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(() => runtime.startJob({ kind: "rebuild" })).toThrow(
        expect.objectContaining({ code: "GRAPH_WRITE_FAILED" }),
      );
      expect(runtime.getStatus()).toMatchObject({
        currentIndexJob: null,
        lastIndexJob: {
          error: { code: "GRAPH_WRITE_FAILED" },
          state: "failed",
        },
      });
      expect(createJob).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it("aborts the active scan before closing the store during shutdown", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const scan = vi.fn(async ({ signal }: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new WorkspaceScanCancelledError("测试扫描已取消。")),
          { once: true },
        );
      }));
    const markJobCancelled = vi.fn(
      (jobId: string, completedAt: string) => store.markJobCancelled(jobId, completedAt),
    );
    const runtime = createIndexJobRuntime({
      closeTimeoutMs: 100,
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      scan,
      serviceInstanceId: "instance-cancel-runtime",
      statusEpoch: "epoch-cancel-runtime",
      store: {
        close: () => store.close(),
        commitAtomicGraphUpdate: (input) => store.commitAtomicGraphUpdate(input),
        createJob: (job) => store.createJob(job),
        markJobCancelled,
        markJobCancelledAndWorkspaceStale: (jobId, completedAt) =>
          store.markJobCancelledAndWorkspaceStale(jobId, completedAt),
        markJobFailed: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailed(jobId, completedAt, errorCode, errorLogId),
        markJobFailedAndWorkspaceStale: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailedAndWorkspaceStale(jobId, completedAt, errorCode, errorLogId),
        markJobPartial: (jobId, completedAt) => store.markJobPartial(jobId, completedAt),
        markJobRunning: (jobId, startedAt) => store.markJobRunning(jobId, startedAt),
        markWorkspaceStale: () => store.markWorkspaceStale(),
        readBootstrapState: () => store.readBootstrapState(),
        readCommittedSnapshot: () => store.readCommittedSnapshot(),
      },
      workspaceKey: fixture.workspaceKey,
    });

    runtime.startJob({ kind: "rebuild" });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(runtime.getStatus().lastIndexJob).toMatchObject({ state: "cancelled" });
    expect(markJobCancelled).toHaveBeenCalledTimes(1);
  });

  it("does not enter SQLite running state when shutdown cancels a queued Job", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    let scheduledOperation: (() => void) | undefined;
    const markJobRunning = vi.fn(
      (jobId: string, startedAt: string) => store.markJobRunning(jobId, startedAt),
    );
    const runtime = createIndexJobRuntime({
      closeTimeoutMs: 100,
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      schedule: (operation) => {
        scheduledOperation = operation;
      },
      serviceInstanceId: "instance-cancel-queued",
      statusEpoch: "epoch-cancel-queued",
      store: {
        close: () => store.close(),
        commitAtomicGraphUpdate: (input) => store.commitAtomicGraphUpdate(input),
        createJob: (job) => store.createJob(job),
        markJobCancelled: (jobId, completedAt) => store.markJobCancelled(jobId, completedAt),
        markJobCancelledAndWorkspaceStale: (jobId, completedAt) =>
          store.markJobCancelledAndWorkspaceStale(jobId, completedAt),
        markJobFailed: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailed(jobId, completedAt, errorCode, errorLogId),
        markJobFailedAndWorkspaceStale: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailedAndWorkspaceStale(jobId, completedAt, errorCode, errorLogId),
        markJobPartial: (jobId, completedAt) => store.markJobPartial(jobId, completedAt),
        markJobRunning,
        markWorkspaceStale: () => store.markWorkspaceStale(),
        readBootstrapState: () => store.readBootstrapState(),
        readCommittedSnapshot: () => store.readCommittedSnapshot(),
      },
      workspaceKey: fixture.workspaceKey,
    });

    runtime.startJob({ kind: "rebuild" });
    const closePromise = runtime.close();
    scheduledOperation?.();
    await expect(closePromise).resolves.toBeUndefined();
    expect(markJobRunning).not.toHaveBeenCalled();
    expect(runtime.getStatus().lastIndexJob).toMatchObject({ state: "cancelled" });
  });

  it("keeps Job lifecycle timestamps monotonic across a wall-clock rollback", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const timestamps = [
      "2026-07-25T00:00:03.000Z",
      "2026-07-25T00:00:02.000Z",
      "2026-07-25T00:00:01.000Z",
      "2026-07-24T23:59:59.000Z",
      "2026-07-24T23:59:58.000Z",
      "2026-07-24T23:59:57.000Z",
    ];
    const runtime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      now: () => timestamps.shift() ?? "2026-07-25T00:00:00.000Z",
      serviceInstanceId: "instance-clock-rollback",
      statusEpoch: "epoch-clock-rollback",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      /** mutation 后双重完整 read-set 复核在并行磁盘 I/O 下允许更宽的测试观察窗口。 */
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"),
        { timeout: 5_000 },
      );
      expect(runtime.getStatus()).toMatchObject({
        committed: { generatedAt: "2026-07-25T00:00:03.000Z" },
        lastIndexJob: {
          completedAt: "2026-07-25T00:00:03.000Z",
          requestedAt: "2026-07-25T00:00:03.000Z",
          startedAt: "2026-07-25T00:00:03.000Z",
        },
      });

      const second = runtime.startJob({ kind: "rebuild" });
      expect(runtime.getStatus()).toMatchObject({
        currentIndexJob: {
          id: second.job.id,
          requestedAt: "2026-07-25T00:00:03.000Z",
        },
        lastIndexJob: { completedAt: "2026-07-25T00:00:03.000Z" },
      });
      expect(validateServiceStatusV1(runtime.getStatus())).toBe(true);
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: second.job.id,
          state: "succeeded",
        }),
        { timeout: 5_000 },
      );
    } finally {
      await runtime.close();
    }
  });

  it("rolls back a failed first write and rejects a concurrent second writer", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.indexingRoot, "src"));
    await writeFile(path.join(fixture.indexingRoot, "src", "index.ts"), "export {};\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      faultInjector: ({ entityIndex, stage }) => {
        if (stage === "node" && entityIndex === 1) {
          throw Object.assign(new Error("storage full"), { code: "SQLITE_FULL" });
        }
      },
      workspaceKey: fixture.workspaceKey,
    });
    const runtime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-write-runtime",
      statusEpoch: "epoch-write-runtime",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      expect(() => runtime.startJob({ kind: "rebuild" })).toThrow(GraphServiceRequestError);
      // Windows 并行 I/O 下 fault rollback 可能超过 Vitest 默认 1 秒等待窗口。
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("failed"),
        { timeout: 5_000 },
      );
      expect(runtime.getStatus()).toMatchObject({
        availability: "absent",
        committed: null,
        lastIndexJob: { error: { code: "GRAPH_WRITE_FAILED" } },
      });
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
      expect(MAX_PENDING_EXPLICIT_JOBS).toBe(64);
    } finally {
      await runtime.close();
    }
  });

  it("marks and persists the old revision stale when reconciliation scanning fails", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    let scanCount = 0;
    const runtime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      scan: async (options) => {
        scanCount += 1;
        /** 首个成功 Job 需要 capture、isCurrent 与两次事务外完整 collect。 */
        if (scanCount <= 4) {
          return scanWorkspace(options);
        }
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "测试注入扫描失败。");
      },
      serviceInstanceId: "instance-scan-failure-stale",
      statusEpoch: "epoch-scan-failure-stale",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      const first = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: first.job.id,
          state: "succeeded",
        }),
        { timeout: 5_000 },
      );
      const failed = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: failed.job.id,
          state: "failed",
        }),
        { timeout: 5_000 },
      );

      expect(runtime.getStatus()).toMatchObject({
        freshness: "stale",
        graphRevision: 1,
        lastIndexJob: { error: { code: "GRAPH_SCAN_FAILED" } },
      });
      expect(store.readBootstrapState()).toMatchObject({
        committed: { graphRevision: 1 },
        freshness: "stale",
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not misclassify an independent scan failure as cancellation when shutdown races the catch", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    let scanCount = 0;
    let runtime!: ReturnType<typeof createIndexJobRuntime>;
    runtime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      scan: async (options) => {
        scanCount += 1;
        /** 首个成功 Job 需要 capture、isCurrent 与两次事务外完整 collect。 */
        if (scanCount <= 4) {
          return scanWorkspace(options);
        }
        // 先产生独立扫描错误，再让 shutdown 抢在 runtime catch 前设置 signal。
        queueMicrotask(() => runtime.beginShutdown());
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "测试注入独立扫描失败。");
      },
      serviceInstanceId: "instance-scan-failure-shutdown-race",
      statusEpoch: "epoch-scan-failure-shutdown-race",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"),
        { timeout: 5_000 },
      );
      const failed = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: failed.job.id,
          state: "failed",
        }),
        { timeout: 5_000 },
      );

      expect(runtime.getStatus()).toMatchObject({
        freshness: "stale",
        graphRevision: 1,
        lastIndexJob: { error: { code: "GRAPH_SCAN_FAILED" } },
      });
      expect(store.readBootstrapState()).toMatchObject({
        freshness: "stale",
        lastJob: { id: failed.job.id, state: "failed" },
      });
    } finally {
      await runtime.close();
    }
  });

  it("requeues when a watched change arrives after isCurrent but before the synchronous commit guard", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.indexingRoot, "index.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const baseProvider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_root, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-post-verify-watcher-race",
      watchWorkspaceChanges: true,
    });
    let injected = false;
    const isCurrent = vi.fn(async (expected, signal) => {
      const current = await baseProvider.isCurrent(expected, signal);
      if (!injected) {
        injected = true;
        // 此 microtask 先于 runtime 的 await continuation，精确落在 isCurrent/commit 间隙。
        queueMicrotask(() => {
          writeFileSync(sourcePath, "export const value = 2;\n", "utf8");
          notifyWorkspaceChanged("index.ts", "change");
        });
      }
      return current;
    });
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: { ...baseProvider, isCurrent },
      serviceInstanceId: "instance-post-verify-watcher-race",
      statusEpoch: "epoch-post-verify-watcher-race",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"),
        { timeout: 5_000 },
      );
      expect(isCurrent).toHaveBeenCalledTimes(2);
      expect(runtime.getStatus()).toMatchObject({ freshness: "current", graphRevision: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("rolls back and requeues when the source changes after verification but before mutation", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.indexingRoot, "index.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const provider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-commit-entry-toctou",
    });
    let injected = false;
    let commitMutations = 0;
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: {
        ...provider,
        runCommitFence: (expected, prepared, commitMutation) => provider.runCommitFence(
          expected,
          prepared,
          () => {
            commitMutations += 1;
            if (!injected) {
              injected = true;
              // 精确落在真实前置 verifier 返回 true 后、SQLite mutation 执行前。
              writeFileSync(sourcePath, "export const value = 2;\n", "utf8");
            }
            commitMutation();
          },
        ),
      },
      serviceInstanceId: "instance-commit-entry-toctou",
      statusEpoch: "epoch-commit-entry-toctou",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      const started = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: started.job.id,
          state: "succeeded",
        }),
        { timeout: 5_000 },
      );

      expect(commitMutations).toBe(2);
      const current = await provider.capture(1);
      expect(store.readCommittedSnapshot().committedReadSet?.manifestDigest).toBe(
        current.readSet.manifestDigest,
      );
      expect(runtime.getStatus()).toMatchObject({ freshness: "current", graphRevision: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("marks a persisted current revision stale when files changed while the service was offline", async () => {
    const fixture = await createFixture();
    const sourcePath = path.join(fixture.indexingRoot, "index.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    const databasePath = path.join(fixture.cacheRoot, "graph.sqlite");
    const firstStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const firstRuntime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-offline-change-first",
      statusEpoch: "epoch-offline-change-first",
      store: firstStore,
      workspaceKey: fixture.workspaceKey,
    });
    firstRuntime.startJob({ kind: "rebuild" });
    // 与 SQLite 重型用例并行时，Windows WAL 初始化可能超过 Vitest 默认 1 秒窗口。
    await vi.waitFor(
      () => expect(firstRuntime.getStatus().lastIndexJob?.state).toBe("succeeded"),
      { timeout: 5_000 },
    );
    await firstRuntime.close();

    await writeFile(sourcePath, "export const value = 2;\n");
    const reopenedStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const reopenedRuntime = await createVerifiedIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-offline-change-second",
      statusEpoch: "epoch-offline-change-second",
      store: reopenedStore,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(reopenedRuntime.getStatus()).toMatchObject({
        freshness: "stale",
        graphRevision: 1,
      });
      expect(reopenedStore.readBootstrapState()).toMatchObject({ freshness: "stale" });
    } finally {
      await reopenedRuntime.close();
    }
  });

  it("reuses the captured startup proof instead of hashing an unchanged committed workspace twice", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    const databasePath = path.join(fixture.cacheRoot, "graph.sqlite");
    const firstStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const firstRuntime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-single-startup-scan-first",
      statusEpoch: "epoch-single-startup-scan-first",
      store: firstStore,
      workspaceKey: fixture.workspaceKey,
    });
    firstRuntime.startJob({ kind: "rebuild" });
    await vi.waitFor(
      () => expect(firstRuntime.getStatus().lastIndexJob?.state).toBe("succeeded"),
      { timeout: 5_000 },
    );
    await firstRuntime.close();

    const reopenedStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const scan = vi.fn(scanWorkspace);
    const readSetProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      scan,
      statusEpoch: "epoch-single-startup-scan-second",
    });
    const runtime = await createVerifiedIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider,
      serviceInstanceId: "instance-single-startup-scan-second",
      statusEpoch: "epoch-single-startup-scan-second",
      store: reopenedStore,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(scan).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus()).toMatchObject({ freshness: "current", graphRevision: 1 });
    } finally {
      await runtime.close();
    }
  });

  it("keeps startup current after repeated transient watcher handoff failures", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(fixture.indexingRoot, "README.md"), "documentation\n");
    const databasePath = path.join(fixture.cacheRoot, "graph.sqlite");
    const firstStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const firstRuntime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-pending-ignored-first",
      statusEpoch: "epoch-pending-ignored-first",
      store: firstStore,
      workspaceKey: fixture.workspaceKey,
    });
    firstRuntime.startJob({ kind: "rebuild" });
    await vi.waitFor(
      () => expect(firstRuntime.getStatus().lastIndexJob?.state).toBe("succeeded"),
      { timeout: 5_000 },
    );
    await firstRuntime.close();

    const reopenedStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-pending-ignored-second",
    });
    let transientHandoffFailures = 0;
    const runtime = await createVerifiedIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: {
        ...baseProvider,
        isCaptureCurrent: async (capture, signal) => {
          if (transientHandoffFailures < 2) {
            transientHandoffFailures += 1;
            return false;
          }
          return baseProvider.isCaptureCurrent!(capture, signal);
        },
      },
      serviceInstanceId: "instance-pending-ignored-second",
      statusEpoch: "epoch-pending-ignored-second",
      store: reopenedStore,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(transientHandoffFailures).toBe(2);
      expect(runtime.getStatus()).toMatchObject({ freshness: "current", graphRevision: 1 });
      expect(reopenedStore.readBootstrapState()).toMatchObject({ freshness: "current" });
    } finally {
      await runtime.close();
    }
  });

  it("fails startup verification closed after the stability attempt budget is exhausted", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    const databasePath = path.join(fixture.cacheRoot, "graph.sqlite");
    const firstStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const firstRuntime = createIndexJobRuntime({
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-startup-budget-first",
      statusEpoch: "epoch-startup-budget-first",
      store: firstStore,
      workspaceKey: fixture.workspaceKey,
    });
    firstRuntime.startJob({ kind: "rebuild" });
    await vi.waitFor(
      () => expect(firstRuntime.getStatus().lastIndexJob?.state).toBe("succeeded"),
      { timeout: 5_000 },
    );
    await firstRuntime.close();

    const reopenedStore = await openSqliteGraphStore({ databasePath, workspaceKey: fixture.workspaceKey });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-startup-budget-second",
    });
    const isCaptureCurrent = vi.fn(async () => false);
    const runtime = await createVerifiedIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: { ...baseProvider, isCaptureCurrent },
      serviceInstanceId: "instance-startup-budget-second",
      statusEpoch: "epoch-startup-budget-second",
      store: reopenedStore,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(isCaptureCurrent).toHaveBeenCalledTimes(MAX_STARTUP_READ_SET_STABILITY_ATTEMPTS);
      expect(runtime.getStatus()).toMatchObject({ freshness: "stale", graphRevision: 1 });
      expect(reopenedStore.readBootstrapState()).toMatchObject({ freshness: "stale" });
    } finally {
      await runtime.close();
    }
  });

  it("rechecks the ignore barrier after installing the production watcher", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const staleReadyState = await createInitialIgnoreState(fixture.indexingRoot);
    if (staleReadyState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    // 模拟首次检查完成、production watcher 尚未安装时创建用户配置。
    await writeFile(path.join(fixture.indexingRoot, ".codegraphignore"), "dist/**\n");
    const runtime = await createVerifiedIndexJobRuntime({
      ignoreState: staleReadyState,
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-ignore-barrier-race",
      statusEpoch: "epoch-ignore-barrier-race",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      expect(() => runtime.startJob({ kind: "rebuild" })).toThrow(GraphServiceRequestError);
      expect(runtime.getStatus().lastIndexJob).toMatchObject({
        error: { code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED" },
        state: "failed",
      });
    } finally {
      await runtime.close();
    }
  });

  it("maps a runtime .codegraphignore event to the stable non-retryable contract", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let notifyWorkspaceChanged!: (
      relativePath?: string,
      eventType?: "change" | "rename",
    ) => void;
    const provider = createIndexReadSetProvider({
      createWorkspaceChangeMonitor: (_root, onChange) => {
        notifyWorkspaceChanged = onChange;
        return { close: vi.fn() };
      },
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-runtime-ignore-change",
      watchWorkspaceChanges: true,
    });
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: provider,
      serviceInstanceId: "instance-runtime-ignore-change",
      statusEpoch: "epoch-runtime-ignore-change",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      notifyWorkspaceChanged(".CodeGraphIgnore", "rename");
      const started = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob).toMatchObject({
        id: started.job.id,
        state: "failed",
      }));

      expect(runtime.getStatus()).toMatchObject({
        freshness: null,
        lastIndexJob: {
          error: {
            code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
            retryable: false,
          },
        },
      });
      expect(store.readBootstrapState().lastJob).toMatchObject({
        errorCode: "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
        state: "failed",
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects .codegraphignore created at commit entry before the native watcher callback runs", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let injected = false;
    const commitAtomicGraphUpdate = vi.fn((
      input: Parameters<SqliteGraphStore["commitAtomicGraphUpdate"]>[0],
    ) => {
      if (!injected) {
        injected = true;
        writeFileSync(
          path.join(fixture.indexingRoot, ".codegraphignore"),
          "dist/**\n",
          "utf8",
        );
      }
      return store.commitAtomicGraphUpdate(input);
    });
    const guardedStore = new Proxy(store, {
      get: (target, property) => {
        if (property === "commitAtomicGraphUpdate") {
          return commitAtomicGraphUpdate;
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-ignore-commit-entry",
      statusEpoch: "epoch-ignore-commit-entry",
      store: guardedStore,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      const started = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob).toMatchObject({
        id: started.job.id,
        state: "failed",
      }));

      expect(commitAtomicGraphUpdate).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus().lastIndexJob).toMatchObject({
        error: { code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED", retryable: false },
      });
      expect(store.readBootstrapState().lastJob).toMatchObject({
        errorCode: "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
        state: "failed",
      });
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    } finally {
      await runtime.close();
    }
  });

  it("requeues the same logical Job up to three stale attempts and then commits", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "index.ts"), "export const value = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-stale-success",
    });
    const isCurrent = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: { ...baseProvider, isCurrent },
      serviceInstanceId: "instance-stale-success",
      statusEpoch: "epoch-stale-success",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      const started = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: started.job.id,
          state: "succeeded",
        }),
        { timeout: 5_000 },
      );

      expect(isCurrent).toHaveBeenCalledTimes(MAX_STALE_REQUEUE_ATTEMPTS + 1);
      expect(runtime.getStatus()).toMatchObject({
        freshness: "current",
        graphRevision: 1,
        lastIndexJob: { id: started.job.id, state: "succeeded" },
      });
      expect(store.readBootstrapState().lastJob).toMatchObject({ id: started.job.id });
    } finally {
      await runtime.close();
    }
  });

  it("requeues successfully when a competing commit advances the base revision", async () => {
    const fixture = await createFixture();
    await writeFile(path.join(fixture.indexingRoot, "runtime.ts"), "export const runtime = 1;\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    store.createJob({
      baseGraphRevision: null,
      id: "job-cas-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-cas-baseline", "2026-07-25T00:00:01.000Z");
    commitPreparedGraph(
      store,
      fixture.workspaceKey,
      "job-cas-baseline",
      ["baseline.ts"],
      "2026-07-25T00:00:02.000Z",
    );
    store.createJob({
      baseGraphRevision: 1,
      id: "job-cas-competitor",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-base-revision-requeue",
    });
    let competitorCommitted = false;
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: {
        ...baseProvider,
        isCurrent: async (expected, signal) => {
          if (!competitorCommitted) {
            competitorCommitted = true;
            store.markJobRunning("job-cas-competitor", "2026-07-25T00:00:04.000Z");
            commitPreparedGraph(
              store,
              fixture.workspaceKey,
              "job-cas-competitor",
              ["competitor.ts"],
              "2026-07-25T00:00:05.000Z",
            );
          }
          return baseProvider.isCurrent(expected, signal);
        },
      },
      serviceInstanceId: "instance-base-revision-requeue",
      statusEpoch: "epoch-base-revision-requeue",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      const started = runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob).toMatchObject({
          id: started.job.id,
          state: "succeeded",
        }),
        { timeout: 5_000 },
      );

      expect(runtime.getStatus()).toMatchObject({
        freshness: "current",
        graphRevision: 3,
        lastIndexJob: {
          baseGraphRevision: 1,
          id: started.job.id,
          resultGraphRevision: 3,
          state: "succeeded",
        },
      });
      expect(store.readBootstrapState()).toMatchObject({
        committed: { graphRevision: 3 },
        lastJob: { id: started.job.id, resultGraphRevision: 3 },
      });
    } finally {
      await runtime.close();
    }
  });

  it("fails with the stable input-changed error after stale requeue exhaustion", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-stale-exhausted",
    });
    const isCurrent = vi.fn(async () => false);
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: { ...baseProvider, isCurrent },
      serviceInstanceId: "instance-stale-exhausted",
      statusEpoch: "epoch-stale-exhausted",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(
        () => expect(runtime.getStatus().lastIndexJob?.state).toBe("failed"),
        // 四次真实扫描验证有界耗尽；并行 CI 的磁盘争用不属于本用例的性能断言。
        { timeout: 5_000 },
      );

      expect(isCurrent).toHaveBeenCalledTimes(MAX_STALE_REQUEUE_ATTEMPTS + 1);
      expect(runtime.getStatus()).toMatchObject({
        availability: "absent",
        graphRevision: null,
        lastIndexJob: {
          error: {
            category: "indexing",
            code: "GRAPH_INPUT_CHANGED_DURING_BUILD",
            message: "工作区输入在图谱构建期间持续变化。",
            retryable: true,
            suggestedAction: "等待工作区写入稳定后重新请求 rebuild。",
          },
          state: "failed",
        },
      });
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    } finally {
      await runtime.close();
    }
  });

  it("publishes partial without replacing the last complete ownership slice", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    if (ignoreState.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const baseProvider = createIndexReadSetProvider({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: fixture.indexingRoot,
      statusEpoch: "epoch-partial",
    });
    const runtime = createIndexJobRuntime({
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      readSetProvider: {
        ...baseProvider,
        capture: async (baseGraphRevision, signal) => {
          const capture = await baseProvider.capture(baseGraphRevision, signal);
          return {
            ...capture,
            scanResult: { ...capture.scanResult, coverage: "partial" },
          };
        },
      },
      serviceInstanceId: "instance-partial",
      statusEpoch: "epoch-partial",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob?.state).toBe("partial"));

      expect(runtime.getStatus()).toMatchObject({
        availability: "absent",
        completeness: "partial",
        graphRevision: null,
        lastIndexJob: { resultGraphRevision: null, state: "partial" },
      });
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    } finally {
      await runtime.close();
    }
  });

  it("closes the Job gate synchronously and bounds waiting for a pending scan", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    let resolveScan: ((result: {
      candidateFiles: readonly string[];
      excludedPathCount: number;
      manifest: readonly [];
      manifestDigest: string;
    }) => void)
      | undefined;
    const scan = vi.fn(async () => new Promise<{
      candidateFiles: readonly string[];
      excludedPathCount: number;
      manifest: readonly [];
      manifestDigest: string;
    }>((resolve) => {
      resolveScan = resolve;
    }));
    const runtime = createIndexJobRuntime({
      closeTimeoutMs: 10,
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      scan,
      serviceInstanceId: "instance-close-runtime",
      statusEpoch: "epoch-close-runtime",
      store,
      workspaceKey: fixture.workspaceKey,
    });

    runtime.startJob({ kind: "rebuild" });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    runtime.beginShutdown();
    expect(() => runtime.startJob({ kind: "rebuild" })).toThrow(GraphServiceRequestError);
    await expect(runtime.close()).rejects.toThrow(/超时/u);
    expect(store.inspectPragmas().busyTimeoutMs).toBeGreaterThan(0);

    resolveScan?.({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
    });
    await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob).toMatchObject({
      state: "cancelled",
    }));
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("maps closed Analyzer failures to GRAPH_SCAN_FAILED", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.indexingRoot, "src"), { recursive: true });
    await writeFile(path.join(fixture.indexingRoot, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(fixture.indexingRoot, "tsconfig.json"), "{}\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const runtime = createIndexJobRuntime({
      analyzer: {
        analyze: async () => {
          throw new AnalyzerFailureError(
            "ANALYZER_PROTOCOL_INVALID",
            "测试注入 Analyzer 协议失败。",
          );
        },
        close: () => undefined,
        observeConfiguration: async () => ({
          consultedLogicalPaths: ["tsconfig.json"],
          effectiveCompilerOptions: {},
          projectConfigurations: [],
          resolutionCandidateLogicalPaths: [],
        }),
      },
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-analyzer-failure",
      statusEpoch: "epoch-analyzer-failure",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob).toMatchObject({
        error: { code: "GRAPH_SCAN_FAILED" },
        state: "failed",
      }));
    } finally {
      await runtime.close();
    }
  });

  it("maps ordinary Analyzer configuration/broker failures to scan failure and persists stale", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.indexingRoot, "src"), { recursive: true });
    await writeFile(path.join(fixture.indexingRoot, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(fixture.indexingRoot, "tsconfig.json"), "{}\n");
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    store.createJob({
      baseGraphRevision: null,
      id: "analyzer-config-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("analyzer-config-baseline", "2026-07-27T00:00:00.000Z");
    commitPreparedGraph(
      store,
      fixture.workspaceKey,
      "analyzer-config-baseline",
      ["src/index.ts"],
      "2026-07-27T00:00:01.000Z",
    );
    const runtime = createIndexJobRuntime({
      analyzer: {
        analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
        close: () => undefined,
        observeConfiguration: async () => {
          throw new Error("测试注入 metadata broker 普通失败。");
        },
      },
      ignoreState: await createInitialIgnoreState(fixture.indexingRoot),
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-analyzer-config-failure",
      statusEpoch: "epoch-analyzer-config-failure",
      store,
      workspaceKey: fixture.workspaceKey,
    });
    try {
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(() => expect(runtime.getStatus()).toMatchObject({
        freshness: "stale",
        lastIndexJob: {
          error: { code: "GRAPH_SCAN_FAILED" },
          state: "failed",
        },
      }));
      expect(store.readBootstrapState()).toMatchObject({ freshness: "stale" });
    } finally {
      await runtime.close();
    }
  });

  it("includes Analyzer shutdown in the runtime close deadline", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    let resolveAnalyzerClose: (() => void) | undefined;
    const analyzerClose = new Promise<void>((resolve) => {
      resolveAnalyzerClose = resolve;
    });
    const runtime = createIndexJobRuntime({
      analyzer: {
        analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
        close: () => analyzerClose,
        observeConfiguration: async () => ({
          consultedLogicalPaths: [],
          effectiveCompilerOptions: {},
          projectConfigurations: [],
          resolutionCandidateLogicalPaths: [],
        }),
      },
      closeTimeoutMs: 10,
      ignoreState,
      indexingRoot: fixture.indexingRoot,
      serviceInstanceId: "instance-analyzer-close-deadline",
      statusEpoch: "epoch-analyzer-close-deadline",
      store,
      workspaceKey: fixture.workspaceKey,
    });

    const firstClose = runtime.close();
    const outcome = await Promise.race([
      firstClose.then(() => "resolved" as const, (error: unknown) => error),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    resolveAnalyzerClose?.();
    await firstClose.catch(() => undefined);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ message: expect.stringMatching(/超时/u) });
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
