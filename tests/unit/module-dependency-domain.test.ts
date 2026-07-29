import { describe, expect, it } from "vitest";
import {
  buildGraphEdgeId,
  buildModuleEvidenceId,
  buildNpmPackagePurl,
  buildUnresolvedNpmPackagePurl,
  createUnresolvedExternalPackageNode,
  isCanonicalUtcTimestamp,
  normalizeNodeBuiltinId,
  serializeModuleQualifier,
} from "../../packages/domain/src/index.js";

const workspaceKey = "a".repeat(64);

describe("Story 1.5 module dependency domain", () => {
  it("extends edge identity without changing the committed contains identity", () => {
    const fromId = `cg://${workspaceKey}/file/src/a.ts`;
    const toId = `cg://${workspaceKey}/file/src/b.ts`;

    expect(buildGraphEdgeId(workspaceKey, fromId, "contains", toId)).toBe(
      `cg://${workspaceKey}/edge/${encodeURIComponent(`${fromId}\0contains\0${toId}\0`)}`,
    );
    expect(buildGraphEdgeId(workspaceKey, fromId, "imports", toId, "type"))
      .not.toBe(buildGraphEdgeId(workspaceKey, fromId, "imports", toId, "value"));
  });

  it("normalizes Node built-ins and standard npm purl identities", () => {
    expect(normalizeNodeBuiltinId("fs/promises")).toBe("node:fs/promises");
    expect(normalizeNodeBuiltinId("node:path")).toBe("node:path");
    expect(buildNpmPackagePurl("@scope/pkg", "1.2.3")).toBe(
      "pkg:npm/%40scope/pkg@1.2.3",
    );
    expect(buildUnresolvedNpmPackagePurl("left-pad")).toBe(
      "pkg:npm/left-pad@unresolved",
    );
    expect(createUnresolvedExternalPackageNode("left-pad")).toMatchObject({
      packageVersion: null,
      versionState: "unresolved",
    });
    expect(() => buildNpmPackagePurl("left-pad", "unresolved")).toThrow(/版本/u);
  });

  it("uses the closed AD-21 language and confidence vocabulary", async () => {
    const domain = await import("../../packages/domain/src/module-dependency.js");
    expect(domain).toBeDefined();
    const languages = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
    const confidences = ["high", "medium", "low"];
    expect(languages).toHaveLength(4);
    expect(confidences).toHaveLength(3);
  });

  it("serializes qualifiers reversibly and keeps evidence identity independent from detectedAt", () => {
    expect(serializeModuleQualifier({
      importedName: "a:b",
      kind: "reexport",
      exportedName: "c/d",
      typeOrValue: "type",
      version: 1,
    })).toBe("reexport:c%2Fd:a%3Ab:type");

    const evidence = {
      analyzerVersion: "6.0.3",
      edgeId: "edge-1",
      evidenceKind: "module-dependency" as const,
      normalizedRange: { end: 10, start: 2 },
      provenance: "typescript-compiler-api" as const,
      sourceFileId: "file-1",
    };
    expect(buildModuleEvidenceId(evidence)).toBe(buildModuleEvidenceId({ ...evidence }));
    expect(buildModuleEvidenceId(evidence)).not.toBe(buildModuleEvidenceId({
      ...evidence,
      normalizedRange: { end: 11, start: 2 },
    }));
  });

  it("keeps unusual ModuleExportName values distinct and rejects invalid SemVer", () => {
    expect(serializeModuleQualifier({
      exportedName: "",
      importedName: "value",
      kind: "reexport",
      typeOrValue: "value",
      version: 1,
    })).toBe("reexport:%u:value:value");
    expect(serializeModuleQualifier({
      exportedName: "\uD800",
      importedName: "value",
      kind: "reexport",
      typeOrValue: "value",
      version: 1,
    })).toBe("reexport:%uD800:value:value");
    expect(() => buildNpmPackagePurl("example", "01.2.3")).toThrow(/版本/u);
    expect(() => buildNpmPackagePurl("example", "1.2.3-..")).toThrow(/版本/u);
    expect(() => buildNpmPackagePurl("example", "1.2.3+..")).toThrow(/版本/u);
    expect(() => buildNpmPackagePurl("example", "1.2.3-01")).toThrow(/版本/u);
  });

  it("accepts only the unique RFC3339 UTC millisecond timestamp representation", () => {
    expect(isCanonicalUtcTimestamp("2026-07-27T23:59:59.999Z")).toBe(true);
    for (const value of [
      "2026-07-27T24:00:00.000Z",
      "2026-07-27T00:00:00Z",
      "2026-07-27T08:00:00.000+08:00",
      "2026-02-29T00:00:00.000Z",
    ]) {
      expect(isCanonicalUtcTimestamp(value)).toBe(false);
    }
  });
});
