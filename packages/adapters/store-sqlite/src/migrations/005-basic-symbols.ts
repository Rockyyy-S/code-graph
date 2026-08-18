import type Database from "better-sqlite3";
import type { CanonicalDigestPort } from "@codegraph/application";
import {
  buildGraphEdgeId,
  buildModuleEvidenceId,
  isCanonicalUtcTimestamp,
  type GraphRelationType,
  type ModuleEvidenceV1,
} from "@codegraph/domain";
import { assertBasicSymbolModuleDependencySemantics } from "./003-module-dependencies.js";
import {
  AD4_EDGE_IDENTITY_TABLE_NAMES,
  applyAd4EdgeIdentityMigration,
  type Ad4EdgeIdentityMigrationFaultContext,
} from "./004-ad4-edge-identity.js";

/** BasicSymbol 节点首次持久化后的 schema 版本。 */
export const BASIC_SYMBOL_SCHEMA_VERSION = 5;

/** v5 继续复用既有八张应用表，不创建旁路 symbol store。 */
export const BASIC_SYMBOL_TABLE_NAMES = AD4_EDGE_IDENTITY_TABLE_NAMES;

/** v5 复用 v4 重键故障注入，新增表重建保持单事务 fail closed。 */
export interface ApplyBasicSymbolMigrationOptions {
  digestPort: CanonicalDigestPort;
  faultInjector?: (context: Ad4EdgeIdentityMigrationFaultContext | {
    entityIndex: -5;
    stage: "node";
  }) => void;
}

/** absent/v1-v5 只读 preflight；未来版本必须 fail closed。 */
export function assertBasicSymbolSchemaSupported(database: Database.Database): void {
  const tables = readUserTableNames(database);
  if (!tables.includes("schema_migrations")) {
    if (tables.length > 0) {throw new Error("SQLite Schema 缺少受支持的 migration 元数据。");}
    return;
  }
  const version = readSchemaVersion(database);
  if (version === null || version < 1 || version > BASIC_SYMBOL_SCHEMA_VERSION) {
    throw new Error("SQLite Schema 版本未知或未完整迁移。");
  }
}

/**
 * 先复用 v4 原子重键，再通过完整表重建仅扩展 nodes.kind 的封闭词汇。
 *
 * 历史 migration 保持不可变；edges、Evidence、ownership 与 revision 数据逐行原样复制。
 */
