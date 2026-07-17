import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("repository responsibility documentation", () => {
  it("documents every workspace owner and dependency direction", async () => {
    const document = await readFile(
      path.join(repositoryRoot, "docs/repository-layout.md"),
      "utf8",
    );

    for (const workspace of [
      "apps/graph-service",
      "apps/cli",
      "apps/extension",
      "apps/webview",
      "packages/domain",
      "packages/application",
      "packages/contracts",
      "packages/service-client",
      "packages/adapters/*",
    ]) {
      expect(document).toContain(`\`${workspace}\``);
    }
    expect(document).toContain("唯一组合根");
    expect(document).toContain("禁止通用 `utils`");
  });

  it("documents every root quality command and extension provenance", async () => {
    const document = await readFile(
      path.join(repositoryRoot, "docs/repository-layout.md"),
      "utf8",
    );

    for (const command of [
      "pnpm type",
      "pnpm lint",
      "pnpm unit",
      "pnpm build",
      "pnpm contract",
      "pnpm dependency-boundary",
      "pnpm basic-security",
    ]) {
      expect(document).toContain(`\`${command}\``);
    }
    expect(document).toContain("generator-code@1.12.0");
    expect(document).toContain("模板不代表产品 UX 已完成");
  });
});
