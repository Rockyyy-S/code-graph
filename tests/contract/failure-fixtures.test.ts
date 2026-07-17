import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function runNodeModule(relativeModule: string, args: string[], cwd = repositoryRoot) {
  return spawnSync(
    process.execPath,
    [path.join(repositoryRoot, ...relativeModule.split("/")), ...args],
    { cwd, encoding: "utf8" },
  );
}

describe("isolated real failure fixtures", () => {
  it("returns non-zero for a deterministic TypeScript type error", () => {
    const result = runNodeModule("node_modules/typescript/bin/tsc", [
      "--noEmit",
      "-p",
      "tests/fixtures/type-error/tsconfig.json",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Type 'string' is not assignable to type 'number'");
  });

  it("returns non-zero for a deterministic ESLint violation", () => {
    const result = runNodeModule("node_modules/eslint/bin/eslint.js", [
      "tests/fixtures/lint-error/bad.ts",
      "--config",
      "tests/fixtures/lint-error/eslint.config.mjs",
      "--no-warn-ignored",
      "--format",
      "./scripts/quality/relative-eslint-formatter.mjs",
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("no-debugger");
    expect(result.stdout).toContain("Fix:");
    expect(result.stdout).not.toContain(repositoryRoot);
  });

  it("returns non-zero for a real Vitest assertion failure", () => {
    const result = runNodeModule("node_modules/vitest/vitest.mjs", [
      "run",
      "--config",
      "tests/fixtures/unit-error/vitest.config.mjs",
    ]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("expected 1 to be 2");
  });

  it("returns non-zero for an esbuild resolution failure", () => {
    const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/build-error");
    const outputPath = path.join(tmpdir(), "codegraph-build-error-fixture.js");
    const result = runNodeModule(
      "node_modules/esbuild/bin/esbuild",
      ["src/index.ts", "--bundle", `--outfile=${outputPath}`, "--platform=node"],
      fixtureRoot,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not resolve");
  });

  it("returns non-zero for a security violation without leaking absolute paths", () => {
    const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/security-error");
    const result = runNodeModule("scripts/security/check-basic-security.mjs", [
      "--root",
      fixtureRoot,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("apps/sample/config.ts");
    expect(result.stderr).toContain("Fix:");
    expect(result.stderr).not.toContain(fixtureRoot);
  });
});
