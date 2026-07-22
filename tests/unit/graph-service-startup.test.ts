import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapServiceInstance: vi.fn<() => Promise<never>>(),
  closeLogger: vi.fn<() => Promise<void>>(),
  createSafeLocalLogger: vi.fn<() => Promise<{ close: () => Promise<void> }>>(),
}));

vi.mock("../../apps/graph-service/src/instance-owner.js", async (importOriginal) => ({
  ...(await importOriginal()),
  bootstrapServiceInstance: mocks.bootstrapServiceInstance,
}));

vi.mock("../../apps/graph-service/src/safe-log.js", () => ({
  createSafeLocalLogger: mocks.createSafeLocalLogger,
}));

import { startGraphService } from "../../apps/graph-service/src/index.js";
import { GraphServiceFatalCleanupError } from "../../apps/graph-service/src/instance-owner.js";

beforeEach(() => {
  mocks.bootstrapServiceInstance.mockReset();
  mocks.closeLogger.mockReset();
  mocks.createSafeLocalLogger.mockReset();
  mocks.createSafeLocalLogger.mockResolvedValue({ close: mocks.closeLogger });
});

describe("graph-service startup failure handling", () => {
  it("preserves a fatal cleanup error when logger close also fails", async () => {
    const fatalError = new GraphServiceFatalCleanupError("listener cleanup failed");
    mocks.bootstrapServiceInstance.mockRejectedValue(fatalError);
    mocks.closeLogger.mockRejectedValue(new Error("logger close failed"));

    await expect(startGraphService({
      paths: {
        endpoint: "test-endpoint",
        endpointKind: "named-pipe",
        lockPath: "test-lock",
        metadataPath: "test-metadata",
        tokenPath: "test-token",
        workspaceDirectory: "test-workspace",
        workspaceKey: "1".repeat(64),
      },
    })).rejects.toBe(fatalError);
    expect(mocks.closeLogger).toHaveBeenCalledTimes(1);
  });

  it("bounds a permanently pending logger close before rethrowing fatal cleanup", async () => {
    vi.useFakeTimers();
    const fatalError = new GraphServiceFatalCleanupError("listener cleanup failed");
    mocks.bootstrapServiceInstance.mockRejectedValue(fatalError);
    mocks.closeLogger.mockReturnValue(new Promise<void>(() => undefined));

    try {
      const startup = startGraphService({
        paths: {
          endpoint: "test-endpoint",
          endpointKind: "named-pipe",
          lockPath: "test-lock",
          metadataPath: "test-metadata",
          tokenPath: "test-token",
          workspaceDirectory: "test-workspace",
          workspaceKey: "1".repeat(64),
        },
      });
      const assertion = expect(startup).rejects.toBe(fatalError);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
