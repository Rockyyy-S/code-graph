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

  it("records Story 1.3 hosted failure, provider activation, drift and recovery evidence", async () => {
    const document = await readFile(
      path.join(repositoryRoot, "docs/ci/story-1-3-provider-evidence.md"),
      "utf8",
    );

    for (const evidence of [
      "29987139754",
      "29987237267",
      "e416735c0d42d84324dd3c6dacd4235ae44cd3df",
      "29987370737",
      "19603163",
      "4372284",
      "4372296",
      "29987529815",
      "29987637959",
      "30033569375",
      "30058268244",
      "21b35a8408468c1c71800dcf2408497047a3aab429bed3a0bfc515077c4c56fe",
      "c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec",
      "962913710943c77513433362224ede7ff1279075cfe316d4419278cc6a15ee47",
      "Rockyyy-S/code-graph-gate-controller",
      "已激活",
    ]) {
      expect(document).toContain(evidence);
    }
  });
});
