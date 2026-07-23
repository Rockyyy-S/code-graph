import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { discoverWorkspaces } from "../workspace/discover-workspaces.mjs";
import {
  dependencySuggestion,
  expectedRoleForWorkspace,
  isDependencyAllowed,
} from "./dependency-policy.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const externalDependencyAllowlistByRole = new Map([
  ["domain", new Set()],
  ["application", new Set()],
  ["contracts", new Set(["ajv"])],
  ["service-client", new Set(["vscode-jsonrpc"])],
  ["adapter", new Set()],
  ["composition-root", new Set(["vscode-jsonrpc"])],
  ["client-app", new Set(["@types/vscode", "esbuild", "typescript"])],
  ["renderer-app", new Set()],
]);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function createViolation(relativePath, rule, message, suggestion) {
  return { message, relativePath: toPosix(relativePath), rule, suggestion };
}

async function collectTypeScriptFiles(absoluteDirectory) {
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(absolutePath)));
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function extractModuleSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function dependencyEntries(manifest) {
  const entries = [];
  for (const field of dependencyFields) {
    for (const [name, specifier] of Object.entries(manifest?.[field] ?? {})) {
      entries.push({ field, name, specifier });
    }
  }
  return entries;
}

function workspaceForSpecifier(specifier, sourceFile, workspacesByName, workspaces) {
  for (const [packageName, workspace] of workspacesByName) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return workspace;
    }
  }

  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
    return null;
  }

  const resolved = path.resolve(path.dirname(sourceFile), specifier);
  return (
    workspaces.find(
      (workspace) =>
        resolved === workspace.absolutePath ||
        resolved.startsWith(`${workspace.absolutePath}${path.sep}`),
    ) ?? null
  );
}

function validateEdge(source, target, relativePath, declaredDependencies) {
  const violations = [];
  if (!isDependencyAllowed(source.role, target.role)) {
    violations.push(
      createViolation(
        relativePath,
        "dependency-direction",
        `${source.relativePath} (${source.role}) cannot depend on ${target.relativePath} (${target.role}).`,
        dependencySuggestion(source.role, target.role),
      ),
    );
  }
  if (!declaredDependencies.has(target.manifest.name)) {
    violations.push(
      createViolation(
        relativePath,
        "workspace-dependency-declaration",
        `${source.relativePath} imports ${target.manifest.name} without declaring a workspace dependency.`,
        `add '${target.manifest.name}': 'workspace:*' to ${source.relativePath}/package.json after confirming the direction is allowed`,
      ),
    );
  }
  return violations;
}

