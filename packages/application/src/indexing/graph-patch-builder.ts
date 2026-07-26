import type {
  CommittedGraphSnapshotV1,
  GraphPatchV1,
  HierarchyEdge,
  HierarchyFactBatchV1,
  HierarchyNode,
  HierarchyReadSetV1,
} from "@codegraph/domain";
import type { CanonicalDigestPort } from "../ports/canonical-digest-port.js";
import { compareCanonicalGraphText } from "./hierarchy-builder.js";

/** hierarchy GraphPatch 计算输入。 */
export interface BuildHierarchyGraphPatchOptions {
  batch: HierarchyFactBatchV1;
  digestPort: CanonicalDigestPort;
  readSet: HierarchyReadSetV1;
  snapshot: CommittedGraphSnapshotV1;
}

/**
 * 基于目标 FactBatch 与当前 ownership slice 计算确定性 replacement patch。
 *
 * patchDigest 绑定目标语义状态，不包含 Job、时间、generation 或 base revision，
 * 因而相同目标状态在 CAS 重排和重放时保持字节级一致。
 */
export function buildHierarchyGraphPatch(
  options: BuildHierarchyGraphPatchOptions,
): GraphPatchV1 {
  const { batch, readSet, snapshot } = options;
  if (batch.coverage !== "complete") {
    throw new TypeError("只有 complete hierarchy FactBatch 可以生成 replacement GraphPatch。");
  }
  if (
    batch.ownershipSliceId !== `hierarchy:${batch.indexingRootId}` ||
    snapshot.ownershipSliceId !== batch.ownershipSliceId ||
    readSet.baseGraphRevision !== snapshot.graphRevision ||
    batch.inputDigest !== readSet.inputDigest ||
    batch.configDigest !== readSet.configDigest ||
    batch.manifestDigest !== readSet.manifestDigest
  ) {
    throw new TypeError("hierarchy FactBatch、read-set 与 committed snapshot 不一致。");
  }
  validateReadSet(readSet);

  const targetNodes = sortUniqueFacts(batch.nodes, "node");
  const targetEdges = sortUniqueFacts(batch.edges, "edge");
  const currentNodes = sortUniqueFacts(snapshot.ownedNodes, "node");
  const currentEdges = sortUniqueFacts(snapshot.ownedEdges, "edge");
  const currentNodeById = new Map(currentNodes.map((node) => [node.id, node]));
  const currentEdgeById = new Map(currentEdges.map((edge) => [edge.id, edge]));
  const targetNodeIds = new Set(targetNodes.map((node) => node.id));
  const targetEdgeIds = new Set(targetEdges.map((edge) => edge.id));

  const nodeUpserts = targetNodes.filter((node) => !sameFact(currentNodeById.get(node.id), node));
  const edgeUpserts = targetEdges.filter((edge) => !sameFact(currentEdgeById.get(edge.id), edge));
  const nodeDeletes = currentNodes.map((node) => node.id).filter((id) => !targetNodeIds.has(id));
  const edgeDeletes = currentEdges.map((edge) => edge.id).filter((id) => !targetEdgeIds.has(id));
  const patchDigest = options.digestPort.digest({
    configDigest: batch.configDigest,
    coverage: batch.coverage,
    edges: targetEdges,
    inputDigest: batch.inputDigest,
    manifestDigest: batch.manifestDigest,
    nodes: targetNodes,
    ownershipSliceId: batch.ownershipSliceId,
    producerKind: batch.producerKind,
    producerVersion: batch.producerVersion,
  });

  return Object.freeze({
    baseGraphRevision: snapshot.graphRevision,
    coverage: "complete",
    edgeDeletes: Object.freeze(edgeDeletes),
    edgeUpserts: Object.freeze(edgeUpserts),
    inputDigest: batch.inputDigest,
    nodeDeletes: Object.freeze(nodeDeletes),
    nodeUpserts: Object.freeze(nodeUpserts),
    ownershipSliceId: batch.ownershipSliceId,
    patchDigest,
    readSet,
  });
}

/** 拒绝任意重复 ID 携带不同事实，避免输入排列掩盖语义冲突。 */
function sortUniqueFacts<T extends HierarchyNode | HierarchyEdge>(
  facts: readonly T[],
  label: string,
): readonly T[] {
  const sorted = [...facts].sort((left, right) => compareCanonicalGraphText(left.id, right.id));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous !== undefined && current !== undefined && previous.id === current.id) {
      if (!sameFact(previous, current)) {
        throw new TypeError(`${label} Fact 包含相同 ID 的冲突定义。`);
      }
      sorted.splice(index, 1);
      index -= 1;
    }
  }
  return Object.freeze(sorted);
}

/** 领域事实使用封闭标量字段，可通过稳定 JSON 逐字段比较。 */
function sameFact(left: HierarchyNode | HierarchyEdge | undefined, right: HierarchyNode | HierarchyEdge): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

/** 完整 read-set 必须携带规范 manifest、全量 ignore snapshot 与安全整数栅栏。 */
function validateReadSet(readSet: HierarchyReadSetV1): void {
  if (
    (readSet.baseGraphRevision !== null && !isPositiveSafeInteger(readSet.baseGraphRevision)) ||
    !isNonNegativeSafeInteger(readSet.bootstrapGeneration) ||
    !isNonNegativeSafeInteger(readSet.effectiveIgnoreSnapshot.generation) ||
    readSet.statusEpoch.length === 0
  ) {
    throw new TypeError("hierarchy read-set 的 revision/generation 栅栏不合法。");
  }
  const sortedManifest = [...readSet.manifest].sort((left, right) =>
    compareCanonicalGraphText(left.path, right.path));
  if (JSON.stringify(sortedManifest) !== JSON.stringify(readSet.manifest)) {
    throw new TypeError("hierarchy read-set manifest 必须按规范路径排序。");
  }
}

/** generation 从 0 开始，只接受非负安全整数。 */
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 已提交 revision 从 1 开始，只接受正安全整数。 */
function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}
