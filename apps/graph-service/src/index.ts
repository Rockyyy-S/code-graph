/** @file graph-service 的唯一组合根与可测试启动 API。 */
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createErrorV1, sha256CanonicalJson } from "@codegraph/contracts";
import { openSqliteGraphStore } from "@codegraph/adapter-store-sqlite";
import { createTypeScriptAnalyzer } from "@codegraph/adapter-analyzer-typescript";
import {
  bootstrapServiceInstance,
  GraphServiceStartupError,
  type OwnedServiceInstance,
} from "./instance-owner.js";
import { createBoundIpcEndpoint } from "./server.js";
import { createSafeLocalLogger, type SafeLocalLogger } from "./safe-log.js";
import type { ServiceInstancePaths } from "./instance-owner.js";
import { createInitialIgnoreState } from "./ignore-bootstrap.js";
import { createVerifiedIndexJobRuntime } from "./index-job-runtime.js";
import {
  createDefaultHostPathIdentitySnapshotProvider,
  HostPathIdentityBroker,
  MAX_HOST_PATH_CANDIDATES,
} from "./host-path-identity.js";
import { isFileSystemCaseSensitive } from "./workspace-scanner.js";

const STARTUP_LOGGER_CLOSE_TIMEOUT_MS = 250;

/** graph-service 启动选项。 */
export interface StartGraphServiceOptions {
  forceTerminate?: (code: number) => void;
  indexingRoot: string;
  paths: ServiceInstancePaths;
  platform?: NodeJS.Platform;
}

/**
 * 启动本机 IPC 图谱服务，并在开放握手前完成 SQLite/ignore/runtime 屏障。
 */
export async function startGraphService(
  options: StartGraphServiceOptions,
): Promise<OwnedServiceInstance> {
  const indexingRoot = await validateTrustedIndexingRoot(options.indexingRoot);
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
      initializeRuntime: async ({ serviceInstanceId, statusEpoch, workspaceKey }) => {
        let store: Awaited<ReturnType<typeof openSqliteGraphStore>> | null = null;
        const analyzer = createTypeScriptAnalyzer();
        /**
         * service instance 只创建一个 broker；每次 Analyzer capture 仍生成独立瞬态句柄批次，
         * snapshot identity 不会进入 store、digest 或进程外协议。
         */
        const platform = options.platform ?? process.platform;
        const caseSensitiveFileNames = isFileSystemCaseSensitive(indexingRoot);
        const hostPathIdentityBroker = new HostPathIdentityBroker({
          caseSensitiveFileNames,
          indexingRoot,
          maxCandidates: MAX_HOST_PATH_CANDIDATES,
          platform,
          snapshotProvider: createDefaultHostPathIdentitySnapshotProvider({
            caseSensitiveFileNames,
            platform,
          }),
        });
        try {
          store = await openSqliteGraphStore({
            databasePath: path.join(options.paths.workspaceDirectory, "graph.sqlite"),
            digestPort: { digest: sha256CanonicalJson },
            workspaceKey,
          });
          const ignoreState = await createInitialIgnoreState(indexingRoot);
          return await createVerifiedIndexJobRuntime({
            analyzer,
            hostPathIdentityBroker,
            ignoreState,
            indexingRoot,
            serviceInstanceId,
            statusEpoch,
            store,
            workspaceKey,
          });
        } catch (error) {
          await analyzer.close().catch(() => undefined);
          store?.close();
          if (error instanceof GraphServiceStartupError) {
            throw error;
          }
          throw new GraphServiceStartupError(
            createErrorV1("GRAPH_STORE_OPEN_FAILED", randomUUID()),
          );
        }
      },
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  } catch (error) {
    await closeLoggerWithoutMaskingStartupError(logger);
    throw error;
  }
}

/** 在创建缓存、token 或 endpoint 前确认受信任 root 是规范绝对真实目录。 */
async function validateTrustedIndexingRoot(indexingRoot: string): Promise<string> {
  try {
    if (
      !path.isAbsolute(indexingRoot) ||
      path.normalize(indexingRoot) !== indexingRoot ||
      indexingRoot.includes("\0")
    ) {
      throw new Error("indexing root 不是规范绝对路径。");
    }
    /** 物理 root 不能做 Unicode 改写，否则 NFD 文件系统路径会被错误重定向。 */
    const resolved = await realpath(indexingRoot);
    const status = await lstat(resolved);
    if (!status.isDirectory() || status.isSymbolicLink() || resolved !== indexingRoot) {
      throw new Error("indexing root 不是规范真实目录。");
    }
    return resolved;
  } catch {
    throw new GraphServiceStartupError(
      createErrorV1("GRAPH_SCAN_FAILED", randomUUID()),
    );
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
export * from "./analyzer-config.js";
export * from "./index-read-set.js";
export * from "./index-job-runtime.js";
export * from "./service-state.js";
