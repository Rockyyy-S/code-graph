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
  type MessageReader,
} from "vscode-jsonrpc/node";
import {
  createErrorV1,
  SERVICE_METHODS,
  type ErrorV1,
  type ServiceEndpointKind,
  validateErrorV1,
  validateInitializeResult,
  validateJsonRpcV2Envelope,
  validateServiceControlRequest,
  validateServiceStatusV1,
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
const DEFAULT_MAX_ACTIVE_CONNECTIONS = 64;
const DEFAULT_SHUTDOWN_ATTEMPT_TIMEOUT_MS = 250;

/** IPC endpoint 绑定参数。 */
export interface CreateBoundIpcEndpointOptions {
  endpoint: string;
  endpointKind: ServiceEndpointKind;
  forceTerminate?: (code: number) => void;
  logger: SafeLocalLogger;
  maxActiveConnections?: number;
  setEndpointPermissions?: (endpoint: string, mode: number) => Promise<void>;
  shutdownAttemptTimeoutMs?: number;
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
  const maxActiveConnections = normalizePositiveInteger(
    options.maxActiveConnections ?? DEFAULT_MAX_ACTIVE_CONNECTIONS,
    "maxActiveConnections",
  );
  const shutdownAttemptTimeoutMs = normalizePositiveInteger(
    options.shutdownAttemptTimeoutMs ?? DEFAULT_SHUTDOWN_ATTEMPT_TIMEOUT_MS,
    "shutdownAttemptTimeoutMs",
  );
  let handshakeContext: HandshakeOpenContext | null = null;
  const connections = new Set<ActiveConnection>();
  const pendingConnections = new Set<PendingConnection>();
  const activateSocket = (socket: net.Socket, context: HandshakeOpenContext): void => {
    if (connections.size >= maxActiveConnections) {
      socket.destroy();
      return;
    }
    let active: ActiveConnection;
    active = createConnectionSession(
      socket,
      context,
      options.logger,
      options.forceTerminate ?? ((code: number): void => process.exit(code)),
      shutdownAttemptTimeoutMs,
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
  shutdownAttemptTimeoutMs: number,
  onClosed: () => void,
): ActiveConnection {
  const guard = new HandshakeGuard({
    sessionToken: context.sessionToken,
    workspaceKey: context.workspaceKey,
  });
  const state = createInitialServiceState(context);
  const input = createBoundedJsonRpcInput(socket, logger, () => guard.initialized);
  const reader = new StreamMessageReader(input);
  /** 服务关闭由握手与 socket deadline 管理，禁用会在 dispose 后续期的诊断 timer。 */
  reader.partialMessageTimeout = 0;
  const writer = new SocketMessageWriter(socket);
  const strictReader = createStrictJsonRpcReader(reader, () => {
    void logger.record({ event: "connection-error", logId: randomUUID() });
    socket.destroy();
  });
  const connection = createMessageConnection(strictReader, writer);
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
  let released = false;
  const releaseConnection = (): void => {
    if (released) {
      return;
    }
    released = true;
    cancelTimeout();
    onClosed();
  };
  let canonicalFailure: ErrorV1 | null = null;

  connection.onRequest((method, params) => {
    if (canonicalFailure !== null) {
      return toResponseError(canonicalFailure);
    }
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
      const result = createInitializeResult(state);
      if (!validateInitializeResult(result)) {
        canonicalFailure = createInvalidCanonicalError();
        scheduleConnectionClose(connection, socket);
        return toResponseError(canonicalFailure);
      }
      return result;
    }

    if (method === SERVICE_METHODS.status) {
      if (!validateServiceControlRequest(params)) {
        return invalidControlRequest();
      }
      const result = state.getStatus();
      if (!validateServiceStatusV1(result)) {
        canonicalFailure = createInvalidCanonicalError();
        scheduleConnectionClose(connection, socket);
        return toResponseError(canonicalFailure);
      }
      return result;
    }
    if (method === SERVICE_METHODS.shutdown) {
      if (!validateServiceControlRequest(params)) {
        return invalidControlRequest();
      }
      const result = { accepted: true } as const;
      if (!validateShutdownResult(result)) {
        return toResponseError(createErrorV1("SERVICE_INVALID_REQUEST", randomUUID()));
      }
      scheduleShutdown(
        context.shutdown,
        logger,
        forceTerminate,
        shutdownAttemptTimeoutMs,
      );
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
  connection.onClose(releaseConnection);
  connection.onDispose(releaseConnection);
  connection.listen();
  return { connection, socket };
}

/** 在服务端分派请求前严格拒绝非 JSON-RPC 2.0 信封。 */
function createStrictJsonRpcReader(
  reader: MessageReader,
  onRejected: () => void,
): MessageReader {
  return {
    dispose: () => reader.dispose(),
    listen: (callback) => reader.listen((message) => {
      if (!validateJsonRpcV2Envelope(message)) {
        onRejected();
        return;
      }
      callback(message);
    }),
    onClose: reader.onClose,
    onError: reader.onError,
    onPartialMessage: reader.onPartialMessage,
  };
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

/** 服务内部生成非法 canonical 响应时创建可在连接关闭前重复返回的终态错误。 */
function createInvalidCanonicalError(): ErrorV1 {
  return createErrorV1(
    "SERVICE_PROTOCOL_INCOMPATIBLE",
    randomUUID(),
    "服务生成的控制面响应不符合协议定义。",
  );
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
  shutdownAttemptTimeoutMs: number,
): void {
  const timeout = setTimeout(() => {
    void runShutdownWithRetries(
      shutdown,
      logger,
      forceTerminate,
      shutdownAttemptTimeoutMs,
    );
  }, 20);
  timeout.unref();
}

/** 捕获并记录 shutdown 清理异常，避免定时回调产生未处理 rejection。 */
async function runShutdownWithRetries(
  shutdown: () => Promise<void>,
  logger: SafeLocalLogger,
  forceTerminate: (code: number) => void,
  shutdownAttemptTimeoutMs: number,
): Promise<void> {
  for (const [index, delayMs] of SHUTDOWN_RETRY_DELAYS_MS.entries()) {
    if (delayMs > 0) {
      await wait(delayMs);
    }
    try {
      await runWithTimeout(shutdown, shutdownAttemptTimeoutMs);
      return;
    } catch (error) {
      await runBestEffortWithTimeout(
        () => logger.record({
          event: "connection-error",
          logId: createHashlessLogId(
            error instanceof Error ? error : new Error("shutdown failed"),
          ),
        }),
        shutdownAttemptTimeoutMs,
      );
      if (index === SHUTDOWN_RETRY_DELAYS_MS.length - 1) {
        forceTerminate(1);
      }
    }
  }
}

/** 为单次 RPC shutdown 清理设置硬界限，使最终强制终止一定可达。 */
async function runWithTimeout(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("RPC shutdown 清理超时。")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** 诊断日志只能 best-effort 写入，不能阻断 shutdown 重试与最终强制终止。 */
async function runBestEffortWithTimeout(
  operation: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  try {
    await runWithTimeout(operation, timeoutMs);
  } catch {
    /** 日志失败或挂起均已被收敛，资源终止路径必须继续。 */
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

/** 收敛内部资源上限配置，拒绝无效或超出 Node timer 范围的值。 */
function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} 必须位于 Node 正整数范围内。`);
  }
  return Math.max(1, Math.floor(value));
}
