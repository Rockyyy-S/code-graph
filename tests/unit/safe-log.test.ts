import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directoryChmod: vi.fn<() => Promise<void>>(),
  handleChmod: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  isFile: vi.fn<() => boolean>(),
  mkdir: vi.fn<() => Promise<void>>(),
  open: vi.fn<() => Promise<{
    chmod: () => Promise<void>;
    close: () => Promise<void>;
    stat: () => Promise<{ isFile: () => boolean; nlink: number }>;
  }>>(),
  stat: vi.fn<() => Promise<{ isFile: () => boolean; nlink: number }>>(),
}));

vi.mock("node:fs", () => ({
  constants: {
    O_APPEND: 1,
    O_CREAT: 2,
    O_NOFOLLOW: 8,
    O_NONBLOCK: 16,
    O_WRONLY: 4,
  },
}));

vi.mock("node:fs/promises", () => ({
  chmod: mocks.directoryChmod,
  mkdir: mocks.mkdir,
  open: mocks.open,
}));

import { createSafeLocalLogger } from "../../apps/graph-service/src/safe-log.js";

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
  mocks.directoryChmod.mockResolvedValue(undefined);
  mocks.handleChmod.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ isFile: mocks.isFile, nlink: 1 });
  mocks.open.mockResolvedValue({
    chmod: mocks.handleChmod,
    close: mocks.close,
    stat: mocks.stat,
  });
  mocks.isFile.mockReturnValue(true);
});

describe("safe local log creation", () => {
  it("tightens an existing POSIX workspace directory before opening the log", async () => {
    const logger = await createSafeLocalLogger("test-workspace", "linux");

    expect(mocks.directoryChmod).toHaveBeenCalledWith("test-workspace", 0o700);
    expect(mocks.directoryChmod.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.open.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await logger.close();
  });

  it("rejects and closes a pre-existing non-regular log target", async () => {
    mocks.isFile.mockReturnValue(false);

    await expect(createSafeLocalLogger("test-workspace", "linux")).rejects.toThrow(
      "安全日志路径必须是普通文件",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.handleChmod).not.toHaveBeenCalled();
  });

  it("rejects and closes a pre-existing hard-linked log target", async () => {
    mocks.stat.mockResolvedValue({ isFile: mocks.isFile, nlink: 2 });

    await expect(createSafeLocalLogger("test-workspace", "linux")).rejects.toThrow(
      "安全日志路径不能存在额外硬链接",
    );
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.handleChmod).not.toHaveBeenCalled();
  });
});
