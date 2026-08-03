import { describe, expect, it } from "vitest";
import {
  createAnalyzerConfigSnapshot,
  createAnalyzerInputDigest,
  normalizeEffectiveCompilerOptions,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";

const digestPort = { digest: sha256CanonicalJson };

describe("Story 1.5 analyzer config snapshot", () => {
  it("sorts semantic sets, preserves ordered options, and excludes host-only fields", () => {
    const effectiveCompilerOptions = normalizeEffectiveCompilerOptions({
      configFilePath: "C:\\secret\\tsconfig.json",
      module: "NodeNext",
      moduleSuffixes: [".native", ""],
      paths: { "@/*": ["src/*", "generated/*"] },
      rootDirs: ["generated", "src"],
      types: ["node", "vitest"],
    });

    expect(effectiveCompilerOptions).toEqual({
      module: "NodeNext",
      moduleSuffixes: [".native", ""],
      paths: { "@/*": ["src/*", "generated/*"] },
      rootDirs: ["generated", "src"],
      types: ["node", "vitest"],
    });
    expect(JSON.stringify(effectiveCompilerOptions)).not.toContain("secret");
  });

  it("preserves rootDirs declaration order because TypeScript resolution is order-sensitive", () => {
    const first = normalizeEffectiveCompilerOptions({ rootDirs: ["src", "generated"] });
    const second = normalizeEffectiveCompilerOptions({ rootDirs: ["generated", "src"] });

    expect(first).toEqual({ rootDirs: ["src", "generated"] });
    expect(second).toEqual({ rootDirs: ["generated", "src"] });
    expect(first).not.toEqual(second);
  });

  it("creates deterministic sorted snapshots and keeps rules.yaml outside analysis config", () => {
    const create = (consultedFiles: readonly { contentHash: string; path: string }[]) =>
      createAnalyzerConfigSnapshot({
        analyzerKind: "typescript",
        analyzerVersion: "6.0.3",
        consultedFiles,
        effectiveCompilerOptions: { module: "NodeNext" },
        effectiveIgnore: { effectiveDigest: "c".repeat(64), version: 1 },
        workspacePackages: [],
      }, digestPort);
    const first = create([
      { contentHash: "b".repeat(64), path: "tsconfig.base.json" },
      { contentHash: "a".repeat(64), path: "package.json" },
    ]);
    const second = create([...first.snapshot.consultedFiles].reverse());

    expect(first).toEqual(second);
    expect(first.snapshot.consultedFiles.map((entry) => entry.path)).toEqual([
      "package.json",
      "tsconfig.base.json",
    ]);
    expect(() => create([{ contentHash: "d".repeat(64), path: "rules.yaml" }]))
      .toThrow(/rules\.yaml/u);
    expect(first.snapshot.workspacePackages).toEqual([]);
  });

  it("CR8-005 preserves workspace package names in sorting and config digests", () => {
    const create = (workspacePackages: readonly { name: string; root: string }[]) =>
      createAnalyzerConfigSnapshot({
        analyzerKind: "typescript",
        analyzerVersion: "6.0.3",
        consultedFiles: [],
        effectiveCompilerOptions: {},
        effectiveIgnore: { effectiveDigest: "c".repeat(64), version: 1 },
        workspacePackages,
      }, digestPort);
    const first = create([
      { name: "zeta", root: "packages/z" },
      { name: "beta", root: "packages/a" },
      { name: "alpha", root: "packages/a" },
    ]);
    const reordered = create([
      { name: "alpha", root: "packages/a" },
      { name: "zeta", root: "packages/z" },
      { name: "beta", root: "packages/a" },
    ]);
    const renamed = create([
      { name: "alpha-renamed", root: "packages/a" },
      { name: "beta", root: "packages/a" },
      { name: "zeta", root: "packages/z" },
    ]);

    expect(first).toEqual(reordered);
    expect(first.snapshot.workspacePackages).toEqual([
      { name: "alpha", root: "packages/a" },
      { name: "beta", root: "packages/a" },
      { name: "zeta", root: "packages/z" },
    ]);
    expect(renamed.configDigest).not.toBe(first.configDigest);
  });

  it("rejects rules.yaml from every analyzer snapshot path collection", () => {
    const base = {
      analyzerKind: "typescript" as const,
      analyzerVersion: "6.0.3",
      consultedFiles: [],
      effectiveCompilerOptions: {},
      effectiveIgnore: { effectiveDigest: "c".repeat(64), version: 1 as const },
      workspacePackages: [],
    };
    expect(() => createAnalyzerConfigSnapshot({
      ...base,
      absentFiles: ["Rules.yaml"],
    }, digestPort)).toThrow(/rules\.yaml/iu);
    expect(() => createAnalyzerConfigSnapshot({
      ...base,
      absentResolutionFiles: ["config/RULES.YAML"],
    }, digestPort)).toThrow(/rules\.yaml/iu);
    expect(() => createAnalyzerConfigSnapshot({
      ...base,
      blockedResolutionFiles: [{ contentHash: "d".repeat(64), path: "rules.yaml" }],
    }, digestPort)).toThrow(/rules\.yaml/iu);
  });

  it("computes inputDigest from configDigest and canonically sorted source inputs", () => {
    const first = createAnalyzerInputDigest({
      analyzerKind: "typescript",
      configDigest: "a".repeat(64),
      inputs: [
        { contentHash: "2".repeat(64), path: "src/b.ts" },
        { contentHash: "1".repeat(64), path: "src/a.ts" },
      ],
    }, digestPort);
    const second = createAnalyzerInputDigest({
      analyzerKind: "typescript",
      configDigest: "a".repeat(64),
      inputs: [
        { contentHash: "1".repeat(64), path: "src/a.ts" },
        { contentHash: "2".repeat(64), path: "src/b.ts" },
      ],
    }, digestPort);

    expect(first).toBe(second);
  });
});
