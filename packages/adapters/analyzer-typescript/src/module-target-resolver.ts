import { isBuiltin } from "node:module";
import { normalizeHostPathIdentity } from "@codegraph/application";
import {
  createExternalPackageNode,
  createUnresolvedExternalPackageNode,
  createNodeBuiltinNode,
  normalizeRelativeGraphPath,
  type AnalysisDiagnosticV1,
  type ModuleConfidenceV1,
  type ModuleTargetV1,
  type SourceRangeV1,
} from "@codegraph/domain";

/** 目标解析只消费逻辑路径、manifest 与受控 package metadata。 */
export interface ResolveModuleTargetOptions {
  /** 路径比较必须与 TypeScript host 的真实大小写语义一致。 */
  caseSensitiveFileNames?: boolean;
  /** 请求级稳定 canonical key；调用方必须在进入此层前丢弃 raw proof/token。 */
  hostPathIdentityKey?: (logicalPath: string) => string;
  indexingManifest: readonly { fileId: string; path: string }[];
  normalizedRange?: SourceRangeV1;
  /** 仅当源码明确归属已封口项目配置时，静态内部解析才可声明 high。 */
  projectContextComplete?: boolean;
  resolvedLogicalPath?: string;
  resolvedPackage?: { name: string; version: string };
  resolutionKind?: "dynamic" | "type" | "value";
  sourcePath: string;
  specifier: string;
  workspaceKey: string;
}

interface ManifestIndexCacheEntry {
  byCaseSensitivity: Map<boolean, ReadonlyMap<string, { fileId: string; path: string }>>;
  byHostPathIdentityKey: WeakMap<
    (logicalPath: string) => string,
    ReadonlyMap<string, { fileId: string; path: string }>
  >;
}

const manifestIndexCache = new WeakMap<
  readonly { fileId: string; path: string }[],
  ManifestIndexCacheEntry
>();

/** 固定优先级解析结果。 */
export interface ResolvedModuleTargetV1 {
  confidence: ModuleConfidenceV1;
  diagnostic?: AnalysisDiagnosticV1;
  target: ModuleTargetV1 | null;
}

/**
 * 固定执行 Node built-in → manifest internal file → npm purl → unresolved bare → diagnostic。
 */
export function resolveModuleTarget(options: ResolveModuleTargetOptions): ResolvedModuleTargetV1 {
  const resolvedConfidence: ModuleConfidenceV1 = options.resolutionKind === "dynamic"
    ? "low"
    : options.projectContextComplete === false ? "medium" : "high";
  if (isBuiltin(options.specifier)) {
    return Object.freeze({
      confidence: resolvedConfidence,
      target: createNodeBuiltinNode(options.specifier),
    });
  }
  const resolvedLogicalPath = options.resolvedLogicalPath === undefined
    ? undefined
    : normalizeRelativeGraphPath(options.resolvedLogicalPath);
  const caseSensitiveFileNames = options.caseSensitiveFileNames ?? true;
  if (resolvedLogicalPath !== undefined &&
    !hasNodeModulesSegment(resolvedLogicalPath, caseSensitiveFileNames)) {
    const internalFile = manifestIndex(
      options.indexingManifest,
      caseSensitiveFileNames,
      options.hostPathIdentityKey,
    ).get(pathIdentityKey(
      resolvedLogicalPath,
      caseSensitiveFileNames,
      options.hostPathIdentityKey,
    ));
    if (internalFile !== undefined) {
      return Object.freeze({
        confidence: options.resolutionKind === "dynamic"
          ? "low"
          : options.projectContextComplete === false ? "medium" : "high",
        target: Object.freeze({
          id: internalFile.fileId,
          kind: "internal-file",
          resolvedPath: internalFile.path,
        }),
      });
    }
    return Object.freeze({
      confidence: options.resolutionKind === "dynamic" ? "low" : "medium",
      diagnostic: createResolutionDiagnostic(
        isRelativeSpecifier(options.specifier)
          ? "MODULE_RELATIVE_TARGET_UNRESOLVED"
          : "MODULE_RESOLUTION_FAILED",
        options,
        isRelativeSpecifier(options.specifier)
          ? "将相对目标纳入本次 manifest，或修正扩展名与包含规则。"
          : "将 paths alias 指向本次 manifest 内的受支持源码，或改用明确的 package 目标。",
      ),
      target: null,
    });
  }
  if (options.resolvedPackage !== undefined) {
    try {
      const node = createExternalPackageNode(
        options.resolvedPackage.name,
        options.resolvedPackage.version,
      );
      return Object.freeze({ confidence: resolvedConfidence, target: node });
    } catch {
      return Object.freeze({
        confidence: "medium",
        diagnostic: createResolutionDiagnostic(
          "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID",
          options,
          "修复最近 package.json 的 npm name/version 后重新索引。",
        ),
        target: null,
      });
    }
  }
  if (resolvedLogicalPath !== undefined &&
    hasNodeModulesSegment(resolvedLogicalPath, caseSensitiveFileNames)) {
    return Object.freeze({
      confidence: options.resolutionKind === "dynamic" ? "low" : "medium",
      diagnostic: createResolutionDiagnostic(
        "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID",
        options,
        "修复已解析外部文件最近 package.json 的 npm name/version 后重新索引。",
      ),
      target: null,
    });
  }
  const packageName = packageNameFromNpmSpecifier(options.specifier);
  if (packageName !== null) {
    return Object.freeze({
      confidence: options.resolutionKind === "dynamic" ? "low" : "medium",
      target: createUnresolvedExternalPackageNode(packageName),
    });
  }
  if (!isRelativeSpecifier(options.specifier)) {
    return Object.freeze({
      confidence: options.resolutionKind === "dynamic" ? "low" : "medium",
      diagnostic: createResolutionDiagnostic(
        "MODULE_SPECIFIER_INVALID",
        options,
        "使用合法的相对路径、Node 内置模块或 npm package specifier。",
      ),
      target: null,
    });
  }
  return Object.freeze({
    confidence: options.resolutionKind === "dynamic" ? "low" : "medium",
    diagnostic: createResolutionDiagnostic(
      "MODULE_RELATIVE_TARGET_UNRESOLVED",
      options,
      "检查相对路径、扩展名和 tsconfig 模块解析配置。",
    ),
    target: null,
  });
}

