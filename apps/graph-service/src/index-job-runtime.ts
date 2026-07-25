import { randomUUID } from "node:crypto";
import {
  buildHierarchyGraph,
  type GraphStorePort,
  type StoredIndexJob,
  type StoredIndexSummary,
} from "@codegraph/application";
import {
  createErrorV1,
  SERVICE_ERROR_CODES,
  type ErrorCategory,
  type ErrorV1,
  type JobStartRequest,
  type JobStartResult,
  type ServiceErrorCode,
  type ServiceStatusV1,
} from "@codegraph/contracts";
import type { InitialIgnoreState } from "./ignore-bootstrap.js";
import { createServiceState } from "./service-state.js";
import {
  scanWorkspace,
  WorkspaceScanError,
  type ScanWorkspaceOptions,
  type WorkspaceScanResult,
} from "./workspace-scanner.js";

/** 显式 Job 预算；当前切片仍只允许一个实际 writer 并拒绝并发请求。 */
export const MAX_PENDING_EXPLICIT_JOBS = 64;

/** runtime 单次关闭等待当前扫描结束的默认硬界限。 */
export const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 200;

/** 服务端连接共享的 runtime 边界。 */
export interface GraphServiceRuntime {
  beginShutdown: () => void;
  close: () => Promise<void>;
  getStatus: () => ServiceStatusV1;
  startJob: (request: JobStartRequest) => JobStartResult;
}

/** runtime 初始化参数。 */
export interface CreateIndexJobRuntimeOptions {
  closeTimeoutMs?: number;
  createJobId?: () => string;
  ignoreState: InitialIgnoreState;
  indexingRoot: string;
  now?: () => string;
  scan?: (options: ScanWorkspaceOptions) => Promise<WorkspaceScanResult>;
  schedule?: (operation: () => void) => void;
  serviceInstanceId: string;
  statusEpoch: string;
  store: GraphStorePort;
  workspaceKey: string;
}

/** 带稳定 ErrorV1 的服务端业务请求错误。 */
export class GraphServiceRequestError extends Error implements ErrorV1 {
  public readonly category: ErrorCategory;
  public readonly code: ServiceErrorCode;
  public readonly logId: string;
  public readonly retryable: boolean;
  public readonly suggestedAction: string;

  public constructor(error: ErrorV1) {
    super(error.message);
    this.name = "GraphServiceRequestError";
    this.category = error.category;
    this.code = error.code;
    this.logId = error.logId;
    this.retryable = error.retryable;
    this.suggestedAction = error.suggestedAction;
  }

  /** 返回可安全放入 JSON-RPC error.data 的稳定对象。 */
  public toProtocolError(): ErrorV1 {
    return {
      category: this.category,
      code: this.code,
      logId: this.logId,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
    };
  }
}

