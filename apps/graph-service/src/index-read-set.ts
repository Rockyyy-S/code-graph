import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { sha256CanonicalJson } from "@codegraph/contracts";
import {
  HIERARCHY_PRODUCER_KIND,
  HIERARCHY_PRODUCER_VERSION,
  isSupportedSourceFile,
  normalizeHostPathIdentity,
  normalizeRelativeGraphPath,
  type AnalyzerConfigSnapshotV1,
  type HierarchyReadSetV1,
} from "@codegraph/application";
import {
  isBuiltinIgnoredPath,
  type EffectiveIgnoreSnapshotV1,
} from "./ignore-bootstrap.js";
import {
  isFileSystemCaseSensitive,
  scanWorkspace,
  type ScanWorkspaceOptions,
  verifyWorkspaceReadSetSync,
  WorkspaceScanError,
  type WorkspaceScanResult,
  type WorkspaceVerificationProof,
} from "./workspace-scanner.js";
import {
  ANALYZER_ROOT_METADATA_PATHS,
  prepareAnalyzerConfigFenceSynchronously,
  verifyPreparedAnalyzerConfigFenceSynchronously,
  verifyAnalyzerConfigSnapshotSynchronously,
  type CaptureAnalyzerSemanticContext,
  type PreparedAnalyzerConfigFenceV1,
  type PreparedAnalyzerContextV1,
} from "./analyzer-config.js";

/** eval watcher 与主线程共享同一个纯函数值，避免构建器重写 imported binding 名称。 */
const hostPathIdentity = normalizeHostPathIdentity;

/** 运行期出现用户 ignore 配置后，当前实例无法继续安全解释输入集合。 */
export class WorkspaceIgnoreConfigChangedError extends Error {
  public constructor() {
    super("索引期间检测到 .codegraphignore 配置变化。");
    this.name = "WorkspaceIgnoreConfigChangedError";
  }
}

/** 一次 read-set 捕获同时交付 scanner 事实，避免 application 重新读取文件系统。 */
export interface IndexReadSetCapture {
  analyzerContext?: PreparedAnalyzerContextV1;
  readSet: HierarchyReadSetV1;
  scanResult: WorkspaceScanResult;
}

/** 事务外双重完整扫描生成、供事务内同步身份与成员栅栏消费的稳定输入证明。 */
export interface PreparedCommitFence {
  analyzerVerificationProof: PreparedAnalyzerConfigFenceV1 | null;
  monitorSequence: bigint | null;
  observationDigest: string;
  verificationProof: WorkspaceVerificationProof;
}

