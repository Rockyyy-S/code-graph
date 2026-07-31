import { describe, expect, it } from "vitest";
import { resolveModuleTarget } from "../../packages/adapters/analyzer-typescript/src/index.js";
import { buildGraphEntityId } from "../../packages/domain/src/index.js";

const workspaceKey = "b".repeat(64);

describe("Story 1.5 module target priority", () => {
  it("prioritizes Node built-ins before internal and package resolution", () => {
    expect(resolveModuleTarget({
      indexingManifest: [],
      sourcePath: "src/index.ts",
      specifier: "fs/promises",
      workspaceKey,
    })).toMatchObject({
      confidence: "high",
      target: { id: "node:fs/promises", kind: "node-builtin" },
    });
  });

  it("reuses manifest file identities and never treats node_modules as internal", () => {
    expect(resolveModuleTarget({
      indexingManifest: [{ fileId: buildGraphEntityId(workspaceKey, "file", "src/dep.ts"), path: "src/dep.ts" }],
      resolvedLogicalPath: "src/dep.ts",
      sourcePath: "src/index.ts",
      specifier: "./dep",
      workspaceKey,
    })).toMatchObject({
      confidence: "high",
      target: { id: buildGraphEntityId(workspaceKey, "file", "src/dep.ts"), kind: "internal-file" },
    });
    expect(resolveModuleTarget({
      indexingManifest: [{ fileId: "wrong", path: "node_modules/pkg/index.d.ts" }],
      resolvedLogicalPath: "node_modules/pkg/index.d.ts",
      resolvedPackage: { name: "pkg", version: "2.0.0" },
      sourcePath: "src/index.ts",
      specifier: "pkg",
      workspaceKey,
    })).toMatchObject({
      confidence: "high",
      target: { id: "pkg:npm/pkg@2.0.0", kind: "external-package" },
    });
  });

  it("uses medium unresolved purl for bare specifiers and diagnostics only for relative misses", () => {
    expect(resolveModuleTarget({
      indexingManifest: [],
      sourcePath: "src/index.ts",
      specifier: "@scope/pkg/subpath",
      workspaceKey,
    })).toMatchObject({
      confidence: "medium",
      target: { id: "pkg:npm/%40scope/pkg@unresolved", kind: "external-package" },
    });
    expect(resolveModuleTarget({
      indexingManifest: [],
      sourcePath: "src/index.ts",
      specifier: "./missing",
      workspaceKey,
    })).toMatchObject({
      diagnostic: { code: "MODULE_RELATIVE_TARGET_UNRESOLVED", path: "src/index.ts" },
      target: null,
    });
  });

  it("CR6-009 accepts plus signs in legal npm subpath segments", () => {
    expect(resolveModuleTarget({
      indexingManifest: [],
      sourcePath: "src/index.ts",
      specifier: "pkg/feature+debug",
      workspaceKey,
    })).toMatchObject({
      confidence: "medium",
      target: {
        id: "pkg:npm/pkg@unresolved",
        kind: "external-package",
        packageName: "pkg",
      },
    });
  });

  it.each(["pkg/feature@debug", "pkg/feature!debug"])(
    "CR8-006 accepts legal npm bare subpath punctuation in %s",
    (specifier) => {
      expect(resolveModuleTarget({
        indexingManifest: [],
        sourcePath: "src/index.ts",
        specifier,
        workspaceKey,
      })).toMatchObject({
        confidence: "medium",
        target: {
          id: "pkg:npm/pkg@unresolved",
          kind: "external-package",
          packageName: "pkg",
        },
      });
    },
  );

  it("CR8-006 rejects encoded separators, encoded dot segments, and URL semantics", () => {
    for (const specifier of [
      "pkg/%2fescape",
      "pkg/%5Cescape",
      "pkg/%2e%2e/escape",
      "pkg/feature?query",
      "pkg/feature#fragment",
    ]) {
      expect(resolveModuleTarget({
        indexingManifest: [],
        sourcePath: "src/index.ts",
        specifier,
        workspaceKey,
      })).toMatchObject({
        diagnostic: { code: "MODULE_SPECIFIER_INVALID" },
        target: null,
      });
    }
  });

  it("CR8-002 applies host casing to node_modules boundaries and manifest lookup", () => {
    const manifestPath = "NODE_MODULES/pkg/index.d.ts";
    const external = resolveModuleTarget({
      caseSensitiveFileNames: false,
      indexingManifest: [{ fileId: "must-not-be-internal", path: manifestPath }],
      resolvedLogicalPath: manifestPath,
      resolvedPackage: { name: "pkg", version: "1.2.3" },
      sourcePath: "src/index.ts",
      specifier: "pkg",
      workspaceKey,
    });
    const sensitive = resolveModuleTarget({
      caseSensitiveFileNames: true,
      indexingManifest: [{ fileId: "case-sensitive-file", path: manifestPath }],
      resolvedLogicalPath: manifestPath,
      sourcePath: "src/index.ts",
      specifier: "./unexpected",
      workspaceKey,
    });

    expect(external).toMatchObject({
      target: { id: "pkg:npm/pkg@1.2.3", kind: "external-package" },
    });
    expect(sensitive).toMatchObject({
      target: { id: "case-sensitive-file", kind: "internal-file" },
    });
  });

  it("does not disguise a resolved external file with invalid metadata as unresolved", () => {
    expect(resolveModuleTarget({
      indexingManifest: [],
      resolvedLogicalPath: "node_modules/broken/index.d.ts",
      resolutionKind: "value",
      sourcePath: "src/index.ts",
      specifier: "broken",
      workspaceKey,
    })).toMatchObject({
      diagnostic: { code: "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID" },
      target: null,
    });
    expect(resolveModuleTarget({
      indexingManifest: [],
      resolvedLogicalPath: "node_modules/broken/index.d.ts",
      resolvedPackage: { name: "Bad Package", version: "not-semver" },
      resolutionKind: "value",
      sourcePath: "src/index.ts",
      specifier: "broken",
      workspaceKey,
    })).toMatchObject({
      diagnostic: { code: "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID" },
      target: null,
    });
  });

  it("fails closed when a bare paths alias resolves to a root file outside the manifest", () => {
    expect(resolveModuleTarget({
      indexingManifest: [],
      resolvedLogicalPath: "config/data.json",
      resolutionKind: "value",
      sourcePath: "src/index.ts",
      specifier: "app-config",
      workspaceKey,
    })).toMatchObject({
      diagnostic: { code: "MODULE_RESOLUTION_FAILED" },
      target: null,
    });
  });

  it("rejects non-npm bare identities without throwing or fabricating purls", () => {
    for (const specifier of ["", "#internal", "https://example.test/mod.js", "node:not-real", "@scope"]) {
      expect(() => resolveModuleTarget({
        indexingManifest: [],
        sourcePath: "src/index.ts",
        specifier,
        workspaceKey,
      })).not.toThrow();
      expect(resolveModuleTarget({
        indexingManifest: [],
        sourcePath: "src/index.ts",
        specifier,
        workspaceKey,
      })).toMatchObject({
        diagnostic: { code: "MODULE_SPECIFIER_INVALID" },
        target: null,
      });
    }
  });

  it("keeps literal dynamic imports low-confidence even when the target resolves", () => {
    expect(resolveModuleTarget({
      indexingManifest: [{ fileId: "file-dep", path: "src/dep.ts" }],
      resolvedLogicalPath: "src/dep.ts",
      resolutionKind: "dynamic",
      sourcePath: "src/index.ts",
      specifier: "./dep.js",
      workspaceKey,
    })).toMatchObject({ confidence: "low", target: { id: "file-dep" } });
  });

  it("downgrades resolved internal targets when project ownership context is incomplete", () => {
    expect(resolveModuleTarget({
      indexingManifest: [{ fileId: "file-dep", path: "src/dep.ts" }],
      projectContextComplete: false,
      resolvedLogicalPath: "src/dep.ts",
      resolutionKind: "value",
      sourcePath: "src/index.ts",
      specifier: "./dep.js",
      workspaceKey,
    })).toMatchObject({ confidence: "medium", target: { id: "file-dep" } });
  });

  it("CR9-003 downgrades resolved builtins and external packages for incomplete projects", () => {
    expect(resolveModuleTarget({
      indexingManifest: [],
      projectContextComplete: false,
      resolutionKind: "value",
      sourcePath: "src/index.ts",
      specifier: "node:path",
      workspaceKey,
    })).toMatchObject({ confidence: "medium", target: { id: "node:path" } });
    expect(resolveModuleTarget({
      indexingManifest: [],
      projectContextComplete: false,
      resolvedLogicalPath: "node_modules/example/index.d.ts",
      resolvedPackage: { name: "example", version: "1.2.3" },
      resolutionKind: "value",
      sourcePath: "src/index.ts",
      specifier: "example",
      workspaceKey,
    })).toMatchObject({
      confidence: "medium",
      target: { id: "pkg:npm/example@1.2.3" },
    });
  });

  it("indexes a manifest once and reuses it across relation resolution", () => {
    let pathReads = 0;
    const manifest = Array.from({ length: 200 }, (_, index) => {
      const entry = { fileId: `file-${index}` } as { fileId: string; path: string };
      Object.defineProperty(entry, "path", {
        enumerable: true,
        get: () => {
          pathReads += 1;
          return `src/dep-${index}.ts`;
        },
      });
      return entry;
    });

    for (let index = 0; index < 200; index += 1) {
      expect(resolveModuleTarget({
        indexingManifest: manifest,
        projectContextComplete: true,
        resolvedLogicalPath: `src/dep-${index}.ts`,
        sourcePath: "src/index.ts",
        specifier: `./dep-${index}.js`,
        workspaceKey,
      }).target).toMatchObject({ id: `file-${index}`, kind: "internal-file" });
    }

    expect(pathReads).toBeLessThanOrEqual(manifest.length * 2);
  });

  it("rejects non-canonical SemVer package metadata", () => {
    for (const version of ["unresolved", "01.2.3", "1.2.3-..", "1.2.3+..", "1.2.3-01"]) {
      expect(resolveModuleTarget({
        indexingManifest: [],
        resolvedLogicalPath: "node_modules/example/index.d.ts",
        resolvedPackage: { name: "example", version },
        sourcePath: "src/index.ts",
        specifier: "example",
        workspaceKey,
      })).toMatchObject({
        diagnostic: { code: "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID" },
        target: null,
      });
    }
  });
});
