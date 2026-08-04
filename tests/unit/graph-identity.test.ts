import { describe, expect, it } from "vitest";
import {
  buildGraphEdgeId,
  buildGraphEntityId,
  buildLegacyGraphEdgeIdV0,
  normalizeRelativeGraphPath,
} from "../../packages/domain/src/index.js";

const workspaceKey = "a".repeat(64);

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

  it("locks the AD-4 v1 RFC 8785/UTF-8/SHA-256 fixed vectors", () => {
    const vectors = [
      {
        digest: "67b81de9279b2e6d49d31b24c6289d0cb296107a3925c2c88f55b05df8c6ebde",
        fromId: `cg://${workspaceKey}/workspace/`,
        qualifier: "",
        relationType: "contains" as const,
        toId: `cg://${workspaceKey}/file/src/index.ts`,
      },
      {
        digest: "a41e03f3d331edf2191401f78c5d413ff866bd27c9b8fbba3f0893bb121b8e1d",
        fromId: `cg://${workspaceKey}/file/src/index.ts`,
        qualifier: "value",
        relationType: "imports" as const,
        toId: "node:path",
      },
      {
        digest: "41290605ed11ffb3f44e8af1a11aef46fa59ef24787f5ffcf8147bfb60e93936",
        fromId: `cg://${workspaceKey}/file/src/index.ts`,
        qualifier: "type",
        relationType: "imports" as const,
        toId: "node:path",
      },
      {
        digest: "022d9678db48af7104ed59891ecaef56302ae0c9eee75b1ebabd9dc47077481c",
        fromId: `cg://${workspaceKey}/file/src/组件.ts`,
        qualifier: "reexport:%E7%BB%84%E4%BB%B6:value:value",
        relationType: "exports" as const,
        toId: "pkg:npm/%40scope/pkg@1.2.3",
      },
    ];
    for (const vector of vectors) {
      expect(buildGraphEdgeId(
        workspaceKey,
        vector.fromId,
        vector.relationType,
        vector.toId,
        vector.qualifier,
      )).toBe(`cg://${workspaceKey}/edge/v1/${vector.digest}`);
    }
  });

  it("rejects noncanonical Unicode and lone surrogates instead of silently normalizing", () => {
    const target = `cg://${workspaceKey}/file/src/target.ts`;
    expect(() => buildGraphEdgeId(
      workspaceKey,
      `cg://${workspaceKey}/file/src/cafe\u0301.ts`,
      "imports",
      target,
      "value",
    )).toThrow(/NFC/u);
    expect(() => buildGraphEdgeId(
      workspaceKey,
      `cg://${workspaceKey}/file/src/\uD800.ts`,
      "imports",
      target,
      "value",
    )).toThrow(/代理项/u);
  });

  it("separates workspace and qualifier domains and never emits legacy IDs canonically", () => {
    const fromId = `cg://${workspaceKey}/file/src/index.ts`;
    const toId = "node:path";
    const valueId = buildGraphEdgeId(workspaceKey, fromId, "imports", toId, "value");
    const typeId = buildGraphEdgeId(workspaceKey, fromId, "imports", toId, "type");
    expect(valueId).not.toBe(typeId);
    expect(valueId).not.toBe(buildGraphEdgeId("b".repeat(64), fromId, "imports", toId, "value"));
    expect(valueId).toMatch(/^cg:\/\/[a-f0-9]{64}\/edge\/v1\/[a-f0-9]{64}$/u);
    expect(buildLegacyGraphEdgeIdV0(workspaceKey, fromId, "imports", toId, "value"))
      .not.toBe(valueId);
  });
});