/** service-instance 级 hierarchy read-set 边界。 */
export interface IndexReadSetProvider {
  advanceBootstrapGeneration: () => number;
  awaitPendingRenameVerification?: () => Promise<void>;
  capture: (baseGraphRevision: number | null, signal?: AbortSignal) => Promise<IndexReadSetCapture>;
  close?: () => void;
  isCaptureCurrent?: (
    capture: IndexReadSetCapture,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  prepareCommitFence: (
    expected: HierarchyReadSetV1,
    signal?: AbortSignal,
  ) => Promise<PreparedCommitFence | null>;
  runCommitFence: (
    expected: HierarchyReadSetV1,
    prepared: PreparedCommitFence,
    commitMutation: () => void,
  ) => boolean;
  isFenceCurrent?: (expected: HierarchyReadSetV1) => boolean;
  isCurrent: (expected: HierarchyReadSetV1, signal?: AbortSignal) => Promise<boolean>;
  setWorkspaceChangeHandler?: (handler: (() => void) | null) => void;
}

/** 覆盖 provider 生命周期的工作区变化监视器。 */
export interface WorkspaceChangeMonitor {
  close: () => void;
  readHandledSequence?: () => bigint;
  readRawSequence?: () => bigint;
  readSequence?: () => bigint;
  /** 把本次 Analyzer consulted/absent metadata 集合同步注入原生 watcher。 */
  setAnalyzerMetadataPaths?: (
    paths: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void>;
}

/** metadata path 安装 ACK 的默认硬超时。 */
export const DEFAULT_METADATA_PATHS_ACK_TIMEOUT_MS = 5_000;

/** 可注入监视器工厂，测试可以精确触发最终扫描前缀变化。 */
export type CreateWorkspaceChangeMonitor = (
  indexingRoot: string,
  onChange: (relativePath?: string, eventType?: "change" | "rename") => void,
  onError: (error: unknown) => void,
  caseSensitivePaths?: boolean,
) => WorkspaceChangeMonitor;

/**
 * worker 在主线程可能被 SQLite 同步栈阻塞时判定事件是否可能影响 read-set。
 *
 * rename、缺失/非法路径和保留名一律 fail-closed；只有明确 ignored 或非源码 change 可跳过。
 */
export function isPotentialSemanticWorkspaceEvent(
  relativePath: string | undefined,
  eventType: "change" | "rename",
  pathKind?: "directory" | "file",
  analyzerMetadataPaths?: ReadonlySet<string>,
  caseSensitivePaths = true,
): boolean {
  if (eventType === "rename" || relativePath === undefined) {
    return true;
  }
  let normalizedPath: string;
  try {
    normalizedPath = relativePath.replaceAll("\\", "/").normalize("NFC");
    const segments = normalizedPath.split("/");
    if (
      normalizedPath.length === 0 ||
      normalizedPath.startsWith("/") ||
      normalizedPath.endsWith("/") ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      return true;
    }
    if (normalizedPath.toLowerCase() === ".codegraphignore") {
      return true;
    }
    const watcherKey = normalizeWatcherPathKey(normalizedPath, caseSensitivePaths);
    const isDynamicMetadata = analyzerMetadataPaths === undefined
      ? false
      : [...analyzerMetadataPaths].some((entry) =>
        normalizeWatcherPathKey(entry, caseSensitivePaths) === watcherKey);
    if (isAnalyzerMetadataPath(normalizedPath) || isDynamicMetadata) {
      return true;
    }
    const ignoredDirectoryNames = new Set([
      "node_modules",
      ".pnpm",
      "dist",
      "build",
      "out",
      "coverage",
      ".next",
      ".nuxt",
      ".svelte-kit",
      ".turbo",
      ".cache",
      "generated",
      ".generated",
      "__generated__",
    ].map((segment) => hostPathIdentity(segment, caseSensitivePaths)));
    if (
      hostPathIdentity(segments[0] ?? "", caseSensitivePaths) ===
        hostPathIdentity(".git", caseSensitivePaths) ||
      segments.some((segment) => ignoredDirectoryNames.has(
        hostPathIdentity(segment, caseSensitivePaths),
      ))
    ) {
      return false;
    }
    const lowerName = hostPathIdentity(normalizedPath, false);
    if ([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]
      .some((suffix) => lowerName.endsWith(suffix))) {
      return true;
    }
    return pathKind !== "file";
  } catch {
    return true;
  }
}

/** 原生 watcher 在大小写不敏感文件系统上使用同一 NFC case-fold key。 */
function normalizeWatcherPathKey(relativePath: string, caseSensitivePaths: boolean): string {
  return hostPathIdentity(relativePath, caseSensitivePaths);
}

/** read-set provider 构造参数。 */
export interface CreateIndexReadSetProviderOptions {
  caseSensitivePaths?: boolean;
  captureAnalyzerSemanticContext?: CaptureAnalyzerSemanticContext;
  createWorkspaceChangeMonitor?: CreateWorkspaceChangeMonitor;
  ignoreSnapshot: EffectiveIgnoreSnapshotV1;
  indexingRoot: string;
  scan?: (options: ScanWorkspaceOptions) => Promise<WorkspaceScanResult>;
  statusEpoch: string;
  verifyReadSetSync?: (
    expected: HierarchyReadSetV1,
    verificationProof?: WorkspaceVerificationProof,
    forceContentHash?: boolean,
  ) => boolean;
  watchWorkspaceChanges?: boolean;
  workspaceChangeHandler?: () => void;
}

/**
 * 创建实例内单调 bootstrap generation 与完整 hierarchy read-set 采集器。
 *
 * generation 与 base revision 仅用于 CAS；input/config digest 只绑定规范语义输入。
 */
export function createIndexReadSetProvider(
  options: CreateIndexReadSetProviderOptions,
): IndexReadSetProvider {
  const caseSensitivePaths = options.caseSensitivePaths ??
    isFileSystemCaseSensitive(options.indexingRoot);
  if (options.statusEpoch.length === 0) {
    throw new TypeError("read-set statusEpoch 不能为空。");
  }
  const scan = options.scan ?? scanWorkspace;
  let bootstrapGeneration = 0;
  let monitorError: unknown;
  let closed = false;
  let lastCapturedReadSet: HierarchyReadSetV1 | null = null;
  let pendingRenameVerification: Promise<void> | null = null;
  let renameVerificationAbortController: AbortController | null = null;
  let renameVerificationScheduled = false;
  let renameVerificationSuperseded = false;
  let workspaceInvalidated = false;
  let workspaceChangeHandler = options.workspaceChangeHandler ?? null;

  const advanceBootstrapGeneration = (): number => {
    if (bootstrapGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("bootstrap generation 已达到安全整数上限。");
    }
    bootstrapGeneration += 1;
    return bootstrapGeneration;
  };
  const invalidateCurrentProof = (): void => {
    if (closed) {
      return;
    }
    try {
      advanceBootstrapGeneration();
      if (!workspaceInvalidated) {
        workspaceInvalidated = true;
        workspaceChangeHandler?.();
      }
    } catch (error) {
      monitorError = error;
    }
  };
  const verifyReadSetSynchronously = (
    candidate: HierarchyReadSetV1,
    verificationProof: WorkspaceVerificationProof,
    forceContentHash = false,
  ): boolean => (options.verifyReadSetSync ?? ((expected: HierarchyReadSetV1) =>
    verifyWorkspaceReadSetSync({
        expectedManifest: expected.manifest,
        ...(forceContentHash ? { forceContentHash: true } : {}),
        ignoreSnapshot: options.ignoreSnapshot,
        indexingRoot: options.indexingRoot,
        ...(verificationProof === undefined ? {} : {
          verificationProof,
        }),
      })))(candidate, verificationProof, forceContentHash);
  const scheduleAmbiguousRenameVerification = (): void => {
    if (renameVerificationScheduled) {
      renameVerificationSuperseded = true;
      renameVerificationAbortController?.abort();
      invalidateCurrentProof();
      return;
    }
    renameVerificationScheduled = true;
    renameVerificationSuperseded = false;
    const abortController = new AbortController();
    renameVerificationAbortController = abortController;
    pendingRenameVerification = new Promise<void>((resolve) => {
      setImmediate(async () => {
        let mustInvalidate = false;
        try {
          if (closed || lastCapturedReadSet === null) {
            return;
          }
          const expected = lastCapturedReadSet;
          const capturedIgnoreSnapshot = freezeIgnoreSnapshot(options.ignoreSnapshot);
          const result = await scan({
            ignoreSnapshot: capturedIgnoreSnapshot as EffectiveIgnoreSnapshotV1,
            indexingRoot: options.indexingRoot,
            signal: abortController.signal,
          });
          assertMonitorHealthy(monitorError);
          assertNoUserIgnoreConfigSync(options.indexingRoot);
          mustInvalidate = closed ||
            !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot) ||
            result.manifestDigest !== expected.manifestDigest ||
            sha256CanonicalJson(result.manifest) !== sha256CanonicalJson(expected.manifest);
        } catch {
          /** 异步完整扫描无法证明非语义 rename 时按输入变化处理。 */
          mustInvalidate = true;
        } finally {
          if (mustInvalidate && !renameVerificationSuperseded) {
            invalidateCurrentProof();
          }
          renameVerificationScheduled = false;
          renameVerificationSuperseded = false;
          if (renameVerificationAbortController === abortController) {
            renameVerificationAbortController = null;
          }
          pendingRenameVerification = null;
          resolve();
        }
      });
    });
  };
  const handleWorkspaceChange = (
    relativePath?: string,
    eventType?: "change" | "rename",
  ): void => {
    if (closed) {
      return;
    }
    if (relativePath === undefined) {
      monitorError = new Error("工作区变化事件缺少可验证路径。");
      invalidateCurrentProof();
      return;
    }
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRelativeGraphPath(relativePath);
    } catch (error) {
      monitorError = error;
      invalidateCurrentProof();
      return;
    }
    // 保留名按大小写折叠识别，覆盖 Windows/macOS 默认不区分大小写的卷语义。
    if (normalizedPath.toLowerCase() === ".codegraphignore") {
      monitorError = new WorkspaceIgnoreConfigChangedError();
      invalidateCurrentProof();
      return;
    }
    if (isAnalyzerMetadataPath(normalizedPath, lastCapturedReadSet, caseSensitivePaths)) {
      invalidateCurrentProof();
      return;
    }
    if (eventType === "change" || eventType === "rename") {
      try {
        const absolutePath = path.join(options.indexingRoot, relativePath);
        const status = lstatSync(absolutePath);
        const definitelyNonSemantic = isBuiltinIgnoredPath(
          relativePath,
          options.ignoreSnapshot,
        ) || (status.isFile() && !isSupportedSourceFile(relativePath));
        if (definitelyNonSemantic) {
          if (eventType === "change") {
            return;
          }
          // 首个事件异步完整证明；证明期间再次 rename 会中止扫描并直接 fail-closed。
          scheduleAmbiguousRenameVerification();
          return;
        }
      } catch {
        // 对象可能已删除、跨边界移动或被替换；完整下一次 capture 重新建立证明。
      }
    }
    invalidateCurrentProof();
  };
  const monitor = options.watchWorkspaceChanges === true
    ? (options.createWorkspaceChangeMonitor ?? createNativeWorkspaceChangeMonitor)(
        options.indexingRoot,
        handleWorkspaceChange,
        (error) => {
          monitorError = error;
          invalidateCurrentProof();
        },
        caseSensitivePaths,
      )
    : null;

