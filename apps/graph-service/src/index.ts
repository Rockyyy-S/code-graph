/** @file 空 graph-service 的唯一组合根与可测试启动 API。 */
import { bootstrapServiceInstance, type OwnedServiceInstance } from "./instance-owner.js";
import { createBoundIpcEndpoint } from "./server.js";
import { createSafeLocalLogger } from "./safe-log.js";
import type { ServiceInstancePaths } from "./instance-owner.js";

/** graph-service 启动选项。 */
export interface StartGraphServiceOptions {
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
        createBoundIpcEndpoint({ endpoint, endpointKind, logger }),
      paths: options.paths,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  } catch (error) {
    await logger.close();
    throw error;
  }
}

export * from "./instance-owner.js";
export * from "./service-state.js";
