import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import portableVitestConfig from "../../vitest.contract.config.js";
import unitVitestConfig from "../../vitest.config.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const contractRoot = path.join(repositoryRoot, "tests/contract");
const processDeadlinePath = "tests/unit/process-deadline.test.ts";
const graphServicePath = "tests/contract/graph-service-process.test.ts";
const dedicatedPath: string = "tests/contract/host-path-identity-win32.test.ts";
const unitIncludePatterns = [
  "tests/unit/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "apps/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "packages/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
];

type ProjectTestConfig = {
  allowOnly?: boolean;
  exclude?: string[];
  fileParallelism?: boolean;
  include?: string[];
  isolate?: boolean;
  maxWorkers?: number | string;
  name?: string;
  pool?: string;
  sequence?: { groupOrder?: number };
};

function getProjects(config: unknown): ProjectTestConfig[] {
  const projects = (config as {
    test?: { projects?: Array<{ test?: ProjectTestConfig }> };
  }).test?.projects ?? [];
  return projects.map((project) => project.test ?? {});
}

/** 从 dedicated 源码统计顶层业务测试，避免 verifier 计数合同随测试增删发生漂移。 */
function countDedicatedTests(source: string): number {
  return source.match(/^  it\(/gmu)?.length ?? 0;
}

/** 递归枚举全部 contract 测试文件，并统一为仓库相对 POSIX path。 */
async function collectContractTests(directory = contractRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectContractTests(absolute);
    }
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) {
      return [];
    }
    return [path.relative(repositoryRoot, absolute).replaceAll("\\", "/")];
  }));
  return paths.flat().sort();
}

/** 枚举 unit 命令覆盖的三个源码根，确保普通与 deadline project 的并集无遗漏。 */
async function collectUnitTests(): Promise<string[]> {
  const roots = ["tests/unit", "apps", "packages"];
  const testFilePattern = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;

  async function collect(directory: string): Promise<string[]> {
    const entries = await readdir(path.join(repositoryRoot, directory), { withFileTypes: true });
    const paths = await Promise.all(entries.map(async (entry) => {
      const relative = path.posix.join(directory.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) {
        return collect(relative);
      }
      return entry.isFile() && testFilePattern.test(entry.name) ? [relative] : [];
    }));
    return paths.flat();
  }

  return (await Promise.all(roots.map(collect))).flat().sort();
}

