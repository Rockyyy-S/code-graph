import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("architecture-required workflow", () => {
  it("runs on every pull request and protected default-branch push", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/architecture-required.yml"),
      "utf8",
    );

    expect(workflow).toContain("name: architecture-required");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("- main");
    expect(workflow).not.toMatch(/paths(?:-ignore)?:/);
  });

  it("pins the toolchain, installs frozen, and executes all seven gates", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/architecture-required.yml"),
      "utf8",
    );

    expect(workflow).toContain("node-version: 24.18.0");
    expect(workflow).toContain("version: 11.12.0");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    for (const gate of [
      "type",
      "lint",
      "unit",
      "build",
      "contract",
      "dependency-boundary",
      "basic-security",
    ]) {
      expect(workflow).toContain(`run: pnpm ${gate}`);
    }
    expect(workflow).not.toMatch(/continue-on-error|\|\|\s*true/);
  });

  it("publishes the stable architecture-required job name", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/architecture-required.yml"),
      "utf8",
    );

    expect(workflow).toMatch(/jobs:\s+architecture-required:\s+name: architecture-required/s);
  });
});
