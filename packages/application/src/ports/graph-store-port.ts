import type {
  AnyGraphPatchV1,
  CommittedCompositeGraphSnapshotV1,
  CommittedGraphSnapshotV1,
} from "@codegraph/domain";

/** application 层可观察的已提交图谱摘要。 */
export interface StoredIndexSummary {
  builtinRulesVersion: "builtin-ignore-v1";
  edgeCount: number;
  excludedPathCount: number;
  generatedAt: string;
  graphRevision: number;
  indexedFileCount: number;
  nodeCount: number;
}

/** application 层持久化 Job 的最小字段。 */
export interface StoredIndexJob {
  baseGraphRevision: number | null;
  completedAt?: string;
  errorCode?: string;
  errorLogId?: string;
  id: string;
  kind: "initial-index" | "rebuild";
  requestedAt: string;
  resultGraphRevision: number | null;
  startedAt?: string;
  state: "cancelled" | "failed" | "partial" | "queued" | "running" | "succeeded";
}

/** 服务启动时从存储恢复的确定性提交基线。 */
export interface GraphStoreBootstrapState {
  committed: StoredIndexSummary | null;
  completeness: "complete" | "empty" | "partial";
  freshness: "current" | "stale" | null;
  lastJob: StoredIndexJob | null;
}

/** 创建 queued Job 时同时锁定其基线 revision。 */
export interface CreateStoredIndexJobInput {
  baseGraphRevision: number | null;
  id: string;
  kind: StoredIndexJob["kind"];
  requestedAt: string;
}

/** GraphPatch、摘要、Job 与 read-set 在同一事务提交的唯一输入。 */
export interface AtomicGraphUpdate {
  completedAt: string;
  expectedSnapshot: CommittedGraphSnapshotV1;
  /** 上层在同一同步调用栈中包围事务 mutation，前后复核外部 read-set。 */
  finalReadSetFence: (commitMutation: () => void) => boolean;
  jobId: string;
  patch: AnyGraphPatchV1;
  summary: Omit<StoredIndexSummary, "graphRevision">;
}

/** 原子提交结果；stale 不允许产生任何持久化变更。 */
export type AtomicGraphCommitResult =
  | { graphRevision: number | null; kind: "stale" }
  | { graphRevision: number; kind: "committed" | "noop"; summary: StoredIndexSummary };

/** application 拥有的唯一类型化 snapshot mutation 端口。 */
export interface GraphStorePort {
  close: () => void;
  commitAtomicGraphUpdate: (input: AtomicGraphUpdate) => AtomicGraphCommitResult;
  createJob: (job: CreateStoredIndexJobInput) => void;
  markJobCancelled: (jobId: string, completedAt: string) => void;
  markJobCancelledAndWorkspaceStale: (jobId: string, completedAt: string) => void;
  markJobFailed: (jobId: string, completedAt: string, errorCode: string, errorLogId: string) => void;
  markJobFailedAndWorkspaceStale: (
    jobId: string,
    completedAt: string,
    errorCode: string,
    errorLogId: string,
  ) => void;
  markJobPartial: (jobId: string, completedAt: string) => void;
  markJobRunning: (jobId: string, startedAt: string) => void;
  markWorkspaceStale: () => void;
  readBootstrapState: () => GraphStoreBootstrapState;
  readCommittedSnapshot: () => CommittedCompositeGraphSnapshotV1;
}