export function applyBasicSymbolMigration(
  database: Database.Database,
  options: ApplyBasicSymbolMigrationOptions,
): void {
  assertBasicSymbolSchemaSupported(database);
  const current = readSchemaVersion(database);
  if (current !== BASIC_SYMBOL_SCHEMA_VERSION) {
    applyAd4EdgeIdentityMigration(database, {
      digestPort: options.digestPort,
      ...(options.faultInjector === undefined ? {} : {
        faultInjector: (context: Ad4EdgeIdentityMigrationFaultContext) =>
          options.faultInjector?.(context),
      }),
    });
  }
  if (readSchemaVersion(database) === BASIC_SYMBOL_SCHEMA_VERSION) {
    assertBasicSymbolSchemaIntegrity(database);
    return;
  }
  database.transaction(() => {
    database.pragma("defer_foreign_keys = ON");
    database.exec(`
      ALTER TABLE facts_ownership RENAME TO facts_ownership_v4;
      ALTER TABLE evidence RENAME TO evidence_v4;
      ALTER TABLE edges RENAME TO edges_v4;
      ALTER TABLE nodes RENAME TO nodes_v4;
      DROP INDEX evidence_workspace_edge_source_idx;

      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'workspace', 'directory', 'file', 'external-package', 'node-builtin', 'symbol'
        )),
        relative_path TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        CHECK (
          (kind IN ('workspace', 'directory', 'file') AND relative_path IS NOT NULL) OR
          (kind IN ('external-package', 'node-builtin', 'symbol') AND relative_path IS NULL)
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

      INSERT INTO nodes SELECT * FROM nodes_v4;
      INSERT INTO edges SELECT * FROM edges_v4;
      INSERT INTO evidence SELECT * FROM evidence_v4;
      INSERT INTO facts_ownership SELECT * FROM facts_ownership_v4;

      DROP TABLE facts_ownership_v4;
      DROP TABLE evidence_v4;
      DROP TABLE edges_v4;
      DROP TABLE nodes_v4;

    `);
    /** 重建已完成但版本尚未提交，用于证明整个 v5 仍是单事务可回滚的。 */
    options.faultInjector?.({ entityIndex: -5, stage: "node" });
    database.prepare(`
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run();
  }).immediate();
  assertBasicSymbolSchemaIntegrity(database);
}

/** v5 reopen/commit 后校验精确表集、CHECK 词汇、FK 与 SQLite 页完整性。 */
export function assertBasicSymbolSchemaIntegrity(database: Database.Database): void {
  if (readSchemaVersion(database) !== BASIC_SYMBOL_SCHEMA_VERSION) {
    throw new Error("SQLite BasicSymbol schema 版本不一致。");
  }
  const tables = readUserTableNames(database);
  if (JSON.stringify(tables) !== JSON.stringify([...BASIC_SYMBOL_TABLE_NAMES].sort())) {
    throw new Error("SQLite BasicSymbol migration 未保持精确八表。");
  }
  const nodeSql = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'
  `).pluck().get();
  if (typeof nodeSql !== "string" || !nodeSql.includes("'symbol'") ||
    !nodeSql.includes("'external-package', 'node-builtin', 'symbol'")) {
    throw new Error("SQLite nodes.kind 未封闭接纳 BasicSymbol。");
  }
  const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error("SQLite 数据库包含外键完整性违规，拒绝继续打开。");
  }
  assertBasicSymbolModuleDependencySemantics(database);
  assertCanonicalGraphRows(database);
  const integrity = database.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {throw new Error("SQLite BasicSymbol 页完整性校验失败。");}
}

/** v5 继续严格回验 AD-4 edge、AD-21 Evidence 与 source ownership。 */
function assertCanonicalGraphRows(database: Database.Database): void {
  const edges = database.prepare(`
    SELECT id, workspace_key, from_id, relation_type, to_id, qualifier FROM edges
  `).all() as Array<{
    from_id: string;
    id: string;
    qualifier: string;
    relation_type: GraphRelationType;
    to_id: string;
    workspace_key: string;
  }>;
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  for (const edge of edges) {
    let expected: string;
    try {
      expected = buildGraphEdgeId(
        edge.workspace_key,
        edge.from_id,
        edge.relation_type,
        edge.to_id,
        edge.qualifier,
      );
    } catch (error) {
      throw new Error("SQLite edge 词汇或 qualifier 不合法。", { cause: error });
    }
    if (expected !== edge.id) {throw new Error("SQLite edge 身份与 AD-4 tuple 不一致。");}
  }
  const evidenceRows = database.prepare(`
    SELECT id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
           range_start, range_end, evidence_kind, confidence, language, detected_at
    FROM evidence
  `).all() as Array<ModuleEvidenceV1 & {
    analyzer_version: string;
    detected_at: string;
    edge_id: string;
    evidence_kind: string;
    range_end: number;
    range_start: number;
    source_file_id: string;
    workspace_key: string;
  }>;
  const nodeKind = new Map((database.prepare("SELECT id, workspace_key, kind FROM nodes").all() as
    Array<{ id: string; kind: string; workspace_key: string }>).map((node) =>
    [node.id, `${node.workspace_key}\0${node.kind}`]));
  for (const row of evidenceRows) {
    const edge = edgeById.get(row.edge_id);
    if (edge === undefined || edge.workspace_key !== row.workspace_key ||
      edge.from_id !== row.source_file_id ||
      nodeKind.get(row.source_file_id) !== `${row.workspace_key}\0file` ||
      row.provenance !== "typescript-compiler-api" || row.evidence_kind !== "module-dependency" ||
      !["high", "medium", "low"].includes(row.confidence) ||
      !["typescript", "typescriptreact", "javascript", "javascriptreact"].includes(row.language) ||
      !isCanonicalUtcTimestamp(row.detected_at)) {
      throw new Error("SQLite Evidence 词汇、workspace 或拓扑不合法。");
    }
    const evidence = {
      analyzerVersion: row.analyzer_version,
      confidence: row.confidence,
      detectedAt: row.detected_at,
      edgeId: row.edge_id,
      evidenceKind: "module-dependency" as const,
      id: row.id,
      language: row.language,
      normalizedRange: { end: row.range_end, start: row.range_start },
      provenance: "typescript-compiler-api" as const,
      sourceFileId: row.source_file_id,
    } satisfies ModuleEvidenceV1;
    if (buildModuleEvidenceId(evidence) !== row.id) {
      throw new Error("SQLite Evidence 身份不合法。");
    }
    const ownership = database.prepare(`
      SELECT owner_key FROM facts_ownership
      WHERE workspace_key = ? AND fact_kind = 'evidence' AND fact_id = ?
    `).all(row.workspace_key, row.id) as Array<{ owner_key: string }>;
    if (ownership.length !== 1 ||
      ownership[0]?.owner_key !== `source:typescript:${row.source_file_id}`) {
      throw new Error("SQLite Evidence ownership 拓扑不合法。");
    }
  }
}

function readSchemaVersion(database: Database.Database): number | null {
  const exists = database.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get() as { present: number } | undefined;
  if (exists === undefined) {return null;}
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    { version: number | null } | undefined;
  return row?.version ?? null;
}

function readUserTableNames(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[]).map((row) => row.name);
}
