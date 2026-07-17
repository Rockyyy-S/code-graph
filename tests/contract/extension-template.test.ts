import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const extensionRoot = path.join(repositoryRoot, "apps/extension");

async function readExtensionFile(relativePath: string): Promise<string> {
  return readFile(path.join(extensionRoot, relativePath), "utf8");
}

describe("official VS Code extension template contract", () => {
  it("pins the VS Code API floor and esbuild from the locked template stack", async () => {
    const manifest = JSON.parse(await readExtensionFile("package.json")) as {
      activationEvents: string[];
      contributes: Record<string, unknown>;
      devDependencies: Record<string, string>;
      engines: { vscode: string };
      main: string;
    };

    expect(manifest.engines.vscode).toBe("^1.125.0");
    expect(manifest.devDependencies["@types/vscode"]).toBe("1.125.0");
    expect(manifest.devDependencies.esbuild).toBe("0.28.1");
    expect(manifest.main).toBe("./dist/extension.js");
    expect(manifest.activationEvents).toEqual([]);
    expect(manifest.contributes).toEqual({});

    const esbuildConfig = await readExtensionFile("esbuild.mjs");
    expect(esbuildConfig).toContain("bundle: true");
    expect(esbuildConfig).toContain('external: ["vscode"]');
  });

  it("removes Hello World behavior and keeps activation side-effect free", async () => {
    const source = await readExtensionFile("src/extension.ts");

    expect(source).not.toMatch(/helloWorld|registerCommand|showInformationMessage/);
    expect(source).toContain("export function activate");
    expect(source).toContain("export function deactivate");
  });

  it("records generator provenance and never nests a Git repository", async () => {
    const origin = await readExtensionFile("TEMPLATE_ORIGIN.md");

    expect(origin).toContain("generator-code@1.12.0");
    expect(origin).toContain("--pkgManager=pnpm");
    expect(origin).toContain("--bundler=esbuild");
    expect(origin).toContain("--no-gitInit");
    await expect(access(path.join(extensionRoot, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
