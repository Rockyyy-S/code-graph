import { Worker } from "node:worker_threads";
import { isBuiltin } from "node:module";
import type {
  AnalysisInputV1,
  AnalysisOutputV1,
  AnalyzerByteFileV1,
  AnalyzerCancellationSignal,
  AnalyzerConfigurationInputV1,
  AnalyzerConfigurationObservationV1,
  AnalyzerPort,
} from "@codegraph/application";
import {
  AnalyzerFailureError,
  type AnalyzerFailureCode,
} from "@codegraph/application";
import {
  buildGraphEntityId,
  createExternalPackageNode,
  createNodeBuiltinNode,
  createUnresolvedExternalPackageNode,
  normalizeRelativeGraphPath,
  type ModuleLanguageV1,
} from "@codegraph/domain";

/** 单次 Worker 请求的默认硬超时。 */
export const DEFAULT_ANALYZER_WORKER_TIMEOUT_MS = 30_000;
const MAX_NODE_TIMER_MS = 2_147_483_647;
const MAX_WORKER_BYTE_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_WORKER_BYTE_CACHE_ENTRIES = 65_536;
const MAX_WORKER_INPUT_PATH_BYTES = 1024 * 1024;
const MAX_WORKER_INPUT_RAW_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_INPUT_SOURCE_FILES = 5_000;
const MAX_WORKER_INPUT_TOTAL_FILES = 6_144;

/** TypeScript Analyzer 构造选项。 */
export interface TypeScriptAnalyzerOptions {
  requestTimeoutMs?: number;
  workerUrl?: URL;
}

/** Worker 返回的请求级封闭成功/失败消息。 */
type WorkerResponse =
  | { ok: true; requestId: number; value: unknown }
  | { code: AnalyzerFailureCode; error: string; ok: false; requestId: number };

/** Worker 请求判别值决定成功 payload 的结构校验器。 */
type WorkerRequest =
  | { input: AnalysisInputV1; kind: "analyze" }
  | { input: AnalyzerConfigurationInputV1; kind: "observe" };

interface PendingRequest<T> {
  onAbort: () => void;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
  signal?: AnalyzerCancellationSignal;
  timeout: ReturnType<typeof setTimeout>;
  validatePayload: (value: unknown) => value is T;
}

/**
 * 复用单个持久 Worker，按 requestId 隔离响应，并只传递新增或变化的文件字节。
 *
 * Worker 内部同时维护有界字节与语法事实缓存；超时或取消会终止实例并清空缓存，
 * 下一次请求可建立全新的封闭状态。
 */
