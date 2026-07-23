/** @file 空 graph-service 的唯一组合根与可测试启动 API。 */
import { bootstrapServiceInstance, type OwnedServiceInstance } from "./instance-owner.js";
import { createBoundIpcEndpoint } from "./server.js";
import { createSafeLocalLogger, type SafeLocalLogger } from "./safe-log.js";
import type { ServiceInstancePaths } from "./instance-owner.js";

const STARTUP_LOGGER_CLOSE_TIMEOUT_MS = 250;

/** graph-service 启动选项。 */
export interface StartGraphServiceOptions {
  forceTerminate?: (code: number) => void;
  paths: ServiceInstancePaths;
  platform?: NodeJS.Platform;
}

/**
 * 启动本机 IPC 空图谱服务。
 *
 * 此组合根只装配控制面，不创建 SQLite、Analyzer、watcher、节点、边或 Findings。
 */
export async function startGraphService(
  options: StartGraphServiceOptions,
): Promise<OwnedServiceInstance> {
  const logger = await createSafeLocalLogger(options.paths.workspaceDirectory);
  try {
    return await bootstrapServiceInstance({
      bindEndpoint: (endpoint, endpointKind) =>
        createBoundIpcEndpoint({
          endpoint,
          endpointKind,
          logger,
          ...(options.forceTerminate === undefined
            ? {}
            : { forceTerminate: options.forceTerminate }),
        }),
      paths: options.paths,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  } catch (error) {
    await closeLoggerWithoutMaskingStartupError(logger);
    throw error;
  }
}

/** 为启动失败后的日志关闭设置硬界限，确保原始 fatal cleanup 错误一定可达入口。 */
async function closeLoggerWithoutMaskingStartupError(
  logger: SafeLocalLogger,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => logger.close())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STARTUP_LOGGER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export * from "./instance-owner.js";
export * from "./service-state.js";
