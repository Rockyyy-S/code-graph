import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildCompositeGraphPatch,
  buildHierarchyFactBatch,
  buildModuleSourceFactBatch,
  type GraphStorePort,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import {
  buildGraphEntityId,
  createExternalPackageNode,
  type CommittedCompositeGraphSnapshotV1,
  type HierarchyReadSetV1,
  type ModuleSourceFactBatchV1,
} from "../../packages/domain/src/index.js";

const workspaceKey = "d".repeat(64);
const digestPort = { digest: sha256CanonicalJson };

/** 构造 Story 1.5 使用的完整 read-set。 */
function createReadSet(baseGraphRevision: number | null): HierarchyReadSetV1 {
  const manifest = [
    { contentHash: "1".repeat(64), path: "src/a.ts" },
    { contentHash: "2".repeat(64), path: "src/b.ts" },
  ] as const;
  return {
    baseGraphRevision,
    bootstrapGeneration: 3,
    configDigest: "3".repeat(64),
    effectiveIgnoreSnapshot: {
      builtinRulesVersion: "builtin-ignore-v1",
      contentHash: null,
      effectiveDigest: "4".repeat(64),
      effectiveRules: ["/.git/"],
      generation: 2,
      lastValidDigest: "4".repeat(64),
      userRules: [],
      validity: "valid",
      version: 1,
    },
    inputDigest: "5".repeat(64),
    manifest,
    manifestDigest: sha256CanonicalJson(manifest),
    statusEpoch: "story-1-5",
  };
}

/** 构造单个 source slice 的 imports FactBatch。 */
function createModuleBatch(
  sourcePath: "src/a.ts" | "src/b.ts",
  targetPath: "src/a.ts" | "src/b.ts",
  detectedAt: string,
): ModuleSourceFactBatchV1 {
  return buildModuleSourceFactBatch({
    analyzerKind: "typescript",
    analyzerVersion: "6.0.3",
    configDigest: "3".repeat(64),
    coverage: "complete",
    detectedAt,
    diagnostics: [],
    inputDigest: "5".repeat(64),
    localExportBindings: [],
    relations: [{
      confidence: "high",
      language: "typescript",
      normalizedRange: { end: 18, start: 7 },
      provenance: "typescript-compiler-api",
      qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
      relationType: "imports",
      target: {
        id: buildGraphEntityId(workspaceKey, "file", targetPath),
        kind: "internal-file",
        resolvedPath: targetPath,
      },
    }],
    sourceFileId: buildGraphEntityId(workspaceKey, "file", sourcePath),
    workspaceKey,
  });
}

