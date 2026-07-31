import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildGraphEntityId,
  createAnalyzerConfigSnapshot,
  createAnalyzerInputDigest,
} from "../../packages/application/src/index.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";
import {
  createTypeScriptAnalyzer,
} from "../../packages/adapters/analyzer-typescript/src/index.js";

const digestPort = { digest: sha256CanonicalJson };
const workspaceKey = "a".repeat(64);

/** 构造真实 Worker 使用的最小受控字节文件。 */
function byteFile(relativePath: string, source: string) {
  return Object.freeze({
    bytes: new TextEncoder().encode(source),
    contentHash: sha256CanonicalJson({ source }),
    path: relativePath,
  });
}

/** 返回由 workspace type/build 生成的真实 ESM Worker 入口。 */
function builtWorkerUrl(): URL {
  const workerPath = path.resolve(
    "packages/adapters/analyzer-typescript/dist/analyzer-worker.js",
  );
  if (!existsSync(workerPath)) {
    throw new Error("真实 Analyzer Worker 构建产物不存在，请先执行 workspace type/build。");
  }
  return pathToFileURL(workerPath);
}

/** 创建只保持事件循环活动、不返回响应的受控测试 Worker。 */
function pendingWorkerUrl(): URL {
  return new URL(
    "data:text/javascript," + encodeURIComponent(
      "import { parentPort } from 'node:worker_threads'; setInterval(() => parentPort, 1000);",
    ),
  );
}

/** 用受控 Worker payload 验证主线程协议边界，避免测试依赖真实 Worker 实现。 */
async function expectAnalysisProtocolInvalid(options: {
  effectiveCompilerOptions?: Readonly<Record<string, unknown>>;
  file: Readonly<Record<string, unknown>>;
  sourceText?: string;
}): Promise<void> {
  const sourceText = options.sourceText ?? "export const value = 1;\n";
  const source = Object.freeze({
    ...byteFile("src/index.ts", sourceText),
    fileId: buildGraphEntityId(workspaceKey, "file", "src/index.ts"),
    language: "typescript" as const,
  });
  const value = { consultedLogicalPaths: [], files: [options.file] };
  const workerUrl = new URL(
    "data:text/javascript," + encodeURIComponent([
      "import { parentPort } from 'node:worker_threads';",
      `const value = ${JSON.stringify(value)};`,
      "parentPort.on('message', (message) => parentPort.postMessage({ requestId: message.requestId, ok: true, value }));",
    ].join("\n")),
  );
  const analyzer = createTypeScriptAnalyzer({ workerUrl });
  try {
    await expect(analyzer.analyze({
      configDigest: "1".repeat(64),
      configSnapshot: {
        analyzerKind: "typescript",
        analyzerVersion: "6.0.3",
        consultedFiles: [],
        effectiveCompilerOptions: options.effectiveCompilerOptions ?? {},
        effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
        version: 1,
        workspacePackages: [],
      },
      configurationFiles: [],
      detectedAt: "2026-07-28T00:00:00.000Z",
      inputDigest: "3".repeat(64),
      resolutionFiles: [],
      sourceFiles: [source],
      workspaceKey,
    })).rejects.toMatchObject({ analyzerCode: "ANALYZER_PROTOCOL_INVALID" });
  } finally {
    await analyzer.close();
  }
}

