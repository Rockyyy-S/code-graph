import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverWorkspaces } from "../../scripts/workspace/discover-workspaces.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("TypeScript project references", () => {
  it("matches every internal manifest dependency with a build reference", async () => {
    const workspaces = await discoverWorkspaces(repositoryRoot);
    const byName = new Map(
      workspaces
        .filter(({ manifest }) => typeof manifest?.name === "string")
        .map((workspace) => [workspace.manifest.name as string, workspace]),
    );

    for (const workspace of workspaces) {
      if (!workspace.manifest) {
        continue;
      }
      const configName =
        workspace.relativePath === "apps/extension" ? "tsconfig.json" : "tsconfig.build.json";
      const config = JSON.parse(
        await readFile(path.join(workspace.absolutePath, configName), "utf8"),
      ) as { references?: Array<{ path: string }> };
      const actualTargets = new Set(
        (config.references ?? []).map(({ path: referencePath }) =>
          path.resolve(workspace.absolutePath, referencePath),
        ),
      );
      const expectedTargets = new Set(
        Object.keys(workspace.manifest.dependencies ?? {})
          .map((dependencyName) => byName.get(dependencyName))
          .filter((target) => target !== undefined)
          .map((target) => path.join(target.absolutePath, "tsconfig.build.json")),
      );

      expect(actualTargets, workspace.relativePath).toEqual(expectedTargets);
    }
  });
});
