import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalGateFixtureEvaluation,
  createProviderGateEvaluation,
  evaluateRegistryApplicability,
  parseNameStatusZ,
  selectComparisonBaseOid,
  validateFullGitOid,
} from "../../scripts/ci/evaluate-gate-applicability.mjs";
import {
  computeGateDefinitionDigest,
  computeGateRegistryDigest,
} from "../../packages/contracts/src/quality-gate.js";
import type {
  GateDefinitionV1,
  GateRegistryV1,
} from "../../packages/contracts/src/quality-gate.js";
import { validateGateEvaluationContextV1 } from "../../packages/contracts/src/runtime-validation.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** 创建摘要闭合的测试 registry。 */
function createRegistry(definitions: GateDefinitionV1[]): GateRegistryV1 {
  return {
    gates: definitions.map((gateDefinition) => ({
      gateDefinition,
      gateDefinitionDigest: computeGateDefinitionDigest(gateDefinition),
    })),
    schemaVersion: 1,
  };
}

/** 创建绑定测试 producer 的 GateDefinitionV1。 */
function createDefinition(
  gateId: string,
  triggerPaths?: readonly string[],
): GateDefinitionV1 {
  return {
    blocking: true,
    capabilityOwner: "qa",
    checkId: gateId,
    command: ["pnpm", "unit"],
    evidenceProducerId: `gha-oidc://1303415307/example/controller/.github/workflows/produce-gate-evidence.yml@${"1".repeat(40)}#${gateId}`,
    gateId,
    ...(triggerPaths === undefined ? {} : { triggerPaths }),
  };
}

/** 在临时 SHA-1 仓库中创建删除、带空格路径和 rename 场景。 */
async function createGitFixture(objectFormat: "sha1" | "sha256" = "sha1"): Promise<{
  baseOid: string;
  headOid: string;
  root: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-gate-git-"));
  temporaryRoots.push(root);
  await git(root, "init", "-q", `--object-format=${objectFormat}`);
  await writeFile(path.join(root, "deleted.ts"), "export const deleted = true;\n", "utf8");
  await writeFile(path.join(root, "renamed.ts"), "export const renamed = true;\n", "utf8");
  await git(root, "add", ".");
  await git(
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Gate Fixture",
    "commit",
    "-q",
    "-m",
    "base",
  );
  await rm(path.join(root, "deleted.ts"));
  await git(root, "mv", "renamed.ts", "renamed target.ts");
  await writeFile(path.join(root, "new file.ts"), "export const added = true;\n", "utf8");
  await git(root, "add", "-A");
  await git(
    root,
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=Gate Fixture",
    "commit",
    "-q",
    "-m",
    "head",
  );
  const commits = (await git(root, "rev-list", "--max-count=2", "HEAD")).split(/\r?\n/u);
  const headOid = commits[0]!;
  const baseOid = commits[1]!;
  return { baseOid, headOid, root };
}

/** 执行 Git argv 并返回去除末尾换行的 stdout。 */
async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout.trim();
}