export class TypeScriptAnalyzer implements AnalyzerPort {
  readonly #requestTimeoutMs: number;
  readonly #workerUrl: URL;
  readonly #pending = new Map<number, PendingRequest<unknown>>();
  readonly #knownFiles = new Map<string, number>();
  #knownByteCount = 0;
  #nextRequestId = 1;
  #worker: Worker | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  public constructor(options: TypeScriptAnalyzerOptions = {}) {
    const timeout = options.requestTimeoutMs ?? DEFAULT_ANALYZER_WORKER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_NODE_TIMER_MS) {
      throw new RangeError("Analyzer Worker timeout 必须是 Node timer 上限内的正安全整数。");
    }
    this.#requestTimeoutMs = timeout;
    this.#workerUrl = options.workerUrl ?? new URL("./analyzer-worker.js", import.meta.url);
  }

  /** 在 Worker 内使用 TypeScript 公开配置解析 API。 */
  public observeConfiguration(
    input: AnalyzerConfigurationInputV1,
    signal?: AnalyzerCancellationSignal,
  ): Promise<AnalyzerConfigurationObservationV1> {
    return this.#runWorker({ kind: "observe", input }, isConfigurationObservation, signal);
  }

  /** 在 Worker 内执行语法映射与权威模块解析。 */
  public analyze(
    input: AnalysisInputV1,
    signal?: AnalyzerCancellationSignal,
  ): Promise<AnalysisOutputV1> {
    return this.#runWorker(
      { kind: "analyze", input },
      (value): value is AnalysisOutputV1 => isAnalysisOutput(value, input),
      signal,
    );
  }

  /** 终止持久 Worker；重复关闭保持同一 Promise。 */
  public close(): Promise<void> {
    if (this.#closePromise !== null) {return this.#closePromise;}
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = null;
    this.#clearKnownFiles();
    const pendingRequestIds = [...this.#pending.keys()];
    const termination = worker === null
      ? Promise.resolve()
      : worker.terminate().then(() => undefined);
    this.#closePromise = termination.then(() => {
      /** close 先完成，下一事件循环再拒绝 pending，调用方可按既有合同挂接处理器。 */
      setImmediate(() => {
        for (const requestId of pendingRequestIds) {
          this.#settleRequest(requestId, new AnalyzerFailureError(
            "ANALYZER_EXECUTION_FAILED",
            "TypeScript Analyzer Worker 因 Analyzer 关闭而异常退出。",
          ));
        }
      });
    });
    return this.#closePromise;
  }

  /** 发送一次请求；message/error/exit/timeout/abort 都收敛到请求级状态。 */
  #runWorker<T>(
    request: WorkerRequest,
    validatePayload: (value: unknown) => value is T,
    signal?: AnalyzerCancellationSignal,
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new AnalyzerFailureError(
        "ANALYZER_CLOSED",
        "TypeScript Analyzer 已关闭。",
      ));
    }
    if (signal?.aborted === true) {return Promise.reject(createAbortError());}
    try {
      assertAnalyzerRequestAdmission(request.input);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    if (!Number.isSafeInteger(this.#nextRequestId)) {
      return Promise.reject(new AnalyzerFailureError(
        "ANALYZER_EXECUTION_FAILED",
        "TypeScript Analyzer requestId 已达到安全整数上限。",
      ));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => this.#invalidateWorker(createAbortError(), requestId);
      const timeout = setTimeout(() => this.#invalidateWorker(
        new AnalyzerFailureError("ANALYZER_TIMEOUT", "TypeScript Analyzer Worker 超时。"),
        requestId,
      ), this.#requestTimeoutMs);
      this.#pending.set(requestId, {
        onAbort,
        reject,
        resolve,
        signal,
        timeout,
        validatePayload,
      } as PendingRequest<unknown>);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const worker = this.#ensureWorker();
        worker.postMessage({
          request: this.#serializeRequest(request),
          requestId,
        });
      } catch (error) {
        this.#invalidateWorker(new AnalyzerFailureError(
          "ANALYZER_EXECUTION_FAILED",
          "TypeScript Analyzer Worker 请求发送失败。",
          { cause: error },
        ), requestId);
      }
    });
  }

  /** 惰性创建唯一 Worker，并把实例级事件绑定到当前引用。 */
  #ensureWorker(): Worker {
    if (this.#worker !== null) {return this.#worker;}
    const worker = new Worker(this.#workerUrl);
    this.#worker = worker;
    worker.on("message", (message: unknown) => this.#handleMessage(worker, message));
    worker.on("error", (error) => {
      if (this.#worker === worker) {
        this.#invalidateWorker(new AnalyzerFailureError(
          "ANALYZER_EXECUTION_FAILED",
          "TypeScript Analyzer Worker 执行失败。",
          { cause: error },
        ));
      }
    });
    worker.on("exit", (code) => {
      if (this.#worker === worker) {
        this.#invalidateWorker(new AnalyzerFailureError(
          "ANALYZER_EXECUTION_FAILED",
          `TypeScript Analyzer Worker 异常退出：${code}`,
        ));
      }
    });
    return worker;
  }

  /** 校验 requestId、响应判别值与请求类型对应的完整嵌套 payload。 */
  #handleMessage(worker: Worker, message: unknown): void {
    if (this.#worker !== worker) {return;}
    if (!isWorkerResponse(message)) {
      this.#invalidateWorker(new AnalyzerFailureError(
        "ANALYZER_PROTOCOL_INVALID",
        "TypeScript Analyzer Worker 响应不合法。",
      ));
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) {
      this.#invalidateWorker(new AnalyzerFailureError(
        "ANALYZER_PROTOCOL_INVALID",
        "TypeScript Analyzer Worker 返回未知 requestId。",
      ));
      return;
    }
    if (!message.ok) {
      this.#settleRequest(message.requestId, new AnalyzerFailureError(message.code, message.error));
      return;
    }
    if (!pending.validatePayload(message.value)) {
      this.#invalidateWorker(new AnalyzerFailureError(
        "ANALYZER_PROTOCOL_INVALID",
        "TypeScript Analyzer Worker 成功 payload 不合法。",
      ), message.requestId);
      return;
    }
    this.#settleRequest(message.requestId, undefined, message.value);
  }

  /** 省略 Worker 已缓存的相同 path/contentHash 字节，同时保持其余元数据完整。 */
  #serializeRequest(request: WorkerRequest): unknown {
    const serializeFiles = (files: readonly AnalyzerByteFileV1[] | undefined): unknown[] =>
      (files ?? []).map((file) => {
        const key = `${file.path}\0${file.contentHash}`;
        const knownSize = this.#knownFiles.get(key);
        if (knownSize !== undefined) {
          this.#knownFiles.delete(key);
          this.#knownFiles.set(key, knownSize);
          const { bytes: _bytes, ...metadata } = file;
          void _bytes;
          return metadata;
        }
        this.#rememberFile(key, file.bytes.byteLength);
        return file;
      });
    const input = request.input;
    return {
      input: {
        ...input,
        configurationFiles: serializeFiles(input.configurationFiles),
        ...(input.resolutionFiles === undefined
          ? {}
          : { resolutionFiles: serializeFiles(input.resolutionFiles) }),
        sourceFiles: serializeFiles(input.sourceFiles),
      },
      kind: request.kind,
    };
  }

  /** 主线程与 Worker 使用相同 LRU 规则，保证省略字节时缓存认知一致。 */
  #rememberFile(key: string, byteLength: number): void {
    this.#knownFiles.set(key, byteLength);
    this.#knownByteCount += byteLength;
    while ((this.#knownByteCount > MAX_WORKER_BYTE_CACHE_BYTES ||
      this.#knownFiles.size > MAX_WORKER_BYTE_CACHE_ENTRIES) && this.#knownFiles.size > 0) {
      const oldest = this.#knownFiles.entries().next().value as [string, number] | undefined;
      if (oldest === undefined) {break;}
      this.#knownFiles.delete(oldest[0]);
      this.#knownByteCount -= oldest[1];
    }
  }

  /** Worker 状态失效时终止实例，并拒绝全部并发请求。 */
  #invalidateWorker(primaryError: unknown, primaryRequestId?: number): void {
    const worker = this.#worker;
    this.#worker = null;
    this.#clearKnownFiles();
    for (const requestId of [...this.#pending.keys()]) {
      const error = requestId === primaryRequestId
        ? primaryError
        : primaryRequestId === undefined
          ? primaryError
          : new AnalyzerFailureError(
              "ANALYZER_EXECUTION_FAILED",
              "TypeScript Analyzer Worker 因同实例请求失败而异常退出。",
              { cause: primaryError },
            );
      this.#settleRequest(requestId, error);
    }
    if (worker !== null) {void worker.terminate();}
  }

  /** 请求只结算一次，并同步移除 timeout/abort 监听。 */
  #settleRequest(requestId: number, error?: unknown, value?: unknown): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {return;}
    this.#pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (error !== undefined) {pending.reject(error);}
    else {pending.resolve(value);}
  }

  /** 清空与 Worker 实例绑定的 LRU 字节缓存。 */
  #clearKnownFiles(): void {
    this.#knownFiles.clear();
    this.#knownByteCount = 0;
  }
}

