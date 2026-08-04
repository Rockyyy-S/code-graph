import type Database from "better-sqlite3";
import {
  buildHierarchyGraph,
  compareCanonicalGraphText,
  HIERARCHY_PRODUCER_KIND,
  HIERARCHY_PRODUCER_VERSION,
  type AnalyzerConfigFenceSnapshotV1,
  type AnalyzerConfigSnapshotV1,
  type CanonicalDigestPort,
} from "@codegraph/application";
import {
  buildGraphEdgeId,
  buildGraphEntityId,
  buildLegacyGraphEdgeIdV0,
  buildModuleEvidenceId,
  createExternalPackageNode,
  createNodeBuiltinNode,
  createUnresolvedExternalPackageNode,
  type CompositeGraphReadSetV1,
  type GraphEdgeV1,
  type GraphNodeV1,
  type GraphRelationType,
  type HierarchyReadSetV1,
  type ModuleEvidenceV1,
} from "@codegraph/domain";
import { BOOTSTRAP_SCHEMA_VERSION, BOOTSTRAP_TABLE_NAMES } from "./001-bootstrap.js";
import { DETERMINISTIC_COMMIT_SCHEMA_VERSION } from "./002-deterministic-commit.js";
import {
  applyModuleDependencyMigration,
  assertAd4ModuleDependencySchemaIntegrity,
  assertModuleDependencySchemaIntegrity,
  MODULE_DEPENDENCY_SCHEMA_VERSION,
} from "./003-module-dependencies.js";

/** AD-4 eager rekey 后的 SQLite schema 版本。 */
export const AD4_EDGE_IDENTITY_SCHEMA_VERSION = 4;

/** v4 仍然只有既有八张应用表，不引入 alias 或 dual-read 表。 */
export const AD4_EDGE_IDENTITY_TABLE_NAMES = BOOTSTRAP_TABLE_NAMES;

/** migration 故障注入只暴露负索引检查点，避免与正常提交实体序号混淆。 */
export interface Ad4EdgeIdentityMigrationFaultContext {
  entityIndex: -4 | -3 | -2 | -1;
  stage: "edge" | "evidence" | "metadata" | "ownership";
}

/** SQLite v4 migration 的显式依赖。 */
export interface ApplyAd4EdgeIdentityMigrationOptions {
  digestPort: CanonicalDigestPort;
  faultInjector?: (context: Ad4EdgeIdentityMigrationFaultContext) => void;
}

/** 同一 AD-4 ID 对应不同 tuple 时使用稳定错误码 fail closed。 */
export class GraphEdgeIdCollisionError extends Error {
  public readonly code = "GRAPH_EDGE_ID_COLLISION";

  public constructor() {
    super("AD-4 edge ID 对应多个不同关系 tuple，迁移已回滚。");
    this.name = "GraphEdgeIdCollisionError";
  }
}

interface EdgeIdentityRow {
  from_id: string;
  id: string;
  qualifier: string;
  relation_type: GraphRelationType;
  to_id: string;
  workspace_key: string;
}

interface EdgeIdentityMapping extends EdgeIdentityRow {
  new_id: string;
  tuple_key: string;
}

interface EvidenceIdentityRow {
  analyzer_version: string;
  edge_id: string;
  evidence_kind: "module-dependency";
  id: string;
  provenance: "typescript-compiler-api";
  range_end: number;
  range_start: number;
  source_file_id: string;
}

interface EvidenceIdentityMapping {
  new_edge_id: string;
  new_id: string;
  old_id: string;
}

interface WorkspaceCommitRow {
  committed_at: string;
  config_digest: string | null;
  effective_ignore_digest: string | null;
  graph_revision: number;
  input_digest: string | null;
  manifest_digest: string | null;
  patch_digest: string | null;
  workspace_key: string;
}

interface SucceededJobRow {
  base_graph_revision: number | null;
  completed_at: string;
  id: string;
  kind: "initial-index" | "rebuild";
  legacy_schema_version: number | null;
  patch_digest: string | null;
  read_set_json: string | null;
  result_graph_revision: number | null;
  workspace_key: string;
}

/** 顶层只读 preflight 接受 absent/v1/v2/v3/v4，拒绝未来版本与未知表。 */
export function assertAd4EdgeIdentitySchemaSupported(database: Database.Database): void {
  const tables = readUserTableNames(database);
  if (!tables.includes("schema_migrations")) {
    if (tables.length > 0) {
      throw new Error("SQLite Schema 缺少受支持的 migration 元数据。");
    }
    return;
  }
  const version = readSchemaVersion(database);
  if (![1, 2, 3, 4].includes(version ?? -1)) {
    throw new Error("SQLite Schema 版本未知或未完整迁移。");
  }
  assertExactTableSet(tables);
}

/**
 * 在单个 IMMEDIATE 事务中把 absent/v1/v2/v3 收敛到 v4，并原子重键全部引用与当前摘要。
 *
 * 历史非 current succeeded Job 保留原证据；只有 meta 绑定的当前提交随真实图重新派生。
 */
