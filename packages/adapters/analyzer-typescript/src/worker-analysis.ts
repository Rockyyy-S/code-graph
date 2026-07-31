import path from "node:path";
import ts from "typescript";
import {
  normalizeHostPathIdentity,
  normalizeEffectiveCompilerOptions,
  type AnalysisInputV1,
  type AnalysisOutputV1,
  type AnalyzerByteFileV1,
  type AnalyzerConfigurationInputV1,
  type AnalyzerConfigurationObservationV1,
  type AnalyzerHostPathIdentitySidecarV1,
  type AnalyzerSourceFileV1,
  type ModuleRelationSeedV1,
} from "@codegraph/application";
import {
  normalizeRelativeGraphPath,
  type AnalysisDiagnosticV1,
} from "@codegraph/domain";
import { extractModuleSyntaxFacts } from "./module-syntax.js";
import {
  packageNameFromNpmSpecifier,
  resolveModuleTarget,
} from "./module-target-resolver.js";

const VIRTUAL_ROOT = "/workspace";
export const MAX_WORKER_RESOLUTION_CANDIDATES = 4_096;
export const MAX_WORKER_RESOLUTION_CANDIDATE_PATH_BYTES = 512 * 1024;
/** 单请求原始输入在解码与 Program 构建前执行的确定性 admission 上限。 */
export const WORKER_INPUT_LIMITS = Object.freeze({
  maxPathBytesPerRequest: 1024 * 1024,
  maxRawBytesPerRequest: 64 * 1024 * 1024,
  maxSourceFilesPerRequest: 5_000,
  maxTotalFilesPerRequest: 6_144,
});
export const WORKER_ANALYSIS_CACHE_LIMITS = Object.freeze({
  maxDirectoryEntryCount: 16_384,
  maxProgramCount: 51,
  maxProjectStates: 16,
  maxProjectRetainedBytes: 40 * 1024 * 1024,
  maxRetainedBytes: 48 * 1024 * 1024,
  maxRetainedFacts: 8_192,
  maxResolutionBytesPerProject: 512 * 1024,
  maxResolutionEntriesPerProject: 512,
  maxSourceFileObjectCount: 5_256,
  maxSyntaxRetainedBytes: 8 * 1024 * 1024,
});

/** 单次 analyze 成功 payload 的确定性数量与估算 structured-clone 字节预算。 */
export const WORKER_OUTPUT_LIMITS = Object.freeze({
  maxEstimatedCloneBytesPerRequest: 4 * 1024 * 1024,
  maxFactsPerFile: 4_096,
  maxFactsPerRequest: 16_384,
});

/** Worker 内部只允许四类封闭失败穿过线程协议。 */
export type WorkerAnalysisErrorCode =
  | "ANALYZER_CONFIG_INVALID"
  | "ANALYZER_EXECUTION_FAILED"
  | "ANALYZER_PROTOCOL_INVALID"
  | "ANALYZER_RESOURCE_LIMIT";

/** Worker 失败携带稳定 code，主线程不得根据消息文本猜测分类。 */
export class WorkerAnalysisError extends Error {
  public readonly workerCode: WorkerAnalysisErrorCode;

  public constructor(workerCode: WorkerAnalysisErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerAnalysisError";
    this.workerCode = workerCode;
  }
}

/** 将公共 API/资源/协议/未知执行异常精确收敛为封闭 Worker 错误。 */
export function classifyWorkerAnalysisError(error: unknown): WorkerAnalysisError {
  if (error instanceof WorkerAnalysisError) {return error;}
  if (error instanceof RangeError) {
    return new WorkerAnalysisError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker 超过确定性资源预算。",
      { cause: error },
    );
  }
  if (error instanceof TypeError) {
    return new WorkerAnalysisError(
      "ANALYZER_CONFIG_INVALID",
      "TypeScript Analyzer Worker 配置或受控输入不合法。",
      { cause: error },
    );
  }
  return new WorkerAnalysisError(
    "ANALYZER_EXECUTION_FAILED",
    "TypeScript Analyzer Worker 执行失败。",
    { cause: error },
  );
}

interface CachedSyntaxFacts {
  factCount: number;
  facts: ReturnType<typeof extractModuleSyntaxFacts>;
  retainedBytes: number;
}

const incrementalSyntaxCache = new Map<
  string,
  CachedSyntaxFacts
>();
const incrementalProjectCache = new Map<string, IncrementalProjectState>();
let retainedSyntaxBytes = 0;
let retainedSyntaxFacts = 0;
let retainedProjectBytes = 0;
const cacheMetrics = {
  configReadDirectoryFileVisits: 0,
  directoryExistsCalls: 0,
  directoryIndexBuildFileVisits: 0,
  externalPackageFallbackAncestorLookups: 0,
  externalPackageFallbackIndexBuildFileVisits: 0,
  externalPackageFallbackLookups: 0,
  getDirectoriesCalls: 0,
  moduleResolutionCacheHits: 0,
  moduleResolutionExecutions: 0,
  outputBudgetPeakBytes: 0,
  outputBudgetPeakFacts: 0,
  outputBudgetValueVisits: 0,
  programBuilds: 0,
  programReuses: 0,
  reusedSourceFiles: 0,
  resolutionCandidatePeakBytes: 0,
  resolutionCandidatePeakCount: 0,
  sourceProjectLookupCalls: 0,
  sourceProjectMembershipVisits: 0,
  sourceFileObjectCreationPeak: 0,
};

/** 量化缓存/解析复杂度的只读测试观测，不暴露可变 TypeScript 对象。 */
export function readWorkerAnalysisCacheStatsForTests(): Readonly<Record<string, number>> {
  const states = [...incrementalProjectCache.values()];
  return Object.freeze({
    ...cacheMetrics,
    moduleResolutionEntryCount: states.reduce(
      (sum, state) => sum + state.moduleResolutionResults.size,
      0,
    ),
    moduleResolutionRetainedBytes: states.reduce(
      (sum, state) => sum + state.moduleResolutionBytes,
      0,
    ),
    projectRetainedBytes: retainedProjectBytes,
    projectStateCount: incrementalProjectCache.size,
    programCount: states.reduce((sum, state) => sum + state.programCount, 0),
    retainedBytes: retainedProjectBytes + retainedSyntaxBytes,
    retainedFacts: retainedSyntaxFacts,
    sourceFileObjectCount: states.reduce(
      (sum, state) => sum + state.sourceFileObjectCount,
      0,
    ),
    directoryEntryCount: states.reduce(
      (sum, state) => sum + state.directoryEntryCount,
      0,
    ),
    syntaxEntryCount: incrementalSyntaxCache.size,
    syntaxRetainedBytes: retainedSyntaxBytes,
  });
}

/** 单测之间清空持久 Worker 等价状态，生产请求不会调用。 */
export function resetWorkerAnalysisCacheForTests(): void {
  incrementalSyntaxCache.clear();
  incrementalProjectCache.clear();
  retainedSyntaxBytes = 0;
  retainedSyntaxFacts = 0;
  retainedProjectBytes = 0;
  for (const key of Object.keys(cacheMetrics) as Array<keyof typeof cacheMetrics>) {
    cacheMetrics[key] = 0;
  }
}

/** 纯 Worker 配置观察入口，便于同一实现被真实 Worker 与精确单测共享。 */
export function observeTypeScriptConfiguration(
  input: AnalyzerConfigurationInputV1,
): AnalyzerConfigurationObservationV1 {
  assertWorkerInputAdmission(input);
  const allFiles = [
    ...input.configurationFiles,
    ...(input.resolutionFiles ?? []),
    ...input.sourceFiles,
  ];
  const blockedResolutionPaths = new Set(
    (input.blockedResolutionLogicalPaths ?? []).map((entry) => normalizeRelativeGraphPath(entry)),
  );
  const files = createVirtualFileMap(
    allFiles,
    blockedResolutionPaths,
    input.caseSensitiveFileNames ?? true,
    input.hostPathIdentitySidecar,
  );
  const blockedResolutionPathKeys = new Set([...blockedResolutionPaths].map((logicalPath) =>
    files.lookupKey(toVirtualPath(logicalPath))));
  const incrementalState = prepareIncrementalProjectState(
    allFiles,
    files,
    input.sourceFiles,
    input.configurationEntryPaths,
  );
  const parsed = parseCompilerConfiguration(
    files,
    input.sourceFiles,
    input.configurationEntryPaths,
    incrementalState.directoryIndex,
  );
  refreshIncrementalPrograms(incrementalState, files, input.sourceFiles, parsed);
  discoverResolutionCandidatePaths(
    blockedResolutionPathKeys,
    files,
    input.sourceFiles,
    parsed,
    parsed.consultedPaths,
    incrementalState,
  );
  const projectConfigurations = serializeProjectConfigurations(parsed.projects);
  return Object.freeze({
    consultedLogicalPaths: Object.freeze([...parsed.consultedPaths].sort(compareText)),
    effectiveCompilerOptions: serializeObservedConfiguration(parsed, projectConfigurations),
    projectConfigurations,
    requiredMissingLogicalPaths: parsed.requiredMissingPaths.valuesSorted(),
    resolutionCandidateLogicalPaths: parsed.resolutionCandidatePaths.valuesSorted(),
  });
}

/**
 * 运行公开模块解析并记录 Worker 想访问的逻辑文件候选。
 *
 * 候选路径不在 Worker 内读取；graph-service 经过 realpath、身份与预算检查后再回送字节。
 */
