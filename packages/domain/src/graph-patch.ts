import type { HierarchyEdge, HierarchyNode } from "./hierarchy.js";

/** hierarchy producer 在提交边界允许表达的覆盖状态。 */
export type FactCoverageV1 = "complete" | "failed" | "partial";

/** 规范 manifest 条目只包含相对路径与原始字节 SHA-256。 */
export interface ManifestEntryV1 {
  contentHash: string;
  path: string;
}

/** CAS 必须逐字段比较的完整有效排除快照。 */
export interface EffectiveIgnoreReadSetV1 {
  builtinRulesVersion: string;
  contentHash: string | null;
  effectiveDigest: string;
  effectiveRules: readonly string[];
  generation: number;
  lastValidDigest: string;
  userRules: readonly string[];
  validity: "valid";
  version: 1;
}

/** hierarchy Job 捕获的完整 read-set；generation/revision 只承担并发栅栏职责。 */
export interface HierarchyReadSetV1 {
  baseGraphRevision: number | null;
  bootstrapGeneration: number;
  configDigest: string;
  effectiveIgnoreSnapshot: EffectiveIgnoreReadSetV1;
  inputDigest: string;
  manifest: readonly ManifestEntryV1[];
  manifestDigest: string;
  statusEpoch: string;
}

/** 已提交快照持久化的语义 read-set 元数据，不跨实例保存 generation。 */
export interface CommittedReadSetV1 {
  configDigest: string;
  effectiveIgnoreDigest: string;
  inputDigest: string;
  manifestDigest: string;
}

/** hierarchy producer 输出的基础设施无关事实批次。 */
export interface HierarchyFactBatchV1 {
  configDigest: string;
  coverage: FactCoverageV1;
  edges: readonly HierarchyEdge[];
  indexingRootId: string;
  inputDigest: string;
  manifestDigest: string;
  nodes: readonly HierarchyNode[];
  ownershipSliceId: string;
  producerKind: "hierarchy";
  producerVersion: string;
}

/** application 计算、adapter 原子应用的确定性 hierarchy patch。 */
export interface GraphPatchV1 {
  baseGraphRevision: number | null;
  coverage: "complete";
  edgeDeletes: readonly string[];
  edgeUpserts: readonly HierarchyEdge[];
  inputDigest: string;
  nodeDeletes: readonly string[];
  nodeUpserts: readonly HierarchyNode[];
  ownershipSliceId: string;
  patchDigest: string;
  readSet: HierarchyReadSetV1;
}

/** 计算 patch 时可观察的已提交 ownership slice。 */
export interface CommittedGraphSnapshotV1 {
  committedReadSet: CommittedReadSetV1 | null;
  graphRevision: number | null;
  ownedEdges: readonly HierarchyEdge[];
  ownedNodes: readonly HierarchyNode[];
  ownershipSliceId: string;
  patchDigest: string | null;
}
