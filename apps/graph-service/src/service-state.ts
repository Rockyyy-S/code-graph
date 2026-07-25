import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  type ErrorV1,
  type FailedIndexJobV1,
  type IndexCommitSummaryV1,
  type InitializeResult,
  type QueuedIndexJobV1,
  type ServiceStatusV1,
  type SucceededIndexJobV1,
} from "@codegraph/contracts";

/** 当前 graph-service 包版本。 */
export const GRAPH_SERVICE_VERSION = "0.0.0";

/** 服务状态初始化所需的持久化基线与实例身份。 */
export interface InitialServiceStateOptions {
  committed?: IndexCommitSummaryV1 | null;
  lastJob?: FailedIndexJobV1 | SucceededIndexJobV1 | null;
  serviceInstanceId: string;
  statusEpoch: string;
}

/** graph-service 共享的可变权威状态。 */
export interface ServiceState {
  getStatus: () => ServiceStatusV1;
  publishFailedJob: (jobId: string, completedAt: string, error: ErrorV1) => void;
  publishQueuedJob: (job: QueuedIndexJobV1) => void;
  publishRunningJob: (jobId: string, startedAt: string) => void;
  publishSucceededJob: (jobId: string, summary: IndexCommitSummaryV1) => void;
}

/** 从持久化提交与 terminal Job 创建服务实例级权威状态。 */
export function createServiceState(options: InitialServiceStateOptions): ServiceState {
  let currentIndexJob: ServiceStatusV1["currentIndexJob"] = null;
  let status = freezeStatus({
    availability: options.committed === null || options.committed === undefined
      ? "absent"
      : "available",
    committed: options.committed ?? null,
    completeness: (options.committed?.indexedFileCount ?? 0) === 0 ? "empty" : "complete",
    configRevision: 1,
    currentIndexJob: null,
    freshness: options.committed === null || options.committed === undefined ? null : "fresh",
    lastIndexJob: options.lastJob ?? null,
    lifecycle: "running",
    serviceInstanceId: options.serviceInstanceId,
    serviceStatusRevision: 1,
    statusEpoch: options.statusEpoch,
    statusRevision: 1,
    telemetry: {
      effective: "off",
      pending: false,
      requested: "off",
    },
    version: 1,
    viewConfigRevision: 1,
  });

  /** 原子发布一次状态转换并同步推进两套当前 epoch revision。 */
  const publish = (
    next: Omit<ServiceStatusV1, "serviceStatusRevision" | "statusRevision">,
  ): void => {
    status = freezeStatus({
      ...next,
      serviceStatusRevision: status.serviceStatusRevision + 1,
      statusRevision: status.statusRevision + 1,
    });
  };

  return {
    getStatus: () => status,
    publishFailedJob: (jobId, completedAt, error) => {
      const running = requireActiveJob(currentIndexJob, jobId, completedAt);
      const failed: FailedIndexJobV1 = Object.freeze({
        ...running,
        completedAt,
        error: Object.freeze({ ...error }),
        state: "failed",
      });
      currentIndexJob = null;
      publish({ ...status, currentIndexJob: null, lastIndexJob: failed });
    },
    publishQueuedJob: (job) => {
      if (currentIndexJob !== null) {
        throw new Error("索引 Job 已在运行。");
      }
      currentIndexJob = Object.freeze({ ...job });
      publish({ ...status, currentIndexJob, lastIndexJob: status.lastIndexJob });
    },
    publishRunningJob: (jobId, startedAt) => {
      if (currentIndexJob === null || currentIndexJob.id !== jobId) {
        throw new Error("索引 Job 状态转换目标不存在。");
      }
      currentIndexJob = Object.freeze({
        ...currentIndexJob,
        startedAt,
        state: "running",
      });
      publish({ ...status, currentIndexJob, lastIndexJob: status.lastIndexJob });
    },
    publishSucceededJob: (jobId, summary) => {
      const running = requireRunningJob(currentIndexJob, jobId);
      const succeeded: SucceededIndexJobV1 = Object.freeze({
        ...running,
        completedAt: summary.generatedAt,
        state: "succeeded",
      });
      currentIndexJob = null;
      publish({
        ...status,
        availability: "available",
        committed: Object.freeze({ ...summary }),
        completeness: summary.indexedFileCount === 0 ? "empty" : "complete",
        currentIndexJob: null,
        freshness: "fresh",
        lastIndexJob: succeeded,
      });
    },
  };
}

/** 保留 Story 1.2 调用点的空状态创建入口。 */
export function createInitialServiceState(options: InitialServiceStateOptions): ServiceState {
  return createServiceState({ ...options, committed: null, lastJob: null });
}

/** 从权威状态创建严格 canonical initialize 结果。 */
export function createInitializeResult(
  state: Pick<ServiceState, "getStatus">,
): InitializeResult {
  return {
    capabilities: SERVICE_CAPABILITIES,
    cliSchemaVersion: CLI_SCHEMA_VERSION,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    rulesSchemaVersion: RULES_SCHEMA_VERSION,
    serviceStatus: state.getStatus(),
    serviceVersion: GRAPH_SERVICE_VERSION,
  };
}

/** 冻结公开状态及其嵌套值，避免连接间观察到原地突变。 */
function freezeStatus(status: ServiceStatusV1): ServiceStatusV1 {
  return Object.freeze({
    ...status,
    ...(status.committed === null ? {} : { committed: Object.freeze({ ...status.committed }) }),
    ...(status.currentIndexJob === null
      ? {}
      : { currentIndexJob: Object.freeze({ ...status.currentIndexJob }) }),
    ...(status.lastIndexJob === null
      ? {}
      : { lastIndexJob: Object.freeze({ ...status.lastIndexJob }) }),
    telemetry: Object.freeze({ ...status.telemetry }),
  });
}

/** 只允许 running Job 进入 terminal 状态。 */
function requireRunningJob(
  job: ServiceStatusV1["currentIndexJob"],
  jobId: string,
): Extract<NonNullable<ServiceStatusV1["currentIndexJob"]>, { state: "running" }> {
  if (job === null || job.id !== jobId || job.state !== "running") {
    throw new Error("索引 Job 尚未进入 running 状态。");
  }
  return job;
}

/** queued 阶段基础设施失败时使用完成时间补齐最小 startedAt。 */
function requireActiveJob(
  job: ServiceStatusV1["currentIndexJob"],
  jobId: string,
  fallbackStartedAt: string,
): Extract<NonNullable<ServiceStatusV1["currentIndexJob"]>, { state: "running" }> {
  if (job === null || job.id !== jobId) {
    throw new Error("索引 Job 失败目标不存在。");
  }
  return job.state === "running"
    ? job
    : Object.freeze({ ...job, startedAt: fallbackStartedAt, state: "running" });
}
