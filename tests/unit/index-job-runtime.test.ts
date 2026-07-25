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
    const store = openSqliteGraphStore({
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
    const store = openSqliteGraphStore({
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
      runtime.startJob({ kind: "rebuild" });
      await vi.waitFor(() => expect(runtime.getStatus().lastIndexJob?.state).toBe("failed"));
      expect(runtime.getStatus()).toMatchObject({
        availability: "absent",
        committed: null,
        lastIndexJob: { error: { code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED" } },
      });
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    } finally {
      await runtime.close();
    }
  });

  it("rolls back a failed first write and rejects a concurrent second writer", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.indexingRoot, "src"));
    await writeFile(path.join(fixture.indexingRoot, "src", "index.ts"), "export {};\n");
    const store = openSqliteGraphStore({
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
});
