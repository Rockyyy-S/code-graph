import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const includedDirectories = [
  "apps",
  "packages",
  "scripts",
  ".github/workflows",
];
const includedRootFiles = [
  ".npmrc",
  ".node-version",
  ".nvmrc",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.quality.json",
  "vitest.config.ts",
  "vitest.contract.config.ts",
];
const ignoredDirectoryNames = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);
const supportedExtensions = new Set([
  ".cjs",
  ".cts",
  ".env",
  ".js",
  ".jsx",
  ".json",
  ".mjs",
  ".mts",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const placeholderValues = new Set([
  "admin123",
  "changeme",
  "dummy-secret",
  "example-secret",
  "password123",
  "replace-me",
  "replace_me",
  "test-secret",
  "todo-secret",
]);

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function collectDirectoryFiles(root, relativeDirectory) {
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

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || ignoredDirectoryNames.has(entry.name)) {
      continue;
    }
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectDirectoryFiles(root, relativePath)));
    } else if (supportedExtensions.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }
  return files;
}

async function collectRootEnvironmentFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && (entry.name === ".env" || entry.name.startsWith(".env.")),
    )
    .map((entry) => entry.name);
}

function locationForIndex(source, index) {
  const preceding = source.slice(0, index).split("\n");
  return { column: preceding.at(-1).length + 1, line: preceding.length };
}

function findPatternMatches(source) {
  const findings = [];
  const highConfidencePatterns = [
    {
      message: "private key material is checked into an implementation/config file",
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      rule: "hardcoded-private-key",
    },
    {
      message: "GitHub token-shaped credential is hardcoded",
      pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
      rule: "hardcoded-token",
    },
    {
      message: "AWS access key-shaped credential is hardcoded",
      pattern: /\bAKIA[0-9A-Z]{16}\b/g,
      rule: "hardcoded-token",
    },
  ];

  for (const candidate of highConfidencePatterns) {
    for (const match of source.matchAll(candidate.pattern)) {
      findings.push({
        ...locationForIndex(source, match.index ?? 0),
        message: candidate.message,
        rule: candidate.rule,
      });
    }
  }

  const assignmentPattern =
    /(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z_$][\w$-]*))\s*[:=]\s*["'`]([^"'`\r\n]+)["'`]/g;
  for (const match of source.matchAll(assignmentPattern)) {
    const fieldName = match[1] ?? match[2] ?? match[3] ?? "";
    const normalizedFieldName = fieldName.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const isSensitiveField = [
      "apikey",
      "password",
      "secret",
      "token",
    ].some((suffix) => normalizedFieldName.endsWith(suffix));
    if (!isSensitiveField) {
      continue;
    }

    const value = match[4].trim().toLowerCase();
    findings.push({
      ...locationForIndex(source, match.index ?? 0),
      message: placeholderValues.has(value)
        ? "dangerous placeholder credential is assigned to a sensitive field"
        : "literal credential is assigned to a sensitive field",
      rule: placeholderValues.has(value)
        ? "placeholder-credential"
        : "hardcoded-credential",
    });
  }

  const npmTokenPattern = /:_authToken\s*=\s*(?!\$\{)[^\s]+/g;
  for (const match of source.matchAll(npmTokenPattern)) {
    findings.push({
      ...locationForIndex(source, match.index ?? 0),
      message: "literal npm authentication token is configured",
      rule: "hardcoded-token",
    });
  }

  return findings;
}

export async function scanBasicSecurity(root) {
  const relativeFiles = await collectRootEnvironmentFiles(root);
  for (const relativeDirectory of includedDirectories) {
    relativeFiles.push(...(await collectDirectoryFiles(root, relativeDirectory)));
  }
  for (const relativeFile of includedRootFiles) {
    try {
      await readFile(path.join(root, relativeFile), "utf8");
      relativeFiles.push(relativeFile);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  const findings = [];
  for (const relativePath of [...new Set(relativeFiles)].sort()) {
    const source = await readFile(
      path.join(root, ...relativePath.split("/")),
      "utf8",
    );
    for (const finding of findPatternMatches(source)) {
      findings.push({ ...finding, relativePath: toPosix(relativePath) });
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootOptionIndex = process.argv.indexOf("--root");
  const requestedRoot =
    rootOptionIndex >= 0 && process.argv[rootOptionIndex + 1]
      ? path.resolve(process.argv[rootOptionIndex + 1])
      : repositoryRoot;
  const findings = await scanBasicSecurity(requestedRoot);
  for (const finding of findings) {
    console.error(
      `${finding.relativePath}:${finding.line}:${finding.column}: ${finding.message}. Rule: ${finding.rule}. Fix: load credentials from an approved runtime secret source and remove the literal value.`,
    );
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
