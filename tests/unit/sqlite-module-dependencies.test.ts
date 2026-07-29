import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCompositeGraphPatch,
  buildHierarchyFactBatch,
  buildModuleSourceFactBatch,
  createAnalyzerConfigSnapshot,
  createAnalyzerInputDigest,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import {
  buildGraphEntityId,
  buildGraphEdgeId,
  buildModuleEvidenceId,
  type HierarchyReadSetV1,
} from "../../packages/domain/src/index.js";
import {
  applyBootstrapMigration,
  applyDeterministicCommitMigration,
  applyModuleDependencyMigration,
  assertModuleDependencySchemaIntegrity,
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
  new (databasePath: string): RawSqliteDatabase;
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

/** 构造一次含 Node built-in 依赖的完整 composite patch。 */
function createPatch(
  snapshot: ReturnType<Awaited<ReturnType<typeof openSqliteGraphStore>>["readCommittedSnapshot"]>,
  detectedAt: string,
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
  const inputDigest = createAnalyzerInputDigest({
    analyzerKind: "typescript",
    configDigest: analyzerConfig.configDigest,
    inputs: manifest,
  }, digestPort);
  const readSet: HierarchyReadSetV1 = {
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
      .rejects.toThrow(/ownership|Evidence|恢复|摘要/u);
  });

  it("migrates to v3 and atomically persists module nodes, edges and source Evidence", async () => {
    const databasePath = await createDatabasePath();
    const store = await openSqliteGraphStore({ databasePath, digestPort, workspaceKey });
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
    const containsDirectoryId = buildGraphEdgeId(workspaceKey, rootId, "contains", directoryId);
    const containsSourceId = buildGraphEdgeId(workspaceKey, directoryId, "contains", sourceId);
    const containsOtherId = buildGraphEdgeId(workspaceKey, directoryId, "contains", otherSourceId);
    const moduleFromId = corruption === "source-kind" ? "node:path" : sourceId;
    const moduleRelationType = corruption === "invalid-qualifier" ? "exports" : "imports";
    const moduleQualifier = corruption === "invalid-qualifier"
      ? "reexport:%ZZ:name:value"
      : "value";
    const moduleEdgeId = buildGraphEdgeId(
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

    expect(() => assertModuleDependencySchemaIntegrity(database as never))
      .toThrow(/workspace|Evidence|拓扑/u);
    database.close();
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
    expect(() => assertModuleDependencySchemaIntegrity(runtime as never))
      .toThrow(/Evidence|词汇|provenance|evidence_kind/u);
    runtime.close();
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
});

/** 读取当前最高 migration 版本。 */
function databaseVersion(database: RawSqliteDatabase): number {
  return (database.prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number }).version;
}