/** 主线程在 Worker 创建、structured clone 与字节缓存更新前执行同一 admission。 */
function assertAnalyzerRequestAdmission(
  input: Pick<
    AnalyzerConfigurationInputV1,
    "configurationFiles" | "resolutionFiles" | "sourceFiles"
  >,
): void {
  const allFiles = [
    ...input.configurationFiles,
    ...(input.resolutionFiles ?? []),
    ...input.sourceFiles,
  ];
  if (input.sourceFiles.length > MAX_WORKER_INPUT_SOURCE_FILES ||
    allFiles.length > MAX_WORKER_INPUT_TOTAL_FILES) {
    throw new AnalyzerFailureError(
      "ANALYZER_RESOURCE_LIMIT",
      "TypeScript Analyzer Worker 输入文件数超过 admission 预算。",
    );
  }
  let rawBytes = 0;
  let pathBytes = 0;
  for (const file of allFiles) {
    rawBytes += file.bytes.byteLength;
    pathBytes += Buffer.byteLength(file.path, "utf8");
    if (!Number.isSafeInteger(rawBytes) ||
      rawBytes > MAX_WORKER_INPUT_RAW_BYTES ||
      pathBytes > MAX_WORKER_INPUT_PATH_BYTES) {
      throw new AnalyzerFailureError(
        "ANALYZER_RESOURCE_LIMIT",
        "TypeScript Analyzer Worker 原始输入超过 admission 字节预算。",
      );
    }
  }
  const sidecar = (input as AnalyzerConfigurationInputV1).hostPathIdentitySidecar;
  if ((input as AnalyzerConfigurationInputV1).caseSensitiveFileNames === false &&
    sidecar === undefined) {
    throw new AnalyzerFailureError(
      "ANALYZER_CONFIG_INVALID",
      "大小写不敏感 Analyzer 请求缺少 HostPathIdentityBroker proof sidecar。",
    );
  }
  if (sidecar !== undefined) {
    if (sidecar.version !== 1 || !Array.isArray(sidecar.entries) ||
      sidecar.entries.length > 4_096 || typeof sidecar.proofDigest !== "string" ||
      typeof sidecar.snapshotIdentity !== "string") {
      throw new AnalyzerFailureError(
        "ANALYZER_PROTOCOL_INVALID",
        "Analyzer host path identity sidecar 超限或形状不合法。",
      );
    }
    for (const entry of sidecar.entries) {
      pathBytes += Buffer.byteLength(entry.logicalPath, "utf8") +
        Buffer.byteLength(entry.canonicalLogicalPath, "utf8") +
        Buffer.byteLength(entry.identity, "utf8");
      if (pathBytes > MAX_WORKER_INPUT_PATH_BYTES) {
        throw new AnalyzerFailureError(
          "ANALYZER_RESOURCE_LIMIT",
          "Analyzer host path identity sidecar 路径字节超过 admission 预算。",
        );
      }
    }
  }
}

