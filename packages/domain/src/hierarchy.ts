import type { GraphEntityKind } from "./graph-identity.js";

/** 当前层级切片的业务节点。 */
export interface HierarchyNode {
  id: string;
  kind: GraphEntityKind;
  relativePath: string;
}

/** contains 关系方向固定为 container → child。 */
export interface HierarchyEdge {
  fromId: string;
  id: string;
  qualifier: string;
  relationType: "contains";
  toId: string;
}

/** 单次首次扫描生成的最小层级事实集合。 */
export interface HierarchyGraph {
  edges: readonly HierarchyEdge[];
  nodes: readonly HierarchyNode[];
  workspaceKey: string;
}