/** 创建服务实例级共享索引 runtime，并恢复已持久化的最小状态。 */
export function createIndexJobRuntime(
  options: CreateIndexJobRuntimeOptions,
): GraphServiceRuntime {
  const persisted = options.store.readBootstrapState();
  const state = createServiceState({
    committed: persisted.committed,
    lastJob: mapPersistedTerminalJob(persisted.lastJob),
    serviceInstanceId: options.serviceInstanceId,
    statusEpoch: options.statusEpoch,
  });
  const createJobId = options.createJobId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const scan = options.scan ?? scanWorkspace;
  const schedule = options.schedule ?? ((operation: () => void) => setImmediate(operation));
  const closeTimeoutMs = normalizeCloseTimeout(
    options.closeTimeoutMs ?? DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS,
  );
  let closing = false;
  let currentRun: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let storeClosed = false;
  let runAbortController: AbortController | null = null;

  /** 在返回 shutdown accepted 前同步关闭 Job 接收门禁。 */
  const beginShutdown = (): void => {
    closing = true;
    runAbortController?.abort();
  };

  /** 执行已持久化的 queued Job，并保证任何失败都不发布未提交 counts。 */
  const runJob = async (
    jobId: string,
    requestedAt: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = timestampAtOrAfter(now(), requestedAt);
    try {
      state.publishRunningJob(jobId, startedAt);
      options.store.markJobRunning(jobId, startedAt);
      if (options.ignoreState.kind !== "ready") {
        throw new Error("无有效 ignore snapshot 的 Job 不应进入运行阶段。");
      }
      const scanResult = await scan({
        ignoreSnapshot: options.ignoreState.snapshot,
        indexingRoot: options.indexingRoot,
        signal,
      });
      if (signal.aborted) {
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区扫描已被安全取消。");
      }
      const graph = buildHierarchyGraph(options.workspaceKey, scanResult.candidateFiles);
      const completedAt = timestampAtOrAfter(now(), startedAt);
      const summary: StoredIndexSummary = {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: graph.edges.length,
        excludedPathCount: scanResult.excludedPathCount,
        generatedAt: completedAt,
        indexedFileCount: scanResult.candidateFiles.length,
        nodeCount: graph.nodes.length,
      };
      options.store.commitHierarchy({ completedAt, graph, jobId, summary });
      state.publishSucceededJob(jobId, summary);
    } catch (error) {
      const completedAt = timestampAtOrAfter(now(), startedAt);
      const protocolError = signal.aborted
        ? createErrorV1("GRAPH_SCAN_FAILED", randomUUID())
        : mapJobFailure(error);
      if (!signal.aborted) {
        try {
          options.store.markJobFailed(
            jobId,
            completedAt,
            protocolError.code,
            protocolError.logId,
          );
        } catch {
          /** terminal 状态仍需可诊断；原始 SQLite 错误不会被未处理 rejection 泄露。 */
        }
      }
      state.publishFailedJob(jobId, completedAt, protocolError);
    }
  };

  return {
    beginShutdown,
    close: () => {
      beginShutdown();
      if (storeClosed) {
        return Promise.resolve();
      }
      if (closePromise !== null) {
        return closePromise;
      }
      const activeRun = currentRun;
      closePromise = (async () => {
        if (activeRun !== null) {
          await waitForRunWithinLimit(activeRun, closeTimeoutMs);
        }
        options.store.close();
        storeClosed = true;
      })().finally(() => {
        closePromise = null;
      });
      return closePromise;
    },
    getStatus: state.getStatus,
    startJob: (_request) => {
      if (closing || state.getStatus().currentIndexJob !== null || currentRun !== null) {
        throw new GraphServiceRequestError(
          createErrorV1("INDEX_JOB_ALREADY_RUNNING", randomUUID()),
        );
      }
      const requestedAt = now();
      const kind = state.getStatus().committed === null ? "initial-index" : "rebuild";
      const job = Object.freeze({
        id: createJobId(),
        kind,
        requestedAt,
        state: "queued" as const,
      });
      state.publishQueuedJob(job);
      try {
        options.store.createJob(job);
      } catch {
        const error = createErrorV1("GRAPH_WRITE_FAILED", randomUUID());
        state.publishFailedJob(job.id, timestampAtOrAfter(now(), requestedAt), error);
        throw new GraphServiceRequestError(error);
      }
      if (options.ignoreState.kind !== "ready") {
        const error = createErrorV1("GRAPH_IGNORE_CONFIG_UNSUPPORTED", randomUUID());
        const completedAt = timestampAtOrAfter(now(), requestedAt);
        try {
          options.store.markJobFailed(job.id, completedAt, error.code, error.logId);
        } catch {
          /** 配置拒绝的内存终态仍需可查询，附加持久化失败不覆盖原始诊断。 */
        }
        state.publishFailedJob(job.id, completedAt, error);
        throw new GraphServiceRequestError(error);
      }
      const controller = new AbortController();
      runAbortController = controller;
      currentRun = new Promise<void>((resolve) => schedule(resolve))
        .then(() => runJob(job.id, requestedAt, controller.signal))
        .finally(() => {
          if (runAbortController === controller) {
            runAbortController = null;
          }
          currentRun = null;
        });
      return { accepted: true, job };
    },
  };
}

/** 系统时钟回拨时把生命周期时间钳制到前一阶段，保持 canonical 状态单调。 */
function timestampAtOrAfter(candidate: string, floor: string): string {
  const candidateTime = Date.parse(candidate);
  const floorTime = Date.parse(floor);
  if (Number.isFinite(candidateTime) && Number.isFinite(floorTime) && candidateTime < floorTime) {
    return floor;
  }
  return candidate;
}

/** 有界等待当前扫描，超时时保留仍可能被 Job 使用的 store 供后续重试关闭。 */
async function waitForRunWithinLimit(run: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("等待当前索引 Job 结束超时。")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** runtime 关闭界限必须是 Node 定时器可表达的正整数。 */
function normalizeCloseTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("runtime close timeout 必须位于安全定时器范围内。");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/** 将持久化 terminal Job 恢复为公共状态，不接受不完整或未知错误码。 */
function mapPersistedTerminalJob(
  job: StoredIndexJob | null,
): ServiceStatusV1["lastIndexJob"] {
  if (job === null) {
    return null;
  }
  if (job.startedAt === undefined || job.completedAt === undefined) {
    throw new Error("持久化 terminal Job 缺少时间字段。");
  }
  if (job.state === "succeeded") {
    return {
      completedAt: job.completedAt,
      id: job.id,
      kind: job.kind,
      requestedAt: job.requestedAt,
      startedAt: job.startedAt,
      state: "succeeded",
    };
  }
  if (
    job.state !== "failed" ||
    job.errorCode === undefined ||
    job.errorLogId === undefined ||
    !(SERVICE_ERROR_CODES as readonly string[]).includes(job.errorCode)
  ) {
    throw new Error("持久化失败 Job 的错误合同不完整。");
  }
  return {
    completedAt: job.completedAt,
    error: createErrorV1(job.errorCode as ServiceErrorCode, job.errorLogId),
    id: job.id,
    kind: job.kind,
    requestedAt: job.requestedAt,
    startedAt: job.startedAt,
    state: "failed",
  };
}

/** 将配置、扫描与 SQLite 异常收敛为语义准确的稳定 ErrorV1。 */
function mapJobFailure(error: unknown): ErrorV1 {
  if (error instanceof GraphServiceRequestError) {
    return error.toProtocolError();
  }
  if (error instanceof WorkspaceScanError) {
    return createErrorV1(error.code, randomUUID());
  }
  return createErrorV1("GRAPH_WRITE_FAILED", randomUUID());
}
