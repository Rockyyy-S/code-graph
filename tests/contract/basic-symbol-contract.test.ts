import { describe, expect, expectTypeOf, it } from "vitest";
import { buildModuleSourceFactBatch } from "../../packages/application/src/index.js";
import {
  assertSourceRange,
  buildBasicSymbolId,
  buildGraphEdgeId,
  buildGraphEntityId,
  serializeModuleQualifier,
  type BasicSymbolV1,
  type NavigationTargetV1,
} from "../../packages/domain/src/index.js";

const workspaceKey = "8".repeat(64);
const relativePath = "src/contract.ts";
const sourceFileId = buildGraphEntityId(workspaceKey, "file", relativePath);

/** 构造一个由 host 重算身份的真实 BasicSymbolV1 事实。 */
function createContractSymbol(): BasicSymbolV1 {
  const batch = buildModuleSourceFactBatch({
    analyzerKind: "typescript",
    analyzerVersion: "6.0.3",
    configDigest: "1".repeat(64),
    coverage: "complete",
    detectedAt: "2026-08-17T00:00:00.000Z",
    diagnostics: [],
    inputDigest: "2".repeat(64),
    localExportBindings: [],
    relativePath,
    relations: [],
    sourceFileId,
    symbolSeeds: [{
      exported: false,
      kind: "function",
      language: "typescript",
      name: "run",
      qualifiedName: "run",
      range: {
        end: { character: 12, line: 1 },
        start: { character: 9, line: 1 },
      },
      signatureDigest: "3".repeat(64),
      sourceFileId,
    }],
    workspaceKey,
  });
  return batch.symbols[0]!;
}

describe("Story 1.6 BasicSymbolV1 contract", () => {
  it("locks the closed BasicSymbolV1 and SourceRangeV1 runtime shape", () => {
    const symbol = createContractSymbol();

    expect(Object.keys(symbol).sort()).toEqual([
      "exported", "kind", "name", "range", "relativePath", "symbolId",
    ]);
    expect(Object.keys(symbol.range).sort()).toEqual(["end", "start"]);
    expect(Object.keys(symbol.range.start).sort()).toEqual(["character", "line"]);
    expect(() => assertSourceRange(symbol.range)).not.toThrow();
    expect(() => assertSourceRange({
      end: { character: 9, line: 1 },
      start: { character: 9, line: 1 },
    })).toThrow(/non-empty|\u975e\u7a7a/u);
  });

  it("keeps symbol identity limited to file scope and canonical declaration semantics", () => {
    const input = {
      fileId: sourceFileId,
      kind: "function" as const,
      language: "typescript" as const,
      qualifiedName: "run",
      signatureDigest: "3".repeat(64),
      workspaceKey,
    };

    expect(buildBasicSymbolId(input)).toBe(createContractSymbol().symbolId);
    expect(buildBasicSymbolId({ ...input, signatureDigest: "4".repeat(64) }))
      .not.toBe(buildBasicSymbolId(input));
  });

  it("keeps local and default export qualifiers reversible and collision-free", () => {
    const local = serializeModuleQualifier({
      exportedName: "alias:with~markers",
      kind: "local",
      typeOrValue: "type",
      version: 1,
    });
    const defaultQualifier = serializeModuleQualifier({
      kind: "default",
      typeOrValue: "type",
      version: 1,
    });

    expect(local).toBe("local:alias%3Awith%7Emarkers:type");
    expect(defaultQualifier).toBe("default:type");
    expect(buildGraphEdgeId(workspaceKey, sourceFileId, "exports", "symbol-target", local))
      .not.toBe(buildGraphEdgeId(
        workspaceKey,
        sourceFileId,
        "exports",
        "symbol-target",
        defaultQualifier,
      ));
  });

  it("exposes a direct symbol branch for NavigationTargetV1", () => {
    const symbol = createContractSymbol();
    const target: NavigationTargetV1 = {
      range: symbol.range,
      relativePath: symbol.relativePath,
      symbolId: symbol.symbolId,
      targetKind: "symbol",
    };

    expectTypeOf(target).toMatchTypeOf<NavigationTargetV1>();
    expect(target).toEqual(expect.objectContaining({ targetKind: "symbol" }));
  });
});
