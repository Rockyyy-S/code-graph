import {
  buildGraphEdgeId,
  buildGraphEntityId,
  normalizeRelativeGraphPath,
  type HierarchyEdge,
  type HierarchyGraph,
  type HierarchyNode,
} from "@codegraph/domain";

/** 当前切片锁定的 TypeScript/JavaScript 文件后缀。 */
export const SUPPORTED_SOURCE_SUFFIXES = [
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
] as const;

/** 判断候选路径是否属于当前切片支持的 TS/JS 文件集合。 */
export function isSupportedSourceFile(relativePath: string): boolean {
  const normalized = normalizeRelativeGraphPath(relativePath);
  const lowerName = normalized.toLocaleLowerCase("en-US");
  return SUPPORTED_SOURCE_SUFFIXES.some((suffix) => lowerName.endsWith(suffix));
}

/**
 * 从已过滤的规范候选文件构造确定性的 workspace/directory/file 层级。
 *
 * 本用例不读取文件系统，也不解释 ignore 配置；它只消费 scanner 交付的可信候选集。
 */
export function buildHierarchyGraph(
  workspaceKey: string,
  candidateFiles: readonly string[],
): HierarchyGraph {
  const normalizedFiles = [...new Set(candidateFiles.map(normalizeRelativeGraphPath))]
    .sort((left, right) => left.localeCompare(right));
  if (!normalizedFiles.every(isSupportedSourceFile)) {
    throw new TypeError("hierarchy builder 收到了不受支持的候选文件。");
  }

  const directories = new Set<string>();
  for (const file of normalizedFiles) {
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  const sortedDirectories = [...directories].sort((left, right) => left.localeCompare(right));
  const workspaceNode: HierarchyNode = {
    id: buildGraphEntityId(workspaceKey, "workspace", ""),
    kind: "workspace",
    relativePath: "",
  };
  const directoryNodes = sortedDirectories.map<HierarchyNode>((relativePath) => ({
    id: buildGraphEntityId(workspaceKey, "directory", relativePath),
    kind: "directory",
    relativePath,
  }));
  const fileNodes = normalizedFiles.map<HierarchyNode>((relativePath) => ({
    id: buildGraphEntityId(workspaceKey, "file", relativePath),
    kind: "file",
    relativePath,
  }));
  const nodeByPath = new Map<string, HierarchyNode>([
    ["", workspaceNode],
    ...directoryNodes.map((node) => [node.relativePath, node] as const),
    ...fileNodes.map((node) => [node.relativePath, node] as const),
  ]);
  const childNodes = [...directoryNodes, ...fileNodes].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath));
  const edges = childNodes.map<HierarchyEdge>((child) => {
    const parentPath = parentRelativePath(child.relativePath);
    const parent = nodeByPath.get(parentPath);
    if (parent === undefined) {
      throw new Error("层级候选缺少已纳入的祖先目录。");
    }
    return {
      fromId: parent.id,
      id: buildGraphEdgeId(workspaceKey, parent.id, "contains", child.id),
      qualifier: "",
      relationType: "contains",
      toId: child.id,
    };
  });

  return Object.freeze({
    edges: Object.freeze(edges.map((edge) => Object.freeze(edge))),
    nodes: Object.freeze(
      [workspaceNode, ...directoryNodes, ...fileNodes].map((node) => Object.freeze(node)),
    ),
    workspaceKey,
  });
}

/** 返回规范相对路径的父级；顶层实体由 workspace 根容纳。 */
function parentRelativePath(relativePath: string): string {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex < 0 ? "" : relativePath.slice(0, separatorIndex);
}