/** 创建默认 TypeScript AnalyzerPort。 */
export function createTypeScriptAnalyzer(options?: TypeScriptAnalyzerOptions): TypeScriptAnalyzer {
  return new TypeScriptAnalyzer(options);
}

/** Worker response 必须携带正安全 requestId 与明确布尔判别联合。 */
function isWorkerResponse(value: unknown): value is WorkerResponse {
  return isRecord(value) && Number.isSafeInteger(value.requestId) &&
    (value.requestId as number) > 0 &&
    (value.ok === true || (value.ok === false && typeof value.error === "string" &&
      isAnalyzerFailureCode(value.code)));
}

/** 关闭 Worker 错误码集合，禁止任意字符串穿透 runtime。 */
function isAnalyzerFailureCode(value: unknown): value is AnalyzerFailureCode {
  return value === "ANALYZER_CLOSED" || value === "ANALYZER_CONFIG_INVALID" ||
    value === "ANALYZER_EXECUTION_FAILED" || value === "ANALYZER_METADATA_UNSTABLE" ||
    value === "ANALYZER_PROTOCOL_INVALID" || value === "ANALYZER_RESOURCE_LIMIT" ||
    value === "ANALYZER_TIMEOUT";
}

/** observe 成功 payload 必须包含完整配置观察数组与普通 options 对象。 */
function isConfigurationObservation(value: unknown): value is AnalyzerConfigurationObservationV1 {
  return isRecord(value) && isStringArray(value.consultedLogicalPaths) &&
    isRecord(value.effectiveCompilerOptions) && Array.isArray(value.projectConfigurations) &&
    value.projectConfigurations.every((project) =>
      isRecord(project) && typeof project.configPath === "string" &&
      typeof project.configurationComplete === "boolean" &&
      isRecord(project.effectiveCompilerOptions) && isStringArray(project.sourcePaths)) &&
    (value.requiredMissingLogicalPaths === undefined ||
      isStringArray(value.requiredMissingLogicalPaths)) &&
    isStringArray(value.resolutionCandidateLogicalPaths);
}