function discoverResolutionCandidatePaths(
  blockedResolutionPathKeys: ReadonlySet<string>,
  files: VirtualFileMap,
  sourceFiles: readonly AnalyzerSourceFileV1[],
  parsed: ParsedCompilerConfiguration,
  consultedPaths: Set<string>,
  incrementalState: IncrementalProjectState,
): void {
  const sourcePathSet = new Set(sourceFiles.map((file) => files.lookupKey(toVirtualPath(file.path))));
  const observeFile = (fileName: string): string | null => {
    const logicalPath = toLogicalPath(files.canonicalPath(fileName));
    const logicalPathKey = logicalPath === null ? null : files.lookupKey(toVirtualPath(logicalPath));
    if (logicalPath !== null && !sourcePathSet.has(files.lookupKey(toVirtualPath(logicalPath)))) {
      parsed.resolutionCandidatePaths.add(logicalPath);
      if (files.has(normalizeVirtualPath(fileName)) &&
        logicalPathKey !== null && !blockedResolutionPathKeys.has(logicalPathKey)) {
        consultedPaths.add(logicalPath);
      }
    }
    return logicalPath;
  };
  const host: ts.ModuleResolutionHost = {
    directoryExists: (directoryName) => {
      const normalized = normalizeVirtualPath(directoryName);
      /** 发现阶段允许 TypeScript 探测虚拟根内尚未回送的候选目录。 */
      return normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`);
    },
    fileExists: (fileName) => {
      const logicalPath = observeFile(fileName);
      return files.has(normalizeVirtualPath(fileName)) ||
        (logicalPath !== null &&
          blockedResolutionPathKeys.has(files.lookupKey(toVirtualPath(logicalPath))));
    },
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getDirectories: (directoryName) => incrementalState.directoryIndex.getDirectories(directoryName),
    readFile: (fileName) => {
      const logicalPath = observeFile(fileName);
      const content = files.get(normalizeVirtualPath(fileName));
      return content ?? (logicalPath !== null &&
        blockedResolutionPathKeys.has(files.lookupKey(toVirtualPath(logicalPath)))
        ? ""
        : undefined);
    },
    realpath: (fileName) => files.canonicalPath(fileName),
    useCaseSensitiveFileNames: files.caseSensitiveFileNames,
  };
  for (const file of [...sourceFiles].sort((left, right) => compareText(left.path, right.path))) {
    const options = compilerOptionsForSource(parsed, file.path);
    const sourceText = decodeUtf8(file.bytes, file.path);
    const impliedNodeFormat = ts.getImpliedNodeFormatForFile(
      toVirtualPath(file.path),
      undefined,
      host,
      options,
    );
    const syntax = extractCachedModuleSyntaxFacts(
      file,
      sourceText,
      options,
      impliedNodeFormat,
      incrementalState.sourceFilesByLogicalPath.get(file.path),
    );
    for (const relation of syntax.relations) {
      resolveModuleWithCache(
        incrementalState,
        relation.specifier,
        toVirtualPath(file.path),
        options,
        host,
        relation.typescriptResolutionMode,
      );
    }
  }
}

/**
 * 使用 TypeScript 6 公开 AST 与 resolveModuleName 分析受控内存文件系统。
 *
 * Worker 不读取任意工作区物理路径，也不执行 plugin、transformer 或 package scripts。
 */
export function analyzeTypeScriptModules(input: AnalysisInputV1): AnalysisOutputV1 {
  assertWorkerInputAdmission(input);
  if ((input.configSnapshot.absentFiles?.length ?? 0) > 0) {
    throw new TypeError("Analyzer 配置闭包仍存在缺失文件，拒绝生成模块事实。");
  }
  const allFiles = [...input.configurationFiles, ...input.resolutionFiles, ...input.sourceFiles];
  const blockedResolutionPathSet = new Set([
    ...(input.blockedResolutionLogicalPaths ?? []),
    ...(input.configSnapshot.blockedResolutionFiles ?? []).map((file) => file.path),
  ].map((entry) => normalizeRelativeGraphPath(entry)));
  const files = createVirtualFileMap(
    allFiles,
    blockedResolutionPathSet,
    input.caseSensitiveFileNames ?? true,
    input.hostPathIdentitySidecar,
  );
  const blockedResolutionPathKeys = new Set([...blockedResolutionPathSet].map((logicalPath) =>
    files.lookupKey(toVirtualPath(logicalPath))));
  const incrementalState = prepareIncrementalProjectState(
    allFiles,
    files,
    input.sourceFiles,
    input.configurationEntryPaths,
  );
  const parsed = parseCompilerConfiguration(
    files,
    input.sourceFiles,
    input.configurationEntryPaths,
    incrementalState.directoryIndex,
  );
  refreshIncrementalPrograms(incrementalState, files, input.sourceFiles, parsed);
  const expectedOptions = normalizeEffectiveCompilerOptions(input.configSnapshot.effectiveCompilerOptions);
  if (JSON.stringify(serializeObservedConfiguration(
    parsed,
    serializeProjectConfigurations(parsed.projects),
  )) !== JSON.stringify(expectedOptions)) {
    throw new TypeError("冻结的 AnalyzerConfigSnapshot 与 Worker 配置观察不一致。");
  }
  const consultedPaths = new Set(parsed.consultedPaths);
  const sourcePathSet = new Set(input.sourceFiles.map((file) =>
    files.lookupKey(toVirtualPath(file.path))));
  const moduleResolutionHost: ts.ModuleResolutionHost = {
    directoryExists: (directoryName) => incrementalState.directoryIndex.directoryExists(directoryName),
    fileExists: (fileName) => {
      const logicalPath = toLogicalPath(files.canonicalPath(fileName));
      return files.has(normalizeVirtualPath(fileName)) ||
        (logicalPath !== null &&
          blockedResolutionPathKeys.has(files.lookupKey(toVirtualPath(logicalPath))));
    },
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getDirectories: (directoryName) => incrementalState.directoryIndex.getDirectories(directoryName),
    readFile: (fileName) => {
      const logicalPath = toLogicalPath(files.canonicalPath(fileName));
      if (logicalPath !== null && !sourcePathSet.has(files.lookupKey(toVirtualPath(logicalPath))) &&
        !blockedResolutionPathKeys.has(files.lookupKey(toVirtualPath(logicalPath)))) {
        consultedPaths.add(logicalPath);
      }
      const content = files.get(normalizeVirtualPath(fileName));
      return content ?? (logicalPath !== null &&
        blockedResolutionPathKeys.has(files.lookupKey(toVirtualPath(logicalPath)))
        ? ""
        : undefined);
    },
    realpath: (fileName) => files.canonicalPath(fileName),
    useCaseSensitiveFileNames: files.caseSensitiveFileNames,
  };
  const indexingManifest = input.sourceFiles.map((file) => ({
    fileId: file.fileId,
    path: file.path,
  }));
  /** manifest 派生索引与 Worker 文件表共享稳定 canonical key，不携带请求 raw proof。 */
  const hostPathIdentityKey = (logicalPath: string) =>
    files.lookupKey(toVirtualPath(logicalPath));
  const externalFallbackIndex = buildExternalPackageFallbackIndex(
    files,
    incrementalState.directoryIndex,
  );
  const requestBudget = { bytes: 0, facts: 0 };
  const results = [...input.sourceFiles].sort((left, right) => compareText(left.path, right.path))
    .map((file) => {
      const outputBudget = new BoundedWorkerOutputSink(requestBudget);
      outputBudget.appendPayloadValue({
        language: file.language,
        path: file.path,
        sourceFileId: file.fileId,
      });
      const compilerOptions = compilerOptionsForSource(parsed, file.path);
      const sourceText = decodeUtf8(file.bytes, file.path);
      const impliedNodeFormat = ts.getImpliedNodeFormatForFile(
        toVirtualPath(file.path),
        undefined,
        moduleResolutionHost,
        compilerOptions,
      );
      const syntax = extractCachedModuleSyntaxFacts(
        file,
        sourceText,
        compilerOptions,
        impliedNodeFormat,
        incrementalState.sourceFilesByLogicalPath.get(file.path),
        (fact) => outputBudget.appendFact(fact),
      );
      const relations: ModuleRelationSeedV1[] = [];
      const diagnostics: AnalysisDiagnosticV1[] = [...syntax.diagnostics];
      for (const relation of syntax.relations) {
        const containingFile = toVirtualPath(file.path);
        const resolved = resolveModuleWithCache(
          incrementalState,
          relation.specifier,
          containingFile,
          compilerOptions,
          moduleResolutionHost,
          relation.typescriptResolutionMode,
        ).resolvedModule;
        const resolvedLogicalPath = resolved === undefined
          ? undefined
          : toLogicalPath(files.canonicalPath(resolved.resolvedFileName)) ?? undefined;
        const canonicalContainingPath = toLogicalPath(files.canonicalPath(containingFile)) ?? file.path;
        const metadataBoundaryPath = resolvedLogicalPath ??
          findExternalPackageMetadataBoundary(
            externalFallbackIndex,
            relation.specifier,
            canonicalContainingPath,
          );
        const resolvedPackage = resolvedLogicalPath === undefined
          ? undefined
          : readNearestPackageMetadata(
            files,
            resolvedLogicalPath,
            consultedPaths,
            files.caseSensitiveFileNames,
          );
        const target = resolveModuleTarget({
          /** proof 已收敛对象身份；此处布尔值只保留 ASCII node_modules/manifest 文本语义。 */
          caseSensitiveFileNames: files.caseSensitiveFileNames,
          hostPathIdentityKey,
          indexingManifest,
          normalizedRange: relation.normalizedRange,
          projectContextComplete:
            parsed.sourceProjectByPath.get(file.path)?.configurationComplete ?? false,
          ...(metadataBoundaryPath === undefined
            ? {}
            : { resolvedLogicalPath: metadataBoundaryPath }),
          ...(resolvedPackage === undefined ? {} : { resolvedPackage }),
          resolutionKind: relation.qualifierModel.typeOrValue,
          sourcePath: file.path,
          specifier: relation.specifier,
          workspaceKey: input.workspaceKey,
        });
        if (target.diagnostic !== undefined) {
          outputBudget.appendFact(target.diagnostic);
          diagnostics.push(target.diagnostic);
        }
        if (target.target !== null) {
          outputBudget.appendPayloadValue(target.target);
          relations.push(Object.freeze({
            confidence: target.confidence,
            language: relation.language,
            normalizedRange: relation.normalizedRange,
            provenance: "typescript-compiler-api",
            qualifier: relation.qualifierModel,
            relationType: relation.relationType,
            target: target.target,
          }));
        }
      }
      const result = Object.freeze({
        diagnostics: Object.freeze(diagnostics.sort(compareDiagnostics)),
        language: file.language,
        localExportBindings: syntax.localExportBindings,
        path: file.path,
        relations: Object.freeze(relations),
        sourceFileId: file.fileId,
      });
      return result;
    });
  return Object.freeze({
    consultedLogicalPaths: Object.freeze([...consultedPaths]
      .filter((logicalPath) => !sourcePathSet.has(files.lookupKey(toVirtualPath(logicalPath))))
      .sort(compareText)),
    files: Object.freeze(results),
  });
}

/** 内存配置解析结果。 */
interface ParsedCompilerConfiguration {
  consultedPaths: Set<string>;
  options: ts.CompilerOptions;
  projects: readonly ParsedProjectConfiguration[];
  requiredMissingPaths: BoundedPathCollector;
  resolutionCandidatePaths: BoundedPathCollector;
  sourceProjectByPath: ReadonlyMap<string, ParsedProjectConfiguration>;
}

/** 单个已解析项目保留自己的配置入口、源码集合与 compiler options。 */
interface ParsedProjectConfiguration {
  configPath: string;
  configurationComplete: boolean;
  options: ts.CompilerOptions;
  sourcePaths: readonly string[];
}

/** 使用公开 config parser 解析 tsconfig/jsconfig 与 extends 链。 */
function parseCompilerConfiguration(
  files: VirtualFileMap,
  sourceFiles: readonly AnalyzerSourceFileV1[],
  configurationEntryPaths: readonly string[] | undefined,
  directoryIndex: VirtualDirectoryIndex,
): ParsedCompilerConfiguration {
  const consultedPaths = new Set<string>();
  const resolutionCandidatePaths = new BoundedPathCollector();
  const requiredMissingPaths = new BoundedPathCollector();
  const entryPaths = chooseConfigurationEntryPaths(files, configurationEntryPaths);
  if (entryPaths.length === 0) {
    return {
      consultedPaths,
      options: {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2024,
      },
      projects: [],
      requiredMissingPaths,
      resolutionCandidatePaths,
      sourceProjectByPath: new Map(),
    };
  }
  let activeConfigMissingPaths: BoundedPathCollector | null = null;
  const readFile = (fileName: string): string | undefined => {
    const logicalPath = toLogicalPath(files.canonicalPath(fileName));
    const text = files.get(normalizeVirtualPath(fileName));
    if (logicalPath !== null) {
      if (text === undefined) {
        resolutionCandidatePaths.add(logicalPath);
        activeConfigMissingPaths?.add(logicalPath);
      }
      else {consultedPaths.add(logicalPath);}
    }
    return text;
  };
  const host: ts.ParseConfigHost = {
    directoryExists: (directoryName) => {
      const normalized = normalizeVirtualPath(directoryName);
      return normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`);
    },
    fileExists: (fileName) => {
      const exists = files.has(normalizeVirtualPath(fileName));
      const logicalPath = toLogicalPath(files.canonicalPath(fileName));
      if (!exists && logicalPath !== null) {
        resolutionCandidatePaths.add(logicalPath);
        activeConfigMissingPaths?.add(logicalPath);
      }
      return exists;
    },
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getDirectories: (directoryName) => directoryIndex.getDirectories(directoryName),
    readDirectory: (rootDir, extensions, excludes, includes, depth) => readVirtualDirectory(
      directoryIndex,
      rootDir,
      extensions,
      excludes,
      includes,
      depth,
    ),
    readFile,
    realpath: (fileName) => files.canonicalPath(fileName),
    useCaseSensitiveFileNames: files.caseSensitiveFileNames,
  };
  const sourcePathByKey = new Map(sourceFiles.map((file) =>
    [files.lookupKey(toVirtualPath(file.path)), file.path] as const));
  const queue = [...entryPaths];
  const visited = new Set<string>();
  const projects: ParsedProjectConfiguration[] = [];
  let projectProgramCount = 0;
  while (queue.length > 0) {
    const queuedConfigPath = normalizeRelativeGraphPath(queue.shift()!);
    const canonicalConfigPath = toLogicalPath(files.canonicalPath(toVirtualPath(queuedConfigPath)));
    const configPath = canonicalConfigPath ?? queuedConfigPath;
    const configKey = files.lookupKey(toVirtualPath(configPath));
    if (visited.has(configKey)) {continue;}
    if (projects.length >= WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount + 1) {
      throw new WorkerAnalysisError(
        "ANALYZER_RESOURCE_LIMIT",
        "TypeScript Analyzer Worker project 配置数超过安全预算。",
      );
    }
    visited.add(configKey);
    const virtualConfigPath = toVirtualPath(configPath);
    if (!files.has(virtualConfigPath)) {
      resolutionCandidatePaths.add(configPath);
      requiredMissingPaths.add(configPath);
      continue;
    }
    activeConfigMissingPaths = new BoundedPathCollector();
    const config = ts.readConfigFile(virtualConfigPath, readFile);
    if (config.error !== undefined) {
      throw new TypeError("TypeScript 配置文件无法解析。");
    }
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      host,
      path.posix.dirname(virtualConfigPath),
      undefined,
      virtualConfigPath,
    );
    const fatalErrors = parsed.errors.filter((diagnostic) =>
      diagnostic.code !== 5083 && diagnostic.code !== 6053 &&
      diagnostic.code !== 18002 && diagnostic.code !== 18003);
    if (fatalErrors.length > 0) {
      throw new TypeError(
        `TypeScript 配置文件包含无法恢复的公开解析错误：${fatalErrors
          .map((diagnostic) => diagnostic.code).join(",")}。`,
      );
    }
    assertCompilerOptionContainment(parsed.options);
    const configurationComplete = !parsed.errors.some((diagnostic) =>
      diagnostic.code === 5083 || diagnostic.code === 6053);
    if (!configurationComplete) {
      for (const missingPath of activeConfigMissingPaths.valuesInsertionOrder()) {
        requiredMissingPaths.add(missingPath);
      }
    }
    activeConfigMissingPaths = null;
    delete (parsed.options as { configFilePath?: string }).configFilePath;
    const sourcePaths = parsed.fileNames
      .map((fileName) => toLogicalPath(files.canonicalPath(fileName)))
      .map((logicalPath) => logicalPath === null
        ? null
        : sourcePathByKey.get(files.lookupKey(toVirtualPath(logicalPath))) ?? null)
      .filter((logicalPath): logicalPath is string => logicalPath !== null);
    if (sourcePaths.length > 0) {
      if (projectProgramCount >= WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount) {
        throw new WorkerAnalysisError(
          "ANALYZER_RESOURCE_LIMIT",
          "TypeScript Analyzer Worker project Program 数超过安全预算。",
        );
      }
      projectProgramCount += 1;
    }
    projects.push(Object.freeze({
      configPath,
      configurationComplete,
      options: parsed.options,
      sourcePaths: Object.freeze([...new Set(sourcePaths)].sort(compareText)),
    }));
    for (const reference of parsed.projectReferences ?? []) {
      const referencePath = toLogicalPath(files.canonicalPath(
        ts.resolveProjectReferencePath(reference),
      ));
      if (referencePath === null) {
        throw new TypeError("TypeScript project reference 逃逸虚拟工作区。");
      }
      if (!visited.has(files.lookupKey(toVirtualPath(referencePath)))) {
        queue.push(referencePath);
        if (!files.has(toVirtualPath(referencePath))) {
          resolutionCandidatePaths.add(referencePath);
          requiredMissingPaths.add(referencePath);
        }
      }
    }
  }
  const configuredSourcePaths = new Set(projects.flatMap((project) => project.sourcePaths)
    .map((sourcePath) => files.lookupKey(toVirtualPath(sourcePath))));
  if (projectProgramCount === WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount &&
    sourceFiles.some((file) => !configuredSourcePaths.has(files.lookupKey(toVirtualPath(file.path))))) {
    throw new WorkerAnalysisError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker 未配置 Program 会超过安全预算。",
    );
  }
  const assigned = assignSourcesToProjects(projects, files);
  return {
    consultedPaths,
    options: assigned.projects[0]?.options ?? {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024,
    },
    projects: assigned.projects,
    requiredMissingPaths,
    resolutionCandidatePaths,
    sourceProjectByPath: assigned.sourceProjectByPath,
  };
}

