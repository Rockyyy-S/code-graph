import type { ErrorV1 } from "./protocol-error.js";

/** Story 1.4 支持的最小索引 Job 类型。 */
export type IndexJobKindV1 = "initial-index" | "rebuild";

/** 首次层级图谱提交后可公开的最小摘要。 */
export interface IndexCommitSummaryV1 {
  builtinRulesVersion: "builtin-ignore-v1";
  edgeCount: number;
  excludedPathCount: number;
  generatedAt: string;
  graphRevision: number;
  indexedFileCount: number;
  nodeCount: number;
}

/** 已排队但尚未开始的索引 Job。 */
export interface QueuedIndexJobV1 {
  baseGraphRevision: number | null;
  id: string;
  kind: IndexJobKindV1;
  requestedAt: string;
  resultGraphRevision: null;
  state: "queued";
}

/** 正在执行的索引 Job。 */
export interface RunningIndexJobV1 extends Omit<QueuedIndexJobV1, "state"> {
  startedAt: string;
  state: "running";
}

/** 成功完成的索引 Job。 */
export interface SucceededIndexJobV1 extends Omit<RunningIndexJobV1, "resultGraphRevision" | "state"> {
  completedAt: string;
  resultGraphRevision: number;
  state: "succeeded";
}

/** 失败结束且携带稳定诊断的索引 Job。 */
export interface FailedIndexJobV1 extends Omit<RunningIndexJobV1, "resultGraphRevision" | "state"> {
  completedAt: string;
  error: ErrorV1;
  resultGraphRevision: number | null;
  state: "failed";
}

/** 未覆盖完整 ownership slice 的 terminal partial Job。 */
export interface PartialIndexJobV1 extends Omit<RunningIndexJobV1, "resultGraphRevision" | "state"> {
  completedAt: string;
  resultGraphRevision: number | null;
  state: "partial";
}

/** 在事务外安全点终止且未提交事实的 Job。 */
export interface CancelledIndexJobV1 extends Omit<RunningIndexJobV1, "resultGraphRevision" | "state"> {
  completedAt: string;
  resultGraphRevision: number | null;
  state: "cancelled";
}

/** 当前切片允许的全部 Job 状态。 */
export type IndexJobStatusV1 =
  | CancelledIndexJobV1
  | QueuedIndexJobV1
  | RunningIndexJobV1
  | SucceededIndexJobV1
  | FailedIndexJobV1
  | PartialIndexJobV1;

/** `job/start` 的封闭 rebuild 请求；服务端根据已提交基线决定实际 Job 类型。 */
export interface JobStartRequestV1 {
  kind: "rebuild";
}

/** `job/start` 接受请求后的 canonical 排队响应。 */
export interface JobStartResultV1 {
  accepted: true;
  job: QueuedIndexJobV1;
}