  const captureReadSet = async (
    baseGraphRevision: number | null,
    signal?: AbortSignal,
  ): Promise<IndexReadSetCapture> => {
    assertMonitorHealthy(monitorError);
    assertGraphRevision(baseGraphRevision);
    const capturedBootstrapGeneration = bootstrapGeneration;
    const capturedIgnoreSnapshot = freezeIgnoreSnapshot(options.ignoreSnapshot);
    const scanResult = await scan({
      // scanner 与 read-set 必须消费同一冻结快照，禁止扫描期间的原地配置变化撕裂证据。
      ignoreSnapshot: capturedIgnoreSnapshot as EffectiveIgnoreSnapshotV1,
      indexingRoot: options.indexingRoot,
      ...(signal === undefined ? {} : { signal }),
    });
    assertMonitorHealthy(monitorError);
    const analyzerContext = options.captureAnalyzerSemanticContext === undefined
      ? undefined
      : await options.captureAnalyzerSemanticContext(scanResult, signal);
    if (analyzerContext !== undefined) {
      await monitor?.setAnalyzerMetadataPaths?.([
        ...ANALYZER_ROOT_METADATA_PATHS,
        ...analyzerContext.configSnapshot.consultedFiles.map((file) => file.path),
        ...(analyzerContext.configSnapshot.absentFiles ?? []),
        ...(analyzerContext.configSnapshot.absentResolutionFiles ?? []),
        ...(analyzerContext.configSnapshot.blockedResolutionFiles ?? [])
          .map((file) => file.path),
      ], signal === undefined ? undefined : { signal });
      assertMonitorHealthy(monitorError);
    }
    const configDigest = analyzerContext?.configDigest ?? sha256CanonicalJson({
      ignore: {
        effectiveDigest: capturedIgnoreSnapshot.effectiveDigest,
        version: capturedIgnoreSnapshot.version,
      },
      producer: {
        kind: HIERARCHY_PRODUCER_KIND,
        version: HIERARCHY_PRODUCER_VERSION,
      },
    });
    const inputDigest = analyzerContext?.inputDigest ??
      sha256CanonicalJson({ manifest: scanResult.manifest });
    const readSet: HierarchyReadSetV1 = Object.freeze({
      ...(analyzerContext === undefined ? {} : {
        analyzerConfigSnapshot: analyzerContext.configSnapshot,
      }),
      baseGraphRevision,
      bootstrapGeneration: capturedBootstrapGeneration,
      configDigest,
      effectiveIgnoreSnapshot: capturedIgnoreSnapshot,
      inputDigest,
      manifest: scanResult.manifest,
      manifestDigest: scanResult.manifestDigest,
      statusEpoch: options.statusEpoch,
    });
    lastCapturedReadSet = readSet;
    return Object.freeze({
      ...(analyzerContext === undefined ? {} : { analyzerContext }),
      readSet,
      scanResult,
    });
  };

