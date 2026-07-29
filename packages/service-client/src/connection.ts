import net from "node:net";
import { lstat } from "node:fs/promises";
import {
  Message,
  ResponseError,
  SocketMessageWriter,
  StreamMessageReader,
  createMessageConnection,
  type MessageConnection,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc/node";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  SERVICE_METHODS,
  canonicalizeJson,
  type CompatibleInitializeResult,
  type InitializeResult,
  type JobStartResult,
  type ServiceCapability,
  type ServiceMetadataV1,
  type ServiceStatusV1,
  normalizeServiceStatusV1Compatible,
  validateErrorV1,
  validateInitializeResultCompatible,
  validateJsonRpcV2Envelope,
  validateJobStartResultCompatible,
  validateServiceStatusV1Compatible,
  validateShutdownResultCompatible,
} from "@codegraph/contracts";
import {
  connectFirstOrStart,
  type ConnectFirstOrStartOptions,
  type ServiceDiscoveryRecord,
} from "./discovery.js";
import { createWorkspacePaths } from "./endpoint.js";
import { createServiceClientError, ServiceClientError } from "./errors.js";
import { createBoundedJsonRpcInput } from "./bounded-json-rpc-input.js";
import {
  DEFAULT_SERVICE_START_TIMEOUT_MS as LAUNCHER_START_TIMEOUT_MS,
  type GraphServiceLauncher,
} from "./launcher.js";
import {
  deriveWorkspaceIdentity,
  type WorkspaceIdentityOptions,
  type WorkspaceIdentityResult,
} from "./workspace-identity.js";

/** 默认 RPC 界限严格覆盖 SQLite 5 秒 busy timeout 与 IPC 传输余量。 */
export const DEFAULT_SERVICE_REQUEST_TIMEOUT_MS = 10_000;

/** 连接发现与 launcher 共享同一绝对启动预算，禁止内外层默认值漂移。 */
export const DEFAULT_SERVICE_START_TIMEOUT_MS = LAUNCHER_START_TIMEOUT_MS;

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

/** 仓库测试专用的发现边界注入；生产入口始终使用真实文件系统探测。 */
interface ConnectToGraphServiceTestOverrides {
  probeDiscoveryState?: NonNullable<
    ConnectFirstOrStartOptions<unknown>["probeDiscoveryState"]
  >;
}

/** status 传输立即吸收 rejection，等待观测队列时不会产生裸 Promise 拒绝。 */
type StatusRequestOutcome =
  | { kind: "error"; error: unknown }
  | { kind: "value"; value: unknown };

/** 独立客户端连接；关闭连接不会改变共享服务状态。 */
export class GraphServiceConnection {
  readonly #connection: MessageConnection;
  readonly #socket: net.Socket;
  readonly #requestTimeoutMs: number;
  readonly #protocolState: JsonRpcProtocolState;
  #closed = false;
  #latestConfigRevision: number;
  #latestGraphRevision: number | null;
  #latestIndexStatusCanonical: string;
  #latestServiceStatusRevision: number;
  #latestStatusRevision: number;
  #latestStatusCanonical: string;
  #latestViewConfigRevision: number;
  #mustAdvanceIndexStatus = false;
  #queuedControlMutationCount = 0;
  #revisionObservationTail: Promise<void> = Promise.resolve();
  #shutdownPromise: Promise<void> | null = null;
  #terminalError: ServiceClientError | null = null;

  public readonly identity: WorkspaceIdentityResult;
  public readonly initializeResult: InitializeResult;
  public readonly metadata: ServiceMetadataV1;

  public constructor(
    connection: MessageConnection,
    socket: net.Socket,
    initializeResult: InitializeResult,
    identity: WorkspaceIdentityResult,
    metadata: ServiceMetadataV1,
    requestTimeoutMs = DEFAULT_SERVICE_REQUEST_TIMEOUT_MS,
    protocolState: JsonRpcProtocolState = createJsonRpcProtocolState(),
  ) {
    this.#connection = connection;
    this.#socket = socket;
    this.initializeResult = initializeResult;
    this.identity = identity;
    this.metadata = metadata;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#protocolState = protocolState;
    this.#latestConfigRevision = initializeResult.serviceStatus.configRevision;
    this.#latestGraphRevision = initializeResult.serviceStatus.graphRevision;
    this.#latestIndexStatusCanonical = canonicalizeIndexStatus(initializeResult.serviceStatus);
    this.#latestServiceStatusRevision = initializeResult.serviceStatus.serviceStatusRevision;
    this.#latestStatusRevision = initializeResult.serviceStatus.statusRevision;
    this.#latestStatusCanonical = canonicalizeJson(initializeResult.serviceStatus);
    this.#latestViewConfigRevision = initializeResult.serviceStatus.viewConfigRevision;
  }