/** 把公开 CompilerOptions 投影为 application 白名单使用的稳定值。 */
function serializeCompilerOptions(
  options: ts.CompilerOptions,
  configPath?: string,
): Readonly<Record<string, unknown>> {
  const observation: Record<string, unknown> = {};
  copyBoolean(options, observation, "allowImportingTsExtensions");
  copyBoolean(options, observation, "allowJs");
  copyBoolean(options, observation, "checkJs");
  copyBoolean(options, observation, "resolveJsonModule");
  copyBoolean(options, observation, "resolvePackageJsonExports");
  copyBoolean(options, observation, "resolvePackageJsonImports");
  copyEnum(options.module, ts.ModuleKind, observation, "module");
  copyEnum(options.moduleResolution, ts.ModuleResolutionKind, observation, "moduleResolution");
  copyEnum(options.target, ts.ScriptTarget, observation, "target");
  copyEnum(options.jsx, ts.JsxEmit, observation, "jsx");
  for (const key of ["baseUrl", "rootDir"] as const) {
    const value = options[key];
    if (value !== undefined) {
      const logicalPath = toLogicalPath(value);
      if (logicalPath === null) {
        throw new TypeError(`TypeScript ${key} 路径逃逸虚拟工作区。`);
      }
      observation[key] = logicalPath;
    }
  }
  for (const key of ["rootDirs", "typeRoots"] as const) {
    const value = options[key];
    if (value !== undefined) {
      observation[key] = value.map((item) => {
        const logicalPath = toLogicalPath(item);
        if (logicalPath === null) {
          throw new TypeError(`TypeScript ${key} 路径逃逸虚拟工作区。`);
        }
        return logicalPath;
      });
    }
  }
  for (const key of ["customConditions", "moduleSuffixes", "types"] as const) {
    const value = options[key];
    if (value !== undefined) {observation[key] = [...value];}
  }
  if (options.paths !== undefined) {
    const configDirectory = configPath === undefined
      ? VIRTUAL_ROOT
      : path.posix.dirname(toVirtualPath(configPath));
    const pathsBase = options.baseUrl ?? configDirectory;
    observation.paths = Object.fromEntries(Object.entries(options.paths)
      .map(([alias, candidates]) => [alias, candidates.map((candidate) => {
        const logicalPath = toLogicalPath(path.posix.resolve(pathsBase, candidate));
        if (logicalPath === null) {
          throw new TypeError("TypeScript paths 候选逃逸虚拟工作区。");
        }
        return logicalPath;
      })]));
  }
  return normalizeEffectiveCompilerOptions(observation);
}

/** 选择显式配置入口；兼容未传入口的旧调用时只接受根 tsconfig/jsconfig。 */
function chooseConfigurationEntryPaths(
  files: VirtualFileMap,
  configured?: readonly string[],
): readonly string[] {
  if (configured !== undefined && configured.length > 0) {
    return Object.freeze([...new Set(configured.map((entry) => {
      const normalized = normalizeRelativeGraphPath(entry);
      return toLogicalPath(files.canonicalPath(toVirtualPath(normalized))) ?? normalized;
    }))]);
  }
  for (const candidate of ["tsconfig.json", "jsconfig.json"]) {
    if (files.has(toVirtualPath(candidate))) {return Object.freeze([candidate]);}
  }
  return Object.freeze([]);
}

/** 同一源码只归属最具体的项目配置；未匹配源码保持不完整上下文。 */
function assignSourcesToProjects(
  projects: readonly ParsedProjectConfiguration[],
  files: VirtualFileMap,
): {
  projects: readonly ParsedProjectConfiguration[];
  sourceProjectByPath: ReadonlyMap<string, ParsedProjectConfiguration>;
} {
  if (projects.length === 0) {
    return { projects: Object.freeze([]), sourceProjectByPath: new Map() };
  }
  const assigned = new Map(projects.map((project) => [project.configPath, [] as string[]]));
  const selectedBySourcePath = new Map<string, {
    project: ParsedProjectConfiguration;
    sourcePath: string;
  }>();
  for (const project of projects) {
    for (const sourcePath of project.sourcePaths) {
      cacheMetrics.sourceProjectMembershipVisits += 1;
      const sourceKey = files.lookupKey(toVirtualPath(sourcePath));
      const current = selectedBySourcePath.get(sourceKey);
      if (current === undefined ||
        configDirectoryDepth(project.configPath) > configDirectoryDepth(current.project.configPath) ||
        (configDirectoryDepth(project.configPath) === configDirectoryDepth(current.project.configPath) &&
          compareText(project.configPath, current.project.configPath) < 0)) {
        selectedBySourcePath.set(sourceKey, { project, sourcePath });
      }
    }
  }
  for (const { project, sourcePath } of selectedBySourcePath.values()) {
    assigned.get(project.configPath)?.push(sourcePath);
  }
  const assignedProjects = projects.map((project) => Object.freeze({
    ...project,
    sourcePaths: Object.freeze([...(assigned.get(project.configPath) ?? [])].sort(compareText)),
  }));
  const assignedByConfigPath = new Map(assignedProjects.map((project) =>
    [project.configPath, project] as const));
  const sourceProjectByPath = new Map<string, ParsedProjectConfiguration>();
  for (const { project, sourcePath } of selectedBySourcePath.values()) {
    const assignedProject = assignedByConfigPath.get(project.configPath);
    if (assignedProject !== undefined) {sourceProjectByPath.set(sourcePath, assignedProject);}
  }
  return {
    projects: Object.freeze(assignedProjects),
    sourceProjectByPath,
  };
}

/** 配置目录深度用于选择最近的 referenced project。 */
function configDirectoryDepth(configPath: string): number {
  const directory = path.posix.dirname(configPath);
  return directory === "." ? 0 : directory.split("/").length;
}

/** 将项目配置映射成可进入 AnalyzerConfigSnapshot 的稳定公开结构。 */
function serializeProjectConfigurations(
  projects: readonly ParsedProjectConfiguration[],
): AnalyzerConfigurationObservationV1["projectConfigurations"] {
  return Object.freeze(projects.map((project) => Object.freeze({
    configPath: project.configPath,
    configurationComplete: project.configurationComplete,
    effectiveCompilerOptions: serializeCompilerOptions(project.options, project.configPath),
    sourcePaths: project.sourcePaths,
  })).sort((left, right) => compareText(left.configPath, right.configPath)));
}