describe("gate applicability", () => {
  it("严格区分 SHA-1/SHA-256 完整 OID", () => {
    expect(validateFullGitOid("a".repeat(40), "sha1")).toBe(true);
    expect(validateFullGitOid("a".repeat(64), "sha256")).toBe(true);
    expect(validateFullGitOid("a".repeat(12), "sha1")).toBe(false);
    expect(validateFullGitOid("A".repeat(40), "sha1")).toBe(false);
    expect(validateFullGitOid("a".repeat(40), "sha256")).toBe(false);
  });

  it("对 merge-base --all 完整结果排序并选择最小 OID", () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    expect(selectComparisonBaseOid([second, first], "sha1")).toBe(first);
    expect(() => selectComparisonBaseOid([], "sha1")).toThrow(/merge-base/u);
    expect(() => selectComparisonBaseOid(["short"], "sha1")).toThrow(/OID/u);
  });

  it("按 NUL token 解析 name-status，保留带空格路径并拒绝逃逸", () => {
    expect(parseNameStatusZ(Buffer.from("D\0old file.ts\0A\0new file.ts\0"))).toEqual([
      { path: "old file.ts", status: "D" },
      { path: "new file.ts", status: "A" },
    ]);
    expect(() => parseNameStatusZ(Buffer.from("A\0../escape.ts\0"))).toThrow(/路径/u);
    expect(() => parseNameStatusZ(Buffer.from("A\0broken"))).toThrow(/NUL/u);
  });

  it(
    "使用真实固定 OID diff，并将 rename 表现为 delete+add",
    async () => {
      const fixture = await createGitFixture();
      const registry = createRegistry([
        createDefinition("always"),
        createDefinition("docs", ["docs/**"]),
        createDefinition("source", ["*.ts"]),
      ]);
      const gateRegistryDigest = computeGateRegistryDigest(registry);
      const evaluation = await createLocalGateFixtureEvaluation(fixture.root, {
        baseOid: fixture.baseOid,
        gateRegistryDigest,
        headOid: fixture.headOid,
        objectFormat: "sha1",
        registry,
      });

      expect(evaluation.contextKind).toBe("local-fixture");
      expect(evaluation.hostedEvidenceEligible).toBe(false);
      expect(evaluation.affectedPaths).toEqual([
        "deleted.ts",
        "new file.ts",
        "renamed target.ts",
        "renamed.ts",
      ]);
      expect(evaluation.applicability).toEqual([
        { gateId: "always", status: "required" },
        { gateId: "docs", status: "not-applicable" },
        { gateId: "source", status: "required" },
      ]);

      const providerEvaluation = await createProviderGateEvaluation(fixture.root, {
        baseOid: fixture.baseOid,
        gateRegistryDigest,
        headOid: fixture.headOid,
        objectFormat: "sha1",
        providerRepositoryId: "1303415307",
        registry,
      });
      expect(providerEvaluation.contextKind).toBe("provider-event");
      expect(providerEvaluation.hostedEvidenceEligible).toBe(true);
      expect(validateGateEvaluationContextV1(providerEvaluation.evaluationContext)).toBe(true);
    },
    20_000,
  );

  it(
    "在真实 SHA-256 Git 仓库中使用完整固定 OID",
    async () => {
      const fixture = await createGitFixture("sha256");
      const registry = createRegistry([createDefinition("always")]);
      const gateRegistryDigest = computeGateRegistryDigest(registry);

      const evaluation = await createLocalGateFixtureEvaluation(fixture.root, {
        baseOid: fixture.baseOid,
        gateRegistryDigest,
        headOid: fixture.headOid,
        objectFormat: "sha256",
        registry,
      });

      expect(fixture.baseOid).toHaveLength(64);
      expect(fixture.headOid).toHaveLength(64);
      expect(evaluation.comparisonBaseOid).toBe(fixture.baseOid);
    },
    20_000,
  );

  it("未知 gate、非法 registry 或 provider 输入一律 invalid", async () => {
    const registry = createRegistry([createDefinition("unit")]);
    expect(evaluateRegistryApplicability(registry, ["src/a.ts"], ["missing"])).toEqual([
      { gateId: "missing", status: "invalid" },
    ]);
    expect(() =>
      evaluateRegistryApplicability(
        { ...registry, gates: [...registry.gates, registry.gates[0]!] },
        ["src/a.ts"],
      ),
    ).toThrow(/registry/u);

    const gateRegistryDigest = computeGateRegistryDigest(registry);
    await expect(
      createProviderGateEvaluation(repositoryRoot, {
        baseOid: "a".repeat(12),
        gateRegistryDigest,
        headOid: "b".repeat(40),
        objectFormat: "sha1",
        providerRepositoryId: "1303415307",
        registry,
      }),
    ).rejects.toThrow(/provider|OID/u);
  });
});