  /** 读取单一权威 ServiceStatusV1 快照。 */
  public async status(): Promise<ServiceStatusV1> {
    /** 只读 status 可并发发出；若控制变更已排队，则等待其先完成请求与状态栅栏。 */
    const statusRequest = this.#queuedControlMutationCount === 0
      ? this.#sendStatusRequest()
      : null;
    return this.#serializeRevisionObservation(async () => {
      this.#ensureOpen();
      try {
      const outcome = await (statusRequest ?? this.#sendStatusRequest());
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      const result = outcome.value;
      if (!validateServiceStatusV1Compatible(result)) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      if (
        this.initializeResult.capabilities.includes(SERVICE_METHODS.startJob) &&
        !hasExplicitJobStatusFields(result)
      ) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      const normalized = normalizeServiceStatusV1Compatible(result);
      if (normalized === null) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      const normalizedCanonical = canonicalizeJson(normalized);
      const normalizedIndexStatusCanonical = canonicalizeIndexStatus(normalized);
      const childRevisionAdvanced =
        normalized.statusRevision > this.#latestStatusRevision ||
        normalized.configRevision > this.#latestConfigRevision ||
        normalized.viewConfigRevision > this.#latestViewConfigRevision ||
        (normalized.graphRevision !== null &&
          (this.#latestGraphRevision === null ||
            normalized.graphRevision > this.#latestGraphRevision));
      if (
        normalized.serviceInstanceId !== this.initializeResult.serviceStatus.serviceInstanceId ||
        normalized.statusEpoch !== this.initializeResult.serviceStatus.statusEpoch ||
        normalized.serviceStatusRevision < this.#latestServiceStatusRevision ||
        normalized.statusRevision < this.#latestStatusRevision ||
        normalized.configRevision < this.#latestConfigRevision ||
        normalized.viewConfigRevision < this.#latestViewConfigRevision ||
        (this.#mustAdvanceIndexStatus && (
          normalized.statusRevision <= this.#latestStatusRevision ||
          normalizedIndexStatusCanonical === this.#latestIndexStatusCanonical
        )) ||
        (normalized.statusRevision === this.#latestStatusRevision &&
          normalizedIndexStatusCanonical !== this.#latestIndexStatusCanonical) ||
        (normalized.serviceStatusRevision === this.#latestServiceStatusRevision &&
          normalizedCanonical !== this.#latestStatusCanonical) ||
        (childRevisionAdvanced &&
          normalized.serviceStatusRevision <= this.#latestServiceStatusRevision) ||
        (this.#latestGraphRevision !== null &&
          (normalized.graphRevision === null ||
            normalized.graphRevision < this.#latestGraphRevision))
      ) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      this.#latestServiceStatusRevision = normalized.serviceStatusRevision;
      this.#latestStatusRevision = normalized.statusRevision;
      this.#latestConfigRevision = normalized.configRevision;
      this.#latestIndexStatusCanonical = normalizedIndexStatusCanonical;
      this.#latestStatusCanonical = normalizedCanonical;
      this.#latestViewConfigRevision = normalized.viewConfigRevision;
      this.#mustAdvanceIndexStatus = false;
      if (normalized.graphRevision !== null) {
        /** 同一服务实例的已提交 revision 只能单调前进，供后续 Job 响应做时序校验。 */
        this.#latestGraphRevision = normalized.graphRevision;
      }
      return normalized;
      } catch (error) {
        const mapped = this.#protocolState.violated
          ? createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE")
          : mapConnectionError(error);
        if (
          mapped.code === "SERVICE_START_TIMEOUT" ||
          mapped.code === "SERVICE_PROTOCOL_INCOMPATIBLE" ||
          mapped.code === "SERVICE_METHOD_NOT_FOUND"
        ) {
          this.#terminalError = mapped;
          await this.close();
        }
        throw mapped;
      }
    });
  }

  /** 请求公共 rebuild 路径并返回已持久化的 queued Job。 */
  public async startRebuild(): Promise<JobStartResult> {
    this.#queuedControlMutationCount += 1;
    try {
      return await this.#serializeRevisionObservation(async () => {
      this.#ensureOpen();
      /** 未协商的可选能力不代表现有传输损坏，健康旧服务仍可继续提供 status/shutdown。 */
      this.#ensureCapability(SERVICE_METHODS.startJob);
      try {
      const result = await sendRequestWithTimeout<unknown>(
        this.#connection,
        SERVICE_METHODS.startJob,
        { kind: "rebuild" },
        this.#requestTimeoutMs,
      );
      if (!validateJobStartResultCompatible(result)) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      const hasBaseGraphRevision = Object.hasOwn(result.job, "baseGraphRevision");
      /** revisionless v1 只有固定 revision 1；接受响应后不得再发可失败 RPC 猜测 Job 基线。 */
      const baseGraphRevision = hasBaseGraphRevision
        ? result.job.baseGraphRevision
        : (result.job.kind === "initial-index"
          ? null
          : 1);
      const latestGraphRevision = this.#latestGraphRevision;
      if (
        baseGraphRevision === undefined ||
        (result.job.kind === "initial-index" && baseGraphRevision !== null) ||
        (result.job.kind === "initial-index" &&
          latestGraphRevision !== null) ||
        (result.job.kind === "rebuild" &&
          (baseGraphRevision === null ||
            (latestGraphRevision !== null &&
              baseGraphRevision < latestGraphRevision)))
      ) {
        throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
      }
      if (baseGraphRevision !== null) {
        /** 已接受 rebuild 的 base 证明服务至少已提交到该 revision。 */
        this.#latestGraphRevision = baseGraphRevision;
      }
      /** 后续 IndexStatus 必须以前进 revision 的新内容反映已接受的 Job 变更。 */
      this.#mustAdvanceIndexStatus = true;
      return {
        accepted: true,
        job: {
          baseGraphRevision,
          id: result.job.id,
          kind: result.job.kind,
          requestedAt: result.job.requestedAt,
          resultGraphRevision: null,
          state: "queued",
        },
      };
      } catch (error) {
        const mapped = this.#protocolState.violated
          ? createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE")
          : mapConnectionError(error);
        if (
          mapped.code === "SERVICE_START_TIMEOUT" ||
          mapped.code === "SERVICE_PROTOCOL_INCOMPATIBLE" ||
          mapped.code === "SERVICE_METHOD_NOT_FOUND"
        ) {
          this.#terminalError = mapped;
          await this.close();
        }
        throw mapped;
      }
      });
    } finally {
      this.#queuedControlMutationCount -= 1;
    }
  }

  /** 受控关闭共享服务，并关闭当前连接。 */
  public shutdown(): Promise<void> {
    if (this.#shutdownPromise === null) {
      this.#queuedControlMutationCount += 1;
      this.#shutdownPromise = this.#serializeRevisionObservation(async () => {
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
          const mapped = this.#protocolState.violated
            ? createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE")
            : mapConnectionError(error);
          this.#terminalError = mapped;
          throw mapped;
        } finally {
          await this.close();
        }
      }).finally(() => {
        this.#queuedControlMutationCount -= 1;
      });
    }
    return this.#shutdownPromise;
  }