/** analyze 成功 payload 深度校验诊断、binding、关系、qualifier、target 与公共枚举。 */
function isAnalysisOutput(value: unknown, input: AnalysisInputV1): value is AnalysisOutputV1 {
  const manifestById = new Map(input.sourceFiles.map((file) => [file.fileId, file]));
  const manifestByPath = new Map(input.sourceFiles.map((file) => [file.path, file]));
  const sourceLengthById = new Map<string, number>();
  for (const source of input.sourceFiles) {
    const sourceLength = decodeAnalyzerSourceLength(source.bytes);
    if (sourceLength === null) {return false;}
    sourceLengthById.set(source.fileId, sourceLength);
  }
  if (!isRecord(value) || !isStringArray(value.consultedLogicalPaths) ||
    !Array.isArray(value.files) || value.files.length !== input.sourceFiles.length) {
    return false;
  }
  const seenSourceIds = new Set<string>();
  return value.files.every((file) => {
    if (!isRecord(file) || typeof file.sourceFileId !== "string" ||
      seenSourceIds.has(file.sourceFileId)) {
      return false;
    }
    const source = manifestById.get(file.sourceFileId);
    if (source === undefined || file.path !== source.path || file.language !== source.language) {
      return false;
    }
    const sourceLength = sourceLengthById.get(source.fileId);
    if (sourceLength === undefined) {return false;}
    seenSourceIds.add(file.sourceFileId);
    return Array.isArray(file.diagnostics) && file.diagnostics.every((diagnostic) =>
      isAnalysisDiagnostic(diagnostic, source.path, sourceLength)) &&
      Array.isArray(file.localExportBindings) && file.localExportBindings.every((binding) =>
        isLocalExportBinding(binding, source.fileId, source.language, sourceLength)) &&
      Array.isArray(file.relations) && file.relations.every((relation) =>
        isModuleRelation(
          relation,
          input.workspaceKey,
          manifestByPath,
          source.language,
          sourceLength,
          isProjectContextComplete(input.configSnapshot.effectiveCompilerOptions, source.path),
        ));
  });
}

/** Analyzer 诊断必须使用封闭 code/severity、规范范围和相对路径字符串。 */
function isAnalysisDiagnostic(value: unknown, sourcePath: string, sourceLength: number): boolean {
  return isRecord(value) && isDiagnosticCode(value.code) &&
    isSourceRange(value.normalizedRange, sourceLength) &&
    value.path === sourcePath && value.severity === "warning" &&
    typeof value.suggestedAction === "string" && value.suggestedAction.length > 0;
}

/** Story 1.5 本地导出 seed 允许合法空字符串 ModuleExportName。 */
function isLocalExportBinding(
  value: unknown,
  sourceFileId: string,
  language: ModuleLanguageV1,
  sourceLength: number,
): boolean {
  return isRecord(value) && typeof value.exportedName === "string" && value.language === language &&
    typeof value.localName === "string" && isSourceRange(value.normalizedRange, sourceLength) &&
    value.sourceFileId === sourceFileId &&
    typeof value.stableSortKey === "string" &&
    (value.typeOrValue === "type" || value.typeOrValue === "value");
}

/** 模块关系必须完整满足 application seed 合同，不能让 null/空对象穿透。 */
function isModuleRelation(
  value: unknown,
  workspaceKey: string,
  manifestByPath: ReadonlyMap<string, AnalysisInputV1["sourceFiles"][number]>,
  sourceLanguage: ModuleLanguageV1,
  sourceLength: number,
  projectContextComplete: boolean,
): boolean {
  if (!isRecord(value) || !isConfidence(value.confidence) || value.language !== sourceLanguage ||
    !isSourceRange(value.normalizedRange, sourceLength) ||
    value.provenance !== "typescript-compiler-api" ||
    !isQualifier(value.qualifier) || !isModuleTarget(value.target, workspaceKey, manifestByPath)) {
    return false;
  }
  const typeOrValue = (value.qualifier as { typeOrValue?: unknown }).typeOrValue;
  const expectedConfidence = typeOrValue === "dynamic"
    ? "low"
    : isRecord(value.target) && value.target.kind === "external-package" &&
        value.target.versionState === "unresolved"
      ? "medium"
      : !projectContextComplete ? "medium" : "high";
  if (value.confidence !== expectedConfidence) {return false;}
  if (value.relationType === "imports") {
    return (value.qualifier as { kind: string }).kind === "imports";
  }
  return value.relationType === "exports" &&
    ((value.qualifier as { kind: string }).kind === "star" ||
      (value.qualifier as { kind: string }).kind === "reexport");
}

/** qualifier 判别联合逐字段封闭。 */
function isQualifier(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1) {return false;}
  if (value.kind === "imports") {
    return value.typeOrValue === "dynamic" || value.typeOrValue === "type" ||
      value.typeOrValue === "value";
  }
  if (value.kind === "star") {
    return value.typeOrValue === "type" || value.typeOrValue === "value";
  }
  return value.kind === "reexport" && typeof value.exportedName === "string" &&
    typeof value.importedName === "string" &&
    (value.typeOrValue === "type" || value.typeOrValue === "value");
}

