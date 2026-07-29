import type {
  CommittedCompositeGraphSnapshotV1,
  CompositeGraphPatchV1,
  GraphEdgeV1,
  GraphNodeV1,
  GraphSliceMutationV1,
  HierarchyFactBatchV1,
  HierarchyReadSetV1,
  ModuleEvidenceV1,
  ModuleSourceFactBatchV1,
} from "@codegraph/domain";
import type { CanonicalDigestPort } from "../ports/canonical-digest-port.js";
import { buildHierarchyGraphPatch } from "./graph-patch-builder.js";
import { compareCanonicalGraphText } from "./hierarchy-builder.js";

/** 构建一次 logical rebuild 的 composite patch 输入。 */
export interface BuildCompositeGraphPatchOptions {
  digestPort: CanonicalDigestPort;
  hierarchyBatch: HierarchyFactBatchV1;
  moduleBatches: readonly ModuleSourceFactBatchV1[];
  readSet: HierarchyReadSetV1;
  snapshot: CommittedCompositeGraphSnapshotV1;
}

/**
 * 将 hierarchy 与所有 source slices 收敛为一个确定性 composite patch。
 *
 * source slice 只 replacement 自己的 Evidence；共享 module edge/node 在顶层统一维护。
 */
export function buildCompositeGraphPatch(
  options: BuildCompositeGraphPatchOptions,
): CompositeGraphPatchV1 {
  const { hierarchyBatch, readSet, snapshot } = options;
  const hierarchyPatch = buildHierarchyGraphPatch({
    batch: hierarchyBatch,
    digestPort: options.digestPort,
    readSet,
    snapshot,
  });
  const batches = sortUniqueBatches(options.moduleBatches);
  for (const batch of batches) {
    if (
      batch.coverage !== "complete" ||
      batch.configDigest !== readSet.configDigest ||
      batch.inputDigest !== readSet.inputDigest ||
      batch.ownershipSliceId !== `source:${batch.analyzerKind}:${batch.sourceFileId}`
    ) {
      throw new TypeError("module FactBatch、read-set 或 source ownership 不一致。");
    }
  }

  const currentNodes = sortUniqueFacts(snapshot.allNodes, "current node");
  const currentEdges = sortUniqueFacts(snapshot.allEdges, "current edge");
  const currentEvidence = sortUniqueEvidence(snapshot.allEvidence);
  const targetModuleNodes = sortUniqueFacts(batches.flatMap((batch) => batch.nodes), "module node");
  const targetModuleEdges = sortUniqueFacts(batches.flatMap((batch) => batch.edges), "module edge");
  const targetEvidence = sortUniqueEvidence(batches.flatMap((batch) => batch.evidence));
  const currentNodeById = new Map(currentNodes.map((node) => [node.id, node]));
  const currentEdgeById = new Map(currentEdges.map((edge) => [edge.id, edge]));
  const targetModuleNodeIds = new Set(targetModuleNodes.map((node) => node.id));
  const targetModuleEdgeIds = new Set(targetModuleEdges.map((edge) => edge.id));
  const currentModuleNodes = currentNodes.filter((node) =>
    node.kind === "external-package" || node.kind === "node-builtin");
  const currentModuleEdges = currentEdges.filter((edge) => edge.relationType !== "contains");
  /** Story 1.5 不回收孤立共享节点；最后引用回收由 Story 1.7 统一负责。 */
  const retainedSharedNodes = currentModuleNodes.filter((node) =>
    !targetModuleNodeIds.has(node.id));
  const targetNodes = sortUniqueFacts(
    [...hierarchyBatch.nodes, ...targetModuleNodes, ...retainedSharedNodes],
    "target node",
  );
  const targetEdges = sortUniqueFacts(
    [...hierarchyBatch.edges, ...targetModuleEdges],
    "target edge",
  );
  const sharedNodeUpserts = targetModuleNodes.filter((node) =>
    !sameFact(currentNodeById.get(node.id), node));
  const sharedEdgeUpserts = targetModuleEdges.filter((edge) =>
    !sameFact(currentEdgeById.get(edge.id), edge));
  const sharedNodeDeletes: readonly string[] = [];
  const sharedEdgeDeletes = currentModuleEdges.map((edge) => edge.id)
    .filter((id) => !targetModuleEdgeIds.has(id));

  const currentSourceSlices = new Map(
    snapshot.ownedSlices
      .filter((slice) => slice.ownershipSliceId.startsWith("source:"))
      .map((slice) => [slice.ownershipSliceId, slice] as const),
  );
  const targetSourceBatches = new Map(batches.map((batch) =>
    [batch.ownershipSliceId, batch] as const));
  const sourceSliceIds = [...new Set([
    ...currentSourceSlices.keys(),
    ...targetSourceBatches.keys(),
  ])].sort(compareCanonicalGraphText);
  const sourceSlices = sourceSliceIds.map<GraphSliceMutationV1>((ownershipSliceId) => {
    const current = sortUniqueEvidence(
      currentSourceSlices.get(ownershipSliceId)?.ownedEvidence ??
      currentEvidence.filter((item) => `source:typescript:${item.sourceFileId}` === ownershipSliceId),
    );
    const target = sortUniqueEvidence(targetSourceBatches.get(ownershipSliceId)?.evidence ?? []);
    const currentById = new Map(current.map((item) => [item.id, item]));
    const targetIds = new Set(target.map((item) => item.id));
    return freezeSlice({
      edgeDeletes: [],
      edgeUpserts: [],
      evidenceDeletes: current.map((item) => item.id).filter((id) => !targetIds.has(id)),
      evidenceUpserts: target.filter((item) =>
        !sameEvidence(currentById.get(item.id), item)),
      nodeDeletes: [],
      nodeUpserts: [],
      ownershipSliceId,
    });
  });
  const hierarchySlice = freezeSlice({
    edgeDeletes: hierarchyPatch.edgeDeletes,
    edgeUpserts: hierarchyPatch.edgeUpserts,
    evidenceDeletes: [],
    evidenceUpserts: [],
    nodeDeletes: hierarchyPatch.nodeDeletes,
    nodeUpserts: hierarchyPatch.nodeUpserts,
    ownershipSliceId: hierarchyPatch.ownershipSliceId,
  });

  const ownership = [
    ...hierarchyBatch.edges.map((edge) => ({
      factId: edge.id,
      factKind: "edge" as const,
      ownerKey: hierarchyBatch.ownershipSliceId,
    })),
    ...hierarchyBatch.nodes.map((node) => ({
      factId: node.id,
      factKind: "node" as const,
      ownerKey: hierarchyBatch.ownershipSliceId,
    })),
    ...batches.flatMap((batch) => batch.evidence.map((item) => ({
      factId: item.id,
      factKind: "evidence" as const,
      ownerKey: batch.ownershipSliceId,
    }))),
  ].sort(compareOwnership);
  const targetGraphDigest = options.digestPort.digest({
    edges: targetEdges,
    evidence: targetEvidence.map(withoutDetectedAt),
    nodes: targetNodes,
    ownership,
    version: 1,
  });
  const compositeReadSet = Object.freeze({ ...readSet, targetGraphDigest });
  const patchDigest = options.digestPort.digest({
    configDigest: readSet.configDigest,
    inputDigest: readSet.inputDigest,
    manifestDigest: readSet.manifestDigest,
    targetGraphDigest,
    version: 1,
  });
  return Object.freeze({
    baseGraphRevision: snapshot.graphRevision,
    coverage: "complete",
    inputDigest: readSet.inputDigest,
    patchDigest,
    readSet: compositeReadSet,
    sharedEdgeDeletes: Object.freeze(sharedEdgeDeletes),
    sharedEdgeUpserts: Object.freeze(sharedEdgeUpserts),
    sharedNodeDeletes: Object.freeze(sharedNodeDeletes),
    sharedNodeUpserts: Object.freeze(sharedNodeUpserts),
    slices: Object.freeze([hierarchySlice, ...sourceSlices]
      .sort((left, right) => compareCanonicalGraphText(
        left.ownershipSliceId,
        right.ownershipSliceId,
      ))),
    targetEdgeCount: targetEdges.length,
    targetNodeCount: targetNodes.length,
    version: 1,
  });
}

