import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Graph Edge Identity v1 文档合同", () => {
  it("声明 ModuleExportName ASCII 逃逸及其 canonical 边界", async () => {
    const protocol = await readFile("docs/protocol/graph-edge-identity-v1.md", "utf8");

    expect(protocol).toMatch(/ModuleExportName.*ASCII.*逃逸/u);
    expect(protocol).toMatch(/~e.*空/u);
    expect(protocol).toMatch(/孤立 UTF-16 代理项.*~uXXXX\.\.\./u);
    expect(protocol).toMatch(/仅适用于.*合法 `ModuleExportName`/u);
    expect(protocol).toMatch(/`~`.*`%7E`/u);
    expect(protocol).toMatch(/decode.*re-encode|解码.*重新编码/u);
    expect(protocol).toMatch(/持久化 qualifier.*lone surrogate/u);
    expect(protocol).toMatch(/字面.*`%u`.*`%25u`/u);
    expect(protocol).toMatch(/内部.*`%u`.*fail-closed|内部.*`%u`.*拒绝/u);
  });
});