/** 根选项与 source→project 映射共同组成冻结配置语义。 */
function serializeObservedConfiguration(
  parsed: ParsedCompilerConfiguration,
  projects: AnalyzerConfigurationObservationV1["projectConfigurations"],
): Readonly<Record<string, unknown>> {
  return normalizeEffectiveCompilerOptions({
    ...serializeCompilerOptions(parsed.options, parsed.projects[0]?.configPath),
    projectConfigurations: projects,
  });
}

/** 根据冻结的 source→project 映射选择每文件 compiler options。 */
function compilerOptionsForSource(
  parsed: ParsedCompilerConfiguration,
  sourcePath: string,
): ts.CompilerOptions {
  cacheMetrics.sourceProjectLookupCalls += 1;
  return parsed.sourceProjectByPath.get(sourcePath)?.options ?? parsed.options;
}

/** 复制公开布尔选项。 */
function copyBoolean(
  options: ts.CompilerOptions,
  target: Record<string, unknown>,
  key: keyof ts.CompilerOptions,
): void {
  const value = options[key];
  if (typeof value === "boolean") {target[String(key)] = value;}
}

/** 把公开数字枚举转换为稳定名称。 */
function copyEnum(
  value: number | undefined,
  enumObject: Record<string | number, string | number>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (value !== undefined) {
    const name = enumObject[value];
    if (typeof name === "string") {target[key] = name;}
  }
}

type ModuleResolutionResult = ReturnType<typeof ts.resolveModuleName>;

/** 单个持久 Worker 内按项目身份复用 Program、目录索引与模块解析结果。 */
interface IncrementalProjectState {
  baseRetainedBytes: number;
  directoryEntryCount: number;
  directoryIndex: VirtualDirectoryIndex;
  filePathSignature: string;
  key: string;
  metadataSignature: string;
  moduleResolutionBytes: number;
  moduleResolutionResults: Map<string, CachedModuleResolution>;
  programCount: number;
  programs: Map<string, ts.Program>;
  retainedBytes: number;
  sourceFileObjectCount: number;
  sourceFilesByLogicalPath: Map<string, ts.SourceFile>;
}

interface CachedModuleResolution {
  result: ModuleResolutionResult;
  retainedBytes: number;
}

/** 文件路径集合只构建一次目录树；精确查询 O(1)，后代枚举只访问命中子树。 */
class VirtualDirectoryIndex {
  readonly #canonicalDirectoryByFallbackKey = new Map<string, string>();
  readonly #canonicalDirectories = new Map<string, string>();
  readonly #children = new Map<string, Map<string, string>>();
  readonly #filesByDirectory = new Map<string, Map<string, string>>();
  readonly #pathIdentityProjection: StableHostPathProjection | null;
  public readonly caseSensitiveFileNames: boolean;
  public readonly directoryEntryCount: number;
  public readonly retainedBytes: number;

  public constructor(files: VirtualFileMap) {
    this.caseSensitiveFileNames = files.caseSensitiveFileNames;
    this.#pathIdentityProjection = files.pathIdentityProjection;
    const canonicalFiles = [...files.keys()]
      .map((fileName) => normalizeVirtualPath(fileName))
      .sort(compareText);
    if (!this.caseSensitiveFileNames) {
      this.#rememberCanonicalDirectory(VIRTUAL_ROOT);
      for (const canonicalFile of canonicalFiles) {
        const segments = canonicalFile.split("/").filter(Boolean);
        let current = "";
        for (let index = 0; index < segments.length - 1; index += 1) {
          current = `${current}/${segments[index]}`;
          this.#rememberCanonicalDirectory(current);
        }
      }
    }
    this.#canonicalDirectories.set(
      this.#directoryLookupKey(VIRTUAL_ROOT),
      this.#canonicalDirectory(VIRTUAL_ROOT),
    );
    for (const canonicalFile of canonicalFiles) {
      cacheMetrics.directoryIndexBuildFileVisits += 1;
      const segments = canonicalFile.split("/").filter(Boolean);
      let current = "";
      for (let index = 0; index < segments.length - 1; index += 1) {
        const parent = current.length === 0 ? "/" : normalizeVirtualPath(current);
        current = `${current}/${segments[index]}`;
        const normalizedCurrent = normalizeVirtualPath(current);
        const parentKey = this.#directoryLookupKey(parent);
        const currentKey = this.#directoryLookupKey(normalizedCurrent);
        const canonicalDirectory = this.#canonicalDirectory(normalizedCurrent);
        this.#canonicalDirectories.set(currentKey, canonicalDirectory);
        const children = this.#children.get(parentKey) ?? new Map<string, string>();
        children.set(currentKey, canonicalDirectory);
        this.#children.set(parentKey, children);
      }
      const parentDirectory = path.posix.dirname(canonicalFile);
      const parentKey = this.#directoryLookupKey(parentDirectory);
      const directoryFiles = this.#filesByDirectory.get(parentKey) ?? new Map<string, string>();
      directoryFiles.set(this.#lookupKey(canonicalFile), canonicalFile);
      this.#filesByDirectory.set(parentKey, directoryFiles);
    }
    const childLinkCount = [...this.#children.values()]
      .reduce((sum, children) => sum + children.size, 0);
    const fileLinkCount = [...this.#filesByDirectory.values()]
      .reduce((sum, directoryFiles) => sum + directoryFiles.size, 0);
    this.directoryEntryCount = this.#canonicalDirectoryByFallbackKey.size +
      this.#canonicalDirectories.size + childLinkCount + fileLinkCount;
    if (this.directoryEntryCount > WORKER_ANALYSIS_CACHE_LIMITS.maxDirectoryEntryCount) {
      throw new WorkerAnalysisError(
        "ANALYZER_RESOURCE_LIMIT",
        "TypeScript Analyzer Worker 目录索引对象数超过安全预算。",
      );
    }
    this.retainedBytes = [...this.#canonicalDirectories.entries()].reduce((sum, [key, directory]) =>
      sum + new TextEncoder().encode(`${key}\0${directory}`).byteLength + 192, 0) +
      [...this.#canonicalDirectoryByFallbackKey.entries()].reduce((sum, [key, directory]) =>
        sum + new TextEncoder().encode(`${key}\0${directory}`).byteLength + 96, 0) +
      [...this.#filesByDirectory.entries()].reduce((sum, [directoryKey, directoryFiles]) =>
        sum + new TextEncoder().encode(directoryKey).byteLength +
          [...directoryFiles.entries()].reduce((fileSum, [key, fileName]) =>
            fileSum + new TextEncoder().encode(`${key}\0${fileName}`).byteLength + 96, 0), 0) +
      childLinkCount * 96 + (this.#pathIdentityProjection?.retainedBytes ?? 0);
  }

  public directoryExists(directoryName: string): boolean {
    cacheMetrics.directoryExistsCalls += 1;
    return this.#canonicalDirectories.has(this.#directoryLookupKey(
      normalizeVirtualPath(directoryName).replace(/\/$/u, "") || "/",
    ));
  }

  public getDirectories(directoryName: string): string[] {
    cacheMetrics.getDirectoriesCalls += 1;
    const normalized = normalizeVirtualPath(directoryName).replace(/\/$/u, "") || "/";
    return [...(this.#children.get(this.#directoryLookupKey(normalized))?.values() ?? [])]
      .sort(compareText);
  }

  /** 沿目录树只访问目标目录后代，不假设 opaque identity key 仍保留文本路径前缀。 */
  public filesWithin(directoryName: string): readonly string[] {
    const normalized = normalizeVirtualPath(directoryName).replace(/\/$/u, "") || "/";
    const queue = [this.#directoryLookupKey(normalized)];
    const visited = new Set<string>();
    const descendants: string[] = [];
    for (let index = 0; index < queue.length; index += 1) {
      const directoryKey = queue[index]!;
      if (visited.has(directoryKey)) {continue;}
      visited.add(directoryKey);
      descendants.push(...(this.#filesByDirectory.get(directoryKey)?.values() ?? []));
      queue.push(...(this.#children.get(directoryKey)?.keys() ?? []));
    }
    return descendants.sort(compareText);
  }

  /** 暴露 proof-aware 稳定 key，供 readDirectory 去重共享同一对象语义。 */
  public lookupKey(fileName: string): string {return this.#lookupKey(fileName);}

  /** package fallback 等目录边界查询复用同一份已知目录 canonical 表。 */
  public directoryLookupKey(directoryName: string): string {
    return this.#directoryLookupKey(directoryName);
  }

  /** 只对已知存在目录应用文本 canonical fallback，未知文件探测仍保持 proof-aware 精确 key。 */
  #directoryLookupKey(directoryName: string): string {
    const normalized = normalizeVirtualPath(directoryName).replace(/\/$/u, "") || "/";
    if (this.caseSensitiveFileNames) {return normalized;}
    return this.#canonicalDirectoryByFallbackKey.get(
      normalizeHostPathIdentity(normalized, false),
    ) ?? normalized;
  }

  #canonicalDirectory(directoryName: string): string {
    const normalized = normalizeVirtualPath(directoryName).replace(/\/$/u, "") || "/";
    if (this.caseSensitiveFileNames) {return normalized;}
    return this.#canonicalDirectoryByFallbackKey.get(
      normalizeHostPathIdentity(normalized, false),
    ) ?? normalized;
  }

  /** 从 proof-backed 文件父目录派生有界 fallback；稳定选择不依赖请求枚举顺序。 */
  #rememberCanonicalDirectory(directoryName: string): void {
    const normalized = normalizeVirtualPath(directoryName).replace(/\/$/u, "") || "/";
    const fallbackKey = normalizeHostPathIdentity(normalized, false);
    const existing = this.#canonicalDirectoryByFallbackKey.get(fallbackKey);
    if (existing === undefined || compareText(normalized, existing) < 0) {
      this.#canonicalDirectoryByFallbackKey.set(fallbackKey, normalized);
    }
  }

  /** 文件 key 始终保持 proof-aware 精确对象语义，禁止目录 fallback 泄漏到未知文件探测。 */
  #lookupKey(fileName: string): string {
    const normalized = normalizeVirtualPath(fileName);
    return this.caseSensitiveFileNames
      ? normalized
      : this.#pathIdentityProjection?.lookupKey(normalized) ?? normalized;
  }
}

/** 建立或刷新请求级状态，并在路径集合不变时复用目录索引与解析缓存。 */
function prepareIncrementalProjectState(
  allFiles: readonly AnalyzerByteFileV1[],
  files: VirtualFileMap,
  sourceFiles: readonly AnalyzerSourceFileV1[],
  configurationEntryPaths?: readonly string[],
): IncrementalProjectState {
  const sourceIdentities = [...sourceFiles].map((file) => ({
    fileId: file.fileId,
    path: file.path,
  })).sort((left, right) => compareText(left.path, right.path));
  const key = JSON.stringify({
    caseSensitiveFileNames: files.caseSensitiveFileNames,
    configurationEntryPaths: [...(configurationEntryPaths ?? [])].sort(compareText),
    pathIdentitySignature: files.pathIdentitySignature,
    sourceIdentities,
  });
  const allFileVirtualPaths = new Set(allFiles.map((file) => toVirtualPath(file.path)));
  const filePathSignature = JSON.stringify({
    pathIdentitySignature: files.pathIdentitySignature,
    paths: [...files.keys()].sort(compareText),
  });
  const sourcePaths = new Set(sourceFiles.map((file) => file.path));
  const metadataSignature = JSON.stringify(allFiles
    .filter((file) => !sourcePaths.has(file.path))
    .map((file) => `${file.path}\0${file.contentHash}`)
    .sort(compareText).concat(
      [...files.keys()]
        .filter((fileName) => !allFileVirtualPaths.has(fileName))
        .map((fileName) => `${fileName}\0blocked`)
        .sort(compareText),
    ));
  /** cache key 只含稳定 canonical 投影；请求级 snapshot、proof digest 与 opaque token 已丢弃。 */
  const existing = incrementalProjectCache.get(key);
  const directoryIndex = existing?.filePathSignature === filePathSignature
    ? existing.directoryIndex
    : new VirtualDirectoryIndex(files);
  const canReuseResolutionCache = existing?.metadataSignature === metadataSignature;
  const moduleResolutionBytes = canReuseResolutionCache ? existing.moduleResolutionBytes : 0;
  const state: IncrementalProjectState = {
    baseRetainedBytes: directoryIndex.retainedBytes,
    directoryEntryCount: directoryIndex.directoryEntryCount,
    directoryIndex,
    filePathSignature,
    key,
    metadataSignature,
    moduleResolutionBytes,
    moduleResolutionResults: canReuseResolutionCache
      ? existing.moduleResolutionResults
      : new Map<string, CachedModuleResolution>(),
    programCount: 0,
    programs: canReuseResolutionCache
      ? existing.programs
      : new Map<string, ts.Program>(),
    retainedBytes: directoryIndex.retainedBytes + moduleResolutionBytes,
    sourceFileObjectCount: 0,
    sourceFilesByLogicalPath: new Map<string, ts.SourceFile>(),
  };
  return state;
}

/** 使用 oldProgram 和版本化 SourceFile 构建真实增量 Program。 */
function refreshIncrementalPrograms(
  state: IncrementalProjectState,
  files: VirtualFileMap,
  sourceFiles: readonly AnalyzerSourceFileV1[],
  parsed: ParsedCompilerConfiguration,
): void {
  const versions = new Map(sourceFiles.map((file) => [toVirtualPath(file.path), file.contentHash]));
  const oldPrograms = state.programs;
  const nextPrograms = new Map<string, ts.Program>();
  const assigned = new Set(parsed.projects.flatMap((project) => project.sourcePaths)
    .map((sourcePath) => files.lookupKey(toVirtualPath(sourcePath))));
  const groups = [
    ...parsed.projects.map((project) => ({
      key: project.configPath,
      options: project.options,
      sourcePaths: project.sourcePaths,
    })),
    {
      key: "<unconfigured>",
      options: parsed.options,
      sourcePaths: sourceFiles.map((file) => file.path)
        .filter((sourcePath) => !assigned.has(files.lookupKey(toVirtualPath(sourcePath)))),
    },
  ].filter((group) => group.sourcePaths.length > 0);
  if (groups.length > WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount) {
    throw new WorkerAnalysisError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker project group 数超过安全预算。",
    );
  }
  const sourceFileObjects = new Set<ts.SourceFile>();
  for (const group of groups) {
    const oldProgram = oldPrograms.get(group.key);
    const host = createIncrementalCompilerHost(
      files,
      versions,
      state.directoryIndex,
      oldProgram,
      sourceFileObjects,
    );
    const program = ts.createProgram({
      host,
      ...(oldProgram === undefined ? {} : { oldProgram }),
      options: group.options,
      rootNames: group.sourcePaths.map(toVirtualPath),
    });
    if (oldProgram !== undefined) {
      cacheMetrics.programReuses += 1;
      for (const sourcePath of group.sourcePaths) {
        if (oldProgram.getSourceFile(toVirtualPath(sourcePath)) ===
          program.getSourceFile(toVirtualPath(sourcePath))) {
          cacheMetrics.reusedSourceFiles += 1;
        }
      }
    } else {
      cacheMetrics.programBuilds += 1;
    }
    nextPrograms.set(group.key, program);
    for (const sourcePath of group.sourcePaths) {
      const sourceFile = program.getSourceFile(toVirtualPath(sourcePath));
      if (sourceFile !== undefined) {state.sourceFilesByLogicalPath.set(sourcePath, sourceFile);}
    }
  }
  state.programs = nextPrograms;
  const retainedSourceFiles = new Set<ts.SourceFile>();
  for (const program of nextPrograms.values()) {
    for (const sourceFile of program.getSourceFiles()) {retainedSourceFiles.add(sourceFile);}
  }
  state.programCount = nextPrograms.size;
  state.sourceFileObjectCount = retainedSourceFiles.size;
  if (
    state.programCount > WORKER_ANALYSIS_CACHE_LIMITS.maxProgramCount ||
    state.sourceFileObjectCount > WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount
  ) {
    throw new WorkerAnalysisError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker Program 或 SourceFile 对象数超过安全预算。",
    );
  }
  /**
   * 缓存状态不保留请求原始 Uint8Array；Program 只保留 SourceFile 文本与对象图。
   * JS 字符串每 code unit 最多 2 字节，叠加每 SourceFile 2 KiB 与每 Program 64 KiB
   * 的保守对象开销，避免旧计量把原始字节、文本和 Program 重复累计。
   */
  const programRetainedBytes = state.programCount * 64 * 1024 +
    [...retainedSourceFiles].reduce((sum, sourceFile) =>
      sum + sourceFile.text.length * 2 + 2_048, 0);
  state.retainedBytes = state.baseRetainedBytes + state.moduleResolutionBytes +
    programRetainedBytes;
  rememberIncrementalProjectState(state);
}

/** CompilerHost 只读取虚拟文件，并按 contentHash 复用 oldProgram SourceFile。 */
function createIncrementalCompilerHost(
  files: VirtualFileMap,
  versions: ReadonlyMap<string, string>,
  directoryIndex: VirtualDirectoryIndex,
  oldProgram?: ts.Program,
  sourceFileObjects?: Set<ts.SourceFile>,
): ts.CompilerHost {
  return {
    directoryExists: (directoryName) => directoryIndex.directoryExists(directoryName),
    fileExists: (fileName) => files.has(normalizeVirtualPath(fileName)),
    getCanonicalFileName: (fileName) => files.canonicalPath(fileName),
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getDefaultLibFileName: () => `${VIRTUAL_ROOT}/__lib__.d.ts`,
    getDirectories: (directoryName) => directoryIndex.getDirectories(directoryName),
    getNewLine: () => "\n",
    getSourceFile: (fileName, languageVersion) => {
      const normalized = files.canonicalPath(fileName);
      const text = files.get(normalized);
      if (text === undefined) {return undefined;}
      const version = versions.get(normalized) ?? String(text.length);
      const oldSourceFile = oldProgram?.getSourceFile(normalized);
      if (oldSourceFile !== undefined &&
        (oldSourceFile as ts.SourceFile & { version?: string }).version === version) {
        recordSourceFileObject(oldSourceFile, sourceFileObjects);
        return oldSourceFile;
      }
      const sourceFile = ts.createSourceFile(
        normalized,
        text,
        languageVersion,
        true,
        scriptKindFromVirtualFileName(normalized),
      ) as ts.SourceFile & { version?: string };
      sourceFile.version = version;
      recordSourceFileObject(sourceFile, sourceFileObjects);
      return sourceFile;
    },
    readFile: (fileName) => files.get(normalizeVirtualPath(fileName)),
    realpath: (fileName) => files.canonicalPath(fileName),
    useCaseSensitiveFileNames: () => files.caseSensitiveFileNames,
    writeFile: () => undefined,
  };
}

/** 每创建或复用唯一 SourceFile 都立即执行 MAX+1 早停。 */
function recordSourceFileObject(
  sourceFile: ts.SourceFile,
  sourceFileObjects: Set<ts.SourceFile> | undefined,
): void {
  if (sourceFileObjects === undefined) {return;}
  sourceFileObjects.add(sourceFile);
  cacheMetrics.sourceFileObjectCreationPeak = Math.max(
    cacheMetrics.sourceFileObjectCreationPeak,
    sourceFileObjects.size,
  );
  if (sourceFileObjects.size > WORKER_ANALYSIS_CACHE_LIMITS.maxSourceFileObjectCount) {
    throw new WorkerAnalysisError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker SourceFile 对象数超过安全预算。",
    );
  }
}

