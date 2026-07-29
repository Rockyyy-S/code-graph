import { normalizeRelativeGraphPath } from "@codegraph/domain";
import type { CanonicalDigestPort } from "../ports/canonical-digest-port.js";
import { compareCanonicalGraphText } from "./hierarchy-builder.js";

/** 配置快照中允许进入 digest 的规范文件描述。 */
export interface AnalyzerConsultedFileV1 {
  contentHash: string;
  path: string;
}

/** Story 1.9 前字段固定为空，但合同现在即封闭。 */
export interface AnalyzerWorkspacePackageV1 {
  name: string;
  root: string;
}

/** graph-service 冻结并生产 digest 的 Analyzer 配置快照。 */
export interface AnalyzerConfigSnapshotV1 {
  /** 捕获时不存在、但其创建/rename 会改变 Analyzer 语义的路径。 */
  absentFiles?: readonly string[];
  /** 普通模块解析探测中不存在的候选，与必需配置缺失事实分离。 */
  absentResolutionFiles?: readonly string[];
  analyzerKind: "typescript";
  analyzerVersion: string;
  consultedFiles: readonly AnalyzerConsultedFileV1[];
  /** root 内真实存在但不属于本轮 manifest 的源码候选，只封口身份与 hash。 */
  blockedResolutionFiles?: readonly AnalyzerConsultedFileV1[];
  effectiveCompilerOptions: Readonly<Record<string, unknown>>;
  effectiveIgnore: {
    effectiveDigest: string;
    version: 1;
  };
  version: 1;
  workspacePackages: readonly AnalyzerWorkspacePackageV1[];
}

/** 配置快照及其 RFC 8785 JCS → UTF-8 → SHA-256 结果。 */
export interface CreatedAnalyzerConfigSnapshotV1 {
  configDigest: string;
  snapshot: AnalyzerConfigSnapshotV1;
}

const COMPILER_OPTION_WHITELIST = new Set([
  "allowImportingTsExtensions",
  "allowJs",
  "baseUrl",
  "checkJs",
  "customConditions",
  "jsx",
  "module",
  "moduleResolution",
  "moduleSuffixes",
  "paths",
  "projectConfigurations",
  "resolveJsonModule",
  "resolvePackageJsonExports",
  "resolvePackageJsonImports",
  "rootDir",
  "rootDirs",
  "target",
  "typeRoots",
  "types",
]) as ReadonlySet<string>;

const PATH_OPTIONS = new Set(["baseUrl", "rootDir"]);
const PATH_ARRAY_OPTIONS = new Set(["rootDirs", "typeRoots"]);

/**
 * 把公开 compiler options observation 收敛到封闭白名单。
 *
 * 函数、缓存对象、configFilePath、plugins 与宿主绝对路径都不会进入规范快照。
 */
export function normalizeEffectiveCompilerOptions(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {};
  for (const key of [...Object.keys(input)].sort(compareCanonicalGraphText)) {
    if (!COMPILER_OPTION_WHITELIST.has(key)) {
      continue;
    }
    const value = input[key];
    if (value === undefined || typeof value === "function") {
      continue;
    }
    if (PATH_OPTIONS.has(key)) {
      if (typeof value === "string") {
        normalized[key] = normalizeRelativeGraphPath(value);
      }
      continue;
    }
    if (PATH_ARRAY_OPTIONS.has(key)) {
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        const paths = value.map((entry) => normalizeRelativeGraphPath(entry));
        normalized[key] = key === "rootDirs" ? [...new Set(paths)] : paths;
      }
      continue;
    }
    if (key === "paths") {
      if (isRecord(value)) {
        const mappings: Record<string, readonly string[]> = {};
        for (const alias of Object.keys(value).sort(compareCanonicalGraphText)) {
          const candidates = value[alias];
          if (Array.isArray(candidates) && candidates.every((entry) => typeof entry === "string")) {
            mappings[alias] = Object.freeze(candidates.map((entry) => normalizeRelativeGraphPath(entry)));
          }
        }
        normalized[key] = Object.freeze(mappings);
      }
      continue;
    }
    if (key === "projectConfigurations") {
      if (Array.isArray(value)) {
        normalized[key] = normalizeProjectConfigurations(value);
      }
      continue;
    }
    const canonical = cloneJsonScalarOrArray(value);
    if (canonical !== undefined) {
      normalized[key] = canonical;
    }
  }
  return Object.freeze(normalized);
}

