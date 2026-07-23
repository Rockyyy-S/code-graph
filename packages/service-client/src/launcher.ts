import { spawn, type Serializable } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { validateErrorV1 } from "@codegraph/contracts";
import type { WorkspacePaths } from "./endpoint.js";
import { createServiceClientError, ServiceClientError } from "./errors.js";

/** 仅能由受信任 CLI/extension 组合根注入的可执行入口。 */
export interface TrustedGraphServiceExecutable {
  args: readonly string[];
  command: string;
}

/** 子进程启动结果的最小可测试边界。 */
export interface SpawnedProcess {
  connected: boolean;
  disconnect: () => void;
  kill: (signal?: NodeJS.Signals) => boolean;
  on: {
    (event: "error", listener: (error: Error) => void): SpawnedProcess;
  };
  off: {
    (event: "error", listener: (error: Error) => void): SpawnedProcess;
    (event: "spawn", listener: () => void): SpawnedProcess;
  };
  once: {
    (event: "close", listener: (code: number | null) => void): SpawnedProcess;
    (event: "error", listener: (error: Error) => void): SpawnedProcess;
    (event: "exit", listener: (code: number | null) => void): SpawnedProcess;
    (event: "spawn", listener: () => void): SpawnedProcess;
  };
  pid?: number | undefined;
  send: (
    message: Serializable,
    callback?: (error: Error | null) => void,
  ) => boolean;
  stderr: Readable | null;
  unref: () => void;
}

/** 受控 child_process.spawn 边界。 */
export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    detached: true;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ["ignore", "ignore", "pipe", "ipc"];
    windowsHide: true;
  },
) => SpawnedProcess;

/** service-client 使用的按需启动器接口。 */
export interface GraphServiceLauncher {
  start: (paths: WorkspacePaths, timeoutMs?: number, signal?: AbortSignal) => Promise<void>;
}