/** 目标联合不接受缺字段或未知 kind。 */
function isModuleTarget(
  value: unknown,
  workspaceKey: string,
  manifestByPath: ReadonlyMap<string, AnalysisInputV1["sourceFiles"][number]>,
): boolean {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {return false;}
  if (value.kind === "internal-file") {
    if (typeof value.resolvedPath !== "string") {return false;}
    try {
      const resolvedPath = normalizeRelativeGraphPath(value.resolvedPath);
      const manifestFile = manifestByPath.get(resolvedPath);
      return manifestFile !== undefined &&
        value.id === buildGraphEntityId(workspaceKey, "file", resolvedPath) &&
        manifestFile.fileId === value.id;
    } catch {
      return false;
    }
  }
  if (value.kind === "external-package") {
    if (typeof value.packageName !== "string" || value.packageName.length === 0) {return false;}
    try {
      const canonical = value.versionState === "resolved" &&
        typeof value.packageVersion === "string"
        ? createExternalPackageNode(value.packageName, value.packageVersion)
        : value.versionState === "unresolved" && value.packageVersion === null
          ? createUnresolvedExternalPackageNode(value.packageName)
          : null;
      return canonical !== null && sameCanonicalTarget(value, canonical);
    } catch {
      return false;
    }
  }
  if (value.kind !== "node-builtin" || typeof value.moduleName !== "string" ||
    !isBuiltin(value.id)) {
    return false;
  }
  try {
    return sameCanonicalTarget(value, createNodeBuiltinNode(value.moduleName));
  } catch {
    return false;
  }
}

/** Worker 目标必须与领域构造器产生的唯一规范字段逐项一致。 */
function sameCanonicalTarget(
  value: object,
  canonical: object,
): boolean {
  const valueRecord = value as Readonly<Record<string, unknown>>;
  const canonicalRecord = canonical as Readonly<Record<string, unknown>>;
  const keys = Object.keys(canonical).sort();
  return Object.keys(value).sort().join("\0") === keys.join("\0") &&
    keys.every((key) => valueRecord[key] === canonicalRecord[key]);
}

/** 公共源码范围固定为源码 UTF-16 长度内的非空安全整数半开区间。 */
function isSourceRange(value: unknown, sourceLength: number): boolean {
  return isRecord(value) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    (value.start as number) >= 0 && (value.end as number) > (value.start as number) &&
    (value.end as number) <= sourceLength;
}

/** 从冻结配置中只读恢复 source→project 完整性，缺失或形状异常一律按不完整处理。 */
function isProjectContextComplete(
  effectiveCompilerOptions: Readonly<Record<string, unknown>>,
  sourcePath: string,
): boolean {
  const projects = effectiveCompilerOptions.projectConfigurations;
  if (!Array.isArray(projects)) {return false;}
  return projects.some((project) => isRecord(project) && project.configurationComplete === true &&
    Array.isArray(project.sourcePaths) && project.sourcePaths.includes(sourcePath));
}

/** 主线程按 Worker 相同的 fatal BOM 合同计算 UTF-16 长度，不保留或输出源码正文。 */
function decodeAnalyzerSourceLength(bytes: Uint8Array): number | null {
  try {
    const decoder = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder("utf-16le", { fatal: true })
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? new TextDecoder("utf-16be", { fatal: true })
        : new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(bytes).length;
  } catch {
    return null;
  }
}

function isDiagnosticCode(value: unknown): boolean {
  return value === "MODULE_DYNAMIC_SPECIFIER_NOT_LITERAL" ||
    value === "MODULE_EXTERNAL_PACKAGE_METADATA_INVALID" ||
    value === "MODULE_RELATIVE_TARGET_UNRESOLVED" ||
    value === "MODULE_REQUIRE_SPECIFIER_NOT_LITERAL" || value === "MODULE_RESOLUTION_FAILED" ||
    value === "MODULE_SPECIFIER_INVALID";
}

function isConfidence(value: unknown): boolean {
  return value === "high" || value === "medium" || value === "low";
}

/** Worker payload 只接受普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Worker payload 中的路径数组必须是纯字符串数组。 */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** 取消使用稳定 AbortError 名称，runtime 可与扫描取消统一收敛。 */
function createAbortError(): Error {
  const error = new Error("TypeScript Analyzer Worker 已取消。");
  error.name = "AbortError";
  return error;
}
