import { parentPort } from "node:worker_threads";
import type {
  AnalysisInputV1,
  AnalyzerByteFileV1,
  AnalyzerConfigurationInputV1,
} from "@codegraph/application";
import {
  analyzeTypeScriptModules,
  classifyWorkerAnalysisError,
  observeTypeScriptConfiguration,
  WorkerAnalysisError,
} from "./worker-analysis.js";

const MAX_WORKER_BYTE_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_WORKER_BYTE_CACHE_ENTRIES = 65_536;
const byteCache = new Map<string, Uint8Array>();
let cachedByteCount = 0;

/** 持久 Worker 的请求合同；字节可在命中 path/contentHash 缓存时省略。 */
interface WorkerEnvelope {
  request: {
    input: Record<string, unknown>;
    kind: "analyze" | "observe";
  };
  requestId: number;
}

/** 真实构建产物 Worker 按 requestId 处理多轮配置 broker 与最终分析。 */
function run(): void {
  if (parentPort === null) {
    throw new TypeError("TypeScript Analyzer Worker 缺少 parentPort。");
  }
  parentPort.on("message", (message: unknown) => {
    if (!isWorkerEnvelope(message)) {
      parentPort?.postMessage({
        code: "ANALYZER_PROTOCOL_INVALID",
        error: "TypeScript Analyzer Worker 请求不合法。",
        ok: false,
        requestId: readRequestId(message),
      });
      return;
    }
    try {
      const input = hydrateInput(message.request.input);
      const value = message.request.kind === "analyze"
        ? analyzeTypeScriptModules(input as unknown as AnalysisInputV1)
        : observeTypeScriptConfiguration(input as unknown as AnalyzerConfigurationInputV1);
      parentPort?.postMessage({ ok: true, requestId: message.requestId, value });
    } catch (error) {
      const failure = classifyWorkerAnalysisError(error);
      parentPort?.postMessage({
        code: failure.workerCode,
        error: failure.message,
        ok: false,
        requestId: message.requestId,
      });
    }
  });
}

/** 为三类文件数组恢复缓存字节，其余冻结配置字段保持原值。 */
function hydrateInput(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.configurationFiles) || !Array.isArray(input.sourceFiles)) {
    throw new WorkerAnalysisError("ANALYZER_PROTOCOL_INVALID", "Analyzer 文件数组缺失。");
  }
  if (input.hostPathIdentitySidecar !== undefined &&
    !isRecord(input.hostPathIdentitySidecar)) {
    throw new WorkerAnalysisError(
      "ANALYZER_PROTOCOL_INVALID",
      "Analyzer host path identity sidecar 不是普通请求对象。",
    );
  }
  return {
    ...input,
    configurationFiles: input.configurationFiles.map(hydrateFile),
    ...(input.resolutionFiles === undefined
      ? {}
      : {
          resolutionFiles: Array.isArray(input.resolutionFiles)
            ? input.resolutionFiles.map(hydrateFile)
            : invalidResolutionFiles(),
        }),
    sourceFiles: input.sourceFiles.map(hydrateFile),
  };
}

/** 文件命中缓存时补回字节；首次出现时写入与主线程一致的有界 LRU。 */
function hydrateFile(value: unknown): AnalyzerByteFileV1 & Record<string, unknown> {
  if (!isRecord(value) || typeof value.path !== "string" ||
    typeof value.contentHash !== "string") {
    throw new WorkerAnalysisError("ANALYZER_PROTOCOL_INVALID", "Analyzer 文件元数据不合法。");
  }
  const key = `${value.path}\0${value.contentHash}`;
  let bytes: Uint8Array;
  if (value.bytes instanceof Uint8Array) {
    bytes = value.bytes;
    rememberBytes(key, bytes);
  } else {
    const cached = byteCache.get(key);
    if (cached === undefined) {
      throw new WorkerAnalysisError(
        "ANALYZER_PROTOCOL_INVALID",
        "Analyzer Worker 缺少省略文件对应的缓存字节。",
      );
    }
    byteCache.delete(key);
    byteCache.set(key, cached);
    bytes = cached;
  }
  return { ...value, bytes } as AnalyzerByteFileV1 & Record<string, unknown>;
}

/** Worker 与主线程使用相同插入顺序 LRU，避免省略判断发生分歧。 */
function rememberBytes(key: string, bytes: Uint8Array): void {
  const previous = byteCache.get(key);
  if (previous !== undefined) {
    cachedByteCount -= previous.byteLength;
    byteCache.delete(key);
  }
  byteCache.set(key, bytes);
  cachedByteCount += bytes.byteLength;
  while ((cachedByteCount > MAX_WORKER_BYTE_CACHE_BYTES ||
    byteCache.size > MAX_WORKER_BYTE_CACHE_ENTRIES) && byteCache.size > 0) {
    const oldest = byteCache.entries().next().value as [string, Uint8Array] | undefined;
    if (oldest === undefined) {break;}
    byteCache.delete(oldest[0]);
    cachedByteCount -= oldest[1].byteLength;
  }
}

/** resolutionFiles 非数组时统一抛出封闭协议错误。 */
function invalidResolutionFiles(): never {
  throw new WorkerAnalysisError(
    "ANALYZER_PROTOCOL_INVALID",
    "Analyzer resolutionFiles 不合法。",
  );
}

/** 请求只接受正安全 requestId、普通 request/input 与封闭 kind。 */
function isWorkerEnvelope(value: unknown): value is WorkerEnvelope {
  return isRecord(value) && Number.isSafeInteger(value.requestId) &&
    (value.requestId as number) > 0 && isRecord(value.request) &&
    isRecord(value.request.input) &&
    (value.request.kind === "analyze" || value.request.kind === "observe");
}

/** 非法消息也回送稳定正 requestId，使主线程能按协议失败而非悬挂。 */
function readRequestId(value: unknown): number {
  return isRecord(value) && Number.isSafeInteger(value.requestId) &&
    (value.requestId as number) > 0 ? value.requestId as number : 1;
}

/** Worker 协议对象禁止数组/null 伪装。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

run();
