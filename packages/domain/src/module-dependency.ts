import type { HierarchyEdge, HierarchyNode } from "./hierarchy.js";

/** 模块事实使用的公共源码范围：0-based UTF-16 code-unit、半开区间。 */
export interface SourceRangeV1 {
  end: number;
  start: number;
}

/** AD-21 固定的 TypeScript/JavaScript 文件语言枚举。 */
export type ModuleLanguageV1 =
  | "javascript"
  | "javascriptreact"
  | "typescript"
  | "typescriptreact";

/** AD-21 固定的模块解析置信度枚举。 */
export type ModuleConfidenceV1 = "high" | "low" | "medium";

/** 模块关系类型不包含 references 或运行时调用。 */
export type ModuleRelationTypeV1 = "exports" | "imports";

/** imports qualifier 只由源码语法确定。 */
export interface ImportsQualifierV1 {
  kind: "imports";
  typeOrValue: "dynamic" | "type" | "value";
  version: 1;
}

/** star re-export qualifier。 */
export interface StarExportQualifierV1 {
  kind: "star";
  typeOrValue: "type" | "value";
  version: 1;
}

/** named re-export qualifier；名称段序列化时必须使用可逆的安全编码。 */
export interface ReexportQualifierV1 {
  exportedName: string;
  importedName: string;
  kind: "reexport";
  typeOrValue: "type" | "value";
  version: 1;
}

/** AD-24 唯一模块 qualifier 结构。 */
export type ModuleQualifierV1 =
  | ImportsQualifierV1
  | ReexportQualifierV1
  | StarExportQualifierV1;

/** 外部 npm 包节点不携带伪造的工作区 relativePath。 */
export interface ExternalPackageNodeV1 {
  id: string;
  kind: "external-package";
  packageName: string;
  packageVersion: string | null;
  versionState: "resolved" | "unresolved";
}

/** Node 内置模块节点使用 node: 规范身份。 */
export interface NodeBuiltinNodeV1 {
  id: string;
  kind: "node-builtin";
  moduleName: string;
}

/** 当前图谱节点联合。 */
export type GraphNodeV1 = ExternalPackageNodeV1 | HierarchyNode | NodeBuiltinNodeV1;

/** imports/exports 关系方向固定为 source file → target module entity。 */
export interface ModuleEdgeV1 {
  fromId: string;
  id: string;
  qualifier: string;
  relationType: ModuleRelationTypeV1;
  toId: string;
}

/** 当前图谱关系联合。 */
export type GraphEdgeV1 = HierarchyEdge | ModuleEdgeV1;

/** 内部模块目标复用既有 file 节点。 */
export interface InternalFileTargetV1 {
  id: string;
  kind: "internal-file";
  /** Worker 协议携带逻辑路径，host 必须据此重新推导 file ID。 */
  resolvedPath: string;
}

/** 外部包目标使用标准 npm purl。 */
export interface ExternalPackageTargetV1 extends ExternalPackageNodeV1 {}

/** Node 内置目标使用 node: 规范身份。 */
export interface NodeBuiltinTargetV1 extends NodeBuiltinNodeV1 {}

/** 固定优先级解析后的封闭模块目标。 */
export type ModuleTargetV1 =
  | ExternalPackageTargetV1
  | InternalFileTargetV1
  | NodeBuiltinTargetV1;

/** Analyzer 只输出稳定、相对路径化且不含源码正文的诊断。 */
export interface AnalysisDiagnosticV1 {
  code:
    | "MODULE_DYNAMIC_SPECIFIER_NOT_LITERAL"
    | "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID"
    | "MODULE_RELATIVE_TARGET_UNRESOLVED"
    | "MODULE_REQUIRE_SPECIFIER_NOT_LITERAL"
    | "MODULE_RESOLUTION_FAILED"
    | "MODULE_SPECIFIER_INVALID";
  normalizedRange: SourceRangeV1;
  path: string;
  severity: "warning";
  suggestedAction: string;
}

/** 本地导出在 Story 1.6 建立 symbol 前只作为内部交接 seed。 */
export interface LocalExportBindingSeedV1 {
  exportedName: string;
  language: ModuleLanguageV1;
  localName: string | "default";
  normalizedRange: SourceRangeV1;
  sourceFileId: string;
  stableSortKey: string;
  typeOrValue: "type" | "value";
}

