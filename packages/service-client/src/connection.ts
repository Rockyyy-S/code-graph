import net from "node:net";
import {
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  SERVICE_METHODS,
  type CompatibleInitializeResult,
  type InitializeResult,
  type ServiceCapability,
  type ServiceMetadataV1,
  type ServiceStatusV1,
  validateErrorV1,
  validateInitializeResultCompatible,
  validateServiceStatusV1Compatible,
  validateShutdownResultCompatible,
} from "@codegraph/contracts";
import { connectFirstOrStart, type ServiceDiscoveryRecord } from "./discovery.js";
import { createWorkspacePaths } from "./endpoint.js";
import { createServiceClientError, ServiceClientError } from "./errors.js";
import type { GraphServiceLauncher } from "./launcher.js";
import {
  deriveWorkspaceIdentity,
  type WorkspaceIdentityOptions,
  type WorkspaceIdentityResult,
} from "./workspace-identity.js";

/** 宿主显式提供的 Workspace Trust 门禁。 */
export interface WorkspaceTrustGate {
  isTrusted: boolean;
}

/** 连接共享 graph-service 的公共参数。 */
export interface ConnectToGraphServiceOptions {
  clientVersion: string;
  connectTimeoutMs?: number;
  identityOptions?: WorkspaceIdentityOptions;
  indexingRoot: string;
  launcher: GraphServiceLauncher;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  trust: WorkspaceTrustGate;
}

/** 独立客户端连接；关闭连接不会改变共享服务状态。 */
export class GraphServiceConnection {
  readonly #connection: MessageConnection;
  readonly #socket: net.Socket;
  readonly #requestTimeoutMs: number;
  #closed = false;

  public readonly identity: WorkspaceIdentityResult;
  public readonly initializeResult: InitializeResult;
  public readonly metadata: ServiceMetadataV1;

  public constructor(
    connection: MessageConnection,
    socket: net.Socket,
    initializeResult: InitializeResult,
    identity: WorkspaceIdentityResult,
    metadata: ServiceMetadataV1,
    requestTimeoutMs = 5_000,
  ) {
    this.#connection = connection;
    this.#socket = socket;
    this.initializeResult = initializeResult;
    this.identity = identity;
    this.metadata = metadata;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  /** 读取单一权威 ServiceStatusV1 快照。 */
  public async status(): Promise<ServiceStatusV1> {
    this.#ensureOpen();
    try {
      this.#ensureCapability(SERVICE_METHODS.status);
      const result = await sendRequestWithTimeout<unknown>(
        this.#connection,
        SERVICE_METHODS.status,
        {},
        this.#requestTimeoutMs,
      );
      if (!validateServiceStatusV1Compatible(result)) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      return result;
    } catch (error) {
      const mapped = mapConnectionError(error);
      if (
        mapped.code === "SERVICE_START_TIMEOUT" ||
        mapped.code === "SERVICE_PROTOCOL_INCOMPATIBLE" ||
        mapped.code === "SERVICE_METHOD_NOT_FOUND"
      ) {
        await this.close();
      }
      throw mapped;
    }
  }

  /** 受控关闭共享服务，并关闭当前连接。 */
  public async shutdown(): Promise<void> {
    this.#ensureOpen();
    try {
      this.#ensureCapability(SERVICE_METHODS.shutdown);
      const result = await sendRequestWithTimeout<unknown>(
        this.#connection,
        SERVICE_METHODS.shutdown,
        {},
        this.#requestTimeoutMs,
      );
      if (!validateShutdownResultCompatible(result)) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
    } catch (error) {
      throw mapConnectionError(error);
    } finally {
      await this.close();
    }
  }

  /** 仅关闭当前客户端连接，不触发共享服务 shutdown。 */
  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connection.dispose();
    if (!this.#socket.destroyed) {
      this.#socket.end();
      this.#socket.destroy();
    }
  }

  /** 防止已关闭连接继续发送控制请求。 */
  #ensureOpen(): void {
    if (this.#closed) {
      throw createServiceClientError(
        "SERVICE_START_TIMEOUT",
        "服务连接已经关闭。",
      );
    }
  }

  /** 拒绝调用 initialize 协商结果未声明支持的可选控制方法。 */
  #ensureCapability(capability: ServiceCapability): void {
    if (!this.initializeResult.capabilities.includes(capability)) {
      throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
    }
  }
}

/**
 * 发现、按需启动并初始化每个 indexing root 唯一的 graph-service。
 *
 * trust gate 在 realpath、Git 输入处理和 launcher 之前执行，未受信任工作区无副作用。
 */
export async function connectToGraphService(
  options: ConnectToGraphServiceOptions,
): Promise<GraphServiceConnection> {
  return connectToGraphServiceInternal(options);
}

/** 仓库测试专用缓存根注入；未从包根导出，生产调用始终使用当前用户 OS 缓存。 */
export async function connectToGraphServiceWithCacheRootForTests(
  options: ConnectToGraphServiceOptions,
  cacheRoot: string,
): Promise<GraphServiceConnection> {
  return connectToGraphServiceInternal(options, cacheRoot);
}