/** 仅按封闭后缀选择 Program SourceFile 的公开 ScriptKind。 */
function scriptKindFromVirtualFileName(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) {return ts.ScriptKind.TSX;}
  if (lower.endsWith(".jsx")) {return ts.ScriptKind.JSX;}
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  if (lower.endsWith(".json")) {return ts.ScriptKind.JSON;}
  return ts.ScriptKind.TS;
}

/** 手工关系观察与最终分析共享同一有界模块解析缓存。 */
function resolveModuleWithCache(
  state: IncrementalProjectState,
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
  resolutionMode: ts.ResolutionMode,
): ModuleResolutionResult {
  const key = JSON.stringify({
    containingFile,
    options: serializeCompilerOptions(options),
    resolutionMode,
    specifier,
  });
  const cached = state.moduleResolutionResults.get(key);
  if (cached !== undefined) {
    state.moduleResolutionResults.delete(key);
    state.moduleResolutionResults.set(key, cached);
    cacheMetrics.moduleResolutionCacheHits += 1;
    return cached.result;
  }
  cacheMetrics.moduleResolutionExecutions += 1;
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    undefined,
    undefined,
    resolutionMode,
  );
  const retainedBytes = new TextEncoder().encode(key).byteLength + 512;
  state.moduleResolutionResults.set(key, { result: resolved, retainedBytes });
  state.moduleResolutionBytes += retainedBytes;
  state.retainedBytes += retainedBytes;
  if (incrementalProjectCache.get(state.key) === state) {
    retainedProjectBytes += retainedBytes;
  }
  while (
    (state.moduleResolutionResults.size >
      WORKER_ANALYSIS_CACHE_LIMITS.maxResolutionEntriesPerProject ||
      state.moduleResolutionBytes > WORKER_ANALYSIS_CACHE_LIMITS.maxResolutionBytesPerProject) &&
    state.moduleResolutionResults.size > 0
  ) {
    const oldest = state.moduleResolutionResults.entries().next().value as
      [string, CachedModuleResolution] | undefined;
    if (oldest === undefined) {break;}
    state.moduleResolutionResults.delete(oldest[0]);
    state.moduleResolutionBytes -= oldest[1].retainedBytes;
    state.retainedBytes -= oldest[1].retainedBytes;
    if (incrementalProjectCache.get(state.key) === state) {
      retainedProjectBytes -= oldest[1].retainedBytes;
    }
  }
  enforceIncrementalCacheBudgets();
  return resolved;
}

/** 项目状态 LRU 同时受条目数和可计数字节上限约束。 */
function rememberIncrementalProjectState(state: IncrementalProjectState): void {
  const previous = incrementalProjectCache.get(state.key);
  if (previous !== undefined) {
    incrementalProjectCache.delete(state.key);
    retainedProjectBytes -= previous.retainedBytes;
  }
  if (state.retainedBytes > WORKER_ANALYSIS_CACHE_LIMITS.maxProjectRetainedBytes) {return;}
  incrementalProjectCache.set(state.key, state);
  retainedProjectBytes += state.retainedBytes;
  enforceIncrementalCacheBudgets();
}