describe("Story 1.5 TypeScript Analyzer Worker", () => {
  it("runs the built worker with TypeScript 6.0.3 and analyzes controlled source snapshots", async () => {
    expect(ts.version).toBe("6.0.3");
    const analyzer = createTypeScriptAnalyzer({ workerUrl: builtWorkerUrl() });
    const config = byteFile("tsconfig.json", JSON.stringify({
      compilerOptions: {
        allowJs: true,
        module: "NodeNext",
        moduleResolution: "NodeNext",
        target: "ES2024",
      },
    }));
    const sourceFiles = [
      Object.freeze({
        ...byteFile(
          "src/index.ts",
          "import path from 'node:path';\nimport { value } from './dep.js';\nexport { value };\nvoid path;\n",
        ),
        fileId: buildGraphEntityId(workspaceKey, "file", "src/index.ts"),
        language: "typescript" as const,
      }),
      Object.freeze({
        ...byteFile("src/dep.ts", "export const value = 1;\n"),
        fileId: buildGraphEntityId(workspaceKey, "file", "src/dep.ts"),
        language: "typescript" as const,
      }),
    ];
    try {
      const observation = await analyzer.observeConfiguration({
        configurationFiles: [config],
        sourceFiles,
      });
      const created = createAnalyzerConfigSnapshot({
        analyzerKind: "typescript",
        analyzerVersion: "6.0.3",
        consultedFiles: [{ contentHash: config.contentHash, path: config.path }],
        effectiveCompilerOptions: observation.effectiveCompilerOptions,
        effectiveIgnore: { effectiveDigest: "b".repeat(64), version: 1 },
        workspacePackages: [],
      }, digestPort);
      const inputDigest = createAnalyzerInputDigest({
        analyzerKind: "typescript",
        configDigest: created.configDigest,
        inputs: sourceFiles,
      }, digestPort);
      const output = await analyzer.analyze({
        configDigest: created.configDigest,
        configSnapshot: created.snapshot,
        configurationFiles: [config],
        detectedAt: "2026-07-27T00:00:00.000Z",
        inputDigest,
        resolutionFiles: [config],
        sourceFiles,
        workspaceKey,
      });

      const indexResult = output.files.find((file) => file.sourceFileId === sourceFiles[0]!.fileId);
      expect(observation.consultedLogicalPaths).toEqual(["tsconfig.json"]);
      expect(indexResult?.relations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          confidence: "high",
          target: expect.objectContaining({ id: "node:path", kind: "node-builtin" }),
        }),
        expect.objectContaining({
          confidence: "high",
          target: expect.objectContaining({
            id: sourceFiles[1]!.fileId,
            kind: "internal-file",
          }),
        }),
      ]));
    } finally {
      await analyzer.close();
      await analyzer.close();
    }
  });

  it("rejects malformed worker responses", async () => {
    const workerUrl = new URL(
      "data:text/javascript," + encodeURIComponent(
        "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ unexpected: true });",
      ),
    );
    const analyzer = createTypeScriptAnalyzer({ workerUrl });
    try {
      await expect(analyzer.observeConfiguration({ configurationFiles: [], sourceFiles: [] }))
        .rejects.toThrow(/响应不合法/u);
    } finally {
      await analyzer.close();
    }
  });

  it("CR6-007 rejects diagnostic, binding and relation ranges beyond source UTF-16 length", async () => {
    const sourceFileId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
    const invalidRange = { end: Number.MAX_SAFE_INTEGER, start: 0 };
    const baseFile = {
      diagnostics: [],
      language: "typescript",
      localExportBindings: [],
      path: "src/index.ts",
      relations: [],
      sourceFileId,
    };
    const variants = [
      {
        ...baseFile,
        diagnostics: [{
          code: "MODULE_RESOLUTION_FAILED",
          normalizedRange: invalidRange,
          path: "src/index.ts",
          severity: "warning",
          suggestedAction: "fix",
        }],
      },
      {
        ...baseFile,
        localExportBindings: [{
          exportedName: "value",
          language: "typescript",
          localName: "value",
          normalizedRange: invalidRange,
          sourceFileId,
          stableSortKey: ["value", "value", "value", "0", "1"].join("\0"),
          typeOrValue: "value",
        }],
      },
      {
        ...baseFile,
        relations: [{
          confidence: "high",
          language: "typescript",
          normalizedRange: invalidRange,
          provenance: "typescript-compiler-api",
          qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
          relationType: "imports",
          target: { id: "node:path", kind: "node-builtin", moduleName: "path" },
        }],
      },
    ];

    for (const file of variants) {
      await expectAnalysisProtocolInvalid({ file });
    }
  });

  it("CR6-008 recomputes static target confidence from host-owned context", async () => {
    const sourceFileId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
    const baseFile = {
      diagnostics: [],
      language: "typescript",
      localExportBindings: [],
      path: "src/index.ts",
      sourceFileId,
    };
    const relation = {
      language: "typescript",
      normalizedRange: { end: 6, start: 0 },
      provenance: "typescript-compiler-api",
      qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
      relationType: "imports",
    };
    const completeProjects = {
      projectConfigurations: [{
        configPath: "tsconfig.json",
        configurationComplete: true,
        effectiveCompilerOptions: {},
        sourcePaths: ["src/index.ts"],
      }],
    };
    await expectAnalysisProtocolInvalid({
      effectiveCompilerOptions: completeProjects,
      file: {
        ...baseFile,
        relations: [{
          ...relation,
          confidence: "medium",
          target: { id: "node:path", kind: "node-builtin", moduleName: "path" },
        }],
      },
    });
    await expectAnalysisProtocolInvalid({
      effectiveCompilerOptions: completeProjects,
      file: {
        ...baseFile,
        relations: [{
          ...relation,
          confidence: "low",
          target: {
            id: "pkg:npm/example@1.2.3",
            kind: "external-package",
            packageName: "example",
            packageVersion: "1.2.3",
            versionState: "resolved",
          },
        }],
      },
    });
    await expectAnalysisProtocolInvalid({
      effectiveCompilerOptions: {
        projectConfigurations: [{
          configPath: "tsconfig.json",
          configurationComplete: false,
          effectiveCompilerOptions: {},
          sourcePaths: ["src/index.ts"],
        }],
      },
      file: {
        ...baseFile,
        relations: [{
          ...relation,
          confidence: "high",
          target: {
            id: sourceFileId,
            kind: "internal-file",
            resolvedPath: "src/index.ts",
          },
        }],
      },
    });
    for (const target of [
      { id: "node:path", kind: "node-builtin", moduleName: "path" },
      {
        id: "pkg:npm/example@1.2.3",
        kind: "external-package",
        packageName: "example",
        packageVersion: "1.2.3",
        versionState: "resolved",
      },
    ]) {
      await expectAnalysisProtocolInvalid({
        effectiveCompilerOptions: {
          projectConfigurations: [{
            configPath: "tsconfig.json",
            configurationComplete: false,
            effectiveCompilerOptions: {},
            sourcePaths: ["src/index.ts"],
          }],
        },
        file: {
          ...baseFile,
          relations: [{
            ...relation,
            confidence: "high",
            target,
          }],
        },
      });
    }
  });

  it("CR9-005 rejects over-admission requests before starting the Worker", async () => {
    const workerUrl = new URL(
      "data:text/javascript," + encodeURIComponent([
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.on('message', (message) => parentPort.postMessage({ requestId: message.requestId, ok: true, value: { consultedLogicalPaths: [], effectiveCompilerOptions: {}, projectConfigurations: [], resolutionCandidateLogicalPaths: [] } }));",
      ].join("\n")),
    );
    const analyzer = createTypeScriptAnalyzer({ workerUrl });
    const sourceFiles = Array.from({ length: 5_001 }, (_, index) => Object.freeze({
      ...byteFile(`src/admission-${index}.ts`, `export const value${index} = ${index};\n`),
      fileId: buildGraphEntityId(workspaceKey, "file", `src/admission-${index}.ts`),
      language: "typescript" as const,
    }));
    try {
      await expect(analyzer.observeConfiguration({
        configurationFiles: [],
        sourceFiles,
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_RESOURCE_LIMIT" });
    } finally {
      await analyzer.close();
    }
  });

  it("validates ok:true payloads according to the request kind", async () => {
    const workerUrl = new URL(
      "data:text/javascript," + encodeURIComponent(
        [
          "import { parentPort, workerData } from 'node:worker_threads';",
          "const respond = (message) => parentPort.postMessage({ requestId: message.requestId ?? 1, ok: true, value: {} });",
          "if (workerData?.kind) respond({ requestId: 1 }); else parentPort.on('message', respond);",
        ].join("\n"),
      ),
    );
    const analyzer = createTypeScriptAnalyzer({ workerUrl });
    try {
      await expect(analyzer.observeConfiguration({
        configurationEntryPaths: [],
        configurationFiles: [],
        sourceFiles: [],
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_PROTOCOL_INVALID" });
    } finally {
      await analyzer.close();
    }
  });

  it("rejects nested invalid analyze payloads as protocol failures", async () => {
    const workerUrl = new URL(
      "data:text/javascript," + encodeURIComponent([
        "import { parentPort, workerData } from 'node:worker_threads';",
        "const value = { consultedLogicalPaths: [], files: [{ diagnostics: [], localExportBindings: [], relations: [null], sourceFileId: 'file-1' }] };",
        "const respond = (message) => parentPort.postMessage({ requestId: message.requestId ?? 1, ok: true, value });",
        "if (workerData?.kind) respond({ requestId: 1 }); else parentPort.on('message', respond);",
      ].join("\n")),
    );
    const analyzer = createTypeScriptAnalyzer({ workerUrl });
    try {
      await expect(analyzer.analyze({
        configDigest: "1".repeat(64),
        configSnapshot: {
          analyzerKind: "typescript",
          analyzerVersion: "6.0.3",
          consultedFiles: [],
          effectiveCompilerOptions: {},
          effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
          version: 1,
          workspacePackages: [],
        },
        configurationFiles: [],
        detectedAt: "2026-07-27T00:00:00.000Z",
        inputDigest: "3".repeat(64),
        resolutionFiles: [],
        sourceFiles: [],
        workspaceKey,
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_PROTOCOL_INVALID" });
    } finally {
      await analyzer.close();
    }
  });

  it("rejects relationType and qualifier combinations outside the discriminated union", async () => {
    const workerUrl = new URL(
      "data:text/javascript," + encodeURIComponent([
        "import { parentPort, workerData } from 'node:worker_threads';",
        "const relation = { confidence: 'high', language: 'typescript', normalizedRange: { start: 0, end: 1 }, provenance: 'typescript-compiler-api', qualifier: { kind: 'star', typeOrValue: 'value', version: 1 }, relationType: 'imports', target: { id: 'node:path', kind: 'node-builtin', moduleName: 'path' } };",
        "const value = { consultedLogicalPaths: [], files: [{ diagnostics: [], localExportBindings: [], relations: [relation], sourceFileId: 'file-1' }] };",
        "const respond = (message) => parentPort.postMessage({ requestId: message.requestId ?? 1, ok: true, value });",
        "if (workerData?.kind) respond({ requestId: 1 }); else parentPort.on('message', respond);",
      ].join("\n")),
    );
    const analyzer = createTypeScriptAnalyzer({ workerUrl });
    try {
      await expect(analyzer.analyze({
        configDigest: "1".repeat(64),
        configSnapshot: {
          analyzerKind: "typescript",
          analyzerVersion: "6.0.3",
          consultedFiles: [],
          effectiveCompilerOptions: {},
          effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
          version: 1,
          workspacePackages: [],
        },
        configurationFiles: [],
        detectedAt: "2026-07-27T00:00:00.000Z",
        inputDigest: "3".repeat(64),
        resolutionFiles: [],
        sourceFiles: [],
        workspaceKey,
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_PROTOCOL_INVALID" });
    } finally {
      await analyzer.close();
    }
  });

  it("rejects builtin and internal targets that are not bound to host semantics", async () => {
    const targets = [
      "{ id: 'node:not-a-real-builtin', kind: 'node-builtin', moduleName: 'not-a-real-builtin' }",
      "{ id: 'file-outside-manifest', kind: 'internal-file' }",
    ];
    for (const target of targets) {
      const workerUrl = new URL(
        "data:text/javascript," + encodeURIComponent([
          "import { parentPort } from 'node:worker_threads';",
          `const target = ${target};`,
          "const relation = { confidence: 'high', language: 'typescript', normalizedRange: { start: 0, end: 1 }, provenance: 'typescript-compiler-api', qualifier: { kind: 'imports', typeOrValue: 'value', version: 1 }, relationType: 'imports', target };",
          "const value = { consultedLogicalPaths: [], files: [{ diagnostics: [], localExportBindings: [], relations: [relation], sourceFileId: 'file-valid' }] };",
          "parentPort.on('message', (message) => parentPort.postMessage({ requestId: message.requestId, ok: true, value }));",
        ].join("\n")),
      );
      const analyzer = createTypeScriptAnalyzer({ workerUrl });
      try {
        await expect(analyzer.analyze({
          configDigest: "1".repeat(64),
          configSnapshot: {
            analyzerKind: "typescript",
            analyzerVersion: "6.0.3",
            consultedFiles: [],
            effectiveCompilerOptions: {},
            effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
            version: 1,
            workspacePackages: [],
          },
          configurationFiles: [],
          detectedAt: "2026-07-28T00:00:00.000Z",
          inputDigest: "3".repeat(64),
          resolutionFiles: [],
          sourceFiles: [{
            bytes: new TextEncoder().encode("export {};\n"),
            contentHash: "4".repeat(64),
            fileId: "file-valid",
            language: "typescript",
            path: "src/index.ts",
          }],
          workspaceKey,
        })).rejects.toMatchObject({ analyzerCode: "ANALYZER_PROTOCOL_INVALID" });
      } finally {
        await analyzer.close();
      }
    }
  });

  it("rejects cross-field source, language, confidence and target identity spoofing", async () => {
    const sourceId = buildGraphEntityId(workspaceKey, "file", "src/index.ts");
    const dependencyId = buildGraphEntityId(workspaceKey, "file", "src/dep.ts");
    const range = { end: 1, start: 0 };
    const baseBinding = {
      exportedName: "value",
      language: "typescript",
      localName: "value",
      normalizedRange: range,
      sourceFileId: sourceId,
      stableSortKey: ["value", "value", "value", "0", "1"].join("\0"),
      typeOrValue: "value",
    };
    const baseRelation = {
      confidence: "high",
      language: "typescript",
      normalizedRange: range,
      provenance: "typescript-compiler-api",
      qualifier: { kind: "imports", typeOrValue: "value", version: 1 },
      relationType: "imports",
      target: { id: "node:path", kind: "node-builtin", moduleName: "path" },
    };
    const baseFile = {
      diagnostics: [],
      language: "typescript",
      localExportBindings: [baseBinding],
      path: "src/index.ts",
      relations: [baseRelation],
      sourceFileId: sourceId,
    };
    const invalidFiles = [
      { ...baseFile, diagnostics: [{
        code: "MODULE_RESOLUTION_FAILED",
        normalizedRange: range,
        path: "src/dep.ts",
        severity: "warning",
        suggestedAction: "fix",
      }] },
      { ...baseFile, localExportBindings: [{ ...baseBinding, sourceFileId: dependencyId }] },
      { ...baseFile, localExportBindings: [{ ...baseBinding, language: "javascript" }] },
      { ...baseFile, relations: [{ ...baseRelation, language: "javascript" }] },
      { ...baseFile, relations: [{
        ...baseRelation,
        confidence: "high",
        qualifier: { kind: "imports", typeOrValue: "dynamic", version: 1 },
      }] },
      { ...baseFile, relations: [{
        ...baseRelation,
        confidence: "high",
        target: {
          id: "pkg:npm/pkg@unresolved",
          kind: "external-package",
          packageName: "pkg",
          packageVersion: null,
          versionState: "unresolved",
        },
      }] },
      { ...baseFile, relations: [{
        ...baseRelation,
        target: {
          id: dependencyId,
          kind: "internal-file",
          resolvedPath: "src/index.ts",
        },
      }] },
      { ...baseFile, relations: [{
        ...baseRelation,
        target: {
          id: "pkg:npm/spoof@9.9.9",
          kind: "external-package",
          packageName: "pkg",
          packageVersion: "1.2.3",
          versionState: "resolved",
        },
      }] },
    ];
    for (const file of invalidFiles) {
      const workerUrl = new URL(
        "data:text/javascript," + encodeURIComponent([
          "import { parentPort } from 'node:worker_threads';",
          `const value = ${JSON.stringify({ consultedLogicalPaths: [], files: [file] })};`,
          "parentPort.on('message', (message) => parentPort.postMessage({ requestId: message.requestId, ok: true, value }));",
        ].join("\n")),
      );
      const analyzer = createTypeScriptAnalyzer({ workerUrl });
      try {
        await expect(analyzer.analyze({
          configDigest: "1".repeat(64),
          configSnapshot: {
            analyzerKind: "typescript",
            analyzerVersion: "6.0.3",
            consultedFiles: [],
            effectiveCompilerOptions: {},
            effectiveIgnore: { effectiveDigest: "2".repeat(64), version: 1 },
            version: 1,
            workspacePackages: [],
          },
          configurationFiles: [],
          detectedAt: "2026-07-28T00:00:00.000Z",
          inputDigest: "3".repeat(64),
          resolutionFiles: [],
          sourceFiles: [
            {
              bytes: new TextEncoder().encode("export const value = 1;\n"),
              contentHash: "4".repeat(64),
              fileId: sourceId,
              language: "typescript",
              path: "src/index.ts",
            },
            {
              bytes: new TextEncoder().encode("export const dep = 1;\n"),
              contentHash: "5".repeat(64),
              fileId: dependencyId,
              language: "typescript",
              path: "src/dep.ts",
            },
          ],
          workspaceKey,
        })).rejects.toMatchObject({ analyzerCode: "ANALYZER_PROTOCOL_INVALID" });
      } finally {
        await analyzer.close();
      }
    }
  });

  it("maps Worker configuration, resource and execution failures to distinct closed codes", async () => {
    const configAnalyzer = createTypeScriptAnalyzer({ workerUrl: builtWorkerUrl() });
    try {
      await expect(configAnalyzer.observeConfiguration({
        configurationEntryPaths: ["tsconfig.json"],
        configurationFiles: [byteFile("tsconfig.json", "{ invalid json")],
        sourceFiles: [],
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_CONFIG_INVALID" });
    } finally {
      await configAnalyzer.close();
    }

    const resourceAnalyzer = createTypeScriptAnalyzer({ workerUrl: builtWorkerUrl() });
    const source = Object.freeze({
      ...byteFile(
        "src/fact-budget.ts",
        Array.from({ length: 5_000 }, (_, index) =>
          `export const value${index} = ${index};`).join("\n"),
      ),
      fileId: buildGraphEntityId(workspaceKey, "file", "src/fact-budget.ts"),
      language: "typescript" as const,
    });
    try {
      const observation = await resourceAnalyzer.observeConfiguration({
        configurationFiles: [],
        sourceFiles: [source],
      });
      const created = createAnalyzerConfigSnapshot({
        analyzerKind: "typescript",
        analyzerVersion: "6.0.3",
        consultedFiles: [],
        effectiveCompilerOptions: observation.effectiveCompilerOptions,
        effectiveIgnore: { effectiveDigest: "5".repeat(64), version: 1 },
        workspacePackages: [],
      }, digestPort);
      await expect(resourceAnalyzer.analyze({
        configDigest: created.configDigest,
        configSnapshot: created.snapshot,
        configurationFiles: [],
        detectedAt: "2026-07-28T00:00:00.000Z",
        inputDigest: createAnalyzerInputDigest({
          analyzerKind: "typescript",
          configDigest: created.configDigest,
          inputs: [source],
        }, digestPort),
        resolutionFiles: [],
        sourceFiles: [source],
        workspaceKey,
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_RESOURCE_LIMIT" });
    } finally {
      await resourceAnalyzer.close();
    }

    const executionWorkerUrl = new URL(
      "data:text/javascript," + encodeURIComponent([
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.on('message', () => { throw new Error('boom'); });",
      ].join("\n")),
    );
    const executionAnalyzer = createTypeScriptAnalyzer({ workerUrl: executionWorkerUrl });
    try {
      await expect(executionAnalyzer.observeConfiguration({
        configurationFiles: [],
        sourceFiles: [],
      })).rejects.toMatchObject({ analyzerCode: "ANALYZER_EXECUTION_FAILED" });
    } finally {
      await executionAnalyzer.close();
    }
  });

  it("reuses one worker and omits unchanged bytes after the first request", async () => {
    const workerUrl = new URL(
      "data:text/javascript," + encodeURIComponent([
        "import { parentPort, workerData } from 'node:worker_threads';",
        "let requestCount = 0;",
        "const respond = (message) => {",
        "  requestCount += 1;",
        "  const input = message.request?.input ?? message.input;",
        "  const files = [...(input.configurationFiles ?? []), ...(input.resolutionFiles ?? []), ...(input.sourceFiles ?? [])];",
        "  const byteFileCount = files.filter((file) => file.bytes !== undefined).length;",
        "  parentPort.postMessage({ requestId: message.requestId ?? 1, ok: true, value: {",
        "    consultedLogicalPaths: [],",
        "    effectiveCompilerOptions: { byteFileCount, requestCount },",
        "    projectConfigurations: [],",
        "    resolutionCandidateLogicalPaths: [],",
        "  } });",
        "};",
        "if (workerData?.kind) respond(workerData); else parentPort.on('message', respond);",
      ].join("\n")),
    );
    const analyzer = createTypeScriptAnalyzer({ workerUrl });
    const config = byteFile("tsconfig.json", "{}");
    const source = Object.freeze({
      ...byteFile("src/index.ts", "export const value = 1;\n"),
      fileId: "file-index",
      language: "typescript" as const,
    });
    try {
      const first = await analyzer.observeConfiguration({
        configurationFiles: [config],
        sourceFiles: [source],
      });
      const second = await analyzer.observeConfiguration({
        configurationFiles: [config],
        sourceFiles: [source],
      });

      expect(first.effectiveCompilerOptions).toMatchObject({
        byteFileCount: 2,
        requestCount: 1,
      });
      expect(second.effectiveCompilerOptions).toMatchObject({
        byteFileCount: 0,
        requestCount: 2,
      });
    } finally {
      await analyzer.close();
    }
  });

  it("CR6-012 rejects request timeout values above the Node timer ceiling", () => {
    expect(() => createTypeScriptAnalyzer({ requestTimeoutMs: 3_000_000_000 }))
      .toThrow(/timer|上限/u);
  });

  it("bounds timeout, cancellation and idempotent close", async () => {
    const timed = createTypeScriptAnalyzer({ requestTimeoutMs: 20, workerUrl: pendingWorkerUrl() });
    await expect(timed.observeConfiguration({ configurationFiles: [], sourceFiles: [] }))
      .rejects.toThrow(/超时/u);
    await timed.close();

    const cancelled = createTypeScriptAnalyzer({ workerUrl: pendingWorkerUrl() });
    const controller = new AbortController();
    const cancelledRequest = cancelled.observeConfiguration(
      { configurationFiles: [], sourceFiles: [] },
      controller.signal,
    );
    controller.abort();
    await expect(cancelledRequest).rejects.toMatchObject({ name: "AbortError" });
    await cancelled.close();

    const closed = createTypeScriptAnalyzer({ workerUrl: pendingWorkerUrl() });
    const pending = closed.observeConfiguration({ configurationFiles: [], sourceFiles: [] });
    const firstClose = closed.close();
    const secondClose = closed.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    await expect(pending).rejects.toThrow(/异常退出/u);
    await closed.close();
    await expect(closed.observeConfiguration({ configurationFiles: [], sourceFiles: [] }))
      .rejects.toThrow(/已关闭/u);
  });
});
