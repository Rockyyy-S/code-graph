import { randomUUID } from "node:crypto";
import { isBuiltin } from "node:module";
import {
  buildCompositeGraphPatch,
  buildHierarchyFactBatch,
  buildHierarchyGraphPatch,
  buildModuleSourceFactBatch,
  HIERARCHY_PRODUCER_VERSION,
  AnalyzerFailureError,
  type AnalyzerPort,
  type CanonicalDigestPort,
  type GraphStorePort,
  type StoredIndexSummary,
  type StoredIndexJob,
} from "@codegraph/application";
import {
  createErrorV1,
  SERVICE_ERROR_CODES,
  sha256CanonicalJson,
  type ErrorCategory,
  type ErrorV1,
  type IndexCommitSummaryV1,
  type JobStartRequest,
  type JobStartResult,
  type ServiceErrorCode,
  type ServiceStatusV1,
} from "@codegraph/contracts";
import {
  createInitialIgnoreState,
  type InitialIgnoreState,
} from "./ignore-bootstrap.js";
import {
  createIndexReadSetProvider,
  type IndexReadSetCapture,
  type IndexReadSetProvider,
  WorkspaceIgnoreConfigChangedError,
} from "./index-read-set.js";
import { createServiceState } from "./service-state.js";
import {
  WorkspaceScanCancelledError,
  WorkspaceScanError,
  type ScanWorkspaceOptions,
  type WorkspaceScanResult,
} from "./workspace-scanner.js";
import {
  createAnalyzerSemanticContextCapture,
  type CaptureAnalyzerSemanticContext,
} from "./analyzer-config.js";

/** 显式 Job 预算；当前切片只允许一个实际 writer 并拒绝并发请求。 */
export const MAX_PENDING_EXPLICIT_JOBS = 64;

/** 同一 logical Job 因 stale read-set 最多内部重排三次。 */
export const MAX_STALE_REQUEUE_ATTEMPTS = 3;

/** 启动 read-set 在 watcher 交接竞态下最多尝试八次稳定证明，耗尽后 fail-closed。 */
export const MAX_STARTUP_READ_SET_STABILITY_ATTEMPTS = 8;

/** runtime 单次关闭等待当前扫描结束的默认硬界限。 */
export const DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS = 200;

/** 服务端连接共享的 runtime 边界。 */
export interface GraphServiceRuntime {
  beginShutdown: () => void;
  close: () => Promise<void>;
  getStatus: () => ServiceStatusV1;
  startJob: (request: JobStartRequest) => JobStartResult;
}

/** runtime 初始化参数。 */
export interface CreateIndexJobRuntimeOptions {
  analyzer?: AnalyzerPort;
  captureAnalyzerSemanticContext?: CaptureAnalyzerSemanticContext;
  closeTimeoutMs?: number;
  createJobId?: () => string;
  digestPort?: CanonicalDigestPort;
  ignoreState: InitialIgnoreState;
  indexingRoot: string;
  now?: () => string;
  readSetProvider?: IndexReadSetProvider;
  scan?: (options: ScanWorkspaceOptions) => Promise<WorkspaceScanResult>;
  schedule?: (operation: () => void) => void;
  serviceInstanceId: string;
  statusEpoch: string;
  store: GraphStorePort;
  workspaceKey: string;
}

/** 带稳定 ErrorV1 的服务端业务请求错误。 */
export class GraphServiceRequestError extends Error implements ErrorV1 {
  public readonly category: ErrorCategory;
  public readonly code: ServiceErrorCode;
  public readonly logId: string;
  public readonly retryable: boolean;
  public readonly suggestedAction: string;

  public constructor(error: ErrorV1) {
    super(error.message);
    this.name = "GraphServiceRequestError";
    this.category = error.category;
    this.code = error.code;
    this.logId = error.logId;
    this.retryable = error.retryable;
    this.suggestedAction = error.suggestedAction;
  }

