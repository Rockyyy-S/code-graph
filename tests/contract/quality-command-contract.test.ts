import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateRepositoryContract } from "../../scripts/contracts/validate-repository-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("real root quality commands", () => {
  it("backs every root command with a checked-in implementation or config", async () => {
    const requiredFiles = [
      "eslint.config.mjs",
      "tsconfig.quality.json",
      "vitest.config.ts",
      "vitest.contract.config.ts",
      "scripts/quality/run-workspace-script.mjs",
      "scripts/quality/check-test-markers.mjs",
      "scripts/quality/relative-eslint-formatter.mjs",
      "scripts/architecture/check-dependency-boundaries.mjs",
      "scripts/contracts/validate-repository-contract.mjs",
      "scripts/ci/run-architecture-required.mjs",
      "scripts/security/check-basic-security.mjs",
    ];

    await Promise.all(
      requiredFiles.map((relativePath) =>
        expect(access(path.join(repositoryRoot, relativePath))).resolves.toBeUndefined(),
      ),
    );
  });

  it("keeps Vitest fail-closed for empty suites and excludes failure fixtures", async () => {
    const unitConfig = await readText("vitest.config.ts");
    const contractConfig = await readText("vitest.contract.config.ts");

    expect(unitConfig).toContain("passWithNoTests: false");
    expect(contractConfig).toContain("passWithNoTests: false");
    expect(unitConfig).toContain("tests/fixtures/**");
    expect(contractConfig).toContain("tests/fixtures/**");
  });

  it("checks focused, skipped and todo tests outside isolated fixtures", async () => {
    const markerCheck = await readText("scripts/quality/check-test-markers.mjs");

    expect(markerCheck).toContain("tests/fixtures");
    expect(markerCheck).toContain("Forbidden test marker");
  });

  it("accepts the current repository-level contract", async () => {
    await expect(validateRepositoryContract(repositoryRoot)).resolves.toEqual([]);
  });
});
