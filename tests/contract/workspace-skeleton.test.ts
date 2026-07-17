import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspaces } from "../../scripts/workspace/discover-workspaces.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const expectedWorkspaces = [
  "apps/cli",
  "apps/extension",
  "apps/graph-service",
  "apps/webview",
  "packages/application",
  "packages/contracts",
  "packages/domain",
  "packages/service-client",
  "packages/adapters/analyzer-typescript",
  "packages/adapters/git-local",
  "packages/adapters/store-sqlite",
];

describe("workspace responsibility skeleton", () => {
  it("creates every app, core package and adapter as an explicit workspace", async () => {
    const workspaces = await discoverWorkspaces(repositoryRoot);

    expect(workspaces.map(({ relativePath }) => relativePath)).toEqual(
      expectedWorkspaces,
    );

    for (const workspace of workspaces) {
      expect(workspace.manifest, `${workspace.relativePath}/package.json`).not.toBeNull();
      expect(workspace.manifest?.private).toBe(true);
      expect(workspace.manifest?.scripts).toMatchObject({
        build: expect.any(String),
        type: expect.any(String),
      });
      await expect(
        access(path.join(workspace.absolutePath, "tsconfig.json")),
      ).resolves.toBeUndefined();
      await expect(
        access(path.join(workspace.absolutePath, "src")),
      ).resolves.toBeUndefined();
    }
  });

  it("does not create a responsibility-free utils workspace", async () => {
    const workspaces = await discoverWorkspaces(repositoryRoot);

    expect(
      workspaces.some(({ relativePath }) => /(^|\/)utils?$/.test(relativePath)),
    ).toBe(false);
  });

  it("keeps graph-service as the only workspace that composes adapters", async () => {
    const workspaces = await discoverWorkspaces(repositoryRoot);
    const adapterNames = new Set(
      workspaces
        .filter(({ kind }) => kind === "adapter")
        .map(({ manifest }) => manifest?.name),
    );

    for (const workspace of workspaces) {
      const dependencies = Object.keys(workspace.manifest?.dependencies ?? {});
      const adapterDependencies = dependencies.filter((name) => adapterNames.has(name));

      if (workspace.relativePath === "apps/graph-service") {
        expect(adapterDependencies).toHaveLength(3);
      } else {
        expect(adapterDependencies, workspace.relativePath).toEqual([]);
      }
    }
  });
});
