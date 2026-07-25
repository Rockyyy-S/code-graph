import type { HierarchyGraph } from "@codegraph/domain";

/** application 层可观察的持久化提交摘要。 */
export interface StoredIndexSummary {
  builtinRulesVersion: "builtin-ignore-v1";
  edgeCount: number;
  excludedPathCount: number;
  generatedAt: string;
  indexedFileCount: number;
  nodeCount: number;
}

/** application 层持久化 Job 的最小公共字段。 */
export interface StoredIndexJob {
  completedAt?: string;
  errorCode?: string;
  errorLogId?: string;
  id: string;
  kind: "initial-index" | "rebuild";
  requestedAt: string;
  startedAt?: string;
  state: "failed" | "queued" | "running" | "succeeded";
}

/** 服务启动时从存储恢复的当前切片基线。 */
export interface GraphStoreBootstrapState {
  committed: StoredIndexSummary | null;
  lastJob: StoredIndexJob | null;
}

/** 首次 hierarchy 提交输入；调用方不能提供 SQL、表名或 rowid。 */
export interface CommitHierarchyInput {
  completedAt: string;
  graph: HierarchyGraph;
  jobId: string;
  summary: StoredIndexSummary;
}

/** application 拥有的 Story 1.4 最小存储端口。 */
export interface GraphStorePort {
  close: () => void;
  commitHierarchy: (input: CommitHierarchyInput) => void;
  createJob: (job: Pick<StoredIndexJob, "id" | "kind" | "requestedAt">) => void;
  markJobFailed: (jobId: string, completedAt: string, errorCode: string, errorLogId: string) => void;
  markJobRunning: (jobId: string, startedAt: string) => void;
  readBootstrapState: () => GraphStoreBootstrapState;
}