  /** 仅关闭当前客户端连接，不触发共享服务 shutdown。 */
  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#protocolState.pendingResponseIds.clear();
    this.#connection.dispose();
    if (!this.#socket.destroyed) {
      this.#socket.end();
      this.#socket.destroy();
    }
  }

  /** 防止已关闭连接继续发送控制请求。 */
  #ensureOpen(): void {
    if (this.#closed) {
      throw this.#terminalError ?? createServiceClientError(
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

  /** 创建永不裸拒绝的 status outcome，真实错误由观测队列按调用顺序处理。 */
  #sendStatusRequest(): Promise<StatusRequestOutcome> {
    try {
      this.#ensureOpen();
      this.#ensureCapability(SERVICE_METHODS.status);
      return sendRequestWithTimeout<unknown>(
        this.#connection,
        SERVICE_METHODS.status,
        {},
        this.#requestTimeoutMs,
      ).then(
        (value) => ({ kind: "value", value }),
        (error: unknown) => ({ error, kind: "error" }),
      );
    } catch (error) {
      return Promise.resolve({ error, kind: "error" });
    }
  }

  /** 按调用顺序串行化 revision 观测与控制变更，status 传输本身仍可并发。 */
  #serializeRevisionObservation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#revisionObservationTail.then(operation, operation);
    this.#revisionObservationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * 只规范化由 statusRevision 标识的 IndexStatus 子快照。
 * config、view 与 telemetry 拥有独立 revision，不得混入该绑定。
 */