/** ownership slice 必须唯一，输入排列不影响后续 patch。 */
function sortUniqueBatches(
  batches: readonly ModuleSourceFactBatchV1[],
): readonly ModuleSourceFactBatchV1[] {
  const sorted = [...batches].sort((left, right) =>
    compareCanonicalGraphText(left.ownershipSliceId, right.ownershipSliceId));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.ownershipSliceId === sorted[index]?.ownershipSliceId) {
      throw new TypeError("同一 source ownership slice 只能出现一次。");
    }
  }
  return Object.freeze(sorted);
}

/** 事实按 ID 排序、去重并拒绝同 ID 冲突。 */
function sortUniqueFacts<T extends GraphNodeV1 | GraphEdgeV1>(
  facts: readonly T[],
  label: string,
): readonly T[] {
  const sorted = [...facts].sort((left, right) => compareCanonicalGraphText(left.id, right.id));
  const unique: T[] = [];
  for (const fact of sorted) {
    const previous = unique.at(-1);
    if (previous?.id === fact.id) {
      if (!sameFact(previous, fact)) {
        throw new TypeError(`${label} 包含相同 ID 的冲突定义。`);
      }
      continue;
    }
    unique.push(fact);
  }
  return Object.freeze(unique);
}

/** Evidence 使用 AD-21 ID 去重，detectedAt 不参与冲突判断。 */
function sortUniqueEvidence(facts: readonly ModuleEvidenceV1[]): readonly ModuleEvidenceV1[] {
  const sorted = [...facts].sort((left, right) => compareCanonicalGraphText(left.id, right.id));
  const unique: ModuleEvidenceV1[] = [];
  for (const fact of sorted) {
    const previous = unique.at(-1);
    if (previous?.id === fact.id) {
      if (!sameEvidence(previous, fact)) {
        throw new TypeError("Evidence 包含相同 ID 的冲突定义。");
      }
      continue;
    }
    unique.push(fact);
  }
  return Object.freeze(unique);
}

