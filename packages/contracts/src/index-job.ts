import type { ErrorV1 } from "./protocol-error.js";

/** Story 1.4 支持的最小索引 Job 类型。 */
export type IndexJobKindV1 = "initial-index" | "rebuild";

/** 首次层级图谱提交后可公开的最小摘要。 */
export interface IndexCommitSummaryV1 {
  builtinRulesVersion: "builtin-ignore-v1";
  edgeCount: number;
  excludedPathCount: number;
  generatedAt: string;
  indexedFileCount: number;
  nodeCount: number;
}

/** 已排队但尚未开始的索引 Job。 */
export interface QueuedIndexJobV1 {
  id: string;
  kind: IndexJobKindV1;
  requestedAt: string;
  state: "queued";
}

/** 正在执行的索引 Job。 */
export interface RunningIndexJobV1 extends Omit<QueuedIndexJobV1, "state"> {
  startedAt: string;
  state: "running";
}

/** 成功完成的索引 Job。 */
export interface SucceededIndexJobV1 extends Omit<RunningIndexJobV1, "state"> {
  completedAt: string;
  state: "succeeded";
}

/** 失败结束且携带稳定诊断的索引 Job。 */
export interface FailedIndexJobV1 extends Omit<RunningIndexJobV1, "state"> {
  completedAt: string;
  error: ErrorV1;
  state: "failed";
}

/** 当前切片允许的全部 Job 状态。 */
export type IndexJobStatusV1 =
  | QueuedIndexJobV1
  | RunningIndexJobV1
  | SucceededIndexJobV1
  | FailedIndexJobV1;

/** `job/start` 的封闭 rebuild 请求；服务端根据已提交基线决定实际 Job 类型。 */
export interface JobStartRequestV1 {
  kind: "rebuild";
}

/** `job/start` 接受请求后的 canonical 排队响应。 */
export interface JobStartResultV1 {
  accepted: true;
  job: QueuedIndexJobV1;
}
