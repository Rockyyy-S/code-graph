import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectToGraphService,
  createGraphServiceProcessLauncher,
  type GraphServiceConnection,
} from "../../packages/service-client/src/index.js";

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

      const [first, second] = await Promise.all([
        runClientProcess(workerEntry, config),
        runClientProcess(workerEntry, config),
      ]);

      expect(first.pid).toBe(second.pid);
      expect(first.serviceInstanceId).toBe(second.serviceInstanceId);
      expect(first.statusEpoch).toBe(second.statusEpoch);
      expect(first.endpointKind).toBe(process.platform === "win32" ? "named-pipe" : "unix-socket");

      const launcher = createGraphServiceProcessLauncher({
        args: [graphServiceEntry],
        command: process.execPath,
      });
      const controller = await connectToGraphService({
        cacheRoot,
        clientVersion: "0.0.0-controller-test",
        indexingRoot,
        launcher,
        pollIntervalMs: 10,
        startTimeoutMs: 10_000,
        trust: { isTrusted: true },
      });
      clients.push(controller);
      expect(controller.metadata.pid).toBe(first.pid);
      expect(controller.initializeResult.serviceStatus.serviceInstanceId).toBe(
        first.serviceInstanceId,
      );
      await controller.shutdown();
    },
    30_000,
  );
});

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
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`独立客户端进程失败：${stderr.trim()}`);
  }
  return JSON.parse(stdout.trim()) as ProcessResult;
}