/** 项目配置按 configPath 排序，sourcePaths 唯一排序，并递归规范公开选项。 */
function normalizeProjectConfigurations(value: readonly unknown[]): readonly unknown[] {
  const projects = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.configPath !== "string" ||
      !Array.isArray(entry.sourcePaths) ||
      !entry.sourcePaths.every((sourcePath) => typeof sourcePath === "string") ||
      typeof entry.configurationComplete !== "boolean" ||
      !isRecord(entry.effectiveCompilerOptions)) {
      throw new TypeError("projectConfigurations 形状不合法。");
    }
    const configPath = normalizeRelativeGraphPath(entry.configPath);
    const sourcePaths = [...new Set(entry.sourcePaths.map((sourcePath) =>
      normalizeRelativeGraphPath(sourcePath)))].sort(compareCanonicalGraphText);
    return Object.freeze({
      configPath,
      configurationComplete: entry.configurationComplete,
      effectiveCompilerOptions: normalizeEffectiveCompilerOptions(entry.effectiveCompilerOptions),
      sourcePaths: Object.freeze(sourcePaths),
    });
  }).sort((left, right) => compareCanonicalGraphText(left.configPath, right.configPath));
  return Object.freeze(projects);
}

/** 创建排序、唯一且不包含 rules.yaml 的 AnalyzerConfigSnapshotV1。 */
export function createAnalyzerConfigSnapshot(
  input: Omit<
    AnalyzerConfigSnapshotV1,
    "absentFiles" | "absentResolutionFiles" | "blockedResolutionFiles" | "version"
  > & {
    absentFiles?: readonly string[];
    absentResolutionFiles?: readonly string[];
    blockedResolutionFiles?: readonly AnalyzerConsultedFileV1[];
  },
  digestPort: CanonicalDigestPort,
): CreatedAnalyzerConfigSnapshotV1 {
  assertDigest(input.effectiveIgnore.effectiveDigest, "effectiveIgnore.effectiveDigest");
  if (input.analyzerVersion.length === 0) {
    throw new TypeError("analyzerVersion 不能为空。");
  }
  const consultedFiles = sortUniquePathEntries(input.consultedFiles, "consultedFiles");
  const absentFiles = sortUniquePaths(input.absentFiles ?? [], "absentFiles");
  const absentResolutionFiles = sortUniquePaths(
    input.absentResolutionFiles ?? [],
    "absentResolutionFiles",
  );
  const blockedResolutionFiles = sortUniquePathEntries(
    input.blockedResolutionFiles ?? [],
    "blockedResolutionFiles",
  );
  const existingPaths = new Set([
    ...consultedFiles.map((file) => file.path),
    ...blockedResolutionFiles.map((file) => file.path),
  ]);
  if (
    blockedResolutionFiles.some((file) => consultedFiles.some((entry) => entry.path === file.path)) ||
    absentFiles.some((path) => existingPaths.has(path)) ||
    absentResolutionFiles.some((path) => existingPaths.has(path) || absentFiles.includes(path))
  ) {
    throw new TypeError("Analyzer 配置快照的存在、blocked 与缺失路径集合必须互斥。");
  }
  const snapshotPaths = [
    ...consultedFiles.map((entry) => entry.path),
    ...blockedResolutionFiles.map((entry) => entry.path),
    ...absentFiles,
    ...absentResolutionFiles,
  ];
  if (snapshotPaths.some(isReservedAnalyzerRulesPath)) {
    throw new TypeError("rules.yaml 不得进入 Analyzer 配置快照。");
  }
  const workspacePackages = [...input.workspacePackages]
    .map((entry) => {
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        throw new TypeError("workspace package name 不能为空。");
      }
      return Object.freeze({
        name: entry.name,
        root: normalizeRelativeGraphPath(entry.root),
      });
    })
    .sort((left, right) => compareCanonicalGraphText(left.root, right.root) ||
      compareCanonicalGraphText(left.name, right.name));
  const snapshot: AnalyzerConfigSnapshotV1 = Object.freeze({
    absentFiles,
    absentResolutionFiles,
    analyzerKind: input.analyzerKind,
    analyzerVersion: input.analyzerVersion,
    blockedResolutionFiles,
    consultedFiles,
    effectiveCompilerOptions: normalizeEffectiveCompilerOptions(input.effectiveCompilerOptions),
    effectiveIgnore: Object.freeze({ ...input.effectiveIgnore }),
    version: 1,
    workspacePackages: Object.freeze(workspacePackages),
  });
  return Object.freeze({ configDigest: digestPort.digest(snapshot), snapshot });
}