/** manifest 是请求级不可变值；按数组身份只规范化一次并复用 O(1) 查询。 */
function manifestIndex(
  manifest: readonly { fileId: string; path: string }[],
  caseSensitiveFileNames: boolean,
  hostPathIdentityKey?: (logicalPath: string) => string,
): ReadonlyMap<string, { fileId: string; path: string }> {
  const cachedEntry = manifestIndexCache.get(manifest);
  const cached = hostPathIdentityKey === undefined
    ? cachedEntry?.byCaseSensitivity.get(caseSensitiveFileNames)
    : cachedEntry?.byHostPathIdentityKey.get(hostPathIdentityKey);
  if (cached !== undefined) {return cached;}
  const index = new Map<string, { fileId: string; path: string }>();
  for (const entry of manifest) {
    const normalizedPath = normalizeRelativeGraphPath(entry.path);
    const key = pathIdentityKey(normalizedPath, caseSensitiveFileNames, hostPathIdentityKey);
    if (!index.has(key)) {index.set(key, { fileId: entry.fileId, path: normalizedPath });}
  }
  const nextEntry = cachedEntry ?? {
    byCaseSensitivity: new Map(),
    byHostPathIdentityKey: new WeakMap(),
  };
  if (hostPathIdentityKey === undefined) {
    nextEntry.byCaseSensitivity.set(caseSensitiveFileNames, index);
  } else {
    /** resolver 是弱键，proof-aware 派生索引只能活在其请求作用域内。 */
    nextEntry.byHostPathIdentityKey.set(hostPathIdentityKey, index);
  }
  manifestIndexCache.set(manifest, nextEntry);
  return index;
}

/** 已规范 logical path 统一进入显式 canonical resolver，缺省时保持旧 host 文本语义。 */
function pathIdentityKey(
  normalizedLogicalPath: string,
  caseSensitiveFileNames: boolean,
  hostPathIdentityKey?: (logicalPath: string) => string,
): string {
  return hostPathIdentityKey?.(normalizedLogicalPath) ??
    normalizeHostPathIdentity(normalizedLogicalPath, caseSensitiveFileNames);
}

/** node_modules 即使位于 indexing root 物理前缀下也不是内部源码。 */
function hasNodeModulesSegment(relativePath: string, caseSensitiveFileNames: boolean): boolean {
  const boundaryKey = normalizeHostPathIdentity("node_modules", caseSensitiveFileNames);
  return relativePath.split("/").some((segment) =>
    normalizeHostPathIdentity(segment, caseSensitiveFileNames) === boundaryKey);
}

/** 相对模块请求只接受显式 ./ 与 ../ 前缀。 */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** 封闭校验 npm package/subpath，并只返回 package name 作为 purl 身份。 */
export function packageNameFromNpmSpecifier(specifier: string): string | null {
  if (
    specifier.length === 0 || specifier.startsWith("#") || specifier.startsWith("node:") ||
    specifier.includes("\\") || specifier.includes("?") || specifier.includes("#") ||
    specifier.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(specifier) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)
  ) {
    return null;
  }
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    const scope = segments[0]?.slice(1);
    const name = segments[1];
    if (scope === undefined || name === undefined ||
      !isSafeNpmNameSegment(scope) || !isSafeNpmNameSegment(name) ||
      !segments.slice(2).every(isSafeNpmSubpathSegment)) {
      return null;
    }
    return `${segments[0]}/${segments[1]}`;
  }
  const name = segments[0];
  return name !== undefined && isSafeNpmNameSegment(name) &&
    segments.slice(1).every(isSafeNpmSubpathSegment)
    ? name
    : null;
}

/** npm name 段拒绝路径控制字符、空段和父级语义。 */
function isSafeNpmNameSegment(segment: string): boolean {
  return /^[a-z0-9][a-z0-9._~-]*$/u.test(segment) && segment !== "." && segment !== "..";
}

/** package subpath 不做窄字符白名单，只拒绝 Node/URL 会解释为逃逸的路径语义。 */
function isSafeNpmSubpathSegment(segment: string): boolean {
  if (segment.length === 0 || segment === "." || segment === ".." ||
    /[\u0000-\u001F\u007F]/u.test(segment)) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return decoded !== "." && decoded !== ".." && !decoded.includes("/") &&
      !decoded.includes("\\") && !/[\u0000-\u001F\u007F]/u.test(decoded);
  } catch {
    return false;
  }
}

/** 目标诊断只保留相对来源路径、稳定范围和建议动作。 */
function createResolutionDiagnostic(
  code:
    | "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID"
    | "MODULE_RELATIVE_TARGET_UNRESOLVED"
    | "MODULE_RESOLUTION_FAILED"
    | "MODULE_SPECIFIER_INVALID",
  options: ResolveModuleTargetOptions,
  suggestedAction: string,
): AnalysisDiagnosticV1 {
  return Object.freeze({
    code,
    normalizedRange: options.normalizedRange ?? Object.freeze({ end: 1, start: 0 }),
    path: normalizeRelativeGraphPath(options.sourcePath),
    severity: "warning",
    suggestedAction,
  });
}
