import type Database from "better-sqlite3";
import { isSupportedSourceFile } from "@codegraph/application";
import {
  buildGraphEdgeId,
  buildGraphEntityId,
  buildModuleEvidenceId,
  buildNpmPackagePurl,
  buildUnresolvedNpmPackagePurl,
  decodeModuleExportName,
  isCanonicalUtcTimestamp,
  normalizeNodeBuiltinId,
  normalizeRelativeGraphPath,
} from "@codegraph/domain";
import { BOOTSTRAP_SCHEMA_VERSION, BOOTSTRAP_TABLE_NAMES } from "./001-bootstrap.js";
import {
  applyDeterministicCommitMigration,
  DETERMINISTIC_COMMIT_SCHEMA_VERSION,
} from "./002-deterministic-commit.js";

/** Story 1.5 模块依赖持久化 Schema 版本。 */
export const MODULE_DEPENDENCY_SCHEMA_VERSION = 3;

/** v3 继续保持精确八表，只演进既有图谱事实职责。 */
export const MODULE_DEPENDENCY_TABLE_NAMES = BOOTSTRAP_TABLE_NAMES;

/** 顶层只读 preflight 接受 absent/v1/v2/v3，并拒绝未来版本或未知表。 */
export function assertModuleDependencySchemaSupported(database: Database.Database): void {
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
    row.version !== DETERMINISTIC_COMMIT_SCHEMA_VERSION &&
    row.version !== MODULE_DEPENDENCY_SCHEMA_VERSION
  ) {
    throw new Error("SQLite Schema 版本未知或未完整迁移。");
  }
  assertExactTableSet(tables);
}

/**
 * 依次补齐 v1/v2，并通过单事务表重建演进 node/edge/evidence/ownership。
 */
