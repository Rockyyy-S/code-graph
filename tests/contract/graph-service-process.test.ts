import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGraphServiceProcessLauncher,
  type GraphServiceConnection,
} from "../../packages/service-client/src/index.js";
import { connectToGraphServiceWithCacheRootForTests } from "../../packages/service-client/src/connection.js";

const roots: string[] = [];
const clients: GraphServiceConnection[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("real graph-service process", () => {
  it(
    "reuses one Windows Named Pipe service across two independent client processes",
    async () => {
      const graphServiceEntry = path.resolve("apps/graph-service/dist/main.js");
      const serviceClientEntry = path.resolve("packages/service-client/dist/index.js");
      const workerEntry = path.resolve("tests/fixtures/service-client-process.mjs");
      await access(graphServiceEntry);
      await access(serviceClientEntry);
      const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-process-root-"));
      const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-process-cache-"));
      roots.push(indexingRoot, cacheRoot);
      const config = { cacheRoot, graphServiceEntry, indexingRoot };
      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      let controller: GraphServiceConnection | null = null;
      try {
        const [first, second] = await Promise.all([
          runClientProcess(workerEntry, config),
          runClientProcess(workerEntry, config),
        ]);

        expect(first.pid).toBe(second.pid);
        expect(first.serviceInstanceId).toBe(second.serviceInstanceId);
        expect(first.statusEpoch).toBe(second.statusEpoch);
        expect(first.endpointKind).toBe(
          process.platform === "win32" ? "named-pipe" : "unix-socket",
        );

        controller = await connectToGraphServiceWithCacheRootForTests(
          {
            clientVersion: "0.0.0-controller-test",
            indexingRoot,
            launcher,
            pollIntervalMs: 10,
            startTimeoutMs: 10_000,
            trust: { isTrusted: true },
          },
          cacheRoot,
        );
        expect(controller.metadata.pid).toBe(first.pid);
        expect(controller.initializeResult.serviceStatus.serviceInstanceId).toBe(
          first.serviceInstanceId,
        );
      } finally {
        controller ??= await connectToGraphServiceWithCacheRootForTests(
          {
            clientVersion: "0.0.0-cleanup-test",
            indexingRoot,
            launcher,
            pollIntervalMs: 10,
            startTimeoutMs: 10_000,
            trust: { isTrusted: true },
          },
          cacheRoot,
        ).catch(() => null);
        if (controller !== null) {
          await controller.shutdown().catch(async () => controller?.close());
        }
      }
    },
    30_000,
  );
});

/** 子进程夹具完成后返回的标准输出与退出状态。 */
interface ProcessResult {
  endpointKind: "named-pipe" | "unix-socket";
  pid: number;
  serviceInstanceId: string;
  statusEpoch: string;
}

/** 启动独立 Node 客户端进程并读取唯一 JSON 结果。 */
async function runClientProcess(
  workerEntry: string,
  config: { cacheRoot: string; graphServiceEntry: string; indexingRoot: string },
  timeoutMs = 15_000,
): Promise<ProcessResult> {
  const child = spawn(process.execPath, [workerEntry], {
    env: {
      ...process.env,
      CODEGRAPH_TEST_CLIENT_CONFIG: JSON.stringify(config),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let exitCode: number | null | undefined;
  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exitCode = code;
      resolve(code);
    });
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const completedCode = await Promise.race([
      exitPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("独立客户端进程执行超时。")),
          timeoutMs,
        );
      }),
    ]);
    if (completedCode !== 0) {
      throw new Error(`独立客户端进程失败：${stderr.trim()}`);
    }
    return JSON.parse(stdout.trim()) as ProcessResult;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (exitCode === undefined) {
      await killAndReap(child, exitPromise);
    }
  }
}

/** 终止挂起的测试 worker，并在升级强杀后有界等待 exit。 */
async function killAndReap(
  child: ReturnType<typeof spawn>,
  exitPromise: Promise<number | null>,
): Promise<void> {
  child.kill("SIGTERM");
  if (await waitForExit(exitPromise, 250)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForExit(exitPromise, 250))) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    throw new Error("测试 worker 在强制终止后仍未退出。");
  }
}

/** 在短界限内等待测试子进程退出。 */
async function waitForExit(
  exitPromise: Promise<number | null>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exitPromise.then(() => true),
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
