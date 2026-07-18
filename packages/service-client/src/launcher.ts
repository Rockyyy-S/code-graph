import { spawn } from "node:child_process";
import type { WorkspacePaths } from "./endpoint.js";
import { createServiceClientError } from "./errors.js";

/** 仅能由受信任 CLI/extension 组合根注入的可执行入口。 */
export interface TrustedGraphServiceExecutable {
  args: readonly string[];
  command: string;
}

/** 子进程启动结果的最小可测试边界。 */
export interface SpawnedProcess {
  once: {
    (event: "error", listener: (error: Error) => void): SpawnedProcess;
    (event: "spawn", listener: () => void): SpawnedProcess;
  };
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
    stdio: "ignore";
    windowsHide: true;
  },
) => SpawnedProcess;

/** service-client 使用的按需启动器接口。 */
export interface GraphServiceLauncher {
  start: (paths: WorkspacePaths) => Promise<void>;
}

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
    start: async (paths) => {
      const child = spawnProcess(executable.command, executable.args, {
        detached: true,
        env: {
          ...process.env,
          CODEGRAPH_SERVICE_CONFIG: JSON.stringify(paths),
        },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", () =>
          reject(createServiceClientError("SERVICE_ENDPOINT_START_FAILED")),
        );
        child.once("spawn", resolve);
      });
      child.unref();
    },
  };
}
