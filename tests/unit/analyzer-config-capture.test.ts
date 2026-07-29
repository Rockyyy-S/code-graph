import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyzerByteFileV1,
  AnalyzerPort,
} from "../../packages/application/src/index.js";
import {
  createAnalyzerConfigSnapshot,
  createAnalyzerInputDigest,
} from "../../packages/application/src/index.js";
import {
  MAX_ANALYZER_METADATA_FILE_BYTES,
  MAX_ANALYZER_METADATA_GRAPH_DEPTH,
  MAX_ANALYZER_METADATA_TOTAL_BYTES,
  MAX_ANALYZER_RESOLUTION_FILES,
  MAX_ANALYZER_RESOLUTION_CANDIDATES,
  createAnalyzerSemanticContextCapture,
  hashAnalyzerSourceStreamBounded,
  readAnalyzerBytesBounded,
  readAnalyzerCaptureMetricsForTests,
  resetAnalyzerCaptureMetricsForTests,
  verifyAnalyzerConfigSnapshotSynchronously,
} from "../../apps/graph-service/src/analyzer-config.js";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  MAX_SOURCE_FILE_BYTES,
  isFileSystemCaseSensitive,
  scanWorkspace,
} from "../../apps/graph-service/src/workspace-scanner.js";
import { createTypeScriptAnalyzer } from "../../packages/adapters/analyzer-typescript/src/index.js";
import {
  MAX_WORKER_RESOLUTION_CANDIDATES,
  MAX_WORKER_RESOLUTION_CANDIDATE_PATH_BYTES,
  WORKER_ANALYSIS_CACHE_LIMITS,
  WORKER_OUTPUT_LIMITS,
  analyzeTypeScriptModules,
  observeTypeScriptConfiguration,
  readWorkerAnalysisCacheStatsForTests,
  resetWorkerAnalysisCacheForTests,
} from "../../packages/adapters/analyzer-typescript/src/worker-analysis.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";

const roots: string[] = [];

/** 构造配置观察使用的不可变逻辑文件。 */
function byteFile(relativePath: string, source: string) {
  return Object.freeze({
    bytes: new TextEncoder().encode(source),
    contentHash: sha256CanonicalJson({ source }),
    path: relativePath,
  });
}

/** 构造受控源码快照。 */
function sourceFile(
  relativePath: string,
  source: string,
  language:
    | "javascript"
    | "javascriptreact"
    | "typescript"
    | "typescriptreact" = "typescript",
) {
  return Object.freeze({
    ...byteFile(relativePath, source),
    fileId: `file:${relativePath}`,
    language,
  });
}

/** 构造保留原始编码字节的源码快照，用于验证 BOM 边界而不经过 UTF-8 重编码。 */
function encodedSourceFile(
  relativePath: string,
  bytes: Uint8Array,
  language: "javascript" | "typescript" = "typescript",
) {
  return Object.freeze({
    bytes,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    fileId: `file:${relativePath}`,
    language,
    path: relativePath,
  });
}

/** 以显式字节序编码 UTF-16，并保留对应 BOM。 */
function encodeUtf16WithBom(source: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + source.length * 2);
  bytes[0] = littleEndian ? 0xff : 0xfe;
  bytes[1] = littleEndian ? 0xfe : 0xff;
  for (let index = 0; index < source.length; index += 1) {
    const codeUnit = source.charCodeAt(index);
    bytes[2 + index * 2] = littleEndian ? codeUnit & 0xff : codeUnit >>> 8;
    bytes[3 + index * 2] = littleEndian ? codeUnit >>> 8 : codeUnit & 0xff;
  }
  return bytes;
}

/** 用不可变内存文件替代与预算断言无关的真实磁盘往返。 */
function createVirtualMetadataReader(files: readonly AnalyzerByteFileV1[]) {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  return async (_indexingRoot: string, logicalPath: string) => filesByPath.get(logicalPath) ?? null;
}

/** 保留真实 64 KiB 流式 hash 核心，同时用虚拟长度避免物化大文件。 */
function createVirtualBlockedResolutionInspector(files: ReadonlyMap<string, number>) {
  return async (_indexingRoot: string, logicalPath: string) => {
    const byteLength = files.get(logicalPath);
    if (byteLength === undefined) {return null;}
    return Object.freeze({
      byteLength,
      capture: async (signal?: AbortSignal) => {
        let remaining = byteLength;
        return hashAnalyzerSourceStreamBounded(async (chunk) => {
          if (remaining === 0) {return 0;}
          const bytesRead = Math.min(chunk.byteLength, remaining);
          chunk.fill(0x61, 0, bytesRead);
          remaining -= bytesRead;
          return bytesRead;
        }, MAX_SOURCE_FILE_BYTES, signal);
      },
    });
  };
}

/** 返回真实构建产物 Worker URL。 */
function builtWorkerUrl(): URL {
  const workerPath = path.resolve(
    "packages/adapters/analyzer-typescript/dist/analyzer-worker.js",
  );
  if (!existsSync(workerPath)) {throw new Error("Analyzer Worker 构建产物不存在。");}
  return pathToFileURL(workerPath);
}

