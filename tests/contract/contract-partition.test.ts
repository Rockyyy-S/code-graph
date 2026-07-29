import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const contractRoot = path.join(repositoryRoot, "tests/contract");
const dedicatedPath: string = "tests/contract/host-path-identity-win32.test.ts";

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

describe("contract execution partitions", () => {
  it("partitions every contract file exactly once between portable and dedicated Win32", async () => {
    const all = await collectContractTests();
    const portable = all.filter((file) => file !== dedicatedPath);
    const dedicated = all.filter((file) => file === dedicatedPath);

    expect(all.length).toBeGreaterThan(1);
    expect(new Set(all).size).toBe(all.length);
    expect(portable.length).toBeGreaterThan(0);
    expect(dedicated).toEqual([dedicatedPath]);
    expect([...portable, ...dedicated].sort()).toEqual(all);
    expect(portable.filter((file) => dedicated.includes(file))).toEqual([]);
  });

  it("binds portable and dedicated configs without passWithNoTests or skipped-test escape", async () => {
    const [portableConfig, dedicatedConfig, packageSource, verifier] = await Promise.all([
      readFile(path.join(repositoryRoot, "vitest.contract.config.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "vitest.contract.win32.config.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "scripts/ci/verify-host-path-identity-v1.mjs"), "utf8"),
    ]);
    const scripts = (JSON.parse(packageSource) as { scripts: Record<string, string> }).scripts;

    expect(scripts.contract).toBe("vitest run --config vitest.contract.config.ts");
    expect(portableConfig).toContain('include: ["tests/contract/**/*.test.ts"]');
    expect(portableConfig).toContain(`"${dedicatedPath}"`);
    expect(portableConfig).toContain("passWithNoTests: false");
    expect(portableConfig).toContain("FailOnSkippedReporter");
    expect(dedicatedConfig).toContain(`include: ["${dedicatedPath}"]`);
    expect(dedicatedConfig).toContain("passWithNoTests: false");
    expect(verifier).toContain(
      "runVitestWithRequiredCounts(dedicatedContractConfigPath, contractTestPath)",
    );
    expect(verifier).toContain('report.testResults.length !== 1');
    expect(verifier).toContain('report.numTotalTests <= 0');
    expect(`${portableConfig}\n${dedicatedConfig}\n${scripts.contract}\n${verifier}`).not.toContain(
      "passWithNoTests: true",
    );
  });
});
