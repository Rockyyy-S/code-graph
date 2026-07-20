import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorV1 } from "../../packages/contracts/src/index.js";
import {
  createGraphServiceProcessLauncher,
  type SpawnProcess,
} from "../../packages/service-client/src/launcher.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const workspaceKey = "4".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建满足启动器最小进程边界的可控子进程。 */
function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean;
    disconnect: () => void;
    kill: (signal?: NodeJS.Signals) => boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
    stderr: PassThrough;
    unref: () => void;
  };
  child.connected = true;
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  child.kill = vi.fn(() => true);
  child.send = vi.fn((_message, callback) => {
    callback?.(null);
    return true;
  });
  child.stderr = new PassThrough();
  child.unref = vi.fn();
  return child;
}

/** 创建当前平台可实际发布 metadata 的隔离路径。 */
async function createPaths() {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-launcher-"));
  roots.push(root);
  return createWorkspacePaths(workspaceKey, {
    cacheRoot: root,
    platform: process.platform,
  });
}

describe("trusted graph-service launcher", () => {
  it("spawns an injected executable without a shell or token arguments", async () => {
    const child = createChild();
    const paths = await createPaths();
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        void mkdir(paths.workspaceDirectory, { recursive: true })
          .then(() => writeFile(paths.metadataPath, "{}"))
          .catch(() => undefined);
      });
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      {
        args: ["trusted-entry.js"],
        command: "node",
      },
      spawnProcess,
    );
    await launcher.start(paths);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnProcess.mock.calls[0] ?? [];
    expect(command).toBe("node");
    expect(args).toEqual(["trusted-entry.js"]);
    expect(options).toMatchObject({
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    expect(options?.env?.CODEGRAPH_SERVICE_CONFIG).toBe(JSON.stringify(paths));
    expect(options?.env?.CODEGRAPH_SERVICE_CONFIG).not.toMatch(/sessionToken/i);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("maps an executable permission failure to stable ErrorV1", async () => {
    const child = createChild();
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        child.emit("error", error);
      });
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
    );
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot: "C:\\Users\\Example\\AppData\\Local",
      platform: "win32",
    });

    await expect(launcher.start(paths)).rejects.toMatchObject({
      code: "SERVICE_ENDPOINT_START_FAILED",
    });
  });

  it("propagates a safe ErrorV1 emitted after spawn", async () => {
    const child = createChild();
    const paths = await createPaths();
    const safeError = createErrorV1("SERVICE_ENDPOINT_START_FAILED", "log-child-start");
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.stderr.end(`${JSON.stringify(safeError)}\n`, () => child.emit("close", 1));
      });
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
    );

    await expect(launcher.start(paths)).rejects.toMatchObject(safeError);
  });

  it("escalates termination and waits for close when startup times out", async () => {
    const child = createChild();
    const paths = await createPaths();
    child.send = vi.fn((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => child.emit("close", 0));
      return true;
    });
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
    );

    await expect(launcher.start(paths, 15)).rejects.toMatchObject({
      code: "SERVICE_START_TIMEOUT",
    });

    expect(child.send).toHaveBeenCalledWith(
      { type: "codegraph/cancel-startup" },
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("validates timeout before spawning a detached process", async () => {
    const spawnProcess = vi.fn<SpawnProcess>();
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
    );
    const paths = await createPaths();

    await expect(launcher.start(paths, 0)).rejects.toBeInstanceOf(TypeError);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("reports cleanup failure when cancellation and forced termination cannot stop child", async () => {
    const child = createChild();
    const paths = await createPaths();
    child.send = vi.fn((_message, callback) => {
      callback?.(new Error("ipc unavailable"));
      return false;
    });
    child.kill = vi.fn(() => false);
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
    );

    await expect(launcher.start(paths, 15)).rejects.toMatchObject({
      code: "SERVICE_ENDPOINT_START_FAILED",
    });
  });
});