/** 语法事实与 Program 分区执行 LRU，上界之和仍受统一总字节预算约束。 */
function enforceIncrementalCacheBudgets(): void {
  while (
    (retainedSyntaxFacts > WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedFacts ||
      retainedSyntaxBytes > WORKER_ANALYSIS_CACHE_LIMITS.maxSyntaxRetainedBytes ||
      retainedProjectBytes + retainedSyntaxBytes > WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedBytes) &&
    incrementalSyntaxCache.size > 0
  ) {
    const oldest = incrementalSyntaxCache.entries().next().value as
      [string, CachedSyntaxFacts] | undefined;
    if (oldest === undefined) {break;}
    incrementalSyntaxCache.delete(oldest[0]);
    retainedSyntaxBytes -= oldest[1].retainedBytes;
    retainedSyntaxFacts -= oldest[1].factCount;
  }
  while (
    (incrementalProjectCache.size > WORKER_ANALYSIS_CACHE_LIMITS.maxProjectStates ||
      retainedProjectBytes > WORKER_ANALYSIS_CACHE_LIMITS.maxProjectRetainedBytes ||
      retainedProjectBytes + retainedSyntaxBytes > WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedBytes) &&
    incrementalProjectCache.size > 0
  ) {
    const oldest = incrementalProjectCache.entries().next().value as
      [string, IncrementalProjectState] | undefined;
    if (oldest === undefined) {break;}
    incrementalProjectCache.delete(oldest[0]);
    retainedProjectBytes -= oldest[1].retainedBytes;
  }
}

/**
 * 请求 proof 仅在构造期校验；持久状态只保留可跨 snapshot 比较的 logical→canonical 投影。
 * 未被 proof 覆盖的现存文件、冲突 canonical 映射或 snapshot 元数据缺失都立即失败。
 */
class StableHostPathProjection {
  readonly #canonicalByLogicalPath = new Map<string, string>();
  public readonly retainedBytes: number;
  public readonly signature: string;

  public constructor(
    sidecar: AnalyzerHostPathIdentitySidecarV1,
    requiredLogicalPaths: ReadonlySet<string>,
  ) {
    if (typeof sidecar !== "object" || sidecar === null || sidecar.version !== 1 ||
      typeof sidecar.proofDigest !== "string" || sidecar.proofDigest.length === 0 ||
      typeof sidecar.snapshotIdentity !== "string" || sidecar.snapshotIdentity.length === 0 ||
      !Array.isArray(sidecar.entries)) {
      throw new TypeError("Analyzer host path identity sidecar 元数据不合法。");
    }
    const canonicalByIdentity = new Map<string, string>();
    const identityByLogicalPath = new Map<string, string>();
    for (const entry of sidecar.entries) {
      if (typeof entry !== "object" || entry === null ||
        typeof entry.logicalPath !== "string" ||
        typeof entry.canonicalLogicalPath !== "string") {
        throw new TypeError("Analyzer host path identity sidecar 条目形状不合法。");
      }
      const logicalPath = normalizeRelativeGraphPath(entry.logicalPath);
      const canonicalLogicalPath = normalizeRelativeGraphPath(entry.canonicalLogicalPath);
      if (logicalPath !== entry.logicalPath || canonicalLogicalPath !== entry.canonicalLogicalPath ||
        typeof entry.identity !== "string" || entry.identity.length === 0 ||
        entry.identity.includes("\0") || identityByLogicalPath.has(logicalPath)) {
        throw new TypeError("Analyzer host path identity sidecar 条目不合法或重复。");
      }
      const existingCanonical = canonicalByIdentity.get(entry.identity);
      if (existingCanonical !== undefined && existingCanonical !== canonicalLogicalPath) {
        throw new TypeError("Analyzer host path identity sidecar 对同一对象给出了冲突 canonical path。");
      }
      canonicalByIdentity.set(entry.identity, canonicalLogicalPath);
      identityByLogicalPath.set(logicalPath, entry.identity);
      this.#canonicalByLogicalPath.set(logicalPath, canonicalLogicalPath);
    }
    for (const logicalPath of requiredLogicalPaths) {
      if (!identityByLogicalPath.has(logicalPath)) {
        throw new TypeError("Analyzer 现存路径缺少同批 HostPathIdentityBroker proof。");
      }
    }
    for (const canonicalLogicalPath of this.#canonicalByLogicalPath.values()) {
      if (!requiredLogicalPaths.has(canonicalLogicalPath)) {
        throw new TypeError("Analyzer host proof canonical path 未绑定受控文件或 blocked fence。");
      }
    }
    const stableEntries = [...this.#canonicalByLogicalPath.entries()]
      .sort(([left], [right]) => compareText(left, right));
    this.signature = JSON.stringify(stableEntries);
    this.retainedBytes = stableEntries.reduce((sum, [logicalPath, canonicalLogicalPath]) =>
      sum + new TextEncoder().encode(`${logicalPath}\0${canonicalLogicalPath}`).byteLength + 96, 0);
  }

  public canonicalLogicalPath(logicalPath: string): string | undefined {
    return this.#canonicalByLogicalPath.get(logicalPath);
  }

  /** 已证明路径投影到稳定 canonical key；未知探测路径保持精确文本，禁止启发式折叠。 */
  public lookupKey(fileName: string): string {
    const normalized = normalizeVirtualPath(fileName);
    const logicalPath = toLogicalPath(normalized);
    const canonicalLogicalPath = logicalPath === null
      ? undefined
      : this.#canonicalByLogicalPath.get(logicalPath);
    return canonicalLogicalPath === undefined ? normalized : toVirtualPath(canonicalLogicalPath);
  }
}

/** 虚拟文件表只保留 proof 的稳定 canonical 投影，枚举、realpath 与解析返回 manifest casing。 */
class VirtualFileMap implements ReadonlyMap<string, string> {
  readonly #canonicalByKey = new Map<string, string>();
  readonly #files = new Map<string, string>();
  readonly #pathIdentityProjection: StableHostPathProjection | null;
  public readonly caseSensitiveFileNames: boolean;

  public constructor(
    caseSensitiveFileNames: boolean,
    pathIdentityProjection: StableHostPathProjection | null,
  ) {
    this.caseSensitiveFileNames = caseSensitiveFileNames;
    this.#pathIdentityProjection = pathIdentityProjection;
  }

