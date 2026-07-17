import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
const forbiddenMarkers = [
  { label: "focused test", pattern: /\b(?:describe|it|test|suite)\s*\.\s*only\s*\(/g },
  { label: "skipped test", pattern: /\b(?:describe|it|test|suite)\s*\.\s*skip\s*\(/g },
  { label: "todo test", pattern: /\b(?:describe|it|test|suite)\s*\.\s*todo\s*\(/g },
  { label: "focused test", pattern: /\b(?:fdescribe|fit)\s*\(/g },
  { label: "skipped test", pattern: /\b(?:xdescribe|xit|xtest)\s*\(/g },
];

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

function lineAndColumn(source, index) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return { column: lines.at(-1).length + 1, line: lines.length };
}

export async function findForbiddenTestMarkers(root) {
  const findings = [];
  const files = [];
  for (const testRoot of testRoots) {
    files.push(...(await collectFiles(root, testRoot)));
  }

  for (const relativePath of files) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    for (const marker of forbiddenMarkers) {
      marker.pattern.lastIndex = 0;
      for (const match of source.matchAll(marker.pattern)) {
        const location = lineAndColumn(source, match.index ?? 0);
        findings.push({
          ...location,
          label: marker.label,
          relativePath: toPosix(relativePath),
        });
      }
    }
  }

  return findings;
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
