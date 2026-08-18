import { describe, expect, it } from "vitest";
import {
  extractModuleSyntaxFacts,
} from "../../packages/adapters/analyzer-typescript/src/index.js";
import {
  buildModuleSourceFactBatch,
} from "../../packages/application/src/index.js";
import {
  buildBasicSymbolId,
  buildGraphEntityId,
} from "../../packages/domain/src/index.js";

const workspaceKey = "6".repeat(64);

/** 将纯语法 seed 交给 application host 重算 file-scoped symbol 身份。 */
function buildSymbolBatch(
  relativePath: string,
  language: "javascript" | "javascriptreact" | "typescript" | "typescriptreact",
  sourceText: string,
) {
  const sourceFileId = buildGraphEntityId(workspaceKey, "file", relativePath);
  const syntax = extractModuleSyntaxFacts({
    language,
    path: relativePath,
    sourceFileId,
    sourceText,
  });
  return buildModuleSourceFactBatch({
    analyzerKind: "typescript",
    analyzerVersion: "6.0.3",
    configDigest: "1".repeat(64),
    coverage: "complete",
    detectedAt: "2026-08-17T00:00:00.000Z",
    diagnostics: syntax.diagnostics,
    inputDigest: "2".repeat(64),
    localExportBindings: syntax.localExportBindings,
    relativePath,
    relations: [],
    sourceFileId,
    symbolSeeds: syntax.symbols,
    workspaceKey,
  });
}

