import { randomBytes as nativeRandomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { ServiceEndpointKind } from "@codegraph/contracts";

/** 为 Linux/macOS 共同保留安全余量的 UDS 路径字节上限。 */
export const MAX_UNIX_SOCKET_BYTES = 100;

/** 当前 workspace 的全部受限发现路径。 */
export interface WorkspacePaths {
  endpoint: string;
  endpointKind: ServiceEndpointKind;
  lockPath: string;
  metadataPath: string;
  tokenPath: string;
  workspaceDirectory: string;
  workspaceKey: string;
}

/** endpoint 与缓存路径生成选项。 */
export interface WorkspacePathOptions {
  cacheRoot?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  randomBytes?: (size: number) => Buffer;
}

/**
 * 创建平台本机 IPC endpoint 和发现路径。
 *
 * API 不接受 host/port；Windows 使用随机命名管道，POSIX 使用用户缓存内的 UDS。
 */
export function createWorkspacePaths(
  workspaceKey: string,
  options: WorkspacePathOptions = {},
): WorkspacePaths {
  if (!/^[a-f0-9]{64}$/.test(workspaceKey)) {
    throw new TypeError("workspace-key 必须是 SHA-256 小写十六进制。");
  }
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const cacheRoot =
    options.cacheRoot ?? defaultCacheRoot(platform, options.environment ?? process.env);
  /** 目录名使用 144-bit key 前缀控制 UDS 长度；完整 key 仍由 metadata 校验。 */
  const compactWorkspaceKey = Buffer.from(workspaceKey, "hex")
    .subarray(0, 18)
    .toString("base64url");
  const workspaceDirectory = pathApi.join(
    cacheRoot,
    "codegraph",
    "w",
    compactWorkspaceKey,
  );
  const suffix = (options.randomBytes ?? nativeRandomBytes)(16).toString("hex");
  const endpointKind: ServiceEndpointKind =
    platform === "win32" ? "named-pipe" : "unix-socket";
  const endpoint =
    platform === "win32"
      ? `\\\\.\\pipe\\codegraph-${workspaceKey.slice(0, 16)}-${suffix}`
      : pathApi.join(workspaceDirectory, `s-${suffix.slice(0, 16)}.sock`);

  if (
    endpointKind === "unix-socket" &&
    Buffer.byteLength(endpoint, "utf8") > MAX_UNIX_SOCKET_BYTES
  ) {
    throw new Error("Unix socket path 超出平台安全长度，拒绝启动 fallback transport。");
  }

  return {
    endpoint,
    endpointKind,
    lockPath: pathApi.join(workspaceDirectory, "owner.lock"),
    metadataPath: pathApi.join(workspaceDirectory, "service-metadata.json"),
    tokenPath: pathApi.join(workspaceDirectory, "session-token.bin"),
    workspaceDirectory,
    workspaceKey,
  };
}

/** 返回当前平台的用户级缓存根目录。 */
function defaultCacheRoot(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    return environment.LOCALAPPDATA ?? path.win32.join(homedir(), "AppData", "Local");
  }
  if (platform === "darwin") {
    return path.posix.join(homedir().replaceAll("\\", "/"), "Library", "Caches");
  }
  return environment.XDG_CACHE_HOME ?? path.posix.join(homedir(), ".cache");
}
