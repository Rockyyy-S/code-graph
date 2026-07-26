import type Database from "better-sqlite3";
import { isSupportedSourceFile } from "@codegraph/application";
import {
  buildGraphEdgeId,
  buildGraphEntityId,
  normalizeRelativeGraphPath,
} from "@codegraph/domain";
import {
  applyBootstrapMigration,
  BOOTSTRAP_SCHEMA_VERSION,
  BOOTSTRAP_TABLE_NAMES,
} from "./001-bootstrap.js";

/** Story 1.19 确定性提交 Schema 版本。 */
export const DETERMINISTIC_COMMIT_SCHEMA_VERSION = 2;

/** v2 保持 Story 1.4 的精确八表，只演进现有职责。 */
export const DETERMINISTIC_COMMIT_TABLE_NAMES = BOOTSTRAP_TABLE_NAMES;

/** 在持久 PRAGMA 前只读拒绝未知未来版本、未知表或不完整迁移。 */
export function assertDeterministicSchemaSupported(database: Database.Database): void {
  const tables = readUserTableNames(database);
  if (!tables.includes("schema_migrations")) {
    if (tables.length > 0) {
      throw new Error("SQLite Schema 缺少受支持的 migration 元数据。");
    }
    return;
  }
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  if (
    row.version !== BOOTSTRAP_SCHEMA_VERSION &&
    row.version !== DETERMINISTIC_COMMIT_SCHEMA_VERSION
  ) {
    throw new Error("SQLite Schema 版本未知或未完整迁移。");
  }
  assertExactTableSet(tables);
}

/**
 * 在同步事务中把 v1 演进为 v2，保留既有图谱并初始化 revision/ownership。
 *
 * 旧提交缺少可证明 read-set，因此 migration 只标记 stale，不伪造任何 digest。
 */
