import type { HierarchyEdge, HierarchyNode } from "./hierarchy.js";
import type {
  GraphEdgeV1,
  GraphNodeV1,
  ModuleEvidenceV1,
} from "./module-dependency.js";

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
  analyzerConfigSnapshot?: unknown;
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

/** composite patch 中单个 ownership slice 的完整 replacement mutation。 */
export interface GraphSliceMutationV1 {
  edgeDeletes: readonly string[];
  edgeUpserts: readonly GraphEdgeV1[];
  evidenceDeletes: readonly string[];
  evidenceUpserts: readonly ModuleEvidenceV1[];
  nodeDeletes: readonly string[];
  nodeUpserts: readonly GraphNodeV1[];
  ownershipSliceId: string;
}

/** composite patch 在 persisted read-set 中附加目标语义图摘要。 */
export interface CompositeGraphReadSetV1 extends HierarchyReadSetV1 {
  targetGraphDigest: string;
}

/**
 * hierarchy 与全部 source slices 共用 base revision、read-set、digest 和一次提交。
 *
 * shared facts 不伪装成 source slice 独占；source slice 仅拥有 Evidence。
 */
export interface CompositeGraphPatchV1 {
  baseGraphRevision: number | null;
  coverage: "complete";
  inputDigest: string;
  patchDigest: string;
  readSet: CompositeGraphReadSetV1;
  sharedEdgeDeletes: readonly string[];
  sharedEdgeUpserts: readonly GraphEdgeV1[];
  sharedNodeDeletes: readonly string[];
  sharedNodeUpserts: readonly GraphNodeV1[];
  slices: readonly GraphSliceMutationV1[];
  targetEdgeCount: number;
  targetNodeCount: number;
  version: 1;
}

/** GraphStorePort 兼容旧 hierarchy patch 与 Story 1.5 composite patch。 */
export type AnyGraphPatchV1 = CompositeGraphPatchV1 | GraphPatchV1;

/** 已提交单个 ownership slice 的可观察事实。 */
export interface CommittedOwnershipSliceV1 {
  ownedEdges: readonly GraphEdgeV1[];
  ownedEvidence: readonly ModuleEvidenceV1[];
  ownedNodes: readonly GraphNodeV1[];
  ownershipSliceId: string;
}

/** 计算 hierarchy patch 时可观察的基础已提交快照。 */
export interface CommittedGraphSnapshotV1 {
  allEdges?: readonly GraphEdgeV1[];
  allEvidence?: readonly ModuleEvidenceV1[];
  allNodes?: readonly GraphNodeV1[];
  committedReadSet: CommittedReadSetV1 | null;
  graphRevision: number | null;
  ownedEdges: readonly HierarchyEdge[];
  ownedNodes: readonly HierarchyNode[];
  ownedSlices?: readonly CommittedOwnershipSliceV1[];
  ownershipSliceId: string;
  patchDigest: string | null;
}

/** composite rebuild 必须消费完整全图与 ownership slices，禁止 hierarchy-only 快照降级。 */
export interface CommittedCompositeGraphSnapshotV1 extends CommittedGraphSnapshotV1 {
  allEdges: readonly GraphEdgeV1[];
  allEvidence: readonly ModuleEvidenceV1[];
  allNodes: readonly GraphNodeV1[];
  ownedSlices: readonly CommittedOwnershipSliceV1[];
}