/** 封闭领域事实可直接稳定比较。 */
function sameFact(left: GraphNodeV1 | GraphEdgeV1 | undefined, right: GraphNodeV1 | GraphEdgeV1): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** detectedAt 变化不得单独产生语义 patch。 */
function sameEvidence(left: ModuleEvidenceV1 | undefined, right: ModuleEvidenceV1): boolean {
  return left !== undefined && JSON.stringify(withoutDetectedAt(left)) ===
    JSON.stringify(withoutDetectedAt(right));
}

/** 从 Evidence 语义摘要中移除观察时间。 */
function withoutDetectedAt(value: ModuleEvidenceV1): Omit<ModuleEvidenceV1, "detectedAt"> {
  const { detectedAt: _detectedAt, ...semantic } = value;
  void _detectedAt;
  return semantic;
}

/** 冻结单 slice mutation，避免上层在 digest 后原地改写。 */
function freezeSlice(slice: GraphSliceMutationV1): GraphSliceMutationV1 {
  return Object.freeze({
    edgeDeletes: Object.freeze([...slice.edgeDeletes]),
    edgeUpserts: Object.freeze([...slice.edgeUpserts]),
    evidenceDeletes: Object.freeze([...slice.evidenceDeletes]),
    evidenceUpserts: Object.freeze([...slice.evidenceUpserts]),
    nodeDeletes: Object.freeze([...slice.nodeDeletes]),
    nodeUpserts: Object.freeze([...slice.nodeUpserts]),
    ownershipSliceId: slice.ownershipSliceId,
  });
}

/** ownership 摘要使用 fact kind、ID、owner 的规范序。 */
function compareOwnership(
  left: { factId: string; factKind: string; ownerKey: string },
  right: { factId: string; factKind: string; ownerKey: string },
): number {
  return compareCanonicalGraphText(left.factKind, right.factKind) ||
    compareCanonicalGraphText(left.factId, right.factId) ||
    compareCanonicalGraphText(left.ownerKey, right.ownerKey);
}