  const prepareCommitFence = async (
    expected: HierarchyReadSetV1,
    signal?: AbortSignal,
  ): Promise<PreparedCommitFence | null> => {
    assertMonitorHealthy(monitorError);
    const monitorSequence = readStableMonitorSequence(monitor);
    if (monitorSequence === false || renameVerificationScheduled) {
      return null;
    }
    assertNoUserIgnoreConfigSync(options.indexingRoot);
    if (
      closed || !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot) ||
      !isAnalyzerConfigCurrent(options.indexingRoot, expected)
    ) {
      return null;
    }
    const capturedIgnoreSnapshot = freezeIgnoreSnapshot(options.ignoreSnapshot);
    const collect = async (): Promise<{
      observationDigest: string;
      verificationProof: WorkspaceVerificationProof;
    } | null> => {
      const result = await scan({
        ignoreSnapshot: capturedIgnoreSnapshot as EffectiveIgnoreSnapshotV1,
        indexingRoot: options.indexingRoot,
        ...(signal === undefined ? {} : { signal }),
      });
      assertMonitorHealthy(monitorError);
      assertNoUserIgnoreConfigSync(options.indexingRoot);
      if (
        result.verificationProof === undefined ||
        result.manifestDigest !== expected.manifestDigest ||
        sha256CanonicalJson(result.manifest) !== sha256CanonicalJson(expected.manifest) ||
        !isAnalyzerConfigCurrent(options.indexingRoot, expected)
      ) {
        return null;
      }
      return {
        observationDigest: digestWorkspaceVerificationProof(result.verificationProof),
        verificationProof: result.verificationProof,
      };
    };
    const first = await collect();
    if (
      first === null ||
      renameVerificationScheduled ||
      !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot) ||
      !isMonitorSequenceCurrent(monitor, monitorSequence)
    ) {
      return null;
    }
    const second = await collect();
    if (
      second === null ||
      first.observationDigest !== second.observationDigest ||
      renameVerificationScheduled ||
      !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot) ||
      !isMonitorSequenceCurrent(monitor, monitorSequence)
    ) {
      return null;
    }
    const analyzerVerificationProof = prepareAnalyzerFence(options.indexingRoot, expected);
    if (analyzerVerificationProof === false) {return null;}
    return Object.freeze({
      analyzerVerificationProof,
      monitorSequence,
      observationDigest: second.observationDigest,
      verificationProof: second.verificationProof,
    });
  };

  return {
    advanceBootstrapGeneration,
    awaitPendingRenameVerification: async () => {
      while (pendingRenameVerification !== null) {
        await pendingRenameVerification;
      }
    },
    capture: captureReadSet,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      renameVerificationAbortController?.abort();
      monitor?.close();
    },
    prepareCommitFence,
    runCommitFence: (expected, prepared, commitMutation) => {
      assertMonitorHealthy(monitorError);
      assertNoUserIgnoreConfigSync(options.indexingRoot);
      if (
        closed ||
        renameVerificationScheduled ||
        !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot)
      ) {
        return false;
      }
      if (
        digestWorkspaceVerificationProof(prepared.verificationProof) !==
          prepared.observationDigest ||
        !isMonitorSequenceCurrent(monitor, prepared.monitorSequence)
      ) {
        return false;
      }
      // 无独立原生 watcher 时只能用内容 hash 闭合最终 CAS；生产 watcher 路径保持轻量元数据复核。
      const forceContentHash = prepared.monitorSequence === null;
      const verified = verifyReadSetSynchronously(
        expected,
        prepared.verificationProof,
        forceContentHash,
      ) && isPreparedAnalyzerFenceCurrent(
        options.indexingRoot,
        expected,
        prepared.analyzerVerificationProof,
      );
      assertNoUserIgnoreConfigSync(options.indexingRoot);
      if (
        !verified ||
        renameVerificationScheduled ||
        !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot)
      ) {
        return false;
      }
      if (
        renameVerificationScheduled ||
        !isMonitorSequenceCurrent(monitor, prepared.monitorSequence)
      ) {
        return false;
      }
      // 事务外双内容采集绑定字节；事务内只复核身份/成员并依赖独立 watcher 原始序列锁定线性化点。
      commitMutation();
      assertMonitorHealthy(monitorError);
      const postVerified = verifyReadSetSynchronously(
        expected,
        prepared.verificationProof,
        forceContentHash,
      ) && isPreparedAnalyzerFenceCurrent(
        options.indexingRoot,
        expected,
        prepared.analyzerVerificationProof,
      );
      assertNoUserIgnoreConfigSync(options.indexingRoot);
      if (
        !postVerified ||
        renameVerificationScheduled ||
        !isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot)
      ) {
        return false;
      }
      return !renameVerificationScheduled &&
        isMonitorSequenceCurrent(monitor, prepared.monitorSequence);
    },
    isFenceCurrent: (expected) => {
      if (monitorError !== undefined || closed || renameVerificationScheduled) {
        return false;
      }
      const monitorSequence = readStableMonitorSequence(monitor);
      return monitorSequence !== false &&
        monitorError === undefined &&
        isCheapFenceCurrent(expected, bootstrapGeneration, options.ignoreSnapshot) &&
        isAnalyzerConfigCurrent(options.indexingRoot, expected);
    },
    isCaptureCurrent: async (capture) => {
      assertMonitorHealthy(monitorError);
      const proof = capture.scanResult.verificationProof;
      const monitorSequence = readStableMonitorSequence(monitor);
      if (
        proof === undefined ||
        monitorSequence === false ||
        closed ||
        renameVerificationScheduled ||
        !isCheapFenceCurrent(
          capture.readSet,
          bootstrapGeneration,
          options.ignoreSnapshot,
        )
      ) {
        return false;
      }
      assertNoUserIgnoreConfigSync(options.indexingRoot);
      const verified = verifyReadSetSynchronously(
        capture.readSet,
        proof,
        monitorSequence === null,
      );
      assertNoUserIgnoreConfigSync(options.indexingRoot);
      const isCurrent = verified &&
        isAnalyzerConfigCurrent(options.indexingRoot, capture.readSet) &&
        !renameVerificationScheduled &&
        isCheapFenceCurrent(
          capture.readSet,
          bootstrapGeneration,
          options.ignoreSnapshot,
        ) &&
        isMonitorSequenceCurrent(monitor, monitorSequence);
      if (isCurrent) {
        workspaceInvalidated = false;
      }
      return isCurrent;
    },
    isCurrent: async (expected, signal) => {
      const current = await captureReadSet(expected.baseGraphRevision, signal);
      const liveIgnoreSnapshot = freezeIgnoreSnapshot(options.ignoreSnapshot);
      // 扫描完成后再次读取 generation，覆盖最终复核扫描期间发生的配置屏障变化。
      const isCurrent = current.readSet.bootstrapGeneration === bootstrapGeneration &&
        !renameVerificationScheduled &&
        sha256CanonicalJson(current.readSet.effectiveIgnoreSnapshot) ===
          sha256CanonicalJson(liveIgnoreSnapshot) &&
        sha256CanonicalJson(current.readSet) === sha256CanonicalJson(expected);
      if (isCurrent) {
        workspaceInvalidated = false;
      }
      return isCurrent;
    },
    setWorkspaceChangeHandler: (handler) => {
      workspaceChangeHandler = handler;
    },
  };
}

