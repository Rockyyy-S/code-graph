import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  type ServiceMetadataPayloadV1,
  type ServiceMetadataV1,
  validateServiceMetadataV1,
} from "@codegraph/contracts";
import { canonicalizeJson } from "./workspace-identity.js";
import { createServiceClientError } from "./errors.js";
import type { WorkspacePaths } from "./endpoint.js";

/** metadata 与独立 token 的内部发现结果。 */
export interface ServiceDiscoveryRecord {
  metadata: ServiceMetadataV1;
  sessionToken: string;
}

/** connect-first、按需启动与有界重试选项。 */
export interface ConnectFirstOrStartOptions<T> {
  connect: (record: ServiceDiscoveryRecord) => Promise<T>;
  paths: WorkspacePaths;
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  start: () => Promise<void>;
  timeoutMs?: number;
}

/** 排他所有权句柄；只有持有者可以释放本次 owner.lock。 */
export class WorkspaceOwnership {
  readonly #handle: FileHandle;
  readonly #lockPath: string;
  #released = false;

  public constructor(handle: FileHandle, lockPath: string) {
    this.#handle = handle;
    this.#lockPath = lockPath;
  }

  /** 关闭句柄并删除本实例创建的排他锁。 */
  public async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    await this.#handle.close();
    await rm(this.#lockPath, { force: true });
  }
}

/** 创建并收紧当前 workspace 的用户缓存目录。 */
export async function prepareWorkspaceCache(
  paths: WorkspacePaths,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mkdir(paths.workspaceDirectory, { mode: 0o700, recursive: true });
  if (platform !== "win32") {
    await chmod(paths.workspaceDirectory, 0o700);
  }
}

/** 以 wx/O_EXCL 语义竞争唯一实例所有权，失败时绝不尝试监听。 */
export async function acquireWorkspaceOwnership(
  paths: WorkspacePaths,
): Promise<WorkspaceOwnership> {
  try {
    const handle = await open(paths.lockPath, "wx", 0o600);
    return new WorkspaceOwnership(handle, paths.lockPath);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
    }
    throw createServiceClientError(
      "SERVICE_ENDPOINT_START_FAILED",
      "无法取得本地服务实例所有权。",
    );
  }
}

/** 创建 32-byte 随机 token 并以独占文件存储，不进入 metadata。 */
export async function createSessionToken(paths: WorkspacePaths): Promise<string> {
  const token = randomBytes(32);
  let handle: FileHandle | null = null;
  let tokenCreated = false;
  try {
    handle = await open(paths.tokenPath, "wx", 0o600);
    tokenCreated = true;
    await handle.writeFile(token);
    await handle.sync();
  } catch (error) {
    await handle?.close();
    if (tokenCreated) {
      await rm(paths.tokenPath, { force: true });
    }
    if (hasErrorCode(error, "EEXIST")) {
      throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
    }
    throw createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
  }
  await handle.close();
  return token.toString("base64url");
}

/**
 * 先连接已发布实例，仅在完全没有发现证据时按需启动一次。
 *
 * 启动中竞争只会有界等待胜者；任何缺锁的 token/metadata 均视为疑似 stale，当前
 * Story 绝不回收或启动第二实例。
 */
export async function connectFirstOrStart<T>(
  options: ConnectFirstOrStartOptions<T>,
): Promise<T> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let startAttempted = false;
  let consecutiveStaleObservations = 0;

  while (Date.now() <= deadline) {
    const state = await probeDiscoveryState(options.paths);
    if (state === "ready") {
      consecutiveStaleObservations = 0;
      const record = await readServiceDiscovery(
        options.paths,
        options.paths.workspaceKey,
        platform,
      );
      try {
        return await options.connect(record);
      } catch (error) {
        if (!hasProtocolCode(error, "SERVICE_START_TIMEOUT")) {
          throw error;
        }
        // 已发布 metadata 的实例不能被客户端擅自替换，只允许在界限内重试连接。
      }
    } else if (state === "absent" && !startAttempted) {
      consecutiveStaleObservations = 0;
      startAttempted = true;
      try {
        await options.start();
      } catch (error) {
        if (!hasProtocolCode(error, "SERVICE_INSTANCE_CONFLICT")) {
          throw error;
        }
      }
    } else if (state === "stale") {
      consecutiveStaleObservations += 1;
      if (consecutiveStaleObservations >= 3) {
        throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
      }
    } else {
      consecutiveStaleObservations = 0;
    }

    await wait(pollIntervalMs);
  }
  throw createServiceClientError("SERVICE_START_TIMEOUT");
}

