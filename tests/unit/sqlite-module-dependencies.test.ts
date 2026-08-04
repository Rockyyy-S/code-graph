import { createRequire } from "node:module";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCompositeGraphPatch,
  buildHierarchyFactBatch,
  buildHierarchyGraph,
  buildModuleSourceFactBatch,
  createAnalyzerConfigFenceSnapshot,
  createAnalyzerConfigSnapshot,
  createAnalyzerInputDigest,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import {
  buildGraphEntityId,
  buildLegacyGraphEdgeIdV0,
  buildModuleEvidenceId,
  type HierarchyReadSetV1,
} from "../../packages/domain/src/index.js";
import {
  AD4_EDGE_IDENTITY_SCHEMA_VERSION,
  applyBootstrapMigration,
  applyAd4EdgeIdentityMigration,
  applyDeterministicCommitMigration,
  applyModuleDependencyMigration,
  assertAd4ModuleDependencySchemaIntegrity,
  assertModuleDependencySchemaIntegrity,
  GraphEdgeIdCollisionError,
  MODULE_DEPENDENCY_SCHEMA_VERSION,
  openSqliteGraphStore,
} from "../../packages/adapters/store-sqlite/src/index.js";
import {
  extractCheckExpressions,
} from "../../packages/adapters/store-sqlite/src/migrations/003-module-dependencies.js";

const roots: string[] = [];
const workspaceKey = "e".repeat(64);
const digestPort = { digest: sha256CanonicalJson };
const requireFromStorePackage = createRequire(
  path.resolve("packages/adapters/store-sqlite/package.json"),
);

/** 测试迁移锁与精确 Schema 所需的最小原生 SQLite 连接。 */
interface RawSqliteDatabase {
  close: () => void;
  exec: (source: string) => RawSqliteDatabase;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  prepare: (source: string) => {
    all: (...parameters: unknown[]) => unknown[];
    get: (...parameters: unknown[]) => unknown;
    run: (...parameters: unknown[]) => unknown;
  };
  transaction: (callback: () => void) => {
    (): void;
    immediate: () => void;
  };
}

/** 从 store-sqlite 自身依赖边界解析原生 SQLite 构造器。 */
interface RawSqliteConstructor {
  new (databasePath: string, options?: { readonly?: boolean }): RawSqliteDatabase;
}

const RawSqlite = requireFromStorePackage("better-sqlite3") as RawSqliteConstructor;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建真实 SQLite 文件路径。 */
async function createDatabasePath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-module-sqlite-"));
  roots.push(root);
  return path.join(root, "graph.sqlite");
}

