import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runGraphServiceProcess } from "../../apps/graph-service/src/main.js";
import type { OwnedServiceInstance } from "../../apps/graph-service/src/instance-owner.js";

/** 构造包含私有 indexingRoot 与独立 WorkspacePaths 的进程环境。 */
function createEnvironment(workspaceKey: string, endpoint: string) {
  return {
    CODEGRAPH_SERVICE_CONFIG: JSON.stringify({
      indexingRoot: path.resolve("test-workspace"),
      paths: {
        endpoint,
        endpointKind: "named-pipe",
        lockPath: "C:\\cache\\owner.lock",
        metadataPath: "C:\\cache\\service-metadata.json",
        tokenPath: "C:\\cache\\session-token.bin",
        workspaceDirectory: "C:\\cache",
        workspaceKey,
      },
    }),
  };
}

describe("graph-service process lifecycle", () => {
  it("remembers a termination signal received before startup completes", async () => {
    const signals = new EventEmitter();
    const close = vi.fn(async () => undefined);
    let resolveRuntime: ((runtime: OwnedServiceInstance) => void) | undefined;
    const runtimePromise = new Promise<OwnedServiceInstance>((resolve) => {
      resolveRuntime = resolve;
    });
    const exitCodes: number[] = [];
    const environment = createEnvironment("a".repeat(64), "\\\\.\\pipe\\codegraph-test");
    const running = runGraphServiceProcess(environment, {
      setExitCode: (code) => exitCodes.push(code),
      signalTarget: signals,
      startService: async () => runtimePromise,
    });

    signals.emit("SIGTERM");
    resolveRuntime?.({ close } as unknown as OwnedServiceInstance);
    await running;

    expect(close).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([0]);
  });

  it("sets a failing exit code when signal cleanup cannot finish", async () => {
    vi.useFakeTimers();
    try {
      const signals = new EventEmitter();
      const exitCodes: number[] = [];
      const forceTerminate = vi.fn();
      const environment = createEnvironment(
        "b".repeat(64),
        "\\\\.\\pipe\\codegraph-test-failure",
      );
      const runtime = {
        close: vi.fn(async () => {
          throw new Error("cleanup failed");
        }),
      } as unknown as OwnedServiceInstance;
      const running = await runGraphServiceProcess(environment, {
        forceTerminate,
        setExitCode: (code) => exitCodes.push(code),
        shutdownDeadlineMs: 100,
        signalTarget: signals,
        startService: async () => runtime,
      });

      signals.emit("SIGINT");
      await vi.advanceTimersByTimeAsync(100);
      expect(exitCodes).toContain(1);
      expect(forceTerminate).toHaveBeenCalledWith(1);
      expect(running).toBe(runtime);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forces termination when startup remains pending after a shutdown signal", async () => {
    vi.useFakeTimers();
    try {
      const signals = new EventEmitter();
      const forceTerminate = vi.fn();
      let resolveRuntime: ((runtime: OwnedServiceInstance) => void) | undefined;
      const runtimePromise = new Promise<OwnedServiceInstance>((resolve) => {
        resolveRuntime = resolve;
      });
      const environment = createEnvironment(
        "c".repeat(64),
        "\\\\.\\pipe\\codegraph-test-deadline",
      );
      const running = runGraphServiceProcess(environment, {
        forceTerminate,
        shutdownDeadlineMs: 100,
        signalTarget: signals,
        startService: async () => runtimePromise,
      });

      signals.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);

      expect(forceTerminate).toHaveBeenCalledWith(1);
      resolveRuntime?.({ close: vi.fn(async () => undefined) } as unknown as OwnedServiceInstance);
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a private parent cancellation message before startup completes", async () => {
    const signals = new EventEmitter();
    const controls = new EventEmitter();
    const close = vi.fn(async () => undefined);
    let resolveRuntime: ((runtime: OwnedServiceInstance) => void) | undefined;
    const runtimePromise = new Promise<OwnedServiceInstance>((resolve) => {
      resolveRuntime = resolve;
    });
    const environment = createEnvironment(
      "e".repeat(64),
      "\\\\.\\pipe\\codegraph-private-cancel",
    );
    const running = runGraphServiceProcess(environment, {
      controlTarget: controls,
      signalTarget: signals,
      startService: async () => runtimePromise,
    });

    controls.emit("message", { type: "codegraph/cancel-startup" });
    resolveRuntime?.({ close } as unknown as OwnedServiceInstance);
    await running;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps termination handlers installed while asynchronous cleanup is pending", async () => {
    const signals = new EventEmitter();
    let resolveClose: (() => void) | undefined;
    const close = vi.fn(async () => new Promise<void>((resolve) => {
      resolveClose = resolve;
    }));
    const environment = createEnvironment(
      "d".repeat(64),
      "\\\\.\\pipe\\codegraph-repeat-signal",
    );
    await runGraphServiceProcess(environment, {
      signalTarget: signals,
      startService: async () => ({ close }) as unknown as OwnedServiceInstance,
    });

    signals.emit("SIGTERM");
    signals.emit("SIGTERM");

    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    resolveClose?.();
    await vi.waitFor(() => expect(signals.listenerCount("SIGTERM")).toBe(0));
  });

  it("rejects a shutdown deadline beyond the Node timer range", async () => {
    const signals = new EventEmitter();
    const environment = createEnvironment(
      "f".repeat(64),
      "\\\\.\\pipe\\codegraph-invalid-deadline",
    );

    await expect(
      runGraphServiceProcess(environment, {
        shutdownDeadlineMs: 2_147_483_648,
        signalTarget: signals,
        startService: async () => ({ close: vi.fn() }) as unknown as OwnedServiceInstance,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
