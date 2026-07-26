import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildHierarchyFactBatch,
  buildHierarchyGraphPatch,
  type CanonicalDigestPort,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import type {
  CommittedGraphSnapshotV1,
  HierarchyReadSetV1,
} from "../../packages/domain/src/index.js";

const workspaceKey = "a".repeat(64);

/** 使用跨边界权威 JCS 实现模拟组合根注入的 digest 端口。 */
const digestPort: CanonicalDigestPort = {
  digest: sha256CanonicalJson,
};

/** 构造不含已提交事实的确定性基线。 */
function emptySnapshot(baseGraphRevision: number | null): CommittedGraphSnapshotV1 {
  return {
    committedReadSet: null,
    graphRevision: baseGraphRevision,
    ownedEdges: [],
    ownedNodes: [],
    ownershipSliceId: `hierarchy:cg://${workspaceKey}/workspace/`,
    patchDigest: null,
  };
}

/** 构造完整 hierarchy read-set，便于逐字段验证 CAS 与语义 digest 分离。 */
function createReadSet(overrides: Partial<HierarchyReadSetV1> = {}): HierarchyReadSetV1 {
  const manifest = [
    { contentHash: "1".repeat(64), path: "src/a.ts" },
    { contentHash: "2".repeat(64), path: "src/b.ts" },
  ] as const;
  return {
    baseGraphRevision: null,
    bootstrapGeneration: 0,
    configDigest: "3".repeat(64),
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
    inputDigest: "5".repeat(64),
    manifest,
    manifestDigest: "6".repeat(64),
    statusEpoch: "epoch-story-1-19",
    ...overrides,
  };
}

describe("Story 1.19 deterministic hierarchy contracts", () => {
  it("locks the authoritative direct dependency to Story 1.4 only", async () => {
    const source = await readFile("_bmad-output/planning-artifacts/epics.md", "utf8");
    const dependency = /^\s+"1\.19": \{ dependsOn: \[(.*?)\] \}$/mu.exec(source)?.[1];

    expect(dependency).toBe('"1.4"');
    expect(source).toContain('"1.5": { dependsOn: ["1.19"] }');
    expect(source).toContain('"1.12": { dependsOn: ["1.11", "1.19"] }');
    expect(source).toContain('"1.15": { dependsOn: ["1.19"] }');
  });

  it("builds the same complete FactBatch and ownership slice for any input order", () => {
    const first = buildHierarchyFactBatch({
      configDigest: "3".repeat(64),
      coverage: "complete",
      inputDigest: "5".repeat(64),
      manifestDigest: "6".repeat(64),
      producerVersion: "hierarchy-v1",
      relativePaths: ["src/b.ts", "src/a.ts", "src/a.ts"],
      workspaceKey,
    });
    const second = buildHierarchyFactBatch({
      configDigest: "3".repeat(64),
      coverage: "complete",
      inputDigest: "5".repeat(64),
      manifestDigest: "6".repeat(64),
      producerVersion: "hierarchy-v1",
      relativePaths: ["src/a.ts", "src/b.ts"],
      workspaceKey,
    });

    expect(first).toEqual(second);
    expect(first.indexingRootId).toBe(`cg://${workspaceKey}/workspace/`);
    expect(first.ownershipSliceId).toBe(`hierarchy:cg://${workspaceKey}/workspace/`);
    expect(first.nodes.map((node) => node.id)).toEqual([...first.nodes.map((node) => node.id)].sort());
    expect(first.edges.map((edge) => edge.id)).toEqual([...first.edges.map((edge) => edge.id)].sort());
  });

  it("creates deterministic patches and keeps CAS generations outside patchDigest", () => {
    const batch = buildHierarchyFactBatch({
      configDigest: "3".repeat(64),
      coverage: "complete",
      inputDigest: "5".repeat(64),
      manifestDigest: "6".repeat(64),
      producerVersion: "hierarchy-v1",
      relativePaths: ["src/b.ts", "src/a.ts"],
      workspaceKey,
    });
    const first = buildHierarchyGraphPatch({
      batch,
      digestPort,
      readSet: createReadSet(),
      snapshot: emptySnapshot(null),
    });
    const second = buildHierarchyGraphPatch({
      batch,
      digestPort,
      readSet: createReadSet({
        baseGraphRevision: 7,
        bootstrapGeneration: 9,
        effectiveIgnoreSnapshot: {
          ...createReadSet().effectiveIgnoreSnapshot,
          generation: 11,
        },
      }),
      snapshot: emptySnapshot(7),
    });

    expect(first.patchDigest).toBe(second.patchDigest);
    expect(first.nodeUpserts.map((node) => node.id)).toEqual(
      [...first.nodeUpserts.map((node) => node.id)].sort(),
    );
    expect(first.edgeUpserts.map((edge) => edge.id)).toEqual(
      [...first.edgeUpserts.map((edge) => edge.id)].sort(),
    );
  });

  it("rejects revision zero because committed graph revisions start at one", () => {
    const readSet = createReadSet({ baseGraphRevision: 0 });
    const batch = buildHierarchyFactBatch({
      configDigest: readSet.configDigest,
      coverage: "complete",
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      producerVersion: "hierarchy-v1",
      relativePaths: readSet.manifest.map((entry) => entry.path),
      workspaceKey,
    });

    expect(() => buildHierarchyGraphPatch({
      batch,
      digestPort,
      readSet,
      snapshot: emptySnapshot(0),
    })).toThrow(/revision\/generation/u);
  });

  it("produces an empty semantic patch for an identical owned snapshot", () => {
    const readSet = createReadSet({ baseGraphRevision: 4 });
    const batch = buildHierarchyFactBatch({
      configDigest: readSet.configDigest,
      coverage: "complete",
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      producerVersion: "hierarchy-v1",
      relativePaths: readSet.manifest.map((entry) => entry.path),
      workspaceKey,
    });
    const initial = buildHierarchyGraphPatch({
      batch,
      digestPort,
      readSet,
      snapshot: emptySnapshot(4),
    });
    const replay = buildHierarchyGraphPatch({
      batch,
      digestPort,
      readSet,
      snapshot: {
        committedReadSet: null,
        graphRevision: 4,
        ownedEdges: initial.edgeUpserts,
        ownedNodes: initial.nodeUpserts,
        ownershipSliceId: batch.ownershipSliceId,
        patchDigest: initial.patchDigest,
      },
    });

    expect(replay).toMatchObject({
      edgeDeletes: [],
      edgeUpserts: [],
      nodeDeletes: [],
      nodeUpserts: [],
    });
    expect(replay.patchDigest).toBe(initial.patchDigest);
  });

  it("never creates a replacement patch for partial or failed coverage", () => {
    for (const coverage of ["partial", "failed"] as const) {
      const batch = buildHierarchyFactBatch({
        configDigest: "3".repeat(64),
        coverage,
        inputDigest: "5".repeat(64),
        manifestDigest: "6".repeat(64),
        producerVersion: "hierarchy-v1",
        relativePaths: ["src/a.ts"],
        workspaceKey,
      });

      expect(() => buildHierarchyGraphPatch({
        batch,
        digestPort,
        readSet: createReadSet(),
        snapshot: emptySnapshot(null),
      })).toThrow(/complete/u);
    }
  });
});
