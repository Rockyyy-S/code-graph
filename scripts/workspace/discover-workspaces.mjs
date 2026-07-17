import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workspaceGroups = [
  { directory: "apps", kind: "app" },
  { directory: "packages", kind: "package", excludedNames: new Set(["adapters"]) },
  { directory: "packages/adapters", kind: "adapter" },
];

async function listDirectories(absoluteDirectory) {
  try {
    return (await readdir(absoluteDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function discoverWorkspaces(repositoryRoot) {
  const workspaces = [];

  for (const group of workspaceGroups) {
    const absoluteGroup = path.join(repositoryRoot, ...group.directory.split("/"));
    const names = await listDirectories(absoluteGroup);

    for (const name of names) {
      // packages/adapters is a grouping directory, not an additional nested workspace.
      if (group.excludedNames?.has(name)) {
        continue;
      }

      const relativePath = `${group.directory}/${name}`;
      const manifestPath = path.join(repositoryRoot, ...relativePath.split("/"), "package.json");
      let manifest = null;

      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if (!(error && typeof error === "object" && error.code === "ENOENT")) {
          throw error;
        }
      }

      workspaces.push({
        absolutePath: path.join(repositoryRoot, ...relativePath.split("/")),
        kind: group.kind,
        manifest,
        relativePath,
      });
    }
  }

  return workspaces;
}