/** TypeScript 模块关系的版本化 Evidence。 */
export interface ModuleEvidenceV1 {
  analyzerVersion: string;
  confidence: ModuleConfidenceV1;
  detectedAt: string;
  edgeId: string;
  evidenceKind: "module-dependency";
  id: string;
  language: ModuleLanguageV1;
  normalizedRange: SourceRangeV1;
  provenance: "typescript-compiler-api";
  sourceFileId: string;
}

/** 单个源码 ownership slice 的 complete/partial/failed FactBatch。 */
export interface ModuleSourceFactBatchV1 {
  analyzerKind: "typescript";
  analyzerVersion: string;
  configDigest: string;
  coverage: "complete" | "failed" | "partial";
  diagnostics: readonly AnalysisDiagnosticV1[];
  edges: readonly ModuleEdgeV1[];
  evidence: readonly ModuleEvidenceV1[];
  inputDigest: string;
  localExportBindings: readonly LocalExportBindingSeedV1[];
  nodes: readonly (ExternalPackageNodeV1 | NodeBuiltinNodeV1)[];
  ownershipSliceId: string;
  sourceFileId: string;
}

/** 把结构化 qualifier 唯一序列化为持久关系字段。 */
export function serializeModuleQualifier(qualifier: ModuleQualifierV1): string {
  if (qualifier.version !== 1) {
    throw new TypeError("模块 qualifier 版本不受支持。");
  }
  if (qualifier.kind === "imports") {
    return qualifier.typeOrValue;
  }
  if (qualifier.kind === "star") {
    return `star:${qualifier.typeOrValue}`;
  }
  return `reexport:${encodeModuleExportName(qualifier.exportedName)}:${encodeModuleExportName(
    qualifier.importedName,
  )}:${qualifier.typeOrValue}`;
}

/**
 * ModuleExportName 优先沿用标准 percent-encoding；空串或孤立代理项使用 UTF-16 code-unit 编码。
 *
 * `%u` 标记自身会被标准编码为 `%25u`，因此两条编码路径不会碰撞。
 */
export function encodeModuleExportName(value: string): string {
  if (value.length > 0 && !containsLoneSurrogate(value)) {
    return encodeURIComponent(value);
  }
  if (value.length === 0) {return "%u";}
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += `%u${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

/** 解码持久化 ModuleExportName，并拒绝非规范或不可逆表示。 */
export function decodeModuleExportName(encoded: string): string {
  if (encoded === "%u") {return "";}
  if (/^(?:%u[0-9A-F]{4})+$/u.test(encoded)) {
    let decoded = "";
    for (let index = 0; index < encoded.length; index += 6) {
      decoded += String.fromCharCode(Number.parseInt(encoded.slice(index + 2, index + 6), 16));
    }
    if (encodeModuleExportName(decoded) !== encoded) {
      throw new TypeError("ModuleExportName UTF-16 编码不规范。");
    }
    return decoded;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    if (encodeModuleExportName(decoded) !== encoded) {
      throw new TypeError("ModuleExportName percent-encoding 不规范。");
    }
    return decoded;
  } catch (error) {
    throw new TypeError("ModuleExportName 编码无法解码。", { cause: error });
  }
}

/** 规范化 Node 内置模块身份；是否真实属于当前 Node 版本由 adapter 判定。 */
export function normalizeNodeBuiltinId(moduleName: string): string {
  const normalized = moduleName.startsWith("node:") ? moduleName.slice(5) : moduleName;
  if (!/^[A-Za-z0-9_./-]+$/u.test(normalized) || normalized.startsWith("/") ||
    normalized.includes("..")) {
    throw new TypeError("Node 内置模块名称不合法。");
  }
  return `node:${normalized}`;
}

/** 构造符合 purl npm 命名规则的稳定外部包身份。 */
export function buildNpmPackagePurl(packageName: string, version: string): string {
  if (!isCanonicalSemVer(version)) {
    throw new TypeError("npm 包版本不合法。");
  }
  return buildNpmPackagePurlWithEncodedVersion(packageName, version);
}

/** 构造仅用于真实缺失版本状态的 unresolved npm purl。 */
export function buildUnresolvedNpmPackagePurl(packageName: string): string {
  return buildNpmPackagePurlWithEncodedVersion(packageName, "unresolved");
}

/** 包名校验与 purl 编码由 resolved/unresolved 两条显式入口共享。 */
function buildNpmPackagePurlWithEncodedVersion(packageName: string, version: string): string {
  let encodedName: string;
  if (packageName.startsWith("@")) {
    const segments = packageName.split("/");
    const scope = segments[0];
    const name = segments[1];
    if (segments.length !== 2 || scope === undefined || name === undefined ||
      !isCanonicalNpmNameSegment(scope.slice(1)) || !isCanonicalNpmNameSegment(name)) {
      throw new TypeError("scoped npm 包名不合法。");
    }
    encodedName = `${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
  } else {
    if (!isCanonicalNpmNameSegment(packageName)) {
      throw new TypeError("npm 包名不合法。");
    }
    encodedName = encodeURIComponent(packageName);
  }
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

/** npm package name 段采用封闭可移植字符集并拒绝路径语义。 */
function isCanonicalNpmNameSegment(value: string): boolean {
  return /^[a-z0-9][a-z0-9._~-]*$/u.test(value) && value !== "." && value !== "..";
}

/** SemVer 2.0：核心数字和纯数字 prerelease 禁止前导零，标识符不得为空。 */
function isCanonicalSemVer(value: string): boolean {
  const numeric = "(?:0|[1-9]\\d*)";
  const prereleaseIdentifier = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const buildIdentifier = "[0-9A-Za-z-]+";
  return new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}` +
      `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
      `(?:\\+${buildIdentifier}(?:\\.${buildIdentifier})*)?$`,
    "u",
  ).test(value);
}

