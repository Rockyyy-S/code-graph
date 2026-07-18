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
  SERVICE_METHODS,
  type InitializeResult,
  type ServiceMetadataV1,
  type ServiceStatusV1,
  validateErrorV1,
  validateInitializeResultCompatible,
  validateServiceStatusV1Compatible,
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
  cacheRoot?: string;
  clientVersion: string;
  connectTimeoutMs?: number;
  identityOptions?: WorkspaceIdentityOptions;
  indexingRoot: string;
  launcher: GraphServiceLauncher;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  trust: WorkspaceTrustGate;
}

/** 独立客户端连接；关闭连接不会改变共享服务状态。 */
export class GraphServiceConnection {
  readonly #connection: MessageConnection;
  readonly #socket: net.Socket;
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
  ) {
    this.#connection = connection;
    this.#socket = socket;
    this.initializeResult = initializeResult;
    this.identity = identity;
    this.metadata = metadata;
  }

  /** 读取单一权威 ServiceStatusV1 快照。 */
  public async status(): Promise<ServiceStatusV1> {
    this.#ensureOpen();
    try {
      const result = await this.#connection.sendRequest<unknown>(
        SERVICE_METHODS.status,
        {},
      );
      if (!validateServiceStatusV1Compatible(result)) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      return result;
    } catch (error) {
      throw mapConnectionError(error);
    }
  }

  /** 受控关闭共享服务，并关闭当前连接。 */
  public async shutdown(): Promise<void> {
    this.#ensureOpen();
    try {
      const result = await this.#connection.sendRequest<unknown>(
        SERVICE_METHODS.shutdown,
        {},
      );
      if (!isAcceptedShutdown(result)) {
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
}

/**
 * 发现、按需启动并初始化每个 indexing root 唯一的 graph-service。
 *
 * trust gate 在 realpath、Git 输入处理和 launcher 之前执行，未受信任工作区无副作用。
 */
export async function connectToGraphService(
  options: ConnectToGraphServiceOptions,
): Promise<GraphServiceConnection> {
  if (!options.trust.isTrusted) {
    throw createServiceClientError("SERVICE_WORKSPACE_UNTRUSTED");
  }
  const identity = await deriveWorkspaceIdentity(
    options.indexingRoot,
    options.identityOptions,
  );
  const paths = createWorkspacePaths(identity.workspaceKey, {
    ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
  });
  return connectFirstOrStart({
    connect: (record) =>
      openServiceConnection(record, identity, options.clientVersion, options.connectTimeoutMs),
    paths,
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    start: () => options.launcher.start(paths),
    ...(options.startTimeoutMs === undefined ? {} : { timeoutMs: options.startTimeoutMs }),
  });
}

/** 建立真实 IPC 消息连接并完成 initialize。 */
async function openServiceConnection(
  record: ServiceDiscoveryRecord,
  identity: WorkspaceIdentityResult,
  clientVersion: string,
  connectTimeoutMs = 1_000,
): Promise<GraphServiceConnection> {
  const socket = net.createConnection(record.metadata.endpoint);
  try {
    await waitForSocketConnection(socket, connectTimeoutMs);
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    );
    connection.listen();
    const result = await connection.sendRequest<unknown>(SERVICE_METHODS.initialize, {
      clientVersion,
      protocolVersion: PROTOCOL_VERSION,
      sessionToken: record.sessionToken,
      supportedSchemaVersions: {
        cli: [CLI_SCHEMA_VERSION],
        graph: [GRAPH_SCHEMA_VERSION],
        rules: [RULES_SCHEMA_VERSION],
      },
      workspaceKey: identity.workspaceKey,
    });
    if (!validateInitializeResultCompatible(result)) {
      connection.dispose();
      socket.destroy();
      throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
    }
    return new GraphServiceConnection(
      connection,
      socket,
      result,
      identity,
      record.metadata,
    );
  } catch (error) {
    socket.destroy();
    throw mapConnectionError(error);
  }
}

/** 有界等待 Named Pipe/UDS 连接建立。 */
async function waitForSocketConnection(
  socket: net.Socket,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(createServiceClientError("SERVICE_START_TIMEOUT"));
    }, timeoutMs);
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

/** 验证最小 shutdown 应答。 */
function isAcceptedShutdown(value: unknown): value is { accepted: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "accepted" in value &&
    value.accepted === true
  );
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