  public get size(): number {return this.#files.size;}
  public get pathIdentityProjection(): StableHostPathProjection | null {
    return this.#pathIdentityProjection;
  }
  public get pathIdentitySignature(): string {return this.#pathIdentityProjection?.signature ?? "";}

  public add(fileName: string, text: string): void {
    const canonicalPath = this.canonicalPath(fileName);
    const lookupKey = this.#lookupKey(canonicalPath);
    const existingPath = this.#canonicalByKey.get(lookupKey);
    if (existingPath !== undefined && existingPath !== canonicalPath) {
      throw new TypeError("Analyzer 输入在当前文件系统语义下包含大小写冲突路径。");
    }
    const existingText = this.#files.get(canonicalPath);
    if (existingText !== undefined && existingText !== text) {
      throw new TypeError("Analyzer 输入包含同路径冲突字节。");
    }
    this.#canonicalByKey.set(lookupKey, canonicalPath);
    this.#files.set(canonicalPath, text);
  }

  public canonicalPath(fileName: string): string {
    const normalized = normalizeVirtualPath(fileName);
    const logicalPath = toLogicalPath(normalized);
    if (logicalPath !== null) {
      const canonicalLogicalPath = this.#pathIdentityProjection?.canonicalLogicalPath(logicalPath);
      if (canonicalLogicalPath !== undefined) {return toVirtualPath(canonicalLogicalPath);}
    }
    return this.#canonicalByKey.get(this.#lookupKey(normalized)) ?? normalized;
  }

  /** 暴露与 host 一致的稳定 key，供项目归属、目录索引和 read-set 去重共享。 */
  public lookupKey(fileName: string): string {return this.#lookupKey(normalizeVirtualPath(fileName));}

  public entries(): MapIterator<[string, string]> {return this.#files.entries();}
  public get(fileName: string): string | undefined {return this.#files.get(this.canonicalPath(fileName));}
  public has(fileName: string): boolean {return this.#files.has(this.canonicalPath(fileName));}
  public keys(): MapIterator<string> {return this.#files.keys();}
  public values(): MapIterator<string> {return this.#files.values();}
  public [Symbol.iterator](): MapIterator<[string, string]> {return this.#files[Symbol.iterator]();}
  public forEach(
    callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void,
    thisArg?: unknown,
  ): void {
    this.#files.forEach((value, key) => callback.call(thisArg, value, key, this));
  }

  #lookupKey(fileName: string): string {
    const normalized = normalizeVirtualPath(fileName);
    if (this.caseSensitiveFileNames) {return normalized;}
    return this.#pathIdentityProjection?.lookupKey(normalized) ?? normalized;
  }
}

/**
 * 为 Worker 构建逻辑内存文件系统；blocked 路径只放空占位供 TypeScript 权威 resolver 探测，
 * 不携带真实源码正文，也不会成为 Program root、图节点或 Evidence 来源。
 */
function createVirtualFileMap(
  files: readonly AnalyzerByteFileV1[],
  blockedResolutionPaths: ReadonlySet<string> = new Set(),
  caseSensitiveFileNames = true,
  hostPathIdentitySidecar?: AnalyzerHostPathIdentitySidecarV1,
): VirtualFileMap {
  const requiredLogicalPaths = new Set([
    ...files.map((file) => normalizeRelativeGraphPath(file.path)),
    ...[...blockedResolutionPaths].map((entry) => normalizeRelativeGraphPath(entry)),
  ]);
  const pathIdentityProjection = caseSensitiveFileNames
    ? null
    : hostPathIdentitySidecar === undefined
      ? (() => {throw new TypeError("大小写不敏感 Analyzer 请求缺少 host proof sidecar。");})()
      : new StableHostPathProjection(hostPathIdentitySidecar, requiredLogicalPaths);
  const result = new VirtualFileMap(caseSensitiveFileNames, pathIdentityProjection);
  for (const file of files) {
    const virtualPath = toVirtualPath(file.path);
    const text = decodeUtf8(file.bytes, file.path);
    result.add(virtualPath, text);
  }
  for (const logicalPath of blockedResolutionPaths) {
    const virtualPath = toVirtualPath(logicalPath);
    if (!result.has(virtualPath)) {result.add(virtualPath, "");}
  }
  return result;
}

/**
 * 复用同一 Worker 内未变化源码的 AST 语法事实，缓存以内容、配置和文件格式共同定界。
 */
function extractCachedModuleSyntaxFacts(
  file: AnalyzerSourceFileV1,
  sourceText: string,
  compilerOptions: ts.CompilerOptions,
  impliedNodeFormat: ts.ResolutionMode | undefined,
  incrementalSourceFile?: ts.SourceFile,
  onFact?: Parameters<typeof extractModuleSyntaxFacts>[0]["onFact"],
): ReturnType<typeof extractModuleSyntaxFacts> {
  const cacheKey = JSON.stringify({
    compilerOptions: serializeCompilerOptions(compilerOptions),
    contentHash: file.contentHash,
    fileId: file.fileId,
    impliedNodeFormat,
    language: file.language,
    path: file.path,
  });
  const cached = incrementalSyntaxCache.get(cacheKey);
  if (cached !== undefined) {
    incrementalSyntaxCache.delete(cacheKey);
    incrementalSyntaxCache.set(cacheKey, cached);
    if (onFact !== undefined) {
      for (const fact of [
        ...cached.facts.diagnostics,
        ...cached.facts.localExportBindings,
        ...cached.facts.relations,
      ]) {
        onFact(fact);
      }
    }
    return cached.facts;
  }
  const created = extractModuleSyntaxFacts({
    compilerOptions,
    impliedNodeFormat,
    language: file.language,
    ...(onFact === undefined ? {} : { onFact }),
    path: file.path,
    ...(incrementalSourceFile === undefined ? {} : { sourceFile: incrementalSourceFile }),
    sourceFileId: file.fileId,
    sourceText,
  });
  const factCount = created.diagnostics.length + created.localExportBindings.length +
    created.relations.length;
  const retainedBytes = new TextEncoder().encode(sourceText).byteLength +
    new TextEncoder().encode(cacheKey).byteLength + factCount * 256;
  if (retainedBytes <= WORKER_ANALYSIS_CACHE_LIMITS.maxSyntaxRetainedBytes &&
    factCount <= WORKER_ANALYSIS_CACHE_LIMITS.maxRetainedFacts) {
    const entry = { factCount, facts: created, retainedBytes };
    incrementalSyntaxCache.set(cacheKey, entry);
    retainedSyntaxBytes += retainedBytes;
    retainedSyntaxFacts += factCount;
    enforceIncrementalCacheBudgets();
  }
  return created;
}

/** 根外 compiler option 会破坏封闭解析上下文，必须在配置解析阶段立即失败。 */
function assertCompilerOptionContainment(options: ts.CompilerOptions): void {
  for (const key of ["baseUrl", "rootDir"] as const) {
    const value = options[key];
    if (value !== undefined && toLogicalPath(value) === null) {
      throw new TypeError(`TypeScript ${key} 路径逃逸虚拟工作区。`);
    }
  }
  for (const key of ["rootDirs", "typeRoots"] as const) {
    const values = options[key];
    if (values?.some((value) => toLogicalPath(value) === null) === true) {
      throw new TypeError(`TypeScript ${key} 路径逃逸虚拟工作区。`);
    }
  }
}

/** ParseConfigHost.readDirectory 的虚拟实现完整执行扩展名、include/exclude 与 depth。 */
function readVirtualDirectory(
  directoryIndex: VirtualDirectoryIndex,
  rootDir: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  depth: number | undefined,
): string[] {
  const normalizedRoot = normalizeVirtualPath(rootDir).replace(/\/$/u, "");
  const includePatterns = (includes ?? []).map((pattern) =>
    normalizeVirtualPattern(normalizedRoot, pattern));
  const excludePatterns = (excludes ?? []).map((pattern) =>
    normalizeVirtualPattern(normalizedRoot, pattern));
  const traversalRoots = includePatterns.length === 0
    ? [normalizedRoot]
    : includePatterns.map((pattern) => virtualPatternTraversalRoot(directoryIndex, pattern));
  const candidates = new Map<string, string>();
  for (const traversalRoot of new Set(traversalRoots)) {
    for (const fileName of directoryIndex.filesWithin(traversalRoot)) {
      candidates.set(
        directoryIndex.lookupKey(fileName),
        fileName,
      );
    }
  }
  return [...candidates.values()].filter((fileName) => {
    cacheMetrics.configReadDirectoryFileVisits += 1;
    const normalizedFile = normalizeVirtualPath(fileName);
    if (extensions !== undefined && !extensions.some((extension) =>
      caseAwareText(normalizedFile, directoryIndex.caseSensitiveFileNames)
        .endsWith(caseAwareText(extension, directoryIndex.caseSensitiveFileNames)))) {
      return false;
    }
    if (depth !== undefined) {
      const withinDepth = traversalRoots.some((traversalRoot) => {
        if (!isWithinDirectory(
          normalizedFile,
          traversalRoot,
          directoryIndex.caseSensitiveFileNames,
        )) {return false;}
        const rootSegmentCount = traversalRoot.split("/").filter(Boolean).length;
        const fileSegmentCount = normalizedFile.split("/").filter(Boolean).length;
        return Math.max(0, fileSegmentCount - rootSegmentCount - 1) <= depth;
      });
      if (!withinDepth) {return false;}
    }
    if (excludePatterns.some((pattern) => matchesVirtualPattern(
      normalizedFile,
      pattern,
      true,
      directoryIndex.caseSensitiveFileNames,
    ))) {
      return false;
    }
    return includePatterns.length === 0 ||
      includePatterns.some((pattern) => matchesVirtualPattern(
        normalizedFile,
        pattern,
        false,
        directoryIndex.caseSensitiveFileNames,
      ));
  }).sort(compareText);
}

/** 从 include glob 的固定前缀提取最窄安全枚举根，允许父级与兄弟目录。 */
function virtualPatternTraversalRoot(
  directoryIndex: VirtualDirectoryIndex,
  pattern: string,
): string {
  const wildcardIndex = pattern.search(/[?*]/u);
  if (wildcardIndex < 0) {
    return directoryIndex.directoryExists(pattern)
      ? pattern
      : path.posix.dirname(pattern);
  }
  const fixedPrefix = pattern.slice(0, wildcardIndex);
  if (fixedPrefix.endsWith("/")) {
    return fixedPrefix.replace(/\/+$/u, "") || "/";
  }
  return path.posix.dirname(fixedPrefix);
}

/** 相对 glob 以当前配置目录为基准，绝对虚拟 glob 保持原位。 */
function normalizeVirtualPattern(rootDir: string, pattern: string): string {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  return normalizeVirtualPath(normalizedPattern.startsWith("/")
    ? normalizedPattern
    : path.posix.join(rootDir, normalizedPattern));
}

/** 支持 TypeScript 配置常用的 `*`、`?`、`**`，无通配符目录匹配全部后代。 */
function matchesVirtualPattern(
  fileName: string,
  pattern: string,
  matchDirectoryDescendants = false,
  caseSensitiveFileNames = true,
): boolean {
  fileName = caseAwareText(fileName, caseSensitiveFileNames);
  pattern = caseAwareText(pattern, caseSensitiveFileNames);
  if (!/[?*]/u.test(pattern)) {
    return fileName === pattern || fileName.startsWith(`${pattern.replace(/\/$/u, "")}/`);
  }
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  const exact = new RegExp(`${expression}$`, "u");
  if (exact.test(fileName)) {return true;}
  /** exclude 的目录/文件语义不能由点号猜测；祖先目录精确命中时统一排除后代。 */
  return matchDirectoryDescendants && new RegExp(`${expression}/.*$`, "u").test(fileName);
}

/** Worker 在插入时同时执行候选数量与 UTF-8 路径字节预算，禁止先完整物化。 */
class BoundedPathCollector {
  readonly #paths = new Set<string>();
  readonly #ordered: string[] = [];
  #utf8Bytes = 0;

  public add(value: string): void {
    if (this.#paths.has(value)) {return;}
    const nextBytes = this.#utf8Bytes + new TextEncoder().encode(value).byteLength;
    if (this.#paths.size >= MAX_WORKER_RESOLUTION_CANDIDATES ||
      nextBytes > MAX_WORKER_RESOLUTION_CANDIDATE_PATH_BYTES) {
      throw new RangeError("Analyzer 模块解析候选超过 Worker 数量或路径字节预算。");
    }
    this.#paths.add(value);
    this.#ordered.push(value);
    this.#utf8Bytes = nextBytes;
    cacheMetrics.resolutionCandidatePeakCount = Math.max(
      cacheMetrics.resolutionCandidatePeakCount,
      this.#paths.size,
    );
    cacheMetrics.resolutionCandidatePeakBytes = Math.max(
      cacheMetrics.resolutionCandidatePeakBytes,
      this.#utf8Bytes,
    );
  }

  public valuesInsertionOrder(): readonly string[] {
    return this.#ordered;
  }

  public valuesSorted(): readonly string[] {
    return Object.freeze([...this.#ordered].sort(compareText));
  }
}

/**
 * TypeScript 未解析 bare package 时，区分根不存在、manifest 缺失和 manifest 已存在但
 * exports/子路径规则拒绝解析。后两者返回已知外部边界供稳定诊断，只有根不存在才允许
 * 继续生成 medium `@unresolved` 目标。
 */
function findExternalPackageMetadataBoundary(
  index: ExternalPackageFallbackIndex,
  specifier: string,
  containingFile: string,
): string | undefined {
  cacheMetrics.externalPackageFallbackLookups += 1;
  const packageName = packageNameFromNpmSpecifier(specifier);
  if (packageName === null) {return undefined;}
  const packageSegments = packageName.split("/");
  const packageTail = ["node_modules", ...packageSegments].join("/");
  let containingDirectory = path.posix.dirname(normalizeRelativeGraphPath(containingFile));
  while (true) {
    cacheMetrics.externalPackageFallbackAncestorLookups += 1;
    const packageRoot = containingDirectory === "."
      ? packageTail
      : `${containingDirectory}/${packageTail}`;
    const packageRootKey = index.pathIdentityKey(packageRoot);
    const candidate = index.firstCandidateByPackageRoot.get(packageRootKey);
    if (candidate !== undefined) {return candidate;}
    const manifestRoot = index.manifestRootByKey.get(packageRootKey);
    if (manifestRoot !== undefined) {return `${manifestRoot}/package.json`;}
    if (containingDirectory === ".") {return undefined;}
    containingDirectory = path.posix.dirname(containingDirectory);
  }
}

/** 在解码、目录索引与 AST 构建前按数量、原始字节和路径字节拒绝超限请求。 */
function assertWorkerInputAdmission(
  input: Pick<
    AnalyzerConfigurationInputV1,
    | "caseSensitiveFileNames"
    | "configurationFiles"
    | "hostPathIdentitySidecar"
    | "resolutionFiles"
    | "sourceFiles"
  >,
): void {
  const allFiles = [
    ...input.configurationFiles,
    ...(input.resolutionFiles ?? []),
    ...input.sourceFiles,
  ];
  if (input.sourceFiles.length > WORKER_INPUT_LIMITS.maxSourceFilesPerRequest ||
    allFiles.length > WORKER_INPUT_LIMITS.maxTotalFilesPerRequest) {
    throw new WorkerAnalysisError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker 输入文件数超过 admission 预算。",
    );
  }
  let rawBytes = 0;
  let pathBytes = 0;
  for (const file of allFiles) {
    const byteLength = file.bytes?.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new WorkerAnalysisError(
        "ANALYZER_PROTOCOL_INVALID",
        "TypeScript Analyzer Worker 输入字节长度不合法。",
      );
    }
    rawBytes += byteLength;
    pathBytes += utf8BytesBounded(
      file.path,
      Math.max(0, WORKER_INPUT_LIMITS.maxPathBytesPerRequest - pathBytes),
    );
    if (!Number.isSafeInteger(rawBytes) ||
      rawBytes > WORKER_INPUT_LIMITS.maxRawBytesPerRequest ||
      pathBytes > WORKER_INPUT_LIMITS.maxPathBytesPerRequest) {
      throw new WorkerAnalysisError(
        "ANALYZER_RESOURCE_LIMIT",
        "TypeScript Analyzer Worker 原始输入超过 admission 字节预算。",
      );
    }
  }
  const sidecar = input.hostPathIdentitySidecar;
  if (input.caseSensitiveFileNames === false && sidecar === undefined) {
    throw new WorkerAnalysisError(
      "ANALYZER_CONFIG_INVALID",
      "大小写不敏感 Analyzer 请求缺少 host proof sidecar。",
    );
  }
  if (sidecar !== undefined) {
    if (!Array.isArray(sidecar.entries) || sidecar.entries.length > 4_096) {
      throw new WorkerAnalysisError(
        "ANALYZER_RESOURCE_LIMIT",
        "Analyzer host proof sidecar 条目数超过安全预算。",
      );
    }
    for (const entry of sidecar.entries) {
      pathBytes += utf8BytesBounded(
        `${entry.logicalPath}\0${entry.canonicalLogicalPath}\0${entry.identity}`,
        Math.max(0, WORKER_INPUT_LIMITS.maxPathBytesPerRequest - pathBytes),
      );
      if (pathBytes > WORKER_INPUT_LIMITS.maxPathBytesPerRequest) {
        throw new WorkerAnalysisError(
          "ANALYZER_RESOURCE_LIMIT",
          "Analyzer host proof sidecar 路径字节超过安全预算。",
        );
      }
    }
  }
}

interface ExternalPackageFallbackIndex {
  firstCandidateByPackageRoot: ReadonlyMap<string, string>;
  manifestRootByKey: ReadonlyMap<string, string>;
  pathIdentityKey: (logicalPath: string) => string;
}

/** 每请求单遍建立 package root→首候选索引，relation 回退查询保持 O(1)。 */
function buildExternalPackageFallbackIndex(
  files: VirtualFileMap,
  directoryIndex: VirtualDirectoryIndex,
): ExternalPackageFallbackIndex {
  const firstCandidateByPackageRoot = new Map<string, string>();
  const manifestRootByKey = new Map<string, string>();
  /** package root 是目录边界；只允许命中已知目录的 canonical fallback。 */
  const pathIdentityKey = (logicalPath: string) =>
    directoryIndex.directoryLookupKey(toVirtualPath(logicalPath));
  for (const fileName of files.keys()) {
    cacheMetrics.externalPackageFallbackIndexBuildFileVisits += 1;
    const logicalPath = toLogicalPath(fileName);
    if (logicalPath === null) {continue;}
    const packageRoot = externalPackageRoot(logicalPath, files.caseSensitiveFileNames);
    if (packageRoot === null) {continue;}
    const packageRootKey = pathIdentityKey(packageRoot);
    if (files.lookupKey(toVirtualPath(logicalPath)) ===
      files.lookupKey(toVirtualPath(`${packageRoot}/package.json`))) {
      manifestRootByKey.set(packageRootKey, packageRoot);
      continue;
    }
    const current = firstCandidateByPackageRoot.get(packageRootKey);
    if (current === undefined || compareText(logicalPath, current) < 0) {
      firstCandidateByPackageRoot.set(packageRootKey, logicalPath);
    }
  }
  for (const packageRootKey of manifestRootByKey.keys()) {
    firstCandidateByPackageRoot.delete(packageRootKey);
  }
  return Object.freeze({
    firstCandidateByPackageRoot,
    manifestRootByKey,
    pathIdentityKey,
  });
}

/** 从最后一个 node_modules 段提取精确 npm package root。 */
function externalPackageRoot(logicalPath: string, caseSensitiveFileNames: boolean): string | null {
  const segments = logicalPath.split("/");
  const boundaryKey = normalizeHostPathIdentity("node_modules", caseSensitiveFileNames);
  const nodeModulesIndex = segments.findLastIndex((segment) =>
    normalizeHostPathIdentity(segment, caseSensitiveFileNames) === boundaryKey);
  if (nodeModulesIndex < 0) {return null;}
  const first = segments[nodeModulesIndex + 1];
  if (first === undefined || first.length === 0) {return null;}
  const packageSegments = first.startsWith("@")
    ? [first, segments[nodeModulesIndex + 2]]
    : [first];
  if (packageSegments.some((segment) => segment === undefined || segment.length === 0)) {
    return null;
  }
  return [...segments.slice(0, nodeModulesIndex + 1), ...packageSegments].join("/");
}

interface WorkerRequestBudget {
  bytes: number;
  facts: number;
}

/** 输出事实在进入数组前统一执行数量与保守 structured-clone 字节预算。 */
class BoundedWorkerOutputSink {
  #fileFacts = 0;

  public constructor(private readonly request: WorkerRequestBudget) {}

  public appendFact(value: unknown): void {
    const nextFileFacts = this.#fileFacts + 1;
    const nextRequestFacts = this.request.facts + 1;
    cacheMetrics.outputBudgetPeakFacts = Math.max(
      cacheMetrics.outputBudgetPeakFacts,
      Math.min(nextFileFacts, WORKER_OUTPUT_LIMITS.maxFactsPerFile + 1),
    );
    if (nextFileFacts > WORKER_OUTPUT_LIMITS.maxFactsPerFile ||
      nextRequestFacts > WORKER_OUTPUT_LIMITS.maxFactsPerRequest) {
      throw new WorkerAnalysisError(
        "ANALYZER_RESOURCE_LIMIT",
        "TypeScript Analyzer Worker facts 数超过安全预算。",
      );
    }
    this.#fileFacts = nextFileFacts;
    this.request.facts = nextRequestFacts;
    this.appendPayloadValue(value, 64);
  }

  public appendPayloadValue(value: unknown, overhead = 0): void {
    const remaining = WORKER_OUTPUT_LIMITS.maxEstimatedCloneBytesPerRequest -
      this.request.bytes;
    const estimated = estimateCloneBytesBounded(value, Math.max(0, remaining)) + overhead;
    const nextRequestBytes = this.request.bytes + estimated;
    cacheMetrics.outputBudgetPeakBytes = Math.max(
      cacheMetrics.outputBudgetPeakBytes,
      Math.min(nextRequestBytes, WORKER_OUTPUT_LIMITS.maxEstimatedCloneBytesPerRequest + 1),
    );
    if (nextRequestBytes > WORKER_OUTPUT_LIMITS.maxEstimatedCloneBytesPerRequest) {
      throw new WorkerAnalysisError(
        "ANALYZER_RESOURCE_LIMIT",
        "TypeScript Analyzer Worker structured-clone 字节超过安全预算。",
      );
    }
    this.request.bytes = nextRequestBytes;
  }
}

/** 不序列化对象，仅遍历到 budget+1；字符串逐码点计算规范 UTF-8 字节。 */
function estimateCloneBytesBounded(value: unknown, maximumBytes: number): number {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let bytes = 0;
  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes > maximumBytes;
  };
  while (pending.length > 0) {
    cacheMetrics.outputBudgetValueVisits += 1;
    const current = pending.pop();
    if (current === null || current === undefined) {
      if (add(8)) {return maximumBytes + 1;}
    } else if (typeof current === "string") {
      if (add(utf8BytesBounded(current, maximumBytes - bytes) + 16)) {
        return maximumBytes + 1;
      }
    } else if (typeof current === "number" || typeof current === "boolean") {
      if (add(16)) {return maximumBytes + 1;}
    } else if (typeof current === "object") {
      if (seen.has(current)) {continue;}
      seen.add(current);
      if (add(24)) {return maximumBytes + 1;}
      if (Array.isArray(current)) {
        for (const entry of current) {pending.push(entry);}
      } else {
        for (const [key, entry] of Object.entries(current)) {
          if (add(utf8BytesBounded(key, maximumBytes - bytes) + 8)) {
            return maximumBytes + 1;
          }
          pending.push(entry);
        }
      }
    } else if (add(32)) {
      return maximumBytes + 1;
    }
  }
  return bytes;
}

/** 逐 UTF-16 code point 计数并在 maximum+1 早停，不分配编码缓冲区。 */
function utf8BytesBounded(value: string, maximumBytes: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first <= 0x7F) {bytes += 1;}
    else if (first <= 0x7FF) {bytes += 2;}
    else if (first >= 0xD800 && first <= 0xDBFF && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xDC00 && second <= 0xDFFF) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > maximumBytes) {return maximumBytes + 1;}
  }
  return bytes;
}

/** 只读取最后一个 node_modules 包边界的精确 manifest，禁止跨包或向工作区根上溯。 */
function readNearestPackageMetadata(
  files: ReadonlyMap<string, string>,
  resolvedLogicalPath: string,
  consultedPaths: Set<string>,
  caseSensitiveFileNames: boolean,
): { name: string; version: string } | undefined {
  const segments = resolvedLogicalPath.split("/");
  const boundaryKey = normalizeHostPathIdentity("node_modules", caseSensitiveFileNames);
  const nodeModulesIndex = segments.findLastIndex((segment) =>
    normalizeHostPathIdentity(segment, caseSensitiveFileNames) === boundaryKey);
  if (nodeModulesIndex < 0) {return undefined;}
  const packageStart = nodeModulesIndex + 1;
  const firstPackageSegment = segments[packageStart];
  if (firstPackageSegment === undefined) {return undefined;}
  const packageEnd = firstPackageSegment.startsWith("@") ? packageStart + 2 : packageStart + 1;
  if (packageEnd > segments.length || segments[packageEnd - 1] === undefined) {return undefined;}
  const candidate = [...segments.slice(0, packageEnd), "package.json"].join("/");
  const text = files.get(toVirtualPath(candidate));
  if (text === undefined) {return undefined;}
  consultedPaths.add(candidate);
  try {
    const value = JSON.parse(text) as { name?: unknown; version?: unknown };
    if (typeof value.name === "string" && typeof value.version === "string" &&
      value.name.length > 0 && value.version.length > 0) {
      return { name: value.name, version: value.version };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 逻辑路径映射到平台无关虚拟根。 */
function toVirtualPath(logicalPath: string): string {
  return path.posix.join(VIRTUAL_ROOT, normalizeRelativeGraphPath(logicalPath));
}

/** 虚拟路径映射回工作区逻辑路径；根外输入保持私有。 */
function toLogicalPath(fileName: string): string | null {
  const normalized = normalizeVirtualPath(fileName);
  const prefix = `${VIRTUAL_ROOT}/`;
  if (normalized === VIRTUAL_ROOT) {return "";}
  return normalized.startsWith(prefix)
    ? normalizeRelativeGraphPath(normalized.slice(prefix.length))
    : null;
}

/** 所有 Worker 路径使用 POSIX 虚拟语义。 */
function normalizeVirtualPath(fileName: string): string {
  return path.posix.normalize(fileName.replaceAll("\\", "/"));
}

/** readDirectory 使用的目录 containment。 */
function isWithinDirectory(
  fileName: string,
  rootDir: string,
  caseSensitiveFileNames = true,
): boolean {
  const prefix = `${caseAwareText(
    normalizeVirtualPath(rootDir).replace(/\/$/u, ""),
    caseSensitiveFileNames,
  )}/`;
  return caseAwareText(normalizeVirtualPath(fileName), caseSensitiveFileNames).startsWith(prefix);
}

/** 与 VirtualFileMap 一致的 locale-independent host key。 */
function caseAwareText(value: string, caseSensitiveFileNames: boolean): string {
  return normalizeHostPathIdentity(value, caseSensitiveFileNames);
}

/** 支持 TypeScript 公共读取边界的 BOM；任一编码错误仍 fatal，禁止替换字符改变语义。 */
function decodeUtf8(bytes: Uint8Array, logicalPath: string): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`Analyzer 输入 ${logicalPath} 使用了不受支持或损坏的源码编码。`, {
      cause: error,
    });
  }
}

/** 规范字符串排序禁止 localeCompare。 */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 诊断按来源路径、范围和 code 稳定排序。 */
function compareDiagnostics(left: AnalysisDiagnosticV1, right: AnalysisDiagnosticV1): number {
  return compareText(left.path, right.path) ||
    left.normalizedRange.start - right.normalizedRange.start ||
    compareText(left.code, right.code);
}
