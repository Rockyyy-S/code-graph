import { randomUUID } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import net from "node:net";
import { PassThrough } from "node:stream";
import {
  ErrorCodes,
  ResponseError,
  SocketMessageWriter,
  StreamMessageReader,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  createErrorV1,
  SERVICE_METHODS,
  type ErrorV1,
  type ServiceEndpointKind,
  validateErrorV1,
  validateServiceControlRequest,
  validateShutdownResult,
} from "@codegraph/contracts";
import { HandshakeGuard } from "./handshake.js";
import {
  GraphServiceFatalCleanupError,
  type BoundServiceEndpoint,
  type HandshakeOpenContext,
} from "./instance-owner.js";
import { type SafeLocalLogger } from "./safe-log.js";
import { createInitialServiceState, createInitializeResult } from "./service-state.js";

const MAX_JSON_RPC_HEADER_BYTES = 8 * 1024;
const MAX_JSON_RPC_FRAME_BYTES = 1024 * 1024;
const SHUTDOWN_RETRY_DELAYS_MS = [0, 25, 100] as const;

/** IPC endpoint 绑定参数。 */
export interface CreateBoundIpcEndpointOptions {
  endpoint: string;
  endpointKind: ServiceEndpointKind;
  forceTerminate?: (code: number) => void;
  logger: SafeLocalLogger;
  setEndpointPermissions?: (endpoint: string, mode: number) => Promise<void>;
}

/** 活跃 JSON-RPC 连接及其底层 socket。 */
interface ActiveConnection {
  connection: MessageConnection;
  socket: net.Socket;
}

/** metadata 发布与握手开放之间短暂等待的 socket。 */
interface PendingConnection {
  onError: () => void;
  socket: net.Socket;
  timeout: NodeJS.Timeout;
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
  const pendingConnections = new Set<PendingConnection>();
  const activateSocket = (socket: net.Socket, context: HandshakeOpenContext): void => {
    let active: ActiveConnection;
    active = createConnectionSession(
      socket,
      context,
      options.logger,
      options.forceTerminate ?? ((code: number): void => process.exit(code)),
      () => {
        connections.delete(active);
      },
    );
    connections.add(active);
  };
  const server = net.createServer((socket) => {
    if (handshakeContext === null) {
      if (pendingConnections.size >= 16) {
        socket.destroy();
        return;
      }
      const onError = (): void => {
        clearTimeout(pending.timeout);
        pendingConnections.delete(pending);
        socket.destroy();
      };
      const pending: PendingConnection = {
        onError,
        socket,
        timeout: setTimeout(() => {
          pendingConnections.delete(pending);
          socket.destroy();
        }, 1_000),
      };
      socket.once("error", onError);
      pending.timeout.unref();
      pendingConnections.add(pending);
      return;
    }
    activateSocket(socket, handshakeContext);
  });
  let endpointBound = false;

  try {
    await listenOnEndpoint(server, options.endpoint);
    endpointBound = true;
    if (options.endpointKind === "unix-socket") {
      await (options.setEndpointPermissions ?? chmod)(options.endpoint, 0o600);
    }
  } catch (error) {
    await closeFailedBoundServer(
      server,
      options.endpoint,
      options.endpointKind,
      endpointBound,
      error,
    );
    throw error;
  }

