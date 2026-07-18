import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rm,
  type FileHandle,
} from "node:fs/promises";
import {
  createErrorV1,
  type ErrorCategory,
  type ErrorV1,
  type ServiceEndpointKind,
  type ServiceErrorCode,
  type ServiceMetadataPayloadV1,
  type ServiceMetadataV1,
  validateServiceMetadataV1,
} from "@codegraph/contracts";

/** graph-service 启动所需的受信任路径集合。 */
export interface ServiceInstancePaths {
  endpoint: string;
  endpointKind: ServiceEndpointKind;
  lockPath: string;
  metadataPath: string;
  tokenPath: string;
  workspaceDirectory: string;
  workspaceKey: string;
}

/** endpoint 完成 bind 后、开放握手前获得的实例上下文。 */
export interface HandshakeOpenContext {
  serviceInstanceId: string;
  sessionToken: string;
  statusEpoch: string;
  shutdown: () => Promise<void>;
  workspaceKey: string;
}

/** 已绑定但尚未开放业务握手的 IPC endpoint。 */
export interface BoundServiceEndpoint {
  close: () => Promise<void>;
  openHandshake: (context: HandshakeOpenContext) => Promise<void>;
}

/** 实例启动依赖。 */
export interface BootstrapServiceInstanceOptions {
  bindEndpoint: (
    endpoint: string,
    endpointKind: ServiceEndpointKind,
  ) => Promise<BoundServiceEndpoint>;
  paths: ServiceInstancePaths;
  platform?: NodeJS.Platform;
}

/** 启动完成且持有唯一 writer 所有权的服务实例。 */
export interface OwnedServiceInstance extends HandshakeOpenContext {
  close: () => Promise<void>;
  metadata: ServiceMetadataV1;
}

/** graph-service 对稳定 ErrorV1 的本地启动错误包装。 */
export class GraphServiceStartupError extends Error implements ErrorV1 {
  public readonly category: ErrorCategory;
  public readonly code: ServiceErrorCode;
  public readonly logId: string;
  public readonly retryable: boolean;
  public readonly suggestedAction: string;

  public constructor(error: ErrorV1) {
    super(error.message);
    this.name = "GraphServiceStartupError";
    this.category = error.category;
    this.code = error.code;
    this.logId = error.logId;
    this.retryable = error.retryable;
    this.suggestedAction = error.suggestedAction;
  }

  /** 返回可安全输出到父进程的 ErrorV1，不包含本地堆栈。 */
  public toProtocolError(): ErrorV1 {
    return {
      category: this.category,
      code: this.code,
      logId: this.logId,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
    };
  }
}

/**
 * 以固定顺序启动唯一服务实例：所有权 → token → bind → 身份 → metadata → 握手。
 *
 * Windows 的 Node/libuv 公共 API 无法承诺 current-SID-only Pipe DACL；本实现明确依赖
 * 当前用户缓存 ACL、不可猜 endpoint、32-byte token 与 token-first 握手共同收敛风险，
 * 不对外宣称不存在剩余风险。
 */
