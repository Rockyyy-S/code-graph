import type {
  AnalysisDiagnosticV1,
  LocalExportBindingSeedV1,
  ModuleLanguageV1,
} from "@codegraph/domain";
import type { AnalyzerConfigSnapshotV1 } from "../indexing/analyzer-config-snapshot.js";
import type { ModuleRelationSeedV1 } from "../indexing/module-fact-batch.js";

/**
 * 仅用于扩展名、保留目录名等 ASCII 协议文本比较。
 *
 * 现存宿主路径是否指向同一对象必须消费 `AnalyzerHostPathIdentitySidecarV1`，不得把本函数
 * 的字符串结果当作 file identity。该文本启发式显式保留 İ、ı、ß、ẞ 等已知 NTFS 共存样本，
 * 其余大小写折叠只服务 watcher、扩展名和保留目录名等保守分类。
 */
export function normalizeHostPathIdentity(
  value: string,
  caseSensitiveFileNames: boolean,
): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (caseSensitiveFileNames) {return normalized;}
  return normalized.replace(
    /[^\u0130\u0131\u00DF\u1E9Ea-z0-9\\/:\-_. ]+/gu,
    (segment) => segment.toLowerCase(),
  );
}

/** 同一请求内由宿主句柄快照证明的逻辑路径映射；不得进入领域 ID 或持久化摘要。 */
export interface AnalyzerHostPathIdentityEntryV1 {
  /** Worker 对该对象返回的 manifest/config canonical logical path。 */
  canonicalLogicalPath: string;
  /** 只在本 sidecar 的 snapshotIdentity 内可比较的 opaque 对象身份。 */
  identity: string;
  /** broker 本批证明覆盖的精确 logical path，包括已证明的 ASCII alias。 */
  logicalPath: string;
}

/**
 * 请求级 HostPathIdentityBroker proof 投影。
 *
 * `proofDigest` 与 `snapshotIdentity` 只证明当前 Worker 请求使用同一批映射；调用方不得把它们
 * 写入 file ID、configDigest、inputDigest、GraphPatch 或任何持久化事实。
 */
export interface AnalyzerHostPathIdentitySidecarV1 {
  entries: readonly AnalyzerHostPathIdentityEntryV1[];
  proofDigest: string;
  snapshotIdentity: string;
  version: 1;
}

/** graph-service 通过受控读取边界交付的不可变字节快照。 */
export interface AnalyzerByteFileV1 {
  bytes: Uint8Array;
  contentHash: string;
  path: string;
}

/** manifest 内受支持源码携带既有 file ID 与封闭语言。 */
export interface AnalyzerSourceFileV1 extends AnalyzerByteFileV1 {
  fileId: string;
  language: ModuleLanguageV1;
}

/** 配置观察阶段只消费受控配置/解析元数据，不访问 GraphStore。 */
export interface AnalyzerConfigurationInputV1 {
  /** 已由 host 安全封口、但不得作为 Analyzer 源码输入的 root 内候选。 */
  blockedResolutionLogicalPaths?: readonly string[];
  /** indexing root 所在真实文件系统的大小写语义，由 graph-service 只读探测。 */
  caseSensitiveFileNames?: boolean;
  /** graph-service 选择的权威根配置入口；Worker 不再自行排序猜测。 */
  configurationEntryPaths?: readonly string[];
  configurationFiles: readonly AnalyzerByteFileV1[];
  /** 大小写不敏感宿主上的现存路径必须由同一批 opaque proof 映射。 */
  hostPathIdentitySidecar?: AnalyzerHostPathIdentitySidecarV1;
  /** graph-service broker 已安全读取的模块解析元数据。 */
  resolutionFiles?: readonly AnalyzerByteFileV1[];
  sourceFiles: readonly AnalyzerSourceFileV1[];
}

/** 单个 TypeScript 项目对其源码生效的公开配置观察。 */
export interface AnalyzerProjectConfigurationV1 {
  configPath: string;
  /** extends/reference 闭包完整时才允许声明完整项目级解析上下文。 */
  configurationComplete: boolean;
  effectiveCompilerOptions: Readonly<Record<string, unknown>>;
  sourcePaths: readonly string[];
}

/** Worker 返回公开 compiler options observation 与实际 consulted logical paths。 */
export interface AnalyzerConfigurationObservationV1 {
  consultedLogicalPaths: readonly string[];
  effectiveCompilerOptions: Readonly<Record<string, unknown>>;
  projectConfigurations: readonly AnalyzerProjectConfigurationV1[];
  /** 配置解析实际需要但当前不存在的路径，必须进入缺失事实封口。 */
  requiredMissingLogicalPaths?: readonly string[];
  /** Worker 仅返回逻辑候选路径，由 graph-service 决定是否安全读取。 */
  resolutionCandidateLogicalPaths: readonly string[];
}

/** Analyzer 适配器允许跨基础设施边界传播的封闭失败码。 */
export type AnalyzerFailureCode =
  | "ANALYZER_CLOSED"
  | "ANALYZER_CONFIG_INVALID"
  | "ANALYZER_EXECUTION_FAILED"
  | "ANALYZER_METADATA_UNSTABLE"
  | "ANALYZER_PROTOCOL_INVALID"
  | "ANALYZER_RESOURCE_LIMIT"
  | "ANALYZER_TIMEOUT";

/** Analyzer 失败保留稳定分类，runtime 可映射为扫描错误而非写入错误。 */
export class AnalyzerFailureError extends Error {
  public readonly analyzerCode: AnalyzerFailureCode;

  public constructor(analyzerCode: AnalyzerFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnalyzerFailureError";
    this.analyzerCode = analyzerCode;
  }
}

/** 冻结配置后执行模块分析的输入。 */
export interface AnalysisInputV1 extends AnalyzerConfigurationInputV1 {
  configDigest: string;
  configSnapshot: AnalyzerConfigSnapshotV1;
  detectedAt: string;
  inputDigest: string;
  resolutionFiles: readonly AnalyzerByteFileV1[];
  workspaceKey: string;
}

/** 单文件 Analyzer 结果仍由 application 规范化为 source FactBatch。 */
export interface AnalyzedModuleFileV1 {
  diagnostics: readonly AnalysisDiagnosticV1[];
  language: ModuleLanguageV1;
  localExportBindings: readonly LocalExportBindingSeedV1[];
  path: string;
  relations: readonly ModuleRelationSeedV1[];
  sourceFileId: string;
}

/** 单轮 Worker 分析输出。 */
export interface AnalysisOutputV1 {
  consultedLogicalPaths: readonly string[];
  files: readonly AnalyzedModuleFileV1[];
}

/** application-owned 最小取消信号，不暴露 Worker 或 Node 类型。 */
export interface AnalyzerCancellationSignal {
  readonly aborted: boolean;
  addEventListener: (
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  removeEventListener: (type: "abort", listener: () => void) => void;
}

/** application 拥有、基础设施实现的 Analyzer 端口。 */
export interface AnalyzerPort {
  analyze: (
    input: AnalysisInputV1,
    signal?: AnalyzerCancellationSignal,
  ) => Promise<AnalysisOutputV1>;
  close: () => Promise<void> | void;
  observeConfiguration: (
    input: AnalyzerConfigurationInputV1,
    signal?: AnalyzerCancellationSignal,
  ) => Promise<AnalyzerConfigurationObservationV1>;
}