describe("Story 1.5 composite graph patch", () => {
  it("locks the authoritative direct dependency and documents the stale readiness snapshot", async () => {
    const epics = await readFile("_bmad-output/planning-artifacts/epics.md", "utf8");
    const note = await readFile("docs/planning/story-1-5-authority.md", "utf8");

    expect(epics).toContain('"1.5": { dependsOn: ["1.19"] }');
    expect(note).toContain("implementation-readiness-report-2026-07-15.md");
    expect(note).toContain("StoryDependencyDagV1");
    expect(note).toContain("Story 1.10–1.13");
  });

  it("sorts multiple ownership slices and keeps slice enumeration outside patch identity", () => {
    const readSet = createReadSet(null);
    const hierarchy = buildHierarchyFactBatch({
      configDigest: readSet.configDigest,
      coverage: "complete",
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      producerVersion: "hierarchy-v1",
      relativePaths: readSet.manifest.map((entry) => entry.path),
      workspaceKey,
    });
    const batches = [
      createModuleBatch("src/b.ts", "src/a.ts", "2026-07-27T00:00:00.000Z"),
      createModuleBatch("src/a.ts", "src/b.ts", "2026-07-27T00:00:00.000Z"),
    ];
    const snapshot: CommittedCompositeGraphSnapshotV1 = {
      allEdges: [],
      allEvidence: [],
      allNodes: [],
      committedReadSet: null,
      graphRevision: null,
      ownedEdges: [],
      ownedNodes: [],
      ownedSlices: [],
      ownershipSliceId: hierarchy.ownershipSliceId,
      patchDigest: null,
    };
    const first = buildCompositeGraphPatch({
      digestPort,
      hierarchyBatch: hierarchy,
      moduleBatches: batches,
      readSet,
      snapshot,
    });
    const second = buildCompositeGraphPatch({
      digestPort,
      hierarchyBatch: hierarchy,
      moduleBatches: [...batches].reverse(),
      readSet,
      snapshot,
    });

    expect(first).toEqual(second);
    expect(first.slices.map((slice) => slice.ownershipSliceId)).toEqual(
      [...first.slices.map((slice) => slice.ownershipSliceId)].sort(),
    );
    expect(first.slices.filter((slice) => slice.ownershipSliceId.startsWith("source:"))
      .every((slice) => slice.nodeUpserts.length === 0 && slice.edgeUpserts.length === 0 &&
        slice.evidenceUpserts.length === 1)).toBe(true);
    expect(first.targetNodeCount).toBe(hierarchy.nodes.length);
    expect(first.targetEdgeCount).toBe(hierarchy.edges.length + 2);
  });

  it("treats detectedAt-only replay as a semantic no-op", () => {
    const readSet = createReadSet(7);
    const hierarchy = buildHierarchyFactBatch({
      configDigest: readSet.configDigest,
      coverage: "complete",
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      producerVersion: "hierarchy-v1",
      relativePaths: readSet.manifest.map((entry) => entry.path),
      workspaceKey,
    });
    const committedBatch = createModuleBatch(
      "src/a.ts",
      "src/b.ts",
      "2026-07-27T00:00:00.000Z",
    );
    const replayBatch = createModuleBatch(
      "src/a.ts",
      "src/b.ts",
      "2026-07-27T00:00:10.000Z",
    );
    const snapshot: CommittedCompositeGraphSnapshotV1 = {
      allEdges: [...hierarchy.edges, ...committedBatch.edges],
      allEvidence: committedBatch.evidence,
      allNodes: hierarchy.nodes,
      committedReadSet: null,
      graphRevision: 7,
      ownedEdges: hierarchy.edges,
      ownedNodes: hierarchy.nodes,
      ownedSlices: [{
        ownedEdges: [],
        ownedEvidence: committedBatch.evidence,
        ownedNodes: [],
        ownershipSliceId: committedBatch.ownershipSliceId,
      }],
      ownershipSliceId: hierarchy.ownershipSliceId,
      patchDigest: "6".repeat(64),
    };
    const replay = buildCompositeGraphPatch({
      digestPort,
      hierarchyBatch: hierarchy,
      moduleBatches: [replayBatch],
      readSet,
      snapshot,
    });

    expect(replay.slices.flatMap((slice) => [
      ...slice.nodeDeletes,
      ...slice.nodeUpserts,
      ...slice.edgeDeletes,
      ...slice.edgeUpserts,
      ...slice.evidenceDeletes,
      ...slice.evidenceUpserts,
    ])).toEqual([]);
    expect(replay.sharedEdgeDeletes).toEqual([]);
    expect(replay.sharedEdgeUpserts).toEqual([]);
    expect(replay.sharedNodeDeletes).toEqual([]);
    expect(replay.sharedNodeUpserts).toEqual([]);
  });

  it("retires removed source Evidence and its unsupported edge but preserves orphan shared nodes", () => {
    const readSet = createReadSet(4);
    const hierarchy = buildHierarchyFactBatch({
      configDigest: readSet.configDigest,
      coverage: "complete",
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      producerVersion: "hierarchy-v1",
      relativePaths: readSet.manifest.map((entry) => entry.path),
      workspaceKey,
    });
    const committedBatch = createModuleBatch(
      "src/a.ts",
      "src/b.ts",
      "2026-07-27T00:00:00.000Z",
    );
    const emptyBatch = buildModuleSourceFactBatch({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      configDigest: readSet.configDigest,
      coverage: "complete",
      detectedAt: "2026-07-27T00:00:10.000Z",
      diagnostics: [],
      inputDigest: readSet.inputDigest,
      localExportBindings: [],
      relations: [],
      sourceFileId: buildGraphEntityId(workspaceKey, "file", "src/a.ts"),
      workspaceKey,
    });
    const orphanPackage = createExternalPackageNode("orphan-package", "1.2.3");
    const patch = buildCompositeGraphPatch({
      digestPort,
      hierarchyBatch: hierarchy,
      moduleBatches: [emptyBatch],
      readSet,
      snapshot: {
        allEdges: [...hierarchy.edges, ...committedBatch.edges],
        allEvidence: committedBatch.evidence,
        allNodes: [...hierarchy.nodes, orphanPackage],
        committedReadSet: null,
        graphRevision: 4,
        ownedEdges: hierarchy.edges,
        ownedNodes: hierarchy.nodes,
        ownedSlices: [{
          ownedEdges: [],
          ownedEvidence: committedBatch.evidence,
          ownedNodes: [],
          ownershipSliceId: committedBatch.ownershipSliceId,
        }],
        ownershipSliceId: hierarchy.ownershipSliceId,
        patchDigest: "6".repeat(64),
      },
    });

    expect(patch.sharedEdgeDeletes).toEqual([committedBatch.edges[0]!.id]);
    expect(patch.sharedNodeDeletes).toEqual([]);
    expect(patch.slices.find((slice) =>
      slice.ownershipSliceId === committedBatch.ownershipSliceId)?.evidenceDeletes)
      .toEqual([committedBatch.evidence[0]!.id]);
    expect(patch.targetEdgeCount).toBe(hierarchy.edges.length);
    expect(patch.targetNodeCount).toBe(hierarchy.nodes.length + 1);
  });

  it("exposes only complete composite snapshots through GraphStorePort", () => {
    expectTypeOf<ReturnType<GraphStorePort["readCommittedSnapshot"]>>()
      .toEqualTypeOf<CommittedCompositeGraphSnapshotV1>();
  });
});
