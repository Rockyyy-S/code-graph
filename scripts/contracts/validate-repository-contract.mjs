import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { discoverWorkspaces } from "../workspace/discover-workspaces.mjs";

const requiredScripts = [
  "type",
  "lint",
  "unit",
  "build",
  "contract",
  "dependency-boundary",
  "basic-security",
];
const ignoredDirectoryNames = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function violation(relativePath, rule, message, suggestion) {
  return { message, relativePath: toPosix(relativePath), rule, suggestion };
}

async function readText(root, relativePath, violations) {
  try {
    return await readFile(path.join(root, ...relativePath.split("/")), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      violations.push(
        violation(
          relativePath,
          "required-file",
          `${relativePath} is missing.`,
          `restore ${relativePath} from the repository template`,
        ),
      );
      return null;
    }
    throw error;
  }
}

async function readJson(root, relativePath, violations) {
  const source = await readText(root, relativePath, violations);
  if (source === null) {
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    violations.push(
      violation(
        relativePath,
        "valid-json",
        `${relativePath} is not valid JSON.`,
        "fix the syntax without weakening the contract",
      ),
    );
    return null;
  }
}

async function collectProductManifests(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, ...relativeDirectory.split("/"));
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const manifests = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      manifests.push(...(await collectProductManifests(root, relativePath)));
    } else if (entry.name === "package.json") {
      manifests.push(relativePath);
    }
  }
  return manifests;
}

export async function validateRepositoryContract(root) {
  const violations = [];
  const rootManifest = await readJson(root, "package.json", violations);
  const workspaceSource = await readText(root, "pnpm-workspace.yaml", violations);
  const nodeVersion = await readText(root, ".node-version", violations);
  const nvmVersion = await readText(root, ".nvmrc", violations);
  const extensionManifest = await readJson(
    root,
    "apps/extension/package.json",
    violations,
  );

  if (rootManifest) {
    for (const script of requiredScripts) {
      if (typeof rootManifest.scripts?.[script] !== "string") {
        violations.push(
          violation(
            "package.json",
            "root-script-contract",
            `required root script '${script}' is missing.`,
            `restore a real fail-closed '${script}' command`,
          ),
        );
      }
    }
    if (rootManifest.packageManager !== "pnpm@11.12.0") {
      violations.push(
        violation(
          "package.json",
          "toolchain-version",
          `packageManager must be pnpm@11.12.0, received '${rootManifest.packageManager ?? "missing"}'.`,
          "restore the architecture-locked pnpm version",
        ),
      );
    }
    if (
      rootManifest.engines?.node !== "24.18.0" ||
      rootManifest.engines?.pnpm !== "11.12.0" ||
      rootManifest.devDependencies?.typescript !== "6.0.3"
    ) {
      violations.push(
        violation(
          "package.json",
          "toolchain-version",
          "Node, pnpm, or TypeScript drifted from the locked versions.",
          "restore Node 24.18.0, pnpm 11.12.0, and TypeScript 6.0.3",
        ),
      );
    }
  }

  if (nodeVersion !== null && nodeVersion.trim() !== "24.18.0") {
    violations.push(
      violation(
        ".node-version",
        "toolchain-version",
        ".node-version must contain 24.18.0.",
        "restore the locked Node version",
      ),
    );
  }
  if (nvmVersion !== null && nvmVersion.trim() !== "24.18.0") {
    violations.push(
      violation(
        ".nvmrc",
        "toolchain-version",
        ".nvmrc must contain 24.18.0.",
        "restore the locked Node version",
      ),
    );
  }

  if (workspaceSource !== null) {
    for (const pattern of ["apps/*", "packages/*", "packages/adapters/*"]) {
      if (!workspaceSource.includes(`- '${pattern}'`)) {
        violations.push(
          violation(
            "pnpm-workspace.yaml",
            "workspace-roots",
            `workspace root '${pattern}' is missing.`,
            "restore the exact three workspace roots",
          ),
        );
      }
    }
    if (workspaceSource.includes("packages/application/*")) {
      violations.push(
        violation(
          "pnpm-workspace.yaml",
          "workspace-roots",
          "packages/application must remain one workspace, not a nested workspace root.",
          "remove packages/application/* from workspace patterns",
        ),
      );
    }
  }

  if (extensionManifest) {
    if (extensionManifest.engines?.vscode !== "^1.125.0") {
      violations.push(
        violation(
          "apps/extension/package.json",
          "extension-version",
          `engines.vscode must be ^1.125.0, received '${extensionManifest.engines?.vscode ?? "missing"}'.`,
          "restore the supported VS Code floor",
        ),
      );
    }
    if (extensionManifest.devDependencies?.["@types/vscode"] !== "1.125.0") {
      violations.push(
        violation(
          "apps/extension/package.json",
          "extension-version",
          "@types/vscode must be pinned to 1.125.0.",
          "restore the exact VS Code API type version",
        ),
      );
    }
    if (extensionManifest.devDependencies?.esbuild !== "0.28.1") {
      violations.push(
        violation(
          "apps/extension/package.json",
          "extension-version",
          "esbuild must be pinned to 0.28.1.",
          "restore the exact bundler version",
        ),
      );
    }
  }

  const discovered = await discoverWorkspaces(root);
  const discoveredManifests = new Set(
    discovered
      .filter(({ manifest }) => manifest !== null)
      .map(({ relativePath }) => `${relativePath}/package.json`),
  );
  const productManifests = [
    ...(await collectProductManifests(root, "apps")),
    ...(await collectProductManifests(root, "packages")),
  ];
  for (const manifestPath of productManifests) {
    if (!discoveredManifests.has(manifestPath)) {
      violations.push(
        violation(
          manifestPath,
          "undiscovered-workspace",
          `${manifestPath} is a product package but is not discovered by the workspace roots.`,
          "move it to apps/*, packages/*, or packages/adapters/* without creating a nested workspace",
        ),
      );
    }
  }

  return violations.sort((left, right) =>
    `${left.relativePath}:${left.rule}`.localeCompare(
      `${right.relativePath}:${right.rule}`,
    ),
  );
}
