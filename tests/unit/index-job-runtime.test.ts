import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSqliteGraphStore } from "../../packages/adapters/store-sqlite/src/index.js";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  createIndexJobRuntime,
  GraphServiceRequestError,
  MAX_PENDING_EXPLICIT_JOBS,
} from "../../apps/graph-service/src/index-job-runtime.js";

const roots: string[] = [];

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

describe("index job runtime", () => {
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
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"));
      expect(runtime.getStatus()).toMatchObject({
        availability: "available",
        committed: { indexedFileCount: 0, nodeCount: 1 },
        completeness: "empty",
        freshness: "fresh",
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
        commitHierarchy: (input) => store.commitHierarchy(input),
        createJob,
        markJobFailed: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailed(jobId, completedAt, errorCode, errorLogId),
        markJobRunning: (jobId, startedAt) => store.markJobRunning(jobId, startedAt),
        readBootstrapState: () => store.readBootstrapState(),
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
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    const markJobFailed = vi.fn(
      (jobId: string, completedAt: string, errorCode: string, errorLogId: string) =>
        store.markJobFailed(jobId, completedAt, errorCode, errorLogId),
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
        commitHierarchy: (input) => store.commitHierarchy(input),
        createJob: (job) => store.createJob(job),
        markJobFailed,
        markJobRunning: (jobId, startedAt) => store.markJobRunning(jobId, startedAt),
        readBootstrapState: () => store.readBootstrapState(),
      },
      workspaceKey: fixture.workspaceKey,
    });

    runtime.startJob({ kind: "rebuild" });
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(runtime.getStatus().lastIndexJob).toMatchObject({
      error: { code: "GRAPH_SCAN_FAILED" },
      state: "failed",
    });
    expect(markJobFailed).not.toHaveBeenCalled();
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
        commitHierarchy: (input) => store.commitHierarchy(input),
        createJob: (job) => store.createJob(job),
        markJobFailed: (jobId, completedAt, errorCode, errorLogId) =>
          store.markJobFailed(jobId, completedAt, errorCode, errorLogId),
        markJobRunning,
        readBootstrapState: () => store.readBootstrapState(),
      },
      workspaceKey: fixture.workspaceKey,
    });

    runtime.startJob({ kind: "rebuild" });
    const closePromise = runtime.close();
    scheduledOperation?.();
    await expect(closePromise).resolves.toBeUndefined();
    expect(markJobRunning).not.toHaveBeenCalled();
    expect(runtime.getStatus().lastIndexJob).toMatchObject({
      error: { code: "GRAPH_SCAN_FAILED" },
      state: "failed",
    });
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
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob?.state).toBe("succeeded"));
      expect(runtime.getStatus()).toMatchObject({
        committed: { generatedAt: "2026-07-25T00:00:03.000Z" },
        lastIndexJob: {
          completedAt: "2026-07-25T00:00:03.000Z",
          requestedAt: "2026-07-25T00:00:03.000Z",
          startedAt: "2026-07-25T00:00:03.000Z",
        },
      });
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
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob?.state).toBe("failed"));
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

  it("closes the Job gate synchronously and bounds waiting for a pending scan", async () => {
    const fixture = await createFixture();
    const store = await openSqliteGraphStore({
      databasePath: path.join(fixture.cacheRoot, "graph.sqlite"),
      workspaceKey: fixture.workspaceKey,
    });
    const ignoreState = await createInitialIgnoreState(fixture.indexingRoot);
    let resolveScan: ((result: { candidateFiles: readonly string[]; excludedPathCount: number }) => void)
      | undefined;
    const scan = vi.fn(async () => new Promise<{
      candidateFiles: readonly string[];
      excludedPathCount: number;
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

    resolveScan?.({ candidateFiles: [], excludedPathCount: 0 });
    await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob).toMatchObject({
      error: { code: "GRAPH_SCAN_FAILED" },
      state: "failed",
    }));
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});
