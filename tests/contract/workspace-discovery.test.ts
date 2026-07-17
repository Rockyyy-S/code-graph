import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverWorkspaces } from "../../scripts/workspace/discover-workspaces.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createWorkspace(relativePath: string): Promise<string> {
  const root =
    temporaryRoots[0] ??
    (await mkdtemp(path.join(tmpdir(), "codegraph-workspace-discovery-")));
  if (temporaryRoots.length === 0) {
    temporaryRoots.push(root);
  }

  const directory = path.join(root, ...relativePath.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: `fixture-${relativePath.replaceAll("/", "-")}` }),
    "utf8",
  );
  return root;
}

describe("workspace discovery", () => {
  it("automatically finds new top-level apps, packages and adapters", async () => {
    const root = await createWorkspace("apps/new-app");
    await createWorkspace("packages/new-package");
    await createWorkspace("packages/adapters/new-adapter");

    const discovered = await discoverWorkspaces(root);

    expect(discovered.map(({ relativePath }) => relativePath)).toEqual([
      "apps/new-app",
      "packages/new-package",
      "packages/adapters/new-adapter",
    ]);
  });

  it("does not treat nested application modules as workspaces", async () => {
    const root = await createWorkspace("packages/application");
    await mkdir(path.join(root, "packages/application/indexing"), { recursive: true });

    const discovered = await discoverWorkspaces(root);

    expect(discovered.map(({ relativePath }) => relativePath)).toEqual([
      "packages/application",
    ]);
  });
});
