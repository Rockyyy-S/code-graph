import type {
  CancelledIndexJobV1,
  FailedIndexJobV1,
  IndexCommitSummaryV1,
  PartialIndexJobV1,
  QueuedIndexJobV1,
  RunningIndexJobV1,
  SucceededIndexJobV1,
} from "./index-job.js";

/** 当前切片可返回的图谱可用性。 */
export type GraphAvailabilityV1 = "absent" | "available";

/** hierarchy ownership 的最低完整度表达。 */
export type GraphCompletenessV1 = "complete" | "empty" | "partial";

/** 遥测请求态与有效态；本切片固定为关闭。 */
export interface TelemetryStatusV1 {
  effective: "off";
  pending: false;
  requested: "off";
}

/** 索引状态摘要；服务状态 revision 与 graphRevision 保持独立。 */
export interface IndexStatusSummaryV1 {
  availability: GraphAvailabilityV1;
  committed: IndexCommitSummaryV1 | null;
  completeness: GraphCompletenessV1;
  freshness: "current" | "stale" | null;
  graphRevision: number | null;
}

/** graph-service 的权威状态快照。 */
export interface ServiceStatusV1 extends IndexStatusSummaryV1 {
  configRevision: number;
  currentIndexJob: QueuedIndexJobV1 | RunningIndexJobV1 | null;
  lastIndexJob:
    | CancelledIndexJobV1
    | FailedIndexJobV1
    | PartialIndexJobV1
    | SucceededIndexJobV1
    | null;
  lifecycle: "running";
  serviceInstanceId: string;
  serviceStatusRevision: number;
  statusEpoch: string;
  statusRevision: number;
  telemetry: TelemetryStatusV1;
  version: 1;
  viewConfigRevision: number;
}

type CompatibleQueuedIndexJobV1 = Omit<
  QueuedIndexJobV1,
  "baseGraphRevision" | "resultGraphRevision"
> & Partial<Pick<QueuedIndexJobV1, "baseGraphRevision" | "resultGraphRevision">>;

type CompatibleRunningIndexJobV1 = Omit<
  RunningIndexJobV1,
  "baseGraphRevision" | "resultGraphRevision"
> & Partial<Pick<RunningIndexJobV1, "baseGraphRevision" | "resultGraphRevision">>;

type CompatibleTerminalIndexJobV1 = (
  | Omit<CancelledIndexJobV1, "baseGraphRevision" | "resultGraphRevision">
  | Omit<FailedIndexJobV1, "baseGraphRevision" | "resultGraphRevision">
  | Omit<PartialIndexJobV1, "baseGraphRevision" | "resultGraphRevision">
  | Omit<SucceededIndexJobV1, "baseGraphRevision" | "resultGraphRevision">
) & {
  baseGraphRevision?: number | null;
  resultGraphRevision?: number | null;
};

/** 同一 v1 线协议的兼容状态输入，允许 Story 1.2/1.4 缺少新增 revision 字段。 */
export type CompatibleServiceStatusV1 = Omit<
  ServiceStatusV1,
  "committed" | "currentIndexJob" | "freshness" | "graphRevision" | "lastIndexJob"
> & {
  committed: (Omit<IndexCommitSummaryV1, "graphRevision"> & { graphRevision?: number }) | null;
  currentIndexJob?: CompatibleQueuedIndexJobV1 | CompatibleRunningIndexJobV1 | null;
  freshness: "current" | "fresh" | "stale" | null;
  graphRevision?: number | null;
  lastIndexJob?: CompatibleTerminalIndexJobV1 | null;
};