/** 共享连接实现；可选缓存根仅供仓库内部隔离测试调用。 */
async function connectToGraphServiceInternal(
  options: ConnectToGraphServiceOptions,
  cacheRoot?: string,
): Promise<GraphServiceConnection> {
  if (!options.trust.isTrusted) {
    throw createServiceClientError("SERVICE_WORKSPACE_UNTRUSTED");
  }
  const identity = await deriveWorkspaceIdentity(
    options.indexingRoot,
    options.identityOptions,
  );
  const paths = createWorkspacePaths(identity.workspaceKey, {
    ...(cacheRoot === undefined ? {} : { cacheRoot }),
  });
  return connectFirstOrStart({
    connect: (record, remainingMs, signal) =>
      openServiceConnection(
        record,
        identity,
        options.clientVersion,
        Math.min(options.connectTimeoutMs ?? 1_000, remainingMs),
        Math.min(options.requestTimeoutMs ?? 5_000, remainingMs),
        signal,
      ),
    paths,
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    start: (remainingMs, signal) => options.launcher.start(paths, remainingMs, signal),
    ...(options.startTimeoutMs === undefined ? {} : { timeoutMs: options.startTimeoutMs }),
  });
}

/** 建立真实 IPC 消息连接并完成 initialize。 */
async function openServiceConnection(
  record: ServiceDiscoveryRecord,
  identity: WorkspaceIdentityResult,
  clientVersion: string,
  connectTimeoutMs = 1_000,
  requestTimeoutMs = 5_000,
  signal?: AbortSignal,
): Promise<GraphServiceConnection> {
  const socket = net.createConnection(record.metadata.endpoint);
  let connection: MessageConnection | null = null;
  const abortConnection = (): void => {
    connection?.dispose();
    socket.destroy();
  };
  signal?.addEventListener("abort", abortConnection, { once: true });
  try {
    if (signal?.aborted === true) {
      throw createServiceClientError("SERVICE_START_TIMEOUT");
    }
    await waitForSocketConnection(socket, connectTimeoutMs);
    connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    );
    connection.listen();
    const result = await sendRequestWithTimeout<unknown>(
      connection,
      SERVICE_METHODS.initialize,
      {
        clientVersion,
        protocolVersion: PROTOCOL_VERSION,
        sessionToken: record.sessionToken,
        supportedSchemaVersions: {
          cli: [CLI_SCHEMA_VERSION],
          graph: [GRAPH_SCHEMA_VERSION],
          rules: [RULES_SCHEMA_VERSION],
        },
        workspaceKey: identity.workspaceKey,
      },
      requestTimeoutMs,
    );
    if (!validateInitializeResultCompatible(result)) {
      connection.dispose();
      socket.destroy();
      throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
    }
    if (
      result.serviceStatus.serviceInstanceId !== record.metadata.serviceInstanceId ||
      result.serviceStatus.statusEpoch !== record.metadata.statusEpoch
    ) {
      connection.dispose();
      socket.destroy();
      throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
    }
    const normalizedResult = normalizeInitializeResult(result);
    return new GraphServiceConnection(
      connection,
      socket,
      normalizedResult,
      identity,
      record.metadata,
      requestTimeoutMs,
    );
  } catch (error) {
    connection?.dispose();
    socket.destroy();
    throw mapConnectionError(error);
  } finally {
    signal?.removeEventListener("abort", abortConnection);
  }
}

/** 有界等待 Named Pipe/UDS 连接建立。 */
async function waitForSocketConnection(
  socket: net.Socket,
  timeoutMs: number,
): Promise<void> {
  const boundedTimeoutMs = normalizeTimeout(timeoutMs);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(createServiceClientError("SERVICE_START_TIMEOUT"));
    }, boundedTimeoutMs);
    timeout.unref();
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

/** 将 JSON-RPC 与系统传输错误映射到稳定 ErrorV1。 */
function mapConnectionError(error: unknown): ServiceClientError {
  if (error instanceof ServiceClientError) {
    return error;
  }
  if (error instanceof ResponseError && validateErrorV1(error.data)) {
    return new ServiceClientError(error.data);
  }
  if (hasSystemErrorCode(error, "EACCES") || hasSystemErrorCode(error, "EPERM")) {
    return createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
  }
  return createServiceClientError("SERVICE_START_TIMEOUT");
}

/** 在本地 deadline 内等待 JSON-RPC 响应。 */
async function sendRequestWithTimeout<T>(
  connection: MessageConnection,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  const boundedTimeoutMs = normalizeTimeout(timeoutMs);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      connection.sendRequest<T>(method, params),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              createServiceClientError("SERVICE_START_TIMEOUT", "等待服务响应超时。"),
            ),
          boundedTimeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** 过滤旧客户端不认识的 capability，保留强类型公共结果。 */
function normalizeInitializeResult(result: CompatibleInitializeResult): InitializeResult {
  const capabilities = result.capabilities.filter(isKnownCapability);
  return { ...result, capabilities };
}

/** 判断 capability 是否由当前客户端版本认识。 */
function isKnownCapability(capability: string): capability is ServiceCapability {
  return (SERVICE_CAPABILITIES as readonly string[]).includes(capability);
}

/** 将公共 timeout 收敛为可执行的正有限整数。 */
function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("服务请求 timeout 必须是正有限数。");
  }
  if (timeoutMs > 2_147_483_647) {
    throw new RangeError("服务请求 timeout 超出 Node 定时器范围。");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/** 检查 Node 系统错误码。 */
function hasSystemErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
