import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  MAX_CANDIDATE_SOURCE_FILES,
  MAX_SCANNED_ENTRIES,
  scanWorkspace,
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
    expect(result.excludedPathCount).toBeGreaterThanOrEqual(2);
  });

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

  it("fails closed before accessing a POSIX name containing a backslash", async () => {
    const root = "/trusted/root";
    const state = await createInitialIgnoreState(await createRoot("codegraph-scan-backslash-"));
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    const lstat = vi.fn(async () => ({
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
    expect(lstat).toHaveBeenCalledTimes(1);
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