/** 以 CAS 饱和推进共享序列；达到有符号 64 位上限时 fail-closed，禁止回绕。 */
function advanceSharedSequence(state: BigInt64Array, index: number): bigint {
  const maximum = (1n << 63n) - 1n;
  while (true) {
    const current = Atomics.load(state, index);
    if (current === maximum) {
      if (state.length > 3) {
        /** 共享 fatal 位必须先于异步错误消息可见，阻止主线程同步 fence 穿过饱和窗口。 */
        Atomics.store(state, 3, 1n);
        Atomics.notify(state, 3);
      }
      throw new RangeError("工作区变化序列已达到有符号 64 位上限。");
    }
    const next = current + 1n;
    if (Atomics.compareExchange(state, index, current, next) === current) {
      Atomics.notify(state, index);
      return next;
    }
  }
}

/** 默认递归监听在独立 worker 中推进原生序列，避免同步 SQLite 栈延迟事件观察。 */
export function createNativeWorkspaceChangeMonitor(
  indexingRoot: string,
  onChange: (relativePath?: string, eventType?: "change" | "rename") => void,
  onError: (error: unknown) => void,
  caseSensitivePaths = isFileSystemCaseSensitive(indexingRoot),
): WorkspaceChangeMonitor {
  const rootStatus = lstatSync(indexingRoot, { bigint: true });
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区变化监视根不是可信目录。");
  }
  const rootIdentity = { dev: rootStatus.dev, ino: rootStatus.ino };
  const stateBuffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 4);
  const state = new BigInt64Array(stateBuffer);
  let handledSequence = 0n;
  let nextMetadataRequestId = 1;
  const pendingMetadataRequests = new Map<number, {
    onAbort?: () => void;
    reject: (error: unknown) => void;
    resolve: () => void;
    signal?: AbortSignal;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  let closed = false;
  let failureReported = false;
  const settleMetadataRequest = (requestId: number, error?: unknown): void => {
    const pending = pendingMetadataRequests.get(requestId);
    if (pending === undefined) {return;}
    pendingMetadataRequests.delete(requestId);
    clearTimeout(pending.timeout);
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }
    if (error === undefined) {pending.resolve();}
    else {pending.reject(error);}
  };
  const reportFailure = (error: unknown): void => {
    if (closed || failureReported) {
      return;
    }
    Atomics.store(state, 3, 1n);
    Atomics.notify(state, 3);
    failureReported = true;
    for (const requestId of [...pendingMetadataRequests.keys()]) {
      settleMetadataRequest(requestId, error);
    }
    onError(error);
  };
  const assertRootIdentityCurrent = (): void => {
    try {
      const current = lstatSync(indexingRoot, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== rootIdentity.dev ||
        current.ino !== rootIdentity.ino
      ) {
        throw new Error("工作区变化监视根已被删除或替换。");
      }
    } catch (error) {
      if (!failureReported) {
        try {
          advanceSharedSequence(state, 2);
        } catch {
          /** 序列饱和本身已经要求监视器 fail-closed。 */
        }
      }
      reportFailure(error);
    }
  };
  const worker = new Worker(`
    const { watch } = require("node:fs");
    const { lstatSync } = require("node:fs");
    const path = require("node:path");
    const { parentPort, workerData } = require("node:worker_threads");
    const state = new BigInt64Array(workerData.stateBuffer);
    const advanceSharedSequence = (${advanceSharedSequence.toString()});
    const isAnalyzerMetadataPath = (${isAnalyzerMetadataPath.toString()});
    const hostPathIdentity = (${normalizeHostPathIdentity.toString()});
    const normalizeWatcherPathKey = (${normalizeWatcherPathKey.toString()});
    const isPotentialSemanticWorkspaceEvent = (${isPotentialSemanticWorkspaceEvent.toString()});
    let closing = false;
    let analyzerMetadataPaths = new Set();
    const publishError = (error) => {
      Atomics.store(state, 3, 1n);
      Atomics.notify(state, 3);
      parentPort.postMessage({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    };
    process.on("exit", () => {
      if (!closing) {
        Atomics.store(state, 3, 1n);
        Atomics.notify(state, 3);
      }
    });
    try {
      const watcher = watch(
        workerData.indexingRoot,
        { encoding: "utf8", persistent: false, recursive: true },
        (eventType, relativePath) => {
          const normalizedRelativePath = relativePath == null ? undefined : String(relativePath);
          let pathKind;
          if (eventType === "change" && normalizedRelativePath !== undefined) {
            try {
              const normalized = normalizedRelativePath.replaceAll("\\\\", "/").normalize("NFC");
              const segments = normalized.split("/");
              if (
                normalized.length > 0 &&
                !normalized.startsWith("/") &&
                !normalized.endsWith("/") &&
                !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
              ) {
                const absolutePath = path.resolve(workerData.indexingRoot, ...segments);
                const relativeToRoot = path.relative(workerData.indexingRoot, absolutePath);
                if (!relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) {
                  const status = lstatSync(absolutePath);
                  pathKind = status.isFile() ? "file" : status.isDirectory() ? "directory" : undefined;
                }
              }
            } catch {
              pathKind = undefined;
            }
          }
          let sequence;
          try {
            advanceSharedSequence(state, 1);
            sequence = isPotentialSemanticWorkspaceEvent(
              normalizedRelativePath,
              eventType,
              pathKind,
              analyzerMetadataPaths,
              workerData.caseSensitivePaths,
            )
              ? advanceSharedSequence(state, 2)
              : Atomics.load(state, 2);
          } catch (error) {
            publishError(error);
            return;
          }
          parentPort.postMessage({
            eventType,
            kind: "change",
            relativePath: normalizedRelativePath ?? null,
            sequence,
          });
        },
      );
      watcher.on("error", (error) => {
        try {
          advanceSharedSequence(state, 2);
        } catch {
          /** publishError 仍会让主线程永久 fail-closed。 */
        }
        publishError(error);
      });
      watcher.on("close", () => {
        if (!closing) {
          try {
            advanceSharedSequence(state, 2);
          } catch {
            /** publishError 仍会让主线程永久 fail-closed。 */
          }
          publishError(new Error("workspace watcher closed unexpectedly"));
        }
      });
      parentPort.on("message", (message) => {
        if (message === "close") {
          closing = true;
          watcher.close();
          parentPort.close();
        } else if (message && message.kind === "metadata-paths" &&
          Number.isSafeInteger(message.requestId) && Array.isArray(message.paths) &&
          message.paths.every((entry) => typeof entry === "string")) {
          const next = new Set(message.paths.map((entry) =>
            normalizeWatcherPathKey(entry, workerData.caseSensitivePaths)));
          const changed = next.size !== analyzerMetadataPaths.size ||
            [...next].some((entry) => !analyzerMetadataPaths.has(entry));
          analyzerMetadataPaths = next;
          let sequence = Atomics.load(state, 2);
          if (changed) {sequence = advanceSharedSequence(state, 2);}
          parentPort.postMessage({ kind: "metadata-paths-applied", requestId: message.requestId, sequence });
        }
      });
      Atomics.store(state, 0, 1n);
      Atomics.notify(state, 0);
    } catch (error) {
      Atomics.store(state, 0, -1n);
      Atomics.notify(state, 0);
      publishError(error);
    }
  `, {
    eval: true,
    workerData: {
      caseSensitivePaths,
      indexingRoot,
      stateBuffer,
    },
  });
  const ready = Atomics.load(state, 0) === 0n
    ? Atomics.wait(state, 0, 0n, 5_000)
    : "not-equal";
  if (ready === "timed-out" || Atomics.load(state, 0) !== 1n) {
    void worker.terminate();
    throw new Error("工作区变化 worker 未能在时限内建立监听。");
  }
  worker.on("message", (message: unknown) => {
    if (closed || typeof message !== "object" || message === null || !("kind" in message)) {
      return;
    }
    if (message.kind === "error") {
      reportFailure(new Error("工作区变化 worker 监听失败。"));
      return;
    }
    if (
      message.kind === "metadata-paths-applied" && "requestId" in message &&
      Number.isSafeInteger(message.requestId) && "sequence" in message &&
      typeof message.sequence === "bigint"
    ) {
      const requestId = message.requestId as number;
      const pending = pendingMetadataRequests.get(requestId);
      if (pending !== undefined) {
        if (message.sequence > handledSequence) {handledSequence = message.sequence;}
        settleMetadataRequest(requestId);
      }
      return;
    }
    if (
      message.kind === "change" &&
      "sequence" in message &&
      typeof message.sequence === "bigint" &&
      "eventType" in message &&
      (message.eventType === "change" || message.eventType === "rename")
    ) {
      const relativePath = "relativePath" in message && typeof message.relativePath === "string"
        ? message.relativePath
        : undefined;
      onChange(relativePath, message.eventType);
      if (message.sequence > handledSequence) {
        handledSequence = message.sequence;
      }
    }
  });
  worker.on("error", reportFailure);
  worker.on("exit", (code) => {
    if (!closed) {
      try {
        advanceSharedSequence(state, 2);
      } catch {
        /** worker 退出本身已经要求监视器 fail-closed。 */
      }
      reportFailure(new Error(`工作区变化 worker 意外退出，code=${code}。`));
    }
  });
  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      const abortError = createMetadataWatcherAbortError();
      for (const requestId of [...pendingMetadataRequests.keys()]) {
        settleMetadataRequest(requestId, abortError);
      }
      try {
        worker.postMessage("close");
      } catch {
        /** pending 已同步结算；关闭消息失败仍由 terminate 完成资源回收。 */
      }
      void worker.terminate();
    },
    readHandledSequence: () => handledSequence,
    readRawSequence: () => {
      if (Atomics.load(state, 3) !== 0n) {
        throw new Error("工作区变化 worker 已进入不可恢复失败状态。");
      }
      return Atomics.load(state, 1);
    },
    readSequence: () => {
      assertRootIdentityCurrent();
      if (Atomics.load(state, 3) !== 0n) {
        throw new Error("工作区变化 worker 已进入不可恢复失败状态。");
      }
      return Atomics.load(state, 2);
    },
    setAnalyzerMetadataPaths: (paths, requestOptions) => {
      if (closed || failureReported) {
        return Promise.reject(new Error("工作区变化 worker 已关闭或失效。"));
      }
      if (requestOptions?.signal?.aborted === true) {
        return Promise.reject(createMetadataWatcherAbortError());
      }
      const timeoutMs = requestOptions?.timeoutMs ?? DEFAULT_METADATA_PATHS_ACK_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new RangeError("metadata watcher timeout 必须是正安全整数。"));
      }
      const normalizedPaths = [...new Set(paths.map((entry) =>
        normalizeRelativeGraphPath(entry)))].sort();
      const requestId = nextMetadataRequestId;
      nextMetadataRequestId += 1;
      if (!Number.isSafeInteger(nextMetadataRequestId)) {
        return Promise.reject(new RangeError("metadata watcher requestId 已达到安全上限。"));
      }
      return new Promise<void>((resolve, reject) => {
        const onAbort = requestOptions?.signal === undefined
          ? undefined
          : (): void => settleMetadataRequest(requestId, createMetadataWatcherAbortError());
        const timeout = setTimeout(() => reportFailure(
          new Error("工作区变化 worker metadata paths ACK 超时。"),
        ), timeoutMs);
        pendingMetadataRequests.set(requestId, {
          ...(onAbort === undefined ? {} : { onAbort }),
          reject,
          resolve,
          ...(requestOptions?.signal === undefined ? {} : { signal: requestOptions.signal }),
          timeout,
        });
        requestOptions?.signal?.addEventListener("abort", onAbort ?? (() => undefined), {
          once: true,
        });
        try {
          worker.postMessage({ kind: "metadata-paths", paths: normalizedPaths, requestId });
        } catch (error) {
          reportFailure(error);
        }
      });
    },
  };
}

