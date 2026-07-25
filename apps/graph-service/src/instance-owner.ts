import { randomBytes, randomUUID } from "node:crypto";
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
  sha256CanonicalJson,
  type ErrorCategory,
  type ErrorV1,
  type ServiceEndpointKind,
  type ServiceErrorCode,
  type ServiceMetadataPayloadV1,
  type ServiceMetadataV1,
  validateServiceMetadataV1,
} from "@codegraph/contracts";

const BOOTSTRAP_CLEANUP_RETRY_DELAYS_MS = [0, 10, 50] as const;

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
  setMetadataPermissions?: (metadataPath: string, mode: number) => Promise<void>;
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

/** 启动失败且 owned 资源无法完整回收时使用的进程级致命错误。 */
export class GraphServiceFatalCleanupError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "GraphServiceFatalCleanupError";
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
    const metadata = await publishMetadata(
      options.paths,
      {
        createdAt: new Date().toISOString(),
        endpoint: options.paths.endpoint,
        endpointKind: options.paths.endpointKind,
        pid: process.pid,
        serviceInstanceId,
        statusEpoch,
        version: 1,
        workspaceKey: options.paths.workspaceKey,
      },
      platform,
      options.setMetadataPermissions ?? chmod,
      () => {
        metadataCreated = true;
      },
    );

    let endpointClosed = false;
    let metadataRemoved = false;
    let tokenRemoved = false;
    let lockHandleClosed = false;
    let lockRemoved = false;
    let closePromise: Promise<void> | null = null;
    const closeOwnedResources = (): Promise<void> => {
      if (
        endpointClosed &&
        metadataRemoved &&
        tokenRemoved &&
        lockHandleClosed &&
        lockRemoved
      ) {
        return Promise.resolve();
      }
      if (closePromise !== null) {
        return closePromise;
      }
      closePromise = (async () => {
        const errors: unknown[] = [];
        if (!endpointClosed) {
          endpointClosed = await attemptCleanup(() => endpoint?.close(), errors);
        }
        if (!metadataRemoved) {
          metadataRemoved = await attemptCleanup(
            () => rm(options.paths.metadataPath, { force: true }),
            errors,
          );
        }
        if (!tokenRemoved) {
          tokenRemoved = await attemptCleanup(
            () => rm(options.paths.tokenPath, { force: true }),
            errors,
          );
        }
        if (!lockHandleClosed) {
          lockHandleClosed = await attemptCleanup(() => lockHandle?.close(), errors);
        }
        if (
          endpointClosed &&
          metadataRemoved &&
          tokenRemoved &&
          lockHandleClosed &&
          !lockRemoved
        ) {
          lockRemoved = await attemptCleanup(
            () => rm(options.paths.lockPath, { force: true }),
            errors,
          );
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "关闭 graph-service owned 资源时发生错误。");
        }
      })().finally(() => {
        closePromise = null;
      });
      return closePromise;
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
    const cleanupErrors: unknown[] = [];
    let tokenHandleClean = tokenHandle === null;
    let endpointClean = endpoint === null;
    let metadataClean = !metadataCreated;
    let tokenClean = !tokenCreated;
    let lockHandleClean = lockHandle === null;
    let lockClean = lockHandle === null;
    for (const delayMs of BOOTSTRAP_CLEANUP_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await wait(delayMs);
      }
      if (!tokenHandleClean) {
        tokenHandleClean = await attemptCleanup(() => tokenHandle?.close(), cleanupErrors);
      }
      if (!endpointClean) {
        endpointClean = await attemptCleanup(() => endpoint?.close(), cleanupErrors);
      }
      if (!metadataClean) {
        metadataClean = await attemptCleanup(
          () => rm(options.paths.metadataPath, { force: true }),
          cleanupErrors,
        );
      }
      if (!tokenClean) {
        tokenClean = await attemptCleanup(
          () => rm(options.paths.tokenPath, { force: true }),
          cleanupErrors,
        );
      }
      if (!lockHandleClean) {
        lockHandleClean = await attemptCleanup(() => lockHandle?.close(), cleanupErrors);
      }
      if (
        !lockClean &&
        endpointClean &&
        metadataClean &&
        tokenClean &&
        lockHandleClean
      ) {
        lockClean = await attemptCleanup(
          () => rm(options.paths.lockPath, { force: true }),
          cleanupErrors,
        );
      }
      if (
        tokenHandleClean &&
        endpointClean &&
        metadataClean &&
        tokenClean &&
        lockHandleClean &&
        lockClean
      ) {
        break;
      }
    }
    const cleanupComplete =
      tokenHandleClean &&
      endpointClean &&
      metadataClean &&
      tokenClean &&
      lockHandleClean &&
      lockClean;
    if (error instanceof GraphServiceFatalCleanupError) {
      throw error;
    }
    if (!cleanupComplete) {
      throw new GraphServiceFatalCleanupError(
        "graph-service 启动失败且 owned 资源未能完整回收。",
        error,
      );
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
  platform: NodeJS.Platform,
  setMetadataPermissions: (metadataPath: string, mode: number) => Promise<void>,
  onPublished: () => void,
): Promise<ServiceMetadataV1> {
  const metadata: ServiceMetadataV1 = {
    ...payload,
    integrity: calculateIntegrity(payload),
  };
  if (!validateServiceMetadataV1(metadata)) {
    throw startupError("SERVICE_ENDPOINT_START_FAILED");
  }

  const temporaryPath = `${paths.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, paths.metadataPath);
    onPublished();
    if (platform !== "win32") {
      await setMetadataPermissions(paths.metadataPath, 0o600);
    }
    return metadata;
  } finally {
    await handle?.close().catch(() => undefined);
    await removeTemporaryFile(temporaryPath);
  }
}

/** 对 metadata payload 使用与客户端一致的 JCS 子集和 SHA-256。 */
function calculateIntegrity(payload: ServiceMetadataPayloadV1): string {
  return `sha256:${sha256CanonicalJson(payload)}`;
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

/** 执行单个清理步骤并收集错误，使后续 owned 资源仍可继续回收。 */
async function attemptCleanup(
  cleanup: () => Promise<unknown> | undefined,
  errors: unknown[],
): Promise<boolean> {
  try {
    await cleanup();
    return true;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

/** 等待下一次启动失败资源回收重试。 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** 对 metadata 临时文件执行有界重试，覆盖写入或关闭阶段的失败回滚。 */
async function removeTemporaryFile(temporaryPath: string): Promise<void> {
  let lastError: unknown;
  for (const delayMs of BOOTSTRAP_CLEANUP_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await wait(delayMs);
    }
    try {
      await rm(temporaryPath, { force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