function canonicalizeIndexStatus(status: ServiceStatusV1): string {
  return canonicalizeJson({
    availability: status.availability,
    committed: status.committed,
    completeness: status.completeness,
    currentIndexJob: status.currentIndexJob,
    freshness: status.freshness,
    graphRevision: status.graphRevision,
    lastIndexJob: status.lastIndexJob,
  });
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
  testOverrides: ConnectToGraphServiceTestOverrides = {},
): Promise<GraphServiceConnection> {
  return connectToGraphServiceInternal(options, cacheRoot, testOverrides);
}

/** 仓库传输测试专用入口；绕过 discovery 以注入受控的伪造 endpoint。 */
export async function openServiceConnectionForTests(
  record: ServiceDiscoveryRecord,
  identity: WorkspaceIdentityResult,
  clientVersion: string,
  connectTimeoutMs = 1_000,
  requestTimeoutMs = DEFAULT_SERVICE_REQUEST_TIMEOUT_MS,
): Promise<GraphServiceConnection> {
  return openServiceConnection(
    record,
    identity,
    clientVersion,
    connectTimeoutMs,
    requestTimeoutMs,
  );
}

/** 共享连接实现；可选缓存根仅供仓库内部隔离测试调用。 */
async function connectToGraphServiceInternal(
  options: ConnectToGraphServiceOptions,
  cacheRoot?: string,
  testOverrides?: ConnectToGraphServiceTestOverrides,
): Promise<GraphServiceConnection> {
  if (!options.trust.isTrusted) {
    throw createServiceClientError("SERVICE_WORKSPACE_UNTRUSTED");
  }
  const connectTimeoutMs = normalizeTimeout(
    options.connectTimeoutMs ?? 1_000,
    "connectTimeoutMs",
  );
  const requestTimeoutMs = normalizeTimeout(
    options.requestTimeoutMs ?? DEFAULT_SERVICE_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const startTimeoutMs = normalizeTimeout(
    options.startTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS,
    "startTimeoutMs",
  );
  const pollIntervalMs = normalizeTimeout(
    options.pollIntervalMs ?? 25,
    "pollIntervalMs",
  );
  const deadline = Date.now() + startTimeoutMs;
  const identity = await deriveWorkspaceIdentityWithinDeadline(
    options.indexingRoot,
    options.identityOptions,
    deadline,
  );
  let paths: ReturnType<typeof createWorkspacePaths>;
  let legacyPaths: ReturnType<typeof createWorkspacePaths>;
  try {
    paths = createWorkspacePaths(identity.workspaceKey, {
      ...(cacheRoot === undefined ? {} : { cacheRoot }),
      rootBindingKey: identity.physicalRootKey,
    });
    legacyPaths = createWorkspacePaths(identity.workspaceKey, {
      ...(cacheRoot === undefined ? {} : { cacheRoot }),
    });
  } catch {
    throw createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
  }
  await assertNoLegacyWorkspaceCacheWithinDeadline(paths, legacyPaths, deadline);
  const remainingStartMs = deadline - Date.now();
  if (remainingStartMs <= 0) {
    throw createServiceClientError("SERVICE_START_TIMEOUT");
  }
  return connectFirstOrStart({
    connect: (record, remainingMs, signal) =>
      openServiceConnection(
        record,
        identity,
        options.clientVersion,
        Math.min(connectTimeoutMs, remainingMs),
        Math.min(requestTimeoutMs, remainingMs),
        signal,
      ),
    paths,
    pollIntervalMs,
    ...(testOverrides?.probeDiscoveryState === undefined
      ? {}
      : { probeDiscoveryState: testOverrides.probeDiscoveryState }),
    start: (remainingMs, signal) => options.launcher.start(
      { indexingRoot: identity.indexingRoot, paths },
      remainingMs,
      signal,
    ),
    timeoutMs: remainingStartMs,
  });
}

/**
 * 旧版本只按公共 workspaceKey 建目录，无法证明其缓存属于当前物理根。
 * 任意 legacy 目录都必须 fail closed，避免升级时启动第二个 daemon 或静默遗失旧图谱。
 */
async function assertNoLegacyWorkspaceCache(
  paths: ReturnType<typeof createWorkspacePaths>,
  legacyPaths: ReturnType<typeof createWorkspacePaths>,
): Promise<void> {
  if (paths.workspaceDirectory === legacyPaths.workspaceDirectory) {
    return;
  }
  try {
    await lstat(legacyPaths.workspaceDirectory);
  } catch (error) {
    if (hasSystemErrorCode(error, "ENOENT")) {
      return;
    }
    throw createServiceClientError("SERVICE_INSTANCE_CONFLICT");
  }
  throw createServiceClientError(
    "SERVICE_LEGACY_CACHE_MIGRATION_REQUIRED",
  );
}

/** 将旧缓存探测纳入统一启动 deadline，避免异常文件系统无限阻塞发现流程。 */
async function assertNoLegacyWorkspaceCacheWithinDeadline(
  paths: ReturnType<typeof createWorkspacePaths>,
  legacyPaths: ReturnType<typeof createWorkspacePaths>,
  deadline: number,
): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw createServiceClientError("SERVICE_START_TIMEOUT");
  }
  let timeout: NodeJS.Timeout | undefined;
  const outcome = assertNoLegacyWorkspaceCache(paths, legacyPaths).then(
    () => ({ kind: "value" }) as const,
    (error: unknown) => ({ error, kind: "error" }) as const,
  );
  try {
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      }),
    ]);
    if (result.kind === "timeout") {
      throw createServiceClientError("SERVICE_START_TIMEOUT");
    }
    if (result.kind === "error") {
      throw result.error;
    }
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** 将身份 realpath 纳入公共绝对 deadline，并把本地路径错误收敛为脱敏 ErrorV1。 */
async function deriveWorkspaceIdentityWithinDeadline(
  indexingRoot: string,
  options: WorkspaceIdentityOptions | undefined,
  deadline: number,
): Promise<WorkspaceIdentityResult> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw createServiceClientError("SERVICE_START_TIMEOUT");
  }
  let timeout: NodeJS.Timeout | undefined;
  const outcome = Promise.resolve()
    .then(() => deriveWorkspaceIdentity(indexingRoot, options))
    .then(
      (value) => ({ kind: "value", value }) as const,
      (_error: unknown) => ({ kind: "error" }) as const,
    );
  try {
    const result = await Promise.race([
      outcome,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      }),
    ]);
    if (result.kind === "timeout") {
      throw createServiceClientError("SERVICE_START_TIMEOUT");
    }
    if (result.kind === "error") {
      throw createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
    }
    return result.value;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** 建立真实 IPC 消息连接并完成 initialize。 */