/** 原子发布已绑定 endpoint 的封闭 metadata。 */
export async function publishServiceMetadata(
  paths: WorkspacePaths,
  payload: ServiceMetadataPayloadV1,
): Promise<ServiceMetadataV1> {
  const metadata: ServiceMetadataV1 = {
    ...payload,
    integrity: calculateMetadataIntegrity(payload),
  };
  if (!validateServiceMetadataV1(metadata)) {
    throw createServiceClientError(
      "SERVICE_ENDPOINT_START_FAILED",
      "服务发现 metadata 不符合协议定义。",
    );
  }

  const temporaryPath = `${paths.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, paths.metadataPath);
    if (process.platform !== "win32") {
      await chmod(paths.metadataPath, 0o600);
    }
  } catch {
    await handle?.close();
    await rm(temporaryPath, { force: true });
    throw createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
  }
  return metadata;
}

/** 安全读取 metadata 与独立 token；任何不确定状态都 fail-closed。 */
export async function readServiceDiscovery(
  paths: WorkspacePaths,
  expectedWorkspaceKey: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceDiscoveryRecord> {
  const metadataSource = await readSecureFile(paths.metadataPath, platform);
  const token = await readSecureFile(paths.tokenPath, platform);
  let candidate: unknown;
  try {
    candidate = JSON.parse(metadataSource.toString("utf8"));
  } catch {
    throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
  }
  if (
    !validateServiceMetadataV1(candidate) ||
    candidate.workspaceKey !== expectedWorkspaceKey ||
    !validateEndpointIdentity(candidate, paths, platform) ||
    candidate.integrity !== calculateMetadataIntegrity(withoutIntegrity(candidate)) ||
    token.byteLength !== 32
  ) {
    throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
  }
  return { metadata: candidate, sessionToken: token.toString("base64url") };
}

/** 计算 metadata payload 的稳定 SHA-256 完整性摘要。 */
export function calculateMetadataIntegrity(
  payload: ServiceMetadataPayloadV1,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(payload), "utf8")
    .digest("hex")}`;
}

/** 读取普通、非符号链接且权限安全的文件。 */
async function readSecureFile(
  filePath: string,
  platform: NodeJS.Platform,
): Promise<Buffer> {
  let fileStatus;
  try {
    fileStatus = await lstat(filePath);
  } catch {
    throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
  }
  if (
    fileStatus.isSymbolicLink() ||
    !fileStatus.isFile() ||
    (platform !== "win32" && (fileStatus.mode & 0o077) !== 0)
  ) {
    throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
  }
  return readFile(filePath);
}

/** 校验 metadata endpoint 与当前 workspace、平台和随机命名约束一致。 */
function validateEndpointIdentity(
  metadata: ServiceMetadataV1,
  paths: WorkspacePaths,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") {
    const escapedPrefix = paths.workspaceKey.slice(0, 16);
    return (
      metadata.endpointKind === "named-pipe" &&
      new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\codegraph-${escapedPrefix}-[a-f0-9]{32}$`).test(
        metadata.endpoint,
      )
    );
  }
  return (
    metadata.endpointKind === "unix-socket" &&
    path.dirname(metadata.endpoint) === paths.workspaceDirectory &&
    /^s-[a-f0-9]{16}\.sock$/.test(path.basename(metadata.endpoint))
  );
}

/** 移除完整性字段，恢复摘要覆盖的 payload。 */
function withoutIntegrity(metadata: ServiceMetadataV1): ServiceMetadataPayloadV1 {
  return {
    createdAt: metadata.createdAt,
    endpoint: metadata.endpoint,
    endpointKind: metadata.endpointKind,
    pid: metadata.pid,
    serviceInstanceId: metadata.serviceInstanceId,
    statusEpoch: metadata.statusEpoch,
    version: metadata.version,
    workspaceKey: metadata.workspaceKey,
  };
}

/** 检查 Node 系统错误码，避免散落的宽松类型断言。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** 探测发现文件组合，不读取或删除任何疑似旧实例证据。 */
async function probeDiscoveryState(
  paths: WorkspacePaths,
): Promise<"absent" | "ready" | "stale" | "starting"> {
  const [lockExists, tokenExists, metadataExists] = await Promise.all([
    pathExists(paths.lockPath),
    pathExists(paths.tokenPath),
    pathExists(paths.metadataPath),
  ]);
  if (!lockExists && !tokenExists && !metadataExists) {
    return "absent";
  }
  if (!lockExists && (tokenExists || metadataExists)) {
    return "stale";
  }
  if (lockExists && tokenExists && metadataExists) {
    return "ready";
  }
  return "starting";
}

/** 仅判断路径是否存在；符号链接也算发现证据，后续安全读取会拒绝它。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
  }
}

/** 判断跨包抛出的稳定协议错误码。 */
function hasProtocolCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** 等待下一次有界发现重试。 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
