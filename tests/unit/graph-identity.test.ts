import { describe, expect, it } from "vitest";
import {
  buildGraphEntityId,
  normalizeRelativeGraphPath,
} from "../../packages/domain/src/index.js";

describe("graph identity", () => {
  it("normalizes workspace-relative paths to Unicode NFC and POSIX separators", () => {
    expect(normalizeRelativeGraphPath("src\\cafe\u0301\\index.ts")).toBe(
      "src/café/index.ts",
    );
    expect(normalizeRelativeGraphPath("src/./index.ts")).toBe("src/index.ts");
  });

  it("rejects absolute, escaping, NUL, and empty non-root paths", () => {
    expect(() => normalizeRelativeGraphPath("/src/index.ts")).toThrow();
    expect(() => normalizeRelativeGraphPath("C:\\src\\index.ts")).toThrow();
    expect(() => normalizeRelativeGraphPath("../index.ts")).toThrow();
    expect(() => normalizeRelativeGraphPath("src/../../index.ts")).toThrow();
    expect(() => normalizeRelativeGraphPath("src/\0index.ts")).toThrow();
  });

  it("builds deterministic workspace-scoped cg identifiers without host paths", () => {
    const workspaceKey = "a".repeat(64);
    expect(buildGraphEntityId(workspaceKey, "workspace", "")).toBe(
      `cg://${workspaceKey}/workspace/`,
    );
    expect(buildGraphEntityId(workspaceKey, "directory", "src/组件")).toBe(
      `cg://${workspaceKey}/directory/src/%E7%BB%84%E4%BB%B6/`,
    );
    expect(buildGraphEntityId(workspaceKey, "file", "src/组件/a b.ts")).toBe(
      `cg://${workspaceKey}/file/src/%E7%BB%84%E4%BB%B6/a%20b.ts`,
    );
    expect(
      buildGraphEntityId(workspaceKey, "file", "src/组件/a b.ts"),
    ).not.toContain("\\");
  });
});
