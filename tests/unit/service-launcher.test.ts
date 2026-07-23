import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createErrorV1 } from "../../packages/contracts/src/index.js";
import {
  createGraphServiceProcessLauncher,
  publishedMetadataOpenFlagsForTests,
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
    pid: number;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
    stderr: PassThrough;
    unref: () => void;
  };
  child.connected = true;
  child.disconnect = vi.fn(() => {
    child.connected = false;
  });
  child.kill = vi.fn(() => true);
  child.pid = 4321;
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
          .then(() => writeFile(paths.metadataPath, JSON.stringify({ pid: child.pid })))
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

  it("waits for stderr to drain after exit before mapping the startup error", async () => {
    const child = createChild();
    const paths = await createPaths();
    const safeError = createErrorV1("SERVICE_INSTANCE_CONFLICT", "log-exit-before-close");
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("exit", 1);
        setTimeout(() => {
          child.stderr.end(`${JSON.stringify(safeError)}\n`, () => child.emit("close", 1));
        }, 10);
      });
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
    );

    await expect(launcher.start(paths, 250)).rejects.toMatchObject(safeError);
  });

  it("drains and destroys stderr when exit occurs near the deadline without close", async () => {
    const child = createChild();
    const paths = await createPaths();
    const safeError = createErrorV1("SERVICE_INSTANCE_CONFLICT", "log-late-stderr");
    let probed = false;
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
      {
        readPublishedPid: async () => {
          if (!probed) {
            probed = true;
            await new Promise<void>((resolve) => setTimeout(resolve, 80));
            child.emit("exit", 1);
            setTimeout(() => child.stderr.write(`${JSON.stringify(safeError)}\n`), 50);
          }
          return null;
        },
      },
    );

    const startedAt = Date.now();
    await expect(launcher.start(paths, 100)).rejects.toMatchObject({
      code: "SERVICE_ENDPOINT_START_FAILED",
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.disconnect).toHaveBeenCalledTimes(1);
  });

  it("applies the startup deadline while waiting for the spawn event", async () => {
    const child = createChild();
    const paths = await createPaths();
    child.send = vi.fn((_message, callback) => {
      callback?.(null);
      queueMicrotask(() => child.emit("close", 0));
      return true;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      vi.fn<SpawnProcess>(() => child),
    );
    const startedAt = Date.now();

    await expect(launcher.start(paths, 20)).rejects.toMatchObject({
      code: "SERVICE_START_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(child.send).toHaveBeenCalledTimes(1);
  });

  it("clears a timed-out startup cleanup after the child exits asynchronously", async () => {
    const firstChild = createChild();
    const secondChild = createChild();
    secondChild.pid = firstChild.pid + 1;
    const paths = await createPaths();
    firstChild.send = vi.fn((_message, callback) => {
      setTimeout(() => callback?.(null), 2);
      setTimeout(() => firstChild.emit("close", 0), 5);
      return true;
    });
    let spawnCount = 0;
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      spawnCount += 1;
      const child = spawnCount === 1 ? firstChild : secondChild;
      queueMicrotask(() => {
        child.emit("spawn");
        if (child === secondChild) {
          void mkdir(paths.workspaceDirectory, { recursive: true })
            .then(() => writeFile(paths.metadataPath, JSON.stringify({ pid: child.pid })))
            .catch(() => undefined);
        }
      });
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      spawnProcess,
      { cleanupTimeoutMs: 100 },
    );

    await expect(launcher.start(paths, 15)).rejects.toMatchObject({
      code: "SERVICE_START_TIMEOUT",
    });
    await expect(launcher.start(paths, 250)).resolves.toBeUndefined();

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(firstChild.send).toHaveBeenCalledTimes(1);
  });

  it("captures a child error emitted after spawn as a stable startup failure", async () => {
    const child = createChild();
    const paths = await createPaths();
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      vi.fn<SpawnProcess>(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
      {
        cleanupTimeoutMs: 25,
        readPublishedPid: async () => {
          child.emit("error", new Error("post-spawn child error"));
          return null;
        },
      },
    );

    await expect(launcher.start(paths, 100)).rejects.toMatchObject({
      code: "SERVICE_ENDPOINT_START_FAILED",
    });
  });

  it("rejects metadata published by a child that has already exited", async () => {
    const child = createChild();
    const paths = await createPaths();
    const safeError = createErrorV1("SERVICE_ENDPOINT_START_FAILED", "log-published-then-exit");
    const launcher = createGraphServiceProcessLauncher(
      { args: ["trusted-entry.js"], command: "node" },
      vi.fn<SpawnProcess>(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }),
      {
        readPublishedPid: async () => {
          child.emit("exit", 1);
          child.stderr.end(`${JSON.stringify(safeError)}\n`, () => child.emit("close", 1));
          return child.pid;
        },
      },
    );

    await expect(launcher.start(paths, 250)).rejects.toMatchObject(safeError);
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
      { cleanupTimeoutMs: 25 },
    );

    const startedAt = Date.now();
    await expect(launcher.start(paths, 15)).rejects.toMatchObject({
      code: "SERVICE_START_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBeLessThan(200);
    await expect(launcher.start(paths, 100)).rejects.toMatchObject({
      code: "SERVICE_ENDPOINT_START_FAILED",
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("uses non-following nonblocking flags for POSIX metadata probes", () => {
    expect(publishedMetadataOpenFlagsForTests("win32")).toBe("r");
    if (process.platform === "win32") {
      return;
    }
    const flags = publishedMetadataOpenFlagsForTests(process.platform);

    expect(typeof flags).toBe("number");
    expect((flags as number) & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect((flags as number) & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
  });

  it("reaps a losing child when another process publishes metadata", async () => {
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
      { readPublishedPid: async () => child.pid + 1 },
    );

    await expect(launcher.start(paths, 100)).resolves.toBeUndefined();
    expect(child.send).toHaveBeenCalledTimes(1);
  });

  it("cancels the child even when metadata probing never settles", async () => {
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
      { readPublishedPid: async () => new Promise<never>(() => undefined) },
    );

    await expect(launcher.start(paths, 15)).rejects.toMatchObject({
      code: "SERVICE_START_TIMEOUT",
    });
    expect(child.send).toHaveBeenCalledTimes(1);
  });
});
