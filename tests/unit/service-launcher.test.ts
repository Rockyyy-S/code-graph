import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createGraphServiceProcessLauncher,
  type SpawnProcess,
} from "../../packages/service-client/src/launcher.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const workspaceKey = "4".repeat(64);

describe("trusted graph-service launcher", () => {
  it("spawns an injected executable without a shell or token arguments", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const spawnProcess = vi.fn<SpawnProcess>(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const launcher = createGraphServiceProcessLauncher(
      {
        args: ["trusted-entry.js"],
        command: "node",
      },
      spawnProcess,
    );
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot: "C:\\Users\\Example\\AppData\\Local",
      platform: "win32",
    });

    await launcher.start(paths);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnProcess.mock.calls[0] ?? [];
    expect(command).toBe("node");
    expect(args).toEqual(["trusted-entry.js"]);
    expect(options).toMatchObject({
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(options?.env?.CODEGRAPH_SERVICE_CONFIG).toBe(JSON.stringify(paths));
    expect(options?.env?.CODEGRAPH_SERVICE_CONFIG).not.toMatch(/sessionToken/i);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("maps an executable permission failure to stable ErrorV1", async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
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
});