describe("contract execution partitions", () => {
  it("partitions every unit and contract file exactly once with sensitive projects last", async () => {
    const all = await collectUnitTests();
    const ordinary = all.filter((file) => file !== processDeadlinePath);
    const deadline = all.filter((file) => file === processDeadlinePath);
    const [ordinaryProject, deadlineProject] = getProjects(unitVitestConfig);

    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all).size).toBe(all.length);
    expect(deadline).toEqual([processDeadlinePath]);
    expect([...ordinary, ...deadline].sort()).toEqual(all);
    expect(ordinary.filter((file) => file === processDeadlinePath)).toEqual([]);
    expect(ordinaryProject).toMatchObject({
      allowOnly: false,
      exclude: ["tests/fixtures/**", processDeadlinePath],
      include: unitIncludePatterns,
      name: "unit",
      sequence: { groupOrder: 0 },
    });
    expect(deadlineProject).toMatchObject({
      allowOnly: false,
      exclude: ["tests/fixtures/**"],
      fileParallelism: false,
      include: [processDeadlinePath],
      isolate: true,
      maxWorkers: 1,
      name: "unit-process-deadline",
      pool: "forks",
      sequence: { groupOrder: 1 },
    });

    const allContracts = await collectContractTests();
    const portable = allContracts.filter(
      (file) => file !== graphServicePath && file !== dedicatedPath,
    );
    const graphService = allContracts.filter((file) => file === graphServicePath);
    const dedicated = allContracts.filter((file) => file === dedicatedPath);
    const [portableProject, graphServiceProject] = getProjects(portableVitestConfig);

    expect(allContracts.length).toBeGreaterThan(1);
    expect(new Set(allContracts).size).toBe(allContracts.length);
    expect(portable.length).toBeGreaterThan(0);
    expect(graphService).toEqual([graphServicePath]);
    expect(dedicated).toEqual([dedicatedPath]);
    expect([...portable, ...graphService, ...dedicated].sort()).toEqual(allContracts);
    expect(portable.filter((file) => file === graphServicePath || file === dedicatedPath)).toEqual([]);
    expect(graphService.filter((file) => file === dedicatedPath)).toEqual([]);
    expect(portableProject).toMatchObject({
      allowOnly: false,
      exclude: ["tests/fixtures/**", graphServicePath, dedicatedPath],
      fileParallelism: false,
      include: ["tests/contract/**/*.test.ts"],
      name: "contract-portable",
      sequence: { groupOrder: 0 },
    });
    expect(graphServiceProject).toMatchObject({
      allowOnly: false,
      exclude: ["tests/fixtures/**", dedicatedPath],
      fileParallelism: false,
      include: [graphServicePath],
      isolate: true,
      maxWorkers: 1,
      name: "contract-graph-service-process",
      pool: "forks",
      sequence: { groupOrder: 1 },
    });
  });

  it("binds portable and dedicated configs without passWithNoTests or skipped-test escape", async () => {
    const [portableConfig, dedicatedConfig, dedicatedSource, packageSource, verifier] = await Promise.all([
      readFile(path.join(repositoryRoot, "vitest.contract.config.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "vitest.contract.win32.config.ts"), "utf8"),
      readFile(path.join(repositoryRoot, dedicatedPath), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts/ci/verify-host-path-identity-v1.mjs"), "utf8"),
    ]);
    const scripts = (JSON.parse(packageSource) as { scripts: Record<string, string> }).scripts;
    const dedicatedTestCount = countDedicatedTests(dedicatedSource);

    expect(scripts.contract).toBe("vitest run --config vitest.contract.config.ts");
    expect(dedicatedTestCount).toBeGreaterThan(0);
    expect(portableConfig).toContain('include: ["tests/contract/**/*.test.ts"]');
    expect(portableConfig).toContain(`"${graphServicePath}"`);
    expect(portableConfig).toContain(`"${dedicatedPath}"`);
    expect(portableConfig).toContain("passWithNoTests: false");
    expect(portableConfig).toContain("FailOnSkippedReporter");
    expect(dedicatedConfig).toContain(`include: ["${dedicatedPath}"]`);
    expect(dedicatedConfig).toContain("passWithNoTests: false");
    expect(verifier).toContain(
      "runVitestWithRequiredCounts(dedicatedContractConfigPath, contractTestPath)",
    );
    expect(verifier).toContain("suites.length !== 1");
    expect(verifier).toContain(`report.numTotalTests !== ${dedicatedTestCount}`);
    expect(verifier).toContain(`report.numPassedTests !== ${dedicatedTestCount}`);
    expect(verifier).toContain("report.numTotalTestSuites <= 0");
    expect(`${portableConfig}\n${dedicatedConfig}\n${scripts.contract}\n${verifier}`).not.toContain(
      "passWithNoTests: true",
    );
  });

  it("runs Win32 preflight in the verifier before the hook-free dedicated suite", async () => {
    const [dedicatedSource, dedicatedConfig, verifier] = await Promise.all([
      readFile(path.join(repositoryRoot, dedicatedPath), "utf8"),
      readFile(path.join(repositoryRoot, "vitest.contract.win32.config.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts/ci/verify-host-path-identity-v1.mjs"), "utf8"),
    ]);

    expect(verifier).toContain(
      "export const WINDOWS_TEST_ROOT_PROBE_TIMEOUT_MS = 10_000;",
    );
    expect(verifier).toContain("CODEGRAPH_TRUSTED_WIN32_PREFLIGHT_V1");
    expect(verifier).toContain('fail("TRUSTED_PREFLIGHT_MISSING")');
    expect(verifier).toContain('source: "trusted-outer-preflight-v1"');
    expect(verifier).toMatch(
      /const preflight = runWindowsContractPreflight\(\);[\s\S]*if \(!preflight\.ok\)[\s\S]*return 1;[\s\S]*runVitestWithRequiredCounts/u,
    );
    expect(verifier).toContain("timeout: WINDOWS_TEST_ROOT_PROBE_TIMEOUT_MS");
    expect(verifier).toContain('classification: "preflight-timeout"');
    expect(verifier).toContain('classification: "suite-hook-failure"');
    expect(verifier).toContain('classification: "test-assertion-failure"');
    expect(dedicatedSource).not.toContain("beforeAll");
    expect(dedicatedSource).not.toContain("Get-Volume");
    expect(dedicatedSource).not.toContain("spawnSync");
    expect(dedicatedConfig).not.toContain("hookTimeout");
  });
});
