import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverWorkspaces } from "../workspace/discover-workspaces.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function fileExists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function validateWorkspaceScripts(root, scriptName) {
  const errors = [];
  const workspaces = await discoverWorkspaces(root);

  if (workspaces.length === 0) {
    errors.push(
      "pnpm-workspace.yaml: no product workspaces were discovered. Fix: add an app, package, or adapter with package.json.",
    );
  }

  for (const workspace of workspaces) {
    const manifestPath = `${workspace.relativePath}/package.json`;
    if (workspace.manifest === null) {
      errors.push(
        `${manifestPath}: workspace manifest is missing. Fix: add package.json with explicit type and build scripts.`,
      );
      continue;
    }

    if (typeof workspace.manifest.scripts?.[scriptName] !== "string") {
      errors.push(
        `${manifestPath}: missing '${scriptName}' script. Fix: define a real ${scriptName} command for this workspace.`,
      );
    }

    if (
      scriptName === "type" &&
      !(await fileExists(path.join(workspace.absolutePath, "tsconfig.json")))
    ) {
      errors.push(
        `${workspace.relativePath}/tsconfig.json: required type configuration is missing. Fix: add an explicit workspace TypeScript config.`,
      );
    }
  }

  return { errors, workspaces };
}

export async function runWorkspaceScript(root, scriptName) {
  const { errors, workspaces } = await validateWorkspaceScripts(root, scriptName);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 1;
  }

  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) {
    console.error(
      `package.json: '${scriptName}' must be invoked through pnpm. Fix: run 'pnpm ${scriptName}'.`,
    );
    return 1;
  }

  for (const workspace of workspaces) {
    const result = spawnSync(
      process.execPath,
      [packageManagerCli, "--dir", workspace.absolutePath, "run", scriptName],
      { env: process.env, stdio: "inherit" },
    );

    if (result.status !== 0) {
      console.error(
        `${workspace.relativePath}/package.json: '${scriptName}' failed. Fix: resolve the reported workspace error before retrying.`,
      );
      return result.status ?? 1;
    }
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scriptName = process.argv[2];
  if (scriptName !== "type" && scriptName !== "build") {
    console.error(
      "package.json: workspace runner requires 'type' or 'build'. Fix: use a declared root quality command.",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = await runWorkspaceScript(repositoryRoot, scriptName);
  }
}
