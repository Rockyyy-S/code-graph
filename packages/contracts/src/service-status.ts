/** Story 1.2 可返回的图谱可用性。 */
export type GraphAvailabilityV1 = "absent";

/** Story 1.2 可返回的图谱完整度。 */
export type GraphCompletenessV1 = "empty";

/** 遥测请求态与有效态；本切片固定为关闭。 */
export interface TelemetryStatusV1 {
  effective: "off";
  pending: false;
  requested: "off";
}

/** 索引状态摘要；空服务不得伪造 revision 或成功索引信息。 */
export interface IndexStatusSummaryV1 {
  availability: GraphAvailabilityV1;
  committed: null;
  completeness: GraphCompletenessV1;
  freshness: null;
}

/**
 * 空 graph-service 的权威状态快照。
 *
 * `availability=absent` 必须与 `committed=null`、`freshness=null` 和
 * `completeness=empty` 同时出现。
 */
export interface ServiceStatusV1 extends IndexStatusSummaryV1 {
  configRevision: number;
  lifecycle: "running";
  serviceInstanceId: string;
  serviceStatusRevision: number;
  statusEpoch: string;
  statusRevision: number;
  telemetry: TelemetryStatusV1;
  version: 1;
  viewConfigRevision: number;
}
