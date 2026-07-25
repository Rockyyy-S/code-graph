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

/** 服务端连接共享的 runtime 边界。 */
export interface GraphServiceRuntime {
  close: () => Promise<void>;
  getStatus: () => ServiceStatusV1;
  startJob: (request: JobStartRequest) => JobStartResult;
}

/** runtime 初始化参数。 */
export interface CreateIndexJobRuntimeOptions {
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
  let closing = false;
  let currentRun: Promise<void> | null = null;

  /** 执行已持久化的 queued Job，并保证任何失败都不发布未提交 counts。 */
  const runJob = async (jobId: string): Promise<void> => {
    const startedAt = now();
    try {
      state.publishRunningJob(jobId, startedAt);
      options.store.markJobRunning(jobId, startedAt);
      if (options.ignoreState.kind !== "ready") {
        throw new GraphServiceRequestError(
          createErrorV1("GRAPH_IGNORE_CONFIG_UNSUPPORTED", randomUUID()),
        );
      }
      const scanResult = await scan({
        ignoreSnapshot: options.ignoreState.snapshot,
        indexingRoot: options.indexingRoot,
      });
      const graph = buildHierarchyGraph(options.workspaceKey, scanResult.candidateFiles);
      const completedAt = now();
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
      const completedAt = now();
      const protocolError = mapJobFailure(error);
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
      state.publishFailedJob(jobId, completedAt, protocolError);
    }
  };

  return {
    close: async () => {
      closing = true;
      await currentRun;
      options.store.close();
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
      try {
        options.store.createJob(job);
      } catch {
        throw new GraphServiceRequestError(createErrorV1("GRAPH_WRITE_FAILED", randomUUID()));
      }
      state.publishQueuedJob(job);
      currentRun = new Promise<void>((resolve) => schedule(resolve))
        .then(() => runJob(job.id))
        .finally(() => {
          currentRun = null;
        });
      return { accepted: true, job };
    },
  };
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
