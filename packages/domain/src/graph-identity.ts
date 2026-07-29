/** hierarchy 切片允许使用工作区相对路径构造的实体类型。 */
export type HierarchyEntityKind = "directory" | "file" | "workspace";

/** 当前持久图谱允许的封闭实体类型。 */
export type GraphEntityKind = HierarchyEntityKind | "external-package" | "node-builtin";

/** 当前持久图谱允许的封闭关系类型。 */
export type GraphRelationType = "contains" | "exports" | "imports";

/**
 * 将输入路径规范为工作区相对、Unicode NFC、POSIX 分隔格式。
 *
 * 绝对路径、父目录逃逸、NUL 与空路径段均在进入公共身份前拒绝。
 */
export function normalizeRelativeGraphPath(input: string): string {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(input)
  ) {
    throw new TypeError("图谱路径必须是安全的工作区相对路径。");
  }
  if (input.length === 0) {
    return "";
  }
  const segments: string[] = [];
  for (const rawSegment of input.replaceAll("\\", "/").split("/")) {
    const segment = rawSegment.normalize("NFC");
    if (segment === ".") {
      continue;
    }
    if (segment.length === 0 || segment === "..") {
      throw new TypeError("图谱路径包含空段或父目录逃逸。");
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** 使用工作区作用域、实体类型和规范相对路径构造确定性 cg:// ID。 */
export function buildGraphEntityId(
  workspaceKey: string,
  kind: HierarchyEntityKind,
  relativePath: string,
): string {
  assertWorkspaceKey(workspaceKey);
  const normalizedPath = normalizeRelativeGraphPath(relativePath);
  if (kind === "workspace") {
    if (normalizedPath.length !== 0) {
      throw new TypeError("workspace 实体不能携带相对路径。");
    }
    return `cg://${workspaceKey}/workspace/`;
  }
  if (normalizedPath.length === 0) {
    throw new TypeError(`${kind} 实体必须携带非空相对路径。`);
  }
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  return `cg://${workspaceKey}/${kind}/${encodedPath}${kind === "directory" ? "/" : ""}`;
}

/** 构造包含 qualifier 的确定性关系 ID，且不依赖 SQLite rowid。 */
export function buildGraphEdgeId(
  workspaceKey: string,
  fromId: string,
  relationType: GraphRelationType,
  toId: string,
  qualifier = "",
): string {
  assertWorkspaceKey(workspaceKey);
  const identity = [fromId, relationType, toId, qualifier].join("\0").normalize("NFC");
  return `cg://${workspaceKey}/edge/${encodeURIComponent(identity)}`;
}

/** 工作区公共身份只接受完整 SHA-256 小写十六进制。 */
function assertWorkspaceKey(workspaceKey: string): void {
  if (!/^[a-f0-9]{64}$/u.test(workspaceKey)) {
    throw new TypeError("workspaceKey 必须是 SHA-256 小写十六进制。");
  }
}
