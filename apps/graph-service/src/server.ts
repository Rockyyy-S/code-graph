import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import {
  ErrorCodes,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  createErrorV1,
  SERVICE_METHODS,
  type ErrorV1,
  type ServiceEndpointKind,
  validateErrorV1,
} from "@codegraph/contracts";
import { HandshakeGuard } from "./handshake.js";
import {
  type BoundServiceEndpoint,
  type HandshakeOpenContext,
} from "./instance-owner.js";
import { type SafeLocalLogger } from "./safe-log.js";
import { createInitialServiceState, createInitializeResult } from "./service-state.js";

/** IPC endpoint 绑定参数。 */
export interface CreateBoundIpcEndpointOptions {
  endpoint: string;
  endpointKind: ServiceEndpointKind;
  logger: SafeLocalLogger;
}

/** 活跃 JSON-RPC 连接及其底层 socket。 */
interface ActiveConnection {
  connection: MessageConnection;
  socket: net.Socket;
}

/**
 * 绑定 Named Pipe 或 UDS；metadata 发布前到达的连接立即关闭且不返回业务数据。
 *
 * 本函数只调用 `server.listen(endpoint)`，不存在 TCP host/port 或 fallback 分支。
 */
export async function createBoundIpcEndpoint(
  options: CreateBoundIpcEndpointOptions,
): Promise<BoundServiceEndpoint> {
  let handshakeContext: HandshakeOpenContext | null = null;
  const connections = new Set<ActiveConnection>();
  const server = net.createServer((socket) => {
    if (handshakeContext === null) {
      socket.destroy();
      return;
    }
    const active = createConnectionSession(
      socket,
      handshakeContext,
      options.logger,
      () => connections.delete(active),
    );
    connections.add(active);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.endpoint, () => {
      server.off("error", onError);
      resolve();
    });
  });
  if (options.endpointKind === "unix-socket") {
    await chmod(options.endpoint, 0o600);
  }

  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      for (const active of connections) {
        active.connection.dispose();
        active.socket.destroy();
      }
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (options.endpointKind === "unix-socket") {
        await rm(options.endpoint, { force: true });
      }
      await options.logger.close();
    },
    openHandshake: async (context) => {
      handshakeContext = context;
      await options.logger.record({
        event: "service-started",
        logId: randomUUID(),
      });
    },
  };
}

/** 为单条 socket 创建 token-first JSON-RPC 控制面。 */
function createConnectionSession(
  socket: net.Socket,
  context: HandshakeOpenContext,
  logger: SafeLocalLogger,
  onClosed: () => void,
): ActiveConnection {
  const guard = new HandshakeGuard({
    sessionToken: context.sessionToken,
    workspaceKey: context.workspaceKey,
  });
  const state = createInitialServiceState(context);
  const reader = new SocketMessageReader(socket);
  const writer = new SocketMessageWriter(socket);
  const connection = createMessageConnection(reader, writer);
  const cancelTimeout = guard.armTimeout((decision) => {
    if (!decision.accepted) {
      void logger.record({
        code: decision.error.code,
        event: "handshake-rejected",
        logId: decision.error.logId,
      });
    }
    connection.dispose();
    socket.destroy();
  });

  connection.onRequest((method, params) => {
    if (!guard.initialized) {
      const decision = guard.evaluateFirstRequest(method, params);
      if (!decision.accepted) {
        void logger.record({
          code: decision.error.code,
          event: "handshake-rejected",
          logId: decision.error.logId,
        });
        scheduleConnectionClose(connection, socket);
        return toResponseError(decision.error);
      }
      return createInitializeResult(state);
    }

    if (method === SERVICE_METHODS.status) {
      return state.getStatus();
    }
    if (method === SERVICE_METHODS.shutdown) {
      scheduleShutdown(context.shutdown);
      return { accepted: true };
    }

    const error = createErrorV1("SERVICE_METHOD_NOT_FOUND", randomUUID());
    return new ResponseError(ErrorCodes.MethodNotFound, error.message, error);
  });
  connection.onError(([error]) => {
    void logger.record({
      event: "connection-error",
      logId: createHashlessLogId(error),
    });
  });
  connection.onClose(() => {
    cancelTimeout();
    onClosed();
  });
  connection.listen();
  return { connection, socket };
}

/** 将稳定 ErrorV1 放入 JSON-RPC error.data。 */
function toResponseError(error: ErrorV1): ResponseError<ErrorV1> {
  if (!validateErrorV1(error)) {
    const fallback = createErrorV1("SERVICE_INITIALIZE_REQUIRED", randomUUID());
    return new ResponseError(ErrorCodes.InternalError, fallback.message, fallback);
  }
  const responseCode =
    error.code === "SERVICE_INITIALIZE_REQUIRED"
      ? ErrorCodes.ServerNotInitialized
      : ErrorCodes.UnknownErrorCode;
  return new ResponseError(responseCode, error.message, error);
}

/** 给 writer 留出发送错误响应的机会，然后永久关闭失败连接。 */
function scheduleConnectionClose(
  connection: MessageConnection,
  socket: net.Socket,
): void {
  const timeout = setTimeout(() => {
    connection.dispose();
    socket.destroy();
  }, 20);
  timeout.unref();
}

/** 在 shutdown 响应写出后关闭 endpoint 和本次实例资源。 */
function scheduleShutdown(shutdown: () => Promise<void>): void {
  const timeout = setTimeout(() => void shutdown(), 20);
  timeout.unref();
}

/** 连接错误只记录随机关联 ID，不记录原始错误或堆栈。 */
function createHashlessLogId(_error: Error): string {
  return randomUUID();
}