/** 检测会让 encodeURIComponent 抛 URIError 的孤立 UTF-16 代理项。 */
function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {return true;}
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

/** 从标准 npm purl 构造外部包节点。 */
export function createExternalPackageNode(
  packageName: string,
  packageVersion: string,
): ExternalPackageNodeV1 {
  return Object.freeze({
    id: buildNpmPackagePurl(packageName, packageVersion),
    kind: "external-package",
    packageName,
    packageVersion,
    versionState: "resolved",
  });
}

/** 缺失 manifest version 使用独立状态，禁止借用合法 SemVer 字段。 */
export function createUnresolvedExternalPackageNode(
  packageName: string,
): ExternalPackageNodeV1 {
  return Object.freeze({
    id: buildUnresolvedNpmPackagePurl(packageName),
    kind: "external-package",
    packageName,
    packageVersion: null,
    versionState: "unresolved",
  });
}

/** 只接受唯一规范的 RFC3339 UTC 毫秒表示。 */
export function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** 构造 Node 内置模块节点。 */
export function createNodeBuiltinNode(moduleName: string): NodeBuiltinNodeV1 {
  const id = normalizeNodeBuiltinId(moduleName);
  return Object.freeze({ id, kind: "node-builtin", moduleName: id.slice(5) });
}

/**
 * 使用 AD-21 键构造稳定 Evidence ID。
 *
 * detectedAt、置信度和语言均不进入身份，避免同一观察重放产生重复 Evidence。
 */
export function buildModuleEvidenceId(input: Pick<
  ModuleEvidenceV1,
  "analyzerVersion" | "edgeId" | "evidenceKind" | "normalizedRange" | "provenance" |
  "sourceFileId"
>): string {
  assertSourceRange(input.normalizedRange);
  const identity = [
    input.edgeId,
    input.provenance,
    input.analyzerVersion,
    input.sourceFileId,
    `${input.normalizedRange.start}:${input.normalizedRange.end}`,
    input.evidenceKind,
  ].join("\0").normalize("NFC");
  return `evidence:${encodeURIComponent(identity)}`;
}

/** 公共范围只接受递增的非负安全整数。 */
export function assertSourceRange(range: SourceRangeV1): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start
  ) {
    throw new TypeError("源码范围必须是非空的 0-based UTF-16 半开区间。");
  }
}
