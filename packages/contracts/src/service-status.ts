import type {
  FailedIndexJobV1,
  IndexCommitSummaryV1,
  QueuedIndexJobV1,
  RunningIndexJobV1,
  SucceededIndexJobV1,
} from "./index-job.js";

/** Story 1.4 可返回的图谱可用性。 */
export type GraphAvailabilityV1 = "absent" | "available";

/** 当前 hierarchy 切片可返回的图谱完整度。 */
export type GraphCompletenessV1 = "complete" | "empty";

/** 遥测请求态与有效态；本切片固定为关闭。 */
export interface TelemetryStatusV1 {
  effective: "off";
  pending: false;
  requested: "off";
}

/** 索引状态摘要；空服务不得伪造 revision 或成功索引信息。 */
export interface IndexStatusSummaryV1 {
  availability: GraphAvailabilityV1;
  committed: IndexCommitSummaryV1 | null;
  completeness: GraphCompletenessV1;
  freshness: "fresh" | null;
}

/**
 * 空 graph-service 的权威状态快照。
 *
 * `availability=absent` 必须与 `committed=null`、`freshness=null` 和
 * `completeness=empty` 同时出现。
 */
export interface ServiceStatusV1 extends IndexStatusSummaryV1 {
  configRevision: number;
  currentIndexJob: QueuedIndexJobV1 | RunningIndexJobV1 | null;
  lastIndexJob: FailedIndexJobV1 | SucceededIndexJobV1 | null;
  lifecycle: "running";
  serviceInstanceId: string;
  serviceStatusRevision: number;
  statusEpoch: string;
  statusRevision: number;
  telemetry: TelemetryStatusV1;
  version: 1;
  viewConfigRevision: number;
}