async function openServiceConnection(
  record: ServiceDiscoveryRecord,
  identity: WorkspaceIdentityResult,
  clientVersion: string,
  connectTimeoutMs = 1_000,
  requestTimeoutMs = DEFAULT_SERVICE_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GraphServiceConnection> {
  const socket = net.createConnection(record.metadata.endpoint);
  let connection: MessageConnection | null = null;
  const protocolState = createJsonRpcProtocolState();
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
    const rejectProtocolViolation = (): void => {
      protocolState.violated = true;
      connection?.dispose();
      socket.destroy();
    };
    const input = createBoundedJsonRpcInput(socket, rejectProtocolViolation);
    const reader = new StreamMessageReader(input);
    /** 连接自身已有绝对 deadline，禁用 dispose 后仍会续期的诊断 timer。 */
    reader.partialMessageTimeout = 0;
    reader.onError((error) => {
      /** 普通传输错误保留 retryable 映射；仅解码失败或显式帧拒绝属于协议违规。 */
      if (protocolState.violated || error instanceof SyntaxError) {
        rejectProtocolViolation();
      }
    });
    const strictReader = createStrictJsonRpcReader(
      reader,
      rejectProtocolViolation,
      (message) => {
        const record = message as unknown as Record<string, unknown>;
        if (Object.hasOwn(record, "method")) {
          return false;
        }
        return protocolState.pendingResponseIds.delete(record.id as string | number);
      },
    );
    const writer = createTrackingJsonRpcWriter(
      new SocketMessageWriter(socket),
      protocolState,
    );
    connection = createMessageConnection(
      strictReader,
      writer,
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
      protocolState,
    );
  } catch (error) {
    connection?.dispose();
    socket.destroy();
    if (protocolState.violated) {
      throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
    }
    throw mapConnectionError(error);
  } finally {
    signal?.removeEventListener("abort", abortConnection);
  }
}