/** 启动监控的可测试依赖。 */
export interface GraphServiceLauncherDependencies {
  cleanupTimeoutMs?: number;
  readPublishedPid?: (metadataPath: string) => Promise<number | null>;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHILD_GRACEFUL_SHUTDOWN_MS = 1_200;
const CHILD_FORCE_TERMINATION_MS = 1_000;
const CHILD_STDERR_DRAIN_MS = 250;
const CHILD_CLEANUP_TIMEOUT_MS =
  CHILD_FORCE_TERMINATION_MS + CHILD_GRACEFUL_SHUTDOWN_MS + CHILD_FORCE_TERMINATION_MS;
const PARENT_CANCEL_MESSAGE = { type: "codegraph/cancel-startup" } as const;

const defaultSpawnProcess: SpawnProcess = (command, args, options) =>
  spawn(command, [...args], options);

/**
 * 创建受信任 graph-service 子进程启动器。
 *
 * 可执行入口不从 workspace 文件、仓库配置或用户项目内容读取；参数数组直接传给
 * `spawn` 且固定 `shell:false`，不会构造 shell 命令字符串。
 */
export function createGraphServiceProcessLauncher(
  executable: TrustedGraphServiceExecutable,
  spawnProcess: SpawnProcess = defaultSpawnProcess,
  dependencies: GraphServiceLauncherDependencies = {},
): GraphServiceLauncher {
  const cleanupTimeoutMs = normalizeTimeout(
    dependencies.cleanupTimeoutMs ?? CHILD_CLEANUP_TIMEOUT_MS,
  );
  const pendingCleanups = new Map<string, Set<PendingChildCleanup>>();
  return {
    start: async (paths, timeoutMs, signal) => {
      const boundedTimeoutMs = normalizeTimeout(timeoutMs ?? 5_000);
      const deadline = Date.now() + boundedTimeoutMs;
      const cleanupKey = paths.workspaceDirectory;
      await reconcilePendingChildCleanups(pendingCleanups, cleanupKey, deadline);
      if (signal?.aborted === true) {
        throw createServiceClientError("SERVICE_START_TIMEOUT");
      }
      const child = spawnProcess(executable.command, executable.args, {
        detached: true,
        env: {
          ...process.env,
          CODEGRAPH_SERVICE_CONFIG: JSON.stringify(paths),
        },
        shell: false,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true,
      });
      const closeMonitor = createChildCloseMonitor(child);
      const readStderr = captureStartupStderr(child);
      const spawnOutcome = await waitForChildSpawn(child, closeMonitor, deadline, signal);
      if (spawnOutcome === "exited") {
        throw await readStartupFailureAfterExit(child, closeMonitor, readStderr, deadline);
      }
      if (spawnOutcome === "failed") {
        child.stderr?.destroy();
        disconnectControlChannel(child);
        throw createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
      }
      if (spawnOutcome === "cancelled") {
        trackChildCleanup(
          pendingCleanups,
          cleanupKey,
          terminateAndReapChild(
            child,
            closeMonitor,
            Date.now() + cleanupTimeoutMs,
          ),
        );
        throw createServiceClientError("SERVICE_START_TIMEOUT");
      }
      child.unref();
      try {
        await waitForServicePublication(
          child,
          paths.metadataPath,
          deadline,
          signal,
          dependencies.readPublishedPid ?? readPublishedPid,
          closeMonitor,
          readStderr,
          () => trackChildCleanup(
            pendingCleanups,
            cleanupKey,
            terminateAndReapChild(
              child,
              closeMonitor,
              Date.now() + cleanupTimeoutMs,
            ),
          ),
        );
      } catch (error) {
        if (!closeMonitor.exited &&
            (hasProtocolCode(error, "SERVICE_START_TIMEOUT") || closeMonitor.error !== null)) {
          trackChildCleanup(
            pendingCleanups,
            cleanupKey,
            terminateAndReapChild(
              child,
              closeMonitor,
              Date.now() + cleanupTimeoutMs,
            ),
          );
        }
        throw error;
      }
    },
  };
}

/** 等待 metadata 发布或子进程以安全 ErrorV1 失败，避免只把 spawn 当作启动成功。 */
async function waitForServicePublication(
  child: SpawnedProcess,
  metadataPath: string,
  deadline: number,
  signal?: AbortSignal,
  readPid: (metadataPath: string) => Promise<number | null> = readPublishedPid,
  closeMonitor: ChildCloseMonitor = createChildCloseMonitor(child),
  readStderr: () => string = captureStartupStderr(child),
  trackLosingChildCleanup: () => void = () => undefined,
): Promise<void> {
  while (Date.now() <= deadline) {
    const observation = await Promise.race([
      probePublishedPid(metadataPath, deadline, signal, readPid).then(
        (publication) => ({ kind: "publication", publication }) as const,
      ),
      closeMonitor.errorPromise.then((error) => ({ error, kind: "error" }) as const),
      closeMonitor.exitPromise.then(() => ({ kind: "exit" }) as const),
    ]);
    if (observation.kind === "exit") {
      throw await readStartupFailureAfterExit(
        child,
        closeMonitor,
        readStderr,
        deadline,
      );
    }
    if (observation.kind === "error") {
      throw createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
    }
    const publication = observation.publication;
    if (publication.kind === "cancelled") {
      throw createServiceClientError("SERVICE_START_TIMEOUT");
    }
    if (publication.kind === "published") {
      if (child.pid === undefined || publication.pid !== child.pid) {
        trackLosingChildCleanup();
        return;
      }
      child.stderr?.destroy();
      disconnectControlChannel(child);
      return;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs > 0) {
      await wait(Math.min(10, remainingMs));
    }
  }

  if (closeMonitor.exited) {
    throw await readStartupFailureAfterExit(
      child,
      closeMonitor,
      readStderr,
      deadline,
    );
  }
  throw createServiceClientError("SERVICE_START_TIMEOUT");
}

/** 后台子进程回收的封闭结算状态。 */
type ChildCleanupOutcome =
  | { kind: "failure"; error: ServiceClientError }
  | { kind: "success" };

/** 单次后台回收记录；失败记录会持续作为 fail-closed tombstone。 */
interface PendingChildCleanup {
  outcome?: ChildCleanupOutcome;
  promise: Promise<ChildCleanupOutcome>;
}

/** 立即启动独立有界回收，并在成功确认 exit 后自动删除记录。 */
function trackChildCleanup(
  pendingCleanups: Map<string, Set<PendingChildCleanup>>,
  key: string,
  cleanup: Promise<void>,
): void {
  let entry!: PendingChildCleanup;
  const tracked = cleanup.then<ChildCleanupOutcome, ChildCleanupOutcome>(
    () => {
      entry.outcome = { kind: "success" };
      removePendingChildCleanup(pendingCleanups, key, entry);
      return entry.outcome;
    },
    (error: unknown) => {
      const failure = error instanceof ServiceClientError
        ? error
        : createServiceClientError("SERVICE_ENDPOINT_START_FAILED");
      entry.outcome = { error: failure, kind: "failure" };
      return entry.outcome;
    },
  );
  entry = { promise: tracked };
  const pending = pendingCleanups.get(key) ?? new Set<PendingChildCleanup>();
  pending.add(entry);
  pendingCleanups.set(key, pending);
}

/** 新 spawn 前等待既有后台回收；确认失败后持续禁止启动第二实例。 */
async function reconcilePendingChildCleanups(
  pendingCleanups: Map<string, Set<PendingChildCleanup>>,
  key: string,
  deadline: number,
): Promise<void> {
  while (true) {
    const pending = pendingCleanups.get(key);
    if (pending === undefined || pending.size === 0) {
      return;
    }
    const failure = [...pending].find(
      (entry) => entry.outcome?.kind === "failure",
    )?.outcome;
    if (failure?.kind === "failure") {
      throw failure.error;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      throw createServiceClientError("SERVICE_START_TIMEOUT");
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        ...[...pending].map((entry) => entry.promise),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), remainingMs);
        }),
      ]);
      if (outcome === null) {
        throw createServiceClientError("SERVICE_START_TIMEOUT");
      }
      if (outcome.kind === "failure") {
        throw outcome.error;
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}