  /** 返回可安全放入 JSON-RPC error.data 的稳定对象。 */
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
 * 生产启动屏障：在开放握手前重新采集持久 revision 的完整 read-set。
 *
 * 离线文件变化没有 watcher 历史事件，因此必须在每个新 service instance 上重新证明 current。
 */
export async function createVerifiedIndexJobRuntime(
  options: CreateIndexJobRuntimeOptions,
): Promise<GraphServiceRuntime> {
  let effectiveOptions = options;
  let readSetProvider = options.readSetProvider ?? createDefaultReadSetProvider(options);
  if (options.readSetProvider === undefined && options.ignoreState.kind === "ready") {
    // watcher 已安装后重做配置屏障，关闭首次检查与监听建立之间的创建竞态。
    const verifiedIgnoreState = await createInitialIgnoreState(options.indexingRoot);
    if (verifiedIgnoreState.kind !== "ready") {
      readSetProvider.close?.();
      effectiveOptions = { ...options, ignoreState: verifiedIgnoreState };
      readSetProvider = createDefaultReadSetProvider(effectiveOptions);
    }
  }
  let startupInvalidated = false;
  readSetProvider.setWorkspaceChangeHandler?.(() => {
    startupInvalidated = true;
    try {
      effectiveOptions.store.markWorkspaceStale();
    } catch {
      /** 启动屏障结束前会再次执行非吞错 stale 持久化。 */
    }
  });
  try {
    const snapshot = effectiveOptions.store.readCommittedSnapshot();
    if (snapshot.graphRevision !== null) {
      if (effectiveOptions.ignoreState.kind !== "ready") {
        startupInvalidated = true;
      } else {
        try {
          const capture = await readSetProvider.capture(snapshot.graphRevision);
          const semanticInputDiffers = hasSemanticInputDifference(snapshot, capture.readSet);
          let startupProofCurrent = false;
          for (
            let attempt = 0;
            attempt < MAX_STARTUP_READ_SET_STABILITY_ATTEMPTS &&
              !startupInvalidated &&
              !semanticInputDiffers;
            attempt += 1
          ) {
            await readSetProvider.awaitPendingRenameVerification?.();
            const fullyCurrent = readSetProvider.isCaptureCurrent === undefined
              ? await readSetProvider.isCurrent(capture.readSet)
              : await readSetProvider.isCaptureCurrent(capture);
            await readSetProvider.awaitPendingRenameVerification?.();
            if (
              !startupInvalidated &&
              fullyCurrent &&
              readSetProvider.isFenceCurrent?.(capture.readSet) !== false
            ) {
              startupProofCurrent = true;
              break;
            }
            /** 让已写入共享序列但尚未送达主线程的 watcher 消息建立 pending/invalidated 状态。 */
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (!startupProofCurrent) {
            startupInvalidated = true;
          }
        } catch {
          // 无法完成启动复核时保留旧 revision，但不得继续宣称 current。
          startupInvalidated = true;
        }
      }
    }
    if (startupInvalidated) {
      effectiveOptions.store.markWorkspaceStale();
    }
    return createIndexJobRuntime({ ...effectiveOptions, readSetProvider });
  } catch (error) {
    readSetProvider.close?.();
    throw error;
  }
}

/** 创建服务实例级共享索引 runtime，并恢复已持久化的 revision/Job 状态。 */
export function createIndexJobRuntime(
  options: CreateIndexJobRuntimeOptions,
): GraphServiceRuntime {
  const persisted = options.store.readBootstrapState();
  const persistedSnapshot = persisted.committed === null
    ? null
    : options.store.readCommittedSnapshot();
  const state = createServiceState({
    committed: persisted.committed === null || persistedSnapshot === null
      ? null
      : mapServiceCommitSummary(persisted.committed, {
          edgeCount: persistedSnapshot.ownedEdges.length,
          nodeCount: persistedSnapshot.ownedNodes.length,
        }),
    completeness: persisted.completeness,
    freshness: persisted.freshness,
    lastJob: mapPersistedTerminalJob(persisted.lastJob),
    serviceInstanceId: options.serviceInstanceId,
    statusEpoch: options.statusEpoch,
  });
  const createJobId = options.createJobId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const schedule = options.schedule ?? ((operation: () => void) => setImmediate(operation));
  const digestPort = options.digestPort ?? { digest: sha256CanonicalJson };
  const readSetProvider = options.readSetProvider ?? createDefaultReadSetProvider(options);
  readSetProvider.setWorkspaceChangeHandler?.(() => {
    // watcher 事件可能发生在无 Job 时；内存和持久状态都要立即失去 current 证明。
    state.publishStale();
    try {
      options.store.markWorkspaceStale();
    } catch {
      /** 内存先 fail closed；持久化故障由下一次 Job/open 屏障继续诊断。 */
    }
  });
  const closeTimeoutMs = normalizeCloseTimeout(
    options.closeTimeoutMs ?? DEFAULT_RUNTIME_CLOSE_TIMEOUT_MS,
  );
  let closing = false;
  let currentRun: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let storeClosed = false;
  let runAbortController: AbortController | null = null;

  /** 在返回 shutdown accepted 前同步关闭 Job 接收门禁。 */
  const beginShutdown = (): void => {
    closing = true;
    runAbortController?.abort();
  };

  /** 执行同一 logical Job 的完整 read-set、patch、复核、CAS 与有界重排。 */
  const runJob = async (
    jobId: string,
    requestedAt: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const startedAt = timestampAtOrAfter(now(), requestedAt);
    let staleObserved = false;
    /** 先锁定内存语义，再持久化；失败终态会用原子 store 操作重试 stale 证据。 */
    const publishStale = (): void => {
      staleObserved = true;
      state.publishStale();
      options.store.markWorkspaceStale();
    };
    try {
      throwIfCancelled(signal);
      state.publishRunningJob(jobId, startedAt);
      options.store.markJobRunning(jobId, startedAt);
      if (options.ignoreState.kind !== "ready") {
        throw new Error("无有效 ignore snapshot 的 Job 不应进入运行阶段。");
      }

      let staleRequeueAttempts = 0;
      while (true) {
        throwIfCancelled(signal);
        const snapshot = options.store.readCommittedSnapshot();
        const capture = await readSetProvider.capture(snapshot.graphRevision, signal);
        if (hasSemanticInputDifference(snapshot, capture.readSet)) {
          publishStale();
        }
        if (capture.scanResult.coverage === "partial") {
          const completedAt = timestampAtOrAfter(now(), startedAt);
          options.store.markJobPartial(jobId, completedAt);
          state.publishPartialJob(jobId, completedAt);
          return;
        }
        const batch = buildHierarchyFactBatch({
          configDigest: capture.readSet.configDigest,
          coverage: "complete",
          inputDigest: capture.readSet.inputDigest,
          manifestDigest: capture.readSet.manifestDigest,
          producerVersion: HIERARCHY_PRODUCER_VERSION,
          relativePaths: capture.readSet.manifest.map((entry) => entry.path),
          workspaceKey: options.workspaceKey,
        });
        const analyzerContext = capture.analyzerContext;
        const moduleBatches = options.analyzer === undefined || analyzerContext === undefined
          ? []
          : await analyzeModuleBatches(
              options.analyzer,
              analyzerContext,
              capture,
              options.workspaceKey,
              startedAt,
              signal,
            );
        const patch = options.analyzer === undefined || analyzerContext === undefined
          ? buildHierarchyGraphPatch({
              batch,
              digestPort,
              readSet: capture.readSet,
              snapshot,
            })
          : buildCompositeGraphPatch({
              digestPort,
              hierarchyBatch: batch,
              moduleBatches,
              readSet: capture.readSet,
              snapshot,
            });
        throwIfCancelled(signal);

        if (!await readSetProvider.isCurrent(capture.readSet, signal)) {
          publishStale();
          staleRequeueAttempts = nextStaleAttempt(staleRequeueAttempts);
          continue;
        }
        if (readSetProvider.isFenceCurrent?.(capture.readSet) === false) {
          publishStale();
          staleRequeueAttempts = nextStaleAttempt(staleRequeueAttempts);
          continue;
        }
        const preparedCommitFence = await readSetProvider.prepareCommitFence(
          capture.readSet,
          signal,
        );
        if (preparedCommitFence === null) {
          publishStale();
          staleRequeueAttempts = nextStaleAttempt(staleRequeueAttempts);
          continue;
        }
        throwIfCancelled(signal);
        const completedAt = timestampAtOrAfter(now(), startedAt);
        const result = options.store.commitAtomicGraphUpdate({
          completedAt,
          expectedSnapshot: snapshot,
          finalReadSetFence: (commitMutation) =>
            readSetProvider.runCommitFence(
              capture.readSet,
              preparedCommitFence,
              commitMutation,
            ),
          jobId,
          patch,
          summary: {
            builtinRulesVersion: "builtin-ignore-v1",
            edgeCount: "targetEdgeCount" in patch ? patch.targetEdgeCount : batch.edges.length,
            excludedPathCount: capture.scanResult.excludedPathCount,
            generatedAt: completedAt,
            indexedFileCount: capture.scanResult.manifest.length,
            nodeCount: "targetNodeCount" in patch ? patch.targetNodeCount : batch.nodes.length,
          },
        });
        if (result.kind === "stale") {
          publishStale();
          staleRequeueAttempts = nextStaleAttempt(staleRequeueAttempts);
          continue;
        }
        state.publishSucceededJob(
          jobId,
          mapServiceCommitSummary(result.summary, {
            edgeCount: batch.edges.length,
            nodeCount: batch.nodes.length,
          }),
        );
        return;
      }
    } catch (error) {
      const completedAt = timestampAtOrAfter(now(), startedAt);
      if (signal.aborted &&
        (error instanceof WorkspaceScanCancelledError || isAbortError(error))) {
        try {
          if (staleObserved) {
            options.store.markJobCancelledAndWorkspaceStale(jobId, completedAt);
          } else {
            options.store.markJobCancelled(jobId, completedAt);
          }
        } catch {
          /** 取消终态的内存可见性不应被附加持久化失败掩盖。 */
        }
        state.publishCancelledJob(jobId, completedAt);
        return;
      }
  const mustPersistStale = staleObserved ||
        error instanceof WorkspaceScanError ||
        error instanceof WorkspaceIgnoreConfigChangedError ||
        isAnalyzerFailure(error);
      if (mustPersistStale) {
        // 扫描失败或已观察差异后，内存状态不得被附加持久化故障恢复为 current。
        state.publishStale();
      }
      const protocolError = mapJobFailure(error);
      try {
        if (mustPersistStale) {
          options.store.markJobFailedAndWorkspaceStale(
            jobId,
            completedAt,
            protocolError.code,
            protocolError.logId,
          );
        } else {
          options.store.markJobFailed(
            jobId,
            completedAt,
            protocolError.code,
            protocolError.logId,
          );
        }
      } catch {
        /** terminal 状态仍需可诊断；原始 SQLite 错误不会被未处理 rejection 泄露。 */
      }
      state.publishFailedJob(jobId, completedAt, protocolError);
    }
  };

  return {
    beginShutdown,
    close: () => {
      beginShutdown();
      if (storeClosed) {
        return Promise.resolve();
      }
      if (closePromise !== null) {
        return closePromise;
      }
      const activeRun = currentRun;
      // 先关闭 watcher，保证 shutdown accepted 后不会再推进 generation 或发布 stale。
      readSetProvider.close?.();
      closePromise = (async () => {
        const analyzerClose = Promise.resolve().then(() => options.analyzer?.close());
        const shutdownTasks = activeRun === null
          ? analyzerClose
          : Promise.all([activeRun, analyzerClose]).then(() => undefined);
        await waitForRunWithinLimit(shutdownTasks, closeTimeoutMs);
        options.store.close();
        storeClosed = true;
      })().finally(() => {
        closePromise = null;
      });
      return closePromise;
    },
    getStatus: state.getStatus,
    startJob: (_request) => {
      if (closing || state.getStatus().currentIndexJob !== null || currentRun !== null) {
        throw new GraphServiceRequestError(
          createErrorV1("INDEX_JOB_ALREADY_RUNNING", randomUUID()),
        );
      }
      const observedNow = now();
      const previousCompletedAt = state.getStatus().lastIndexJob?.completedAt;
      // 跨 Job 也钳制时间，保证 current Job 不会因系统时钟回拨早于上一终态。
      const requestedAt = previousCompletedAt === undefined
        ? observedNow
        : timestampAtOrAfter(observedNow, previousCompletedAt);
      const baseGraphRevision = options.store.readCommittedSnapshot().graphRevision;
      const kind = baseGraphRevision === null ? "initial-index" : "rebuild";
      const job = Object.freeze({
        baseGraphRevision,
        id: createJobId(),
        kind,
        requestedAt,
        resultGraphRevision: null,
        state: "queued" as const,
      });
      state.publishQueuedJob(job);
      try {
        options.store.createJob(job);
      } catch {
        const error = createErrorV1("GRAPH_WRITE_FAILED", randomUUID());
        state.publishFailedJob(job.id, timestampAtOrAfter(now(), requestedAt), error);
        throw new GraphServiceRequestError(error);
      }
      if (options.ignoreState.kind !== "ready") {
        const error = createErrorV1("GRAPH_IGNORE_CONFIG_UNSUPPORTED", randomUUID());
        const completedAt = timestampAtOrAfter(now(), requestedAt);
        try {
          options.store.markJobFailed(job.id, completedAt, error.code, error.logId);
        } catch {
          /** 配置拒绝的内存终态仍需可查询，附加持久化失败不覆盖原始诊断。 */
        }
        state.publishFailedJob(job.id, completedAt, error);
        throw new GraphServiceRequestError(error);
      }
      const controller = new AbortController();
      runAbortController = controller;
      currentRun = new Promise<void>((resolve) => schedule(resolve))
        .then(() => runJob(job.id, requestedAt, controller.signal))
        .finally(() => {
          if (runAbortController === controller) {
            runAbortController = null;
          }
          currentRun = null;
        });
      return { accepted: true, job };
    },
  };
}

/**
 * SQLite 摘要校验全图事实；ServiceStatusV1 v1 则保留 hierarchy 树计数合同。
 *
 * 模块边不能直接复用为公开摘要，否则会破坏 `edgeCount = nodeCount - 1` 的 canonical 不变量。
 */
function mapServiceCommitSummary(
  summary: StoredIndexSummary,
  hierarchyCounts: Pick<IndexCommitSummaryV1, "edgeCount" | "nodeCount">,
): IndexCommitSummaryV1 {
  return {
    ...summary,
    edgeCount: hierarchyCounts.edgeCount,
    nodeCount: hierarchyCounts.nodeCount,
  };
}

/** 在受限 Worker 中分析全部 manifest 源码，并由 application 规范化为 source FactBatch。 */
async function analyzeModuleBatches(
  analyzer: AnalyzerPort,
  context: NonNullable<IndexReadSetCapture["analyzerContext"]>,
  capture: IndexReadSetCapture,
  workspaceKey: string,
  detectedAt: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof buildModuleSourceFactBatch>[]> {
  const output = await analyzer.analyze({
    ...(context.caseSensitiveFileNames === undefined
      ? {}
      : { caseSensitiveFileNames: context.caseSensitiveFileNames }),
    configDigest: context.configDigest,
    configSnapshot: context.configSnapshot,
    configurationEntryPaths: context.configurationEntryPaths,
    configurationFiles: context.configurationFiles,
    detectedAt,
    inputDigest: context.inputDigest,
    resolutionFiles: context.resolutionFiles,
    sourceFiles: context.sourceFiles,
    workspaceKey,
  }, signal);
  const consultedPaths = new Set(context.configSnapshot.consultedFiles.map((file) => file.path));
  if (output.consultedLogicalPaths.some((logicalPath) => !consultedPaths.has(logicalPath))) {
    throw new WorkspaceScanError(
      "GRAPH_SCAN_FAILED",
      "Analyzer 发现了未进入配置封口快照的解析元数据。",
    );
  }
  const sourceIds = new Set(context.sourceFiles.map((file) => file.fileId));
  const resultIds = output.files.map((file) => file.sourceFileId);
  if (
    resultIds.length !== sourceIds.size ||
    new Set(resultIds).size !== resultIds.length ||
    resultIds.some((fileId) => !sourceIds.has(fileId))
  ) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "Analyzer 未返回完整唯一的 source 结果。");
  }
  for (const file of output.files) {
    for (const relation of file.relations) {
      const target = relation.target;
      const invalidInternal = target.kind === "internal-file" && !sourceIds.has(target.id);
      const invalidBuiltin = target.kind === "node-builtin" && (
        target.id !== `node:${target.moduleName}` ||
        target.moduleName.startsWith("node:") ||
        !isBuiltin(target.id)
      );
      if (invalidInternal || invalidBuiltin) {
        throw new AnalyzerFailureError(
          "ANALYZER_PROTOCOL_INVALID",
          "Analyzer 返回了未绑定本轮 manifest 或非规范 Node builtin 的 target。",
        );
      }
    }
  }
  return output.files.map((file) => buildModuleSourceFactBatch({
    analyzerKind: "typescript",
    analyzerVersion: context.configSnapshot.analyzerVersion,
    configDigest: capture.readSet.configDigest,
    coverage: "complete",
    detectedAt,
    diagnostics: file.diagnostics,
    inputDigest: capture.readSet.inputDigest,
    localExportBindings: file.localExportBindings,
    relations: file.relations,
    sourceFileId: file.sourceFileId,
    workspaceKey,
  }));
}

/** 已提交语义 digest 与本次捕获不同即说明旧 revision 不再对应当前输入。 */
function hasSemanticInputDifference(
  snapshot: ReturnType<GraphStorePort["readCommittedSnapshot"]>,
  readSet: IndexReadSetCapture["readSet"],
): boolean {
  const committed = snapshot.committedReadSet;
  return committed !== null && (
    committed.manifestDigest !== readSet.manifestDigest ||
    committed.inputDigest !== readSet.inputDigest ||
    committed.configDigest !== readSet.configDigest ||
    committed.effectiveIgnoreDigest !== readSet.effectiveIgnoreSnapshot.effectiveDigest
  );
}

/** Analyzer 使用标准 AbortError 名称收敛 Worker 取消。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 默认 read-set provider 只在有效 ignore 启动屏障后创建。 */
function createDefaultReadSetProvider(options: CreateIndexJobRuntimeOptions): IndexReadSetProvider {
  if (options.ignoreState.kind !== "ready") {
    return {
      advanceBootstrapGeneration: () => 0,
      capture: async () => {
        throw new Error("无有效 ignore snapshot 时不能采集 read-set。");
      },
      close: () => undefined,
      prepareCommitFence: async () => null,
      runCommitFence: () => false,
      isCurrent: async () => false,
    };
  }
  return createIndexReadSetProvider({
    ...(options.captureAnalyzerSemanticContext !== undefined
      ? { captureAnalyzerSemanticContext: options.captureAnalyzerSemanticContext }
      : options.analyzer === undefined
        ? {}
        : {
            captureAnalyzerSemanticContext: createAnalyzerSemanticContextCapture({
              analyzer: options.analyzer,
              effectiveIgnoreSnapshot: options.ignoreState.snapshot,
              indexingRoot: options.indexingRoot,
              workspaceKey: options.workspaceKey,
            }),
          }),
    ignoreSnapshot: options.ignoreState.snapshot,
    indexingRoot: options.indexingRoot,
    ...(options.scan === undefined ? {} : { scan: options.scan }),
    statusEpoch: options.statusEpoch,
    watchWorkspaceChanges: options.scan === undefined,
  });
}

/** 第四次发现 stale 时结束 logical Job，禁止无限重排。 */
function nextStaleAttempt(current: number): number {
  if (current >= MAX_STALE_REQUEUE_ATTEMPTS) {
    throw new GraphServiceRequestError(
      createErrorV1("GRAPH_INPUT_CHANGED_DURING_BUILD", randomUUID()),
    );
  }
  return current + 1;
}

/** 在事务外安全点把 shutdown AbortSignal 映射为 cancelled。 */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceScanCancelledError("索引 Job 已在安全点取消。");
  }
}

