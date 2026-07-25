import { realpath as nativeRealpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256CanonicalJson } from "@codegraph/contracts";

export { canonicalizeJson } from "@codegraph/contracts";

/** Git 工作区身份输入；字段集合封闭且可进行 JCS canonicalization。 */
export interface GitWorkspaceIdentityInputV1 {
  kind: "git";
  remoteIdentity: string;
  subroot: string;
  version: 1;
}

/** 无稳定 Git 身份时使用的本地工作区身份输入。 */
export interface LocalWorkspaceIdentityInputV1 {
  kind: "local";
  uri: string;
  version: 1;
}

/** 唯一允许参与 workspace-key 哈希的封闭联合。 */
export type WorkspaceIdentityInputV1 =
  | GitWorkspaceIdentityInputV1
  | LocalWorkspaceIdentityInputV1;

/** 受信任宿主注入的 Git 身份，不允许从 workspace 配置直接读取。 */
export interface TrustedGitIdentity {
  remoteUrl: string;
  repositoryRoot: string;
}

/** 工作区身份派生选项。 */
export interface WorkspaceIdentityOptions {
  gitIdentity?: TrustedGitIdentity | null;
  platform?: NodeJS.Platform;
  realpath?: (input: string) => Promise<string>;
}

/** 工作区身份派生结果。 */
export interface WorkspaceIdentityResult {
  identity: WorkspaceIdentityInputV1;
  indexingRoot: string;
  workspaceKey: string;
}

/** 规范化 Git remote，移除凭据、默认端口、尾随斜杠与 `.git`。 */
export function normalizeGitRemoteIdentity(remoteUrl: string): string {
  const normalizedInput = remoteUrl.trim().normalize("NFC");
  const scpMatch = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(normalizedInput);
  if (scpMatch !== null && !normalizedInput.includes("://")) {
    return formatRemoteIdentity(scpMatch[1] ?? "", scpMatch[2] ?? "", "");
  }

  const parsed = new URL(normalizedInput);
  const defaultPort =
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "http:" && parsed.port === "80") ||
    (parsed.protocol === "ssh:" && parsed.port === "22");
  const port = parsed.port.length > 0 && !defaultPort ? parsed.port : "";
  return formatRemoteIdentity(parsed.hostname, decodeURIComponent(parsed.pathname), port);
}

/**
 * 从 realpath 后的 indexing root 派生唯一工作区身份与 SHA-256 key。
 *
 * Git 发现由受信任宿主注入；缺少稳定 Git 身份时自动使用规范 file URI。
 */
export async function deriveWorkspaceIdentity(
  indexingRoot: string,
  options: WorkspaceIdentityOptions = {},
): Promise<WorkspaceIdentityResult> {
  const resolveRealpath = options.realpath ?? nativeRealpath;
  const resolvedRoot = (await resolveRealpath(indexingRoot)).normalize("NFC");
  let identity: WorkspaceIdentityInputV1;

  if (options.gitIdentity) {
    const repositoryRoot = (
      await resolveRealpath(options.gitIdentity.repositoryRoot)
    ).normalize("NFC");
    const pathApi = selectPathApi(resolvedRoot, options.platform);
    const relative = pathApi.relative(repositoryRoot, resolvedRoot);
    if (
      relative === ".." ||
      relative.startsWith(`..${pathApi.sep}`) ||
      pathApi.isAbsolute(relative)
    ) {
      throw new Error("indexing root 不能逃逸受信任的仓库根目录。");
    }
    identity = {
      kind: "git",
      remoteIdentity: normalizeGitRemoteIdentity(options.gitIdentity.remoteUrl),
      subroot: relative.split(pathApi.sep).join("/").normalize("NFC"),
      version: 1,
    };
  } else {
    identity = {
      kind: "local",
      uri: normalizeLocalFileUri(resolvedRoot, options.platform ?? process.platform),
      version: 1,
    };
  }

  return {
    identity,
    indexingRoot: resolvedRoot,
    workspaceKey: sha256CanonicalJson(identity),
  };
}

/** 格式化不含协议和凭据的 remote 身份。 */
function formatRemoteIdentity(host: string, remotePath: string, port: string): string {
  const normalizedHost = host.toLowerCase().normalize("NFC");
  const normalizedPath = remotePath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .normalize("NFC");
  if (normalizedHost.length === 0 || normalizedPath.length === 0) {
    throw new Error("Git remote 缺少稳定 host 或 path。");
  }
  return `${normalizedHost}${port.length > 0 ? `:${port}` : ""}/${normalizedPath}`;
}

/** 根据注入平台或盘符形状选择路径语义，保证跨平台测试一致。 */
function selectPathApi(input: string, platform?: NodeJS.Platform): typeof path.posix {
  return platform === "win32" || /^[A-Za-z]:[\\/]/.test(input)
    ? path.win32
    : path.posix;
}

/** 将 realpath 结果规范为统一 percent-encoding 的 file URI。 */
function normalizeLocalFileUri(realPath: string, platform: NodeJS.Platform): string {
  if (platform === "win32" || /^[A-Za-z]:[\\/]/.test(realPath)) {
    const normalized = path.win32.normalize(realPath);
    const driveNormalized = normalized.replace(/^([a-z]):/, (_match, drive: string) =>
      `${drive.toUpperCase()}:`,
    );
    return pathToFileURL(driveNormalized.normalize("NFC"), { windows: true }).href;
  }
  return pathToFileURL(realPath.normalize("NFC")).href;
}
