#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createErrorV1 } from "@codegraph/contracts";
import { startGraphService } from "./index.js";
import {
  GraphServiceStartupError,
  type OwnedServiceInstance,
  type ServiceInstancePaths,
} from "./instance-owner.js";

const CONFIG_ENVIRONMENT_KEY = "CODEGRAPH_SERVICE_CONFIG";

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
): Promise<OwnedServiceInstance> {
  const paths = parseServiceProcessConfig(environment);
  delete environment[CONFIG_ENVIRONMENT_KEY];
  const runtime = await startGraphService({ paths });
  const close = (): void => {
    void runtime.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return runtime;
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
    process.stderr.write(`${JSON.stringify(safeError)}\n`);
    process.exitCode = 1;
  });
}
