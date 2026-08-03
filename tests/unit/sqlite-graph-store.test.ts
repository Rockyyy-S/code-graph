import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHierarchyFactBatch,
  buildHierarchyGraph,
  buildHierarchyGraphPatch,
  type AtomicGraphUpdate,
  type CreateStoredIndexJobInput,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import {
  buildGraphEdgeId,
  buildGraphEntityId,
  type HierarchyGraph,
  type HierarchyReadSetV1,
} from "../../packages/domain/src/index.js";
import {
  applyBootstrapMigration,
  applyDeterministicCommitMigration,
  groupOwnershipRows,
  SQLITE_BUSY_TIMEOUT_MS,
  SqliteGraphStore,
  openSqliteGraphStore as openSqliteGraphStoreWithDigest,
  type OpenSqliteGraphStoreOptions,
} from "../../packages/adapters/store-sqlite/src/index.js";

const roots: string[] = [];

/** 测试与生产共享同一规范 digest 端口，确保恢复校验能重新派生全部摘要。 */
function openSqliteGraphStore(
  options: Omit<OpenSqliteGraphStoreOptions, "digestPort">,
): Promise<SqliteGraphStore> {
  return openSqliteGraphStoreWithDigest({
    ...options,
    digestPort: { digest: sha256CanonicalJson },
  });
}
const requireFromStorePackage = createRequire(
  path.resolve("packages/adapters/store-sqlite/package.json"),
);

/** 测试构造未知 schema 与真实写锁所需的最小原生 SQLite 连接。 */
interface RawSqliteDatabase {
  close: () => void;
  exec: (source: string) => RawSqliteDatabase;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  prepare: (source: string) => {
    get: (...parameters: unknown[]) => unknown;
    run: (...parameters: unknown[]) => unknown;
  };
  transaction: (callback: () => void) => {
    (): void;
    immediate: () => void;
  };
}

/** 从 store-sqlite 自身依赖边界解析的原生 SQLite 构造器。 */
interface RawSqliteConstructor {
  new (databasePath: string, options?: { readonly?: boolean }): RawSqliteDatabase;
}

const RawSqlite = requireFromStorePackage("better-sqlite3") as RawSqliteConstructor;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建真实 SQLite 临时目录。 */
async function createDatabasePath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-sqlite-"));
  roots.push(root);
  return path.join(root, "graph.sqlite");
}

/** 旧测试调用点通过新端口显式锁定创建时的 base revision。 */
function createJob(
  store: SqliteGraphStore,
  job: Omit<CreateStoredIndexJobInput, "baseGraphRevision">,
): void {
  store.createJob({
    ...job,
    baseGraphRevision: store.readCommittedSnapshot().graphRevision,
  });
}

/** 把 Story 1.4 测试输入转换为 Story 1.19 唯一 GraphPatch 提交通道。 */
function commitHierarchy(
  store: SqliteGraphStore,
  input: {
    completedAt: string;
    finalReadSetFence?: AtomicGraphUpdate["finalReadSetFence"];
    graph: HierarchyGraph;
    jobId: string;
    permitStale?: boolean;
    summary: AtomicGraphUpdate["summary"];
  },
): ReturnType<SqliteGraphStore["commitAtomicGraphUpdate"]> {
  const snapshot = store.readCommittedSnapshot();
  const manifest = input.graph.nodes
    .filter((node) => node.kind === "file")
    .map((node) => ({ contentHash: sha256CanonicalJson(node.relativePath), path: node.relativePath }));
  const effectiveDigest = sha256CanonicalJson({ rules: "builtin-ignore-v1" });
  const readSet: HierarchyReadSetV1 = {
    baseGraphRevision: snapshot.graphRevision,
    bootstrapGeneration: 0,
    configDigest: sha256CanonicalJson({
      ignore: { effectiveDigest, version: 1 },
      producer: { kind: "hierarchy", version: "hierarchy-v1" },
    }),
    effectiveIgnoreSnapshot: {
      builtinRulesVersion: "builtin-ignore-v1",
      contentHash: null,
      effectiveDigest,
      effectiveRules: ["/.git/"],
      generation: 0,
      lastValidDigest: effectiveDigest,
      userRules: [],
      validity: "valid",
      version: 1,
    },
    inputDigest: sha256CanonicalJson({ manifest }),
    manifest,
    manifestDigest: sha256CanonicalJson(manifest),
    statusEpoch: "epoch-sqlite-test",
  };
  const batch = buildHierarchyFactBatch({
    configDigest: readSet.configDigest,
    coverage: "complete",
    inputDigest: readSet.inputDigest,
    manifestDigest: readSet.manifestDigest,
    producerVersion: "hierarchy-v1",
    relativePaths: manifest.map((entry) => entry.path),
    workspaceKey: input.graph.workspaceKey,
  });
  const patch = buildHierarchyGraphPatch({
    batch,
    digestPort: { digest: sha256CanonicalJson },
    readSet,
    snapshot,
  });
  const result = store.commitAtomicGraphUpdate({
    completedAt: input.completedAt,
    expectedSnapshot: snapshot,
    finalReadSetFence: input.finalReadSetFence ?? ((commitMutation) => {
      commitMutation();
      return true;
    }),
    jobId: input.jobId,
    patch,
    summary: input.summary,
  });
  if (result.kind === "stale" && input.permitStale !== true) {
    throw new Error("测试提交不应发生 stale CAS。");
  }
  return result;
}