/** 系统时钟回拨时把生命周期时间钳制到前一阶段。 */
function timestampAtOrAfter(candidate: string, floor: string): string {
  const candidateTime = Date.parse(candidate);
  const floorTime = Date.parse(floor);
  if (Number.isFinite(candidateTime) && Number.isFinite(floorTime) && candidateTime < floorTime) {
    return floor;
  }
  return candidate;
}

/** 有界等待当前扫描，超时时保留仍可能被 Job 使用的 store 供后续重试关闭。 */
async function waitForRunWithinLimit(run: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("等待当前索引 Job 结束超时。")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** runtime 关闭界限必须是 Node 定时器可表达的正整数。 */
function normalizeCloseTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("runtime close timeout 必须位于安全定时器范围内。");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/** 将持久化 terminal Job 恢复为公共状态，不接受不完整或未知错误码。 */
function mapPersistedTerminalJob(
  job: StoredIndexJob | null,
): ServiceStatusV1["lastIndexJob"] {
  if (job === null) {
    return null;
  }
  if (job.startedAt === undefined || job.completedAt === undefined) {
    throw new Error("持久化 terminal Job 缺少时间字段。");
  }
  const base = {
    baseGraphRevision: job.baseGraphRevision,
    completedAt: job.completedAt,
    id: job.id,
    kind: job.kind,
    requestedAt: job.requestedAt,
    resultGraphRevision: job.resultGraphRevision,
    startedAt: job.startedAt,
  };
  if (job.state === "succeeded") {
    if (job.resultGraphRevision === null) {
      throw new Error("持久化 succeeded Job 缺少 resultGraphRevision。");
    }
    return { ...base, resultGraphRevision: job.resultGraphRevision, state: "succeeded" };
  }
  if (job.state === "partial" || job.state === "cancelled") {
    return { ...base, state: job.state };
  }
  if (
    job.state !== "failed" ||
    job.errorCode === undefined ||
    job.errorLogId === undefined ||
    !(SERVICE_ERROR_CODES as readonly string[]).includes(job.errorCode)
  ) {
    throw new Error("持久化失败 Job 的错误合同不完整。");
  }
  return {
    ...base,
    error: createErrorV1(job.errorCode as ServiceErrorCode, job.errorLogId),
    state: "failed",
  };
}

/** 将配置、扫描、CAS 与 SQLite 异常收敛为稳定 ErrorV1。 */
function mapJobFailure(error: unknown): ErrorV1 {
  if (error instanceof GraphServiceRequestError) {
    return error.toProtocolError();
  }
  if (error instanceof WorkspaceScanError) {
    return createErrorV1(error.code, randomUUID());
  }
  if (error instanceof WorkspaceIgnoreConfigChangedError) {
    return createErrorV1("GRAPH_IGNORE_CONFIG_UNSUPPORTED", randomUUID());
  }
  if (isAnalyzerFailure(error)) {
    return createErrorV1("GRAPH_SCAN_FAILED", randomUUID());
  }
  return createErrorV1("GRAPH_WRITE_FAILED", randomUUID());
}

/** 跨构建边界按封闭 analyzerCode 识别 AnalyzerFailureError。 */
function isAnalyzerFailure(error: unknown): error is AnalyzerFailureError {
  if (error instanceof AnalyzerFailureError) {return true;}
  if (typeof error !== "object" || error === null || !("analyzerCode" in error)) {return false;}
  const code = (error as { analyzerCode?: unknown }).analyzerCode;
  return code === "ANALYZER_CLOSED" || code === "ANALYZER_EXECUTION_FAILED" ||
    code === "ANALYZER_CONFIG_INVALID" || code === "ANALYZER_METADATA_UNSTABLE" ||
    code === "ANALYZER_PROTOCOL_INVALID" || code === "ANALYZER_RESOURCE_LIMIT" ||
    code === "ANALYZER_TIMEOUT";
}