/** 原生序列存在但主线程尚未处理时，当前 generation 证明不可用于提交。 */
function readStableMonitorSequence(monitor: WorkspaceChangeMonitor | null): bigint | null | false {
  try {
    const sequence = monitor?.readSequence?.();
    if (sequence === undefined) {
      return null;
    }
    return monitor?.readHandledSequence?.() === sequence ? sequence : false;
  } catch {
    return false;
  }
}

/** 自最终 fence 开始后出现任意原生文件事件都要求本次 mutation 回滚重排。 */
function isMonitorSequenceCurrent(
  monitor: WorkspaceChangeMonitor | null,
  expected: bigint | null,
): boolean {
  try {
    return expected === null || monitor?.readSequence?.() === expected;
  } catch {
    return false;
  }
}

/** watcher 失效后无法再证明扫描与提交窗口内没有输入变化。 */
function assertMonitorHealthy(error: unknown): void {
  if (error instanceof WorkspaceIgnoreConfigChangedError) {
    throw error;
  }
  if (error !== undefined) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区变化监视器已失效。", error);
  }
}

/** watcher 回调可能被同步提交阻塞，因此最终栅栏必须直接复核根级保留名。 */
/** Analyzer 配置、manifest、lockfile 与已封口 consulted path 都属于语义事件。 */
function isAnalyzerMetadataPath(
  relativePath: string,
  readSet?: HierarchyReadSetV1 | null,
  caseSensitivePaths = true,
): boolean {
  const normalized = relativePath.replaceAll("\\", "/").normalize("NFC");
  const normalizedKey = normalizeWatcherPathKey(normalized, caseSensitivePaths);
  const baseName = normalized.split("/").at(-1)?.toLowerCase() ?? "";
  if (
    baseName === "package.json" ||
    baseName === "package-lock.json" ||
    baseName === "pnpm-lock.yaml" ||
    baseName === "pnpm-workspace.yaml" ||
    baseName === "yarn.lock" ||
    /^(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/iu.test(baseName)
  ) {
    return true;
  }
  const snapshot = readSet?.analyzerConfigSnapshot;
  if (typeof snapshot !== "object" || snapshot === null || !("consultedFiles" in snapshot)) {
    return false;
  }
  const consultedFiles = (snapshot as { consultedFiles?: unknown }).consultedFiles;
  if (Array.isArray(consultedFiles) && consultedFiles.some((entry) =>
    typeof entry === "object" && entry !== null && "path" in entry &&
    typeof (entry as { path?: unknown }).path === "string" &&
    normalizeWatcherPathKey(
      (entry as { path: string }).path,
      caseSensitivePaths,
    ) === normalizedKey)) {
    return true;
  }
  const absentFiles = (snapshot as { absentFiles?: unknown }).absentFiles;
  if (Array.isArray(absentFiles) && absentFiles.some((entry) => typeof entry === "string" &&
    normalizeWatcherPathKey(entry, caseSensitivePaths) === normalizedKey)) {
    return true;
  }
  const absentResolutionFiles = (snapshot as { absentResolutionFiles?: unknown })
    .absentResolutionFiles;
  if (Array.isArray(absentResolutionFiles) &&
    absentResolutionFiles.some((entry) => typeof entry === "string" &&
      normalizeWatcherPathKey(entry, caseSensitivePaths) === normalizedKey)) {
    return true;
  }
  const blockedResolutionFiles = (snapshot as { blockedResolutionFiles?: unknown })
    .blockedResolutionFiles;
  return Array.isArray(blockedResolutionFiles) && blockedResolutionFiles.some((entry) =>
    typeof entry === "object" && entry !== null && "path" in entry &&
    typeof (entry as { path?: unknown }).path === "string" &&
    normalizeWatcherPathKey(
      (entry as { path: string }).path,
      caseSensitivePaths,
    ) === normalizedKey);
}

/** close/abort 统一使用稳定 AbortError，确保调用方不会遗留悬挂 Promise。 */
function createMetadataWatcherAbortError(): Error {
  const error = new Error("工作区变化 worker metadata 请求已取消。");
  error.name = "AbortError";
  return error;
}

/** hierarchy-only read-set 无 Analyzer 栅栏；composite read-set 必须逐文件同步复核。 */
function isAnalyzerConfigCurrent(
  indexingRoot: string,
  readSet: HierarchyReadSetV1,
): boolean {
  const snapshot = readSet.analyzerConfigSnapshot;
  if (snapshot === undefined) {return true;}
  if (typeof snapshot !== "object" || snapshot === null) {return false;}
  return verifyAnalyzerConfigSnapshotSynchronously(
    indexingRoot,
    snapshot as AnalyzerConfigSnapshotV1,
  );
}

/** 事务外生成 Analyzer 完整字节证明；hierarchy-only read-set 使用 null。 */
function prepareAnalyzerFence(
  indexingRoot: string,
  readSet: HierarchyReadSetV1,
): PreparedAnalyzerConfigFenceV1 | null | false {
  const snapshot = readSet.analyzerConfigSnapshot;
  if (snapshot === undefined) {return null;}
  if (typeof snapshot !== "object" || snapshot === null) {return false;}
  return prepareAnalyzerConfigFenceSynchronously(
    indexingRoot,
    snapshot as AnalyzerConfigSnapshotV1,
  ) ?? false;
}

/** 同步事务内禁止重新 hash Analyzer 文件，仅复核事务外准备身份。 */
function isPreparedAnalyzerFenceCurrent(
  indexingRoot: string,
  readSet: HierarchyReadSetV1,
  prepared: PreparedAnalyzerConfigFenceV1 | null,
): boolean {
  const snapshot = readSet.analyzerConfigSnapshot;
  if (snapshot === undefined) {return prepared === null;}
  return prepared !== null && typeof snapshot === "object" && snapshot !== null &&
    verifyPreparedAnalyzerConfigFenceSynchronously(
      indexingRoot,
      snapshot as AnalyzerConfigSnapshotV1,
      prepared,
    );
}

function assertNoUserIgnoreConfigSync(indexingRoot: string): void {
  try {
    if (readdirSync(indexingRoot).some((name) => name.normalize("NFC").toLowerCase() ===
      ".codegraphignore")) {
      throw new WorkspaceIgnoreConfigChangedError();
    }
  } catch (error) {
    if (error instanceof WorkspaceIgnoreConfigChangedError) {
      throw error;
    }
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "无法复核根级 ignore 配置。", error);
  }
}

