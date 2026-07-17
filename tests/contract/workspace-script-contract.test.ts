import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkspaceScripts } from "../../scripts/quality/run-workspace-script.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace script contract", () => {
  it("rejects a type command that can succeed without checking source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-workspace-script-"));
    temporaryRoots.push(root);
    const workspaceRoot = path.join(root, "apps", "sample");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "@codegraph/sample",
        scripts: { type: 'node -e "process.exit(0)"' },
      }),
      "utf8",
    );
    await writeFile(path.join(workspaceRoot, "tsconfig.json"), "{}", "utf8");

    const result = await validateWorkspaceScripts(root, "type");

    expect(result.errors.join("\n")).toContain("real TypeScript type command");
  });
});
