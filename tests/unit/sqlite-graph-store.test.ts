import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHierarchyGraph } from "../../packages/application/src/index.js";
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SqliteGraphStore,
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
  prepare: (source: string) => {
    get: (...parameters: unknown[]) => unknown;
    run: (...parameters: unknown[]) => unknown;
  };
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
    store.createJob({
      id: "job-corrupt-summary",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-corrupt-summary", "2026-07-25T00:00:01.000Z");
    store.commitHierarchy({
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
    store.createJob({
      id: "job-committed",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-committed", "2026-07-25T00:00:01.000Z");
    store.commitHierarchy({
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
    store.createJob({
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
    store.createJob({
      id: "job-earlier-same-time",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-earlier-same-time", "2026-07-25T00:00:01.000Z");
    store.commitHierarchy({
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
    store.createJob({
      id: "job-current-same-time",
      kind: "rebuild",
      requestedAt: "2026-07-25T00:00:02.000Z",
    });
    store.markJobRunning("job-current-same-time", "2026-07-25T00:00:02.000Z");
    store.commitHierarchy({
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
    store.createJob({
      id: "job-legacy-committed",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("job-legacy-committed", "2026-07-25T00:00:01.000Z");
    store.commitHierarchy({
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

  it("rejects an ambiguous pre-binding database with colliding succeeded timestamps", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "9".repeat(64);
    const graph = buildHierarchyGraph(workspaceKey, []);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    for (const [id, kind] of [
      ["job-legacy-first", "initial-index"],
      ["job-legacy-second", "rebuild"],
    ] as const) {
      store.createJob({
        id,
        kind,
        requestedAt: "2026-07-25T00:00:00.000Z",
      });
      store.markJobRunning(id, "2026-07-25T00:00:01.000Z");
      store.commitHierarchy({
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

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/无法唯一恢复/u);
  });

  it("reconciles interrupted running Jobs on the next startup", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "5".repeat(64);
    let store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.createJob({
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

  it("rejects recovery when a database trigger ignores the interrupted Job update", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "a".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.createJob({
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
    store.createJob({
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
    store.createJob({
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
    store.createJob({
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
    store.createJob({
      id: "",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
    });
    store.markJobRunning("", "2026-07-25T00:00:01.000Z");
    store.markJobFailed(
      "",
      "2026-07-25T00:00:02.000Z",
      "GRAPH_SCAN_FAILED",
      "log-empty-id",
    );
    store.close();

    await expect(openSqliteGraphStore({ databasePath, workspaceKey }))
      .rejects.toThrow(/terminal Job 合同不完整/u);
  });

  it("rejects an unknown error code in any persisted terminal Job", async () => {
    const databasePath = await createDatabasePath();
    const workspaceKey = "1".repeat(64);
    const store = await openSqliteGraphStore({ databasePath, workspaceKey });
    store.createJob({
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
    store.createJob({
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

  it("rolls back all hierarchy rows when a synchronous write fails", async () => {
    const workspaceKey = "e".repeat(64);
    const store = await openSqliteGraphStore({
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
      ).get()).toEqual({ version: 2 });
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
      VALUES (2, '2026-07-25T00:00:00.000Z');
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
