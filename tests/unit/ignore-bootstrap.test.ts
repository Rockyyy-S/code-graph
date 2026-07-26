import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_IGNORE_V1,
  createInitialIgnoreState,
  isBuiltinIgnoredPath,
} from "../../apps/graph-service/src/ignore-bootstrap.js";
import { sha256CanonicalJson } from "../../packages/contracts/src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建隔离的首次配置工作区。 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-ignore-"));
  roots.push(root);
  return root;
}

describe("initial ignore barrier", () => {
  it("creates the exact generation zero snapshot when no user file exists", async () => {
    const root = await createRoot();
    const state = await createInitialIgnoreState(root);

    expect(BUILTIN_IGNORE_V1).toEqual([
      "/.git/",
      "**/node_modules/",
      "**/.pnpm/",
      "**/dist/",
      "**/build/",
      "**/out/",
      "**/coverage/",
      "**/.next/",
      "**/.nuxt/",
      "**/.svelte-kit/",
      "**/.turbo/",
      "**/.cache/",
      "**/generated/",
      "**/.generated/",
      "**/__generated__/",
    ]);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    expect(state.snapshot).toMatchObject({
      builtinRulesVersion: "builtin-ignore-v1",
      contentHash: null,
      effectiveRules: BUILTIN_IGNORE_V1,
      generation: 0,
      userRules: [],
      validity: "valid",
      version: 1,
    });
    expect(state.snapshot.effectiveDigest).toBe(
      sha256CanonicalJson({
        builtinRulesVersion: "builtin-ignore-v1",
        effectiveRules: BUILTIN_IGNORE_V1,
        version: 1,
      }),
    );
    expect(state.snapshot.lastValidDigest).toBe(state.snapshot.effectiveDigest);
  });

  it("fails closed for any existing .codegraphignore object", async () => {
    for (const kind of ["file", "directory"] as const) {
      const root = await createRoot();
      const ignorePath = path.join(root, ".codegraphignore");
      if (kind === "file") {
        await writeFile(ignorePath, "dist/\n", "utf8");
      } else {
        await mkdir(ignorePath);
      }
      await expect(createInitialIgnoreState(root)).resolves.toEqual({
        kind: "unsupported-user-config",
      });
    }
  });

  it("fails closed for a case-variant reserved ignore name", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, ".CodeGraphIgnore"), "dist/\n", "utf8");

    await expect(createInitialIgnoreState(root)).resolves.toEqual({
      kind: "unsupported-user-config",
    });
  });

  it("matches every builtin category without treating ordinary source as ignored", async () => {
    const root = await createRoot();
    const state = await createInitialIgnoreState(root);
    if (state.kind !== "ready") {
      throw new Error("测试前置条件不成立。");
    }
    for (const candidate of [
      ".git/config",
      "node_modules/a/index.js",
      "packages/a/.pnpm/cache.json",
      "dist/index.js",
      "packages/a/build/index.js",
      "out/index.js",
      "coverage/result.json",
      ".next/server.js",
      ".nuxt/app.js",
      ".svelte-kit/app.js",
      ".turbo/cache.json",
      ".cache/value",
      "src/generated/a.ts",
      "src/.generated/a.ts",
      "src/__generated__/a.ts",
    ]) {
      expect(isBuiltinIgnoredPath(candidate, state.snapshot)).toBe(true);
    }
    expect(isBuiltinIgnoredPath("src/index.ts", state.snapshot)).toBe(false);
  });
});
