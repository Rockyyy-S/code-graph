import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  extractModuleSyntaxFacts,
  type ExtractModuleSyntaxFactsOptions,
} from "../../packages/adapters/analyzer-typescript/src/index.js";

describe("Story 1.5 AD-24 TypeScript syntax mapping", () => {
  it("maps static, type-only, dynamic, require, import-equals and re-export syntax uniquely", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/index.ts",
      sourceFileId: "file-index",
      sourceText: [
        'import value, { type Shape, helper } from "./dep";',
        'import "./side-effect";',
        'import legacy = require("legacy");',
        'const lazy = import("./lazy");',
        'const cjs = require("cjs-only");',
        'export { type Shape as PublicShape, helper as publicHelper } from "./dep";',
        'export type * from "./types";',
        'export { helper as localHelper };',
        'export default value;',
      ].join("\n"),
    });

    expect(result.relations.map(({ qualifier, relationType, specifier }) => ({
      qualifier,
      relationType,
      specifier,
    }))).toEqual(expect.arrayContaining([
      { qualifier: "type", relationType: "imports", specifier: "./dep" },
      { qualifier: "value", relationType: "imports", specifier: "./dep" },
      { qualifier: "value", relationType: "imports", specifier: "./side-effect" },
      { qualifier: "value", relationType: "imports", specifier: "legacy" },
      { qualifier: "dynamic", relationType: "imports", specifier: "./lazy" },
      { qualifier: "value", relationType: "imports", specifier: "cjs-only" },
      {
        qualifier: "reexport:PublicShape:Shape:type",
        relationType: "exports",
        specifier: "./dep",
      },
      {
        qualifier: "reexport:publicHelper:helper:value",
        relationType: "exports",
        specifier: "./dep",
      },
      { qualifier: "star:type", relationType: "exports", specifier: "./types" },
    ]));
    expect(result.localExportBindings.map((binding) => binding.exportedName))
      .toEqual(expect.arrayContaining(["localHelper", "default"]));
    expect(result.relations.every((relation) => relation.normalizedRange.start >= 0 &&
      relation.normalizedRange.end > relation.normalizedRange.start)).toBe(true);
  });

  it("does not invent precise edges for non-literal dynamic syntax or internal aliases", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/index.ts",
      sourceFileId: "file-index",
      sourceText: [
        "import alias = Namespace.Value;",
        "const name = './runtime';",
        "import(name);",
        "require(name);",
      ].join("\n"),
    });

    expect(result.relations).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "MODULE_DYNAMIC_SPECIFIER_NOT_LITERAL",
      "MODULE_REQUIRE_SPECIFIER_NOT_LITERAL",
    ]);
  });

  it("CR6-010 treats no-substitution template literals as exact import and require specifiers", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/templates.ts",
      sourceFileId: "file-templates",
      sourceText: [
        "const lazy = import(`./lazy.js`);",
        "const legacy = require(`legacy-package`);",
      ].join("\n"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifier: "dynamic", specifier: "./lazy.js" }),
      expect.objectContaining({ qualifier: "value", specifier: "legacy-package" }),
    ]));
  });

  it("keeps empty import/export requests and emits every Story 1.5 local export seed", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/exports.ts",
      sourceFileId: "file-exports",
      sourceText: [
        'import {} from "side-effect-import";',
        'export {} from "side-effect-export";',
        "export const value = 1;",
        "export function run() {}",
        "export class Service {}",
        "export type Shape = { value: number };",
        "export interface Contract { value: number }",
        "export enum State { Ready }",
        "export default function namedDefault() {}",
        "export default class {}",
        "const legacy = 1; export = legacy;",
      ].join("\n"),
    });

    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: "imports", specifier: "side-effect-import" }),
      expect.objectContaining({ relationType: "imports", specifier: "side-effect-export" }),
    ]));
    expect(result.localExportBindings.map(({ exportedName, localName, typeOrValue }) => ({
      exportedName,
      localName,
      typeOrValue,
    }))).toEqual(expect.arrayContaining([
      { exportedName: "value", localName: "value", typeOrValue: "value" },
      { exportedName: "run", localName: "run", typeOrValue: "value" },
      { exportedName: "Service", localName: "Service", typeOrValue: "value" },
      { exportedName: "Shape", localName: "Shape", typeOrValue: "type" },
      { exportedName: "Contract", localName: "Contract", typeOrValue: "type" },
      { exportedName: "State", localName: "State", typeOrValue: "value" },
      { exportedName: "default", localName: "namedDefault", typeOrValue: "value" },
      { exportedName: "default", localName: "default", typeOrValue: "value" },
    ]));
    expect(result.localExportBindings).not.toContainEqual(expect.objectContaining({
      exportedName: "default",
      localName: "legacy",
    }));
  });

  it("records the public import/require resolution mode for each AST usage", () => {
    const result = extractModuleSyntaxFacts({
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      language: "typescript",
      path: "src/modes.ts",
      sourceFileId: "file-modes",
      sourceText: [
        'import value from "conditional";',
        'const legacy = require("conditional");',
        'const lazy = import("conditional");',
      ].join("\n"),
    });

    expect(result.relations.map((relation) => relation.resolutionMode)).toEqual([
      "import",
      "require",
      "import",
    ]);
  });

  it("uses the package-derived implied Node format for NodeNext static imports", () => {
    /** 显式绑定公共合同，避免枚举成员在对象夹具中被宽化为整个 ModuleKind。 */
    const input: ExtractModuleSyntaxFactsOptions = {
      compilerOptions: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      },
      impliedNodeFormat: ts.ModuleKind.ESNext,
      language: "typescript" as const,
      path: "src/esm.ts",
      sourceFileId: "file-esm",
      sourceText: 'import value from "conditional";\nvoid value;\n',
    };

    const result = extractModuleSyntaxFacts(input);

    expect(result.relations[0]?.typescriptResolutionMode).toBe(ts.ModuleKind.ESNext);
  });

  it("emits only the file-level namespace export seed", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/namespaces.ts",
      sourceFileId: "file-namespaces",
      sourceText: [
        "export namespace PublicApi {",
        "  export const nestedValue = 1;",
        "  export namespace Nested { export const deeper = 1; }",
        "}",
        "namespace PrivateApi { export const hidden = 1; }",
      ].join("\n"),
    });

    expect(result.localExportBindings.map(({ exportedName, localName }) => ({
      exportedName,
      localName,
    }))).toEqual([{ exportedName: "PublicApi", localName: "PublicApi" }]);
  });

  it("serializes empty and lone-surrogate ModuleExportName values without terminating analysis", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/unusual-exports.ts",
      sourceFileId: "file-unusual-exports",
      sourceText: [
        'export { value as "" } from "./dep";',
        'export { value as "\\uD800" } from "./dep";',
      ].join("\n"),
    });

    expect(result.relations.filter((relation) => relation.relationType === "exports")
      .map((relation) => relation.qualifier)).toEqual([
        "reexport:%u:value:value",
        "reexport:%uD800:value:value",
      ]);
  });

  it("ignores require calls shadowed by lexical declarations", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/shadowed-require.ts",
      sourceFileId: "file-shadowed-require",
      sourceText: [
        'require("global-dependency");',
        'function byParameter(require: (name: string) => unknown) { require("parameter"); }',
        'function byLocal() { const require = () => undefined; require("local"); }',
        'try { throw new Error(); } catch (require) { require("catch"); }',
      ].join("\n"),
    });

    expect(result.relations.map((relation) => relation.specifier)).toEqual([
      "global-dependency",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps loop-header let/const require bindings inside the loop lexical scope", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/loop-require.ts",
      sourceFileId: "file-loop-require",
      sourceText: [
        'require("before");',
        'for (let require = () => undefined; false; ) { require("for-body"); }',
        'require("after-for");',
        'for (const require in { value: 1 }) { require("for-in-body"); }',
        'require("after-for-in");',
        'for (const require of [() => undefined]) { require("for-of-body"); }',
        'require("after-for-of");',
      ].join("\n"),
    });

    expect(result.relations.map((relation) => relation.specifier)).toEqual([
      "before",
      "after-for",
      "after-for-in",
      "after-for-of",
    ]);
  });

  it("does not let type-only imports named require shadow the runtime CommonJS binding", () => {
    const cases = [
      'import type require from "types-default";',
      'import { type Shape as require } from "types-named";',
      'import { type require, value } from "types-mixed";',
      'import type require = require("types-equals");',
    ];
    for (const [index, declaration] of cases.entries()) {
      const result = extractModuleSyntaxFacts({
        language: "typescript",
        path: `src/type-only-require-${index}.ts`,
        sourceFileId: `file-type-only-require-${index}`,
        sourceText: `${declaration}\nrequire("runtime-${index}");\n`,
      });

      expect(result.relations.map((relation) => relation.specifier)).toContain(`runtime-${index}`);
    }
  });

  it("unwraps transparent default-export expressions before choosing the local binding", () => {
    const result = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/default-wrappers.ts",
      sourceFileId: "file-default-wrappers",
      sourceText: [
        "declare const foo: unknown;",
        "export default ((((foo as unknown)!) satisfies unknown));",
      ].join("\n"),
    });

    expect(result.localExportBindings).toEqual([
      expect.objectContaining({ exportedName: "default", localName: "foo" }),
    ]);
  });

  it("ignores ambient require declarations while preserving real lexical shadowing", () => {
    const ambient = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/ambient-require.ts",
      sourceFileId: "file-ambient-require",
      sourceText: [
        "declare const require: (name: string) => unknown;",
        "declare namespace Types { const require: (name: string) => unknown; }",
        'require("top-level-runtime");',
      ].join("\n"),
    });
    const real = extractModuleSyntaxFacts({
      language: "typescript",
      path: "src/real-require.ts",
      sourceFileId: "file-real-require",
      sourceText: [
        "const require = (name: string) => name;",
        'require("shadowed-by-const");',
        'function f(require: (name: string) => unknown) { require("shadowed-by-parameter"); }',
      ].join("\n"),
    });

    expect(ambient.relations.map((relation) => relation.specifier))
      .toContain("top-level-runtime");
    expect(real.relations).toEqual([]);
  });
});