/** generation 与完整 ignore 快照共同组成无需访问文件系统的快速栅栏。 */
function isCheapFenceCurrent(
  expected: HierarchyReadSetV1,
  bootstrapGeneration: number,
  ignoreSnapshot: EffectiveIgnoreSnapshotV1,
): boolean {
  const liveIgnoreSnapshot = freezeIgnoreSnapshot(ignoreSnapshot);
  return expected.bootstrapGeneration === bootstrapGeneration &&
    sha256CanonicalJson(expected.effectiveIgnoreSnapshot) ===
      sha256CanonicalJson(liveIgnoreSnapshot);
}

/** 把仅驻留内存的 bigint 身份证明规范化为可比较摘要，供双重 collect 建立稳定视图。 */
function digestWorkspaceVerificationProof(proof: WorkspaceVerificationProof): string {
  const normalizeStatus = (status: WorkspaceVerificationProof["files"][number]) => ({
    ctimeNs: status.ctimeNs.toString(),
    dev: status.dev.toString(),
    ino: status.ino.toString(),
    mtimeNs: status.mtimeNs.toString(),
    nlink: status.nlink.toString(),
    path: status.path,
    size: status.size.toString(),
  });
  return sha256CanonicalJson({
    directories: proof.directories.map((directory) => ({
      semanticEntriesDigest: directory.semanticEntriesDigest,
      status: normalizeStatus(directory.status),
    })),
    files: proof.files.map(normalizeStatus),
    manifestDigest: proof.manifestDigest,
  });
}

/** 冻结完整 ignore 快照，避免配置对象在扫描期间被原地突变。 */
function freezeIgnoreSnapshot(snapshot: EffectiveIgnoreSnapshotV1): HierarchyReadSetV1["effectiveIgnoreSnapshot"] {
  return Object.freeze({
    ...snapshot,
    effectiveRules: Object.freeze([...snapshot.effectiveRules]),
    userRules: Object.freeze([...snapshot.userRules]),
  });
}

/** 首次无基线使用 null，已提交 revision 从 1 开始且必须是安全整数。 */
function assertGraphRevision(value: number | null): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("baseGraphRevision 必须是 null 或正安全整数。");
  }
}
