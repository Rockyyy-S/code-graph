import { describe, expect, it } from "vitest";
import { buildModuleSourceFactBatch } from "../../packages/application/src/index.js";
import {
  buildGraphEntityId,
  createUnresolvedExternalPackageNode,
} from "../../packages/domain/src/index.js";

const workspaceKey = "c".repeat(64);

describe("Story 1.5 source module FactBatch", () => {
  it("owns evidence by source slice and deduplicates replay without using detectedAt in identity", () => {
    const sourceFileId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
    const targetFileId = buildGraphEntityId(workspaceKey, "file", "src/dep.ts");
    const create = (detectedAt: string) => buildModuleSourceFactBatch({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      configDigest: "1".repeat(64),
      coverage: "complete",
      detectedAt,
      diagnostics: [],
      inputDigest: "2".repeat(64),
      localExportBindings: [],
      relations: [{
        confidence: "high",
        language: "typescript",
        normalizedRange: { end: 20, start: 7 },
        provenance: "typescript-compiler-api",
        qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
        relationType: "imports",
        target: { id: targetFileId, kind: "internal-file", resolvedPath: "src/target.ts" },
      }],
      sourceFileId,
      workspaceKey,
    });
    const first = create("2026-07-27T00:00:00.000Z");
    const replay = create("2026-07-27T00:00:01.000Z");

    expect(first.ownershipSliceId).toBe(`source:typescript:${sourceFileId}`);
    expect(first.edges).toHaveLength(1);
    expect(first.evidence).toHaveLength(1);
    expect(first.evidence[0]?.id).toBe(replay.evidence[0]?.id);
    expect(first.edges[0]?.relationType).toBe("imports");
  });

  it("rejects non-canonical detectedAt values before building application facts", () => {
    expect(() => buildModuleSourceFactBatch({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      configDigest: "1".repeat(64),
      coverage: "complete",
      detectedAt: "2026-07-27T24:00:00.000Z",
      diagnostics: [],
      inputDigest: "2".repeat(64),
      localExportBindings: [],
      relations: [],
      sourceFileId: buildGraphEntityId(workspaceKey, "file", "src/index.ts"),
      workspaceKey,
    })).toThrow(/detectedAt/u);
  });

  it("preserves unresolved package state without treating it as a manifest version", () => {
    const sourceFileId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
    const batch = buildModuleSourceFactBatch({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      configDigest: "1".repeat(64),
      coverage: "complete",
      detectedAt: "2026-07-27T00:00:00.000Z",
      diagnostics: [],
      inputDigest: "2".repeat(64),
      localExportBindings: [],
      relations: [{
        confidence: "medium",
        language: "typescript",
        normalizedRange: { end: 10, start: 1 },
        provenance: "typescript-compiler-api",
        qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
        relationType: "imports",
        target: createUnresolvedExternalPackageNode("left-pad"),
      }],
      sourceFileId,
      workspaceKey,
    });

    expect(batch.nodes).toContainEqual(expect.objectContaining({
      id: "pkg:npm/left-pad@unresolved",
      packageVersion: null,
      versionState: "unresolved",
    }));
  });
});