/** 删除已经确认安全退出的单次后台回收记录。 */
function removePendingChildCleanup(
  pendingCleanups: Map<string, Set<PendingChildCleanup>>,
  key: string,
  entry: PendingChildCleanup,
): void {
  const pending = pendingCleanups.get(key);
  pending?.delete(entry);
  if (pending?.size === 0) {
    pendingCleanups.delete(key);
  }
}

/** 先通过父子 IPC 请求受控终止，超出子进程 deadline 后才升级强杀。 */
async function terminateAndReapChild(
  child: SpawnedProcess,
  closeMonitor: ChildCloseMonitor,
  deadline: number,
): Promise<void> {
  child.stderr?.destroy();
  if (closeMonitor.exited) {
    return;
  }
  const cancellationSent = await sendCancellationMessage(
    child,
    Math.max(0, deadline - Date.now()),
  );
  if (cancellationSent) {
    disconnectControlChannel(child);
  }
  const gracefulWaitMs = Math.min(
    CHILD_GRACEFUL_SHUTDOWN_MS,
    Math.max(0, deadline - Date.now()),
  );
  if (cancellationSent &&
      (closeMonitor.exited ||
        (gracefulWaitMs > 0 &&
          await waitForChildLifecycle(closeMonitor.exitPromise, gracefulWaitMs)))) {
    return;
  }
  if (closeMonitor.exited) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /** kill 竞态失败仍由 exit monitor 决定是否已安全回收。 */
  }
  const forceWaitMs = Math.min(
    CHILD_FORCE_TERMINATION_MS,
    Math.max(0, deadline - Date.now()),
  );
  const exited = closeMonitor.exited ||
    (forceWaitMs > 0 &&
      await waitForChildLifecycle(closeMonitor.exitPromise, forceWaitMs));
  if (!exited) {
    throw createServiceClientError(
      "SERVICE_ENDPOINT_START_FAILED",
      "graph-service 子进程无法确认终止，已停止自动回收。",
    );
  }
}