describe("sqlite graph store", () => {
  it("groups ownership rows in one linear pass", () => {
    let propertyReads = 0;
    const rows = Array.from({ length: 300 }, (_, index) => {
      const values = {
        fact_id: `fact-${index}`,
        fact_kind: (["node", "edge", "evidence"] as const)[index % 3]!,
        owner_key: `owner-${Math.floor(index / 3)}`,
      };
      return Object.defineProperties({}, {
        fact_id: { enumerable: true, get: () => { propertyReads += 1; return values.fact_id; } },
        fact_kind: { enumerable: true, get: () => { propertyReads += 1; return values.fact_kind; } },
        owner_key: { enumerable: true, get: () => { propertyReads += 1; return values.owner_key; } },
      }) as typeof values;
    });

    const grouped = groupOwnershipRows(rows);

    expect(grouped).toHaveLength(100);
    expect(grouped[0]).toEqual({
      edgeIds: ["fact-1"],
      evidenceIds: ["fact-2"],
      nodeIds: ["fact-0"],
      ownerKey: "owner-0",
    });
    expect(propertyReads).toBeLessThanOrEqual(rows.length * 4);
  });

  it("retries the native close after an initial close failure", () => {
    const close = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("close failed");
      })
      .mockImplementationOnce(() => undefined);
    const store = new SqliteGraphStore({ close } as never, "0".repeat(64));

    expect(() => store.close()).toThrow("close failed");
    expect(() => store.close()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("creates exactly the bootstrap tables and verifies required pragmas", async () => {
    const store = await openSqliteGraphStore({
      databasePath: await createDatabasePath(),
      workspaceKey: "c".repeat(64),
    });
    try {
      expect(store.listUserTables()).toEqual([
        "edges",
        "evidence",
        "facts_ownership",
        "jobs",
        "meta",
        "nodes",
        "schema_migrations",
        "workspace",
      ]);
      expect(store.inspectPragmas()).toEqual({
        busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
        foreignKeys: true,
        journalMode: "wal",
        synchronous: "normal",
      });
      expect(SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
      expect(Number.isFinite(SQLITE_BUSY_TIMEOUT_MS)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("is migration-idempotent and persists a recognizable empty commit", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "d".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    let store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, { id: "job-empty", kind: "initial-index", requestedAt: "2026-07-25T00:00:00.000Z" });
    store.markJobRunning("job-empty", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-empty",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    store.close();

    store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(store.readBootstrapState()).toMatchObject({
        committed: { indexedFileCount: 0, nodeCount: 1 },
        lastJob: { id: "job-empty", state: "succeeded" },
      });
      expect(store.listUserTables()).toHaveLength(8);
    } finally {
      store.close();
    }
  });

  it("rejects a persisted summary that disagrees with the actual hierarchy", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "7".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-corrupt-summary",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-corrupt-summary", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-corrupt-summary",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      UPDATE workspace
      SET node_count = 0, edge_count = 99
      WHERE workspace_key = ?
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/摘要与实际 hierarchy 不一致/u);
  });

  it("requires a succeeded Job that matches the committed summary", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "6".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-committed",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-committed", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-committed",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    createJob(store, {
      id: "job-later-failed",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-later-failed", "2026-07-25T00:00:04.000Z");
    store.markJobFailed(
      "job-later-failed",
      "2026-07-25T00:00:05.000Z",
      "GRAPH_SCAN_FAILED",
      "log-later-failed",
    );
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("DELETE FROM jobs WHERE state = 'succeeded'").run();
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/缺少对应的 succeeded Job/u);
  });

  it("binds a committed summary to the exact succeeded Job even when timestamps collide", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "3".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-earlier-same-time",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-earlier-same-time", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-earlier-same-time",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    createJob(store, {
      id: "job-current-same-time",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:02.000Z",
    });
    store.markJobRunning("job-current-same-time", "2026-07-25T00:00:02.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-current-same-time",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("DELETE FROM jobs WHERE id = ?").run("job-current-same-time");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/缺少对应的 succeeded Job/u);
  });

  it("backfills the exact committed Job binding for a valid pre-binding schema v1 database", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "8".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    let store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-legacy-committed",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-legacy-committed", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-legacy-committed",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    store.close();

    let rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("DELETE FROM meta WHERE key LIKE 'bootstrap-committed-job:%'").run();
    rawDatabase.close();

    store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(store.readBootstrapState()).toMatchObject({
        committed: { generatedAt: "2026-07-25T00:00:02.000Z" },
        lastJob: { id: "job-legacy-committed", state: "succeeded" },
      });
    } finally {
      store.close();
    }

    rawDatabase = new RawSqlite(databasePath);
    const binding = rawDatabase.prepare(`
      SELECT value FROM meta WHERE key = ?
    `).get(`bootstrap-committed-job:${workspaceKey}`) as { value: string };
    rawDatabase.close();
    expect(binding.value).toBe("job-legacy-committed");
  });

  it("backfills the latest persisted succeeded Job when legacy timestamps collide", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "9".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    for (const [id, kind] of [
      ["job-legacy-first", "initial-index"],
      ["job-legacy-second", "rebuild"],
    ] as const) {
      createJob(store, {
        id,
        kind,
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning(id, "2026-07-25T00:00:01.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: id,
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: 0,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 0,
          nodeCount: 1,
        },
      });
    }
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("DELETE FROM meta WHERE key LIKE 'bootstrap-committed-job:%'").run();
    rawDatabase.close();

    const reopened = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(reopened.readBootstrapState().lastJob).toMatchObject({
        id: "job-legacy-second",
        state: "succeeded",
      });
    } finally {
      reopened.close();
    }

    const reboundDatabase = new RawSqlite(databasePath);
    const rebound = reboundDatabase.prepare(`
      SELECT value FROM meta WHERE key = ?
    `).get(`bootstrap-committed-job:${workspaceKey}`) as { value: string };
    reboundDatabase.close();
    expect(rebound.value).toBe("job-legacy-second");
  });

  it("bounds retained terminal Job history while preserving the latest status", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ history: "bounded-terminal-jobs" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      for (let index = 0; index < 140; index += 1) {
        const id = `job-retained-${index.toString().padStart(3, "0")}`;
        const requestedAt = new Date(Date.UTC(2026, 6, 25, 0, 0, 0, index * 3)).toISOString();
        const startedAt = new Date(Date.UTC(2026, 6, 25, 0, 0, 0, index * 3 + 1)).toISOString();
        const completedAt = new Date(Date.UTC(2026, 6, 25, 0, 0, 0, index * 3 + 2)).toISOString();
        createJob(store, { id, kind: "initial-index", requestedAt });
        store.markJobRunning(id, startedAt);
        store.markJobFailed(id, completedAt, "GRAPH_SCAN_FAILED", `log-retained-${index}`);
      }
      expect(store.readBootstrapState().lastJob).toMatchObject({
        id: "job-retained-139",
        state: "failed",
      });
    } finally {
      store.close();
    }

    const rawDatabase = new RawSqlite(databasePath);
    const count = rawDatabase.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE workspace_key = ?
    `).get(workspaceKey) as { count: number };
    rawDatabase.close();
    expect(count.count).toBeLessThanOrEqual(16);
  });

  it("rejects a terminal transition when a trigger suppresses bounded-history pruning", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ history: "prune-trigger-ignored" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      for (let index = 0; index < 16; index += 1) {
        const id = `job-prune-guard-${index.toString().padStart(2, "0")}`;
        const requestedAt = new Date(Date.UTC(2026, 6, 25, 1, 0, 0, index * 3)).toISOString();
        const startedAt = new Date(Date.UTC(2026, 6, 25, 1, 0, 0, index * 3 + 1)).toISOString();
        const completedAt = new Date(Date.UTC(2026, 6, 25, 1, 0, 0, index * 3 + 2)).toISOString();
        createJob(store, { id, kind: "initial-index", requestedAt });
        store.markJobRunning(id, startedAt);
        store.markJobFailed(id, completedAt, "GRAPH_SCAN_FAILED", `log-prune-guard-${index}`);
      }

      const rawDatabase = new RawSqlite(databasePath);
      rawDatabase.exec(`
        CREATE TRIGGER suppress_terminal_history_prune
        BEFORE DELETE ON jobs
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      rawDatabase.close();

      createJob(store, {
        id: "job-prune-guard-overflow",
        kind: "initial-index",
        requestedAt: "2026-07-25T01:01:00.000Z",
      });
      store.markJobRunning("job-prune-guard-overflow", "2026-07-25T01:01:01.000Z");
      expect(() => store.markJobFailed(
        "job-prune-guard-overflow",
        "2026-07-25T01:01:02.000Z",
        "GRAPH_SCAN_FAILED",
        "log-prune-guard-overflow",
      )).toThrow(/历史裁剪未能收敛/u);

      expect(store.readBootstrapState().lastJob).toMatchObject({
        id: "job-prune-guard-15",
        state: "failed",
      });
    } finally {
      store.close();
    }
  });

  it("prunes oversized pre-retention history before deriving the retained succeeded evidence", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ history: "oversized-pre-retention" });
    let store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-oversized-committed",
      kind: "initial-index",
      requestedAt: "2026-07-25T02:00:00.000Z",
    });
    store.markJobRunning("job-oversized-committed", "2026-07-25T02:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T02:00:02.000Z",
      graph: buildHierarchyGraph(workspaceKey, []),
      jobId: "job-oversized-committed",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T02:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: 1,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    const evidence = rawDatabase.prepare(`
      SELECT read_set_json, patch_digest
      FROM jobs
      WHERE id = 'job-oversized-committed'
    `).get() as { patch_digest: string; read_set_json: string };
    const insert = rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, completed_at,
        base_graph_revision, result_graph_revision, read_set_json, patch_digest
      ) VALUES (?, ?, 'initial-index', 'succeeded', ?, ?, ?, NULL, 1, ?, ?)
    `);
    let latestId = "job-oversized-committed";
    let latestCompletedAt = "2026-07-25T02:00:02.000Z";
    for (let index = 0; index < 40; index += 1) {
      latestId = `job-oversized-history-${index.toString().padStart(2, "0")}`;
      const requestedAt = new Date(Date.UTC(2026, 6, 25, 2, 1, 0, index * 3)).toISOString();
      const startedAt = new Date(Date.UTC(2026, 6, 25, 2, 1, 0, index * 3 + 1)).toISOString();
      latestCompletedAt = new Date(Date.UTC(2026, 6, 25, 2, 1, 0, index * 3 + 2)).toISOString();
      insert.run(
        latestId,
        workspaceKey,
        requestedAt,
        startedAt,
        latestCompletedAt,
        evidence.read_set_json,
        evidence.patch_digest,
      );
    }
    rawDatabase.prepare(`
      UPDATE meta SET value = ? WHERE key = ?
    `).run(latestId, `bootstrap-committed-job:${workspaceKey}`);
    rawDatabase.prepare(`
      UPDATE workspace SET committed_at = ? WHERE workspace_key = ?
    `).run(latestCompletedAt, workspaceKey);
    rawDatabase.close();

    let digestCalls = 0;
    store = await openSqliteGraphStoreWithDigest({
      databasePath,
      digestPort: {
        digest: (value) => {
          digestCalls += 1;
          return sha256CanonicalJson(value);
        },
      },
      workspaceKey,
    });
    try {
      expect(store.readBootstrapState().lastJob).toMatchObject({
        id: latestId,
        state: "succeeded",
      });
      expect(digestCalls).toBeLessThan(120);
    } finally {
      store.close();
    }

    const boundedDatabase = new RawSqlite(databasePath);
    const count = boundedDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE workspace_key = ? AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
    `).get(workspaceKey) as { count: number };
    const committed = boundedDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE workspace_key = ? AND id = ? AND state = 'succeeded'
    `).get(workspaceKey, latestId) as { count: number };
    boundedDatabase.close();
    expect(count.count).toBe(16);
    expect(committed.count).toBe(1);
  });

  it("reconciles interrupted running Jobs on the next startup", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "5".repeat(64);
    let store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-interrupted",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-interrupted", "2026-07-25T00:00:01.000Z");
    store.close();

    store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(store.readBootstrapState().lastJob).toMatchObject({
        errorCode: "GRAPH_SCAN_FAILED",
        id: "job-interrupted",
        state: "failed",
      });
    } finally {
      store.close();
    }
  });

  it("does not rewrite a malformed queued Job before rejecting the database", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "2".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.close();

    let rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      INSERT INTO jobs(id, workspace_key, kind, state, requested_at)
      VALUES ('', ?, 'initial-index', 'queued', 'not-a-time')
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/活动 Job 合同不完整/u);

    rawDatabase = new RawSqlite(databasePath);
    const row = rawDatabase.prepare(`
      SELECT state, started_at, completed_at, error_code, error_log_id
      FROM jobs
      WHERE id = ''
    `).get() as Record<string, unknown>;
    rawDatabase.close();
    expect(row).toEqual({
      completed_at: null,
      error_code: null,
      error_log_id: null,
      started_at: null,
      state: "queued",
    });
  });

  it("rejects a persisted rebuild whose base revision is zero without rewriting it", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "zero-rebuild-base" });
    const graph = buildHierarchyGraph(workspaceKey, []);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-zero-base-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-zero-base-baseline", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-zero-base-baseline",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 0,
        nodeCount: graph.nodes.length,
      },
    });
    store.close();

    let rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, base_graph_revision
      ) VALUES (?, ?, 'rebuild', 'running', ?, ?, 0)
    `).run(
      "job-zero-base-running",
      workspaceKey,
      "2026-07-25T00:00:03.000Z",
      "2026-07-25T00:00:04.000Z",
    );
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/活动 Job 合同不完整/u);

    rawDatabase = new RawSqlite(databasePath);
    try {
      expect(rawDatabase.prepare(`
        SELECT state, base_graph_revision, result_graph_revision
        FROM jobs WHERE id = 'job-zero-base-running'
      `).get()).toEqual({
        base_graph_revision: 0,
        result_graph_revision: null,
        state: "running",
      });
    } finally {
      rawDatabase.close();
    }
  });

  it("rejects recovery when a database trigger ignores the interrupted Job update", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "a".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-trigger-ignored",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER ignore_interrupted_job_update
      BEFORE UPDATE OF state ON jobs
      WHEN OLD.state IN ('queued', 'running')
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/中断 Job 未能收敛/u);
  });

  it("rejects recovery when an after-update trigger restores the Job to active state", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "b".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-trigger-restored",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER restore_interrupted_job_after_update
      AFTER UPDATE OF state ON jobs
      WHEN OLD.state IN ('queued', 'running')
      BEGIN
        UPDATE jobs
        SET state = OLD.state,
            started_at = OLD.started_at,
            completed_at = OLD.completed_at,
            error_code = OLD.error_code,
            error_log_id = OLD.error_log_id
        WHERE id = OLD.id;
      END;
    `);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/中断 Job 未能收敛/u);
  });

  it("rejects recovery when a trigger rewrites the failed Job to different valid fields", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "f".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-trigger-rewritten",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER rewrite_interrupted_job_after_update
      AFTER UPDATE OF state ON jobs
      WHEN OLD.state IN ('queued', 'running')
      BEGIN
        UPDATE jobs
        SET kind = 'rebuild',
            requested_at = '2026-07-24T23:59:59.000Z',
            error_code = 'GRAPH_WRITE_FAILED',
            error_log_id = 'trigger-log-id'
        WHERE id = OLD.id;
      END;
    `);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/中断 Job 未能收敛/u);
  });

  it("rejects recovery when a trigger inserts a new active Job", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "0".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-trigger-original",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER insert_active_job_after_update
      AFTER UPDATE OF state ON jobs
      WHEN OLD.state IN ('queued', 'running')
      BEGIN
        INSERT INTO jobs(id, workspace_key, kind, state, requested_at)
        VALUES ('job-trigger-injected', OLD.workspace_key, 'rebuild', 'queued', NEW.completed_at);
      END;
    `);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/中断 Job 未能收敛/u);
  });

  it("rejects empty persisted terminal Job identifiers", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "4".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-empty-id-corruption",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-empty-id-corruption", "2026-07-25T00:00:01.000Z");
    store.markJobFailed(
      "job-empty-id-corruption",
      "2026-07-25T00:00:02.000Z",
      "GRAPH_SCAN_FAILED",
      "log-empty-id",
    );
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("UPDATE jobs SET id = '' WHERE id = ?").run("job-empty-id-corruption");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/terminal Job 合同不完整/u);
  });

  it("rejects an unknown error code in any persisted terminal Job", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "1".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-older-corrupt",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobFailed(
      "job-older-corrupt",
      "2026-07-25T00:00:01.000Z",
      "GRAPH_SCAN_FAILED",
      "log-older-corrupt",
    );
    createJob(store, {
      id: "job-latest-valid",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:02.000Z",
    });
    store.markJobFailed(
      "job-latest-valid",
      "2026-07-25T00:00:03.000Z",
      "GRAPH_SCAN_FAILED",
      "log-latest-valid",
    );
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("UPDATE jobs SET error_code = 'UNKNOWN_FAILURE' WHERE id = ?")
      .run("job-older-corrupt");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/terminal Job 合同不完整/u);
  });

  it("rolls back a completed mutation when the post-mutation read-set fence is stale", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ fence: "post-mutation-stale" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    createJob(store, {
      id: "job-post-fence-stale",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-post-fence-stale", "2026-07-25T00:00:01.000Z");

    const result = commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      finalReadSetFence: (commitMutation) => {
        commitMutation();
        return false;
      },
      graph,
      jobId: "job-post-fence-stale",
      permitStale: true,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: graph.nodes.length,
      },
    });

    expect(result).toEqual({ graphRevision: null, kind: "stale" });
    expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    expect(store.readCommittedSnapshot()).toMatchObject({ graphRevision: null });
    const reader = new RawSqlite(databasePath, { readonly: true });
    try {
      expect(reader.prepare("SELECT state FROM jobs WHERE id = ?")
        .get("job-post-fence-stale")).toEqual({ state: "running" });
    } finally {
      reader.close();
      store.close();
    }
  });

  it("revokes an escaped mutation capability when the final fence returns", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ fence: "escaped-mutation-capability" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const jobId = "job-escaped-mutation-capability";
    createJob(store, {
      id: jobId,
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning(jobId, "2026-07-25T00:00:01.000Z");
    let escapedMutation!: () => void;

    const result = commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      finalReadSetFence: (commitMutation) => {
        escapedMutation = commitMutation;
        return false;
      },
      graph,
      jobId,
      permitStale: true,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: graph.nodes.length,
      },
    });

    expect(result).toEqual({ graphRevision: null, kind: "stale" });
    expect(() => escapedMutation()).toThrow(/capability 已失效/u);
    expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    const reader = new RawSqlite(databasePath, { readonly: true });
    try {
      expect(reader.prepare(
        "SELECT state, result_graph_revision FROM jobs WHERE id = ?",
      ).get(jobId)).toEqual({ result_graph_revision: null, state: "running" });
    } finally {
      reader.close();
      store.close();
    }
  });

  it("rolls back when a faulty final fence swallows the mutation exception", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ fence: "swallowed-mutation-error" });
    const store = await openSqliteGraphStore({
      databasePath,
      faultInjector: ({ entityIndex, stage }) => {
        if (stage === "edge" && entityIndex === 0) {
          throw Object.assign(new Error("disk full after node writes"), { code: "SQLITE_FULL" });
        }
      },
      workspaceKey,
    });
    const jobId = "job-swallowed-mutation-error";
    createJob(store, {
      id: jobId,
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning(jobId, "2026-07-25T00:00:01.000Z");

    expect(() => commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      finalReadSetFence: (commitMutation) => {
        try {
          commitMutation();
        } catch {
          /** 模拟错误实现吞掉 mutation 异常并错误返回 stale。 */
        }
        return false;
      },
      graph: buildHierarchyGraph(workspaceKey, ["src/index.ts"]),
      jobId,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 2,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: 3,
      },
    })).toThrow(/disk full after node writes/u);
    expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    expect(store.readBootstrapState()).toMatchObject({ committed: null });
    const reader = new RawSqlite(databasePath, { readonly: true });
    try {
      expect(reader.prepare(
        "SELECT state, result_graph_revision FROM jobs WHERE id = ?",
      ).get(jobId)).toEqual({ result_graph_revision: null, state: "running" });
    } finally {
      reader.close();
      store.close();
    }
  });

  it("rolls back when a faulty final fence swallows a thrown undefined value", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ fence: "swallowed-undefined" });
    /** Generator.throw 复现合法但非 Error 的 JavaScript throw 值，同时遵守 lint 约束。 */
    const undefinedThrower = (function* (): Generator<void, void, undefined> {
      yield;
    })();
    undefinedThrower.next();
    const store = await openSqliteGraphStore({
      databasePath,
      faultInjector: ({ entityIndex, stage }) => {
        if (stage === "edge" && entityIndex === 0) {
          undefinedThrower.throw(undefined);
        }
      },
      workspaceKey,
    });
    const jobId = "job-swallowed-undefined";
    createJob(store, {
      id: jobId,
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning(jobId, "2026-07-25T00:00:01.000Z");

    let caught = false;
    try {
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        finalReadSetFence: (commitMutation) => {
          try {
            commitMutation();
          } catch {
            /** 模拟 fence 吞掉任意 JavaScript throw 值，而不只吞 Error 实例。 */
          }
          return false;
        },
        graph: buildHierarchyGraph(workspaceKey, ["src/index.ts"]),
        jobId,
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: 2,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: 3,
        },
      });
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    expect(store.readBootstrapState()).toMatchObject({ committed: null });
    store.close();
  });

  it("rolls back nodes, edges, ownership, metadata/revision and Job failures", async () => {
    const cases = [
      { entityIndex: 1, stage: "node" },
      { entityIndex: 0, stage: "edge" },
      { entityIndex: 0, stage: "ownership" },
      { entityIndex: 0, stage: "metadata" },
      { entityIndex: 0, stage: "job" },
    ] as const;
    for (const faultTarget of cases) {
      const workspaceKey = sha256CanonicalJson(faultTarget);
      const databasePath = await createDatabasePath();
      const store = await openSqliteGraphStore({
        databasePath,
        faultInjector: ({ entityIndex, stage }) => {
          if (stage === faultTarget.stage && entityIndex === faultTarget.entityIndex) {
            throw Object.assign(new Error(`disk full at ${stage}`), { code: "SQLITE_FULL" });
          }
        },
        workspaceKey,
      });
      const reader = new RawSqlite(databasePath);
      try {
        const jobId = `job-fail-${faultTarget.stage}`;
        createJob(store, {
          id: jobId,
          kind: "initial-index",
          requestedAt: "2026-07-25T00:00:00.000Z",
        });
        store.markJobRunning(jobId, "2026-07-25T00:00:01.000Z");
        expect(() => commitHierarchy(store, {
          completedAt: "2026-07-25T00:00:02.000Z",
          graph: buildHierarchyGraph(workspaceKey, ["src/index.ts"]),
          jobId,
          summary: {
            builtinRulesVersion: "builtin-ignore-v1",
            edgeCount: 2,
            excludedPathCount: 0,
            generatedAt: "2026-07-25T00:00:02.000Z",
            indexedFileCount: 1,
            nodeCount: 3,
          },
        })).toThrow(/disk full/u);
        expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
        expect(store.listOwnership()).toEqual([]);
        expect(store.readBootstrapState()).toMatchObject({
          committed: null,
          completeness: "empty",
          freshness: null,
        });
        expect(reader.prepare(
          "SELECT graph_revision, patch_digest FROM workspace WHERE workspace_key = ?",
        ).get(workspaceKey)).toEqual({ graph_revision: null, patch_digest: null });
        expect(reader.prepare(
          "SELECT state, result_graph_revision FROM jobs WHERE id = ?",
        ).get(jobId)).toEqual({ result_graph_revision: null, state: "running" });
      } finally {
        reader.close();
        store.close();
      }
    }
  });

  it("migrates a real v1 empty commit to revision 1, stale freshness, and hierarchy ownership", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "c".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    rawDatabase.prepare(`
      INSERT INTO workspace(
        workspace_key, committed_at, indexed_file_count, node_count, edge_count,
        excluded_path_count, builtin_rules_version
      ) VALUES (?, ?, 0, 1, 0, 0, 'builtin-ignore-v1')
    `).run(workspaceKey, "2026-07-25T00:00:02.000Z");
    rawDatabase.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path)
      VALUES (?, ?, 'workspace', '')
    `).run(graph.nodes[0]!.id, workspaceKey);
    rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, completed_at,
        error_code, error_log_id
      ) VALUES (?, ?, 'initial-index', 'failed', ?, ?, ?, ?, ?)
    `).run(
      "job-v1-failed-before-success",
      workspaceKey,
      "2026-07-24T23:59:57.000Z",
      "2026-07-24T23:59:58.000Z",
      "2026-07-24T23:59:59.000Z",
      "GRAPH_SCAN_FAILED",
      "log-v1-failed-before-success",
    );
    rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, completed_at
      ) VALUES (?, ?, 'initial-index', 'succeeded', ?, ?, ?)
    `).run(
      "job-v1-empty",
      workspaceKey,
      "2026-07-25T00:00:00.000Z",
      "2026-07-25T00:00:01.000Z",
      "2026-07-25T00:00:02.000Z",
    );
    rawDatabase.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
      `bootstrap-committed-job:${workspaceKey}`,
      "job-v1-empty",
    );
    rawDatabase.close();

    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(store.readBootstrapState()).toMatchObject({
        committed: { graphRevision: 1, indexedFileCount: 0 },
        freshness: "stale",
        lastJob: {
          baseGraphRevision: null,
          id: "job-v1-empty",
          resultGraphRevision: 1,
          state: "succeeded",
        },
      });
      expect(store.listOwnership()).toEqual([
        {
          factId: graph.nodes[0]!.id,
          factKind: "node",
          ownerKey: `hierarchy:${graph.nodes[0]!.id}`,
        },
      ]);
      const migratedDatabase = new RawSqlite(databasePath, { readonly: true });
      try {
        expect(migratedDatabase.prepare(`
          SELECT base_graph_revision, result_graph_revision, legacy_schema_version
          FROM jobs WHERE id = 'job-v1-failed-before-success'
        `).get()).toEqual({
          base_graph_revision: null,
          legacy_schema_version: 1,
          result_graph_revision: null,
        });
        expect(migratedDatabase.prepare(`
          SELECT legacy_schema_version FROM jobs WHERE id = 'job-v1-empty'
        `).get()).toEqual({ legacy_schema_version: 1 });
      } finally {
        migratedDatabase.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects a v1 orphan Job instead of dropping it during migration", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "orphan-v1-job" });
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    /** 模拟旧进程在未启用外键检查时留下的损坏缓存。 */
    rawDatabase.pragma("foreign_keys = OFF");
    rawDatabase.prepare(`
      INSERT INTO jobs(id, workspace_key, kind, state, requested_at)
      VALUES (?, ?, 'initial-index', 'queued', ?)
    `).run(
      "job-v1-orphan",
      "missing-workspace",
      "2026-07-26T00:00:00.000Z",
    );
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/外键完整性/u);
  });

  it("rejects foreign-key corruption in an already migrated v2 database", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "orphan-v2-job" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    /** 模拟外部旧工具关闭外键约束后写入损坏的 v2 Job。 */
    rawDatabase.pragma("foreign_keys = OFF");
    rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at,
        base_graph_revision, result_graph_revision, legacy_schema_version
      ) VALUES (?, ?, 'initial-index', 'queued', ?, NULL, NULL, NULL)
    `).run(
      "job-v2-orphan",
      "missing-workspace",
      "2026-07-26T00:00:01.000Z",
    );
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/外键完整性/u);
  });

  it("rejects v1 ownership whose fact exists only in another workspace", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "cross-workspace-v1-owner" });
    const otherWorkspaceKey = sha256CanonicalJson({ migration: "cross-workspace-v1-fact" });
    const openedWorkspaceKey = sha256CanonicalJson({ migration: "cross-workspace-v1-open" });
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    rawDatabase.pragma("foreign_keys = ON");
    rawDatabase.prepare("INSERT INTO workspace(workspace_key) VALUES (?), (?)")
      .run(workspaceKey, otherWorkspaceKey);
    rawDatabase.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path)
      VALUES ('foreign-root', ?, 'workspace', ''),
             ('foreign-node', ?, 'file', 'foreign.ts')
    `).run(otherWorkspaceKey, otherWorkspaceKey);
    /** ownership 的父 workspace 合法，但 fact 属于另一 workspace，SQLite FK 无法表达该约束。 */
    rawDatabase.prepare(`
      INSERT INTO facts_ownership(fact_id, owner_key, workspace_key)
      VALUES ('foreign-node', 'hierarchy:foreign', ?)
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey: openedWorkspaceKey }).then(
      (openedStore) => {
        openedStore.close();
        return openedStore;
      },
    ))
      .rejects.toThrow(/ownership/u);
  });

  it("rejects a v1 ownership fact id that is ambiguous across node and edge", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "ambiguous-v1-owner" });
    const openedWorkspaceKey = sha256CanonicalJson({ migration: "ambiguous-v1-open" });
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    rawDatabase.pragma("foreign_keys = ON");
    rawDatabase.prepare("INSERT INTO workspace(workspace_key) VALUES (?)").run(workspaceKey);
    rawDatabase.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path)
      VALUES ('shared-fact-id', ?, 'workspace', ''),
             ('child-node', ?, 'file', 'child.ts')
    `).run(workspaceKey, workspaceKey);
    rawDatabase.prepare(`
      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      VALUES ('shared-fact-id', ?, 'shared-fact-id', 'contains', 'child-node', '')
    `).run(workspaceKey);
    rawDatabase.prepare(`
      INSERT INTO facts_ownership(fact_id, owner_key, workspace_key)
      VALUES ('shared-fact-id', 'hierarchy:shared', ?)
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey: openedWorkspaceKey }))
      .rejects.toThrow(/ownership/u);
  });

  it.each(["missing", "multiple"] as const)(
    "rejects a v1 workspace with facts and %s hierarchy roots",
    async (rootMode) => {
      const databasePath = await createDatabasePath();
      const workspaceKey = sha256CanonicalJson({ migration: `v1-root-${rootMode}` });
      const openedWorkspaceKey = sha256CanonicalJson({ migration: `v1-root-open-${rootMode}` });
      const rawDatabase = new RawSqlite(databasePath);
      applyBootstrapMigration(rawDatabase as never);
      rawDatabase.pragma("foreign_keys = ON");
      rawDatabase.prepare("INSERT INTO workspace(workspace_key) VALUES (?)").run(workspaceKey);
      if (rootMode === "missing") {
        rawDatabase.prepare(`
          INSERT INTO nodes(id, workspace_key, kind, relative_path)
          VALUES ('rootless-file', ?, 'file', 'rootless.ts')
        `).run(workspaceKey);
      } else {
        rawDatabase.prepare(`
          INSERT INTO nodes(id, workspace_key, kind, relative_path)
          VALUES ('root-one', ?, 'workspace', ''),
                 ('root-two', ?, 'workspace', 'duplicate-root')
        `).run(workspaceKey, workspaceKey);
      }
      rawDatabase.close();

      await expect(openSqliteGraphStore({
        databasePath,
        workspaceKey: openedWorkspaceKey,
      }).then((openedStore) => {
        openedStore.close();
        return openedStore;
      })).rejects.toThrow(/root/u);
    },
  );

  it("rejects a v1 ownership that is not bound to its workspace root", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "v1-ghost-owner" });
    const openedWorkspaceKey = sha256CanonicalJson({ migration: "v1-ghost-owner-open" });
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    rawDatabase.pragma("foreign_keys = ON");
    rawDatabase.prepare("INSERT INTO workspace(workspace_key) VALUES (?)").run(workspaceKey);
    rawDatabase.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path)
      VALUES ('canonical-root', ?, 'workspace', ''),
             ('owned-file', ?, 'file', 'owned.ts')
    `).run(workspaceKey, workspaceKey);
    /** 旧表允许任意 owner；迁移必须拒绝幽灵 owner，而不是把它复制到 v2。 */
    rawDatabase.prepare(`
      INSERT INTO facts_ownership(fact_id, owner_key, workspace_key)
      VALUES ('owned-file', 'hierarchy:ghost-root', ?)
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey: openedWorkspaceKey }))
      .rejects.toThrow(/ownership/u);
  });

  it.each([
    "missing-root",
    "multiple-root",
    "unowned-node",
    "unowned-edge",
    "cross-workspace-edge",
    "extra-owner",
    "unknown-node-kind",
    "unknown-relation",
    "noncanonical-backslash",
    "noncanonical-unicode",
    "path-kind-collision",
    "unsupported-file",
    "empty-directory",
    "cycle",
    "disconnected",
  ] as const)("rejects global v2 hierarchy corruption: %s", async (corruption) => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: `v2-global-${corruption}` });
    const openedWorkspaceKey = sha256CanonicalJson({ migration: `v2-global-open-${corruption}` });
    const relativePath = corruption === "noncanonical-backslash"
      ? "index.ts"
      : (corruption === "noncanonical-unicode"
        ? "src/indéx.ts"
        : (corruption === "path-kind-collision" ? "src.ts/index.ts" : "src/index.ts"));
    const graph = buildHierarchyGraph(workspaceKey, [relativePath]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: `job-v2-global-${corruption}`,
      kind: "initial-index",
      requestedAt: "2026-07-26T00:00:00.000Z",
    });
    store.markJobRunning(`job-v2-global-${corruption}`, "2026-07-26T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-26T00:00:02.000Z",
      graph,
      jobId: `job-v2-global-${corruption}`,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-26T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: graph.nodes.length,
      },
    });
    store.close();

    const root = graph.nodes.find((node) => node.kind === "workspace")!;
    const file = graph.nodes.find((node) => node.kind === "file")!;
    const edge = graph.edges[0]!;
    const rawDatabase = new RawSqlite(databasePath);
    if (corruption === "missing-root") {
      rawDatabase.prepare("UPDATE nodes SET kind = 'directory' WHERE id = ?").run(root.id);
    } else if (corruption === "multiple-root") {
      rawDatabase.prepare(`
        INSERT INTO nodes(id, workspace_key, kind, relative_path)
        VALUES ('duplicate-root', ?, 'workspace', 'duplicate-root')
      `).run(workspaceKey);
    } else if (corruption === "unowned-node") {
      rawDatabase.prepare(`
        DELETE FROM facts_ownership WHERE fact_kind = 'node' AND fact_id = ?
      `).run(file.id);
    } else if (corruption === "unowned-edge") {
      rawDatabase.prepare(`
        DELETE FROM facts_ownership WHERE fact_kind = 'edge' AND fact_id = ?
      `).run(edge.id);
    } else if (corruption === "cross-workspace-edge") {
      const foreignWorkspaceKey = sha256CanonicalJson({ migration: "v2-edge-foreign" });
      rawDatabase.prepare("INSERT INTO workspace(workspace_key) VALUES (?)").run(foreignWorkspaceKey);
      rawDatabase.prepare(`
        INSERT INTO nodes(id, workspace_key, kind, relative_path)
        VALUES ('foreign-root', ?, 'workspace', '')
      `).run(foreignWorkspaceKey);
      rawDatabase.prepare("UPDATE edges SET workspace_key = ? WHERE id = ?")
        .run(foreignWorkspaceKey, edge.id);
      rawDatabase.prepare("DELETE FROM facts_ownership WHERE fact_kind = 'edge' AND fact_id = ?")
        .run(edge.id);
      rawDatabase.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES ('edge', ?, 'hierarchy:foreign-root', ?)
      `).run(edge.id, foreignWorkspaceKey);
      rawDatabase.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES ('node', 'foreign-root', 'hierarchy:foreign-root', ?)
      `).run(foreignWorkspaceKey);
    } else if (corruption === "extra-owner") {
      rawDatabase.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES ('node', ?, 'hierarchy:ghost-root', ?)
      `).run(file.id, workspaceKey);
    } else if (corruption === "unknown-node-kind") {
      rawDatabase.pragma("ignore_check_constraints = ON");
      rawDatabase.pragma("foreign_keys = OFF");
      const futureNodeId = buildGraphEntityId(
        workspaceKey,
        "future-kind" as never,
        file.relativePath,
      );
      const fileEdge = graph.edges.find((candidate) => candidate.toId === file.id)!;
      const futureEdgeId = buildGraphEdgeId(
        workspaceKey,
        fileEdge.fromId,
        fileEdge.relationType,
        futureNodeId,
      );
      rawDatabase.prepare("UPDATE nodes SET id = ?, kind = 'future-kind' WHERE id = ?")
        .run(futureNodeId, file.id);
      rawDatabase.prepare("UPDATE edges SET id = ?, to_id = ? WHERE id = ?")
        .run(futureEdgeId, futureNodeId, fileEdge.id);
      rawDatabase.prepare(`
        UPDATE facts_ownership SET fact_id = ?
        WHERE fact_kind = 'node' AND fact_id = ?
      `).run(futureNodeId, file.id);
      rawDatabase.prepare(`
        UPDATE facts_ownership SET fact_id = ?
        WHERE fact_kind = 'edge' AND fact_id = ?
      `).run(futureEdgeId, fileEdge.id);
    } else if (corruption === "unknown-relation") {
      rawDatabase.pragma("ignore_check_constraints = ON");
      const edgeWithFutureRelation = graph.edges[0]!;
      const futureEdgeId = buildGraphEdgeId(
        workspaceKey,
        edgeWithFutureRelation.fromId,
        "imports" as never,
        edgeWithFutureRelation.toId,
      );
      rawDatabase.prepare("UPDATE edges SET id = ?, relation_type = 'imports' WHERE id = ?")
        .run(futureEdgeId, edgeWithFutureRelation.id);
      rawDatabase.prepare(`
        UPDATE facts_ownership SET fact_id = ?
        WHERE fact_kind = 'edge' AND fact_id = ?
      `).run(futureEdgeId, edgeWithFutureRelation.id);
    } else if (corruption === "noncanonical-backslash") {
      /** 规范 ID 不变，但原始持久路径不得依赖读取时再消除 dot/反斜杠。 */
      rawDatabase.prepare("UPDATE nodes SET relative_path = '.\\index.ts' WHERE id = ?")
        .run(file.id);
    } else if (corruption === "noncanonical-unicode") {
      /** 规范 ID 不变，但 NFD 原文不得伪装成已持久化的 NFC 路径。 */
      rawDatabase.prepare("UPDATE nodes SET relative_path = ? WHERE id = ?")
        .run(file.relativePath.normalize("NFD"), file.id);
    } else if (corruption === "path-kind-collision") {
      const collidingPath = "src.ts";
      const collidingFileId = buildGraphEntityId(workspaceKey, "file", collidingPath);
      const collidingEdgeId = buildGraphEdgeId(
        workspaceKey,
        root.id,
        "contains",
        collidingFileId,
      );
      rawDatabase.prepare(`
        INSERT INTO nodes(id, workspace_key, kind, relative_path)
        VALUES (?, ?, 'file', ?)
      `).run(collidingFileId, workspaceKey, collidingPath);
      rawDatabase.prepare(`
        INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
        VALUES (?, ?, ?, 'contains', ?, '')
      `).run(collidingEdgeId, workspaceKey, root.id, collidingFileId);
      rawDatabase.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES ('node', ?, ?, ?), ('edge', ?, ?, ?)
      `).run(
        collidingFileId,
        `hierarchy:${root.id}`,
        workspaceKey,
        collidingEdgeId,
        `hierarchy:${root.id}`,
        workspaceKey,
      );
    } else if (corruption === "unsupported-file") {
      const unsupportedPath = "src/index.txt";
      const unsupportedFileId = buildGraphEntityId(workspaceKey, "file", unsupportedPath);
      const fileEdge = graph.edges.find((candidate) => candidate.toId === file.id)!;
      const unsupportedEdgeId = buildGraphEdgeId(
        workspaceKey,
        fileEdge.fromId,
        fileEdge.relationType,
        unsupportedFileId,
      );
      rawDatabase.pragma("foreign_keys = OFF");
      rawDatabase.prepare("UPDATE nodes SET id = ?, relative_path = ? WHERE id = ?")
        .run(unsupportedFileId, unsupportedPath, file.id);
      rawDatabase.prepare("UPDATE edges SET id = ?, to_id = ? WHERE id = ?")
        .run(unsupportedEdgeId, unsupportedFileId, fileEdge.id);
      rawDatabase.prepare(`
        UPDATE facts_ownership SET fact_id = ?
        WHERE fact_kind = 'node' AND fact_id = ?
      `).run(unsupportedFileId, file.id);
      rawDatabase.prepare(`
        UPDATE facts_ownership SET fact_id = ?
        WHERE fact_kind = 'edge' AND fact_id = ?
      `).run(unsupportedEdgeId, fileEdge.id);
    } else if (corruption === "empty-directory") {
      const emptyDirectoryId = buildGraphEntityId(workspaceKey, "directory", "empty");
      const emptyDirectoryEdgeId = buildGraphEdgeId(
        workspaceKey,
        root.id,
        "contains",
        emptyDirectoryId,
      );
      rawDatabase.prepare(`
        INSERT INTO nodes(id, workspace_key, kind, relative_path)
        VALUES (?, ?, 'directory', 'empty')
      `).run(emptyDirectoryId, workspaceKey);
      rawDatabase.prepare(`
        INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
        VALUES (?, ?, ?, 'contains', ?, '')
      `).run(emptyDirectoryEdgeId, workspaceKey, root.id, emptyDirectoryId);
      rawDatabase.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES ('node', ?, ?, ?), ('edge', ?, ?, ?)
      `).run(
        emptyDirectoryId,
        `hierarchy:${root.id}`,
        workspaceKey,
        emptyDirectoryEdgeId,
        `hierarchy:${root.id}`,
        workspaceKey,
      );
    } else {
      const rootEdge = graph.edges.find((candidate) => candidate.fromId === root.id)!;
      if (corruption === "cycle") {
        /** 保持端点同 workspace 与 ownership 完整，只把 root 分支改成目录/文件环。 */
        const cycleEdgeId = buildGraphEdgeId(
          workspaceKey,
          file.id,
          rootEdge.relationType,
          rootEdge.toId,
        );
        rawDatabase.prepare("UPDATE edges SET id = ?, from_id = ? WHERE id = ?")
          .run(cycleEdgeId, file.id, rootEdge.id);
        rawDatabase.prepare(`
          UPDATE facts_ownership SET fact_id = ?
          WHERE fact_kind = 'edge' AND fact_id = ?
        `).run(cycleEdgeId, rootEdge.id);
      } else {
        rawDatabase.prepare("DELETE FROM edges WHERE id = ?").run(rootEdge.id);
        rawDatabase.prepare(`
          DELETE FROM facts_ownership WHERE fact_kind = 'edge' AND fact_id = ?
        `).run(rootEdge.id);
      }
    }
    rawDatabase.close();

    /** 打开无关干净 workspace，证明完整性检查覆盖数据库全局而非当前 slice。 */
    await expect(openSqliteGraphStore({ databasePath, workspaceKey: openedWorkspaceKey }).then(
      (openedStore) => {
        openedStore.close();
        return openedStore;
      },
    ))
      .rejects.toThrow();
  });

  it("rejects a v2 polymorphic ownership whose declared fact does not exist", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "orphan-v2-ownership" });
    const openedWorkspaceKey = sha256CanonicalJson({ migration: "orphan-v2-open" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.close();
    const rawDatabase = new RawSqlite(databasePath);
    /** v2 只对 workspace_key 声明 SQLite FK，fact_kind/fact_id 必须由打开路径语义校验。 */
    rawDatabase.prepare(`
      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      VALUES ('node', 'missing-node', 'hierarchy:missing', ?)
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey: openedWorkspaceKey }))
      .rejects.toThrow(/ownership/u);
  });

  it("rejects a v2 ownership with an unknown fact kind", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "unknown-v2-fact-kind" });
    const openedWorkspaceKey = sha256CanonicalJson({ migration: "unknown-v2-kind-open" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.close();
    const rawDatabase = new RawSqlite(databasePath);
    /** 模拟外部工具显式关闭 CHECK 约束后写入当前合同未知的多态 kind。 */
    rawDatabase.pragma("ignore_check_constraints = ON");
    rawDatabase.prepare(`
      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      VALUES ('future-kind', 'missing-fact', 'hierarchy:future', ?)
    `).run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey: openedWorkspaceKey }))
      .rejects.toThrow(/ownership/u);
  });

  it.each(["v1", "v2"] as const)(
    "holds an immediate writer lock while validating a %s migration",
    async (schemaVersion) => {
      const databasePath = await createDatabasePath();
      const migrationDatabase = new RawSqlite(databasePath);
      applyBootstrapMigration(migrationDatabase as never);
      if (schemaVersion === "v2") {
        applyDeterministicCommitMigration(migrationDatabase as never);
      }
      migrationDatabase.pragma("foreign_keys = ON");
      const competingDatabase = new RawSqlite(databasePath);
      competingDatabase.pragma("foreign_keys = OFF");
      competingDatabase.pragma("busy_timeout = 0");
      const originalTransaction = migrationDatabase.transaction.bind(migrationDatabase);
      let competingWrite: unknown = "not-attempted";
      migrationDatabase.transaction = ((callback: () => void) => {
        const wrapped = originalTransaction(() => {
          try {
            competingDatabase.prepare(`
              INSERT INTO facts_ownership(fact_id, owner_key, workspace_key)
              VALUES ('orphan-fact', 'hierarchy:orphan', 'missing-workspace')
            `).run();
            competingWrite = "succeeded";
          } catch (error) {
            competingWrite = error;
          }
          callback();
        });
        return wrapped;
      }) as RawSqliteDatabase["transaction"];

      try {
        applyDeterministicCommitMigration(migrationDatabase as never);
        expect(competingWrite).toMatchObject({ code: "SQLITE_BUSY" });
      } finally {
        competingDatabase.close();
        migrationDatabase.close();
      }
    },
  );

  it("preserves a succeeded v1 rebuild as a no-op on its committed revision", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "succeeded-v1-rebuild" });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    rawDatabase.prepare(`
      INSERT INTO workspace(
        workspace_key, committed_at, indexed_file_count, node_count, edge_count,
        excluded_path_count, builtin_rules_version
      ) VALUES (?, ?, 1, ?, ?, 0, 'builtin-ignore-v1')
    `).run(
      workspaceKey,
      "2026-07-25T00:00:02.000Z",
      graph.nodes.length,
      graph.edges.length,
    );
    const insertNode = rawDatabase.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path) VALUES (?, ?, ?, ?)
    `);
    for (const node of graph.nodes) {
      insertNode.run(node.id, workspaceKey, node.kind, node.relativePath);
    }
    const insertEdge = rawDatabase.prepare(`
      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const edge of graph.edges) {
      insertEdge.run(
        edge.id,
        workspaceKey,
        edge.fromId,
        edge.relationType,
        edge.toId,
        edge.qualifier,
      );
    }
    rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, completed_at
      ) VALUES (?, ?, 'rebuild', 'succeeded', ?, ?, ?)
    `).run(
      "job-v1-rebuild",
      workspaceKey,
      "2026-07-25T00:00:00.000Z",
      "2026-07-25T00:00:01.000Z",
      "2026-07-25T00:00:02.000Z",
    );
    rawDatabase.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(
      `bootstrap-committed-job:${workspaceKey}`,
      "job-v1-rebuild",
    );
    rawDatabase.close();

    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(store.readBootstrapState()).toMatchObject({
        committed: { graphRevision: 1, indexedFileCount: 1 },
        freshness: "stale",
        lastJob: {
          baseGraphRevision: 1,
          id: "job-v1-rebuild",
          resultGraphRevision: 1,
          state: "succeeded",
        },
      });
    } finally {
      store.close();
    }
  });

  it("rejects corrupted legacy hierarchy topology even though v1 has no committed read-set", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ migration: "corrupted-v1-topology" });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const rawDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(rawDatabase as never);
    rawDatabase.prepare(`
      INSERT INTO workspace(
        workspace_key, committed_at, indexed_file_count, node_count, edge_count,
        excluded_path_count, builtin_rules_version
      ) VALUES (?, ?, 1, ?, ?, 0, 'builtin-ignore-v1')
    `).run(
      workspaceKey,
      "2026-07-25T00:00:02.000Z",
      graph.nodes.length,
      graph.edges.length,
    );
    const insertNode = rawDatabase.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path) VALUES (?, ?, ?, ?)
    `);
    for (const node of graph.nodes) {
      insertNode.run(node.id, workspaceKey, node.kind, node.relativePath);
    }
    const insertEdge = rawDatabase.prepare(`
      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const edge of graph.edges) {
      insertEdge.run(
        edge.id,
        workspaceKey,
        edge.fromId,
        edge.relationType,
        edge.toId,
        edge.qualifier,
      );
    }
    rawDatabase.prepare(`
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, completed_at
      ) VALUES (?, ?, 'initial-index', 'succeeded', ?, ?, ?)
    `).run(
      "job-v1-corrupted-topology",
      workspaceKey,
      "2026-07-25T00:00:00.000Z",
      "2026-07-25T00:00:01.000Z",
      "2026-07-25T00:00:02.000Z",
    );
    rawDatabase.prepare("UPDATE edges SET qualifier = 'tampered' WHERE workspace_key = ?")
      .run(workspaceKey);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow();
  });

  it("keeps graphRevision and ownership stable for an identical rebuild", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "d".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      createJob(store, {
        id: "job-first-revision",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning("job-first-revision", "2026-07-25T00:00:01.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: "job-first-revision",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      });
      const firstOwnership = store.listOwnership();

      createJob(store, {
        id: "job-noop-revision",
        kind: "rebuild",
        requestedAt: "2026-07-25T00:00:03.000Z",
      });
      store.markJobRunning("job-noop-revision", "2026-07-25T00:00:04.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:05.000Z",
        graph,
        jobId: "job-noop-revision",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:05.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      });

      expect(store.readBootstrapState()).toMatchObject({
        committed: { graphRevision: 1 },
        lastJob: { id: "job-noop-revision", resultGraphRevision: 1, state: "succeeded" },
      });
      expect(store.listOwnership()).toEqual(firstOwnership);
      expect(store.listOwnership()).toHaveLength(graph.nodes.length + graph.edges.length);
    } finally {
      store.close();
    }
  });

  it("persists partial/stale workspace evidence across service restarts", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "8".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-partial-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-partial-baseline", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-partial-baseline",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: graph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-partial-rebuild",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-partial-rebuild", "2026-07-25T00:00:04.000Z");
    store.markJobPartial("job-partial-rebuild", "2026-07-25T00:00:05.000Z");
    expect(store.readBootstrapState()).toMatchObject({
      committed: { graphRevision: 1 },
      completeness: "partial",
      freshness: "stale",
      lastJob: { id: "job-partial-rebuild", state: "partial" },
    });
    store.close();

    const reopened = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      expect(reopened.readBootstrapState()).toMatchObject({
        committed: { graphRevision: 1 },
        completeness: "partial",
        freshness: "stale",
        lastJob: { id: "job-partial-rebuild", state: "partial" },
      });
    } finally {
      reopened.close();
    }
  });

  it("fails closed when a trigger silently ignores partial or stale workspace updates", async () => {
    const scenarios = ["partial", "failed-stale", "stale-only"] as const;
    for (const scenario of scenarios) {
      const databasePath = await createDatabasePath();
      const workspaceKey = sha256CanonicalJson({ scenario });
      const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
      const store = await openSqliteGraphStore({ databasePath, workspaceKey });
      const baselineJobId = `job-trigger-baseline-${scenario}`;
      createJob(store, {
        id: baselineJobId,
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning(baselineJobId, "2026-07-25T00:00:01.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: baselineJobId,
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      });
      const terminalJobId = `job-trigger-terminal-${scenario}`;
      if (scenario !== "stale-only") {
        createJob(store, {
          id: terminalJobId,
          kind: "rebuild",
          requestedAt: "2026-07-25T00:00:03.000Z",
        });
        store.markJobRunning(terminalJobId, "2026-07-25T00:00:04.000Z");
      }
      const rawDatabase = new RawSqlite(databasePath);
      rawDatabase.exec(`
        CREATE TRIGGER ignore_workspace_state
        BEFORE UPDATE OF freshness, completeness ON workspace
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      try {
        const action = scenario === "partial"
          ? () => store.markJobPartial(terminalJobId, "2026-07-25T00:00:05.000Z")
          : scenario === "failed-stale"
            ? () => store.markJobFailedAndWorkspaceStale(
                terminalJobId,
                "2026-07-25T00:00:05.000Z",
                "GRAPH_SCAN_FAILED",
                "log-trigger-failed",
              )
            : () => store.markWorkspaceStale();
        expect(action).toThrow();
        expect(rawDatabase.prepare(`
          SELECT freshness, completeness FROM workspace WHERE workspace_key = ?
        `).get(workspaceKey)).toEqual({ completeness: "complete", freshness: "current" });
        if (scenario !== "stale-only") {
          expect(rawDatabase.prepare("SELECT state FROM jobs WHERE id = ?")
            .get(terminalJobId)).toEqual({ state: "running" });
        }
      } finally {
        rawDatabase.exec("DROP TRIGGER ignore_workspace_state");
        rawDatabase.close();
        store.close();
      }
    }
  });

  it("fails closed when triggers ignore queued creation or rewrite the running transition", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "job-lifecycle-write" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER ignore_queued_job
      BEFORE INSERT ON jobs
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    try {
      expect(() => store.createJob({
        baseGraphRevision: null,
        id: "job-trigger-ignored-create",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      })).toThrow();
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM jobs WHERE workspace_key = ?")
        .get(workspaceKey)).toEqual({ count: 0 });
      rawDatabase.exec("DROP TRIGGER ignore_queued_job");

      store.createJob({
        baseGraphRevision: null,
        id: "job-trigger-rewritten-running",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      rawDatabase.exec(`
        CREATE TRIGGER rewrite_running_job
        AFTER UPDATE OF state ON jobs
        WHEN NEW.state = 'running'
        BEGIN
          UPDATE jobs SET started_at = '2026-07-25T00:00:09.000Z' WHERE id = NEW.id;
        END;
      `);
      expect(() => store.markJobRunning(
        "job-trigger-rewritten-running",
        "2026-07-25T00:00:01.000Z",
      )).toThrow();
      expect(rawDatabase.prepare("SELECT state, started_at FROM jobs WHERE id = ?")
        .get("job-trigger-rewritten-running")).toEqual({ started_at: null, state: "queued" });
    } finally {
      rawDatabase.exec("DROP TRIGGER IF EXISTS ignore_queued_job");
      rawDatabase.exec("DROP TRIGGER IF EXISTS rewrite_running_job");
      rawDatabase.close();
      store.close();
    }
  });

  it("rolls back Job lifecycle writes when a trigger mutates graph tables", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "job-cross-table-write" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER inject_node_from_queued_job
      AFTER INSERT ON jobs
      BEGIN
        INSERT INTO nodes(id, workspace_key, kind, relative_path)
        VALUES ('trigger-queued-node', NEW.workspace_key, 'file', 'trigger-queued.ts');
      END;
    `);
    try {
      expect(() => store.createJob({
        baseGraphRevision: null,
        id: "job-trigger-cross-table-create",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      })).toThrow(/旁路表/u);
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 });
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toEqual({ count: 0 });
      rawDatabase.exec("DROP TRIGGER inject_node_from_queued_job");

      store.createJob({
        baseGraphRevision: null,
        id: "job-trigger-cross-table-running",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      rawDatabase.exec(`
        CREATE TRIGGER inject_node_from_running_job
        AFTER UPDATE OF state ON jobs
        WHEN NEW.state = 'running'
        BEGIN
          INSERT INTO nodes(id, workspace_key, kind, relative_path)
          VALUES ('trigger-running-node', NEW.workspace_key, 'file', 'trigger-running.ts');
        END;
      `);
      expect(() => store.markJobRunning(
        "job-trigger-cross-table-running",
        "2026-07-25T00:00:01.000Z",
      )).toThrow(/旁路表/u);
      expect(rawDatabase.prepare("SELECT state FROM jobs WHERE id = ?")
        .get("job-trigger-cross-table-running")).toEqual({ state: "queued" });
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toEqual({ count: 0 });
    } finally {
      rawDatabase.exec("DROP TRIGGER IF EXISTS inject_node_from_queued_job");
      rawDatabase.exec("DROP TRIGGER IF EXISTS inject_node_from_running_job");
      rawDatabase.close();
      store.close();
    }
  });

  it("rolls back an atomic commit when an AFTER trigger rewrites the final workspace state", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "atomic-workspace-rewrite" });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-after-trigger-commit",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-after-trigger-commit", "2026-07-25T00:00:01.000Z");
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER rewrite_committed_workspace
      AFTER UPDATE OF freshness ON workspace
      WHEN NEW.freshness = 'current'
      BEGIN
        UPDATE workspace SET freshness = 'stale' WHERE workspace_key = NEW.workspace_key;
      END;
    `);
    try {
      expect(() => commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: "job-after-trigger-commit",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      })).toThrow();
      expect(rawDatabase.prepare(`
        SELECT graph_revision, freshness, committed_at
        FROM workspace WHERE workspace_key = ?
      `).get(workspaceKey)).toEqual({ committed_at: null, freshness: null, graph_revision: null });
      expect(rawDatabase.prepare("SELECT state FROM jobs WHERE id = ?")
        .get("job-after-trigger-commit")).toEqual({ state: "running" });
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM nodes WHERE workspace_key = ?")
        .get(workspaceKey)).toEqual({ count: 0 });
    } finally {
      rawDatabase.exec("DROP TRIGGER rewrite_committed_workspace");
      rawDatabase.close();
      store.close();
    }
  });

  it("rolls back an atomic commit when a trigger writes an undeclared authority row", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "atomic-cross-table-write" });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-atomic-cross-table",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-atomic-cross-table", "2026-07-25T00:00:01.000Z");
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER inject_evidence_during_commit
      AFTER UPDATE OF graph_revision ON workspace
      WHEN NEW.graph_revision IS NOT NULL
      BEGIN
        INSERT INTO evidence(
          id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
          range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
        )
        SELECT
          'trigger-commit-evidence', NEW.workspace_key, edge.id,
          'typescript-compiler-api', '6.0.3', file.id,
          0, 1, 'module-dependency', 'high', 'typescript',
          '2026-07-25T00:00:02.000Z', '{}'
        FROM edges AS edge
        JOIN nodes AS file ON file.workspace_key = NEW.workspace_key AND file.kind = 'file'
        WHERE edge.workspace_key = NEW.workspace_key
        LIMIT 1;
      END;
    `);
    try {
      expect(() => commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: "job-atomic-cross-table",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      })).toThrow(/旁路表/u);
      expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
      expect(rawDatabase.prepare("SELECT state FROM jobs WHERE id = ?")
        .get("job-atomic-cross-table")).toEqual({ state: "running" });
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM evidence").get())
        .toEqual({ count: 0 });
    } finally {
      rawDatabase.exec("DROP TRIGGER inject_evidence_during_commit");
      rawDatabase.close();
      store.close();
    }
  });

  it("rolls back terminal writes when an AFTER trigger changes the requested terminal state", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "terminal-rewrite" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-after-trigger-terminal",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-after-trigger-terminal", "2026-07-25T00:00:01.000Z");
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER rewrite_failed_terminal
      AFTER UPDATE OF state ON jobs
      WHEN NEW.state = 'failed'
      BEGIN
        UPDATE jobs
        SET state = 'cancelled', error_code = NULL, error_log_id = NULL
        WHERE id = NEW.id;
      END;
    `);
    try {
      expect(() => store.markJobFailed(
        "job-after-trigger-terminal",
        "2026-07-25T00:00:02.000Z",
        "GRAPH_SCAN_FAILED",
        "log-after-trigger-terminal",
      )).toThrow();
      expect(rawDatabase.prepare(`
        SELECT state, completed_at, error_code, error_log_id
        FROM jobs WHERE id = ?
      `).get("job-after-trigger-terminal")).toEqual({
        completed_at: null,
        error_code: null,
        error_log_id: null,
        state: "running",
      });
    } finally {
      rawDatabase.exec("DROP TRIGGER rewrite_failed_terminal");
      rawDatabase.close();
      store.close();
    }
  });

  it("rolls back terminal writes when an AFTER trigger injects an additional valid terminal Job", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "terminal-injection" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.createJob({
      baseGraphRevision: null,
      id: "job-terminal-injection-target",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-terminal-injection-target", "2026-07-25T00:00:01.000Z");
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER inject_terminal_job
      AFTER UPDATE OF state ON jobs
      WHEN NEW.state = 'failed'
      BEGIN
        INSERT INTO jobs(
          id, workspace_key, kind, state, requested_at, started_at, completed_at,
          base_graph_revision, result_graph_revision
        ) VALUES (
          'job-terminal-injected', NEW.workspace_key, 'initial-index', 'cancelled',
          NEW.requested_at, NEW.started_at, NEW.completed_at, NULL, NULL
        );
      END;
    `);
    try {
      expect(() => store.markJobFailed(
        "job-terminal-injection-target",
        "2026-07-25T00:00:02.000Z",
        "GRAPH_SCAN_FAILED",
        "log-terminal-injection",
      )).toThrow();
      expect(rawDatabase.prepare("SELECT id, state FROM jobs ORDER BY rowid").get()).toEqual({
        id: "job-terminal-injection-target",
        state: "running",
      });
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM jobs WHERE workspace_key = ?")
        .get(workspaceKey)).toEqual({ count: 1 });
    } finally {
      rawDatabase.exec("DROP TRIGGER inject_terminal_job");
      rawDatabase.close();
      store.close();
    }
  });

  it("rolls back interrupted-job recovery when a trigger restores workspace freshness to current", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "recovery-freshness-rewrite" });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-recovery-trigger-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-recovery-trigger-baseline", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-recovery-trigger-baseline",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: graph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-recovery-trigger-active",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-recovery-trigger-active", "2026-07-25T00:00:04.000Z");
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER rewrite_recovered_freshness
      AFTER UPDATE OF state ON jobs
      WHEN NEW.state = 'failed'
      BEGIN
        UPDATE workspace SET freshness = 'current' WHERE workspace_key = NEW.workspace_key;
      END;
    `);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow();
    const verificationDatabase = new RawSqlite(databasePath);
    try {
      expect(verificationDatabase.prepare("SELECT freshness FROM workspace WHERE workspace_key = ?")
        .get(workspaceKey)).toEqual({ freshness: "current" });
      expect(verificationDatabase.prepare("SELECT state FROM jobs WHERE id = ?")
        .get("job-recovery-trigger-active")).toEqual({ state: "running" });
    } finally {
      verificationDatabase.exec("DROP TRIGGER rewrite_recovered_freshness");
      verificationDatabase.close();
    }
  });

  it("rolls back interrupted-job recovery when a trigger writes another authority table", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ trigger: "recovery-cross-table-write" });
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.createJob({
      baseGraphRevision: null,
      id: "job-recovery-cross-table",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-recovery-cross-table", "2026-07-25T00:00:01.000Z");
    store.close();

    let rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TRIGGER inject_evidence_during_recovery
      AFTER UPDATE OF state ON jobs
      WHEN NEW.state = 'failed'
      BEGIN
        INSERT INTO meta(key, value)
        VALUES ('trigger-recovery-authority', NEW.workspace_key);
      END;
    `);
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/旁路表/u);

    rawDatabase = new RawSqlite(databasePath);
    try {
      expect(rawDatabase.prepare("SELECT state FROM jobs WHERE id = ?")
        .get("job-recovery-cross-table")).toEqual({ state: "running" });
      expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM evidence").get())
        .toEqual({ count: 0 });
      expect(rawDatabase.prepare("SELECT value FROM meta WHERE key = 'trigger-recovery-authority'")
        .get()).toBeUndefined();
    } finally {
      rawDatabase.exec("DROP TRIGGER inject_evidence_during_recovery");
      rawDatabase.close();
    }
  });

  it("repairs missing ownership even when the target patchDigest matches", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "9".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    try {
      createJob(store, {
        id: "job-replay-baseline",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning("job-replay-baseline", "2026-07-25T00:00:01.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: "job-replay-baseline",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      });
      const rawDatabase = new RawSqlite(databasePath);
      rawDatabase.prepare(`
        DELETE FROM facts_ownership
        WHERE workspace_key = ? AND fact_kind = 'node' AND fact_id = ?
      `).run(workspaceKey, graph.nodes[0]!.id);
      rawDatabase.close();

      createJob(store, {
        id: "job-replay-repair",
        kind: "rebuild",
        requestedAt: "2026-07-25T00:00:03.000Z",
      });
      store.markJobRunning("job-replay-repair", "2026-07-25T00:00:04.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:05.000Z",
        graph,
        jobId: "job-replay-repair",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:05.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      });

      expect(store.readBootstrapState().committed).toMatchObject({ graphRevision: 2 });
      expect(store.listOwnership()).toHaveLength(graph.nodes.length + graph.edges.length);
    } finally {
      store.close();
    }
  });

  it("rejects tampered committed read-set, patch digest, or hierarchy topology on restart", async () => {
    const corruptions = [
      "read-set",
      "read-set-manifest",
      "read-set-content",
      "read-set-base-revision",
      "read-set-bootstrap-generation",
      "read-set-status-epoch",
      "read-set-ignore-generation",
      "read-set-effective-rules",
      "patch-digest",
      "ownership",
      "unknown-ownership",
      "node-topology",
      "edge-topology",
    ] as const;
    for (const corruption of corruptions) {
      const databasePath = await createDatabasePath();
      const workspaceKey = sha256CanonicalJson({ corruption });
      const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
      const store = await openSqliteGraphStore({ databasePath, workspaceKey });
      createJob(store, {
        id: `job-evidence-${corruption}`,
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning(`job-evidence-${corruption}`, "2026-07-25T00:00:01.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph,
        jobId: `job-evidence-${corruption}`,
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: graph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 1,
          nodeCount: graph.nodes.length,
        },
      });
      store.close();

      const rawDatabase = new RawSqlite(databasePath);
      if (corruption === "read-set") {
        rawDatabase.prepare("UPDATE jobs SET read_set_json = ? WHERE id = ?")
          .run("{not-json", `job-evidence-${corruption}`);
      } else if (
        corruption === "read-set-manifest" ||
        corruption === "read-set-content" ||
        corruption === "read-set-base-revision" ||
        corruption === "read-set-bootstrap-generation" ||
        corruption === "read-set-status-epoch" ||
        corruption === "read-set-ignore-generation" ||
        corruption === "read-set-effective-rules"
      ) {
        const row = rawDatabase.prepare("SELECT read_set_json FROM jobs WHERE id = ?")
          .get(`job-evidence-${corruption}`) as { read_set_json: string };
        const readSet = JSON.parse(row.read_set_json) as {
          baseGraphRevision: number | null;
          bootstrapGeneration: number;
          effectiveIgnoreSnapshot: { effectiveRules: string[]; generation: number };
          manifest: Array<{ contentHash: string; path: string }>;
          statusEpoch: string;
        };
        if (corruption === "read-set-manifest") {
          readSet.manifest[0]!.path = "src/tampered.ts";
        } else if (corruption === "read-set-content") {
          readSet.manifest[0]!.contentHash = "0".repeat(64);
        } else if (corruption === "read-set-base-revision") {
          readSet.baseGraphRevision = 99;
        } else if (corruption === "read-set-bootstrap-generation") {
          readSet.bootstrapGeneration = 99;
        } else if (corruption === "read-set-status-epoch") {
          readSet.statusEpoch = "tampered-epoch";
        } else if (corruption === "read-set-ignore-generation") {
          readSet.effectiveIgnoreSnapshot.generation = 99;
        } else {
          readSet.effectiveIgnoreSnapshot.effectiveRules = ["/tampered/"];
        }
        rawDatabase.prepare("UPDATE jobs SET read_set_json = ? WHERE id = ?")
          .run(JSON.stringify(readSet), `job-evidence-${corruption}`);
      } else if (corruption === "patch-digest") {
        rawDatabase.prepare("UPDATE jobs SET patch_digest = ? WHERE id = ?")
          .run("0".repeat(64), `job-evidence-${corruption}`);
        rawDatabase.prepare("UPDATE workspace SET patch_digest = ? WHERE workspace_key = ?")
          .run("0".repeat(64), workspaceKey);
      } else if (corruption === "ownership") {
        rawDatabase.prepare(`
          DELETE FROM facts_ownership
          WHERE workspace_key = ? AND fact_kind = 'node' AND fact_id = ?
        `).run(workspaceKey, graph.nodes[0]!.id);
      } else if (corruption === "unknown-ownership") {
        rawDatabase.prepare(`
          INSERT INTO facts_ownership(workspace_key, owner_key, fact_kind, fact_id)
          VALUES (?, 'unknown-owner', 'node', ?)
        `).run(workspaceKey, graph.nodes[0]!.id);
      } else if (corruption === "node-topology") {
        rawDatabase.prepare(`
          UPDATE nodes SET relative_path = 'src/tampered.ts'
          WHERE workspace_key = ? AND kind = 'file'
        `).run(workspaceKey);
      } else {
        rawDatabase.prepare(`
          UPDATE edges SET qualifier = 'tampered'
          WHERE workspace_key = ?
        `).run(workspaceKey);
      }
      rawDatabase.close();

      await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow();
    }
  });

  it("rejects a succeeded logical base rewritten beyond its committed attempt base", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "logical-base-after-attempt" });
    const firstGraph = buildHierarchyGraph(workspaceKey, ["src/first.ts"]);
    const secondGraph = buildHierarchyGraph(workspaceKey, ["src/second.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-logical-base-first",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-logical-base-first", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph: firstGraph,
      jobId: "job-logical-base-first",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: firstGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: firstGraph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-logical-base-second",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-logical-base-second", "2026-07-25T00:00:04.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:05.000Z",
      graph: secondGraph,
      jobId: "job-logical-base-second",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: secondGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:05.000Z",
        indexedFileCount: 1,
        nodeCount: secondGraph.nodes.length,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      UPDATE jobs SET base_graph_revision = result_graph_revision WHERE id = ?
    `).run("job-logical-base-second");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow();
  });

  it("rejects a historical succeeded Job whose result revision disagrees with its attempt", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "historical-result-after-current" });
    const firstGraph = buildHierarchyGraph(workspaceKey, ["src/first.ts"]);
    const secondGraph = buildHierarchyGraph(workspaceKey, ["src/second.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-historical-result-first",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-historical-result-first", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph: firstGraph,
      jobId: "job-historical-result-first",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: firstGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: firstGraph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-historical-result-second",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-historical-result-second", "2026-07-25T00:00:04.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:05.000Z",
      graph: secondGraph,
      jobId: "job-historical-result-second",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: secondGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:05.000Z",
        indexedFileCount: 1,
        nodeCount: secondGraph.nodes.length,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      UPDATE jobs SET result_graph_revision = 2 WHERE id = ?
    `).run("job-historical-result-first");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow(
      /CAS read-set revision/u,
    );
  });

  it("rejects missing evidence on a modern historical revision-one success", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "modern-revision-one-evidence" });
    const firstGraph = buildHierarchyGraph(workspaceKey, ["src/first.ts"]);
    const secondGraph = buildHierarchyGraph(workspaceKey, ["src/second.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-modern-revision-one",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-modern-revision-one", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph: firstGraph,
      jobId: "job-modern-revision-one",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: firstGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: firstGraph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-modern-revision-two",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-modern-revision-two", "2026-07-25T00:00:04.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:05.000Z",
      graph: secondGraph,
      jobId: "job-modern-revision-two",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: secondGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:05.000Z",
        indexedFileCount: 1,
        nodeCount: secondGraph.nodes.length,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      UPDATE jobs SET read_set_json = NULL, patch_digest = NULL WHERE id = ?
    `).run("job-modern-revision-one");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow(
      /非 legacy succeeded/u,
    );
  });

  it("rejects a tampered patch digest on a superseded succeeded Job", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "historical-patch-digest" });
    const firstGraph = buildHierarchyGraph(workspaceKey, ["src/first.ts"]);
    const secondGraph = buildHierarchyGraph(workspaceKey, ["src/second.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-historical-digest-first",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-historical-digest-first", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph: firstGraph,
      jobId: "job-historical-digest-first",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: firstGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: firstGraph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-historical-digest-current",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-historical-digest-current", "2026-07-25T00:00:04.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:05.000Z",
      graph: secondGraph,
      jobId: "job-historical-digest-current",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: secondGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:05.000Z",
        indexedFileCount: 1,
        nodeCount: secondGraph.nodes.length,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare("UPDATE jobs SET patch_digest = ? WHERE id = ?")
      .run("0".repeat(64), "job-historical-digest-first");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow(
      /历史 succeeded Job.*digest|规范语义重新派生/u,
    );
  });

  it("rejects a revision-above-one succeeded Job whose commit evidence is missing", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "historical-evidence-less-revision" });
    const firstGraph = buildHierarchyGraph(workspaceKey, ["src/first.ts"]);
    const secondGraph = buildHierarchyGraph(workspaceKey, ["src/second.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-evidence-less-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-evidence-less-baseline", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph: firstGraph,
      jobId: "job-evidence-less-baseline",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: firstGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: firstGraph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-evidence-less-current",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-evidence-less-current", "2026-07-25T00:00:04.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:05.000Z",
      graph: secondGraph,
      jobId: "job-evidence-less-current",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: secondGraph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:05.000Z",
        indexedFileCount: 1,
        nodeCount: secondGraph.nodes.length,
      },
    });
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    /** rowid=0 将损坏的历史行放在现有提交之前，且不改变 latest succeeded 绑定。 */
    rawDatabase.prepare(`
      INSERT INTO jobs(
        rowid, id, workspace_key, kind, state, requested_at, started_at, completed_at,
        error_code, error_log_id, base_graph_revision, result_graph_revision,
        read_set_json, patch_digest
      ) VALUES (0, ?, ?, 'rebuild', 'succeeded', ?, ?, ?, NULL, NULL, 1, 2, NULL, NULL)
    `).run(
      "job-evidence-less-historical",
      workspaceKey,
      "2026-07-24T23:59:57.000Z",
      "2026-07-24T23:59:58.000Z",
      "2026-07-24T23:59:59.000Z",
    );
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow(
      /非 legacy succeeded/u,
    );
  });

  it("rejects an uncommitted rebuild whose logical base is after the current graph revision", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = sha256CanonicalJson({ corruption: "terminal-base-after-current" });
    const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    createJob(store, {
      id: "job-terminal-base-baseline",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-terminal-base-baseline", "2026-07-25T00:00:01.000Z");
    commitHierarchy(store, {
      completedAt: "2026-07-25T00:00:02.000Z",
      graph,
      jobId: "job-terminal-base-baseline",
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        indexedFileCount: 1,
        nodeCount: graph.nodes.length,
      },
    });
    createJob(store, {
      id: "job-terminal-base-failed",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:03.000Z",
    });
    store.markJobRunning("job-terminal-base-failed", "2026-07-25T00:00:04.000Z");
    store.markJobFailed(
      "job-terminal-base-failed",
      "2026-07-25T00:00:05.000Z",
      "GRAPH_SCAN_FAILED",
      "log-terminal-base-failed",
    );
    store.close();

    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.prepare(`
      UPDATE jobs SET base_graph_revision = 2, result_graph_revision = 2 WHERE id = ?
    `).run("job-terminal-base-failed");
    rawDatabase.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey })).rejects.toThrow();
  });

  it("keeps a second WAL reader on the old revision until the transaction commits", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "e".repeat(64);
    let observeTransaction = false;
    let observedDuringCommit: { nodeCount: number; revision: number } | undefined;
    let reader: RawSqliteDatabase | undefined;
    const store = await openSqliteGraphStore({
      databasePath,
      faultInjector: ({ stage }) => {
        if (observeTransaction && observedDuringCommit === undefined && stage === "node") {
          observedDuringCommit = {
            nodeCount: (reader!.prepare(
              "SELECT COUNT(*) AS count FROM nodes WHERE workspace_key = ?",
            ).get(workspaceKey) as { count: number }).count,
            revision: (reader!.prepare(
              "SELECT graph_revision AS revision FROM workspace WHERE workspace_key = ?",
            ).get(workspaceKey) as { revision: number }).revision,
          };
        }
      },
      workspaceKey,
    });
    try {
      const firstGraph = buildHierarchyGraph(workspaceKey, []);
      createJob(store, {
        id: "job-reader-first",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning("job-reader-first", "2026-07-25T00:00:01.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:02.000Z",
        graph: firstGraph,
        jobId: "job-reader-first",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: 0,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:02.000Z",
          indexedFileCount: 0,
          nodeCount: 1,
        },
      });
      reader = new RawSqlite(databasePath);
      reader.pragma("journal_mode = WAL");
      observeTransaction = true;

      const nextGraph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
      createJob(store, {
        id: "job-reader-next",
        kind: "rebuild",
        requestedAt: "2026-07-25T00:00:03.000Z",
      });
      store.markJobRunning("job-reader-next", "2026-07-25T00:00:04.000Z");
      commitHierarchy(store, {
        completedAt: "2026-07-25T00:00:05.000Z",
        graph: nextGraph,
        jobId: "job-reader-next",
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: nextGraph.edges.length,
          excludedPathCount: 0,
          generatedAt: "2026-07-25T00:00:05.000Z",
          indexedFileCount: 1,
          nodeCount: nextGraph.nodes.length,
        },
      });

      expect(observedDuringCommit).toEqual({ nodeCount: 1, revision: 1 });
      expect(reader.prepare(
        "SELECT graph_revision AS revision FROM workspace WHERE workspace_key = ?",
      ).get(workspaceKey)).toEqual({ revision: 2 });
      expect(reader.prepare(
        "SELECT COUNT(*) AS count FROM nodes WHERE workspace_key = ?",
      ).get(workspaceKey)).toEqual({ count: nextGraph.nodes.length });
    } finally {
      reader?.close();
      store.close();
    }
  });

  it("rejects an unknown higher schema and preserves the original database copy", async () => {
    const databasePath = await createDatabasePath();
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (4, '2026-07-25T00:00:00.000Z');
    `);
    expect(String(rawDatabase.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("delete");
    rawDatabase.close();

    await expect(openSqliteGraphStore({
      databasePath,
      workspaceKey: "f".repeat(64),
    })).rejects.toThrow(/Schema 版本未知/u);

    const entries = await readdir(path.dirname(databasePath));
    expect(entries.filter((entry) => /^graph\.sqlite\.failed-existing-\d+-\d+\.bak$/u.test(entry)))
      .toHaveLength(1);
    const preservedDatabase = new RawSqlite(databasePath);
    try {
      expect(String(preservedDatabase.pragma("journal_mode", { simple: true })).toLowerCase())
        .toBe("delete");
      expect(preservedDatabase.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get()).toEqual({ version: 4 });
    } finally {
      preservedDatabase.close();
    }
  });

  it("preserves WAL sidecars and bounds accumulated failure backups", async () => {
    const databasePath = await createDatabasePath();
    await Promise.all([1, 2, 3, 4].map((timestamp) =>
      writeFile(`${databasePath}.failed-existing-${timestamp}.bak`, "legacy", "utf8")));
    const rawDatabase = new RawSqlite(databasePath);
    rawDatabase.pragma("journal_mode = WAL");
    rawDatabase.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (4, '2026-07-25T00:00:00.000Z');
    `);
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(Promise.resolve().then(() => openSqliteGraphStore({
          databasePath,
          workspaceKey: "9".repeat(64),
        }))).rejects.toThrow(/Schema 版本未知/u);
      }
      const entries = await readdir(path.dirname(databasePath));
      expect(entries.some((entry) => /^graph\.sqlite\.failed-existing-\d+-\d+\.bak-wal$/u.test(entry)))
        .toBe(true);
      expect(entries.filter((entry) =>
        /^graph\.sqlite\.failed-(?:existing|new)-\d+(?:-\d+)?\.bak$/u.test(entry)))
        .toHaveLength(3);
      expect(entries.filter((entry) => /^graph\.sqlite\.failed-existing-[1-4]\.bak$/u.test(entry)))
        .toHaveLength(0);
    } finally {
      rawDatabase.close();
    }
  });

  it("restores the last terminal Job by insertion order when timestamps collide", async () => {
    const store = await openSqliteGraphStore({
      databasePath: await createDatabasePath(),
      workspaceKey: "b".repeat(64),
    });
    const requestedAt = "2026-07-25T00:00:00.000Z";
    try {
      createJob(store, { id: "z-old", kind: "initial-index", requestedAt });
      store.markJobRunning("z-old", "2026-07-25T00:00:01.000Z");
      store.markJobFailed(
        "z-old",
        "2026-07-25T00:00:02.000Z",
        "GRAPH_SCAN_FAILED",
        "log-old",
      );
      createJob(store, { id: "a-new", kind: "initial-index", requestedAt });
      store.markJobRunning("a-new", "2026-07-25T00:00:01.000Z");
      store.markJobFailed(
        "a-new",
        "2026-07-25T00:00:02.000Z",
        "GRAPH_SCAN_FAILED",
        "log-new",
      );

      expect(store.readBootstrapState().lastJob).toMatchObject({ id: "a-new" });
    } finally {
      store.close();
    }
  });

  it("rethrows SQLITE_BUSY after the bounded timeout under a competing writer", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({
      databasePath,
      workspaceKey: "a".repeat(64),
    });
    const competingWriter = new RawSqlite(databasePath);
    competingWriter.pragma("journal_mode = WAL");
    competingWriter.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = Date.now();
      let busyError: unknown;
      try {
        createJob(store, {
          id: "job-busy",
          kind: "initial-index",
          requestedAt: "2026-07-25T00:00:00.000Z",
        });
      } catch (error) {
        busyError = error;
      }
      const elapsedMs = Date.now() - startedAt;
      expect(busyError).toMatchObject({ code: "SQLITE_BUSY" });
      expect(elapsedMs).toBeGreaterThanOrEqual(SQLITE_BUSY_TIMEOUT_MS - 500);
      /** SQLite 的 5 秒原生超时保持不变，仅容纳高并发 Windows 调度后的观测延迟。 */
      expect(elapsedMs).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS + 6_000);
      expect(store.readBootstrapState()).toEqual({
        committed: null,
        completeness: "empty",
        freshness: null,
        lastJob: null,
      });
    } finally {
      competingWriter.exec("ROLLBACK");
      competingWriter.close();
      store.close();
    }
  }, 15_000);
});
