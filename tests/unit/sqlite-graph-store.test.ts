import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHierarchyGraph } from "../../packages/application/src/index.js";
import {
  SQLITE_BUSY_TIMEOUT_MS,
  openSqliteGraphStore,
} from "../../packages/adapters/store-sqlite/src/index.js";

const roots: string[] = [];
const requireFromStorePackage = createRequire(
  path.resolve("packages/adapters/store-sqlite/package.json"),
);

/** 测试构造未知 schema 与真实写锁所需的最小原生 SQLite 连接。 */
interface RawSqliteDatabase {
  close: () => void;
  exec: (source: string) => RawSqliteDatabase;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  prepare: (source: string) => { get: () => unknown };
}

/** 从 store-sqlite 自身依赖边界解析的原生 SQLite 构造器。 */
interface RawSqliteConstructor {
  new (databasePath: string): RawSqliteDatabase;
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

describe("sqlite graph store", () => {
  it("creates exactly the bootstrap tables and verifies required pragmas", async () => {
    const store = openSqliteGraphStore({
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
    let store = openSqliteGraphStore({ databasePath, workspaceKey });
    store.createJob({ id: "job-empty", kind: "initial-index", requestedAt: "2026-07-25T00:00:00.000Z" });
    store.markJobRunning("job-empty", "2026-07-25T00:00:01.000Z");
    store.commitHierarchy({
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

    store = openSqliteGraphStore({ databasePath, workspaceKey });
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

  it("rolls back all hierarchy rows when a synchronous write fails", async () => {
    const workspaceKey = "e".repeat(64);
    const store = openSqliteGraphStore({
      databasePath: await createDatabasePath(),
      faultInjector: ({ entityIndex, stage }) => {
        if (stage === "node" && entityIndex === 1) {
          throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
        }
      },
      workspaceKey,
    });
    try {
      store.createJob({ id: "job-fail", kind: "initial-index", requestedAt: "2026-07-25T00:00:00.000Z" });
      store.markJobRunning("job-fail", "2026-07-25T00:00:01.000Z");
      expect(() => store.commitHierarchy({
        completedAt: "2026-07-25T00:00:02.000Z",
        graph: buildHierarchyGraph(workspaceKey, ["src/index.ts"]),
        jobId: "job-fail",
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
      expect(store.readBootstrapState().committed).toBeNull();
    } finally {
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
      VALUES (2, '2026-07-25T00:00:00.000Z');
    `);
    expect(String(rawDatabase.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("delete");
    rawDatabase.close();

    expect(() => openSqliteGraphStore({
      databasePath,
      workspaceKey: "f".repeat(64),
    })).toThrow(/Schema 版本未知/u);

    const entries = await readdir(path.dirname(databasePath));
    expect(entries.filter((entry) => /^graph\.sqlite\.failed-existing-\d+\.bak$/u.test(entry)))
      .toHaveLength(1);
    const preservedDatabase = new RawSqlite(databasePath);
    try {
      expect(String(preservedDatabase.pragma("journal_mode", { simple: true })).toLowerCase())
        .toBe("delete");
      expect(preservedDatabase.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get()).toEqual({ version: 2 });
    } finally {
      preservedDatabase.close();
    }
  });

  it("restores the last terminal Job by insertion order when timestamps collide", async () => {
    const store = openSqliteGraphStore({
      databasePath: await createDatabasePath(),
      workspaceKey: "b".repeat(64),
    });
    const requestedAt = "2026-07-25T00:00:00.000Z";
    try {
      store.createJob({ id: "z-old", kind: "initial-index", requestedAt });
      store.markJobRunning("z-old", "2026-07-25T00:00:01.000Z");
      store.markJobFailed(
        "z-old",
        "2026-07-25T00:00:02.000Z",
        "GRAPH_SCAN_FAILED",
        "log-old",
      );
      store.createJob({ id: "a-new", kind: "initial-index", requestedAt });
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
    const store = openSqliteGraphStore({
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
        store.createJob({
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
      expect(elapsedMs).toBeLessThan(SQLITE_BUSY_TIMEOUT_MS + 3_000);
      expect(store.readBootstrapState()).toEqual({ committed: null, lastJob: null });
    } finally {
      competingWriter.exec("ROLLBACK");
      competingWriter.close();
      store.close();
    }
  }, 10_000);
});