/** 构造带 current composite 证据的真实 v3 数据库，供 v4 rekey/恢复测试复用。 */
async function seedLegacyV3CompositeDatabase(databasePath: string): Promise<{
  canonicalEdgeIds: readonly string[];
  canonicalEvidenceIds: readonly string[];
  canonicalPatchDigest: string;
  canonicalReadSetDigest: string;
  canonicalTargetGraphDigest: string;
  historicalPatchDigest: string;
  historicalReadSetJson: string;
  legacyEdgeIds: readonly string[];
  legacyEvidenceIds: readonly string[];
  legacyTargetGraphDigest: string;
}> {
  const emptySnapshot = {
    allEdges: [],
    allEvidence: [],
    allNodes: [],
    committedReadSet: null,
    graphRevision: null,
    ownedEdges: [],
    ownedNodes: [],
    ownedSlices: [],
    ownershipSliceId: `hierarchy:${buildGraphEntityId(workspaceKey, "workspace", "")}`,
    patchDigest: null,
  } as const;
  const patch = createPatch(emptySnapshot, "2026-07-27T00:00:00.000Z");
  const hierarchySlice = patch.slices.find((slice) =>
    slice.ownershipSliceId.startsWith("hierarchy:"));
  const sourceSlice = patch.slices.find((slice) =>
    slice.ownershipSliceId.startsWith("source:typescript:"));
  if (hierarchySlice === undefined || sourceSlice === undefined) {
    throw new Error("legacy v3 fixture 缺少 hierarchy/source slice。");
  }
  const canonicalEdges = [...hierarchySlice.edgeUpserts, ...patch.sharedEdgeUpserts]
    .sort((left, right) => left.id.localeCompare(right.id));
  const legacyEdges = canonicalEdges.map((edge) => Object.freeze({
    ...edge,
    id: buildLegacyGraphEdgeIdV0(
      workspaceKey,
      edge.fromId,
      edge.relationType,
      edge.toId,
      edge.qualifier,
    ),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const legacyEdgeIdByCanonical = new Map(canonicalEdges.map((edge) => [
    edge.id,
    buildLegacyGraphEdgeIdV0(
      workspaceKey,
      edge.fromId,
      edge.relationType,
      edge.toId,
      edge.qualifier,
    ),
  ]));
  const legacyEvidence = sourceSlice.evidenceUpserts.map((item) => {
    const edgeId = legacyEdgeIdByCanonical.get(item.edgeId);
    if (edgeId === undefined) {throw new Error("legacy Evidence 缺少 edge 映射。");}
    return Object.freeze({
      ...item,
      edgeId,
      id: buildModuleEvidenceId({
        analyzerVersion: item.analyzerVersion,
        edgeId,
        evidenceKind: item.evidenceKind,
        normalizedRange: item.normalizedRange,
        provenance: item.provenance,
        sourceFileId: item.sourceFileId,
      }),
    });
  });
  const nodes = [...hierarchySlice.nodeUpserts, ...patch.sharedNodeUpserts]
    .sort((left, right) => left.id.localeCompare(right.id));
  const ownership = [
    ...hierarchySlice.nodeUpserts.map((node) => ({
      factId: node.id,
      factKind: "node" as const,
      ownerKey: hierarchySlice.ownershipSliceId,
    })),
    ...legacyEdges.filter((edge) => edge.relationType === "contains").map((edge) => ({
      factId: edge.id,
      factKind: "edge" as const,
      ownerKey: hierarchySlice.ownershipSliceId,
    })),
    ...legacyEvidence.map((item) => ({
      factId: item.id,
      factKind: "evidence" as const,
      ownerKey: sourceSlice.ownershipSliceId,
    })),
  ].sort((left, right) => left.factKind.localeCompare(right.factKind) ||
    left.factId.localeCompare(right.factId) || left.ownerKey.localeCompare(right.ownerKey));
  const targetGraphDigest = sha256CanonicalJson({
    edges: legacyEdges,
    evidence: legacyEvidence.map(({ detectedAt: _detectedAt, ...semantic }) => semantic),
    nodes,
    ownership,
    version: 1,
  });
  const readSet = Object.freeze({ ...patch.readSet, targetGraphDigest });
  const patchDigest = sha256CanonicalJson({
    configDigest: readSet.configDigest,
    inputDigest: readSet.inputDigest,
    manifestDigest: readSet.manifestDigest,
    targetGraphDigest,
    version: 1,
  });

  const database = new RawSqlite(databasePath);
  applyModuleDependencyMigration(database as never);
  database.pragma("foreign_keys = ON");
  database.prepare(`
    INSERT INTO workspace(
      workspace_key, committed_at, indexed_file_count, node_count, edge_count,
      excluded_path_count, builtin_rules_version, graph_revision, freshness, completeness,
      manifest_digest, input_digest, config_digest, effective_ignore_digest, patch_digest
    ) VALUES (?, ?, 1, ?, ?, 0, 'builtin-ignore-v1', 1, 'current', 'complete', ?, ?, ?, ?, ?)
  `).run(
    workspaceKey,
    "2026-07-27T00:00:01.000Z",
    nodes.length,
    legacyEdges.length,
    readSet.manifestDigest,
    readSet.inputDigest,
    readSet.configDigest,
    readSet.effectiveIgnoreSnapshot.effectiveDigest,
    patchDigest,
  );
  const insertNode = database.prepare(`
    INSERT INTO nodes(id, workspace_key, kind, relative_path, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const node of nodes) {
    const relativePath = "relativePath" in node ? node.relativePath : null;
    const payload = node.kind === "external-package"
      ? JSON.stringify({
          packageName: node.packageName,
          packageVersion: node.packageVersion,
          versionState: node.versionState,
        })
      : node.kind === "node-builtin"
        ? JSON.stringify({ moduleName: node.moduleName })
        : "{}";
    insertNode.run(node.id, workspaceKey, node.kind, relativePath, payload);
  }
  const insertEdge = database.prepare(`
    INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const edge of legacyEdges) {
    insertEdge.run(edge.id, workspaceKey, edge.fromId, edge.relationType, edge.toId, edge.qualifier);
  }
  const insertEvidence = database.prepare(`
    INSERT INTO evidence(
      id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
      range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
  `);
  for (const item of legacyEvidence) {
    insertEvidence.run(
      item.id,
      workspaceKey,
      item.edgeId,
      item.provenance,
      item.analyzerVersion,
      item.sourceFileId,
      item.normalizedRange.start,
      item.normalizedRange.end,
      item.evidenceKind,
      item.confidence,
      item.language,
      item.detectedAt,
    );
  }
  const insertOwnership = database.prepare(`
    INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
    VALUES (?, ?, ?, ?)
  `);
  for (const item of ownership) {
    insertOwnership.run(item.factKind, item.factId, item.ownerKey, workspaceKey);
  }
  const historicalReadSetJson = JSON.stringify(readSet, null, 2);
  const insertSucceededJob = database.prepare(`
    INSERT INTO jobs(
      id, workspace_key, kind, state, requested_at, started_at, completed_at,
      base_graph_revision, result_graph_revision, read_set_json, patch_digest
    ) VALUES (?, ?, 'initial-index', 'succeeded', ?, ?, ?, NULL, 1, ?, ?)
  `);
  insertSucceededJob.run(
    "legacy-v3-historical",
    workspaceKey,
    "2026-07-26T23:59:57.000Z",
    "2026-07-26T23:59:58.000Z",
    "2026-07-26T23:59:59.000Z",
    historicalReadSetJson,
    patchDigest,
  );
  insertSucceededJob.run(
    "legacy-v3-current",
    workspaceKey,
    "2026-07-27T00:00:00.000Z",
    "2026-07-27T00:00:00.000Z",
    "2026-07-27T00:00:01.000Z",
    JSON.stringify(readSet),
    patchDigest,
  );
  database.prepare("INSERT INTO meta(key, value) VALUES (?, ?), (?, ?)").run(
    `bootstrap-committed-job:${workspaceKey}`,
    "legacy-v3-current",
    `bootstrap-committed-read-set-digest:${workspaceKey}`,
    sha256CanonicalJson(readSet),
  );
  database.close();
  return {
    canonicalEdgeIds: Object.freeze(canonicalEdges.map((edge) => edge.id)),
    canonicalEvidenceIds: Object.freeze(sourceSlice.evidenceUpserts.map((item) => item.id)),
    canonicalPatchDigest: patch.patchDigest,
    canonicalReadSetDigest: sha256CanonicalJson(patch.readSet),
    canonicalTargetGraphDigest: patch.readSet.targetGraphDigest,
    historicalPatchDigest: patchDigest,
    historicalReadSetJson,
    legacyEdgeIds: Object.freeze(legacyEdges.map((edge) => edge.id)),
    legacyEvidenceIds: Object.freeze(legacyEvidence.map((item) => item.id)),
    legacyTargetGraphDigest: targetGraphDigest,
  };
}

/** 读取 migration 必须保持的八表应用状态，供 rollback 与幂等性逐字比较。 */
function readApplicationState(database: RawSqliteDatabase): Record<string, unknown[]> {
  return {
    edges: database.prepare("SELECT * FROM edges ORDER BY rowid").all(),
    evidence: database.prepare("SELECT * FROM evidence ORDER BY rowid").all(),
    facts_ownership: database.prepare("SELECT * FROM facts_ownership ORDER BY rowid").all(),
    jobs: database.prepare("SELECT * FROM jobs ORDER BY rowid").all(),
    meta: database.prepare("SELECT * FROM meta ORDER BY rowid").all(),
    nodes: database.prepare("SELECT * FROM nodes ORDER BY rowid").all(),
    schema_migrations: database.prepare("SELECT * FROM schema_migrations ORDER BY rowid").all(),
    workspace: database.prepare("SELECT * FROM workspace ORDER BY rowid").all(),
  };
}

/** 精确八表集合是 v1-v4 共同边界，不允许 migration 引入 alias/dual-read 表。 */
function readUserTables(database: RawSqliteDatabase): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

/** ID 会重键，但业务时间字段必须在 migration 前后保持不变。 */
function readTemporalState(database: RawSqliteDatabase): Record<string, unknown[]> {
  return {
    evidence: database.prepare(`
      SELECT analyzer_version, source_file_id, range_start, range_end, detected_at
      FROM evidence ORDER BY source_file_id, range_start, range_end
    `).all(),
    jobs: database.prepare(`
      SELECT id, requested_at, started_at, completed_at
      FROM jobs ORDER BY id
    `).all(),
    workspace: database.prepare(`
      SELECT workspace_key, committed_at FROM workspace ORDER BY workspace_key
    `).all(),
  };
}

/** 构造真实 schema-v1 current，验证 v4 只重键且不补造现代提交证据。 */
function seedLegacyV1CurrentDatabase(databasePath: string): {
  canonicalEdgeIds: readonly string[];
  legacyEdgeIds: readonly string[];
} {
  const graph = buildHierarchyGraph(workspaceKey, ["src/index.ts"]);
  const legacyEdges = graph.edges.map((edge) => ({
    ...edge,
    id: buildLegacyGraphEdgeIdV0(
      workspaceKey,
      edge.fromId,
      edge.relationType,
      edge.toId,
      edge.qualifier,
    ),
  }));
  const rootId = buildGraphEntityId(workspaceKey, "workspace", "");
  const database = new RawSqlite(databasePath);
  applyBootstrapMigration(database as never);
  database.prepare(`
    INSERT INTO workspace(
      workspace_key, committed_at, indexed_file_count, node_count, edge_count,
      excluded_path_count, builtin_rules_version
    ) VALUES (?, '2026-07-27T00:00:01.000Z', 1, ?, ?, 0, 'builtin-ignore-v1')
  `).run(workspaceKey, graph.nodes.length, legacyEdges.length);
  const insertNode = database.prepare(`
    INSERT INTO nodes(id, workspace_key, kind, relative_path) VALUES (?, ?, ?, ?)
  `);
  for (const node of graph.nodes) {
    insertNode.run(node.id, workspaceKey, node.kind, node.relativePath);
  }
  const insertEdge = database.prepare(`
    INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const edge of legacyEdges) {
    insertEdge.run(edge.id, workspaceKey, edge.fromId, edge.relationType, edge.toId, edge.qualifier);
  }
  const insertOwnership = database.prepare(`
    INSERT INTO facts_ownership(fact_id, owner_key, workspace_key) VALUES (?, ?, ?)
  `);
  for (const factId of [...graph.nodes.map((node) => node.id), ...legacyEdges.map((edge) => edge.id)]) {
    insertOwnership.run(factId, `hierarchy:${rootId}`, workspaceKey);
  }
  database.prepare(`
    INSERT INTO jobs(
      id, workspace_key, kind, state, requested_at, started_at, completed_at
    ) VALUES (
      'legacy-v1-current', ?, 'initial-index', 'succeeded',
      '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z',
      '2026-07-27T00:00:01.000Z'
    )
  `).run(workspaceKey);
  database.prepare("INSERT INTO meta(key, value) VALUES (?, 'legacy-v1-current')").run(
    `bootstrap-committed-job:${workspaceKey}`,
  );
  database.close();
  return {
    canonicalEdgeIds: Object.freeze(graph.edges.map((edge) => edge.id).sort()),
    legacyEdgeIds: Object.freeze(legacyEdges.map((edge) => edge.id).sort()),
  };
}

/** 构造一次含 Node built-in 依赖的完整 composite patch。 */
function createPatch(
  snapshot: ReturnType<Awaited<ReturnType<typeof openSqliteGraphStore>>["readCommittedSnapshot"]>,
  detectedAt: string,
  fenceInput: Omit<
    Parameters<typeof createAnalyzerConfigFenceSnapshot>[0],
    "consultedFiles"
  > = {},
) {
  const manifest = [{ contentHash: "1".repeat(64), path: "src/index.ts" }] as const;
  const analyzerConfig = createAnalyzerConfigSnapshot({
    analyzerKind: "typescript",
    analyzerVersion: "6.0.3",
    consultedFiles: [],
    effectiveCompilerOptions: { module: "NodeNext" },
    effectiveIgnore: { effectiveDigest: "4".repeat(64), version: 1 },
    workspacePackages: [],
  }, digestPort);
  const analyzerConfigFence = createAnalyzerConfigFenceSnapshot({
    ...fenceInput,
    consultedFiles: analyzerConfig.snapshot.consultedFiles,
  });
  const inputDigest = createAnalyzerInputDigest({
    analyzerKind: "typescript",
    configDigest: analyzerConfig.configDigest,
    inputs: manifest,
  }, digestPort);
  const readSet: HierarchyReadSetV1 = {
    analyzerConfigFenceSnapshot: analyzerConfigFence,
    analyzerConfigSnapshot: analyzerConfig.snapshot,
    baseGraphRevision: snapshot.graphRevision,
    bootstrapGeneration: 0,
    configDigest: analyzerConfig.configDigest,
    effectiveIgnoreSnapshot: {
      builtinRulesVersion: "builtin-ignore-v1",
      contentHash: null,
      effectiveDigest: "4".repeat(64),
      effectiveRules: ["/.git/"],
      generation: 0,
      lastValidDigest: "4".repeat(64),
      userRules: [],
      validity: "valid",
      version: 1,
    },
    inputDigest,
    manifest,
    manifestDigest: sha256CanonicalJson(manifest),
    statusEpoch: "sqlite-module-story",
  };
  const hierarchyBatch = buildHierarchyFactBatch({
    configDigest: readSet.configDigest,
    coverage: "complete",
    inputDigest: readSet.inputDigest,
    manifestDigest: readSet.manifestDigest,
    producerVersion: "hierarchy-v1",
    relativePaths: ["src/index.ts"],
    workspaceKey,
  });
  const sourceFileId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
  const moduleBatch = buildModuleSourceFactBatch({
    analyzerKind: "typescript",
    analyzerVersion: "6.0.3",
    configDigest: readSet.configDigest,
    coverage: "complete",
    detectedAt,
    diagnostics: [],
    inputDigest: readSet.inputDigest,
    localExportBindings: [],
    relations: [{
      confidence: "high",
      language: "typescript",
      normalizedRange: { end: 16, start: 7 },
      provenance: "typescript-compiler-api",
      qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
      relationType: "imports",
      target: { id: "node:path", kind: "node-builtin", moduleName: "path" },
    }],
    sourceFileId,
    workspaceKey,
  });
  return buildCompositeGraphPatch({
    digestPort,
    hierarchyBatch,
    moduleBatches: [moduleBatch],
    readSet,
    snapshot,
  });
}

describe("Story 1.5 SQLite module dependency storage", () => {
  it("DIAGNOSIS23 S2 persists fence state while keeping it outside recovered configDigest", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    const snapshot = store.readCommittedSnapshot();
    const baseline = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    const variants = [
      createPatch(snapshot, "2026-07-27T00:00:00.000Z", {
        absentFiles: ["configs/base.json"],
      }),
      createPatch(snapshot, "2026-07-27T00:00:00.000Z", {
        absentResolutionFiles: ["node_modules/pkg/missing.d.ts"],
      }),
      createPatch(snapshot, "2026-07-27T00:00:00.000Z", {
        blockedResolutionFiles: [{
          contentHash: "5".repeat(64),
          path: "src/blocked.ts",
        }],
      }),
    ];
    for (const variant of variants) {
      expect(variant.readSet.configDigest).toBe(baseline.readSet.configDigest);
      expect(variant.readSet.analyzerConfigFenceSnapshot).toBeDefined();
    }

    const patch = variants[2]!;
    store.createJob({
      baseGraphRevision: null,
      id: "fence-recovery",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("fence-recovery", "2026-07-27T00:00:00.000Z");
    store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: snapshot,
      finalReadSetFence: (commit) => {commit(); return true;},
      jobId: "fence-recovery",
      patch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: patch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: patch.targetNodeCount,
      },
    });
    store.close();

    const database = new RawSqlite(databasePath);
    const persisted = database.prepare("SELECT read_set_json FROM jobs WHERE id = ?")
      .get("fence-recovery") as { read_set_json: string };
    const readSet = JSON.parse(persisted.read_set_json) as HierarchyReadSetV1;
    expect(readSet.analyzerConfigFenceSnapshot).toEqual(
      patch.readSet.analyzerConfigFenceSnapshot,
    );
    database.close();

    const reopened = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    expect(reopened.readCommittedSnapshot().graphRevision).toBe(1);
    reopened.close();
  });

  it("tokenizes CHECK only outside SQL comments, quoted identifiers and token substrings", () => {
    const ddl = `
      CREATE TABLE sample (
        "CHECK(fake_double)" TEXT,
        value TEXT,
        -- CHECK (fake_line)
        /* CHECK (fake_block) */
        preCHECK(value),
        CHECK ((value IN ('a', 'b')) AND (length(value) > 0))
      )
    `;
    const expected = ["(valuein('a','b'))and(length(value)>0)"];

    expect(extractCheckExpressions(ddl)).toEqual(expected);
    expect(extractCheckExpressions(ddl.replace(
      "(length(value) > 0)",
      "((length(value) > 0) OR ((1 = 1)))",
    ))).not.toEqual(expected);
  });

  it.each([
    ["NOCASE", "workspace_key COLLATE NOCASE, edge_id, source_file_id"],
    ["DESC", "workspace_key, edge_id DESC, source_file_id"],
  ])("rejects %s drift in the exact Evidence support index", async (_label, columns) => {
    const databasePath = await createDatabasePath();
    const database = new RawSqlite(databasePath);
    applyModuleDependencyMigration(database as never);
    database.exec(`
      DROP INDEX evidence_workspace_edge_source_idx;
      CREATE INDEX evidence_workspace_edge_source_idx ON evidence(${columns});
    `);
    try {
      expect(() => assertModuleDependencySchemaIntegrity(database as never))
        .toThrow(/index|索引|Schema/u);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate Evidence ownership before invoking any SQLite mutation", async () => {
    const databasePath = await createDatabasePath();
    const mutationStages: string[] = [];
    const store = await openSqliteGraphStore({
      databasePath,
      digestPort,
      faultInjector: ({ stage }) => mutationStages.push(stage),
      workspaceKey,
    });
    const snapshot = store.readCommittedSnapshot();
    const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    const sourceSlice = patch.slices.find((slice) =>
      slice.ownershipSliceId.startsWith("source:typescript:"));
    if (sourceSlice === undefined) {throw new Error("测试 source slice 缺失。");}
    const malformedPatch = {
      ...patch,
      slices: Object.freeze([
        ...patch.slices,
        Object.freeze({
          ...sourceSlice,
          ownershipSliceId: `source:typescript:${"f".repeat(64)}`,
        }),
      ].sort((left, right) => left.ownershipSliceId.localeCompare(right.ownershipSliceId))),
    };
    store.createJob({
      baseGraphRevision: null,
      id: "duplicate-evidence-owner",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("duplicate-evidence-owner", "2026-07-27T00:00:00.000Z");

    try {
      expect(() => store.commitAtomicGraphUpdate({
        completedAt: "2026-07-27T00:00:01.000Z",
        expectedSnapshot: snapshot,
        finalReadSetFence: (commit) => {commit(); return true;},
        jobId: "duplicate-evidence-owner",
        patch: malformedPatch,
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: patch.targetEdgeCount,
          excludedPathCount: 0,
          generatedAt: "2026-07-27T00:00:01.000Z",
          indexedFileCount: 1,
          nodeCount: patch.targetNodeCount,
        },
      })).toThrow(/Evidence|ownership|source/u);
      expect(mutationStages).toEqual([]);
    } finally {
      store.close();
    }
  });

  it.each(["hierarchy-node", "shared-node", "evidence"] as const)(
    "rejects non-canonical %s payload_json during recovery",
    async (target) => {
      const databasePath = await createDatabasePath();
      const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
      const snapshot = store.readCommittedSnapshot();
      const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
      store.createJob({
        baseGraphRevision: null,
        id: `payload-${target}`,
        kind: "initial-index",
        requestedAt: "2026-07-27T00:00:00.000Z",
      });
      store.markJobRunning(`payload-${target}`, "2026-07-27T00:00:00.000Z");
      store.commitAtomicGraphUpdate({
        completedAt: "2026-07-27T00:00:01.000Z",
        expectedSnapshot: snapshot,
        finalReadSetFence: (commit) => {commit(); return true;},
        jobId: `payload-${target}`,
        patch,
        summary: {
          builtinRulesVersion: "builtin-ignore-v1",
          edgeCount: patch.targetEdgeCount,
          excludedPathCount: 0,
          generatedAt: "2026-07-27T00:00:01.000Z",
          indexedFileCount: 1,
          nodeCount: patch.targetNodeCount,
        },
      });
      store.close();

      const database = new RawSqlite(databasePath);
      if (target === "hierarchy-node") {
        database.prepare(`
          UPDATE nodes SET payload_json = '{"tampered":true}'
          WHERE workspace_key = ? AND kind = 'file'
        `).run(workspaceKey);
      } else if (target === "shared-node") {
        database.prepare(`
          UPDATE nodes SET payload_json = '{"moduleName":"path","extra":true}'
          WHERE workspace_key = ? AND kind = 'node-builtin'
        `).run(workspaceKey);
      } else {
        database.prepare(`
          UPDATE evidence SET payload_json = '{"tampered":true}'
          WHERE workspace_key = ?
        `).run(workspaceKey);
      }
      database.close();

      let reopened: Awaited<ReturnType<typeof openSqliteGraphStore>> | undefined;
      let failure: unknown;
      try {
        reopened = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
      } catch (error) {
        failure = error;
      } finally {
        reopened?.close();
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/payload|摘要|恢复|canonical|规范/u);
    },
  );

  it("rejects a recovered Evidence row with more than one ownership row", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    const snapshot = store.readCommittedSnapshot();
    const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    store.createJob({
      baseGraphRevision: null,
      id: "recovery-duplicate-evidence-owner",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("recovery-duplicate-evidence-owner", "2026-07-27T00:00:00.000Z");
    store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: snapshot,
      finalReadSetFence: (commit) => {commit(); return true;},
      jobId: "recovery-duplicate-evidence-owner",
      patch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: patch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: patch.targetNodeCount,
      },
    });
    store.close();

    const database = new RawSqlite(databasePath);
    const evidence = database.prepare("SELECT id FROM evidence WHERE workspace_key = ? LIMIT 1")
      .get(workspaceKey) as { id: string };
    database.prepare(`
      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      VALUES ('evidence', ?, ?, ?)
    `).run(evidence.id, `source:typescript:${"f".repeat(64)}`, workspaceKey);
    database.close();

    await expect(openSqliteGraphStore({ databasePath, digestPort, workspaceKey }))
      .rejects.toThrow(/ownership|Evidence|恢复|摘要|targetGraphDigest|真实图事实/u);
  });

  it("fresh-open converges through v3 to v4 and atomically persists module facts", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    const schema = new RawSqlite(databasePath, { readonly: true });
    expect(databaseVersion(schema)).toBe(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
    schema.close();
    const snapshot = store.readCommittedSnapshot();
    const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    store.createJob({
      baseGraphRevision: null,
      id: "module-initial",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("module-initial", "2026-07-27T00:00:00.000Z");

    const result = store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: snapshot,
      finalReadSetFence: (commit) => {
        commit();
        return true;
      },
      jobId: "module-initial",
      patch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: patch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: patch.targetNodeCount,
      },
    });

    expect(MODULE_DEPENDENCY_SCHEMA_VERSION).toBe(3);
    expect(result).toMatchObject({ graphRevision: 1, kind: "committed" });
    expect(store.listOwnership().some((item) =>
      item.factKind === "evidence" && item.ownerKey.startsWith("source:typescript:"))).toBe(true);
    expect(store.readCommittedSnapshot()).toMatchObject({
      allEvidence: [{ confidence: "high", edgeId: expect.any(String), language: "typescript" }],
      graphRevision: 1,
    });
    store.close();

    const reopened = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    expect(reopened.readCommittedSnapshot().allEvidence).toHaveLength(1);
    expect(reopened.readBootstrapState().committed).toMatchObject({
      edgeCount: patch.targetEdgeCount,
      graphRevision: 1,
      nodeCount: patch.targetNodeCount,
    });
    reopened.close();
  });

  it("keeps graphRevision stable when only detectedAt changes", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    const firstSnapshot = store.readCommittedSnapshot();
    const firstPatch = createPatch(firstSnapshot, "2026-07-27T00:00:00.000Z");
    store.createJob({
      baseGraphRevision: null,
      id: "first",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("first", "2026-07-27T00:00:00.000Z");
    store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: firstSnapshot,
      finalReadSetFence: (commit) => { commit(); return true; },
      jobId: "first",
      patch: firstPatch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: firstPatch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: firstPatch.targetNodeCount,
      },
    });

    const replaySnapshot = store.readCommittedSnapshot();
    const replayPatch = createPatch(replaySnapshot, "2026-07-27T00:00:10.000Z");
    store.createJob({
      baseGraphRevision: 1,
      id: "replay",
      kind: "rebuild",
      requestedAt: "2026-07-27T00:00:10.000Z",
    });
    store.markJobRunning("replay", "2026-07-27T00:00:10.000Z");
    const replay = store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:11.000Z",
      expectedSnapshot: replaySnapshot,
      finalReadSetFence: (commit) => { commit(); return true; },
      jobId: "replay",
      patch: replayPatch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: replayPatch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:11.000Z",
        indexedFileCount: 1,
        nodeCount: replayPatch.targetNodeCount,
      },
    });

    expect(replay).toMatchObject({ graphRevision: 1, kind: "noop" });
    expect(store.readCommittedSnapshot().allEvidence?.[0]?.detectedAt)
      .toBe("2026-07-27T00:00:00.000Z");
    store.close();
  });

  it("rolls back every composite fact when Evidence persistence fails", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({
      databasePath,
      digestPort,
      faultInjector: ({ stage }) => {
        if (stage === "evidence") {throw new Error("injected composite evidence failure");}
      },
      workspaceKey,
    });
    const snapshot = store.readCommittedSnapshot();
    const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    store.createJob({
      baseGraphRevision: null,
      id: "module-rollback",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("module-rollback", "2026-07-27T00:00:00.000Z");

    expect(() => store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: snapshot,
      finalReadSetFence: (commit) => { commit(); return true; },
      jobId: "module-rollback",
      patch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: patch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: patch.targetNodeCount,
      },
    })).toThrow(/injected composite evidence failure/u);
    expect(store.readGraphCounts()).toEqual({ edgeCount: 0, nodeCount: 0 });
    expect(store.listOwnership()).toEqual([]);
    expect(store.readCommittedSnapshot()).toMatchObject({
      allEvidence: [],
      graphRevision: null,
    });
    store.close();
  });

  it.each([
    "source-kind",
    "source-edge-mismatch",
    "missing-evidence",
    "invalid-qualifier",
  ] as const)("rejects invalid module Evidence topology: %s", async (corruption) => {
    const databasePath = await createDatabasePath();
    const database = new RawSqlite(databasePath);
    applyModuleDependencyMigration(database as never);
    database.pragma("foreign_keys = ON");
    database.pragma("ignore_check_constraints = ON");
    const rootId = buildGraphEntityId(workspaceKey, "workspace", "");
    const directoryId = buildGraphEntityId(workspaceKey, "directory", "src");
    const sourceId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
    const otherSourceId = buildGraphEntityId(workspaceKey, "file", "src/other.ts");
    const containsDirectoryId = buildLegacyGraphEdgeIdV0(
      workspaceKey,
      rootId,
      "contains",
      directoryId,
    );
    const containsSourceId = buildLegacyGraphEdgeIdV0(
      workspaceKey,
      directoryId,
      "contains",
      sourceId,
    );
    const containsOtherId = buildLegacyGraphEdgeIdV0(
      workspaceKey,
      directoryId,
      "contains",
      otherSourceId,
    );
    const moduleFromId = corruption === "source-kind" ? "node:path" : sourceId;
    const moduleRelationType = corruption === "invalid-qualifier" ? "exports" : "imports";
    const moduleQualifier = corruption === "invalid-qualifier"
      ? "reexport:%ZZ:name:value"
      : "value";
    const moduleEdgeId = buildLegacyGraphEdgeIdV0(
      workspaceKey,
      moduleFromId,
      moduleRelationType,
      "node:path",
      moduleQualifier,
    );
    const evidenceSourceId = corruption === "source-edge-mismatch" ? otherSourceId : moduleFromId;
    const evidenceId = buildModuleEvidenceId({
      analyzerVersion: "6.0.3",
      edgeId: moduleEdgeId,
      evidenceKind: "module-dependency",
      normalizedRange: { end: 8, start: 1 },
      provenance: "typescript-compiler-api",
      sourceFileId: evidenceSourceId,
    });
    database.prepare("INSERT INTO workspace(workspace_key, completeness) VALUES (?, 'empty')")
      .run(workspaceKey);
    for (const [id, kind, relativePath, payload] of [
      [rootId, "workspace", "", "{}"],
      [directoryId, "directory", "src", "{}"],
      [sourceId, "file", "src/index.ts", "{}"],
      [otherSourceId, "file", "src/other.ts", "{}"],
      ["node:path", "node-builtin", null, JSON.stringify({ moduleName: "path" })],
    ] as const) {
      database.prepare(`
        INSERT INTO nodes(id, workspace_key, kind, relative_path, payload_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, workspaceKey, kind, relativePath, payload);
    }
    for (const [id, fromId, toId] of [
      [containsDirectoryId, rootId, directoryId],
      [containsSourceId, directoryId, sourceId],
      [containsOtherId, directoryId, otherSourceId],
    ]) {
      database.prepare(`
        INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
        VALUES (?, ?, ?, 'contains', ?, '')
      `).run(id, workspaceKey, fromId, toId);
    }
    database.prepare(`
      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      VALUES (?, ?, ?, ?, 'node:path', ?)
    `).run(moduleEdgeId, workspaceKey, moduleFromId, moduleRelationType, moduleQualifier);
    for (const [factKind, factId] of [
      ["node", rootId],
      ["node", directoryId],
      ["node", sourceId],
      ["node", otherSourceId],
      ["edge", containsDirectoryId],
      ["edge", containsSourceId],
      ["edge", containsOtherId],
    ] as const) {
      database.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES (?, ?, ?, ?)
      `).run(factKind, factId, `hierarchy:${rootId}`, workspaceKey);
    }
    if (corruption !== "missing-evidence") {
      database.prepare(`
        INSERT INTO evidence(
          id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
          range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
        ) VALUES (?, ?, ?, 'typescript-compiler-api', '6.0.3', ?, 1, 8,
          'module-dependency', 'high', 'typescript', '2026-07-27T00:00:00.000Z', '{}')
      `).run(evidenceId, workspaceKey, moduleEdgeId, evidenceSourceId);
      database.prepare(`
        INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
        VALUES ('evidence', ?, ?, ?)
      `).run(evidenceId, `source:typescript:${evidenceSourceId}`, workspaceKey);
    }

    expect(() => assertModuleDependencySchemaIntegrity(database as never))
      .toThrow(/module|Evidence|拓扑/u);
    database.close();
  });

  it("locks the exact v3 DDL, indexes and UTC Evidence contract", async () => {
    const databasePath = await createDatabasePath();
    const database = new RawSqlite(databasePath);
    applyModuleDependencyMigration(database as never);
    const evidenceSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evidence'
    `).get() as { sql: string }).sql;

    expect(evidenceSql).toMatch(/confidence\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(confidence\s+IN\s*\('high',\s*'medium',\s*'low'\)\)/iu);
    expect(evidenceSql).toMatch(/language\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(language\s+IN\s*\(\s*'typescript',\s*'typescriptreact',\s*'javascript',\s*'javascriptreact'\s*\)\)/iu);
    expect(evidenceSql).toMatch(/detected_at[\s\S]+strftime/iu);
    const evidenceIndexes = database.prepare("PRAGMA index_list('evidence')").all() as Array<{
      name: string;
      partial: number;
      unique: number;
    }>;
    expect(evidenceIndexes).toContainEqual(expect.objectContaining({
      name: "evidence_workspace_edge_source_idx",
      partial: 0,
      unique: 0,
    }));
    const supportIndexColumns = database.prepare(
      "PRAGMA index_info('evidence_workspace_edge_source_idx')",
    ).all() as Array<{ name: string }>;
    expect(supportIndexColumns.map((column) => column.name)).toEqual([
      "workspace_key",
      "edge_id",
      "source_file_id",
    ]);
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT 1
      FROM edges AS edge
      WHERE edge.relation_type IN ('imports', 'exports') AND NOT EXISTS (
        SELECT 1 FROM evidence
        WHERE evidence.workspace_key = edge.workspace_key
          AND evidence.edge_id = edge.id
          AND evidence.source_file_id = edge.from_id
      )
    `).all() as Array<{ detail: string }>;
    expect(plan.map((step) => step.detail).join("\n"))
      .toContain("evidence_workspace_edge_source_idx");
    database.exec("CREATE INDEX unexpected_evidence_index ON evidence(edge_id)");
    expect(() => assertModuleDependencySchemaIntegrity(database as never))
      .toThrow(/Schema|index|索引/u);
    database.close();
  });

  it("recreates the declared Evidence support index idempotently for an existing v3 database", async () => {
    const databasePath = await createDatabasePath();
    const database = new RawSqlite(databasePath);
    applyModuleDependencyMigration(database as never);
    database.exec("DROP INDEX evidence_workspace_edge_source_idx");

    expect(() => applyModuleDependencyMigration(database as never)).not.toThrow();
    expect(database.prepare(`
      SELECT 1 AS found FROM sqlite_master
      WHERE type = 'index' AND name = 'evidence_workspace_edge_source_idx'
    `).get()).toBeDefined();
    expect(() => assertModuleDependencySchemaIntegrity(database as never)).not.toThrow();
    database.close();
  });

  it("keeps Evidence support lookup bounded at scale", async () => {
    const databasePath = await createDatabasePath();
    const database = new RawSqlite(databasePath);
    applyModuleDependencyMigration(database as never);
    database.pragma("foreign_keys = OFF");
    database.prepare("INSERT INTO workspace(workspace_key, completeness) VALUES (?, 'empty')")
      .run(workspaceKey);
    const insertEdge = database.prepare(`
      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      VALUES (?, ?, ?, 'imports', ?, 'value')
    `);
    const insertEvidence = database.prepare(`
      INSERT INTO evidence(
        id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
        range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
      ) VALUES (?, ?, ?, 'typescript-compiler-api', '6.0.3', ?, 0, 1,
        'module-dependency', 'high', 'typescript', '2026-07-27T00:00:00.000Z', '{}')
    `);
    const rowCount = 10_000;
    database.transaction(() => {
      for (let index = 0; index < rowCount; index += 1) {
        const edgeId = `edge-scale-${index}`;
        const sourceId = `source-scale-${index}`;
        insertEdge.run(edgeId, workspaceKey, sourceId, `target-scale-${index}`);
        insertEvidence.run(`evidence-scale-${index}`, workspaceKey, edgeId, sourceId);
      }
    }).immediate();
    const query = database.prepare(`
      SELECT COUNT(*) AS unsupported_count
      FROM edges AS edge
      WHERE edge.relation_type IN ('imports', 'exports') AND NOT EXISTS (
        SELECT 1 FROM evidence
        WHERE evidence.workspace_key = edge.workspace_key
          AND evidence.edge_id = edge.id
          AND evidence.source_file_id = edge.from_id
      )
    `);
    const startedAt = performance.now();
    const result = query.get() as { unsupported_count: number };
    const elapsedMs = performance.now() - startedAt;

    expect(result.unsupported_count).toBe(0);
    expect(elapsedMs).toBeLessThan(1_000);
    database.close();
  });

  it("rejects 24:00 at the SQLite Evidence boundary", async () => {
    const databasePath = await createDatabasePath();
    const database = new RawSqlite(databasePath);
    applyModuleDependencyMigration(database as never);
    database.pragma("foreign_keys = OFF");

    expect(() => database.prepare(`
      INSERT INTO evidence(
        id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
        range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
      ) VALUES ('evidence-24h', ?, 'edge-missing', 'typescript-compiler-api', '6.0.3',
        'source-missing', 0, 1, 'module-dependency', 'high', 'typescript',
        '2026-07-27T24:00:00.000Z', '{}')
    `).run(workspaceKey)).toThrow(/CHECK|constraint/iu);
    database.close();
  });

  it("rejects an extra cross-workspace Evidence row even when the edge also has valid support", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    const snapshot = store.readCommittedSnapshot();
    const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    store.createJob({
      baseGraphRevision: null,
      id: "cross-workspace-evidence",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("cross-workspace-evidence", "2026-07-27T00:00:00.000Z");
    store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: snapshot,
      finalReadSetFence: (commit) => {commit(); return true;},
      jobId: "cross-workspace-evidence",
      patch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: patch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: patch.targetNodeCount,
      },
    });
    store.close();

    const database = new RawSqlite(databasePath);
    try {
    database.pragma("foreign_keys = OFF");
    const valid = database.prepare(`
      SELECT edge_id, source_file_id FROM evidence LIMIT 1
    `).get() as { edge_id: string; source_file_id: string };
    const otherWorkspaceKey = "f".repeat(64);
    const pollutedId = buildModuleEvidenceId({
      analyzerVersion: "6.0.3",
      edgeId: valid.edge_id,
      evidenceKind: "module-dependency",
      normalizedRange: { end: 9, start: 2 },
      provenance: "typescript-compiler-api",
      sourceFileId: valid.source_file_id,
    });
    database.prepare("INSERT INTO workspace(workspace_key, completeness) VALUES (?, 'empty')")
      .run(otherWorkspaceKey);
    database.prepare(`
      INSERT INTO evidence(
        id, workspace_key, edge_id, provenance, analyzer_version, source_file_id,
        range_start, range_end, evidence_kind, confidence, language, detected_at, payload_json
      ) VALUES (?, ?, ?, 'typescript-compiler-api', '6.0.3', ?, 2, 9,
        'module-dependency', 'high', 'typescript', '2026-07-27T00:00:00.000Z', '{}')
    `).run(pollutedId, otherWorkspaceKey, valid.edge_id, valid.source_file_id);
    database.prepare(`
      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      VALUES ('evidence', ?, ?, ?)
    `).run(pollutedId, `source:typescript:${valid.source_file_id}`, otherWorkspaceKey);

    expect(() => assertAd4ModuleDependencySchemaIntegrity(database as never))
      .toThrow(/workspace|Evidence|拓扑/u);
    } finally {
      database.close();
    }
  });

  it("rejects weakened CHECK expressions and closes runtime Evidence vocabularies", async () => {
    const weakenedPath = await createDatabasePath();
    const weakened = new RawSqlite(weakenedPath);
    applyModuleDependencyMigration(weakened as never);
    weakened.pragma("foreign_keys = OFF");
    weakened.exec(`
      CREATE TABLE edges_weakened (
        id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        from_id TEXT NOT NULL,
        relation_type TEXT NOT NULL
          CHECK (relation_type IN ('contains', 'imports', 'exports') OR 1),
        to_id TEXT NOT NULL,
        qualifier TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (workspace_key) REFERENCES workspace(workspace_key) ON DELETE CASCADE,
        FOREIGN KEY (from_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (to_id) REFERENCES nodes(id) ON DELETE CASCADE,
        UNIQUE (from_id, relation_type, to_id, qualifier)
      );
      DROP TABLE edges;
      ALTER TABLE edges_weakened RENAME TO edges;
    `);
    expect(() => assertModuleDependencySchemaIntegrity(weakened as never))
      .toThrow(/CHECK|Schema|合同/u);
    weakened.close();

    const literalPath = await createDatabasePath();
    const literal = new RawSqlite(literalPath);
    applyModuleDependencyMigration(literal as never);
    const nodeDdlRow = literal.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'
    `).get() as { sql?: unknown };
    const nodeDdl = nodeDdlRow.sql;
    if (typeof nodeDdl !== "string") {throw new Error("nodes DDL 缺失。");}
    literal.pragma("foreign_keys = OFF");
    literal.exec([
      nodeDdl
        .replace(/CREATE\s+TABLE\s+nodes/iu, "CREATE TABLE nodes_literal")
        .replace("'workspace'", "'WORKSPACE'") + ";",
      "DROP TABLE nodes;",
      "ALTER TABLE nodes_literal RENAME TO nodes;",
    ].join("\n"));
    expect(() => assertModuleDependencySchemaIntegrity(literal as never))
      .toThrow(/CHECK|Schema|合同/u);
    literal.close();

    const runtimePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath: runtimePath, digestPort, workspaceKey });
    const snapshot = store.readCommittedSnapshot();
    const patch = createPatch(snapshot, "2026-07-27T00:00:00.000Z");
    store.createJob({
      baseGraphRevision: null,
      id: "runtime-vocabulary",
      kind: "initial-index",
      requestedAt: "2026-07-27T00:00:00.000Z",
    });
    store.markJobRunning("runtime-vocabulary", "2026-07-27T00:00:00.000Z");
    const committed = store.commitAtomicGraphUpdate({
      completedAt: "2026-07-27T00:00:01.000Z",
      expectedSnapshot: snapshot,
      finalReadSetFence: (commit) => { commit(); return true; },
      jobId: "runtime-vocabulary",
      patch,
      summary: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: patch.targetEdgeCount,
        excludedPathCount: 0,
        generatedAt: "2026-07-27T00:00:01.000Z",
        indexedFileCount: 1,
        nodeCount: patch.targetNodeCount,
      },
    });
    expect(committed.kind).toBe("committed");
    store.close();

    const runtime = new RawSqlite(runtimePath);
    try {
    const evidence = runtime.prepare(`
      SELECT id, edge_id, analyzer_version, source_file_id, range_start, range_end
      FROM evidence LIMIT 1
    `).get() as {
      analyzer_version: string;
      edge_id: string;
      id: string;
      range_end: number;
      range_start: number;
      source_file_id: string;
    };
    const invalidEvidenceId = buildModuleEvidenceId({
      analyzerVersion: evidence.analyzer_version,
      edgeId: evidence.edge_id,
      evidenceKind: "invalid-evidence-kind" as never,
      normalizedRange: { end: evidence.range_end, start: evidence.range_start },
      provenance: "invalid-provenance" as never,
      sourceFileId: evidence.source_file_id,
    });
    runtime.pragma("foreign_keys = OFF");
    runtime.pragma("ignore_check_constraints = ON");
    runtime.prepare(`
      UPDATE evidence
      SET id = ?, provenance = 'invalid-provenance', evidence_kind = 'invalid-evidence-kind'
      WHERE id = ?
    `).run(invalidEvidenceId, evidence.id);
    runtime.prepare(`
      UPDATE facts_ownership SET fact_id = ?
      WHERE fact_kind = 'evidence' AND fact_id = ?
    `).run(invalidEvidenceId, evidence.id);
    expect(() => assertAd4ModuleDependencySchemaIntegrity(runtime as never))
      .toThrow(/Evidence|词汇|provenance|evidence_kind/u);
    } finally {
      runtime.close();
    }
  });

  it("re-reads absent bootstrap state after acquiring the IMMEDIATE lock", async () => {
    const databasePath = await createDatabasePath();
    const migrationDatabase = new RawSqlite(databasePath);
    const competingDatabase = new RawSqlite(databasePath);
    const originalTransaction = migrationDatabase.transaction.bind(migrationDatabase);
    migrationDatabase.transaction = ((callback: () => void) => {
      const wrapped = originalTransaction(callback);
      let raced = false;
      const race = (): void => {
        if (!raced) {
          raced = true;
          applyBootstrapMigration(competingDatabase as never);
        }
      };
      const transaction = (() => {
        race();
        wrapped();
      }) as ReturnType<RawSqliteDatabase["transaction"]>;
      transaction.immediate = () => {
        race();
        wrapped.immediate();
      };
      return transaction;
    }) as RawSqliteDatabase["transaction"];

    expect(() => applyBootstrapMigration(migrationDatabase as never)).not.toThrow();
    expect(databaseVersion(migrationDatabase)).toBe(1);
    competingDatabase.close();
    migrationDatabase.close();
  });

  it("routes absent through v1/v2/v3 only after the outer IMMEDIATE lock is acquired", async () => {
    const databasePath = await createDatabasePath();
    const migrationDatabase = new RawSqlite(databasePath);
    const competingDatabase = new RawSqlite(databasePath);
    const originalTransaction = migrationDatabase.transaction.bind(migrationDatabase);
    migrationDatabase.transaction = ((callback: () => void) => {
      const wrapped = originalTransaction(callback);
      let raced = false;
      const race = (): void => {
        if (!raced) {
          raced = true;
          applyModuleDependencyMigration(competingDatabase as never);
        }
      };
      const transaction = (() => {
        race();
        wrapped();
      }) as ReturnType<RawSqliteDatabase["transaction"]>;
      transaction.immediate = () => {
        race();
        wrapped.immediate();
      };
      return transaction;
    }) as RawSqliteDatabase["transaction"];

    expect(() => applyModuleDependencyMigration(migrationDatabase as never)).not.toThrow();
    expect(databaseVersion(migrationDatabase)).toBe(MODULE_DEPENDENCY_SCHEMA_VERSION);
    competingDatabase.close();
    migrationDatabase.close();
  });

  it("re-reads v3 migration state only after acquiring the IMMEDIATE lock", async () => {
    const databasePath = await createDatabasePath();
    const migrationDatabase = new RawSqlite(databasePath);
    applyBootstrapMigration(migrationDatabase as never);
    applyDeterministicCommitMigration(migrationDatabase as never);
    const competingDatabase = new RawSqlite(databasePath);
    const originalTransaction = migrationDatabase.transaction.bind(migrationDatabase);
    migrationDatabase.transaction = ((callback: () => void) => {
      const wrapped = originalTransaction(callback);
      const transaction = (() => wrapped()) as ReturnType<RawSqliteDatabase["transaction"]>;
      transaction.immediate = () => {
        applyModuleDependencyMigration(competingDatabase as never);
        wrapped.immediate();
      };
      return transaction;
    }) as RawSqliteDatabase["transaction"];

    expect(() => applyModuleDependencyMigration(migrationDatabase as never)).not.toThrow();
    expect(databaseVersion(migrationDatabase)).toBe(MODULE_DEPENDENCY_SCHEMA_VERSION);
    competingDatabase.close();
    migrationDatabase.close();
  });

  it("converges absent/v1/v2/v3 to schema v4 with the exact eight application tables", async () => {
    for (const sourceVersion of ["absent", "v1", "v2", "v3"] as const) {
      const databasePath = await createDatabasePath();
      const database = new RawSqlite(databasePath);
      if (sourceVersion === "v1") {
        applyBootstrapMigration(database as never);
      } else if (sourceVersion === "v2") {
        applyDeterministicCommitMigration(database as never);
      } else if (sourceVersion === "v3") {
        applyModuleDependencyMigration(database as never);
      }

      applyAd4EdgeIdentityMigration(database as never, { digestPort });

      expect(databaseVersion(database)).toBe(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
      expect(readUserTables(database)).toEqual([
        "edges",
        "evidence",
        "facts_ownership",
        "jobs",
        "meta",
        "nodes",
        "schema_migrations",
        "workspace",
      ]);
      database.close();
    }
  });

  it("rekeys edge, Evidence and ownership atomically while recomputing only current evidence", async () => {
    const databasePath = await createDatabasePath();
    const fixture = await seedLegacyV3CompositeDatabase(databasePath);
    const database = new RawSqlite(databasePath);
    const temporalBefore = readTemporalState(database);
    const workspaceBefore = database.prepare(`
      SELECT graph_revision, manifest_digest, input_digest, config_digest,
             effective_ignore_digest, committed_at
      FROM workspace WHERE workspace_key = ?
    `).get(workspaceKey);

    applyAd4EdgeIdentityMigration(database as never, { digestPort });

    expect(databaseVersion(database)).toBe(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
    expect((database.prepare("SELECT id FROM edges ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id)).toEqual([...fixture.canonicalEdgeIds].sort());
    const migratedEvidence = database.prepare(`
      SELECT id, edge_id FROM evidence ORDER BY id
    `).all() as Array<{ edge_id: string; id: string }>;
    expect(migratedEvidence.map((row) => row.id)).toEqual([...fixture.canonicalEvidenceIds].sort());
    expect(migratedEvidence.every((row) => fixture.canonicalEdgeIds.includes(row.edge_id))).toBe(true);
    const ownership = database.prepare(`
      SELECT fact_kind, fact_id FROM facts_ownership
      WHERE fact_kind IN ('edge', 'evidence') ORDER BY fact_kind, fact_id
    `).all() as Array<{ fact_id: string; fact_kind: "edge" | "evidence" }>;
    expect(ownership.some((row) => fixture.legacyEdgeIds.includes(row.fact_id))).toBe(false);
    expect(ownership.some((row) => fixture.legacyEvidenceIds.includes(row.fact_id))).toBe(false);
    expect(ownership.filter((row) => row.fact_kind === "edge")
      .every((row) => fixture.canonicalEdgeIds.includes(row.fact_id))).toBe(true);
    expect(ownership.filter((row) => row.fact_kind === "evidence")
      .every((row) => fixture.canonicalEvidenceIds.includes(row.fact_id))).toBe(true);

    const current = database.prepare(`
      SELECT read_set_json, patch_digest FROM jobs WHERE id = 'legacy-v3-current'
    `).get() as { patch_digest: string; read_set_json: string };
    const currentReadSet = JSON.parse(current.read_set_json) as { targetGraphDigest: string };
    const workspaceAfter = database.prepare(`
      SELECT graph_revision, manifest_digest, input_digest, config_digest,
             effective_ignore_digest, committed_at, patch_digest
      FROM workspace WHERE workspace_key = ?
    `).get(workspaceKey) as Record<string, unknown>;
    const readSetMeta = database.prepare("SELECT value FROM meta WHERE key = ?").get(
      `bootstrap-committed-read-set-digest:${workspaceKey}`,
    ) as { value: string };
    expect(currentReadSet.targetGraphDigest).toBe(fixture.canonicalTargetGraphDigest);
    expect(currentReadSet.targetGraphDigest).not.toBe(fixture.legacyTargetGraphDigest);
    expect(current.patch_digest).toBe(fixture.canonicalPatchDigest);
    expect(workspaceAfter.patch_digest).toBe(fixture.canonicalPatchDigest);
    expect(readSetMeta.value).toBe(fixture.canonicalReadSetDigest);
    expect(workspaceAfter).toMatchObject(workspaceBefore as object);
    expect(readTemporalState(database)).toEqual(temporalBefore);

    const historical = database.prepare(`
      SELECT read_set_json, patch_digest FROM jobs WHERE id = 'legacy-v3-historical'
    `).get() as { patch_digest: string; read_set_json: string };
    expect(historical).toEqual({
      patch_digest: fixture.historicalPatchDigest,
      read_set_json: fixture.historicalReadSetJson,
    });
    database.close();
  });

  it("keeps schema-v1 current evidence-less while rekeying its real hierarchy edges", async () => {
    const databasePath = await createDatabasePath();
    const fixture = seedLegacyV1CurrentDatabase(databasePath);
    const database = new RawSqlite(databasePath);

    applyAd4EdgeIdentityMigration(database as never, { digestPort });

    expect(databaseVersion(database)).toBe(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
    expect((database.prepare("SELECT id FROM edges ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id)).toEqual(fixture.canonicalEdgeIds);
    expect((database.prepare("SELECT id FROM edges ORDER BY id").all() as Array<{ id: string }>)
      .some((row) => fixture.legacyEdgeIds.includes(row.id))).toBe(false);
    expect(database.prepare(`
      SELECT read_set_json, patch_digest, legacy_schema_version
      FROM jobs WHERE id = 'legacy-v1-current'
    `).get()).toEqual({ legacy_schema_version: 1, patch_digest: null, read_set_json: null });
    expect(database.prepare(`
      SELECT graph_revision, manifest_digest, input_digest, config_digest,
             effective_ignore_digest, patch_digest, committed_at
      FROM workspace WHERE workspace_key = ?
    `).get(workspaceKey)).toEqual({
      committed_at: "2026-07-27T00:00:01.000Z",
      config_digest: null,
      effective_ignore_digest: null,
      graph_revision: 1,
      input_digest: null,
      manifest_digest: null,
      patch_digest: null,
    });
    expect(database.prepare("SELECT value FROM meta WHERE key = ?").get(
      `bootstrap-committed-read-set-digest:${workspaceKey}`,
    )).toBeUndefined();
    database.close();
  });

  it.each(["edge", "ownership", "evidence", "metadata"] as const)(
    "rolls back every authority table when v4 migration fails at %s",
    async (faultStage) => {
      const databasePath = await createDatabasePath();
      await seedLegacyV3CompositeDatabase(databasePath);
      const database = new RawSqlite(databasePath);
      const before = readApplicationState(database);

      expect(() => applyAd4EdgeIdentityMigration(database as never, {
        digestPort,
        faultInjector: ({ stage }) => {
          if (stage === faultStage) {throw new Error(`injected v4 ${stage} failure`);}
        },
      })).toThrow(`injected v4 ${faultStage} failure`);

      expect(databaseVersion(database)).toBe(MODULE_DEPENDENCY_SCHEMA_VERSION);
      expect(readApplicationState(database)).toEqual(before);
      database.close();
    },
  );

  it.each([
    "readset-base-zero",
    "bootstrap-negative",
    "status-empty",
    "manifest-duplicate",
    "ignore-invalid",
    "ignore-generation-negative",
    "analyzer-extra-field",
    "fence-path-overlap",
    "job-cas-mismatch",
  ] as const)("rejects invalid v3 preflight before any schema-v4 mutation: %s", async (corruption) => {
    const databasePath = await createDatabasePath();
    const fixture = await seedLegacyV3CompositeDatabase(databasePath);
    const database = new RawSqlite(databasePath);
    if (corruption === "job-cas-mismatch") {
      database.prepare(`
        UPDATE jobs SET base_graph_revision = 1 WHERE id = 'legacy-v3-current'
      `).run();
    } else {
      const persisted = database.prepare(`
        SELECT read_set_json FROM jobs WHERE id = 'legacy-v3-current'
      `).get() as { read_set_json: string };
      const readSet = JSON.parse(persisted.read_set_json) as Record<string, unknown>;
      const ignore = readSet.effectiveIgnoreSnapshot as Record<string, unknown>;
      const analyzer = readSet.analyzerConfigSnapshot as Record<string, unknown>;
      const fence = readSet.analyzerConfigFenceSnapshot as Record<string, unknown>;
      if (corruption === "readset-base-zero") {
        readSet.baseGraphRevision = 0;
      } else if (corruption === "bootstrap-negative") {
        readSet.bootstrapGeneration = -1;
      } else if (corruption === "status-empty") {
        readSet.statusEpoch = "";
      } else if (corruption === "manifest-duplicate") {
        const manifest = readSet.manifest as Array<Record<string, unknown>>;
        readSet.manifest = [manifest[0]!, { ...manifest[0]! }];
      } else if (corruption === "ignore-invalid") {
        ignore.validity = "invalid";
      } else if (corruption === "ignore-generation-negative") {
        ignore.generation = -1;
      } else if (corruption === "analyzer-extra-field") {
        analyzer.unexpected = true;
      } else {
        const overlapping = { contentHash: "5".repeat(64), path: "tsconfig.json" };
        analyzer.consultedFiles = [overlapping];
        fence.blockedResolutionFiles = [overlapping];
      }
      database.prepare(`
        UPDATE jobs SET read_set_json = ? WHERE id = 'legacy-v3-current'
      `).run(JSON.stringify(readSet));
    }
    const before = readApplicationState(database);

    expect(() => applyAd4EdgeIdentityMigration(database as never, { digestPort })).toThrow();

    expect(databaseVersion(database)).toBe(MODULE_DEPENDENCY_SCHEMA_VERSION);
    expect(readApplicationState(database)).toEqual(before);
    expect((database.prepare("SELECT id FROM edges ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id)).toEqual([...fixture.legacyEdgeIds].sort());
    database.close();
  });

  it("returns GRAPH_EDGE_ID_COLLISION and rolls back when distinct tuples collide", async () => {
    const databasePath = await createDatabasePath();
    await seedLegacyV3CompositeDatabase(databasePath);
    const database = new RawSqlite(databasePath);
    const before = readApplicationState(database);
    let failure: unknown;

    try {
      applyAd4EdgeIdentityMigration(database as never, {
        digestPort,
        faultInjector: ({ stage }) => {
          if (stage === "edge") {
            database.prepare("UPDATE temp.ad4_edge_rekey SET new_id = 'forced-collision'").run();
          }
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GraphEdgeIdCollisionError);
    expect(failure).toMatchObject({ code: "GRAPH_EDGE_ID_COLLISION" });
    expect(databaseVersion(database)).toBe(MODULE_DEPENDENCY_SCHEMA_VERSION);
    expect(readApplicationState(database)).toEqual(before);
    database.close();
  });

  it("is v4 reopen-idempotent and preserves every application row", async () => {
    const databasePath = await createDatabasePath();
    await seedLegacyV3CompositeDatabase(databasePath);
    let database = new RawSqlite(databasePath);
    applyAd4EdgeIdentityMigration(database as never, { digestPort });
    const migrated = readApplicationState(database);
    database.close();

    const reopened = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
    reopened.close();
    database = new RawSqlite(databasePath);
    applyAd4EdgeIdentityMigration(database as never, { digestPort });

    expect(databaseVersion(database)).toBe(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
    expect(readApplicationState(database)).toEqual(migrated);
    database.close();
  });

  it("preserves an invalid v3 backup as readonly schema-v3 evidence", async () => {
    const databasePath = await createDatabasePath();
    await seedLegacyV3CompositeDatabase(databasePath);
    const database = new RawSqlite(databasePath);
    const persisted = database.prepare(`
      SELECT read_set_json FROM jobs WHERE id = 'legacy-v3-current'
    `).get() as { read_set_json: string };
    const readSet = JSON.parse(persisted.read_set_json) as Record<string, unknown>;
    readSet.statusEpoch = "";
    database.prepare(`
      UPDATE jobs SET read_set_json = ? WHERE id = 'legacy-v3-current'
    `).run(JSON.stringify(readSet));
    database.close();

    await expect(openSqliteGraphStore({ databasePath, digestPort, workspaceKey })).rejects.toThrow();

    const entries = await readdir(path.dirname(databasePath));
    const backupName = entries.find((entry) =>
      /^graph\.sqlite\.failed-existing-\d+(?:-\d+)?\.bak$/u.test(entry));
    if (backupName === undefined) {throw new Error("v3 migration failure backup 缺失。");}
    const backup = new RawSqlite(path.join(path.dirname(databasePath), backupName), { readonly: true });
    try {
      expect(databaseVersion(backup)).toBe(MODULE_DEPENDENCY_SCHEMA_VERSION);
      expect(String(backup.pragma("integrity_check", { simple: true })).toLowerCase()).toBe("ok");
      expect(() => backup.prepare("INSERT INTO meta(key, value) VALUES ('x', 'y')").run())
        .toThrow();
    } finally {
      backup.close();
    }
  });

  it("keeps a concurrent WAL reader on complete v3 until the v4 transaction commits", async () => {
    const databasePath = await createDatabasePath();
    const fixture = await seedLegacyV3CompositeDatabase(databasePath);
    const migrationDatabase = new RawSqlite(databasePath);
    migrationDatabase.pragma("journal_mode = WAL");
    const reader = new RawSqlite(databasePath, { readonly: true });
    let observedDuringMigration: { edgeIds: string[]; version: number } | undefined;

    try {
      applyAd4EdgeIdentityMigration(migrationDatabase as never, {
        digestPort,
        faultInjector: ({ stage }) => {
          if (stage === "evidence") {
            observedDuringMigration = {
              edgeIds: (reader.prepare("SELECT id FROM edges ORDER BY id").all() as Array<{ id: string }>)
                .map((row) => row.id),
              version: databaseVersion(reader),
            };
          }
        },
      });

      expect(observedDuringMigration).toEqual({
        edgeIds: [...fixture.legacyEdgeIds].sort(),
        version: MODULE_DEPENDENCY_SCHEMA_VERSION,
      });
      expect(databaseVersion(reader)).toBe(AD4_EDGE_IDENTITY_SCHEMA_VERSION);
      expect((reader.prepare("SELECT id FROM edges ORDER BY id").all() as Array<{ id: string }>)
        .map((row) => row.id)).toEqual([...fixture.canonicalEdgeIds].sort());
    } finally {
      reader.close();
      migrationDatabase.close();
    }
  });
});

/** 读取当前最高 migration 版本。 */
function databaseVersion(database: RawSqliteDatabase): number {
  return (database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number }).version;
}
