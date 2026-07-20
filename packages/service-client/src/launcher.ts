import { spawn, type Serializable } from "node:child_process";
import { access } from "node:fs/promises";
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
  once: {
    (event: "close", listener: (code: number | null) => void): SpawnedProcess;
    (event: "error", listener: (error: Error) => void): SpawnedProcess;
    (event: "spawn", listener: () => void): SpawnedProcess;
  };
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

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHILD_GRACEFUL_SHUTDOWN_MS = 1_200;
const CHILD_FORCE_TERMINATION_MS = 250;
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
): GraphServiceLauncher {
  return {
    start: async (paths, timeoutMs, signal) => {
      const boundedTimeoutMs = normalizeTimeout(timeoutMs ?? 5_000);
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
      await new Promise<void>((resolve, reject) => {
        child.once("error", () =>
          reject(createServiceClientError("SERVICE_ENDPOINT_START_FAILED")),
        );
        child.once("spawn", resolve);
      });
      child.unref();
      await waitForServicePublication(
        child,
        paths.metadataPath,
        boundedTimeoutMs,
        signal,
      );
    },
  };
}

/** 等待 metadata 发布或子进程以安全 ErrorV1 失败，避免只把 spawn 当作启动成功。 */
async function waitForServicePublication(
  child: SpawnedProcess,
  metadataPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + normalizeTimeout(timeoutMs);
  let exitCode: number | null | undefined;
  let resolveClose: (() => void) | undefined;
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (stderr.length < 16_384) {
      stderr += chunk.slice(0, 16_384 - stderr.length);
    }
  });
  child.once("close", (code) => {
    exitCode = code;
    resolveClose?.();
  });

  while (Date.now() <= deadline) {
    if (signal?.aborted === true) {
      await terminateAndReapChild(child, closePromise);
      throw createServiceClientError("SERVICE_START_TIMEOUT");
    }
    if (await pathExists(metadataPath)) {
      child.stderr?.destroy();
      disconnectControlChannel(child);
      return;
    }
    if (exitCode !== undefined) {
      throw readSafeStartupError(stderr) ?? createServiceClientError(
        "SERVICE_ENDPOINT_START_FAILED",
      );
    }
    await wait(10);
  }

  child.stderr?.destroy();
  await terminateAndReapChild(child, closePromise);
  throw createServiceClientError("SERVICE_START_TIMEOUT");
}

/** 先通过父子 IPC 请求受控终止，超出子进程 deadline 后才升级强杀。 */
async function terminateAndReapChild(
  child: SpawnedProcess,
  closePromise: Promise<void>,
): Promise<void> {
  child.stderr?.destroy();
  const cancellationSent = await sendCancellationMessage(child);
  if (cancellationSent) {
    disconnectControlChannel(child);
  }
  if (
    cancellationSent &&
    (await waitForChildClose(closePromise, CHILD_GRACEFUL_SHUTDOWN_MS))
  ) {
    return;
  }
  const killAccepted = child.kill("SIGKILL");
  const closed = await waitForChildClose(closePromise, CHILD_FORCE_TERMINATION_MS);
  if (!killAccepted || !closed) {
    throw createServiceClientError(
      "SERVICE_ENDPOINT_START_FAILED",
      "graph-service 子进程无法确认终止，已停止自动回收。",
    );
  }
}

/** 通过仅父子进程持有的 IPC channel 发送启动取消请求。 */
async function sendCancellationMessage(child: SpawnedProcess): Promise<boolean> {
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
        timeout = setTimeout(() => resolve(false), CHILD_FORCE_TERMINATION_MS);
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
    child.disconnect();
  }
}

/** 在短界限内等待子进程 close，确保启动器不会无界卡在回收阶段。 */
async function waitForChildClose(
  closePromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closePromise.then(() => true),
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

/** 检查服务是否已原子发布 metadata。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

/** 等待下一次 metadata/exit 探测。 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