export async function checkDependencyBoundaries(root) {
  const violations = [];
  const discovered = await discoverWorkspaces(root);
  const workspaces = [];
  const seenNames = new Set();

  for (const workspace of discovered) {
    const manifestPath = `${workspace.relativePath}/package.json`;
    if (/(^|\/)(?:utils?|common)$/.test(workspace.relativePath)) {
      violations.push(
        createViolation(
          manifestPath,
          "no-generic-utils",
          `${workspace.relativePath} has no explicit architectural responsibility.`,
          "move shared code to domain, application, contracts, service-client, or a specific adapter",
        ),
      );
    }
    if (workspace.manifest === null) {
      violations.push(
        createViolation(
          manifestPath,
          "workspace-manifest",
          `${workspace.relativePath} is discovered by pnpm but has no package.json.`,
          "add an explicit package manifest with a codegraph.role",
        ),
      );
      continue;
    }

    const expectedRole = expectedRoleForWorkspace(workspace.relativePath);
    const declaredRole = workspace.manifest.codegraph?.role;
    if (expectedRole === null) {
      violations.push(
        createViolation(
          manifestPath,
          "unknown-responsibility",
          `${workspace.relativePath} is a new workspace without a recognized owner boundary.`,
          "place it under an existing responsibility or update the architecture and dependency policy first",
        ),
      );
      continue;
    }
    if (declaredRole !== expectedRole) {
      violations.push(
        createViolation(
          manifestPath,
          "workspace-role",
          `${workspace.relativePath} declares role '${declaredRole ?? "missing"}' but must be '${expectedRole}'.`,
          `set codegraph.role to '${expectedRole}' without weakening the dependency policy`,
        ),
      );
    }

    if (typeof workspace.manifest.name !== "string") {
      violations.push(
        createViolation(
          manifestPath,
          "workspace-name",
          `${workspace.relativePath} has no stable package name.`,
          "add a unique @codegraph/* package name",
        ),
      );
      continue;
    }
    if (seenNames.has(workspace.manifest.name)) {
      violations.push(
        createViolation(
          manifestPath,
          "workspace-name",
          `${workspace.manifest.name} is declared by more than one workspace.`,
          "assign a unique package name",
        ),
      );
    }
    seenNames.add(workspace.manifest.name);
    workspaces.push({ ...workspace, role: expectedRole });
  }

  const workspacesByName = new Map(
    workspaces.map((workspace) => [workspace.manifest.name, workspace]),
  );

  for (const workspace of workspaces) {
    const manifestPath = `${workspace.relativePath}/package.json`;
    const dependencyEntriesForWorkspace = dependencyEntries(workspace.manifest);
    const declaredDependencies = new Set(
      dependencyEntriesForWorkspace.map(({ name }) => name),
    );
    const externalAllowlist =
      externalDependencyAllowlistByRole.get(workspace.role) ?? new Set();

    for (const { field, name: dependencyName, specifier } of dependencyEntriesForWorkspace) {
      const target = workspacesByName.get(dependencyName);
      if (target) {
        if (specifier !== "workspace:*") {
          violations.push(
            createViolation(
              manifestPath,
              "workspace-dependency-protocol",
              `${dependencyName} must use workspace:* instead of '${String(specifier)}'.`,
              `set ${field}.${dependencyName} to 'workspace:*' so the checked workspace is the installed workspace`,
            ),
          );
        }
        if (!isDependencyAllowed(workspace.role, target.role)) {
          violations.push(
            createViolation(
              manifestPath,
              "dependency-direction",
              `${workspace.relativePath} (${workspace.role}) cannot declare ${dependencyName} (${target.role}).`,
              dependencySuggestion(workspace.role, target.role),
            ),
          );
        }
      } else if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
        violations.push(
          createViolation(
            manifestPath,
            "workspace-dependency-alias",
            `${dependencyName} aliases a workspace package through '${specifier}'.`,
            "declare the target workspace by its canonical package name with workspace:*",
          ),
        );
      } else if (dependencyName.startsWith("@codegraph/")) {
        violations.push(
          createViolation(
            manifestPath,
            "unknown-workspace-dependency",
            `${dependencyName} is declared but no matching workspace was discovered.`,
            "add the missing workspace under a covered pnpm root or remove the stale dependency",
          ),
        );
      } else if (!externalAllowlist.has(dependencyName)) {
        violations.push(
          createViolation(
            manifestPath,
            "external-dependency-allowlist",
            `${dependencyName} is not allowlisted for the ${workspace.role} role.`,
            "update the architecture-owned role allowlist before introducing this external dependency",
          ),
        );
      }
    }

    const sourceFiles = await collectTypeScriptFiles(
      path.join(workspace.absolutePath, "src"),
    );
    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      const parsed = ts.createSourceFile(
        sourceFile,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const specifier of extractModuleSpecifiers(parsed)) {
        const target = workspaceForSpecifier(
          specifier,
          sourceFile,
          workspacesByName,
          workspaces,
        );
        if (target && target.relativePath !== workspace.relativePath) {
          violations.push(
            ...validateEdge(
              workspace,
              target,
              path.relative(root, sourceFile),
              declaredDependencies,
            ),
          );
        }
      }
    }
  }

  return violations.sort((left, right) =>
    `${left.relativePath}:${left.rule}:${left.message}`.localeCompare(
      `${right.relativePath}:${right.rule}:${right.message}`,
    ),
  );
}

export function formatBoundaryViolation(violation) {
  return `${violation.relativePath}: ${violation.message} Rule: ${violation.rule}. Fix: ${violation.suggestion}.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await checkDependencyBoundaries(repositoryRoot);
  for (const violation of violations) {
    console.error(formatBoundaryViolation(violation));
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}