/** 客户端消息门禁状态；每个响应必须匹配一个真实在途请求 ID。 */
interface JsonRpcProtocolState {
  pendingResponseIds: Set<string | number>;
  violated: boolean;
}

/** 创建独立连接使用的在途请求 ID 集合与协议违规状态。 */
function createJsonRpcProtocolState(): JsonRpcProtocolState {
  return { pendingResponseIds: new Set<string | number>(), violated: false };
}

/**
 * 在请求写入传输前记录 vscode-jsonrpc 分配的真实 ID。
 * 这样乱序响应按 ID 独立消费预算，错配、重复或无请求响应会被严格 reader 拒绝。
 */
function createTrackingJsonRpcWriter(
  writer: MessageWriter,
  protocolState: JsonRpcProtocolState,
): MessageWriter {
  return {
    dispose: () => writer.dispose(),
    end: () => writer.end(),
    onClose: writer.onClose,
    onError: writer.onError,
    write: async (message) => {
      if (!Message.isRequest(message) || message.id === null) {
        await writer.write(message);
        return;
      }
      protocolState.pendingResponseIds.add(message.id);
      try {
        await writer.write(message);
      } catch (error) {
        protocolState.pendingResponseIds.delete(message.id);
        throw error;
      }
    },
  };
}

/** 在消息进入 vscode-jsonrpc 宽松分派器前验证 JSON-RPC 2.0 信封。 */
function createStrictJsonRpcReader(
  reader: MessageReader,
  onRejected: () => void,
  acceptsMessage: (message: unknown) => boolean = () => true,
): MessageReader {
  return {
    dispose: () => reader.dispose(),
    listen: (callback) => reader.listen((message) => {
      if (!validateJsonRpcV2Envelope(message) || !acceptsMessage(message)) {
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
  if (error instanceof ResponseError) {
    return createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
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
  const serviceStatus = normalizeServiceStatusV1Compatible(result.serviceStatus);
  if (serviceStatus === null) {
    throw createServiceClientError("SERVICE_PROTOCOL_INCOMPATIBLE");
  }
  return { ...result, capabilities, serviceStatus };
}

/** 协商 job/start 后，后续 status 不能省略当前与最后 Job 字段。 */
function hasExplicitJobStatusFields(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "currentIndexJob") &&
    Object.hasOwn(value, "lastIndexJob")
  );
}

/** 判断 capability 是否由当前客户端版本认识。 */
function isKnownCapability(capability: string): capability is ServiceCapability {
  return (SERVICE_CAPABILITIES as readonly string[]).includes(capability);
}

/** 将公共 timeout 收敛为可执行的正有限整数。 */
function normalizeTimeout(timeoutMs: number, name = "timeout"): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`服务连接 ${name} 必须是正有限数。`);
  }
  if (timeoutMs > 2_147_483_647) {
    throw new RangeError(`服务连接 ${name} 超出 Node 定时器范围。`);
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