export async function bootstrapServiceInstance(
  options: BootstrapServiceInstanceOptions,
): Promise<OwnedServiceInstance> {
  const platform = options.platform ?? process.platform;
  let lockHandle: FileHandle | null = null;
  let tokenHandle: FileHandle | null = null;
  let endpoint: BoundServiceEndpoint | null = null;
  let tokenCreated = false;
  let metadataCreated = false;

  try {
    await mkdir(options.paths.workspaceDirectory, { mode: 0o700, recursive: true });
    if (platform !== "win32") {
      await chmod(options.paths.workspaceDirectory, 0o700);
    }

    lockHandle = await open(options.paths.lockPath, "wx", 0o600);
    tokenHandle = await open(options.paths.tokenPath, "wx", 0o600);
    tokenCreated = true;
    const token = randomBytes(32);
    await tokenHandle.writeFile(token);
    await tokenHandle.sync();
    await tokenHandle.close();
    tokenHandle = null;

    await ensureNoPublishedMetadata(options.paths.metadataPath);
    endpoint = await options.bindEndpoint(
      options.paths.endpoint,
      options.paths.endpointKind,
    );

    const serviceInstanceId = randomUUID();
    const statusEpoch = randomUUID();
    const sessionToken = token.toString("base64url");
    const metadata = await publishMetadata(options.paths, {
      createdAt: new Date().toISOString(),
      endpoint: options.paths.endpoint,
      endpointKind: options.paths.endpointKind,
      pid: process.pid,
      serviceInstanceId,
      statusEpoch,
      version: 1,
      workspaceKey: options.paths.workspaceKey,
    });
    metadataCreated = true;

    let closed = false;
    const closeOwnedResources = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      await endpoint?.close();
      await rm(options.paths.metadataPath, { force: true });
      await rm(options.paths.tokenPath, { force: true });
      await lockHandle?.close();
      await rm(options.paths.lockPath, { force: true });
    };

    await endpoint.openHandshake({
      serviceInstanceId,
      sessionToken,
      shutdown: closeOwnedResources,
      statusEpoch,
      workspaceKey: options.paths.workspaceKey,
    });

    return {
      close: closeOwnedResources,
      metadata,
      serviceInstanceId,
      sessionToken,
      shutdown: closeOwnedResources,
      statusEpoch,
      workspaceKey: options.paths.workspaceKey,
    };
  } catch (error) {
    await tokenHandle?.close();
    await endpoint?.close().catch(() => undefined);
    if (metadataCreated) {
      await rm(options.paths.metadataPath, { force: true });
    }
    if (tokenCreated) {
      await rm(options.paths.tokenPath, { force: true });
    }
    await lockHandle?.close();
    if (lockHandle !== null) {
      await rm(options.paths.lockPath, { force: true });
    }
    if (error instanceof GraphServiceStartupError) {
      throw error;
    }
    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "EADDRINUSE")) {
      throw startupError("SERVICE_INSTANCE_CONFLICT");
    }
    throw startupError("SERVICE_ENDPOINT_START_FAILED");
  }
}

/** 未能同时确认旧实例失效时拒绝回收既有 metadata。 */
async function ensureNoPublishedMetadata(metadataPath: string): Promise<void> {
  try {
    await lstat(metadataPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw startupError("SERVICE_INSTANCE_CONFLICT");
}

/** 原子创建 metadata，禁止覆盖任何疑似旧实例证据。 */
async function publishMetadata(
  paths: ServiceInstancePaths,
  payload: ServiceMetadataPayloadV1,
): Promise<ServiceMetadataV1> {
  const metadata: ServiceMetadataV1 = {
    ...payload,
    integrity: calculateIntegrity(payload),
  };
  if (!validateServiceMetadataV1(metadata)) {
    throw startupError("SERVICE_ENDPOINT_START_FAILED");
  }

  const temporaryPath = `${paths.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, paths.metadataPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  if (process.platform !== "win32") {
    await chmod(paths.metadataPath, 0o600);
  }
  return metadata;
}

/** 对 metadata payload 使用与客户端一致的 JCS 子集和 SHA-256。 */
function calculateIntegrity(payload: ServiceMetadataPayloadV1): string {
  return `sha256:${createHash("sha256")
    .update(canonicalize(payload), "utf8")
    .digest("hex")}`;
}

/** metadata 仅含 JSON 标量对象，按 UTF-16 键序生成确定性表示。 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw startupError("SERVICE_ENDPOINT_START_FAILED");
}

/** 创建不会暴露路径、token 或堆栈的稳定启动错误。 */
function startupError(code: ServiceErrorCode): GraphServiceStartupError {
  return new GraphServiceStartupError(createErrorV1(code, randomUUID()));
}

/** 检查 Node 系统错误码。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