export function applyModuleDependencyMigration(database: Database.Database): void {
  assertModuleDependencySchemaSupported(database);
  database.transaction(() => {
    /** 取得同一 IMMEDIATE 写锁后再路由 absent/v1/v2/v3，禁止锁前陈旧版本决定旧 migrator。 */
    assertModuleDependencySchemaSupported(database);
    let version = readSchemaVersion(database);
    if (version === null || version === BOOTSTRAP_SCHEMA_VERSION) {
      applyDeterministicCommitMigration(database);
      version = readSchemaVersion(database);
    }
    if (version === MODULE_DEPENDENCY_SCHEMA_VERSION) {
      ensureEvidenceSupportIndex(database);
      assertModuleDependencySchemaIntegrity(database);
      return;
    }
    if (version !== DETERMINISTIC_COMMIT_SCHEMA_VERSION) {
      throw new Error("SQLite Schema 版本未知或未完整迁移。");
    }
    /** v2 事实必须在同一 IMMEDIATE 锁内通过旧合同校验后才允许重建表。 */
    assertNoForeignKeyViolation(database);
    assertLegacyV2Ownership(database);
    assertHierarchyTopology(database);
    const counts = readMigrationCounts(database);
    if (counts.evidenceCount !== 0) {
      throw new Error("v2 evidence 缺少模块关系结构化合同，拒绝静默迁移非空旧数据。");
    }
    assertNoForeignKeyViolation(database);
    database.exec(`
      ALTER TABLE facts_ownership RENAME TO facts_ownership_v2;
      ALTER TABLE evidence RENAME TO evidence_v2;
      ALTER TABLE edges RENAME TO edges_v2;
      ALTER TABLE nodes RENAME TO nodes_v2;

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'workspace', 'directory', 'file', 'external-package', 'node-builtin'
        )),
        relative_path TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        CHECK (
          (kind IN ('workspace', 'directory', 'file') AND relative_path IS NOT NULL) OR
          (kind IN ('external-package', 'node-builtin') AND relative_path IS NULL)
        ),
        UNIQUE (workspace_key, kind, relative_path)
      );

      CREATE TABLE edges (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        from_id TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('contains', 'imports', 'exports')),
        to_id TEXT NOT NULL,
        qualifier TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE,
        UNIQUE (from_id, relation_type, to_id, qualifier)
      );

      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance = 'typescript-compiler-api'),
        analyzer_version TEXT NOT NULL,
        source_file_id TEXT NOT NULL,
        range_start INTEGER NOT NULL CHECK (range_start >= 0),
        range_end INTEGER NOT NULL CHECK (range_end > range_start),
        evidence_kind TEXT NOT NULL CHECK (evidence_kind = 'module-dependency'),
        confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
        language TEXT NOT NULL CHECK (language IN (
          'typescript', 'typescriptreact', 'javascript', 'javascriptreact'
        )),
        detected_at TEXT NOT NULL CHECK (
          detected_at GLOB '????-??-??T??:??:??.???Z' AND
          substr(detected_at, 12, 2) BETWEEN '00' AND '23' AND
          detected_at = strftime('%Y-%m-%dT%H:%M:%fZ', detected_at)
        ),
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        FOREIGN KEY (edge_id) REFERENCES edges(id) ON DELETE CASCADE,
        FOREIGN KEY (source_file_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX evidence_workspace_edge_source_idx
      ON evidence(workspace_key, edge_id, source_file_id);

      CREATE TABLE facts_ownership (
        fact_kind TEXT NOT NULL CHECK (fact_kind IN ('edge', 'evidence', 'node')),
        fact_id TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        PRIMARY KEY (fact_kind, fact_id, owner_key)
      );

      INSERT INTO nodes(id, workspace_key, kind, relative_path, payload_json)
      SELECT id, workspace_key, kind, relative_path, '{}'
      FROM nodes_v2;

      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      SELECT id, workspace_key, from_id, relation_type, to_id, qualifier
      FROM edges_v2;

      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      SELECT fact_kind, fact_id, owner_key, workspace_key
      FROM facts_ownership_v2;

      DROP TABLE facts_ownership_v2;
      DROP TABLE evidence_v2;
      DROP TABLE edges_v2;
      DROP TABLE nodes_v2;

      INSERT INTO schema_migrations(version, applied_at)
      VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    const migrated = readMigrationCounts(database);
    if (
      migrated.nodeCount !== counts.nodeCount ||
      migrated.edgeCount !== counts.edgeCount ||
      migrated.ownershipCount !== counts.ownershipCount ||
      migrated.jobCount !== counts.jobCount ||
      migrated.evidenceCount !== 0
    ) {
      throw new Error("SQLite v3 表重建未完整保留既有 hierarchy/Job/read-set 数据。");
    }
    assertModuleDependencySchemaIntegrity(database);
  }).immediate();
  assertModuleDependencySchemaSupported(database);
  assertModuleDependencySchemaIntegrity(database);
}

/** v3 恢复路径幂等补齐声明索引，错误同名定义由精确 Schema 校验拒绝。 */
function ensureEvidenceSupportIndex(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS evidence_workspace_edge_source_idx
    ON evidence(workspace_key, edge_id, source_file_id)
  `);
}

/** v2 每个 hierarchy fact 必须唯一绑定本 workspace root，且不允许未知 fact kind。 */
function assertLegacyV2Ownership(database: Database.Database): void {
  const invalid = database.prepare(`
    SELECT 1 AS found
    FROM facts_ownership AS ownership
    LEFT JOIN nodes AS root ON root.workspace_key = ownership.workspace_key
      AND root.kind = 'workspace'
    WHERE ownership.fact_kind NOT IN ('edge', 'node') OR root.id IS NULL OR
      ownership.owner_key <> 'hierarchy:' || root.id OR
      (ownership.fact_kind = 'node' AND NOT EXISTS (
        SELECT 1 FROM nodes
        WHERE id = ownership.fact_id AND workspace_key = ownership.workspace_key
      )) OR
      (ownership.fact_kind = 'edge' AND NOT EXISTS (
        SELECT 1 FROM edges
        WHERE id = ownership.fact_id AND workspace_key = ownership.workspace_key
      ))
    LIMIT 1
  `).get();
  const incomplete = database.prepare(`
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
  if (invalid !== undefined || incomplete !== undefined) {
    throw new Error("SQLite v2 ownership 未唯一绑定 workspace hierarchy root。");
  }
}

/** v3 打开时交叉校验外键、身份、拓扑与多态 ownership。 */
export function assertModuleDependencySchemaIntegrity(database: Database.Database): void {
  assertExactV3Schema(database);
  assertNoForeignKeyViolation(database);
  assertCanonicalNodes(database);
  assertCanonicalEdges(database);
  assertCanonicalEvidence(database);
  assertOwnership(database);
  assertHierarchyTopology(database);
  assertModuleTopology(database);
}

/** 节点按 kind 回算稳定身份，外部实体不得携带 relative_path。 */
function assertCanonicalNodes(database: Database.Database): void {
  const rows = database.prepare(`
    SELECT id, workspace_key, kind, relative_path, payload_json FROM nodes
  `).iterate() as Iterable<{
    id: string;
    kind: string;
    payload_json: string;
    relative_path: string | null;
    workspace_key: string;
  }>;
  try {
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (row.kind === "workspace" || row.kind === "directory" || row.kind === "file") {
        if (
          row.relative_path === null ||
          normalizeRelativeGraphPath(row.relative_path) !== row.relative_path ||
          (row.kind === "file" && !isSupportedSourceFile(row.relative_path)) ||
          row.id !== buildGraphEntityId(row.workspace_key, row.kind, row.relative_path)
        ) {throw new Error("invalid hierarchy node");}
      } else if (row.kind === "external-package") {
        if (
          row.relative_path !== null || typeof payload.packageName !== "string" ||
          (payload.versionState !== "resolved" && payload.versionState !== "unresolved") ||
          (payload.versionState === "resolved" &&
            (typeof payload.packageVersion !== "string" ||
              row.id !== buildNpmPackagePurl(payload.packageName, payload.packageVersion))) ||
          (payload.versionState === "unresolved" &&
            (payload.packageVersion !== null ||
              row.id !== buildUnresolvedNpmPackagePurl(payload.packageName)))
        ) {throw new Error("invalid package node");}
      } else if (row.kind === "node-builtin") {
        if (
          row.relative_path !== null || typeof payload.moduleName !== "string" ||
          row.id !== normalizeNodeBuiltinId(payload.moduleName)
        ) {throw new Error("invalid builtin node");}
      } else {
        throw new Error("unknown node kind");
      }
    }
  } catch (error) {
    throw new Error("SQLite v3 包含非规范 node 身份。", { cause: error });
  }
}

/** 所有关系 ID 继续绑定 workspace、方向、端点、类型与 qualifier。 */
function assertCanonicalEdges(database: Database.Database): void {
  const rows = database.prepare(`
    SELECT id, workspace_key, from_id, relation_type, to_id, qualifier FROM edges
  `).iterate() as Iterable<{
    from_id: string;
    id: string;
    qualifier: string;
    relation_type: string;
    to_id: string;
    workspace_key: string;
  }>;
  for (const row of rows) {
    if (
      !["contains", "exports", "imports"].includes(row.relation_type) ||
      row.id !== buildGraphEdgeId(
        row.workspace_key,
        row.from_id,
        row.relation_type as "contains" | "exports" | "imports",
        row.to_id,
        row.qualifier,
      ) ||
      (row.relation_type === "contains" && row.qualifier !== "") ||
      (row.relation_type !== "contains" &&
        !isCanonicalModuleQualifier(
          row.relation_type as "exports" | "imports",
          row.qualifier,
        ))
    ) {
      throw new Error("SQLite v3 包含非规范 module edge qualifier 或 edge 身份。");
    }
  }
}

/** 持久 qualifier 必须可逆且与 AD-24 的关系类型一致。 */
function isCanonicalModuleQualifier(
  relationType: "exports" | "imports",
  qualifier: string,
): boolean {
  if (relationType === "imports") {
    return qualifier === "value" || qualifier === "type" || qualifier === "dynamic";
  }
  if (qualifier === "star:value" || qualifier === "star:type") {return true;}
  const segments = qualifier.split(":");
  if (segments.length !== 4 || segments[0] !== "reexport" ||
    (segments[3] !== "value" && segments[3] !== "type")) {
    return false;
  }
  try {
    segments.slice(1, 3).forEach((encoded) => decodeModuleExportName(encoded!));
    return true;
  } catch {
    return false;
  }
}

/** Evidence ID 按 AD-21 键回算，detectedAt 不参与身份。 */
function assertCanonicalEvidence(database: Database.Database): void {
  const rows = database.prepare(`
    SELECT id, edge_id, provenance, analyzer_version, source_file_id,
           range_start, range_end, evidence_kind, confidence, language, detected_at
    FROM evidence
  `).iterate() as Iterable<{
    analyzer_version: string;
    confidence: string;
    detected_at: string;
    edge_id: string;
    evidence_kind: string;
    id: string;
    language: string;
    provenance: string;
    range_end: number;
    range_start: number;
    source_file_id: string;
  }>;
  for (const row of rows) {
    if (
      row.provenance !== "typescript-compiler-api" ||
      row.evidence_kind !== "module-dependency" ||
      !["high", "medium", "low"].includes(row.confidence) ||
      !["typescript", "typescriptreact", "javascript", "javascriptreact"]
        .includes(row.language) ||
      !isCanonicalUtcTimestamp(row.detected_at) ||
      row.id !== buildModuleEvidenceId({
      analyzerVersion: row.analyzer_version,
      edgeId: row.edge_id,
      evidenceKind: row.evidence_kind as "module-dependency",
      normalizedRange: { end: row.range_end, start: row.range_start },
      provenance: row.provenance as "typescript-compiler-api",
      sourceFileId: row.source_file_id,
      })
    ) {
      throw new Error("SQLite v3 包含非规范 Evidence 身份。");
    }
  }
}

/** module edge 与 Evidence 必须形成 file→module 的受支持拓扑且每条边有有效证据。 */
function assertModuleTopology(database: Database.Database): void {
  const invalidEdge = database.prepare(`
    SELECT 1 AS found
    FROM edges AS edge
    JOIN nodes AS source ON source.workspace_key = edge.workspace_key
      AND source.id = edge.from_id
    JOIN nodes AS target ON target.workspace_key = edge.workspace_key
      AND target.id = edge.to_id
    WHERE edge.relation_type IN ('imports', 'exports') AND (
      source.kind <> 'file' OR
      target.kind NOT IN ('file', 'external-package', 'node-builtin') OR
      (edge.relation_type = 'imports' AND edge.qualifier NOT IN ('value', 'type', 'dynamic')) OR
      (edge.relation_type = 'exports' AND
        edge.qualifier NOT IN ('star:value', 'star:type') AND
        edge.qualifier NOT LIKE 'reexport:%:%:value' AND
        edge.qualifier NOT LIKE 'reexport:%:%:type')
    )
    LIMIT 1
  `).get();
  const invalidEvidence = database.prepare(`
    SELECT 1 AS found
    FROM evidence
    WHERE NOT EXISTS (
      SELECT 1
      FROM edges AS edge
      JOIN nodes AS source ON source.workspace_key = evidence.workspace_key
        AND source.id = evidence.source_file_id
      WHERE edge.workspace_key = evidence.workspace_key
        AND edge.id = evidence.edge_id
        AND edge.relation_type IN ('imports', 'exports')
        AND source.kind = 'file'
        AND evidence.source_file_id = edge.from_id
    )
    LIMIT 1
  `).get();
  const unsupportedEdge = database.prepare(`
    SELECT 1 AS found
    FROM edges AS edge
    WHERE edge.relation_type IN ('imports', 'exports') AND NOT EXISTS (
      SELECT 1 FROM evidence
      WHERE evidence.workspace_key = edge.workspace_key AND evidence.edge_id = edge.id
        AND evidence.source_file_id = edge.from_id
    )
    LIMIT 1
  `).get();
  if (invalidEdge !== undefined || invalidEvidence !== undefined || unsupportedEdge !== undefined) {
    throw new Error("SQLite v3 module edge/Evidence 拓扑不满足合同。");
  }
}

/** 通过 PRAGMA 与 sqlite_master 锁定 v3 精确列、约束、唯一索引和外键合同。 */
function assertExactV3Schema(database: Database.Database): void {
  assertExactTableSet(readUserTableNames(database));
  const expectedColumns: Readonly<Record<string, readonly string[]>> = {
    edges: ["id:TEXT:0::1", "workspace_key:TEXT:1::0", "from_id:TEXT:1::0",
      "relation_type:TEXT:1::0", "to_id:TEXT:1::0", "qualifier:TEXT:1:'':0"],
    evidence: ["id:TEXT:0::1", "workspace_key:TEXT:1::0", "edge_id:TEXT:1::0",
      "provenance:TEXT:1::0", "analyzer_version:TEXT:1::0", "source_file_id:TEXT:1::0",
      "range_start:INTEGER:1::0", "range_end:INTEGER:1::0", "evidence_kind:TEXT:1::0",
      "confidence:TEXT:1::0", "language:TEXT:1::0", "detected_at:TEXT:1::0",
      "payload_json:TEXT:1:'{}':0"],
    facts_ownership: ["fact_kind:TEXT:1::1", "fact_id:TEXT:1::2",
      "owner_key:TEXT:1::3", "workspace_key:TEXT:1::0"],
    jobs: ["id:TEXT:0::1", "workspace_key:TEXT:1::0", "kind:TEXT:1::0",
      "state:TEXT:1::0", "requested_at:TEXT:1::0", "started_at:TEXT:0::0",
      "completed_at:TEXT:0::0", "error_code:TEXT:0::0", "error_log_id:TEXT:0::0",
      "base_graph_revision:INTEGER:0::0", "result_graph_revision:INTEGER:0::0",
      "read_set_json:TEXT:0::0", "patch_digest:TEXT:0::0",
      "legacy_schema_version:INTEGER:0:NULL:0"],
    meta: ["key:TEXT:0::1", "value:TEXT:1::0"],
    nodes: ["id:TEXT:0::1", "workspace_key:TEXT:1::0", "kind:TEXT:1::0",
      "relative_path:TEXT:0::0", "payload_json:TEXT:1:'{}':0"],
    schema_migrations: ["version:INTEGER:0::1", "applied_at:TEXT:1::0"],
    workspace: ["workspace_key:TEXT:0::1", "committed_at:TEXT:0::0",
      "indexed_file_count:INTEGER:0::0", "node_count:INTEGER:0::0",
      "edge_count:INTEGER:0::0", "excluded_path_count:INTEGER:0::0",
      "builtin_rules_version:TEXT:0::0", "graph_revision:INTEGER:0::0",
      "freshness:TEXT:0::0", "completeness:TEXT:0::0", "manifest_digest:TEXT:0::0",
      "input_digest:TEXT:0::0", "config_digest:TEXT:0::0",
      "effective_ignore_digest:TEXT:0::0", "patch_digest:TEXT:0::0"],
  };
  for (const table of MODULE_DEPENDENCY_TABLE_NAMES) {
    const actualColumns = (database.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
      dflt_value: string | null;
      name: string;
      notnull: number;
      pk: number;
      type: string;
    }>).map((column) => [
      column.name,
      column.type.toUpperCase(),
      String(column.notnull),
      column.dflt_value ?? "",
      String(column.pk),
    ].join(":"));
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns[table])) {
      throw new Error(`SQLite v3 ${table} 列合同不一致。`);
    }
  }
  assertExactIndexes(database);
  assertExactForeignKeys(database);
  assertRequiredCheckClauses(database);
}

/** 所有索引必须仅来自声明的 PRIMARY KEY/UNIQUE，拒绝额外或缺失索引。 */
function assertExactIndexes(database: Database.Database): void {
  const expected: Readonly<Record<string, readonly string[]>> = {
    edges: ["pk:id", "u:from_id,relation_type,to_id,qualifier"],
    evidence: [
      "c:evidence_workspace_edge_source_idx:workspace_key,edge_id,source_file_id",
      "pk:id",
    ],
    facts_ownership: ["pk:fact_kind,fact_id,owner_key"],
    jobs: ["pk:id"],
    meta: ["pk:key"],
    nodes: ["pk:id", "u:workspace_key,kind,relative_path"],
    schema_migrations: [],
    workspace: ["pk:workspace_key"],
  };
  for (const table of MODULE_DEPENDENCY_TABLE_NAMES) {
    const actual = (database.prepare(`PRAGMA index_list('${table}')`).all() as Array<{
      name: string;
      origin: string;
      partial: number;
      unique: number;
    }>).map((index) => {
      const xinfo = database.prepare(`PRAGMA index_xinfo('${index.name}')`).all() as Array<{
        cid: number;
        coll: string;
        desc: number;
        key: number;
        name: string | null;
        seqno: number;
      }>;
      const keyColumns = xinfo.filter((column) => column.key === 1)
        .sort((left, right) => left.seqno - right.seqno);
      const indexSemanticsValid = keyColumns.length > 0 && keyColumns.every((column, position) =>
        column.seqno === position && column.cid >= 0 && column.name !== null &&
        column.coll.toUpperCase() === "BINARY" && column.desc === 0 && column.key === 1);
      const columns = keyColumns.map((column) => column.name).join(",");
      if (index.partial !== 0) {
        return `invalid:${index.name}`;
      }
      if (!indexSemanticsValid) {return `invalid:${index.name}`;}
      if (index.origin === "c") {
        return index.unique === 0
          ? `c:${index.name}:${columns}`
          : `invalid:${index.name}`;
      }
      if (index.unique !== 1 || (index.origin !== "pk" && index.origin !== "u")) {
        return `invalid:${index.name}`;
      }
      return `${index.origin}:${columns}`;
    }).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...(expected[table] ?? [])].sort())) {
      throw new Error(`SQLite v3 ${table} 索引合同不一致。`);
    }
  }
}

/** 外键端点与 CASCADE 行为按表精确校验。 */
function assertExactForeignKeys(database: Database.Database): void {
  const expected: Readonly<Record<string, readonly string[]>> = {
    edges: ["from_id>nodes.id:CASCADE", "to_id>nodes.id:CASCADE",
      "workspace_key>workspace.workspace_key:CASCADE"],
    evidence: ["edge_id>edges.id:CASCADE", "source_file_id>nodes.id:CASCADE",
      "workspace_key>workspace.workspace_key:CASCADE"],
    facts_ownership: ["workspace_key>workspace.workspace_key:CASCADE"],
    jobs: ["workspace_key>workspace.workspace_key:CASCADE"],
    meta: [], nodes: ["workspace_key>workspace.workspace_key:CASCADE"],
    schema_migrations: [], workspace: [],
  };
  for (const table of MODULE_DEPENDENCY_TABLE_NAMES) {
    const actual = (database.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
      from: string;
      on_delete: string;
      table: string;
      to: string;
    }>).map((foreignKey) =>
      `${foreignKey.from}>${foreignKey.table}.${foreignKey.to}:${foreignKey.on_delete}`)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...(expected[table] ?? [])].sort())) {
      throw new Error(`SQLite v3 ${table} 外键合同不一致。`);
    }
  }
}

/** sqlite_master 的 CHECK 集合必须逐表达式精确匹配，禁止 `OR 1` 等削弱条件。 */
function assertRequiredCheckClauses(database: Database.Database): void {
  const expected: Readonly<Record<string, readonly string[]>> = {
    edges: ["relation_type IN ('contains', 'imports', 'exports')"],
    evidence: [
      "provenance = 'typescript-compiler-api'",
      "range_start >= 0",
      "range_end > range_start",
      "evidence_kind = 'module-dependency'",
      "confidence IN ('high', 'medium', 'low')",
      "language IN ('typescript', 'typescriptreact', 'javascript', 'javascriptreact')",
      "detected_at GLOB '????-??-??T??:??:??.???Z' AND substr(detected_at, 12, 2) BETWEEN '00' AND '23' AND detected_at = strftime('%Y-%m-%dT%H:%M:%fZ', detected_at)",
      "json_valid(payload_json)",
    ],
    facts_ownership: ["fact_kind IN ('edge', 'evidence', 'node')"],
    jobs: [
      "kind IN ('initial-index', 'rebuild')",
      "state IN ('queued', 'running', 'succeeded', 'failed', 'partial', 'cancelled')",
      "legacy_schema_version IS NULL OR legacy_schema_version = 1",
    ],
    nodes: [
      "kind IN ('workspace', 'directory', 'file', 'external-package', 'node-builtin')",
      "json_valid(payload_json)",
      "(kind IN ('workspace', 'directory', 'file') AND relative_path IS NOT NULL) OR (kind IN ('external-package', 'node-builtin') AND relative_path IS NULL)",
    ],
  };
  for (const [table, expressions] of Object.entries(expected)) {
    const row = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as { sql: string } | undefined;
    const actualChecks = row === undefined ? [] : extractCheckExpressions(row.sql);
    const expectedChecks = expressions.map(normalizeCheckExpression).sort();
    if (JSON.stringify(actualChecks) !== JSON.stringify(expectedChecks)) {
      throw new Error(`SQLite v3 ${table} CHECK 合同不一致。`);
    }
  }
}

/** 只在 SQL 注释与全部 quoted context 外识别独立 CHECK token。 */
export function extractCheckExpressions(sql: string): string[] {
  const expressions: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrComment(sql, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    if (sql.slice(index, index + 5).toLowerCase() === "check" &&
      !isSqlIdentifierCharacter(sql[index - 1]) &&
      !isSqlIdentifierCharacter(sql[index + 5])) {
      const openIndex = skipSqlTrivia(sql, index + 5);
      if (sql[openIndex] === "(") {
        const closeIndex = findSqlClosingParenthesis(sql, openIndex);
        expressions.push(normalizeCheckExpression(sql.slice(openIndex + 1, closeIndex)));
        index = closeIndex + 1;
        continue;
      }
    }
    index += 1;
  }
  return expressions.sort();
}

/** SQL 标识符边界采用 SQLite 常见 ASCII 字母、数字、下划线与美元符。 */
function isSqlIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_$]/u.test(character);
}

/** 跳过空白与注释，供 CHECK token 和左括号之间使用。 */
function skipSqlTrivia(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/u.test(sql[index] ?? "")) {
      index += 1;
      continue;
    }
    const skipped = skipSqlComment(sql, index);
    if (skipped === null) {return index;}
    index = skipped;
  }
  return index;
}

/** 返回 quoted/comment context 之后的位置；当前位置不是 context 时返回 null。 */
function skipSqlQuotedOrComment(sql: string, start: number): number | null {
  const commentEnd = skipSqlComment(sql, start);
  if (commentEnd !== null) {return commentEnd;}
  const opening = sql[start];
  if (opening === "'" || opening === '"' || opening === "`") {
    return skipSqlDelimited(sql, start, opening, opening);
  }
  return opening === "[" ? skipSqlDelimited(sql, start, "[", "]") : null;
}

/** 跳过 line/block comment，并拒绝未闭合 block comment。 */
function skipSqlComment(sql: string, start: number): number | null {
  if (sql.startsWith("--", start)) {
    const newline = sql.indexOf("\n", start + 2);
    return newline < 0 ? sql.length : newline + 1;
  }
  if (!sql.startsWith("/*", start)) {return null;}
  const close = sql.indexOf("*/", start + 2);
  if (close < 0) {throw new Error("SQLite DDL block comment 未闭合。");}
  return close + 2;
}

/** 跳过单/双引号、反引号或方括号 quoted context，支持成对转义结束符。 */
function skipSqlDelimited(
  sql: string,
  start: number,
  opening: string,
  closing: string,
): number {
  let index = start + opening.length;
  while (index < sql.length) {
    if (sql[index] === closing) {
      if (sql[index + 1] === closing) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  throw new Error("SQLite DDL quoted context 未闭合。");
}

/** 从左括号开始按 tokenizer context 计算匹配右括号。 */
function findSqlClosingParenthesis(sql: string, openIndex: number): number {
  let depth = 1;
  let index = openIndex + 1;
  while (index < sql.length) {
    const skipped = skipSqlQuotedOrComment(sql, index);
    if (skipped !== null) {
      index = skipped;
      continue;
    }
    if (sql[index] === "(") {depth += 1;}
    else if (sql[index] === ")") {
      depth -= 1;
      if (depth === 0) {return index;}
    }
    index += 1;
  }
  throw new Error("SQLite CHECK DDL 括号不完整。");
}

/** CHECK 比较忽略 SQL 排版与关键字大小写，但保留全部运算符和字面量。 */
function normalizeCheckExpression(expression: string): string {
  let normalized = "";
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === undefined) {continue;}
    const skippedComment = skipSqlComment(expression, index);
    if (skippedComment !== null) {
      index = skippedComment - 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      const end = skipSqlDelimited(expression, index, character, closing);
      normalized += expression.slice(index, end);
      index = end - 1;
    } else if (!/\s/u.test(character)) {
      normalized += character.toLowerCase();
    }
  }
  return normalized;
}

/** 多态 ownership 必须联结到声明类型的真实事实。 */
function assertOwnership(database: Database.Database): void {
  const invalid = database.prepare(`
    SELECT 1 AS found
    FROM facts_ownership AS ownership
    WHERE ownership.fact_kind NOT IN ('edge', 'evidence', 'node') OR
    (ownership.fact_kind = 'node' AND NOT EXISTS (
      SELECT 1 FROM nodes WHERE id = ownership.fact_id
        AND workspace_key = ownership.workspace_key
    )) OR (ownership.fact_kind = 'edge' AND NOT EXISTS (
      SELECT 1 FROM edges WHERE id = ownership.fact_id
        AND workspace_key = ownership.workspace_key
    )) OR (ownership.fact_kind = 'evidence' AND NOT EXISTS (
      SELECT 1 FROM evidence WHERE id = ownership.fact_id
        AND workspace_key = ownership.workspace_key
    ))
    LIMIT 1
  `).get();
  if (invalid !== undefined) {
    throw new Error("SQLite v3 facts_ownership 包含无效 fact 引用。");
  }
  const invalidHierarchyOwner = database.prepare(`
    SELECT 1 AS found
    FROM facts_ownership AS ownership
    LEFT JOIN nodes AS node ON node.workspace_key = ownership.workspace_key
      AND node.id = ownership.fact_id AND ownership.fact_kind = 'node'
    LEFT JOIN edges AS edge ON edge.workspace_key = ownership.workspace_key
      AND edge.id = ownership.fact_id AND ownership.fact_kind = 'edge'
    LEFT JOIN nodes AS root ON root.workspace_key = ownership.workspace_key
      AND root.kind = 'workspace'
    WHERE ownership.fact_kind IN ('node', 'edge') AND (
      root.id IS NULL OR ownership.owner_key <> 'hierarchy:' || root.id OR
      (ownership.fact_kind = 'node' AND node.kind NOT IN ('workspace', 'directory', 'file')) OR
      (ownership.fact_kind = 'edge' AND edge.relation_type <> 'contains')
    )
    LIMIT 1
  `).get();
  const incompleteHierarchyOwnership = database.prepare(`
    SELECT 1 AS found
    FROM (
      SELECT 'node' AS fact_kind, node.id AS fact_id, node.workspace_key
      FROM nodes AS node WHERE node.kind IN ('workspace', 'directory', 'file')
      UNION ALL
      SELECT 'edge' AS fact_kind, edge.id AS fact_id, edge.workspace_key
      FROM edges AS edge WHERE edge.relation_type = 'contains'
    ) AS fact
    JOIN nodes AS root ON root.workspace_key = fact.workspace_key AND root.kind = 'workspace'
    WHERE (
      SELECT COUNT(*) FROM facts_ownership AS ownership
      WHERE ownership.workspace_key = fact.workspace_key
        AND ownership.fact_kind = fact.fact_kind
        AND ownership.fact_id = fact.fact_id
        AND ownership.owner_key = 'hierarchy:' || root.id
    ) <> 1
    LIMIT 1
  `).get();
  const invalidEvidenceOwner = database.prepare(`
    SELECT 1 AS found
    FROM evidence
    WHERE (
      SELECT COUNT(*) FROM facts_ownership AS ownership
      WHERE ownership.workspace_key = evidence.workspace_key
        AND ownership.fact_kind = 'evidence'
        AND ownership.fact_id = evidence.id
        AND ownership.owner_key = 'source:typescript:' || evidence.source_file_id
    ) <> 1
    LIMIT 1
  `).get();
  if (
    invalidHierarchyOwner !== undefined || incompleteHierarchyOwnership !== undefined ||
    invalidEvidenceOwner !== undefined
  ) {
    throw new Error("SQLite v3 ownership 未按 hierarchy/source 合同唯一绑定。");
  }
}

/** hierarchy 子图单独验证，module edge 不参与树入度或可达性。 */
function assertHierarchyTopology(database: Database.Database): void {
  const invalidRoot = database.prepare(`
    SELECT 1 AS found
    FROM workspace AS candidate
    WHERE EXISTS (
      SELECT 1 FROM nodes
      WHERE workspace_key = candidate.workspace_key
        AND kind IN ('workspace', 'directory', 'file')
    ) AND (
      SELECT COUNT(*) FROM nodes
      WHERE workspace_key = candidate.workspace_key AND kind = 'workspace'
    ) <> 1
    LIMIT 1
  `).get();
  const duplicatePath = database.prepare(`
    SELECT 1 AS found
    FROM nodes
    WHERE kind IN ('workspace', 'directory', 'file')
    GROUP BY workspace_key, relative_path
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  const emptyDirectory = database.prepare(`
    SELECT 1 AS found
    FROM nodes AS node
    WHERE node.kind = 'directory' AND NOT EXISTS (
      SELECT 1 FROM edges AS outgoing
      WHERE outgoing.workspace_key = node.workspace_key
        AND outgoing.from_id = node.id AND outgoing.relation_type = 'contains'
    )
    LIMIT 1
  `).get();
  const crossWorkspaceEndpoint = database.prepare(`
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
  const invalidContainsShape = database.prepare(`
    SELECT 1 AS found
    FROM edges AS edge
    JOIN nodes AS source ON source.id = edge.from_id
      AND source.workspace_key = edge.workspace_key
    JOIN nodes AS target ON target.id = edge.to_id
      AND target.workspace_key = edge.workspace_key
    WHERE edge.relation_type = 'contains' AND (
      edge.qualifier <> '' OR source.kind = 'file' OR target.kind = 'workspace' OR
      source.kind IN ('external-package', 'node-builtin') OR
      target.kind IN ('external-package', 'node-builtin') OR
      (source.kind = 'workspace' AND instr(target.relative_path, '/') <> 0) OR
      (source.kind = 'directory' AND (
        substr(target.relative_path, 1, length(source.relative_path) + 1) <>
          source.relative_path || '/' OR
        instr(substr(target.relative_path, length(source.relative_path) + 2), '/') <> 0
      ))
    )
    LIMIT 1
  `).get();
  const invalid = database.prepare(`
    WITH RECURSIVE hierarchy_nodes AS (
      SELECT * FROM nodes WHERE kind IN ('workspace', 'directory', 'file')
    ), incoming AS (
      SELECT workspace_key, to_id, COUNT(*) AS edge_count
      FROM edges WHERE relation_type = 'contains'
      GROUP BY workspace_key, to_id
    ), reachable(workspace_key, node_id) AS (
      SELECT workspace_key, id FROM hierarchy_nodes WHERE kind = 'workspace'
      UNION
      SELECT edge.workspace_key, edge.to_id
      FROM reachable
      JOIN edges AS edge ON edge.workspace_key = reachable.workspace_key
        AND edge.from_id = reachable.node_id AND edge.relation_type = 'contains'
    )
    SELECT 1 AS found
    FROM hierarchy_nodes AS node
    LEFT JOIN incoming ON incoming.workspace_key = node.workspace_key
      AND incoming.to_id = node.id
    WHERE (node.kind = 'workspace' AND COALESCE(incoming.edge_count, 0) <> 0)
      OR (node.kind <> 'workspace' AND COALESCE(incoming.edge_count, 0) <> 1)
      OR NOT EXISTS (
        SELECT 1 FROM reachable WHERE workspace_key = node.workspace_key AND node_id = node.id
      )
    LIMIT 1
  `).get();
  if (
    invalidRoot !== undefined || duplicatePath !== undefined || emptyDirectory !== undefined ||
    crossWorkspaceEndpoint !== undefined || invalidContainsShape !== undefined ||
    invalid !== undefined
  ) {
    throw new Error("SQLite v3 hierarchy 子图不满足规范树不变量。");
  }
}

/** 读取迁移前后必须保持的事实与 Job 行数。 */
function readMigrationCounts(database: Database.Database): {
  edgeCount: number;
  evidenceCount: number;
  jobCount: number;
  nodeCount: number;
  ownershipCount: number;
} {
  const count = (table: string): number => (database.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).get() as { count: number }).count;
  return {
    edgeCount: count("edges"),
    evidenceCount: count("evidence"),
    jobCount: count("jobs"),
    nodeCount: count("nodes"),
    ownershipCount: count("facts_ownership"),
  };
}

/** 只读取当前最高 migration 版本。 */
function readSchemaVersion(database: Database.Database): number | null {
  if (!readUserTableNames(database).includes("schema_migrations")) {return null;}
  return (database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null }).version;
}

/** 任何外键损坏都必须在打开边界 fail closed。 */
function assertNoForeignKeyViolation(database: Database.Database): void {
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    throw new Error("SQLite 数据库包含外键完整性违规，拒绝继续打开。");
  }
}

/** v3 继续锁定精确八表。 */
function assertExactTableSet(actual: readonly string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(MODULE_DEPENDENCY_TABLE_NAMES)) {
    throw new Error("SQLite 用户表集合不符合 Story 1.5 migration v3 合同。");
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
