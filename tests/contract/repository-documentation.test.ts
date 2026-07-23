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
      "pnpm planning-trace",
      "pnpm architecture-required",
    ]) {
      expect(document).toContain(`\`${command}\``);
    }
    expect(document).toContain("`ci/quality-gates.v1.yaml`");
    expect(document).toContain("`Rockyyy-S/code-graph-gate-controller`");
    expect(document).toContain("child evidence");
    expect(document).toContain("generator-code@1.12.0");
    expect(document).toContain("模板不代表产品 UX 已完成");
  });

  it("records Story 1.3 hosted child evidence and unresolved provider activation", async () => {
    const document = await readFile(
      path.join(repositoryRoot, "docs/ci/story-1-3-provider-evidence.md"),
      "utf8",
    );

    for (const evidence of [
      "29979602524",
      "d54be3b34eddc55c3e7f65dafe8682718290904a",
      "d1b9e3c2529514dfbe4a058ed4d17f86d4e24e05951a4391ddf09161eb113378",
      "1d0d0e573bb8fd5ece802335d89246f0caeaf4965bf59b99f0345f73ed529f44",
      "Rockyyy-S/code-graph-gate-controller",
      "待激活",
    ]) {
      expect(document).toContain(evidence);
    }
  });
});
