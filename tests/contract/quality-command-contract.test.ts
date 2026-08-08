import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import contractVitestConfig from "../../vitest.contract.config.js";
import unitVitestConfig from "../../vitest.config.js";
import processLifecycleVitestConfig, {
  PROCESS_LIFECYCLE_BUDGET,
} from "../../vitest.process-deadline.config.js";
import { validateRepositoryContract } from "../../scripts/contracts/validate-repository-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function readText(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

type ProjectTestConfig = {
  allowOnly?: boolean;
  fileParallelism?: boolean;
  include?: string[];
  isolate?: boolean;
  maxWorkers?: number | string;
  name?: string;
  pool?: string;
  sequence?: { groupOrder?: number };
  testTimeout?: number;
};

type RootTestConfig = {
  allowOnly?: boolean;
  exclude?: string[];
  fileParallelism?: boolean;
  include?: string[];
  isolate?: boolean;
  maxWorkers?: number | string;
  name?: string;
  passWithNoTests?: boolean;
  pool?: string;
  projects?: Array<{ test?: ProjectTestConfig }>;
  reporters?: unknown[];
  testTimeout?: number;
};

const unitIncludePatterns = [
  "tests/unit/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "apps/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "packages/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
];

function getTestConfig(config: unknown): RootTestConfig {
  return (config as { test?: RootTestConfig }).test ?? {};
}

describe("real root quality commands", () => {
  it("backs every root command with a checked-in implementation or config", async () => {
    const requiredFiles = [
      "eslint.config.mjs",
      "tsconfig.quality.json",
      "vitest.config.ts",
      "vitest.process-deadline.config.ts",
      "vitest.contract.config.ts",
      "scripts/quality/run-workspace-script.mjs",
      "scripts/quality/check-test-markers.mjs",
      "scripts/quality/relative-eslint-formatter.mjs",
      "scripts/architecture/check-dependency-boundaries.mjs",
      "scripts/contracts/validate-repository-contract.mjs",
      "scripts/ci/run-architecture-required.mjs",
      "scripts/ci/load-quality-gates.mjs",
      "scripts/ci/verify-process-lifecycle.mjs",
      "scripts/ci/attest-vitest-json-report.mjs",
      "scripts/planning/check-planning-traceability.mjs",
      "scripts/security/check-basic-security.mjs",
      "ci/quality-gates.v1.yaml",
    ];

    await Promise.all(
      requiredFiles.map((relativePath) =>
        expect(access(path.join(repositoryRoot, relativePath))).resolves.toBeUndefined(),
      ),
    );
  });

  it("keeps Vitest fail-closed for empty suites and excludes failure fixtures", async () => {
    const [unitConfig, processLifecycleConfig, contractConfig, packageSource] =
      await Promise.all([
        readText("vitest.config.ts"),
        readText("vitest.process-deadline.config.ts"),
        readText("vitest.contract.config.ts"),
        readText("package.json"),
      ]);
    const scripts = (JSON.parse(packageSource) as { scripts: Record<string, string> })
      .scripts;

    const unitTestConfig = getTestConfig(unitVitestConfig);
    const processLifecycleTestConfig = getTestConfig(processLifecycleVitestConfig);
    const contractTestConfig = getTestConfig(contractVitestConfig);
    const contractProjects = contractTestConfig.projects?.map((project) => project.test ?? {}) ?? [];

    expect(scripts.unit).toBe(
      "node scripts/quality/check-test-markers.mjs && vitest run --config vitest.config.ts",
    );
    expect(scripts["process-lifecycle"]).toBe(
      "node scripts/ci/verify-process-lifecycle.mjs",
    );
    expect(unitTestConfig).toMatchObject({
      allowOnly: false,
      exclude: ["tests/fixtures/**", "tests/unit/process-deadline.test.ts"],
      include: unitIncludePatterns,
      name: "unit",
      passWithNoTests: false,
      testTimeout: 10_000,
    });
    expect(unitTestConfig.projects).toBeUndefined();
    expect(processLifecycleTestConfig).toMatchObject({
      allowOnly: false,
      exclude: ["tests/fixtures/**"],
      fileParallelism: false,
      include: ["tests/unit/process-deadline.test.ts"],
      isolate: true,
      maxWorkers: 1,
      name: "process-lifecycle",
      passWithNoTests: false,
      pool: "forks",
      testTimeout: PROCESS_LIFECYCLE_BUDGET.testTimeoutMs,
    });
    expect(PROCESS_LIFECYCLE_BUDGET).toMatchObject({
      declaredTestBudgetMs: 140_000,
      expectedTestCount: 15,
      gateTimeoutMs: 180_000,
    });
    expect(
      PROCESS_LIFECYCLE_BUDGET.gateTimeoutMs -
        PROCESS_LIFECYCLE_BUDGET.declaredTestBudgetMs,
    ).toBeGreaterThanOrEqual(PROCESS_LIFECYCLE_BUDGET.requiredMarginMs);
    expect(contractTestConfig).toMatchObject({
      allowOnly: false,
      fileParallelism: false,
      passWithNoTests: false,
      testTimeout: 10_000,
    });
    expect(contractProjects).toHaveLength(2);
    expect(contractProjects.map((project) => project.name)).toEqual([
      "contract-portable",
      "contract-graph-service-process",
    ]);
    expect(contractProjects.map((project) => project.sequence?.groupOrder)).toEqual([0, 1]);
    expect(contractProjects[1]).toMatchObject({
      allowOnly: false,
      fileParallelism: false,
      include: ["tests/contract/graph-service-process.test.ts"],
      isolate: true,
      maxWorkers: 1,
      pool: "forks",
      testTimeout: 10_000,
    });
    expect(unitConfig).toContain("tests/fixtures/**");
    expect(processLifecycleConfig).toContain("tests/fixtures/**");
    expect(contractConfig).toContain("tests/fixtures/**");
    expect(unitConfig).toContain("apps/**/*");
    expect(unitConfig).toContain("packages/**/*");
    expect(unitConfig).toContain("fail-on-skipped-reporter");
    expect(contractConfig).toContain("fail-on-skipped-reporter");
    expect(`${unitConfig}\n${processLifecycleConfig}\n${contractConfig}`).not.toContain(
      "passWithNoTests: true",
    );
  });

  it("applies lint rules to product JavaScript and TSX", async () => {
    const eslint = new ESLint({ cwd: repositoryRoot });

    const extensionBuildConfig = await eslint.calculateConfigForFile(
      "apps/extension/esbuild.mjs",
    );
    const webviewTsxConfig = await eslint.calculateConfigForFile(
      "apps/webview/src/example.tsx",
    );

    expect(extensionBuildConfig?.rules?.["no-debugger"]).toBeDefined();
    expect(webviewTsxConfig?.rules?.["@typescript-eslint/no-explicit-any"]).toBeDefined();
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