describe("Story 1.6 BasicSymbolV1", () => {
  it("extracts only the seven supported top-level declaration kinds", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescriptreact",
      path: "src/symbols.tsx",
      sourceFileId: buildGraphEntityId(workspaceKey, "file", "src/symbols.tsx"),
      sourceText: [
        "export function run(input: string): void {}",
        "export default class Widget { method() {} }",
        "export interface Shape { value: string }",
        "export type Alias = string | number;",
        "export enum Mode { A, B }",
        "const local = 1; export { local as publicLocal };",
        "export namespace Tools { export const nested = 1; }",
        "function outer(parameter: string) { const inner = 1; return parameter + inner; }",
        "import { helper as importedAlias } from './dep';",
        "export default () => null;",
        "declare module 'virtual-name' { export const value: string; }",
        "const element = <div />;",
        "const { excludedByBindingPattern } = { excludedByBindingPattern: 1 };",
        "run('call-only');",
      ].join("\n"),
    });

    expect(result.symbols.map(({ exported, kind, name }) => ({ exported, kind, name })))
      .toEqual([
        { exported: true, kind: "function", name: "run" },
        { exported: true, kind: "class", name: "Widget" },
        { exported: true, kind: "interface", name: "Shape" },
        { exported: true, kind: "type-alias", name: "Alias" },
        { exported: true, kind: "enum", name: "Mode" },
        { exported: true, kind: "variable", name: "local" },
        { exported: true, kind: "namespace", name: "Tools" },
        { exported: false, kind: "function", name: "outer" },
        { exported: false, kind: "variable", name: "element" },
      ]);
    expect(result.symbols.some((symbol) =>
      ["method", "parameter", "inner", "importedAlias", "nested",
        "excludedByBindingPattern"].includes(symbol.name)))
      .toBe(false);
  });

  it.each([
    ["typescript", "src/all.ts", [
      "function fn() {}", "class C {}", "interface I {}", "type T = string;",
      "enum E { A }", "const value = 1;", "namespace N {}",
    ].join("\n"), ["fn", "C", "I", "T", "E", "value", "N"]],
    ["typescriptreact", "src/all.tsx", [
      "function fn() { return <div />; }", "class C {}", "interface I {}",
      "type T = string;", "enum E { A }", "const value = <span />;", "namespace N {}",
    ].join("\n"), ["fn", "C", "I", "T", "E", "value", "N"]],
    ["javascript", "src/all.js", "function fn() {}\nclass C {}\nconst value = 1;", ["fn", "C", "value"]],
    ["javascriptreact", "src/all.jsx", "function fn() { return <div />; }\nclass C {}\nconst value = <span />;", ["fn", "C", "value"]],
  ] as const)("extracts supported declarations from %s fixtures", (language, path, sourceText, names) => {
    const batch = buildSymbolBatch(path, language, sourceText);

    expect(batch.symbols.map((symbol) => symbol.name).sort()).toEqual([...names].sort());
    expect(batch.symbols.every((symbol) => symbol.relativePath === path)).toBe(true);
  });

  it("uses implementation range for overloads and UTF-16 line/character positions", () => {
    const sourceText = [
      "// 😀 occupies two UTF-16 code units\r",
      "export function merge(value: string): string;\r",
      "export function merge(value: number): number;\r",
      "export function merge(value: string | number) { return value; }\r",
      "interface Split { left: string }\r",
      "interface Split { right: string }\r",
    ].join("\n");
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/merge.ts",
      sourceFileId: buildGraphEntityId(workspaceKey, "file", "src/merge.ts"),
      sourceText,
    });

    const merge = result.symbols.find((symbol) => symbol.name === "merge");
    const split = result.symbols.find((symbol) => symbol.name === "Split");
    expect(merge?.range).toEqual({
      end: { character: 21, line: 3 },
      start: { character: 16, line: 3 },
    });
    expect(split?.range).toEqual({
      end: { character: 15, line: 4 },
      start: { character: 10, line: 4 },
    });
    expect(result.symbols.filter((symbol) => symbol.name === "merge")).toHaveLength(1);
    expect(result.symbols.filter((symbol) => symbol.name === "Split")).toHaveLength(1);
  });

  it("builds deterministic file-scoped IDs and promotes local export aliases to symbol edges", () => {
    const relativePath = "src/exported.ts";
    const sourceFileId = buildGraphEntityId(workspaceKey, "file", relativePath);
    const syntax = extractModuleSyntaxFacts({
      language: "typescript",
      path: relativePath,
      sourceFileId,
      sourceText: "const local = 1; export { local as first, local as second };",
    });
    const batch = buildModuleSourceFactBatch({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      configDigest: "1".repeat(64),
      coverage: "complete",
      detectedAt: "2026-08-17T00:00:00.000Z",
      diagnostics: syntax.diagnostics,
      inputDigest: "2".repeat(64),
      localExportBindings: syntax.localExportBindings,
      relativePath,
      relations: [],
      sourceFileId,
      symbolSeeds: syntax.symbols,
      workspaceKey,
    });

    expect(batch.symbols).toHaveLength(1);
    expect(batch.symbols[0]).toMatchObject({ exported: true, kind: "variable", name: "local" });
    expect(batch.edges.map((edge) => edge.qualifier).sort()).toEqual([
      "local:first:value",
      "local:second:value",
    ]);
    expect(batch.edges.every((edge) => edge.fromId === sourceFileId &&
      edge.toId === batch.symbols[0]?.symbolId)).toBe(true);

    const seed = syntax.symbols[0]!;
    expect(buildBasicSymbolId({
      fileId: sourceFileId,
      kind: seed.kind,
      language: seed.language,
      qualifiedName: seed.qualifiedName,
      signatureDigest: seed.signatureDigest,
      workspaceKey,
    })).toBe(batch.symbols[0]?.symbolId);
  });

  it("promotes named default exports while excluding anonymous defaults and complex bindings", () => {
    const functionBatch = buildSymbolBatch(
      "src/default-function.ts",
      "typescript",
      "export default function namedDefault() {}",
    );
    const classBatch = buildSymbolBatch(
      "src/default-class.ts",
      "typescript",
      "export default class NamedClass {}",
    );
    const excludedBatch = buildSymbolBatch(
      "src/anonymous-default.ts",
      "typescript",
      "export default () => 1;\nconst { hidden } = { hidden: 1 }; export { hidden };",
    );

    expect(functionBatch.symbols).toEqual([
      expect.objectContaining({ exported: true, name: "namedDefault" }),
    ]);
    expect(classBatch.symbols).toEqual([
      expect.objectContaining({ exported: true, name: "NamedClass" }),
    ]);
    expect(functionBatch.edges.map((edge) => edge.qualifier)).toEqual(["default:value"]);
    expect(classBatch.edges.map((edge) => edge.qualifier)).toEqual(["default:value"]);
    expect(excludedBatch.symbols).toEqual([]);
    expect(excludedBatch.edges).toEqual([]);
  });

  it("keeps IDs stable across trivia, export and implementation-body changes", () => {
    const baseline = buildSymbolBatch(
      "src/stable.ts",
      "typescript",
      "export function run(value: string): number { return 1; }",
    );
    const relocated = buildSymbolBatch(
      "src/stable.ts",
      "typescript",
      "\n// 仅改变 trivia 和函数体\nfunction run ( value : string ) : number { return 2; }",
    );
    const semanticChange = buildSymbolBatch(
      "src/stable.ts",
      "typescript",
      "function run(value: number): number { return 2; }",
    );

    expect(relocated.symbols[0]?.symbolId).toBe(baseline.symbols[0]?.symbolId);
    expect(relocated.symbols[0]?.range).not.toEqual(baseline.symbols[0]?.range);
    expect(relocated.symbols[0]?.exported).toBe(false);
    expect(semanticChange.symbols[0]?.symbolId).not.toBe(baseline.symbols[0]?.symbolId);
  });

  it("normalizes Worker symbol enumeration before building IDs and facts", () => {
    const relativePath = "src/reordered.ts";
    const sourceFileId = buildGraphEntityId(workspaceKey, "file", relativePath);
    const syntax = extractModuleSyntaxFacts({
      language: "typescript",
      path: relativePath,
      sourceFileId,
      sourceText: "interface Zed {}\ninterface Alpha {}",
    });
    const build = (symbolSeeds: typeof syntax.symbols) => buildModuleSourceFactBatch({
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
      symbolSeeds,
      workspaceKey,
    });

    expect(build(syntax.symbols)).toEqual(build([...syntax.symbols].reverse()));
  });

  it("keeps same-file and cross-file ownership separate and rejects mixed-kind bindings", () => {
    const first = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/a.ts",
      sourceFileId: buildGraphEntityId(workspaceKey, "file", "src/a.ts"),
      sourceText: "interface Shared {} namespace SharedNamespace {} " +
        "namespace SharedNamespace {} " +
        "namespace Conflict {} interface Conflict {}",
    });
    const second = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/b.ts",
      sourceFileId: buildGraphEntityId(workspaceKey, "file", "src/b.ts"),
      sourceText: "interface Shared {} namespace SharedNamespace {}",
    });

    expect(first.symbols.map((symbol) => symbol.name)).toEqual(["Shared", "SharedNamespace"]);
    expect(second.symbols.map((symbol) => symbol.name)).toEqual(["Shared", "SharedNamespace"]);
    expect(first.symbols[0]?.sourceFileId).not.toBe(second.symbols[0]?.sourceFileId);
    const firstBatch = buildSymbolBatch(
      "src/a.ts",
      "typescript",
      "interface Shared {} namespace SharedNamespace {}",
    );
    const secondBatch = buildSymbolBatch(
      "src/b.ts",
      "typescript",
      "interface Shared {} namespace SharedNamespace {}",
    );
    expect(firstBatch.symbols.map((symbol) => symbol.symbolId)).not.toEqual(
      secondBatch.symbols.map((symbol) => symbol.symbolId),
    );
    expect(first.diagnostics).toContainEqual(expect.objectContaining({
      code: "BASIC_SYMBOL_KIND_CONFLICT",
    }));
  });
});