export function applyAd4EdgeIdentityMigration(
  database: Database.Database,
  options: ApplyAd4EdgeIdentityMigrationOptions,
): void {
  assertAd4EdgeIdentitySchemaSupported(database);
  const migrated = database.transaction((): boolean => {
    /** 锁内重检版本，保证并发 opener 只能看到完整 v3 或完整 v4。 */
    assertAd4EdgeIdentitySchemaSupported(database);
    let version = readSchemaVersion(database);
    if (
      version === null ||
      version === BOOTSTRAP_SCHEMA_VERSION ||
      version === DETERMINISTIC_COMMIT_SCHEMA_VERSION
    ) {
      applyModuleDependencyMigration(database);
      version = readSchemaVersion(database);
    }
    if (version === AD4_EDGE_IDENTITY_SCHEMA_VERSION) {
      /**
       * store 会在绑定 current、裁剪 retention 后完整派生保留历史；这里仅做 v4
       * schema/身份/拓扑与 current 证据回验，避免在裁剪前重复扫描全部 succeeded history。
       */
      assertAd4ModuleDependencySchemaIntegrity(database);
      assertCurrentCommittedState(database, options.digestPort, "canonical", false);
      return false;
    }
    if (version !== MODULE_DEPENDENCY_SCHEMA_VERSION) {
      throw new Error("SQLite Schema 版本未知或未完整迁移。");
    }

    /** v3 必须先按旧编码 byte-for-byte 回验，禁止把损坏身份误认成迁移输入。 */
    assertModuleDependencySchemaIntegrity(database);
    assertHistoricalSucceededJobEvidence(database, options.digestPort);
    assertCurrentCommittedState(database, options.digestPort, "legacy", true);

    const edgeMappings = buildEdgeMappings(readEdgeIdentityRows(database));
    const evidenceMappings = buildEvidenceMappings(database, edgeMappings);
    createMigrationMaps(database, edgeMappings, evidenceMappings);
    if (edgeMappings.length > 0) {
      options.faultInjector?.({ entityIndex: -1, stage: "edge" });
    }
    assertNoEdgeIdCollision(database);
    assertNoEvidenceIdCollision(database);

    /** v3 外键没有 ON UPDATE；事务级延迟使 edge/Evidence/ownership 可作为一个原子集合重键。 */
    database.pragma("defer_foreign_keys = ON");
    database.exec(`
      UPDATE edges
      SET id = (SELECT new_id FROM temp.ad4_edge_rekey WHERE old_id = edges.id)
      WHERE EXISTS (SELECT 1 FROM temp.ad4_edge_rekey WHERE old_id = edges.id);

      UPDATE evidence
      SET edge_id = (
        SELECT new_id FROM temp.ad4_edge_rekey WHERE old_id = evidence.edge_id
      )
      WHERE EXISTS (SELECT 1 FROM temp.ad4_edge_rekey WHERE old_id = evidence.edge_id);

      UPDATE facts_ownership
      SET fact_id = (
        SELECT new_id FROM temp.ad4_edge_rekey WHERE old_id = facts_ownership.fact_id
      )
      WHERE fact_kind = 'edge' AND EXISTS (
        SELECT 1 FROM temp.ad4_edge_rekey WHERE old_id = facts_ownership.fact_id
      );
    `);
    if (edgeMappings.length > 0) {
      options.faultInjector?.({ entityIndex: -2, stage: "ownership" });
    }

    database.exec(`
      UPDATE evidence
      SET id = (SELECT new_id FROM temp.ad4_evidence_rekey WHERE old_id = evidence.id)
      WHERE EXISTS (SELECT 1 FROM temp.ad4_evidence_rekey WHERE old_id = evidence.id);

      UPDATE facts_ownership
      SET fact_id = (
        SELECT new_id FROM temp.ad4_evidence_rekey WHERE old_id = facts_ownership.fact_id
      )
      WHERE fact_kind = 'evidence' AND EXISTS (
        SELECT 1 FROM temp.ad4_evidence_rekey WHERE old_id = facts_ownership.fact_id
      );
    `);
    if (evidenceMappings.length > 0) {
      options.faultInjector?.({ entityIndex: -3, stage: "evidence" });
    }

    const hasCommittedWorkspaces = readCommittedWorkspaces(database).length > 0;
    migrateCurrentCommittedDigests(database, options.digestPort);
    if (hasCommittedWorkspaces) {
      options.faultInjector?.({ entityIndex: -4, stage: "metadata" });
    }
    database.prepare(`
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
    dropMigrationMaps(database);

    /** 提交前在同一快照交叉验证 schema/FK/身份/拓扑/ownership/Job/read-set/meta/digest。 */
    assertAd4EdgeIdentitySchemaIntegrity(database, options.digestPort);
    return true;
  }).immediate();
  assertAd4EdgeIdentitySchemaSupported(database);
  if (migrated) {
    assertAd4EdgeIdentitySchemaIntegrity(database, options.digestPort);
  }
}

/** v4 reopen 只执行验证，不创建表、不重键也不改写摘要。 */
export function assertAd4EdgeIdentitySchemaIntegrity(
  database: Database.Database,
  digestPort: CanonicalDigestPort,
): void {
  if (readSchemaVersion(database) !== AD4_EDGE_IDENTITY_SCHEMA_VERSION) {
    throw new Error("SQLite AD-4 schema 尚未完成 v4 migration。");
  }
  assertAd4ModuleDependencySchemaIntegrity(database);
  assertHistoricalSucceededJobEvidence(database, digestPort);
  assertCurrentCommittedState(database, digestPort, "canonical", false);
}

/** 以 readonly 集合构造旧 ID→AD-4 ID 映射，mutation 只发生在 SQLite 临时表内。 */
function buildEdgeMappings(rows: ReadonlyArray<EdgeIdentityRow>): ReadonlyArray<EdgeIdentityMapping> {
  return Object.freeze(rows.map((row) => Object.freeze({
    ...row,
    new_id: buildGraphEdgeId(
      row.workspace_key,
      row.from_id,
      row.relation_type,
      row.to_id,
      row.qualifier,
    ),
    tuple_key: JSON.stringify([
      row.workspace_key,
      row.relation_type,
      row.from_id,
      row.to_id,
      row.qualifier,
    ]),
  })));
}

/** Evidence 身份包含 edge ID，因此必须与 edge 引用在同一事务同步重算。 */
function buildEvidenceMappings(
  database: Database.Database,
  edgeMappings: ReadonlyArray<EdgeIdentityMapping>,
): ReadonlyArray<EvidenceIdentityMapping> {
  const edgeIdByOldId = new Map(edgeMappings.map((mapping) => [mapping.id, mapping.new_id]));
  const rows = database.prepare(`
    SELECT id, edge_id, provenance, analyzer_version, source_file_id,
           range_start, range_end, evidence_kind
    FROM evidence ORDER BY id
  `).all() as ReadonlyArray<EvidenceIdentityRow>;
  return Object.freeze(rows.map((row) => {
    const newEdgeId = edgeIdByOldId.get(row.edge_id);
    if (newEdgeId === undefined) {
      throw new Error("SQLite v3 Evidence 引用了未纳入 AD-4 rekey 的 edge。");
    }
    return Object.freeze({
      new_edge_id: newEdgeId,
      new_id: buildModuleEvidenceId({
        analyzerVersion: row.analyzer_version,
        edgeId: newEdgeId,
        evidenceKind: row.evidence_kind,
        normalizedRange: { end: row.range_end, start: row.range_start },
        provenance: row.provenance,
        sourceFileId: row.source_file_id,
      }),
      old_id: row.id,
    });
  }));
}

/** 临时映射不是应用表，事务结束前必须显式删除。 */
function createMigrationMaps(
  database: Database.Database,
  edges: ReadonlyArray<EdgeIdentityMapping>,
  evidence: ReadonlyArray<EvidenceIdentityMapping>,
): void {
  database.exec(`
    CREATE TEMP TABLE ad4_edge_rekey (
      old_id TEXT NOT NULL,
      new_id TEXT NOT NULL,
      tuple_key TEXT NOT NULL
    );
    CREATE TEMP TABLE ad4_evidence_rekey (
      old_id TEXT NOT NULL,
      new_id TEXT NOT NULL,
      new_edge_id TEXT NOT NULL
    );
  `);
  const insertEdge = database.prepare(`
    INSERT INTO temp.ad4_edge_rekey(old_id, new_id, tuple_key) VALUES (?, ?, ?)
  `);
  for (const mapping of edges) {
    insertEdge.run(mapping.id, mapping.new_id, mapping.tuple_key);
  }
  const insertEvidence = database.prepare(`
    INSERT INTO temp.ad4_evidence_rekey(old_id, new_id, new_edge_id) VALUES (?, ?, ?)
  `);
  for (const mapping of evidence) {
    insertEvidence.run(mapping.old_id, mapping.new_id, mapping.new_edge_id);
  }
}

/** 不同 tuple 映射到相同 AD-4 ID 时禁止 salt、覆盖或 fallback。 */
function assertNoEdgeIdCollision(database: Database.Database): void {
  const collision = database.prepare(`
    SELECT 1 AS found
    FROM temp.ad4_edge_rekey
    GROUP BY new_id
    HAVING COUNT(DISTINCT tuple_key) > 1
    LIMIT 1
  `).get();
  if (collision !== undefined) {throw new GraphEdgeIdCollisionError();}
}

/** Evidence 重键同样拒绝不同旧证据覆盖同一新主键。 */
function assertNoEvidenceIdCollision(database: Database.Database): void {
  const collision = database.prepare(`
    SELECT 1 AS found
    FROM temp.ad4_evidence_rekey
    GROUP BY new_id
    HAVING COUNT(DISTINCT old_id) > 1
    LIMIT 1
  `).get();
  if (collision !== undefined) {
    throw new Error("AD-4 migration 产生 Evidence ID 冲突，迁移已回滚。");
  }
}

/** current 提交的 target/read-set/patch/meta 必须与重键后的真实事实一起更新。 */
function migrateCurrentCommittedDigests(
  database: Database.Database,
  digestPort: CanonicalDigestPort,
): void {
  const workspaces = readCommittedWorkspaces(database);
  for (const workspace of workspaces) {
    const job = resolveCurrentCommittedJob(database, workspace, true);
    if (job.read_set_json === null) {
      assertLegacyEvidenceLessCurrent(workspace, job, database);
      continue;
    }
    const originalReadSet = parseReadSet(job.read_set_json);
    const readSet = isCompositeReadSet(originalReadSet)
      ? Object.freeze({
          ...originalReadSet,
          targetGraphDigest: deriveCurrentTargetGraphDigest(
            database,
            workspace.workspace_key,
            digestPort,
          ),
        })
      : originalReadSet;
    const patchDigest = derivePatchDigest(
      database,
      workspace.workspace_key,
      readSet,
      digestPort,
      "canonical",
    );
    const serializedReadSet = JSON.stringify(readSet);
    const readSetDigest = digestPort.digest(readSet);
    requireSingleChange(database.prepare(`
      UPDATE jobs SET read_set_json = ?, patch_digest = ?
      WHERE id = ? AND workspace_key = ? AND state = 'succeeded'
    `).run(serializedReadSet, patchDigest, job.id, workspace.workspace_key).changes);
    requireSingleChange(database.prepare(`
      UPDATE workspace SET patch_digest = ? WHERE workspace_key = ?
    `).run(patchDigest, workspace.workspace_key).changes);
    upsertMeta(database, committedReadSetDigestMetaKey(workspace.workspace_key), readSetDigest);
  }
}

/** 历史 succeeded Job 保持原字节证据，但必须在迁移前后仍可按 legacy/canonical 规则验证。 */
function assertHistoricalSucceededJobEvidence(
  database: Database.Database,
  digestPort: CanonicalDigestPort,
): void {
  const rows = database.prepare(`
    SELECT id, workspace_key, kind, completed_at, base_graph_revision,
           result_graph_revision, read_set_json, patch_digest, legacy_schema_version
    FROM jobs WHERE state = 'succeeded' ORDER BY rowid
  `).all() as ReadonlyArray<SucceededJobRow>;
  for (const row of rows) {
    if (row.legacy_schema_version === 1) {
      const validLegacyRevision = row.kind === "initial-index"
        ? row.base_graph_revision === null
        : row.base_graph_revision === 1;
      if (
        row.read_set_json !== null ||
        row.patch_digest !== null ||
        row.result_graph_revision !== 1 ||
        !validLegacyRevision
      ) {
        throw new Error("legacy schema-v1 succeeded Job 携带了伪造提交证据。");
      }
      continue;
    }
    if (row.read_set_json === null || row.patch_digest === null) {
      throw new Error("非 legacy succeeded Job 缺少 read-set 或 patch digest。");
    }
    const readSet = parseReadSet(row.read_set_json);
    assertReadSetSemanticDigests(readSet, digestPort);
    const canonicalPatch = derivePatchDigest(
      database,
      row.workspace_key,
      readSet,
      digestPort,
      "canonical",
    );
    const legacyPatch = isCompositeReadSet(readSet)
      ? canonicalPatch
      : derivePatchDigest(database, row.workspace_key, readSet, digestPort, "legacy");
    if (row.patch_digest !== canonicalPatch && row.patch_digest !== legacyPatch) {
      throw new Error("历史 succeeded Job 的 patch/read-set 证据无法重新派生。");
    }
    assertSucceededJobCasContract(row, readSet);
  }
}

/** succeeded Job 的逻辑 base、最终 CAS base 与 result revision 必须保持同一 attempt 合同。 */
function assertSucceededJobCasContract(
  row: SucceededJobRow,
  readSet: HierarchyReadSetV1 | CompositeGraphReadSetV1,
): void {
  if (
    (row.base_graph_revision !== null && !isPositiveSafeInteger(row.base_graph_revision)) ||
    !isPositiveSafeInteger(row.result_graph_revision)
  ) {
    throw new Error("历史 succeeded Job 的 revision 字段不合法。");
  }
  const attemptBase = readSet.baseGraphRevision;
  const kindMatchesAttempt = row.kind === "initial-index"
    ? attemptBase === null && row.result_graph_revision === 1
    : attemptBase !== null;
  const logicalBasePrecedesAttempt = row.base_graph_revision === null
    ? row.kind === "initial-index" && attemptBase === null
    : attemptBase !== null && row.base_graph_revision <= attemptBase;
  const resultMatchesAttempt = attemptBase === null
    ? row.result_graph_revision === 1
    : row.result_graph_revision === attemptBase || row.result_graph_revision === attemptBase + 1;
  if (!kindMatchesAttempt || !logicalBasePrecedesAttempt || !resultMatchesAttempt) {
    throw new Error("历史 succeeded Job 与最终 CAS read-set revision 不一致。");
  }
}

/** current 绑定、workspace 摘要、真实目标图和 read-set digest 必须完全交叉一致。 */
function assertCurrentCommittedState(
  database: Database.Database,
  digestPort: CanonicalDigestPort,
  identity: "canonical" | "legacy",
  allowLegacyBindingBackfill: boolean,
): void {
  for (const workspace of readCommittedWorkspaces(database)) {
    const job = resolveCurrentCommittedJob(database, workspace, allowLegacyBindingBackfill);
    if (job.result_graph_revision !== workspace.graph_revision || job.completed_at !== workspace.committed_at) {
      throw new Error("current succeeded Job 与 workspace revision/timestamp 不一致。");
    }
    if (job.read_set_json === null) {
      assertLegacyEvidenceLessCurrent(workspace, job, database);
      continue;
    }
    if (job.patch_digest === null || workspace.patch_digest !== job.patch_digest ||
      job.legacy_schema_version !== null) {
      throw new Error("current succeeded Job 与 workspace patch 证据不一致。");
    }
    const readSet = parseReadSet(job.read_set_json);
    assertReadSetSemanticDigests(readSet, digestPort);
    if (
      workspace.manifest_digest !== readSet.manifestDigest ||
      workspace.input_digest !== readSet.inputDigest ||
      workspace.config_digest !== readSet.configDigest ||
      workspace.effective_ignore_digest !== readSet.effectiveIgnoreSnapshot.effectiveDigest
    ) {
      throw new Error("current read-set 与 workspace committed 摘要不一致。");
    }
    if (isCompositeReadSet(readSet)) {
      const actualTarget = deriveCurrentTargetGraphDigest(
        database,
        workspace.workspace_key,
        digestPort,
      );
      if (actualTarget !== readSet.targetGraphDigest) {
        throw new Error("current targetGraphDigest 与真实图事实不一致。");
      }
    }
    const derivedPatch = derivePatchDigest(
      database,
      workspace.workspace_key,
      readSet,
      digestPort,
      identity,
    );
    const persistedReadSetDigest = readMetaValue(
      database,
      committedReadSetDigestMetaKey(workspace.workspace_key),
    );
    if (
      derivedPatch !== job.patch_digest ||
      persistedReadSetDigest !== digestPort.digest(readSet)
    ) {
      throw new Error("current Job/read-set/meta digest 无法从规范语义重新派生。");
    }
  }
}

/** schema-v1 current 只允许迁移真实 edge，不得补造 read-set 或 patch 证据。 */
function assertLegacyEvidenceLessCurrent(
  workspace: WorkspaceCommitRow,
  job: SucceededJobRow,
  database: Database.Database,
): void {
  if (
    job.legacy_schema_version !== 1 ||
    job.patch_digest !== null ||
    workspace.patch_digest !== null ||
    readMetaValue(database, committedReadSetDigestMetaKey(workspace.workspace_key)) !== null
  ) {
    throw new Error("legacy schema-v1 current Job 不得伪造 read-set/patch/meta 证据。");
  }
}

/** hierarchy 与 composite 使用各自冻结的 patch digest 预像。 */
function derivePatchDigest(
  database: Database.Database,
  workspaceKey: string,
  readSet: HierarchyReadSetV1 | CompositeGraphReadSetV1,
  digestPort: CanonicalDigestPort,
  identity: "canonical" | "legacy",
): string {
  if (isCompositeReadSet(readSet)) {
    return digestPort.digest({
      configDigest: readSet.configDigest,
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      targetGraphDigest: readSet.targetGraphDigest,
      version: 1,
    });
  }
  const graph = buildHierarchyGraph(workspaceKey, readSet.manifest.map((entry) => entry.path));
  const edges = graph.edges.map((edge) => identity === "canonical" ? edge : Object.freeze({
    ...edge,
    id: buildLegacyGraphEdgeIdV0(
      workspaceKey,
      edge.fromId,
      edge.relationType,
      edge.toId,
      edge.qualifier,
    ),
  })).sort(compareById);
  return digestPort.digest({
    configDigest: readSet.configDigest,
    coverage: "complete",
    edges,
    inputDigest: readSet.inputDigest,
    manifestDigest: readSet.manifestDigest,
    nodes: [...graph.nodes].sort(compareById),
    ownershipSliceId: hierarchyOwnershipSliceId(workspaceKey),
    producerKind: HIERARCHY_PRODUCER_KIND,
    producerVersion: HIERARCHY_PRODUCER_VERSION,
  });
}

/** composite 目标摘要按节点、AD-4 edge、无 detectedAt Evidence 与 ownership 独立重算。 */
function deriveCurrentTargetGraphDigest(
  database: Database.Database,
  workspaceKey: string,
  digestPort: CanonicalDigestPort,
): string {
  const nodes = (database.prepare(`
    SELECT id, kind, relative_path, payload_json FROM nodes WHERE workspace_key = ?
  `).all(workspaceKey) as ReadonlyArray<{
    id: string;
    kind: GraphNodeV1["kind"];
    payload_json: string;
    relative_path: string | null;
  }>).map(mapGraphNode).sort(compareById);
  const edges = (database.prepare(`
    SELECT id, from_id, relation_type, to_id, qualifier
    FROM edges WHERE workspace_key = ?
  `).all(workspaceKey) as ReadonlyArray<{
    from_id: string;
    id: string;
    qualifier: string;
    relation_type: GraphRelationType;
    to_id: string;
  }>).map((row) => Object.freeze({
    fromId: row.from_id,
    id: row.id,
    qualifier: row.qualifier,
    relationType: row.relation_type,
    toId: row.to_id,
  }) as GraphEdgeV1).sort(compareById);
  const evidence = (database.prepare(`
    SELECT id, edge_id, provenance, analyzer_version, source_file_id,
           range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
    FROM evidence WHERE workspace_key = ?
  `).all(workspaceKey) as ReadonlyArray<{
    analyzer_version: string;
    confidence: ModuleEvidenceV1["confidence"];
    detected_at: string;
    edge_id: string;
    evidence_kind: "module-dependency";
    id: string;
    language: ModuleEvidenceV1["language"];
    payload_json: string;
    provenance: "typescript-compiler-api";
    range_end: number;
    range_start: number;
    source_file_id: string;
  }>).map(mapEvidenceWithoutDetectedAt).sort(compareById);
  const ownership = (database.prepare(`
    SELECT fact_id, fact_kind, owner_key
    FROM facts_ownership WHERE workspace_key = ?
  `).all(workspaceKey) as ReadonlyArray<{
    fact_id: string;
    fact_kind: "edge" | "evidence" | "node";
    owner_key: string;
  }>).map((row) => ({
    factId: row.fact_id,
    factKind: row.fact_kind,
    ownerKey: row.owner_key,
  })).sort(compareOwnership);
  return digestPort.digest({ edges, evidence, nodes, ownership, version: 1 });
}

/** 节点 payload 必须恢复为与 application builder 相同的领域对象形状。 */
function mapGraphNode(row: {
  id: string;
  kind: GraphNodeV1["kind"];
  payload_json: string;
  relative_path: string | null;
}): GraphNodeV1 {
  if (row.kind === "workspace" || row.kind === "directory" || row.kind === "file") {
    if (row.relative_path === null || row.payload_json !== "{}") {
      throw new Error("hierarchy node payload 不规范。");
    }
    return Object.freeze({ id: row.id, kind: row.kind, relativePath: row.relative_path });
  }
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (row.kind === "external-package") {
    if (typeof payload.packageName !== "string") {
      throw new Error("external-package payload 不完整。");
    }
    const node = payload.versionState === "resolved" && typeof payload.packageVersion === "string"
      ? createExternalPackageNode(payload.packageName, payload.packageVersion)
      : payload.versionState === "unresolved" && payload.packageVersion === null
        ? createUnresolvedExternalPackageNode(payload.packageName)
        : undefined;
    if (node === undefined || node.id !== row.id) {
      throw new Error("external-package payload 与 ID 不一致。");
    }
    return node;
  }
  if (typeof payload.moduleName !== "string") {
    throw new Error("node-builtin payload 不完整。");
  }
  const node = createNodeBuiltinNode(payload.moduleName);
  if (node.id !== row.id) {throw new Error("node-builtin payload 与 ID 不一致。");}
  return node;
}

/** detectedAt 是观察元数据，不进入 targetGraphDigest。 */
function mapEvidenceWithoutDetectedAt(row: {
  analyzer_version: string;
  confidence: ModuleEvidenceV1["confidence"];
  detected_at: string;
  edge_id: string;
  evidence_kind: "module-dependency";
  id: string;
  language: ModuleEvidenceV1["language"];
  payload_json: string;
  provenance: "typescript-compiler-api";
  range_end: number;
  range_start: number;
  source_file_id: string;
}): Omit<ModuleEvidenceV1, "detectedAt"> {
  if (row.payload_json !== "{}") {throw new Error("Evidence payload_json 不规范。");}
  return Object.freeze({
    analyzerVersion: row.analyzer_version,
    confidence: row.confidence,
    edgeId: row.edge_id,
    evidenceKind: row.evidence_kind,
    id: row.id,
    language: row.language,
    normalizedRange: Object.freeze({ end: row.range_end, start: row.range_start }),
    provenance: row.provenance,
    sourceFileId: row.source_file_id,
  });
}

/** read-set 自身的 manifest/input/config 摘要必须可独立重算。 */
function assertReadSetSemanticDigests(
  readSet: HierarchyReadSetV1 | CompositeGraphReadSetV1,
  digestPort: CanonicalDigestPort,
): void {
  const manifestDigest = digestPort.digest(readSet.manifest);
  const inputDigest = isCompositeReadSet(readSet)
    ? digestPort.digest({
        analyzerKind: readSet.analyzerConfigSnapshot.analyzerKind,
        configDigest: readSet.configDigest,
        inputs: readSet.manifest,
        version: 1,
      })
    : digestPort.digest({ manifest: readSet.manifest });
  const configDigest = isCompositeReadSet(readSet)
    ? digestPort.digest(readSet.analyzerConfigSnapshot)
    : digestPort.digest({
        ignore: {
          effectiveDigest: readSet.effectiveIgnoreSnapshot.effectiveDigest,
          version: readSet.effectiveIgnoreSnapshot.version,
        },
        producer: { kind: HIERARCHY_PRODUCER_KIND, version: HIERARCHY_PRODUCER_VERSION },
      });
  if (
    manifestDigest !== readSet.manifestDigest ||
    inputDigest !== readSet.inputDigest ||
    configDigest !== readSet.configDigest
  ) {
    throw new Error("succeeded Job read-set 的语义摘要不一致。");
  }
}

/**
 * 在任何临时映射或持久 mutation 前，按 store 恢复路径的同等强度验证完整 read-set。
 */
function parseReadSet(serialized: string): HierarchyReadSetV1 | CompositeGraphReadSetV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("持久化 Job read-set JSON 无法解析。", { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.manifest) ||
    !isRecord(value.effectiveIgnoreSnapshot)) {
    throw new Error("持久化 Job read-set 形状不完整。");
  }
  const ignore = value.effectiveIgnoreSnapshot;
  const manifest = value.manifest;
  if (
    (value.baseGraphRevision !== null && !isPositiveSafeInteger(value.baseGraphRevision)) ||
    !isNonNegativeSafeInteger(value.bootstrapGeneration) ||
    !isSha256(value.configDigest) ||
    !isSha256(value.inputDigest) ||
    !isSha256(value.manifestDigest) ||
    typeof value.statusEpoch !== "string" ||
    value.statusEpoch.length === 0 ||
    ignore.builtinRulesVersion !== "builtin-ignore-v1" ||
    (ignore.contentHash !== null && !isSha256(ignore.contentHash)) ||
    !isSha256(ignore.effectiveDigest) ||
    !Array.isArray(ignore.effectiveRules) ||
    !ignore.effectiveRules.every((rule) => typeof rule === "string") ||
    !isNonNegativeSafeInteger(ignore.generation) ||
    !isSha256(ignore.lastValidDigest) ||
    !Array.isArray(ignore.userRules) ||
    !ignore.userRules.every((rule) => typeof rule === "string") ||
    ignore.validity !== "valid" ||
    ignore.version !== 1
  ) {
    throw new Error("持久化 Job read-set 字段不合法。");
  }
  let previousPath: string | null = null;
  for (const entry of manifest) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      !isSha256(entry.contentHash) ||
      (previousPath !== null && previousPath >= entry.path)
    ) {
      throw new Error("持久化 Job manifest 未按规范路径唯一排序。");
    }
    previousPath = entry.path;
  }
  const hasCompositeDigest = "targetGraphDigest" in value;
  const hasAnalyzerSnapshot = "analyzerConfigSnapshot" in value;
  const hasAnalyzerFenceSnapshot = "analyzerConfigFenceSnapshot" in value;
  if (
    hasCompositeDigest !== hasAnalyzerSnapshot ||
    hasCompositeDigest !== hasAnalyzerFenceSnapshot
  ) {
    throw new Error("持久化 composite read-set 缺少 Analyzer 语义、fence 或目标图摘要。");
  }
  if (hasCompositeDigest) {
    if (!isSha256(value.targetGraphDigest)) {
      throw new Error("持久化 composite 目标图摘要不合法。");
    }
    validatePersistedAnalyzerConfigSnapshot(
      value.analyzerConfigSnapshot,
      ignore.effectiveDigest as string,
    );
    validatePersistedAnalyzerConfigFenceSnapshot(
      value.analyzerConfigFenceSnapshot,
      value.analyzerConfigSnapshot as AnalyzerConfigSnapshotV1,
    );
  }
  return value as unknown as HierarchyReadSetV1 | CompositeGraphReadSetV1;
}

/** 持久 Analyzer 快照必须保持封闭字段、规范排序与 effective ignore 绑定。 */
function validatePersistedAnalyzerConfigSnapshot(
  snapshot: unknown,
  effectiveIgnoreDigest: string,
): asserts snapshot is AnalyzerConfigSnapshotV1 {
  if (
    !isRecord(snapshot) ||
    snapshot.version !== 1 ||
    snapshot.analyzerKind !== "typescript" ||
    !hasExactObjectKeys(snapshot, [
      "analyzerKind",
      "analyzerVersion",
      "consultedFiles",
      "effectiveCompilerOptions",
      "effectiveIgnore",
      "version",
      "workspacePackages",
    ]) ||
    typeof snapshot.analyzerVersion !== "string" ||
    snapshot.analyzerVersion.length === 0 ||
    !isRecord(snapshot.effectiveCompilerOptions) ||
    !isRecord(snapshot.effectiveIgnore) ||
    snapshot.effectiveIgnore.version !== 1 ||
    snapshot.effectiveIgnore.effectiveDigest !== effectiveIgnoreDigest ||
    !Array.isArray(snapshot.consultedFiles) ||
    !Array.isArray(snapshot.workspacePackages)
  ) {
    throw new Error("持久化 AnalyzerConfigSnapshotV1 形状不合法。");
  }
  assertSortedDigestPaths(snapshot.consultedFiles, "consultedFiles");
  if (snapshot.consultedFiles.some((entry) =>
    isReservedAnalyzerRulesPath((entry as { path: string }).path))) {
    throw new Error("持久化 AnalyzerConfigSnapshotV1 不得包含 rules.yaml。");
  }
  let previousRoot: string | null = null;
  for (const entry of snapshot.workspacePackages) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      typeof entry.root !== "string" ||
      entry.root.length === 0 ||
      (previousRoot !== null && previousRoot >= entry.root)
    ) {
      throw new Error("持久化 workspacePackages 未按规范 root 唯一排序。");
    }
    previousRoot = entry.root;
  }
}

/** 持久 fence 快照保持封闭字段、规范排序及与语义快照的路径集合互斥。 */
function validatePersistedAnalyzerConfigFenceSnapshot(
  fenceSnapshot: unknown,
  snapshot: AnalyzerConfigSnapshotV1,
): asserts fenceSnapshot is AnalyzerConfigFenceSnapshotV1 {
  if (
    !isRecord(fenceSnapshot) ||
    fenceSnapshot.version !== 1 ||
    !hasExactObjectKeys(fenceSnapshot, [
      "absentFiles",
      "absentResolutionFiles",
      "blockedResolutionFiles",
      "version",
    ]) ||
    !Array.isArray(fenceSnapshot.absentFiles) ||
    !Array.isArray(fenceSnapshot.absentResolutionFiles) ||
    !Array.isArray(fenceSnapshot.blockedResolutionFiles)
  ) {
    throw new Error("持久化 AnalyzerConfigFenceSnapshotV1 形状不合法。");
  }
  assertSortedDigestPaths(fenceSnapshot.blockedResolutionFiles, "blockedResolutionFiles");
  const existingPaths = new Set(snapshot.consultedFiles.map((entry) => entry.path));
  for (const entry of fenceSnapshot.blockedResolutionFiles) {
    const blockedPath = (entry as { path: string }).path;
    if (existingPaths.has(blockedPath)) {
      throw new Error("持久化 Analyzer existing/blocked 路径集合不互斥。");
    }
    existingPaths.add(blockedPath);
  }
  const absentPaths = new Set<string>();
  for (const [label, entries] of [
    ["absentFiles", fenceSnapshot.absentFiles],
    ["absentResolutionFiles", fenceSnapshot.absentResolutionFiles],
  ] as const) {
    let previousAbsentPath: string | null = null;
    for (const absentPath of entries) {
      if (
        typeof absentPath !== "string" ||
        absentPath.length === 0 ||
        (previousAbsentPath !== null && previousAbsentPath >= absentPath) ||
        existingPaths.has(absentPath) ||
        absentPaths.has(absentPath)
      ) {
        throw new Error(`持久化 Analyzer ${label} 未按规范路径唯一排序。`);
      }
      absentPaths.add(absentPath);
      previousAbsentPath = absentPath;
    }
  }
  if ([...existingPaths, ...absentPaths].some(isReservedAnalyzerRulesPath)) {
    throw new Error("持久化 AnalyzerConfigFenceSnapshotV1 不得包含 rules.yaml。");
  }
}

/** 持久协议对象拒绝额外字段，防止 fence 状态漂入语义摘要。 */
function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort(compareCanonicalGraphText)) ===
    JSON.stringify([...expected].sort(compareCanonicalGraphText));
}

/** rules.yaml 由后续规则 Story 独占，不得进入 Analyzer 语义或 fence 快照。 */
function isReservedAnalyzerRulesPath(logicalPath: string): boolean {
  return logicalPath.split("/").at(-1)?.toLowerCase() === "rules.yaml";
}

/** 配置文件集合必须按 path 唯一排序并携带 SHA-256。 */
function assertSortedDigestPaths(entries: readonly unknown[], label: string): void {
  let previousPath: string | null = null;
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      !isSha256(entry.contentHash) ||
      (previousPath !== null && previousPath >= entry.path)
    ) {
      throw new Error(`持久化 ${label} 未按规范 path 唯一排序。`);
    }
    previousPath = entry.path;
  }
}

/** v3/v4 都允许从 meta 缺失的旧库按最新 succeeded+completedAt 唯一回填 current 绑定。 */
function resolveCurrentCommittedJob(
  database: Database.Database,
  workspace: WorkspaceCommitRow,
  allowLegacyBindingBackfill: boolean,
): SucceededJobRow {
  const metaKey = committedJobMetaKey(workspace.workspace_key);
  let jobId = readMetaValue(database, metaKey);
  if (jobId === null) {
    if (!allowLegacyBindingBackfill) {
      throw new Error("v4 current 提交缺少 committed Job meta 绑定。");
    }
    const latest = database.prepare(`
      SELECT id, workspace_key, kind, completed_at, base_graph_revision,
             result_graph_revision, read_set_json, patch_digest, legacy_schema_version
      FROM jobs WHERE workspace_key = ? AND state = 'succeeded'
      ORDER BY rowid DESC LIMIT 1
    `).get(workspace.workspace_key) as SucceededJobRow | undefined;
    if (latest === undefined || latest.completed_at !== workspace.committed_at) {
      throw new Error("旧版持久提交缺少可唯一绑定的 current succeeded Job。");
    }
    jobId = latest.id;
    upsertMeta(database, metaKey, jobId);
  }
  const job = database.prepare(`
    SELECT id, workspace_key, kind, completed_at, base_graph_revision,
           result_graph_revision, read_set_json, patch_digest, legacy_schema_version
    FROM jobs WHERE id = ? AND workspace_key = ? AND state = 'succeeded'
  `).get(jobId, workspace.workspace_key) as SucceededJobRow | undefined;
  if (job === undefined) {throw new Error("committed Job meta 指向不存在的 succeeded Job。");}
  return job;
}

function readCommittedWorkspaces(database: Database.Database): ReadonlyArray<WorkspaceCommitRow> {
  return database.prepare(`
    SELECT workspace_key, committed_at, graph_revision, manifest_digest, input_digest,
           config_digest, effective_ignore_digest, patch_digest
    FROM workspace WHERE committed_at IS NOT NULL ORDER BY workspace_key
  `).all() as ReadonlyArray<WorkspaceCommitRow>;
}

function readEdgeIdentityRows(database: Database.Database): ReadonlyArray<EdgeIdentityRow> {
  return database.prepare(`
    SELECT id, workspace_key, from_id, relation_type, to_id, qualifier
    FROM edges ORDER BY workspace_key, relation_type, from_id, to_id, qualifier
  `).all() as ReadonlyArray<EdgeIdentityRow>;
}

function dropMigrationMaps(database: Database.Database): void {
  database.exec(`DROP TABLE temp.ad4_evidence_rekey; DROP TABLE temp.ad4_edge_rekey;`);
}

function hierarchyOwnershipSliceId(workspaceKey: string): string {
  return `hierarchy:${buildGraphEntityId(workspaceKey, "workspace", "")}`;
}

function committedJobMetaKey(workspaceKey: string): string {
  return `bootstrap-committed-job:${workspaceKey}`;
}

function committedReadSetDigestMetaKey(workspaceKey: string): string {
  return `bootstrap-committed-read-set-digest:${workspaceKey}`;
}

function readMetaValue(database: Database.Database, key: string): string | null {
  return (database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    { value: string } | undefined)?.value ?? null;
}

function upsertMeta(database: Database.Database, key: string, value: string): void {
  database.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function requireSingleChange(changes: number): void {
  if (changes !== 1) {throw new Error("SQLite v4 current 摘要更新未命中唯一行。");}
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareOwnership(
  left: { factId: string; factKind: string; ownerKey: string },
  right: { factId: string; factKind: string; ownerKey: string },
): number {
  return left.factKind < right.factKind ? -1 : left.factKind > right.factKind ? 1 :
    left.factId < right.factId ? -1 : left.factId > right.factId ? 1 :
      left.ownerKey < right.ownerKey ? -1 : left.ownerKey > right.ownerKey ? 1 : 0;
}

function isCompositeReadSet(
  readSet: HierarchyReadSetV1 | CompositeGraphReadSetV1,
): readSet is CompositeGraphReadSetV1 & {
  analyzerConfigFenceSnapshot: AnalyzerConfigFenceSnapshotV1;
  analyzerConfigSnapshot: AnalyzerConfigSnapshotV1;
} {
  return "targetGraphDigest" in readSet && "analyzerConfigSnapshot" in readSet &&
    "analyzerConfigFenceSnapshot" in readSet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function readSchemaVersion(database: Database.Database): number | null {
  if (!readUserTableNames(database).includes("schema_migrations")) {return null;}
  return (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    { version: number | null }).version;
}

function assertExactTableSet(actual: readonly string[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(AD4_EDGE_IDENTITY_TABLE_NAMES)) {
    throw new Error("SQLite 用户表集合不符合 AD-4 migration v4 八表合同。");
  }
}

function readUserTableNames(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as ReadonlyArray<{ name: string }>).map((row) => row.name);
}