/** 从 spawn 返回后立即截取有界 stderr，覆盖 spawn 事件前的快速失败。 */
function captureStartupStderr(child: SpawnedProcess): () => string {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 16_384) {
      stderr += chunk.slice(0, 16_384 - stderr.length);
    }
  });
  return () => stderr;
}

/** 在同一绝对 deadline 内等待 spawn/error/exit，并响应外部取消。 */
async function waitForChildSpawn(
  child: SpawnedProcess,
  closeMonitor: ChildCloseMonitor,
  deadline: number,
  signal?: AbortSignal,
): Promise<"cancelled" | "exited" | "failed" | "spawned"> {
  if (signal?.aborted === true || Date.now() >= deadline) {
    return "cancelled";
  }
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let settleSpawn!: () => void;
  const spawnOutcome = new Promise<"spawned">((resolve) => {
    settleSpawn = () => resolve("spawned");
  });
  const onSpawn = (): void => settleSpawn();
  child.once("spawn", onSpawn);
  try {
    return await Promise.race([
      spawnOutcome,
      closeMonitor.errorPromise.then(() => "failed" as const),
      closeMonitor.exitPromise.then(() => "exited" as const),
      new Promise<"cancelled">((resolve) => {
        timeout = setTimeout(
          () => resolve("cancelled"),
          Math.max(0, deadline - Date.now()),
        );
        onAbort = () => resolve("cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
    /** once 监听器在竞态丢败时也必须移除，避免持有启动闭包。 */
    child.off("spawn", onSpawn);
  }
}

/** 从 spawn 返回起分别监控进程退出与 stdio close，避免混淆回收和排空语义。 */
interface ChildCloseMonitor {
  closePromise: Promise<void>;
  closed: boolean;
  error: Error | null;
  errorPromise: Promise<Error>;
  exitPromise: Promise<void>;
  exited: boolean;
}

/** 在等待 spawn 事件前注册 exit/close 监听。 */
function createChildCloseMonitor(child: SpawnedProcess): ChildCloseMonitor {
  const monitor: ChildCloseMonitor = {
    closePromise: Promise.resolve(),
    closed: false,
    error: null,
    errorPromise: Promise.resolve(new Error("uninitialized child error monitor")),
    exitPromise: Promise.resolve(),
    exited: false,
  };
  let resolveExit: (() => void) | undefined;
  let resolveClose: (() => void) | undefined;
  let resolveError: ((error: Error) => void) | undefined;
  monitor.exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  monitor.closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  monitor.errorPromise = new Promise<Error>((resolve) => {
    resolveError = resolve;
  });
  const markErrored = (error: Error): void => {
    monitor.error = error;
    resolveError?.(error);
  };
  const markExited = (): void => {
    if (!monitor.exited) {
      monitor.exited = true;
      child.off("error", markErrored);
      resolveExit?.();
    }
  };
  const markClosed = (): void => {
    markExited();
    if (!monitor.closed) {
      monitor.closed = true;
      resolveClose?.();
    }
  };
  child.on("error", markErrored);
  child.once("exit", markExited);
  child.once("close", markClosed);
  return monitor;
}

/** 通过仅父子进程持有的 IPC channel 发送启动取消请求。 */
async function sendCancellationMessage(
  child: SpawnedProcess,
  remainingMs: number,
): Promise<boolean> {
  if (!child.connected) {
    return false;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      new Promise<boolean>((resolve) => {
        try {
          child.send(PARENT_CANCEL_MESSAGE, (error) => resolve(error === null));
        } catch {
          resolve(false);
        }
      }),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(
          () => resolve(false),
          Math.min(CHILD_FORCE_TERMINATION_MS, Math.max(0, remainingMs)),
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** metadata 已发布后断开仅用于启动取消的父子控制通道。 */
function disconnectControlChannel(child: SpawnedProcess): void {
  if (child.connected) {
    try {
      child.disconnect();
    } catch {
      /** 进程退出与 IPC close 可能竞态；断开失败不应覆盖原始启动结果。 */
    }
  }
}

/** 在短界限内等待指定子进程生命周期事件。 */
async function waitForChildLifecycle(
  lifecyclePromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lifecyclePromise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** 子进程退出后有界等待 stdio close，再解析已经排空的安全启动错误。 */
async function readStartupFailureAfterExit(
  child: SpawnedProcess,
  monitor: ChildCloseMonitor,
  readStderr: () => string,
  deadline: number,
): Promise<ServiceClientError> {
  const drainWaitMs = Math.min(
    CHILD_STDERR_DRAIN_MS,
    Math.max(0, deadline - Date.now()),
  );
  if (!monitor.closed && drainWaitMs > 0) {
    await waitForChildLifecycle(
      monitor.closePromise,
      drainWaitMs,
    );
  }
  const failure = readSafeStartupError(readStderr()) ?? createServiceClientError(
    "SERVICE_ENDPOINT_START_FAILED",
  );
  if (!monitor.closed) {
    child.stderr?.destroy();
    disconnectControlChannel(child);
  }
  return failure;
}

/** 只解析 graph-service 明确输出的严格 ErrorV1，不传播任意 stderr。 */
function readSafeStartupError(stderr: string): ServiceClientError | null {
  for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
    if (line.length === 0) {
      continue;
    }
    try {
      const candidate: unknown = JSON.parse(line);
      if (validateErrorV1(candidate)) {
        return new ServiceClientError(candidate);
      }
    } catch {
      /** 非协议 stderr 被安全忽略，避免把路径或堆栈带入公共错误。 */
    }
  }
  return null;
}

/** 在 deadline/abort 内探测 metadata PID，避免文件系统挂起阻塞子进程回收。 */
async function probePublishedPid(
  metadataPath: string,
  deadline: number,
  signal: AbortSignal | undefined,
  readPid: (metadataPath: string) => Promise<number | null>,
): Promise<{ kind: "absent" } | { kind: "cancelled" } | { kind: "published"; pid: number }> {
  if (signal?.aborted === true) {
    return { kind: "cancelled" };
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) {
    return { kind: "cancelled" };
  }
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      readPid(metadataPath).then((pid) =>
        pid === null
          ? ({ kind: "absent" } as const)
          : ({ kind: "published", pid } as const),
      ),
      new Promise<{ kind: "cancelled" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "cancelled" }), remainingMs);
        onAbort = () => resolve({ kind: "cancelled" });
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    return result;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (onAbort !== undefined) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** 从有界 metadata 文件读取发布进程 PID；非法或缺失文件视为尚未发布。 */
async function readPublishedPid(metadataPath: string): Promise<number | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(metadataPath, publishedMetadataOpenFlags(process.platform));
    const status = await handle.stat();
    if (!status.isFile() || status.size <= 0 || status.size > 64 * 1024) {
      return null;
    }
    const source = Buffer.allocUnsafe(status.size);
    const { bytesRead } = await handle.read(source, 0, source.byteLength, 0);
    if (bytesRead !== source.byteLength) {
      return null;
    }
    const candidate: unknown = JSON.parse(source.toString("utf8"));
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("pid" in candidate) ||
      typeof candidate.pid !== "number" ||
      !Number.isInteger(candidate.pid) ||
      candidate.pid <= 0
    ) {
      return null;
    }
    return candidate.pid;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** 返回 metadata PID 探针的平台安全打开参数，供跨平台回归测试验证。 */
export function publishedMetadataOpenFlagsForTests(
  platform: NodeJS.Platform,
): number | string {
  return publishedMetadataOpenFlags(platform);
}

/** POSIX 禁止跟随链接并以非阻塞方式打开，避免 FIFO 永久占用 libuv 请求。 */
function publishedMetadataOpenFlags(platform: NodeJS.Platform): number | string {
  return platform === "win32"
    ? "r"
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
}

/** 启动监控使用正有限 timeout，拒绝无界等待。 */
function normalizeTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("graph-service 启动 timeout 必须是正有限数。");
  }
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("graph-service 启动 timeout 超出 Node 定时器范围。");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/** 判断稳定 service-client 协议错误码。 */
function hasProtocolCode(error: unknown, code: string): boolean {
  return error instanceof ServiceClientError && error.code === code;
}

/** 等待下一次 metadata/exit 探测。 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