export function applyDeterministicCommitMigration(database: Database.Database): void {
  assertDeterministicSchemaSupported(database);
  if (!readUserTableNames(database).includes("schema_migrations")) {
    applyBootstrapMigration(database);
  }
  database.transaction(() => {
    /** IMMEDIATE 锁内重验版本与完整性，禁止外部连接在预检和迁移之间插入损坏行。 */
    assertDeterministicSchemaSupported(database);
    const current = database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    assertNoForeignKeyViolation(database);
    assertNoInvalidOwnership(database, current.version);
    if (current.version === DETERMINISTIC_COMMIT_SCHEMA_VERSION) {
      return;
    }
    if (current.version !== BOOTSTRAP_SCHEMA_VERSION) {
      throw new Error("SQLite Schema 版本未知或未完整迁移。");
    }
    /** 迁移前计数必须与后续 DDL/复制共享同一 SQLite 事务快照。 */
    const legacyJobCount = (database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
      count: number;
    }).count;
    database.exec(`
      ALTER TABLE workspace ADD COLUMN graph_revision INTEGER;
      ALTER TABLE workspace ADD COLUMN freshness TEXT;
      ALTER TABLE workspace ADD COLUMN completeness TEXT;
      ALTER TABLE workspace ADD COLUMN manifest_digest TEXT;
      ALTER TABLE workspace ADD COLUMN input_digest TEXT;
      ALTER TABLE workspace ADD COLUMN config_digest TEXT;
      ALTER TABLE workspace ADD COLUMN effective_ignore_digest TEXT;
      ALTER TABLE workspace ADD COLUMN patch_digest TEXT;

      UPDATE workspace
      SET graph_revision = CASE WHEN committed_at IS NULL THEN NULL ELSE 1 END,
          freshness = CASE WHEN committed_at IS NULL THEN NULL ELSE 'stale' END,
          completeness = CASE
            WHEN committed_at IS NULL THEN 'empty'
            WHEN indexed_file_count = 0 THEN 'empty'
            ELSE 'complete'
          END;

      ALTER TABLE facts_ownership RENAME TO facts_ownership_v1;
      CREATE TABLE facts_ownership (
        fact_kind TEXT NOT NULL CHECK (fact_kind IN ('edge', 'node')),
        fact_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        PRIMARY KEY (fact_kind, fact_id, owner_key)
      );

      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      SELECT 'node', old.fact_id, old.owner_key, old.workspace_key
      FROM facts_ownership_v1 AS old
      WHERE EXISTS (
        SELECT 1 FROM nodes
        WHERE id = old.fact_id AND workspace_key = old.workspace_key
      );
      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      SELECT 'edge', old.fact_id, old.owner_key, old.workspace_key
      FROM facts_ownership_v1 AS old
      WHERE EXISTS (
        SELECT 1 FROM edges
        WHERE id = old.fact_id AND workspace_key = old.workspace_key
      );

      INSERT OR IGNORE INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      SELECT 'node', node.id, 'hierarchy:' || root.id, node.workspace_key
      FROM nodes AS node
      JOIN nodes AS root
        ON root.workspace_key = node.workspace_key AND root.kind = 'workspace';
      INSERT OR IGNORE INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      SELECT 'edge', edge.id, 'hierarchy:' || root.id, edge.workspace_key
      FROM edges AS edge
      JOIN nodes AS root
        ON root.workspace_key = edge.workspace_key AND root.kind = 'workspace';
      DROP TABLE facts_ownership_v1;

      ALTER TABLE jobs RENAME TO jobs_v1;
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('initial-index', 'rebuild')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'partial', 'cancelled')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error_code TEXT,
        error_log_id TEXT,
        base_graph_revision INTEGER,
        result_graph_revision INTEGER,
        read_set_json TEXT,
        patch_digest TEXT,
        legacy_schema_version INTEGER DEFAULT NULL
          CHECK (legacy_schema_version IS NULL OR legacy_schema_version = 1),
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE
      );
      INSERT INTO jobs(
        id, workspace_key, kind, state, requested_at, started_at, completed_at,
        error_code, error_log_id, base_graph_revision, result_graph_revision, read_set_json,
        patch_digest, legacy_schema_version
      )
      SELECT
        old.id, old.workspace_key, old.kind, old.state, old.requested_at, old.started_at,
        old.completed_at, old.error_code, old.error_log_id,
        CASE
          WHEN old.kind = 'initial-index' THEN NULL
          WHEN workspace.graph_revision IS NULL THEN NULL
          ELSE workspace.graph_revision
        END,
        CASE
          WHEN old.state IN ('queued', 'running') THEN NULL
          WHEN old.state = 'succeeded' THEN workspace.graph_revision
          WHEN old.kind = 'initial-index' THEN NULL
          ELSE workspace.graph_revision
        END,
        NULL,
        NULL,
        1
      FROM jobs_v1 AS old
      JOIN workspace ON workspace.workspace_key = old.workspace_key
      ORDER BY old.rowid;
      DROP TABLE jobs_v1;

      INSERT INTO schema_migrations(version, applied_at)
      VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    /** JOIN 只是读取父 workspace，任何行数差异都表示旧 Job 被静默丢弃。 */
    const migratedJobCount = (database.prepare("SELECT COUNT(*) AS count FROM jobs").get() as {
      count: number;
    }).count;
    if (migratedJobCount !== legacyJobCount) {
      throw new Error("v1 Job migration 行数不一致，拒绝提交迁移。");
    }
  }).immediate();
  assertDeterministicSchemaSupported(database);
}

/** 只读取首个外键违规，避免损坏规模控制打开路径的内存占用。 */
function assertNoForeignKeyViolation(database: Database.Database): void {
  const violation = database.prepare("PRAGMA foreign_key_check").get();
  if (violation !== undefined) {
    throw new Error("SQLite 数据库包含外键完整性违规，拒绝继续打开。");
  }
}

/** 校验所有含 facts 的 workspace 恰有一个 hierarchy root。 */
function assertExactlyOneHierarchyRoot(database: Database.Database): void {
  const invalidRoot = database.prepare(`
    SELECT 1 AS found
    FROM workspace AS candidate
    WHERE (
      EXISTS (SELECT 1 FROM nodes WHERE workspace_key = candidate.workspace_key) OR
      EXISTS (SELECT 1 FROM edges WHERE workspace_key = candidate.workspace_key)
    ) AND (
      SELECT COUNT(*) FROM nodes
      WHERE workspace_key = candidate.workspace_key AND kind = 'workspace'
    ) <> 1
    LIMIT 1
  `).get();
  if (invalidRoot !== undefined) {
    throw new Error("SQLite workspace 的 hierarchy facts 缺少唯一 root 节点。");
  }
}

/** 校验 contains edge 与两端 node 位于同一 workspace。 */
function assertEdgeEndpointsShareWorkspace(database: Database.Database): void {
  const invalidEdge = database.prepare(`
    SELECT 1 AS found
    FROM edges AS edge
    WHERE NOT EXISTS (
      SELECT 1 FROM nodes AS source
      WHERE source.id = edge.from_id AND source.workspace_key = edge.workspace_key
    ) OR NOT EXISTS (
      SELECT 1 FROM nodes AS target
      WHERE target.id = edge.to_id AND target.workspace_key = edge.workspace_key
    )
    LIMIT 1
  `).get();
  if (invalidEdge !== undefined) {
    throw new Error("SQLite edge 与端点 node 的 workspace 归属不一致。");
  }
}

/** 逐行重算 node/edge 身份，避免损坏规模转化为无界 JS 内存占用。 */
function assertCanonicalHierarchyIdentity(database: Database.Database): void {
  const nodes = database.prepare(`
    SELECT id, workspace_key, kind, relative_path FROM nodes
  `).iterate() as Iterable<{
    id: string;
    kind: "directory" | "file" | "workspace";
    relative_path: string;
    workspace_key: string;
  }>;
  try {
    for (const node of nodes) {
      if (
        (node.kind !== "directory" && node.kind !== "file" && node.kind !== "workspace") ||
        normalizeRelativeGraphPath(node.relative_path) !== node.relative_path ||
        (node.kind === "file" && !isSupportedSourceFile(node.relative_path)) ||
        node.id !== buildGraphEntityId(node.workspace_key, node.kind, node.relative_path)
      ) {
        throw new Error("invalid node identity");
      }
    }
    const edges = database.prepare(`
      SELECT id, workspace_key, from_id, relation_type, to_id, qualifier FROM edges
    `).iterate() as Iterable<{
      from_id: string;
      id: string;
      qualifier: string;
      relation_type: "contains";
      to_id: string;
      workspace_key: string;
    }>;
    for (const edge of edges) {
      if (edge.relation_type !== "contains") {
        throw new Error("invalid edge relation");
      }
      const expectedId = buildGraphEdgeId(
        edge.workspace_key,
        edge.from_id,
        edge.relation_type,
        edge.to_id,
        edge.qualifier,
      );
      if (edge.id !== expectedId) {
        throw new Error("invalid edge identity");
      }
    }
  } catch {
    throw new Error("SQLite hierarchy 包含非规范 node 或 edge 身份。");
  }
}

/** 校验每个 workspace 的 contains 关系构成从唯一 root 出发的规范路径树。 */
function assertCanonicalHierarchyTree(database: Database.Database): void {
  const duplicatePath = database.prepare(`
    SELECT 1 AS found
    FROM nodes
    GROUP BY workspace_key, relative_path
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  const emptyDirectory = database.prepare(`
    SELECT 1 AS found
    FROM nodes AS node
    WHERE node.kind = 'directory' AND NOT EXISTS (
      SELECT 1 FROM edges AS outgoing
      WHERE outgoing.workspace_key = node.workspace_key AND outgoing.from_id = node.id
    )
    LIMIT 1
  `).get();
  const invalidParent = database.prepare(`
    WITH incoming(workspace_key, node_id, edge_count) AS (
      SELECT workspace_key, to_id, COUNT(*)
      FROM edges
      GROUP BY workspace_key, to_id
    )
    SELECT 1 AS found
    FROM nodes AS node
    LEFT JOIN incoming
      ON incoming.workspace_key = node.workspace_key AND incoming.node_id = node.id
    WHERE (node.kind = 'workspace' AND COALESCE(incoming.edge_count, 0) <> 0)
      OR (node.kind <> 'workspace' AND COALESCE(incoming.edge_count, 0) <> 1)
    LIMIT 1
  `).get();
  const invalidEdgeShape = database.prepare(`
    SELECT 1 AS found
    FROM edges AS edge
    JOIN nodes AS source
      ON source.id = edge.from_id AND source.workspace_key = edge.workspace_key
    JOIN nodes AS target
      ON target.id = edge.to_id AND target.workspace_key = edge.workspace_key
    WHERE edge.qualifier <> '' OR
      source.kind = 'file' OR
      target.kind = 'workspace' OR
      (source.kind = 'workspace' AND instr(target.relative_path, '/') <> 0) OR
      (source.kind = 'directory' AND (
        substr(target.relative_path, 1, length(source.relative_path) + 1) <>
          source.relative_path || '/' OR
        instr(substr(target.relative_path, length(source.relative_path) + 2), '/') <> 0
      ))
    LIMIT 1
  `).get();
  const unreachableNode = database.prepare(`
    WITH RECURSIVE reachable(workspace_key, node_id) AS (
      SELECT workspace_key, id FROM nodes WHERE kind = 'workspace'
      UNION
      SELECT edge.workspace_key, edge.to_id
      FROM reachable
      JOIN edges AS edge
        ON edge.workspace_key = reachable.workspace_key AND edge.from_id = reachable.node_id
    )
    SELECT 1 AS found
    FROM nodes AS node
    WHERE NOT EXISTS (
      SELECT 1 FROM reachable
      WHERE reachable.workspace_key = node.workspace_key AND reachable.node_id = node.id
    )
    LIMIT 1
  `).get();
  if (
    duplicatePath !== undefined ||
    emptyDirectory !== undefined ||
    invalidParent !== undefined ||
    invalidEdgeShape !== undefined ||
    unreachableNode !== undefined
  ) {
    throw new Error("SQLite hierarchy 未形成从唯一 workspace root 出发的规范路径树。");
  }
}

/** 校验 SQLite 无法表达的全局 hierarchy、ownership 与多态 fact 不变量。 */
function assertNoInvalidOwnership(database: Database.Database, schemaVersion: number): void {
  assertExactlyOneHierarchyRoot(database);
  assertEdgeEndpointsShareWorkspace(database);
  const invalid = schemaVersion === BOOTSTRAP_SCHEMA_VERSION
    ? database.prepare(`
      SELECT 1 AS found
      FROM facts_ownership AS ownership
      WHERE (
        (SELECT COUNT(*) FROM nodes
         WHERE id = ownership.fact_id AND workspace_key = ownership.workspace_key) +
        (SELECT COUNT(*) FROM edges
         WHERE id = ownership.fact_id AND workspace_key = ownership.workspace_key)
      ) <> 1 OR ownership.owner_key <> 'hierarchy:' || (
        SELECT root.id FROM nodes AS root
        WHERE root.workspace_key = ownership.workspace_key AND root.kind = 'workspace'
      )
      LIMIT 1
    `).get()
    : database.prepare(`
      SELECT 1 AS found
      FROM facts_ownership AS ownership
      WHERE ownership.fact_kind NOT IN ('edge', 'node')
        OR (ownership.fact_kind = 'node' AND NOT EXISTS (
        SELECT 1 FROM nodes
        WHERE id = ownership.fact_id AND workspace_key = ownership.workspace_key
      )) OR (ownership.fact_kind = 'edge' AND NOT EXISTS (
        SELECT 1 FROM edges
        WHERE id = ownership.fact_id AND workspace_key = ownership.workspace_key
      ))
      LIMIT 1
    `).get();
  if (invalid !== undefined) {
    throw new Error("SQLite facts_ownership 包含无效或歧义的 fact 引用。");
  }
  assertCanonicalHierarchyIdentity(database);
  assertCanonicalHierarchyTree(database);
  if (schemaVersion === DETERMINISTIC_COMMIT_SCHEMA_VERSION) {
    assertCanonicalV2Ownership(database);
  }
}

/** v2 每个 fact 必须且只能由本 workspace 唯一 hierarchy root 持有。 */
function assertCanonicalV2Ownership(database: Database.Database): void {
  const invalidOwner = database.prepare(`
    SELECT 1 AS found
    FROM facts_ownership AS ownership
    JOIN nodes AS root
      ON root.workspace_key = ownership.workspace_key AND root.kind = 'workspace'
    WHERE ownership.owner_key <> 'hierarchy:' || root.id
    LIMIT 1
  `).get();
  const invalidFactOwnership = database.prepare(`
    SELECT 1 AS found
    FROM (
      SELECT 'node' AS fact_kind, id AS fact_id, workspace_key FROM nodes
      UNION ALL
      SELECT 'edge' AS fact_kind, id AS fact_id, workspace_key FROM edges
    ) AS fact
    WHERE (
      SELECT COUNT(*) FROM facts_ownership AS ownership
      WHERE ownership.fact_kind = fact.fact_kind
        AND ownership.fact_id = fact.fact_id
        AND ownership.workspace_key = fact.workspace_key
    ) <> 1
    LIMIT 1
  `).get();
  if (invalidOwner !== undefined || invalidFactOwnership !== undefined) {
    throw new Error("SQLite facts_ownership 未唯一绑定 workspace hierarchy root。");
  }
}

/** 锁定八表集合，禁止本 Story 提前创建 Findings、impact 或发布表。 */
function assertExactTableSet(actual: readonly string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(DETERMINISTIC_COMMIT_TABLE_NAMES)) {
    throw new Error("SQLite 用户表集合不符合 Story 1.19 migration v2 合同。");
  }
}

/** 只读返回排序后的用户表名。 */
function readUserTableNames(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[]).map((row) => row.name);
}
