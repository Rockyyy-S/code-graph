import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const ignoredSegments = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);
const testRoots = ["tests", "apps", "packages"];
const testFunctionNames = new Set(["describe", "it", "suite", "test"]);
const directMarkerLabels = new Map([
  ["fdescribe", "focused test"],
  ["fit", "focused test"],
  ["xdescribe", "skipped test"],
  ["xit", "skipped test"],
  ["xtest", "skipped test"],
]);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isTestFile(relativePath) {
  const normalized = toPosix(relativePath);
  return (
    normalized.startsWith("tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
  );
}

async function collectFiles(root, relativeDirectory = "") {
  const absoluteDirectory = path.join(root, relativeDirectory);
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
    if (ignoredSegments.has(entry.name)) {
      continue;
    }
    const relativePath = path.join(relativeDirectory, entry.name);
    const normalized = toPosix(relativePath);
    if (normalized.startsWith("tests/fixtures/")) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, relativePath)));
    } else if (isTestFile(relativePath) && /\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

function accessChain(expression) {
  const parts = [];
  let current = expression;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) {
    parts.unshift(current.text);
  }
  return parts;
}

function markerLabelForCall(callExpression) {
  if (ts.isIdentifier(callExpression.expression)) {
    return directMarkerLabels.get(callExpression.expression.text) ?? null;
  }
  if (!ts.isPropertyAccessExpression(callExpression.expression)) {
    return null;
  }

  const [root, ...modifiers] = accessChain(callExpression.expression);
  if (!testFunctionNames.has(root)) {
    return null;
  }
  if (modifiers.includes("skipIf") || modifiers.includes("runIf")) {
    return "conditional test";
  }
  if (modifiers.includes("only")) {
    return "focused test";
  }
  if (modifiers.includes("skip")) {
    return "skipped test";
  }
  if (modifiers.includes("todo")) {
    return "todo test";
  }
  return null;
}

export async function findForbiddenTestMarkers(root) {
  const findings = [];
  const files = [];
  for (const testRoot of testRoots) {
    files.push(...(await collectFiles(root, testRoot)));
  }

  for (const relativePath of files) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node) {
      if (ts.isCallExpression(node)) {
        const label = markerLabelForCall(node);
        if (label) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({
            column: location.character + 1,
            label,
            line: location.line + 1,
            relativePath: toPosix(relativePath),
          });
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return findings.sort((left, right) =>
    `${left.relativePath}:${String(left.line).padStart(8, "0")}:${String(left.column).padStart(8, "0")}`.localeCompare(
      `${right.relativePath}:${String(right.line).padStart(8, "0")}:${String(right.column).padStart(8, "0")}`,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = await findForbiddenTestMarkers(repositoryRoot);
  for (const finding of findings) {
    console.error(
      `${finding.relativePath}:${finding.line}:${finding.column}: Forbidden test marker (${finding.label}). Fix: make the test execute with real assertions or move a deliberate failing case under tests/fixtures.`,
    );
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
