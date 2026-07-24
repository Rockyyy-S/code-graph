import { accessSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { loadQualityGateRegistry } from "../ci/load-quality-gates.mjs";
import { discoverWorkspaces } from "../workspace/discover-workspaces.mjs";

const requiredWorkspaceRoots = ["apps/*", "packages/*", "packages/adapters/*"];
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
  let gateRegistry = null;
  try {
    gateRegistry = await loadQualityGateRegistry(root);
  } catch (error) {
    violations.push(
      violation(
        "ci/quality-gates.v1.yaml",
        "gate-registry-contract",
        error instanceof Error ? error.message : "Gate Registry 无法验证。",
        "恢复唯一、升序、摘要闭合且命令真实的 GateRegistryV1",
      ),
    );
  }
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
    if (rootManifest.scripts?.["architecture-required"] !== "node scripts/ci/run-architecture-required.mjs") {
      violations.push(
        violation(
          "package.json",
          "root-script-contract",
          "architecture-required 必须指向 checked-in registry runner。",
          "将 architecture-required 恢复为 node scripts/ci/run-architecture-required.mjs",
        ),
      );
    }
    for (const entry of gateRegistry?.registry.gates ?? []) {
      validateGateCommandContract(root, rootManifest, entry.gateDefinition, violations);
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
    let workspaceConfig;
    try {
      workspaceConfig = parse(workspaceSource);
    } catch {
      violations.push(
        violation(
          "pnpm-workspace.yaml",
          "workspace-roots",
          "pnpm-workspace.yaml is not valid YAML.",
          "restore valid YAML with the exact three workspace roots",
        ),
      );
    }

    const actualRoots = workspaceConfig?.packages;
    if (
      !Array.isArray(actualRoots) ||
      actualRoots.length !== requiredWorkspaceRoots.length ||
      !requiredWorkspaceRoots.every((pattern, index) => actualRoots[index] === pattern)
    ) {
      violations.push(
        violation(
          "pnpm-workspace.yaml",
          "workspace-roots",
          "pnpm workspace roots must exactly match apps/*, packages/*, and packages/adapters/*.",
          "remove extra or nested roots and restore the required order",
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

/** 从唯一 Gate Registry 派生并验证根脚本或 checked-in Node 入口。 */
function validateGateCommandContract(root, rootManifest, definition, violations) {
  const [executable, ...args] = definition.command;
  if (executable === "pnpm" && args.length === 1) {
    const scriptName = args[0];
    const implementation = rootManifest.scripts?.[scriptName];
    if (typeof implementation !== "string" || isNoOpScript(implementation)) {
      violations.push(
        violation(
          "package.json",
          "root-script-contract",
          `registry gate '${definition.gateId}' 引用缺失或 no-op 的根脚本 '${scriptName}'。`,
          `为 '${scriptName}' 恢复 checked-in fail-closed 实现`,
        ),
      );
    }
    return;
  }
  if (executable === "node" && args.length === 1 && isSafeScriptPath(args[0])) {
    const absolutePath = path.join(root, ...args[0].split("/"));
    try {
      accessSync(absolutePath);
    } catch {
      violations.push(
        violation(
          args[0],
          "gate-command-contract",
          `registry gate '${definition.gateId}' 的 checked-in 入口缺失。`,
          `恢复 ${args[0]} 或同步更新已批准 registry`,
        ),
      );
    }
    return;
  }
  violations.push(
    violation(
      "ci/quality-gates.v1.yaml",
      "gate-command-contract",
      `registry gate '${definition.gateId}' 使用未批准的命令形状。`,
      "使用 ['pnpm','<root-script>'] 或 ['node','<checked-in-relative-path>']",
    ),
  );
}

/** 拒绝恒成功、内联执行或弱化失败传播的根脚本。 */
function isNoOpScript(source) {
  return (
    source.trim().length === 0 ||
    /(?:^|\s)(?:true|echo|printf)(?:\s|$)/u.test(source) ||
    /node\s+(?:-e|--eval|-p|--print)(?:\s|$)/u.test(source) ||
    /process\.exit\(0\)|\|\|\s*true|continue-on-error/u.test(source)
  );
}

/** checked-in Node 入口必须是仓库内规范 POSIX 相对路径。 */
function isSafeScriptPath(relativePath) {
  return (
    typeof relativePath === "string" &&
    relativePath.endsWith(".mjs") &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    relativePath.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const violations = await validateRepositoryContract(repositoryRoot);
  for (const contractViolation of violations) {
    console.error(
      `${contractViolation.relativePath}: ${contractViolation.message} Rule: ${contractViolation.rule}. Fix: ${contractViolation.suggestion}.`,
    );
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}
