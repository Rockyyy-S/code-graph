import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(relativePath)) as Record<string, unknown>;
}

describe("root toolchain contract", () => {
  it("pins Node, pnpm, TypeScript and exposes every required quality command", async () => {
    const packageJson = await readJson("package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const devDependencies = packageJson.devDependencies as Record<string, string>;

    expect(packageJson.packageManager).toBe("pnpm@11.12.0");
    expect(packageJson.engines).toEqual({ node: "24.18.0", pnpm: "11.12.0" });
    expect(devDependencies.typescript).toBe("6.0.3");
    expect(Object.keys(scripts)).toEqual(
      expect.arrayContaining([
        "type",
        "lint",
        "unit",
        "build",
        "contract",
        "dependency-boundary",
        "basic-security",
      ]),
    );

    for (const command of Object.values(scripts)) {
      expect(command).not.toMatch(/--if-present|\|\|\s*true|continue-on-error/);
    }
  });

  it("declares the exact non-nested workspace roots and frozen installs", async () => {
    const workspace = await readText("pnpm-workspace.yaml");
    const npmrc = await readText(".npmrc");
    const lockfile = await readText("pnpm-lock.yaml");

    expect(workspace).toContain("- 'apps/*'");
    expect(workspace).toContain("- 'packages/*'");
    expect(workspace).toContain("- 'packages/adapters/*'");
    expect(workspace).not.toContain("packages/application/*");
    expect(workspace).toContain("allowBuilds:\n  esbuild: true");
    expect(npmrc).toContain("frozen-lockfile=true");
    expect(npmrc).toContain("engine-strict=true");
    expect(lockfile).toContain("lockfileVersion: '9.0'");
  });

  it("pins Node consistently across version files", async () => {
    await expect(readText(".node-version")).resolves.toBe("24.18.0\n");
    await expect(readText(".nvmrc")).resolves.toBe("24.18.0\n");
  });
});
