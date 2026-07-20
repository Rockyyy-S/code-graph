#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createErrorV1 } from "@codegraph/contracts";
import { startGraphService } from "./index.js";
import {
  GraphServiceFatalCleanupError,
  GraphServiceStartupError,
  type OwnedServiceInstance,
  type ServiceInstancePaths,
} from "./instance-owner.js";

const CONFIG_ENVIRONMENT_KEY = "CODEGRAPH_SERVICE_CONFIG";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PARENT_CANCEL_MESSAGE_TYPE = "codegraph/cancel-startup";
const CLOSE_RETRY_DELAYS_MS = [0, 25, 100] as const;

/** graph-service 进程启动与信号处理的可测试依赖。 */
export interface GraphServiceProcessDependencies {
  controlTarget?: {
    off: (event: "message", listener: (message: unknown) => void) => unknown;
    on: (event: "message", listener: (message: unknown) => void) => unknown;
  };
  forceTerminate?: (code: number) => void;
  setExitCode?: (code: number) => void;
  shutdownDeadlineMs?: number;
  signalTarget?: {
    off: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
    once: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  };
  startService?: typeof startGraphService;
}

/** 从受信任启动器注入的环境变量读取服务路径，不接受 workspace 配置。 */
export function parseServiceProcessConfig(
  environment: NodeJS.ProcessEnv,
): ServiceInstancePaths {
  const source = environment[CONFIG_ENVIRONMENT_KEY];
  if (source === undefined) {
    throw new Error("缺少 graph-service 启动配置。");
  }
  const value: unknown = JSON.parse(source);
  if (!isServiceInstancePaths(value)) {
    throw new Error("graph-service 启动配置不合法。");
  }
  return value;
}

/** 启动子进程服务并注册受控信号关闭。 */
export async function runGraphServiceProcess(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: GraphServiceProcessDependencies = {},
): Promise<OwnedServiceInstance> {
  const paths = parseServiceProcessConfig(environment);
  delete environment[CONFIG_ENVIRONMENT_KEY];
  const signalTarget = dependencies.signalTarget ?? process;
  const controlTarget = dependencies.controlTarget ?? process;
  const startService = dependencies.startService ?? startGraphService;
  const setExitCode =
    dependencies.setExitCode ?? ((code: number): void => void (process.exitCode = code));
  const forceTerminate =
    dependencies.forceTerminate ?? ((code: number): void => process.exit(code));
  const shutdownDeadlineMs = normalizeShutdownDeadline(
    dependencies.shutdownDeadlineMs ?? 1_000,
  );
  let runtime: OwnedServiceInstance | null = null;
  let shutdownRequested = false;
  let closePromise: Promise<void> | null = null;
  let hardShutdownTimeout: NodeJS.Timeout | null = null;
  const clearHardShutdownTimeout = (): void => {
    if (hardShutdownTimeout !== null) {
      clearTimeout(hardShutdownTimeout);
      hardShutdownTimeout = null;
    }
  };
  const armHardShutdownTimeout = (): void => {
    if (hardShutdownTimeout !== null) {
      return;
    }
    hardShutdownTimeout = setTimeout(() => forceTerminate(1), shutdownDeadlineMs);
    hardShutdownTimeout.unref();
  };
  const removeSignalHandlers = (): void => {
    signalTarget.off("SIGINT", requestShutdown);
    signalTarget.off("SIGTERM", requestShutdown);
  };
  const removeControlHandler = (): void => {
    controlTarget.off("message", receiveParentControlMessage);
  };
  const removeLifecycleHandlers = (): void => {
    removeSignalHandlers();
    removeControlHandler();
  };
  const closeRuntime = (): Promise<void> => {
    if (runtime === null) {
      return Promise.resolve();
    }
    closePromise ??= (async () => {
      let lastError: unknown;
      for (const delayMs of CLOSE_RETRY_DELAYS_MS) {
        if (delayMs > 0) {
          await wait(delayMs);
        }
        try {
          await runtime?.close();
          setExitCode(0);
          clearHardShutdownTimeout();
          removeLifecycleHandlers();
          return;
        } catch (error) {
          lastError = error;
          setExitCode(1);
        }
      }
      throw lastError;
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  };
  function requestShutdown(): void {
    shutdownRequested = true;
    armHardShutdownTimeout();
    if (runtime !== null) {
      void closeRuntime();
    }
  }
  function receiveParentControlMessage(message: unknown): void {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === PARENT_CANCEL_MESSAGE_TYPE
    ) {
      requestShutdown();
    }
  }

  signalTarget.once("SIGINT", requestShutdown);
  signalTarget.once("SIGTERM", requestShutdown);
  controlTarget.on("message", receiveParentControlMessage);
  try {
    runtime = await startService({ paths });
    if (shutdownRequested) {
      await closeRuntime();
    }
    return runtime;
  } catch (error) {
    if (!shutdownRequested) {
      clearHardShutdownTimeout();
      removeLifecycleHandlers();
    }
    throw error;
  }
}

/** 将进程终止宽限期收敛为可执行的正有限整数。 */
function normalizeShutdownDeadline(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("graph-service shutdown deadline 必须是正有限数。");
  }
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError("graph-service shutdown deadline 超出 Node 定时器范围。");
  }
  return Math.max(1, Math.floor(timeoutMs));
}

/** 等待下一次受控关闭重试。 */
async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** 严格校验启动器注入的封闭路径对象。 */
function isServiceInstancePaths(value: unknown): value is ServiceInstancePaths {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "endpoint",
    "endpointKind",
    "lockPath",
    "metadataPath",
    "tokenPath",
    "workspaceDirectory",
    "workspaceKey",
  ].sort();
  return (
    JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    typeof record.endpoint === "string" &&
    (record.endpointKind === "named-pipe" || record.endpointKind === "unix-socket") &&
    typeof record.lockPath === "string" &&
    typeof record.metadataPath === "string" &&
    typeof record.tokenPath === "string" &&
    typeof record.workspaceDirectory === "string" &&
    typeof record.workspaceKey === "string" &&
    /^[a-f0-9]{64}$/.test(record.workspaceKey)
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runGraphServiceProcess().catch((error: unknown) => {
    const safeError =
      error instanceof GraphServiceStartupError
        ? error.toProtocolError()
        : createErrorV1("SERVICE_ENDPOINT_START_FAILED", randomUUID());
    process.stderr.write(`${JSON.stringify(safeError)}\n`, () => {
      if (error instanceof GraphServiceFatalCleanupError) {
        process.exit(1);
      }
    });
    process.exitCode = 1;
  });
}