/** rules.yaml 由规则 Story 独占，任何 Analyzer 观察集合都不得将其封口。 */
function isReservedAnalyzerRulesPath(logicalPath: string): boolean {
  return logicalPath.split("/").at(-1)?.toLowerCase() === "rules.yaml";
}

/** 缺失路径按规范相对路径唯一排序。 */
function sortUniquePaths(paths: readonly string[], label: string): readonly string[] {
  const sorted = paths.map((entry) => normalizeRelativeGraphPath(entry))
    .sort(compareCanonicalGraphText);
  const unique = [...new Set(sorted)];
  if (unique.some((entry) => entry.length === 0)) {
    throw new TypeError(`${label} 不能包含工作区根。`);
  }
  return Object.freeze(unique);
}

/** 按架构固定语义形状计算 Analyzer inputDigest。 */
export function createAnalyzerInputDigest(
  input: {
    analyzerKind: "typescript";
    configDigest: string;
    inputs: readonly AnalyzerConsultedFileV1[];
  },
  digestPort: CanonicalDigestPort,
): string {
  assertDigest(input.configDigest, "configDigest");
  return digestPort.digest({
    analyzerKind: input.analyzerKind,
    configDigest: input.configDigest,
    inputs: sortUniquePathEntries(input.inputs, "inputs"),
    version: 1,
  });
}

/** 路径集合使用 UTF-16 码元序并拒绝同路径冲突 hash。 */
function sortUniquePathEntries(
  entries: readonly AnalyzerConsultedFileV1[],
  label: string,
): readonly AnalyzerConsultedFileV1[] {
  const sorted = entries.map((entry) => {
    assertDigest(entry.contentHash, `${label}.contentHash`);
    return Object.freeze({
      contentHash: entry.contentHash,
      path: normalizeRelativeGraphPath(entry.path),
    });
  }).sort((left, right) => compareCanonicalGraphText(left.path, right.path));
  const unique: AnalyzerConsultedFileV1[] = [];
  for (const entry of sorted) {
    const previous = unique.at(-1);
    if (previous?.path === entry.path) {
      if (previous.contentHash !== entry.contentHash) {
        throw new TypeError(`${label} 包含同路径冲突 hash。`);
      }
      continue;
    }
    unique.push(entry);
  }
  return Object.freeze(unique);
}

/** 只复制 JSON 标量与有序标量数组，拒绝宿主对象。 */
function cloneJsonScalarOrArray(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const cloned = value.map(cloneJsonScalarOrArray);
    return cloned.some((entry) => entry === undefined) ? undefined : Object.freeze(cloned);
  }
  return undefined;
}

/** 配置对象只接受普通非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 所有语义 digest 使用 SHA-256 小写十六进制。 */
function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} 必须是 SHA-256 小写十六进制。`);
  }
}
