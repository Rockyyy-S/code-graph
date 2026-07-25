import type Database from "better-sqlite3";

/** Story 1.4 唯一支持的持久化 Schema 版本。 */
export const BOOTSTRAP_SCHEMA_VERSION = 1;

/** migration v1 允许创建的精确用户表集合。 */
export const BOOTSTRAP_TABLE_NAMES = Object.freeze([
  "edges",
  "evidence",
  "facts_ownership",
  "jobs",
  "meta",
  "nodes",
  "schema_migrations",
  "workspace",
] as const);

/**
 * 在同步事务中应用幂等 migration v1，并拒绝未知更高版本或额外表。
 *
 * 所有 SQL 均封装在 SQLite 适配器内，调用方不能传入表名或语句。
 */
export function applyBootstrapMigration(database: Database.Database): void {
  const hasMigrationTable = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() !== undefined;
  if (hasMigrationTable) {
    const row = database.prepare(`
      SELECT MAX(version) AS version
      FROM schema_migrations
    `).get() as { version: number | null };
    if (row.version !== BOOTSTRAP_SCHEMA_VERSION) {
      throw new Error("SQLite Schema 版本未知或未完整迁移。");
    }
    assertExactTableSet(database);
    return;
  }

  database.transaction(() => {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE workspace (
        workspace_key TEXT PRIMARY KEY,
        committed_at TEXT,
        indexed_file_count INTEGER,
        node_count INTEGER,
        edge_count INTEGER,
        excluded_path_count INTEGER,
        builtin_rules_version TEXT
      );

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('workspace', 'directory', 'file')),
        relative_path TEXT NOT NULL,
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        UNIQUE (workspace_key, kind, relative_path)
      );

      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        from_id TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK (relation_type = 'contains'),
        to_id TEXT NOT NULL,
        qualifier TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE,
        UNIQUE (from_id, relation_type, to_id)
      );

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE
      );

      CREATE TABLE facts_ownership (
        fact_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        PRIMARY KEY (fact_id, owner_key)
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('initial-index', 'rebuild')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error_code TEXT,
        error_log_id TEXT,
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE
      );
    `);
    database.prepare(`
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (?, ?)
    `).run(BOOTSTRAP_SCHEMA_VERSION, new Date().toISOString());
  })();
  assertExactTableSet(database);
}

/** 通过 sqlite_master 锁定当前切片精确八表，拒绝未来表被提前创建。 */
function assertExactTableSet(database: Database.Database): void {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[];
  const actual = rows.map((row) => row.name);
  if (JSON.stringify(actual) !== JSON.stringify(BOOTSTRAP_TABLE_NAMES)) {
    throw new Error("SQLite 用户表集合不符合 Story 1.4 migration v1 合同。");
  }
}