afterEach(async () => {
  resetAnalyzerCaptureMetricsForTests();
  resetWorkerAnalysisCacheForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Story 1.5 Analyzer configuration capture", () => {
  it.each([
    ["全数字", "E:\\123\\456"],
    ["全非 ASCII", "E:\\项目\\模块"],
  ])("CR7-001 detects a case-insensitive Windows volume for a %s indexing root", (_label, indexingRoot) => {
    expect(isFileSystemCaseSensitive(indexingRoot, {
      lstat: (candidate) => {
        const normalized = candidate.toLocaleLowerCase("en-US");
        if (normalized === "e:\\" || normalized === indexingRoot.toLocaleLowerCase("en-US")) {
          return { dev: 7n, ino: normalized === "e:\\" ? 1n : 2n, isDirectory: () => true };
        }
        throw Object.assign(new Error(`unexpected path: ${candidate}`), { code: "ENOENT" });
      },
      pathStyle: "win32",
      readDirectory: () => [],
      realpath: () => indexingRoot,
    })).toBe(false);
  });

  it("CR7-001 detects a case-insensitive POSIX volume when every indexing-root component lacks ASCII letters", () => {
    const indexingRoot = "/123/项目";
    expect(isFileSystemCaseSensitive(indexingRoot, {
      lstat: (candidate) => {
        if ([indexingRoot, "/123", "/"].includes(candidate)) {
          return { dev: 9n, ino: BigInt(candidate.length), isDirectory: () => true };
        }
        if ([`${indexingRoot}/Source.ts`, `${indexingRoot}/source.ts`].includes(candidate)) {
          return { dev: 9n, ino: 99n, isDirectory: () => false };
        }
        throw Object.assign(new Error(`unexpected path: ${candidate}`), { code: "ENOENT" });
      },
      pathStyle: "posix",
      readDirectory: (directory) => directory === indexingRoot ? ["Source.ts"] : [],
      realpath: () => indexingRoot,
    })).toBe(false);
  });

  it("CR7-003 seals pnpm-workspace.yaml into configDigest and keeps workspace discovery deferred", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-pnpm-workspace-metadata-"));
    roots.push(indexingRoot);
    const workspacePath = path.join(indexingRoot, "pnpm-workspace.yaml");
    await writeFile(workspacePath, "packages:\n  - packages/*\n");
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => ({
        consultedLogicalPaths: input.configurationFiles.map((file) => file.path),
        effectiveCompilerOptions: {},
        projectConfigurations: [],
        resolutionCandidateLogicalPaths: [],
      }),
    };
    const capture = createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "3".repeat(64),
    });
    const scanResult = {
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    };

    const before = await capture(scanResult);
    expect(before.configurationFiles.map((file) => file.path)).toContain("pnpm-workspace.yaml");
    expect(before.configSnapshot.consultedFiles.map((file) => file.path))
      .toContain("pnpm-workspace.yaml");
    expect(before.configSnapshot.workspacePackages).toEqual([]);

    await writeFile(workspacePath, "packages:\n  - modules/*\n");
    const after = await capture(scanResult);
    expect(after.configDigest).not.toBe(before.configDigest);
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, before.configSnapshot))
      .toBe(false);
  });

  it("applies distinct synchronous fence limits to consulted metadata and blocked sources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-boundary-"));
    roots.push(root);
    const verify = async (
      relativePath: string,
      byteLength: number,
      kind: "blocked" | "consulted",
    ): Promise<boolean> => {
      const bytes = Buffer.alloc(byteLength, 0x61);
      await writeFile(path.join(root, relativePath), bytes);
      const file = {
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        path: relativePath,
      };
      const created = createAnalyzerConfigSnapshot({
        analyzerKind: "typescript",
        analyzerVersion: "6.0.3",
        blockedResolutionFiles: kind === "blocked" ? [file] : [],
        consultedFiles: kind === "consulted" ? [file] : [],
        effectiveCompilerOptions: {},
        effectiveIgnore: { effectiveDigest: "a".repeat(64), version: 1 },
        workspacePackages: [],
      }, { digest: sha256CanonicalJson });
      return verifyAnalyzerConfigSnapshotSynchronously(root, created.snapshot);
    };

    expect(await verify("consulted-max.json", MAX_ANALYZER_METADATA_FILE_BYTES, "consulted"))
      .toBe(true);
    expect(await verify("consulted-over.json", MAX_ANALYZER_METADATA_FILE_BYTES + 1, "consulted"))
      .toBe(false);
    expect(await verify("blocked-max.ts", MAX_SOURCE_FILE_BYTES, "blocked")).toBe(true);
    expect(await verify("blocked-over.ts", MAX_SOURCE_FILE_BYTES + 1, "blocked")).toBe(false);
  });

  it("pre-reserves blocked file count and aggregate bytes before streaming SHA-256", async () => {
    const captureBlocked = async (
      root: string,
      candidates: readonly string[],
      virtualFiles: ReadonlyMap<string, number>,
    ) => {
      const ignoreState = await createInitialIgnoreState(root);
      if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
      const analyzer: AnalyzerPort = {
        analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
        close: () => undefined,
        observeConfiguration: async (input) => ({
          consultedLogicalPaths: [],
          effectiveCompilerOptions: {},
          projectConfigurations: [],
          resolutionCandidateLogicalPaths:
            (input.blockedResolutionLogicalPaths?.length ?? 0) === 0 ? candidates : [],
        }),
      };
      return createAnalyzerSemanticContextCapture({
        analyzer,
        effectiveIgnoreSnapshot: ignoreState.snapshot,
        indexingRoot: root,
        workspaceKey: "6".repeat(64),
      }, {
        inspectBlockedResolutionFile: createVirtualBlockedResolutionInspector(virtualFiles),
      })({
        candidateFiles: [],
        excludedPathCount: 0,
        manifest: [],
        manifestDigest: sha256CanonicalJson([]),
        sourceFiles: [],
      });
    };

    const byteRoot = await mkdtemp(path.join(tmpdir(), "codegraph-blocked-byte-budget-"));
    roots.push(byteRoot);
    const blockedBytes = 9 * 1024 * 1024;
    const byteCandidates = ["src/first.ts", "src/second.ts"];
    await expect(captureBlocked(byteRoot, byteCandidates, new Map(
      byteCandidates.map((candidate) => [candidate, blockedBytes]),
    )))
      .rejects.toMatchObject({ analyzerCode: "ANALYZER_RESOURCE_LIMIT" });
    let metrics = readAnalyzerCaptureMetricsForTests();
    expect(metrics.blockedBytesHashed).toBe(blockedBytes);
    expect(metrics.blockedPeakBufferedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(metrics.blockedStatPreRejected).toBe(1);
    expect(metrics.blockedTotalBytesPeak).toBeLessThanOrEqual(
      MAX_ANALYZER_METADATA_TOTAL_BYTES,
    );

    resetAnalyzerCaptureMetricsForTests();
    const countRoot = await mkdtemp(path.join(tmpdir(), "codegraph-blocked-count-budget-"));
    roots.push(countRoot);
    const candidates = Array.from(
      { length: MAX_ANALYZER_RESOLUTION_FILES + 1 },
      (_, index) => `src/blocked-${index}.ts`,
    );
    await expect(captureBlocked(countRoot, candidates, new Map(
      candidates.map((candidate) => [candidate, 0]),
    )))
      .rejects.toMatchObject({ analyzerCode: "ANALYZER_RESOURCE_LIMIT" });
    metrics = readAnalyzerCaptureMetricsForTests();
    expect(metrics.blockedFilePeakCount).toBe(MAX_ANALYZER_RESOLUTION_FILES);
    expect(metrics.blockedStatPreRejected).toBe(1);
  }, 30_000);

  it("uses the graph-service authoritative config entry instead of sorting every config file", () => {
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [
        byteFile("jsconfig.json", JSON.stringify({ compilerOptions: { module: "CommonJS" } })),
        byteFile("tsconfig.base.json", JSON.stringify({ compilerOptions: { target: "ES2022" } })),
        byteFile("tsconfig.json", JSON.stringify({
          compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
          extends: "./tsconfig.base.json",
          include: ["src/**/*.ts"],
        })),
      ],
      sourceFiles: [sourceFile("src/index.ts", "export const value = 1;\n")],
    });

    expect(observation.effectiveCompilerOptions).toMatchObject({
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
    });
    expect(observation.consultedLogicalPaths).toEqual(expect.arrayContaining([
      "tsconfig.base.json",
      "tsconfig.json",
    ]));
    expect(observation.consultedLogicalPaths).not.toContain("jsconfig.json");
  });

  it("uses TypeScript config APIs to discover package and array extends without reading JSONC comments", () => {
    const configurationFiles = [
      byteFile("tsconfig.json", [
        "{",
        '  // \\"extends\\": \\"./comment-only.json\\",',
        '  "extends": ["@tsconfig/node22/tsconfig.json", "./tsconfig.shared.json"],',
        '  "include": ["src/**/*.ts"]',
        "}",
      ].join("\n")),
      byteFile("tsconfig.shared.json", JSON.stringify({ compilerOptions: { strict: true } })),
    ];
    const first = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles,
      sourceFiles: [sourceFile("src/index.ts", "export const value = 1;\n")],
    });

    expect(first.resolutionCandidateLogicalPaths).toContain(
      "node_modules/@tsconfig/node22/tsconfig.json",
    );
    expect(first.resolutionCandidateLogicalPaths).not.toContain("comment-only.json");

    const second = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles,
      resolutionFiles: [byteFile(
        "node_modules/@tsconfig/node22/tsconfig.json",
        JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
      )],
      sourceFiles: [sourceFile("src/index.ts", "export const value = 1;\n")],
    });
    expect(second.consultedLogicalPaths).toEqual(expect.arrayContaining([
      "node_modules/@tsconfig/node22/tsconfig.json",
      "tsconfig.shared.json",
      "tsconfig.json",
    ]));
  });

  it("seals project references and maps every source to its project compiler options", () => {
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        files: [],
        references: [{ path: "./packages/a" }, { path: "./packages/b" }],
      }))],
      resolutionFiles: [
        byteFile("packages/a/tsconfig.json", JSON.stringify({
          compilerOptions: { jsx: "react-jsx", module: "NodeNext", moduleResolution: "NodeNext" },
          include: ["src/**/*.tsx"],
        })),
        byteFile("packages/b/tsconfig.json", JSON.stringify({
          compilerOptions: { allowJs: true, module: "CommonJS" },
          include: ["src/**/*.js"],
        })),
      ],
      sourceFiles: [
        sourceFile("packages/a/src/view.tsx", "export const View = () => <div />;\n", "typescriptreact"),
        sourceFile("packages/b/src/index.js", "exports.value = 1;\n", "javascript"),
      ],
    });

    expect(observation.consultedLogicalPaths).toEqual(expect.arrayContaining([
      "packages/a/tsconfig.json",
      "packages/b/tsconfig.json",
      "tsconfig.json",
    ]));
    expect(observation.projectConfigurations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        configPath: "packages/a/tsconfig.json",
        effectiveCompilerOptions: expect.objectContaining({ module: "NodeNext" }),
        sourcePaths: ["packages/a/src/view.tsx"],
      }),
      expect.objectContaining({
        configPath: "packages/b/tsconfig.json",
        effectiveCompilerOptions: expect.objectContaining({ module: "CommonJS" }),
        sourcePaths: ["packages/b/src/index.js"],
      }),
    ]));
  });

  it("honors include, exclude and wildcard depth for sibling referenced projects", () => {
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        files: [],
        references: [
          { path: "./packages/shared/tsconfig.a.json" },
          { path: "./packages/shared/tsconfig.b.json" },
        ],
      }))],
      resolutionFiles: [
        byteFile("packages/shared/tsconfig.a.json", JSON.stringify({
          compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
          exclude: ["a/excluded.ts", "**/generated"],
          include: ["a/**/*.ts"],
        })),
        byteFile("packages/shared/tsconfig.b.json", JSON.stringify({
          compilerOptions: { module: "CommonJS" },
          include: ["b/*.ts"],
        })),
      ],
      sourceFiles: [
        sourceFile("packages/shared/a/main.ts", "export const a = 1;\n"),
        sourceFile("packages/shared/a/excluded.ts", "export const excluded = 1;\n"),
        sourceFile("packages/shared/a/nested/deep.ts", "export const deep = 1;\n"),
        sourceFile("packages/shared/a/generated/direct.ts", "export const generated = 1;\n"),
        sourceFile("packages/shared/a/generated/nested/deep.ts", "export const generated = 2;\n"),
        sourceFile("packages/shared/b/main.ts", "export const b = 1;\n"),
      ],
    });

    expect(observation.projectConfigurations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        configPath: "packages/shared/tsconfig.a.json",
        sourcePaths: [
          "packages/shared/a/main.ts",
          "packages/shared/a/nested/deep.ts",
        ],
      }),
      expect.objectContaining({
        configPath: "packages/shared/tsconfig.b.json",
        sourcePaths: ["packages/shared/b/main.ts"],
      }),
    ]));
  });

  it("CR6-002 excludes descendants of dotted directory glob patterns", () => {
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        exclude: ["**/.generated", "**/generated.v2"],
        include: ["src/**/*.ts"],
      }))],
      sourceFiles: [
        sourceFile("src/index.ts", "export const included = 1;\n"),
        sourceFile("src/.generated/direct.ts", "export const hidden = 1;\n"),
        sourceFile("src/.generated/nested/deep.ts", "export const hidden = 2;\n"),
        sourceFile("src/generated.v2/direct.ts", "export const hidden = 3;\n"),
        sourceFile("src/generated.v2/nested/deep.ts", "export const hidden = 4;\n"),
      ],
    });

    expect(observation.projectConfigurations[0]?.sourcePaths).toEqual(["src/index.ts"]);
  });

  it("marks a project incomplete and seals a missing package extends candidate", () => {
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        extends: "@company/tsconfig/base.json",
        include: ["src/**/*.ts"],
      }))],
      sourceFiles: [sourceFile("src/index.ts", "export const value = 1;\n")],
    });

    expect(observation.requiredMissingLogicalPaths).toContain(
      "node_modules/@company/tsconfig/base.json",
    );
    expect(observation.projectConfigurations).toContainEqual(expect.objectContaining({
      configPath: "tsconfig.json",
      configurationComplete: false,
      sourcePaths: ["src/index.ts"],
    }));
  });

  it("fails closed when project references or path-like compiler options escape the root", () => {
    expect(() => observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        files: [],
        references: [{ path: "../outside" }],
      }))],
      sourceFiles: [],
    })).toThrow(/工作区|逃逸|root|reference/iu);

    for (const compilerOptions of [
      { baseUrl: "../../../outside" },
      { rootDir: "../../../outside" },
      { typeRoots: ["../../../outside/types"] },
    ]) {
      expect(() => observeTypeScriptConfiguration({
        configurationEntryPaths: ["packages/app/tsconfig.json"],
        configurationFiles: [byteFile("packages/app/tsconfig.json", JSON.stringify({
          compilerOptions,
          include: ["src/**/*.ts"],
        }))],
        sourceFiles: [sourceFile("packages/app/src/index.ts", "export const value = 1;\n")],
      })).toThrow(/工作区|逃逸|root|路径/iu);
    }
  });

  it("does not inherit the root package identity across internal or package boundaries", () => {
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        resolveJsonModule: true,
      },
      include: ["src/**/*.ts"],
    }));
    const rootPackage = byteFile("package.json", JSON.stringify({
      name: "root-app",
      type: "module",
      version: "1.0.0",
    }));
    const resolutionFiles = [
      byteFile("src/data.json", "{\"value\":1}"),
      byteFile("node_modules/missing-manifest/index.d.ts", "export default 1;\n"),
    ];
    const sources = [sourceFile("src/index.ts", [
      'import data from "./data.json";',
      'import missing from "missing-manifest";',
      "void data; void missing;",
    ].join("\n"))];
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config, rootPackage],
      resolutionFiles,
      sourceFiles: sources,
    });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [config, rootPackage, ...resolutionFiles].map(({ contentHash, path }) => ({
        contentHash,
        path,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "a".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const inputDigest = createAnalyzerInputDigest({
      analyzerKind: "typescript",
      configDigest: created.configDigest,
      inputs: sources,
    }, { digest: sha256CanonicalJson });

    const output = analyzeTypeScriptModules({
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config, rootPackage],
      detectedAt: "2026-07-27T00:00:00.000Z",
      inputDigest,
      resolutionFiles,
      sourceFiles: sources,
      workspaceKey: "b".repeat(64),
    });

    expect(output.files[0]?.relations).toEqual([]);
    expect(output.files[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID",
        "MODULE_RELATIVE_TARGET_UNRESOLVED",
      ]),
    );
  });

  it("derives NodeNext static-import conditions from the nearest package.json", () => {
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }));
    const rootPackage = byteFile("package.json", JSON.stringify({
      name: "root-app",
      type: "module",
      version: "1.0.0",
    }));
    const externalPackage = byteFile(
      "node_modules/conditional/package.json",
      JSON.stringify({
        exports: { ".": { import: "./import.d.ts", require: "./require.d.ts" } },
        name: "conditional",
        version: "1.0.0",
      }),
    );
    const importDeclaration = byteFile(
      "node_modules/conditional/import.d.ts",
      "declare const value: 'import'; export default value;\n",
    );
    const source = sourceFile(
      "src/index.ts",
      'import value from "conditional";\nvoid value;\n',
    );
    // 故意不提供 require 条件目标；若 .ts 被误判为 CommonJS，本次只能降为 unresolved。
    const resolutionFiles = [externalPackage, importDeclaration];
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config, rootPackage],
      resolutionFiles,
      sourceFiles: [source],
    });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [config, rootPackage, ...resolutionFiles].map(({ contentHash, path }) => ({
        contentHash,
        path,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "c".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const inputDigest = createAnalyzerInputDigest({
      analyzerKind: "typescript",
      configDigest: created.configDigest,
      inputs: [source],
    }, { digest: sha256CanonicalJson });

    const output = analyzeTypeScriptModules({
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config, rootPackage],
      detectedAt: "2026-07-27T00:00:00.000Z",
      inputDigest,
      resolutionFiles,
      sourceFiles: [source],
      workspaceKey: "d".repeat(64),
    });

    expect(output.files[0]?.relations).toContainEqual(expect.objectContaining({
      confidence: "high",
      target: expect.objectContaining({ id: "pkg:npm/conditional@1.0.0" }),
    }));
  });

  it("CR6-001 follows case-insensitive host semantics and returns manifest casing", () => {
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }));
    const sourceFiles = [
      sourceFile("src/index.ts", 'import { value } from "./Dep.js";\nvoid value;\n'),
      sourceFile("src/dep.ts", "export const value = 1;\n"),
    ];
    const input = {
      caseSensitiveFileNames: false,
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config],
      sourceFiles,
    };
    const observation = observeTypeScriptConfiguration(input);
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [{ contentHash: config.contentHash, path: config.path }],
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "1".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });

    const output = analyzeTypeScriptModules({
      ...input,
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sourceFiles,
      }, { digest: sha256CanonicalJson }),
      resolutionFiles: [],
      workspaceKey: "1".repeat(64),
    });

    expect(output.files.find((file) => file.path === "src/index.ts")).toMatchObject({
      relations: expect.arrayContaining([expect.objectContaining({
        confidence: "high",
        target: expect.objectContaining({
          kind: "internal-file",
          resolvedPath: "src/dep.ts",
        }),
      })]),
    });
  });

  it("CR7-002 propagates case-insensitive host semantics through directories, globs, extensions, and project membership", () => {
    const configurationFiles = [byteFile("tsconfig.json", JSON.stringify({
      files: [],
      references: [{ path: "./PACKAGES/APP" }],
    }))];
    const resolutionFiles = [byteFile("packages/app/tsconfig.json", JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      exclude: ["SRC/GENERATED/**"],
      include: ["SRC/**/*.TS"],
    }))];
    const sourceFiles = [
      sourceFile(
        "packages/app/src/Index.TS",
        'import { value } from "./LIB/DEP.js";\nvoid value;\n',
      ),
      sourceFile("packages/app/src/lib/dep.TS", "export const value = 1;\n"),
      sourceFile("packages/app/src/Generated/skip.TS", "export const skipped = true;\n"),
    ];
    const input = {
      caseSensitiveFileNames: false,
      configurationEntryPaths: ["TSCONFIG.JSON"],
      configurationFiles,
      resolutionFiles,
      sourceFiles,
    };
    const observation = observeTypeScriptConfiguration(input);

    expect(observation.projectConfigurations).toContainEqual(expect.objectContaining({
      configPath: "packages/app/tsconfig.json",
      sourcePaths: [
        "packages/app/src/Index.TS",
        "packages/app/src/lib/dep.TS",
      ],
    }));

    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [...configurationFiles, ...resolutionFiles].map(({ contentHash, path }) => ({
        contentHash,
        path,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const output = analyzeTypeScriptModules({
      ...input,
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sourceFiles,
      }, { digest: sha256CanonicalJson }),
      workspaceKey: "2".repeat(64),
    });

    expect(output.files.find((file) => file.path === "packages/app/src/Index.TS"))
      .toMatchObject({
        relations: expect.arrayContaining([expect.objectContaining({
          confidence: "high",
          target: expect.objectContaining({
            kind: "internal-file",
            resolvedPath: "packages/app/src/lib/dep.TS",
          }),
        })]),
      });
  });

  it("CR8-001 preserves TypeScript non-ASCII host identity across files, globs, and resolution", () => {
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["SRC/**/*.TS"],
    }));
    const sourceFiles = [
      sourceFile("src/index.ts", [
        'import { sigma } from "./σ.js";',
        'import { capitalDotted } from "./İ.js";',
        'import { combiningDotted } from "./i\u0307.js";',
        "void sigma; void capitalDotted; void combiningDotted;",
      ].join("\n")),
      sourceFile("src/Σ.ts", "export const sigma = 1;\n"),
      sourceFile("src/İ.ts", "export const capitalDotted = 2;\n"),
      sourceFile("src/i\u0307.ts", "export const combiningDotted = 3;\n"),
    ];
    const input = {
      caseSensitiveFileNames: false,
      configurationEntryPaths: ["TSCONFIG.JSON"],
      configurationFiles: [config],
      sourceFiles,
    };
    const observation = observeTypeScriptConfiguration(input);
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [{ contentHash: config.contentHash, path: config.path }],
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "8".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const output = analyzeTypeScriptModules({
      ...input,
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sourceFiles,
      }, { digest: sha256CanonicalJson }),
      resolutionFiles: [],
      workspaceKey: "8".repeat(64),
    });
    const resolvedPaths = output.files.find((file) => file.path === "src/index.ts")?.relations
      .map((relation) => relation.target.kind === "internal-file"
        ? relation.target.resolvedPath
        : undefined);

    expect(observation.projectConfigurations[0]?.sourcePaths).toEqual([
      "src/index.ts",
      "src/i\u0307.ts",
      "src/İ.ts",
      "src/Σ.ts",
    ]);
    expect(resolvedPaths).toEqual(expect.arrayContaining([
      "src/Σ.ts",
      "src/İ.ts",
      "src/i\u0307.ts",
    ]));
  });

  it("CR8-002 propagates mixed-case node_modules boundaries through package metadata and exports rejection", () => {
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }));
    const resolutionFiles = [
      byteFile("NODE_MODULES/case-pkg/package.json", JSON.stringify({
        exports: {
          ".": "./index.d.ts",
          "./feature@debug": "./feature@debug.d.ts",
        },
        name: "case-pkg",
        version: "1.2.3",
      })),
      byteFile("NODE_MODULES/case-pkg/index.d.ts", "export declare const root: number;\n"),
      byteFile(
        "NODE_MODULES/case-pkg/feature@debug.d.ts",
        "export declare const feature: number;\n",
      ),
      byteFile("Node_Modules/locked/package.json", JSON.stringify({
        exports: { ".": "./index.d.ts" },
        name: "locked",
        version: "4.5.6",
      })),
      byteFile("Node_Modules/locked/index.d.ts", "export declare const value: number;\n"),
    ];
    const sources = [sourceFile("src/index.ts", [
      'import { root } from "case-pkg";',
      'import { feature } from "case-pkg/feature@debug";',
      'import "locked/private";',
      "void root; void feature;",
    ].join("\n"))];
    const input = {
      caseSensitiveFileNames: false,
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config],
      resolutionFiles,
      sourceFiles: sources,
    };
    const observation = observeTypeScriptConfiguration(input);
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [config, ...resolutionFiles].map(({ contentHash, path }) => ({
        contentHash,
        path,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "9".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const output = analyzeTypeScriptModules({
      ...input,
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sources,
      }, { digest: sha256CanonicalJson }),
      workspaceKey: "9".repeat(64),
    });
    const result = output.files[0]!;

    expect(result.relations.filter((relation) => relation.target.kind === "external-package"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ id: "pkg:npm/case-pkg@1.2.3" }) }),
        expect.objectContaining({ target: expect.objectContaining({ id: "pkg:npm/case-pkg@1.2.3" }) }),
      ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID",
    }));
    expect(result.relations).not.toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ id: "pkg:npm/locked@unresolved" }),
    }));
  });

  it("CR6-013 accepts fatal-decoded UTF-16LE and UTF-16BE BOM source snapshots", () => {
    const sourceFiles = [
      encodedSourceFile(
        "src/index.ts",
        encodeUtf16WithBom('import { value } from "./dep.js";\nvoid value;\n', true),
      ),
      encodedSourceFile(
        "src/dep.ts",
        encodeUtf16WithBom("export const value = 1;\n", false),
      ),
    ];
    const observation = observeTypeScriptConfiguration({
      configurationFiles: [],
      sourceFiles,
    });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [],
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });

    const output = analyzeTypeScriptModules({
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationFiles: [],
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sourceFiles,
      }, { digest: sha256CanonicalJson }),
      resolutionFiles: [],
      sourceFiles,
      workspaceKey: "2".repeat(64),
    });

    expect(output.files).toHaveLength(2);
    expect(output.files.find((file) => file.path === "src/dep.ts")?.localExportBindings)
      .toContainEqual(expect.objectContaining({
      exportedName: "value",
      localName: "value",
      }));
  });

  it("keeps scanner source snapshots in shared memory for zero-copy Worker delivery", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-shared-analyzer-"));
    roots.push(indexingRoot);
    await writeFile(path.join(indexingRoot, "index.ts"), "export const value = 1;\n");
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试前置条件不成立。");}

    const scan = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot,
    });

    expect(scan.sourceFiles?.[0]?.bytes.buffer).toBeInstanceOf(SharedArrayBuffer);
  });

  it("resolves paths candidates against baseUrl before snapshot normalization", () => {
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["packages/app/tsconfig.json"],
      configurationFiles: [byteFile("packages/app/tsconfig.json", JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@shared/*": ["../shared/*", "./fallback/*"] },
        },
        include: ["src/**/*.ts"],
      }))],
      sourceFiles: [sourceFile("packages/app/src/index.ts", "export const value = 1;\n")],
    });

    expect(observation.effectiveCompilerOptions).toMatchObject({
      baseUrl: "packages/app",
      paths: { "@shared/*": ["packages/shared/*", "packages/app/fallback/*"] },
    });
  });

  it("iteratively brokers external resolution metadata and seals every actual file", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-capture-"));
    roots.push(indexingRoot);
    await mkdir(path.join(indexingRoot, "src"), { recursive: true });
    await mkdir(path.join(indexingRoot, "node_modules", "example"), { recursive: true });
    await writeFile(
      path.join(indexingRoot, "src", "index.ts"),
      "import { value } from 'example';\nvoid value;\n",
    );
    await writeFile(
      path.join(indexingRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    await writeFile(
      path.join(indexingRoot, "node_modules", "example", "package.json"),
      JSON.stringify({ name: "example", types: "index.d.ts", version: "1.2.3" }),
    );
    await writeFile(
      path.join(indexingRoot, "node_modules", "example", "index.d.ts"),
      "export declare const value: number;\n",
    );
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const scanResult = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot,
    });
    const observeConfiguration = vi.fn(async (input: {
      configurationFiles: readonly AnalyzerByteFileV1[];
      resolutionFiles?: readonly AnalyzerByteFileV1[];
    }) => {
      const resolutionPaths = new Set((input.resolutionFiles ?? []).map((file) => file.path));
      const hasPackage = resolutionPaths.has("node_modules/example/package.json");
      const hasDeclaration = resolutionPaths.has("node_modules/example/index.d.ts");
      return {
        consultedLogicalPaths: [
          "tsconfig.json",
          ...(hasPackage ? ["node_modules/example/package.json"] : []),
          ...(hasDeclaration ? ["node_modules/example/index.d.ts"] : []),
        ],
        effectiveCompilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
        projectConfigurations: [],
        resolutionCandidateLogicalPaths: hasPackage
          ? ["node_modules/example/index.d.ts"]
          : ["node_modules/example/package.json"],
      };
    });
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: observeConfiguration as AnalyzerPort["observeConfiguration"],
    };
    const capture = createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "c".repeat(64),
    });

    const context = await capture(scanResult);

    expect(observeConfiguration).toHaveBeenCalledTimes(3);
    expect(context.resolutionFiles.map((file) => file.path)).toEqual([
      "node_modules/example/index.d.ts",
      "node_modules/example/package.json",
    ]);
    expect(context.configSnapshot.consultedFiles.map((file) => file.path)).toEqual([
      "node_modules/example/index.d.ts",
      "node_modules/example/package.json",
      "tsconfig.json",
    ]);
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(true);
    await writeFile(
      path.join(indexingRoot, "node_modules", "example", "package.json"),
      JSON.stringify({ name: "example", types: "index.d.ts", version: "2.0.0" }),
    );
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(false);
  });

  it("seals absent extends paths and invalidates the synchronous fence when they are created", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-absent-extends-"));
    roots.push(indexingRoot);
    await writeFile(path.join(indexingRoot, "tsconfig.json"), JSON.stringify({
      extends: "./configs/base.json",
      files: [],
    }));
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => observeTypeScriptConfiguration(input),
    };
    const context = await createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "7".repeat(64),
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    });

    expect(context.configSnapshot.absentFiles).toContain("configs/base.json");
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(true);
    await mkdir(path.join(indexingRoot, "configs"), { recursive: true });
    await writeFile(path.join(indexingRoot, "configs", "base.json"), "{}\n");
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(false);
  });

  it("lets the real worker resolve a brokered external npm package to a versioned purl", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-external-"));
    roots.push(indexingRoot);
    await mkdir(path.join(indexingRoot, "src"), { recursive: true });
    await mkdir(path.join(indexingRoot, "node_modules", "example"), { recursive: true });
    await writeFile(
      path.join(indexingRoot, "src", "index.ts"),
      "import { value } from 'example';\nvoid value;\n",
    );
    await writeFile(
      path.join(indexingRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
    );
    await writeFile(
      path.join(indexingRoot, "node_modules", "example", "package.json"),
      JSON.stringify({ name: "example", types: "index.d.ts", version: "1.2.3" }),
    );
    await writeFile(
      path.join(indexingRoot, "node_modules", "example", "index.d.ts"),
      "export declare const value: number;\n",
    );
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const scanResult = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot,
    });
    const analyzer = createTypeScriptAnalyzer({ workerUrl: builtWorkerUrl() });
    try {
      const context = await createAnalyzerSemanticContextCapture({
        analyzer,
        effectiveIgnoreSnapshot: ignoreState.snapshot,
        indexingRoot,
        workspaceKey: "d".repeat(64),
      })(scanResult);
      const output = await analyzer.analyze({
        configDigest: context.configDigest,
        configSnapshot: context.configSnapshot,
        configurationFiles: context.configurationFiles,
        detectedAt: "2026-07-27T00:00:00.000Z",
        inputDigest: context.inputDigest,
        resolutionFiles: context.resolutionFiles,
        sourceFiles: context.sourceFiles,
        workspaceKey: "d".repeat(64),
      });

      expect(context.resolutionFiles.map((file) => file.path)).toEqual(expect.arrayContaining([
        "node_modules/example/index.d.ts",
        "node_modules/example/package.json",
      ]));
      expect(output.files[0]?.relations).toContainEqual(expect.objectContaining({
        confidence: "high",
        target: expect.objectContaining({
          id: "pkg:npm/example@1.2.3",
          kind: "external-package",
        }),
      }));
    } finally {
      await analyzer.close();
    }
  });

  it("allows trusted pnpm-style hardlinks and nested node_modules metadata", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-hardlink-"));
    roots.push(indexingRoot);
    await mkdir(path.join(indexingRoot, ".pnpm-store"), { recursive: true });
    await mkdir(path.join(indexingRoot, "packages", "app", "node_modules", "example"), {
      recursive: true,
    });
    const sourceMetadata = path.join(indexingRoot, ".pnpm-store", "example-package.json");
    const nestedMetadata = path.join(
      indexingRoot,
      "packages",
      "app",
      "node_modules",
      "example",
      "package.json",
    );
    await writeFile(sourceMetadata, JSON.stringify({ name: "example", version: "1.0.0" }));
    await link(sourceMetadata, nestedMetadata);
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => ({
        consultedLogicalPaths: input.resolutionFiles?.map((file) => file.path) ?? [],
        effectiveCompilerOptions: {},
        projectConfigurations: [],
        resolutionCandidateLogicalPaths: ["packages/app/node_modules/example/package.json"],
      }),
    };
    const context = await createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "e".repeat(64),
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    });

    expect(context.resolutionFiles.map((file) => file.path)).toEqual([
      "packages/app/node_modules/example/package.json",
    ]);
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(true);
  });

  it("finds manifest-less packages from the containing file's nested node_modules ancestors", () => {
    const source = sourceFile(
      "packages/app/src/index.ts",
      'import "example";\n',
    );
    const resolutionFiles = [byteFile(
      "packages/app/node_modules/example/internal.data",
      "sealed external boundary\n",
    )];
    const observation = observeTypeScriptConfiguration({
      configurationFiles: [],
      resolutionFiles,
      sourceFiles: [source],
    });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: resolutionFiles.map(({ contentHash, path: filePath }) => ({
        contentHash,
        path: filePath,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "7".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });

    const output = analyzeTypeScriptModules({
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationFiles: [],
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: [source],
      }, { digest: sha256CanonicalJson }),
      resolutionFiles,
      sourceFiles: [source],
      workspaceKey: "8".repeat(64),
    });

    expect(output.files[0]?.relations).toEqual([]);
    expect(output.files[0]?.diagnostics).toContainEqual(expect.objectContaining({
      code: "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID",
    }));
  });

  it("CR7-007 diagnoses exports-rejected packages without forging an unresolved edge", () => {
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }));
    const resolutionFiles = [
      byteFile("node_modules/exports-locked/package.json", JSON.stringify({
        exports: { ".": "./index.d.ts" },
        name: "exports-locked",
        version: "1.0.0",
      })),
      byteFile("node_modules/exports-locked/index.d.ts", "export declare const value: number;\n"),
    ];
    const sources = [sourceFile("src/index.ts", [
      'import "exports-locked/private";',
      'import "totally-missing";',
    ].join("\n"))];
    const input = {
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [config],
      resolutionFiles,
      sourceFiles: sources,
    };
    const observation = observeTypeScriptConfiguration(input);
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [config, ...resolutionFiles].map(({ contentHash, path }) => ({
        contentHash,
        path,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "7".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const output = analyzeTypeScriptModules({
      ...input,
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sources,
      }, { digest: sha256CanonicalJson }),
      workspaceKey: "7".repeat(64),
    });
    const result = output.files[0]!;

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID",
    }));
    expect(result.relations).not.toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ id: "pkg:npm/exports-locked@unresolved" }),
    }));
    expect(result.relations).toContainEqual(expect.objectContaining({
      confidence: "medium",
      target: expect.objectContaining({ id: "pkg:npm/totally-missing@unresolved" }),
    }));
  });

  it("CR8-002 treats mixed-case node_modules source candidates as metadata in the broker", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-host-case-"));
    roots.push(indexingRoot);
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const externalDeclaration = byteFile(
      "NODE_MODULES/pkg/index.d.ts",
      "export declare const value: number;\n",
    );
    const inspectBlockedResolutionFile = vi.fn(async () => {
      throw new Error("mixed-case node_modules 不得进入 blocked 源码路径");
    });
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => ({
        consultedLogicalPaths: input.resolutionFiles?.length === 1
          ? ["node_modules/pkg/index.d.ts"]
          : [],
        effectiveCompilerOptions: {},
        projectConfigurations: [],
        resolutionCandidateLogicalPaths: input.resolutionFiles?.length === 1
          ? []
          : [externalDeclaration.path],
      }),
    };

    const context = await createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "a".repeat(64),
    }, {
      caseSensitiveFileNames: false,
      inspectBlockedResolutionFile,
      readMetadataFile: createVirtualMetadataReader([externalDeclaration]),
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    });

    expect(inspectBlockedResolutionFile).not.toHaveBeenCalled();
    expect(context.resolutionFiles.map((file) => file.path)).toEqual([
      "NODE_MODULES/pkg/index.d.ts",
    ]);
    expect(context.configSnapshot.consultedFiles).toContainEqual(expect.objectContaining({
      path: "NODE_MODULES/pkg/index.d.ts",
    }));
  });

  it("counts only unique non-manifest metadata against the resolution candidate budget", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-budget-"));
    roots.push(indexingRoot);
    const count = MAX_ANALYZER_RESOLUTION_CANDIDATES + 1;
    const manifest = Array.from({ length: count }, (_, index) => ({
      contentHash: "a".repeat(64),
      path: `src/file-${index}.ts`,
    }));
    const sourceFiles = manifest.map((entry) => ({
      ...entry,
      bytes: new TextEncoder().encode("export {};\n"),
    }));
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async () => ({
        consultedLogicalPaths: [],
        effectiveCompilerOptions: {},
        projectConfigurations: [],
        resolutionCandidateLogicalPaths: [],
      }),
    };

    await expect(createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "f".repeat(64),
    })({
      candidateFiles: manifest.map((entry) => entry.path),
      excludedPathCount: 0,
      manifest,
      manifestDigest: sha256CanonicalJson(manifest),
      sourceFiles,
    })).resolves.toMatchObject({ sourceFiles: expect.any(Array) });
  });

  it("brokers a legal deep extends chain within explicit graph budgets", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-deep-extends-"));
    roots.push(indexingRoot);
    const chainLength = 16;
    await writeFile(path.join(indexingRoot, "tsconfig.json"), JSON.stringify({
      extends: "./configs/0.json",
      files: [],
    }));
    await mkdir(path.join(indexingRoot, "configs"), { recursive: true });
    for (let index = 0; index < chainLength; index += 1) {
      await writeFile(path.join(indexingRoot, "configs", `${index}.json`), JSON.stringify(
        index + 1 < chainLength
          ? { extends: `./${index + 1}.json` }
          : { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } },
      ));
    }
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => observeTypeScriptConfiguration(input),
    };

    const context = await createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "9".repeat(64),
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    });

    expect(context.configSnapshot.consultedFiles.map((file) => file.path))
      .toContain(`configs/${chainLength - 1}.json`);
  });

  it("allows a 128-layer metadata graph to perform one non-consuming stability confirmation", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-depth-boundary-"));
    roots.push(indexingRoot);
    const virtualMetadataFiles = Array.from(
      { length: MAX_ANALYZER_METADATA_GRAPH_DEPTH },
      (_, index) => byteFile(`metadata/${index}.json`, "{}\n"),
    );
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => {
        const currentCount = input.resolutionFiles?.length ?? 0;
        return {
          consultedLogicalPaths: input.resolutionFiles?.map((file) => file.path) ?? [],
          effectiveCompilerOptions: {},
          projectConfigurations: [],
          resolutionCandidateLogicalPaths: currentCount < MAX_ANALYZER_METADATA_GRAPH_DEPTH
            ? [`metadata/${currentCount}.json`]
            : [],
        };
      },
    };

    await expect(createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "7".repeat(64),
    }, {
      readMetadataFile: createVirtualMetadataReader(virtualMetadataFiles),
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    })).resolves.toMatchObject({
      resolutionFiles: { length: MAX_ANALYZER_METADATA_GRAPH_DEPTH },
    });
  });

  it("fails deterministically for circular config inheritance and graph-depth exhaustion", async () => {
    expect(() => observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        extends: "./configs/base.json",
        files: [],
      }))],
      resolutionFiles: [byteFile("configs/base.json", JSON.stringify({
        extends: "../tsconfig.json",
      }))],
      sourceFiles: [],
    })).toThrow(/18000|循环|配置/u);

    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-depth-budget-"));
    roots.push(indexingRoot);
    const virtualMetadataFiles = Array.from(
      { length: MAX_ANALYZER_METADATA_GRAPH_DEPTH + 1 },
      (_, index) => byteFile(`metadata/${index}.json`, "{}\n"),
    );
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input) => {
        const currentCount = input.resolutionFiles?.length ?? 0;
        return {
          consultedLogicalPaths: input.resolutionFiles?.map((file) => file.path) ?? [],
          effectiveCompilerOptions: {},
          projectConfigurations: [],
          resolutionCandidateLogicalPaths: [`metadata/${currentCount}.json`],
        };
      },
    };

    await expect(createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "4".repeat(64),
    }, {
      readMetadataFile: createVirtualMetadataReader(virtualMetadataFiles),
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    })).rejects.toMatchObject({ analyzerCode: "ANALYZER_RESOURCE_LIMIT" });
  });

  it("stops reading candidate entries as soon as the main-process count budget is exceeded", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-stream-budget-"));
    roots.push(indexingRoot);
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    let reads = 0;
    const candidates = Array.from(
      { length: MAX_ANALYZER_RESOLUTION_CANDIDATES + 128 },
      (_, index) => `metadata/${index}.json`,
    );
    const guardedCandidates = new Proxy(candidates, {
      get: (target, property, receiver) => {
        if (typeof property === "string" && /^\d+$/u.test(property)) {reads += 1;}
        return Reflect.get(target, property, receiver);
      },
    });
    const analyzer: AnalyzerPort = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async () => ({
        consultedLogicalPaths: [],
        effectiveCompilerOptions: {},
        projectConfigurations: [],
        resolutionCandidateLogicalPaths: guardedCandidates,
      }),
    };

    await expect(createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "8".repeat(64),
    }, {
      readMetadataFile: async () => null,
    })({
      candidateFiles: [],
      excludedPathCount: 0,
      manifest: [],
      manifestDigest: sha256CanonicalJson([]),
      sourceFiles: [],
    })).rejects.toThrow(/候选数|预算/u);
    expect(reads).toBeLessThanOrEqual(MAX_ANALYZER_RESOLUTION_CANDIDATES + 1);
  });

  it("reuses incremental Programs and bounds directory/module-resolution work across requests", () => {
    resetWorkerAnalysisCacheForTests();
    const dependencyCount = 64;
    const input = {
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles: [byteFile("tsconfig.json", JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["src/**/*.ts"],
      }))],
      sourceFiles: [
        sourceFile(
          "src/index.ts",
          Array.from({ length: dependencyCount }, (_, index) =>
            `import { value${index} } from "./dep-${index}.js";`).join("\n"),
        ),
        ...Array.from({ length: dependencyCount }, (_, index) => sourceFile(
          `src/dep-${index}.ts`,
          `export const value${index} = ${index};\n`,
        )),
      ],
    };

    const observation = observeTypeScriptConfiguration(input);
    const first = readWorkerAnalysisCacheStatsForTests();
    observeTypeScriptConfiguration(input);
    const second = readWorkerAnalysisCacheStatsForTests();

    expect(second.programReuses).toBeGreaterThanOrEqual(1);
    expect(second.reusedSourceFiles).toBeGreaterThanOrEqual(dependencyCount + 1);
    expect(second.moduleResolutionCacheHits).toBeGreaterThanOrEqual(dependencyCount);
    expect(second.moduleResolutionExecutions).toBe(first.moduleResolutionExecutions);
    expect(second.directoryIndexBuildFileVisits).toBe(first.directoryIndexBuildFileVisits);
    expect(second.directoryIndexBuildFileVisits).toBeLessThanOrEqual(dependencyCount + 2);

    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: input.configurationFiles.map(({ contentHash, path: filePath }) => ({
        contentHash,
        path: filePath,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "6".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    const inputDigest = createAnalyzerInputDigest({
      analyzerKind: "typescript",
      configDigest: created.configDigest,
      inputs: input.sourceFiles,
    }, { digest: sha256CanonicalJson });
    analyzeTypeScriptModules({
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationEntryPaths: input.configurationEntryPaths,
      configurationFiles: input.configurationFiles,
      detectedAt: "2026-07-27T00:00:00.000Z",
      inputDigest,
      resolutionFiles: [],
      sourceFiles: input.sourceFiles,
      workspaceKey: "5".repeat(64),
    });
    const afterAnalyze = readWorkerAnalysisCacheStatsForTests();
    expect(afterAnalyze.moduleResolutionExecutions).toBe(second.moduleResolutionExecutions);
    if (second.moduleResolutionCacheHits === undefined) {
      throw new Error("第二次配置观测未返回模块解析缓存命中数。");
    }
    expect(afterAnalyze.moduleResolutionCacheHits).toBeGreaterThan(second.moduleResolutionCacheHits);
  });

  it("keeps retained Program and syntax state under byte, fact and project-count ceilings", () => {
    resetWorkerAnalysisCacheForTests();
    const padding = "x".repeat(450_000);
    for (let index = 0; index < WORKER_ANALYSIS_CACHE_LIMITS.maxProjectStates + 8; index += 1) {
      observeTypeScriptConfiguration({
        configurationFiles: [],
        sourceFiles: [sourceFile(
          `src/cache-${index}.ts`,
          `export const value${index} = ${index}; /* ${padding} */\n`,
        )],
      });
    }
    const stats = readWorkerAnalysisCacheStatsForTests();

    expect(stats.projectStateCount).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxProjectStates,
    );
    expect(stats.retainedBytes).toBeLessThanOrEqual(WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedBytes);
    expect(stats.retainedFacts).toBeLessThanOrEqual(WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedFacts);
    const objectLimits = WORKER_ANALYSIS_CACHE_LIMITS as unknown as {
      maxDirectoryEntryCount: number;
      maxProgramCount: number;
      maxSourceFileObjectCount: number;
    };
    expect(stats.programCount).toBeLessThanOrEqual(objectLimits.maxProgramCount);
    expect(stats.sourceFileObjectCount).toBeLessThanOrEqual(
      objectLimits.maxSourceFileObjectCount,
    );
    expect(stats.directoryEntryCount).toBeLessThanOrEqual(objectLimits.maxDirectoryEntryCount);
  });

  it("seals blocked non-manifest source candidates and ordinary absent candidates separately", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-analyzer-resolution-fence-"));
    roots.push(indexingRoot);
    await mkdir(path.join(indexingRoot, "src"), { recursive: true });
    await writeFile(path.join(indexingRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: {
          "@blocked": ["src/blocked.ts"],
          "@missing": ["src/missing.ts"],
        },
      },
      include: ["src/**/*.ts"],
    }));
    await writeFile(path.join(indexingRoot, "src", "blocked.ts"), "export const hidden = 1;\n");
    const source = sourceFile(
      "src/index.ts",
      'import { hidden } from "@blocked";\nimport "@missing";\nvoid hidden;\n',
    );
    await writeFile(path.join(indexingRoot, "src", "index.ts"), new TextDecoder().decode(source.bytes));
    const ignoreState = await createInitialIgnoreState(indexingRoot);
    if (ignoreState.kind !== "ready") {throw new Error("测试 ignore 前置条件不成立。");}
    const capture = createAnalyzerSemanticContextCapture({
      analyzer: {
        analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
        close: () => undefined,
        observeConfiguration: async (input) => observeTypeScriptConfiguration(input),
      },
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      indexingRoot,
      workspaceKey: "a".repeat(64),
    });
    const context = await capture({
      candidateFiles: [source.path],
      excludedPathCount: 1,
      manifest: [{ contentHash: source.contentHash, path: source.path }],
      manifestDigest: sha256CanonicalJson([{ contentHash: source.contentHash, path: source.path }]),
      sourceFiles: [source],
    });
    const sealed = context.configSnapshot as unknown as {
      absentResolutionFiles: readonly string[];
      blockedResolutionFiles: readonly { contentHash: string; path: string }[];
    };

    expect(sealed.blockedResolutionFiles.map((entry) => entry.path)).toContain("src/blocked.ts");
    expect(sealed.absentResolutionFiles).toContain("src/missing.ts");
    expect(context.configSnapshot.absentFiles).not.toContain("src/missing.ts");
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(true);
    const output = analyzeTypeScriptModules({
      configDigest: context.configDigest,
      configSnapshot: context.configSnapshot,
      configurationEntryPaths: context.configurationEntryPaths,
      configurationFiles: context.configurationFiles,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: context.inputDigest,
      resolutionFiles: context.resolutionFiles,
      sourceFiles: context.sourceFiles,
      workspaceKey: "a".repeat(64),
    });
    expect(output.files[0]?.relations).not.toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ packageName: "@blocked" }),
    }));
    expect(output.files[0]?.diagnostics).toContainEqual(expect.objectContaining({
      code: "MODULE_RESOLUTION_FAILED",
    }));
    await writeFile(path.join(indexingRoot, "src", "blocked.ts"), "export const hidden = 2;\n");
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(false);
    await writeFile(path.join(indexingRoot, "src", "blocked.ts"), "export const hidden = 1;\n");
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(true);
    await writeFile(path.join(indexingRoot, "src", "missing.ts"), "export {};\n");
    expect(verifyAnalyzerConfigSnapshotSynchronously(indexingRoot, context.configSnapshot))
      .toBe(false);
  });

  it("uses request indexes for package fallback and source-project membership", () => {
    resetWorkerAnalysisCacheForTests();
    const projectCount = 24;
    const configurationFiles = [byteFile("tsconfig.json", JSON.stringify({
      files: [],
      references: Array.from({ length: projectCount }, (_, index) => ({
        path: `./packages/p${index}/tsconfig.json`,
      })),
    }))];
    const resolutionFiles = Array.from({ length: projectCount }, (_, index) => byteFile(
      `packages/p${index}/tsconfig.json`,
      JSON.stringify({ include: ["src/**/*.ts"] }),
    ));
    const sources = Array.from({ length: projectCount }, (_, index) => sourceFile(
      `packages/p${index}/src/index.ts`,
      `import "missing-${index}";\nexport const value${index} = ${index};\n`,
    ));
    const observation = observeTypeScriptConfiguration({
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles,
      resolutionFiles,
      sourceFiles: sources,
    });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [...configurationFiles, ...resolutionFiles].map(({ contentHash, path: filePath }) => ({
        contentHash,
        path: filePath,
      })),
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "8".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    analyzeTypeScriptModules({
      configDigest: created.configDigest,
      configSnapshot: created.snapshot,
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles,
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sources,
      }, { digest: sha256CanonicalJson }),
      resolutionFiles,
      sourceFiles: sources,
      workspaceKey: "9".repeat(64),
    });
    const stats = readWorkerAnalysisCacheStatsForTests();

    expect(stats.sourceProjectMembershipVisits).toBeLessThanOrEqual(projectCount * 2);
    expect(stats.sourceProjectLookupCalls).toBeGreaterThanOrEqual(projectCount * 2);
    expect(stats.externalPackageFallbackIndexBuildFileVisits).toBeLessThanOrEqual(
      configurationFiles.length + resolutionFiles.length + sources.length,
    );
    expect(stats.externalPackageFallbackLookups).toBe(projectCount);
  });

  it("CR6-004 reuses Programs at the 50-project and 5000-file standard scale", () => {
    resetWorkerAnalysisCacheForTests();
    const projectCount = 50;
    const filesPerProject = 100;
    const configurationFiles = [byteFile("tsconfig.json", JSON.stringify({
      files: [],
      references: Array.from({ length: projectCount }, (_, index) => ({
        path: `./packages/standard-${index}/tsconfig.json`,
      })),
    }))];
    const resolutionFiles = Array.from({ length: projectCount }, (_, index) => byteFile(
      `packages/standard-${index}/tsconfig.json`,
      JSON.stringify({ include: ["src/**/*.ts"] }),
    ));
    const sources = Array.from(
      { length: projectCount * filesPerProject },
      (_, index) => {
        const project = Math.floor(index / filesPerProject);
        return sourceFile(
          `packages/standard-${project}/src/file-${index}.ts`,
          `export const value${index} = ${index};\n`,
        );
      },
    );

    const input = {
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles,
      resolutionFiles,
      sourceFiles: sources,
    };
    const observation = observeTypeScriptConfiguration(input);
    const first = readWorkerAnalysisCacheStatsForTests();
    observeTypeScriptConfiguration(input);
    const second = readWorkerAnalysisCacheStatsForTests();

    expect(observation.projectConfigurations).toHaveLength(projectCount + 1);
    expect(WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount).toBeGreaterThanOrEqual(projectCount);
    expect(WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount)
      .toBeGreaterThanOrEqual(sources.length + projectCount);
    expect(first.projectStateCount).toBeGreaterThan(0);
    expect(first.programBuilds).toBe(projectCount);
    expect(second.programBuilds).toBe(first.programBuilds);
    expect(second.programReuses).toBeGreaterThanOrEqual(projectCount);
    expect(second.retainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedBytes,
    );
    expect(second.projectRetainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxProjectRetainedBytes,
    );
    expect(second.syntaxRetainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxSyntaxRetainedBytes,
    );
    expect(second.sourceFileObjectCreationPeak).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount,
    );
    expect(second.configReadDirectoryFileVisits).toBeLessThanOrEqual(sources.length * 6);
  }, 30_000);

  it("CR7-004 reuses bounded Programs across two 50-project 5000-file 500000-LOC requests", () => {
    resetWorkerAnalysisCacheForTests();
    const projectCount = 50;
    const filesPerProject = 100;
    const linesPerFile = 100;
    const configurationFiles = [byteFile("tsconfig.json", JSON.stringify({
      files: [],
      references: Array.from({ length: projectCount }, (_, index) => ({
        path: `./packages/loc-${index}/tsconfig.json`,
      })),
    }))];
    const resolutionFiles = Array.from({ length: projectCount }, (_, index) => byteFile(
      `packages/loc-${index}/tsconfig.json`,
      JSON.stringify({ include: ["src/**/*.ts"] }),
    ));
    const commentBlock = Array.from(
      { length: linesPerFile - 1 },
      (_, line) => `// 标准规模保留行 ${line}`,
    );
    const sources = Array.from(
      { length: projectCount * filesPerProject },
      (_, index) => {
        const project = Math.floor(index / filesPerProject);
        return sourceFile(
          `packages/loc-${project}/src/file-${index}.ts`,
          `${[...commentBlock, `export const value${index} = ${index};`].join("\n")}\n`,
        );
      },
    );
    expect(sources.length * linesPerFile).toBe(500_000);

    const input = {
      configurationEntryPaths: ["tsconfig.json"],
      configurationFiles,
      resolutionFiles,
      sourceFiles: sources,
    };
    observeTypeScriptConfiguration(input);
    const first = readWorkerAnalysisCacheStatsForTests();
    observeTypeScriptConfiguration(input);
    const second = readWorkerAnalysisCacheStatsForTests();

    expect(first.programBuilds).toBe(projectCount);
    expect(first.projectStateCount).toBe(1);
    expect(second.programBuilds).toBe(first.programBuilds);
    expect(second.programReuses).toBeGreaterThanOrEqual(projectCount);
    expect(second.retainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedBytes,
    );
    expect(second.projectRetainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxProjectRetainedBytes,
    );
    expect(second.syntaxRetainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxSyntaxRetainedBytes,
    );
    expect(second.sourceFileObjectCount).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount,
    );
  }, 30_000);

  it("rejects a single-file Worker output that exceeds the deterministic fact budget", () => {
    const source = sourceFile(
      "src/fact-budget.ts",
      Array.from({ length: 5_000 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    );
    const observation = observeTypeScriptConfiguration({ configurationFiles: [], sourceFiles: [source] });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [],
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "9".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });

    let failure: unknown;
    try {
      analyzeTypeScriptModules({
        configDigest: created.configDigest,
        configSnapshot: created.snapshot,
        configurationFiles: [],
        detectedAt: "2026-07-28T00:00:00.000Z",
        inputDigest: createAnalyzerInputDigest({
          analyzerKind: "typescript",
          configDigest: created.configDigest,
          inputs: [source],
        }, { digest: sha256CanonicalJson }),
        resolutionFiles: [],
        sourceFiles: [source],
        workspaceKey: "0".repeat(64),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ workerCode: "ANALYZER_RESOURCE_LIMIT" });
    const stats = readWorkerAnalysisCacheStatsForTests();
    expect(stats.outputBudgetPeakFacts).toBe(WORKER_OUTPUT_LIMITS.maxFactsPerFile + 1);
  });

  it("rejects a below-count Worker output that exceeds the clone-byte budget", () => {
    const suffix = "x".repeat(900);
    const source = sourceFile(
      "src/clone-budget.ts",
      Array.from({ length: 1_600 }, (_, index) =>
        `export const value${index}_${suffix} = ${index};`).join("\n"),
    );
    const observation = observeTypeScriptConfiguration({ configurationFiles: [], sourceFiles: [source] });
    const created = createAnalyzerConfigSnapshot({
      analyzerKind: "typescript",
      analyzerVersion: "6.0.3",
      consultedFiles: [],
      effectiveCompilerOptions: observation.effectiveCompilerOptions,
      effectiveIgnore: { effectiveDigest: "1".repeat(64), version: 1 },
      workspacePackages: [],
    }, { digest: sha256CanonicalJson });
    let failure: unknown;
    try {
      analyzeTypeScriptModules({
        configDigest: created.configDigest,
        configSnapshot: created.snapshot,
        configurationFiles: [],
        detectedAt: "2026-07-28T00:00:00.000Z",
        inputDigest: createAnalyzerInputDigest({
          analyzerKind: "typescript",
          configDigest: created.configDigest,
          inputs: [source],
        }, { digest: sha256CanonicalJson }),
        resolutionFiles: [],
        sourceFiles: [source],
        workspaceKey: "2".repeat(64),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ workerCode: "ANALYZER_RESOURCE_LIMIT" });
    const stats = readWorkerAnalysisCacheStatsForTests();
    expect(stats.outputBudgetPeakBytes).toBeLessThanOrEqual(
      WORKER_OUTPUT_LIMITS.maxEstimatedCloneBytesPerRequest + 1,
    );
  });

  it("CR6-006 stops project parsing before MAX+1 source membership work", () => {
    const createProjectInput = (projectCount: number) => {
      const configurationFiles = [byteFile("tsconfig.json", JSON.stringify({
        files: [],
        references: Array.from({ length: projectCount }, (_, index) => ({
          path: `./packages/limit-${index}/tsconfig.json`,
        })),
      }))];
      const resolutionFiles = Array.from({ length: projectCount }, (_, index) => byteFile(
        `packages/limit-${index}/tsconfig.json`,
        JSON.stringify({ include: ["src/**/*.ts"] }),
      ));
      const sources = Array.from({ length: projectCount }, (_, index) => sourceFile(
        `packages/limit-${index}/src/index.ts`,
        `export const value${index} = ${index};\n`,
      ));
      return {
        configurationEntryPaths: ["tsconfig.json"],
        configurationFiles,
        resolutionFiles,
        sourceFiles: sources,
      };
    };
    resetWorkerAnalysisCacheForTests();
    expect(() => observeTypeScriptConfiguration(
      createProjectInput(WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount),
    )).not.toThrow();
    resetWorkerAnalysisCacheForTests();
    const projectCount = WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount + 1;
    const overflow = createProjectInput(projectCount);
    let failure: unknown;
    try {
      observeTypeScriptConfiguration(overflow);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ workerCode: "ANALYZER_RESOURCE_LIMIT" });
    const stats = readWorkerAnalysisCacheStatsForTests();
    expect(stats.programBuilds).toBe(0);
    expect(stats.sourceProjectMembershipVisits).toBe(0);
  });

  it("stops SourceFile construction at the unique MAX+1 object", () => {
    resetWorkerAnalysisCacheForTests();
    const sources = Array.from(
      { length: WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount + 1 },
      (_, index) => sourceFile(`src/object-${index}.ts`, `export const v${index} = ${index};\n`),
    );

    expect(() => observeTypeScriptConfiguration({
      configurationFiles: [],
      sourceFiles: sources,
    })).toThrow(/SourceFile|对象|预算/u);
    expect(readWorkerAnalysisCacheStatsForTests().sourceFileObjectCreationPeak)
      .toBe(WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount + 1);
  }, 30_000);

  it("stops a growing metadata read after exactly MAX+1 sentinel bytes", async () => {
    const requested: number[] = [];
    await expect(readAnalyzerBytesBounded(async (chunk) => {
      requested.push(chunk.byteLength);
      chunk.fill(0x61);
      return chunk.byteLength;
    }, 128)).rejects.toMatchObject({ analyzerCode: "ANALYZER_RESOURCE_LIMIT" });

    expect(requested.reduce((sum, value) => sum + value, 0)).toBe(129);
  });

  it("bounds Worker resolution candidates before count or path bytes can be fully materialized", () => {
    resetWorkerAnalysisCacheForTests();
    const tooManyImports = Array.from(
      { length: MAX_WORKER_RESOLUTION_CANDIDATES + 32 },
      (_, index) => `import "package-${index}";`,
    ).join("\n");
    expect(() => observeTypeScriptConfiguration({
      configurationFiles: [],
      sourceFiles: [sourceFile("src/count-budget.ts", tooManyImports)],
    })).toThrow(/Worker|候选|预算/u);
    let stats = readWorkerAnalysisCacheStatsForTests();
    expect(stats.resolutionCandidatePeakCount).toBeLessThanOrEqual(
      MAX_WORKER_RESOLUTION_CANDIDATES,
    );
    expect(stats.moduleResolutionEntryCount).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxResolutionEntriesPerProject,
    );
    expect(stats.moduleResolutionRetainedBytes).toBeLessThanOrEqual(
      WORKER_ANALYSIS_CACHE_LIMITS.maxResolutionBytesPerProject,
    );

    resetWorkerAnalysisCacheForTests();
    const longSegment = "a".repeat(2_048);
    const longImports = Array.from({ length: 320 }, (_, index) =>
      `import "pkg-${index}-${longSegment}";`).join("\n");
    expect(() => observeTypeScriptConfiguration({
      configurationFiles: [],
      sourceFiles: [sourceFile("src/byte-budget.ts", longImports)],
    })).toThrow(/Worker|候选|字节|预算/u);
    stats = readWorkerAnalysisCacheStatsForTests();
    expect(stats.resolutionCandidatePeakBytes).toBeLessThanOrEqual(
      MAX_WORKER_RESOLUTION_CANDIDATE_PATH_BYTES,
    );
  });
});
