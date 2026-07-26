import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  MAX_CANDIDATE_SOURCE_FILES,
  MAX_SOURCE_FILE_BYTES,
  MAX_SCANNED_ENTRIES,
  MAX_TOTAL_SOURCE_BYTES,
  scanWorkspace,
  verifyWorkspaceReadSetSync,
} from "../../apps/graph-service/src/workspace-scanner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建扫描测试目录并登记清理。 */
async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("workspace scanner", () => {
  it("returns only supported files after builtin filtering", async () => {
    const root = await createRoot("codegraph-scan-");
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "src", "index.ts"), "export {};\n");
    await writeFile(path.join(root, "src", "nested", "view.jsx"), "export {};\n");
    await writeFile(path.join(root, "src", "data.json"), "{}\n");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x\n");
    await writeFile(path.join(root, "dist", "bundle.js"), "x\n");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }

    const result = await scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    });

    expect(result.candidateFiles).toEqual(["src/index.ts", "src/nested/view.jsx"]);
    expect(result.manifest).toEqual([
      {
        contentHash: "8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881",
        path: "src/index.ts",
      },
      {
        contentHash: "8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881",
        path: "src/nested/view.jsx",
      },
    ]);
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.excludedPathCount).toBeGreaterThanOrEqual(2);
  });

  it("hashes raw opened bytes and rejects files above the 10 MiB boundary", async () => {
    const root = await createRoot("codegraph-scan-hash-limit-");
    const allowed = Buffer.alloc(MAX_SOURCE_FILE_BYTES, 0x61);
    await writeFile(path.join(root, "allowed.ts"), allowed);
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).resolves.toMatchObject({
      manifest: [{ path: "allowed.ts" }],
    });

    await writeFile(path.join(root, "too-large.ts"), Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 0x62));
    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_LIMIT_EXCEEDED" });
  }, 30_000);

  it("does not follow a symlink that can escape the indexing root", async () => {
    const root = await createRoot("codegraph-scan-root-");
    const outside = await createRoot("codegraph-scan-outside-");
    await writeFile(path.join(outside, "secret.ts"), "export {};\n");
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).resolves.toMatchObject({ candidateFiles: [] });
  });

  it("rejects a source hard link whose alias can bypass the workspace watcher", async () => {
    const root = await createRoot("codegraph-scan-hardlink-");
    const outside = await createRoot("codegraph-scan-hardlink-outside-");
    const outsideAlias = path.join(outside, "alias.ts");
    await writeFile(outsideAlias, "export const value = 1;\n");
    await link(outsideAlias, path.join(root, "index.ts"));
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
  });

  it("rejects a trusted root replaced by a junction or symlink after startup", async () => {
    const root = await createRoot("codegraph-scan-root-swap-");
    const outside = await createRoot("codegraph-scan-root-swap-outside-");
    await writeFile(path.join(outside, "secret.ts"), "export {};\n");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const originalRoot = `${root}-original`;
    await rename(root, originalRoot);
    roots.push(originalRoot);
    await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
  });

  it("fails when a directory is replaced after containment validation but before traversal completes", async () => {
    const root = "/trusted/root";
    const state = await createInitialIgnoreState(await createRoot("codegraph-scan-race-"));
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let childRead = false;

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat: async (input) => ({
        isDirectory: () => input.endsWith("child") || input === root,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      platform: "linux",
      readDirectory: async (input) => {
        if (input === root) {
          return [{
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
            name: "child",
          }];
        }
        childRead = true;
        return [];
      },
      realpath: async (input) =>
        input.endsWith("child") && childRead ? "/outside/replaced" : input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
  });

  it("uses raw filesystem names while publishing NFC graph paths", async () => {
    const root = await createRoot("codegraph-scan-unicode-");
    await writeFile(path.join(root, "e\u0301.ts"), "export {};\n");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).resolves.toMatchObject({ candidateFiles: ["é.ts"] });
  });

  it("sorts Unicode manifest paths without depending on the host locale", async () => {
    const root = await createRoot("codegraph-scan-unicode-order-");
    await writeFile(path.join(root, "z.ts"), "export const z = 1;\n");
    await writeFile(path.join(root, "ä.ts"), "export const umlaut = 1;\n");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    })).resolves.toMatchObject({ candidateFiles: ["z.ts", "ä.ts"] });
  });

  it("stops at the first byte beyond 10 MiB when a file grows during reading", async () => {
    const root = "/trusted/root";
    const state = await createInitialIgnoreState(await createRoot("codegraph-scan-growing-file-"));
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    let emittedBytes = 0;
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const remaining = MAX_SOURCE_FILE_BYTES + 1 - emittedBytes;
      const bytesRead = Math.max(0, Math.min(length, remaining));
      buffer.fill(0x61, offset, offset + bytesRead);
      emittedBytes += bytesRead;
      return { bytesRead };
    });
    const close = vi.fn(async () => undefined);

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat: async (input) => ({
        dev: 1n,
        ino: input === root ? 1n : 2n,
        isDirectory: () => input === root,
        isFile: () => input !== root,
        isSymbolicLink: () => false,
      }),
      openFile: async () => ({
        close,
        read,
        stat: async () => ({
          ctimeNs: 1n,
          dev: 1n,
          ino: 2n,
          isFile: () => true,
          mtimeNs: 1n,
          size: BigInt(MAX_SOURCE_FILE_BYTES),
        }),
      }),
      platform: "linux",
      readDirectory: async () => [{
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        name: "growing.ts",
      }],
      realpath: async (input) => input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_LIMIT_EXCEEDED" });
    expect(emittedBytes).toBe(MAX_SOURCE_FILE_BYTES + 1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects an opened handle whose physical identity differs before reading bytes", async () => {
    const root = "/trusted/root";
    const state = await createInitialIgnoreState(await createRoot("codegraph-scan-open-identity-"));
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const read = vi.fn(async () => ({ bytesRead: 0 }));
    let fileStatusReads = 0;

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat: async (input) => ({
        dev: 1n,
        ino: input === root ? 1n : (++fileStatusReads, 2n),
        isDirectory: () => input === root,
        isFile: () => input !== root,
        isSymbolicLink: () => false,
      }),
      openFile: async () => ({
        close: async () => undefined,
        read,
        stat: async () => ({
          ctimeNs: 1n,
          dev: 9n,
          ino: 9n,
          isFile: () => true,
          mtimeNs: 1n,
          size: 1n,
        }),
      }),
      platform: "win32",
      readDirectory: async () => [{
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        name: "swapped.ts",
      }],
      realpath: async (input) => input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
    expect(read).not.toHaveBeenCalled();
    expect(fileStatusReads).toBe(2);
  });

  it("closes a file handle that resolves after scan cancellation", async () => {
    const root = await createRoot("codegraph-scan-abort-open-");
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    let signalOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      signalOpenStarted = resolve;
    });
    let resolveHandle!: (handle: {
      close: () => Promise<void>;
      read: () => Promise<{ bytesRead: number }>;
      stat: () => Promise<never>;
    }) => void;
    const lateHandle = new Promise<{
      close: () => Promise<void>;
      read: () => Promise<{ bytesRead: number }>;
      stat: () => Promise<never>;
    }>((resolve) => {
      resolveHandle = resolve;
    });
    const scan = scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      openFile: async () => {
        signalOpenStarted();
        return lateHandle;
      },
      signal: controller.signal,
    });
    await openStarted;
    controller.abort();
    await expect(scan).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
    resolveHandle({
      close,
      read: async () => ({ bytesRead: 0 }),
      stat: async () => new Promise<never>(() => undefined),
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("fails closed before accessing a POSIX name containing a backslash", async () => {
    const root = "/trusted/root";
    const state = await createInitialIgnoreState(await createRoot("codegraph-scan-backslash-"));
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const lstat = vi.fn(async (_input: string) => ({
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    }));

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat,
      platform: "linux",
      readDirectory: async () => [
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "a\\b.ts" },
      ],
      realpath: async (input) => input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_FAILED" });
    expect(lstat).toHaveBeenCalled();
    expect(lstat.mock.calls.every(([input]) => input === root)).toBe(true);
  });

  it("fails instead of truncating when the source-file budget is exceeded", async () => {
    const root = await createRoot("codegraph-scan-limit-");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat: async () => ({
        isDirectory: () => true,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
      maxCandidateFiles: 1,
      readDirectory: async () => [
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "a.ts" },
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "b.ts" },
      ],
      realpath: async (input) => input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_LIMIT_EXCEEDED" });
    expect(MAX_CANDIDATE_SOURCE_FILES).toBe(20_000);
  });

  it("rejects the total source-byte budget before opening candidate files", async () => {
    const root = "/trusted/root";
    const state = await createInitialIgnoreState(await createRoot("codegraph-scan-byte-budget-"));
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const openFile = vi.fn();

    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat: async (input) => ({
        dev: 1n,
        ino: input === root ? 1n : input.endsWith("a.ts") ? 2n : 3n,
        isDirectory: () => input === root,
        isFile: () => input !== root,
        isSymbolicLink: () => false,
        nlink: 1n,
        size: input === root ? 0n : 6n,
      }),
      maxTotalSourceBytes: 10,
      openFile,
      platform: "linux",
      readDirectory: async () => [
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "a.ts" },
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "b.ts" },
      ],
      realpath: async (input) => input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_LIMIT_EXCEEDED" });
    expect(openFile).not.toHaveBeenCalled();
    expect(MAX_TOTAL_SOURCE_BYTES).toBe(512 * 1024 * 1024);
  });

  it("enforces the total source-byte budget in the synchronous commit replay", async () => {
    const root = await createRoot("codegraph-sync-byte-budget-");
    await writeFile(path.join(root, "a.ts"), "aaaaaa");
    await writeFile(path.join(root, "b.ts"), "bbbbbb");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const scan = await scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
    });

    expect(() => verifyWorkspaceReadSetSync({
      expectedManifest: scan.manifest,
      forceContentHash: true,
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      maxTotalSourceBytes: 10,
    })).toThrow(expect.objectContaining({ code: "GRAPH_SCAN_LIMIT_EXCEEDED" }));
  });

  it("bounds total directory entries even when none are source files", async () => {
    const root = await createRoot("codegraph-scan-entry-limit-");
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    await expect(scanWorkspace({
      ignoreSnapshot: state.snapshot,
      indexingRoot: root,
      lstat: async () => ({
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
      maxScannedEntries: 1,
      readDirectory: async () => [
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "a.txt" },
        { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, name: "b.txt" },
      ],
      realpath: async (input) => input,
    })).rejects.toMatchObject({ code: "GRAPH_SCAN_LIMIT_EXCEEDED" });
    expect(MAX_SCANNED_ENTRIES).toBe(100_000);
  });
});