  let serverClosed = false;
  let socketRemoved = options.endpointKind !== "unix-socket";
  let loggerClosed = false;
  let closingPromise: Promise<void> | null = null;
  return {
    close: () => {
      if (serverClosed && socketRemoved && loggerClosed) {
        return Promise.resolve();
      }
      if (closingPromise !== null) {
        return closingPromise;
      }
      closingPromise = (async () => {
        const errors: unknown[] = [];
        for (const active of connections) {
          active.connection.dispose();
          active.socket.destroy();
        }
        connections.clear();
        for (const pending of pendingConnections) {
          clearTimeout(pending.timeout);
          pending.socket.off("error", pending.onError);
          pending.socket.destroy();
        }
        pendingConnections.clear();
        if (!serverClosed) {
          try {
            await closeServer(server);
            serverClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (serverClosed && !socketRemoved) {
          try {
            await rm(options.endpoint, { force: true });
            socketRemoved = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (!loggerClosed) {
          try {
            await options.logger.close();
            loggerClosed = true;
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "关闭 IPC endpoint 时发生清理错误。");
        }
      })().finally(() => {
        closingPromise = null;
      });
      return closingPromise;
    },
    openHandshake: async (context) => {
      handshakeContext = context;
      for (const pending of pendingConnections) {
        clearTimeout(pending.timeout);
        pending.socket.off("error", pending.onError);
        pendingConnections.delete(pending);
        if (!pending.socket.destroyed) {
          activateSocket(pending.socket, context);
        }
      }
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
  forceTerminate: (code: number) => void,
  onClosed: () => void,
): ActiveConnection {
  const guard = new HandshakeGuard({
    sessionToken: context.sessionToken,
    workspaceKey: context.workspaceKey,
  });
  const state = createInitialServiceState(context);
  const input = createBoundedJsonRpcInput(socket, logger, () => guard.initialized);
  const reader = new StreamMessageReader(input);
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
      if (!validateServiceControlRequest(params)) {
        return invalidControlRequest();
      }
      return state.getStatus();
    }
    if (method === SERVICE_METHODS.shutdown) {
      if (!validateServiceControlRequest(params)) {
        return invalidControlRequest();
      }
      const result = { accepted: true } as const;
      if (!validateShutdownResult(result)) {
        return toResponseError(createErrorV1("SERVICE_INVALID_REQUEST", randomUUID()));
      }
      scheduleShutdown(context.shutdown, logger, forceTerminate);
      return result;
    }

    const error = createErrorV1("SERVICE_METHOD_NOT_FOUND", randomUUID());
    return new ResponseError(ErrorCodes.MethodNotFound, error.message, error);
  });
  connection.onError(([error]) => {
    void logger.record({
      event: "connection-error",
      logId: createHashlessLogId(error),
    });
    connection.dispose();
    socket.destroy();
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
      : error.code === "SERVICE_INVALID_REQUEST"
        ? ErrorCodes.InvalidParams
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

/** 在 shutdown 响应写出后，以有界重试关闭 endpoint 和本次实例资源。 */
function scheduleShutdown(
  shutdown: () => Promise<void>,
  logger: SafeLocalLogger,
  forceTerminate: (code: number) => void,
): void {
  const timeout = setTimeout(() => {
    void runShutdownWithRetries(shutdown, logger, forceTerminate);
  }, 20);
  timeout.unref();
}

/** 捕获并记录 shutdown 清理异常，避免定时回调产生未处理 rejection。 */
async function runShutdownWithRetries(
  shutdown: () => Promise<void>,
  logger: SafeLocalLogger,
  forceTerminate: (code: number) => void,
): Promise<void> {
  for (const [index, delayMs] of SHUTDOWN_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) {
      await wait(delayMs);
    }
    try {
      await shutdown();
      return;
    } catch (error) {
      await logger.record({
        event: "connection-error",
        logId: createHashlessLogId(error instanceof Error ? error : new Error("shutdown failed")),
      });
      if (index === SHUTDOWN_RETRY_DELAYS_MS.length - 1) {
        forceTerminate(1);
      }
    }
  }
}

/** 等待下一次受控 shutdown 清理重试。 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** 在 reader 前验证并转发有界 JSON-RPC 帧，同时限制认证前只允许一帧。 */
function createBoundedJsonRpcInput(
  socket: net.Socket,
  logger: SafeLocalLogger,
  isInitialized: () => boolean,
): PassThrough {
  const input = new PassThrough({ highWaterMark: 64 * 1024 });
  let pendingHeader = Buffer.alloc(0);
  let remainingBodyBytes = 0;
  let preHandshakeFrameCount = 0;
  let rejected = false;
  const rejectFrame = (): void => {
    if (rejected) {
      return;
    }
    rejected = true;
    void logger.record({ event: "connection-error", logId: randomUUID() });
    input.destroy(new Error("JSON-RPC 输入超过认证前资源界限。"));
    socket.destroy();
  };
  const writeInput = (chunk: Buffer): void => {
    if (!input.write(chunk)) {
      socket.pause();
    }
  };
  const onData = (chunk: Buffer): void => {
    let pending = pendingHeader.byteLength === 0
      ? chunk
      : Buffer.concat([pendingHeader, chunk]);
    pendingHeader = Buffer.alloc(0);
    while (pending.byteLength > 0 && !rejected) {
      if (remainingBodyBytes > 0) {
        const consumed = Math.min(remainingBodyBytes, pending.byteLength);
        writeInput(pending.subarray(0, consumed));
        remainingBodyBytes -= consumed;
        pending = pending.subarray(consumed);
        continue;
      }
      const headerEnd = pending.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (pending.byteLength > MAX_JSON_RPC_HEADER_BYTES) {
          rejectFrame();
          return;
        }
        pendingHeader = Buffer.from(pending);
        return;
      }
      if (headerEnd + 4 > MAX_JSON_RPC_HEADER_BYTES) {
        rejectFrame();
        return;
      }
      const header = pending.subarray(0, headerEnd).toString("ascii");
      const contentLengths = header
        .split("\r\n")
        .filter((line) => /^content-length\s*:/iu.test(line));
      if (contentLengths.length !== 1) {
        rejectFrame();
        return;
      }
      const rawLength = contentLengths[0]!.slice(contentLengths[0]!.indexOf(":") + 1).trim();
      if (!/^\d+$/u.test(rawLength)) {
        rejectFrame();
        return;
      }
      const contentLength = Number(rawLength);
      if (!Number.isSafeInteger(contentLength) || contentLength > MAX_JSON_RPC_FRAME_BYTES) {
        rejectFrame();
        return;
      }
      if (!isInitialized()) {
        preHandshakeFrameCount += 1;
        if (preHandshakeFrameCount > 1) {
          rejectFrame();
          return;
        }
      }
      writeInput(pending.subarray(0, headerEnd + 4));
      remainingBodyBytes = contentLength;
      pending = pending.subarray(headerEnd + 4);
    }
  };
  const onSocketError = (error: Error): void => {
    input.destroy(error);
  };
  const onSocketEnd = (): void => {
    input.end();
  };
  const onSocketClose = (): void => {
    socket.off("data", onData);
    socket.off("error", onSocketError);
    socket.off("end", onSocketEnd);
    if (!input.destroyed) {
      input.end();
    }
  };
  socket.on("data", onData);
  socket.on("error", onSocketError);
  socket.once("end", onSocketEnd);
  socket.once("close", onSocketClose);
  input.on("drain", () => socket.resume());
  return input;
}

/** 连接错误只记录随机关联 ID，不记录原始错误或堆栈。 */
function createHashlessLogId(_error: Error): string {
  return randomUUID();
}

/** 监听指定本机 IPC 字符串 endpoint。 */
async function listenOnEndpoint(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(endpoint, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/** bind 后权限收紧失败时关闭 listener 并移除未发布的 UDS。 */
async function closeFailedBoundServer(
  server: net.Server,
  endpoint: string,
  endpointKind: ServiceEndpointKind,
  endpointBound: boolean,
  originalError: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  await closeServer(server).catch((error: unknown) => cleanupErrors.push(error));
  if (endpointBound && endpointKind === "unix-socket") {
    await rm(endpoint, { force: true }).catch((error: unknown) => cleanupErrors.push(error));
  }
  if (cleanupErrors.length > 0) {
    throw new GraphServiceFatalCleanupError(
      "IPC endpoint 启动失败且 listener/UDS 未能完整回收。",
      new AggregateError([originalError, ...cleanupErrors]),
    );
  }
}

/** 关闭 server；未进入监听态视为已经关闭。 */
async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** 返回包含稳定 ErrorV1 的 JSON-RPC InvalidParams。 */
function invalidControlRequest(): ResponseError<ErrorV1> {
  return toResponseError(createErrorV1("SERVICE_INVALID_REQUEST", randomUUID()));
}
