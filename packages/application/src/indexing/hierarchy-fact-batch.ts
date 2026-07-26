import { buildGraphEntityId, type FactCoverageV1, type HierarchyFactBatchV1 } from "@codegraph/domain";
import { buildHierarchyGraph, compareCanonicalGraphText } from "./hierarchy-builder.js";

/** hierarchy producer 的稳定身份会参与 configDigest 与 patchDigest。 */
export const HIERARCHY_PRODUCER_KIND = "hierarchy";
export const HIERARCHY_PRODUCER_VERSION = "hierarchy-v1";

/** 构造 hierarchy FactBatch 所需的语义输入。 */
export interface BuildHierarchyFactBatchOptions {
  configDigest: string;
  coverage: FactCoverageV1;
  inputDigest: string;
  manifestDigest: string;
  producerVersion: string;
  relativePaths: readonly string[];
  workspaceKey: string;
}

/**
 * 把现有稳定 hierarchy 身份提升为拥有明确 ownership 的 FactBatch。
 *
 * coverage 不决定是否保留已发现事实；只有后续 patch 用例有权允许 complete replacement。
 */
export function buildHierarchyFactBatch(
  options: BuildHierarchyFactBatchOptions,
): HierarchyFactBatchV1 {
  assertDigest(options.configDigest, "configDigest");
  assertDigest(options.inputDigest, "inputDigest");
  assertDigest(options.manifestDigest, "manifestDigest");
  if (options.producerVersion.length === 0) {
    throw new TypeError("hierarchy producerVersion 不能为空。");
  }
  const graph = buildHierarchyGraph(options.workspaceKey, options.relativePaths);
  const indexingRootId = buildGraphEntityId(options.workspaceKey, "workspace", "");
  return Object.freeze({
    configDigest: options.configDigest,
    coverage: options.coverage,
    edges: Object.freeze([...graph.edges].sort(compareById)),
    indexingRootId,
    inputDigest: options.inputDigest,
    manifestDigest: options.manifestDigest,
    nodes: Object.freeze([...graph.nodes].sort(compareById)),
    ownershipSliceId: `hierarchy:${indexingRootId}`,
    producerKind: HIERARCHY_PRODUCER_KIND,
    producerVersion: options.producerVersion,
  });
}

/** 稳定事实排序只依赖规范公共 ID。 */
function compareById(left: { id: string }, right: { id: string }): number {
  return compareCanonicalGraphText(left.id, right.id);
}

/** 所有语义 digest 必须是完整 SHA-256 小写十六进制。 */
function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} 必须是 SHA-256 小写十六进制。`);
  }
}
