import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadQualityGateRegistry,
  validateQualityGateRegistry,
} from "../../scripts/ci/load-quality-gates.mjs";
import {
  QUALITY_GATES,
  runArchitectureRequired,
} from "../../scripts/ci/run-architecture-required.mjs";
import {
  TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST,
} from "../../scripts/ci/verify-typescript-module-analysis-v1.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];

const expectedGates = [
  ["basic-security", ["pnpm", "basic-security"], "security"],
  ["build", ["pnpm", "build"], "dev-enablement"],
  ["contract", ["pnpm", "contract"], "qa"],
  ["dependency-boundary", ["pnpm", "dependency-boundary"], "architecture"],
  [
    "deterministic-rebuild-atomic-v1",
    ["node", "scripts/ci/verify-deterministic-rebuild-v1.mjs"],
    "qa",
  ],
  [
    "deterministic-rebuild-error-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-error-v1.mjs", "--capability", "schema:errorV1Schema", "--test", "tests/unit/deterministic-rebuild-error-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-error-v1.json", "--evidence-id", "public-capability:schema:errorV1Schema"],
    "qa",
  ],
  [
    "deterministic-rebuild-initialize-compatible-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-initialize-compatible-v1.mjs", "--capability", "schema:initializeResultCompatibleSchema", "--test", "tests/unit/deterministic-rebuild-initialize-compatible-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-initialize-compatible-v1.json", "--evidence-id", "public-capability:schema:initializeResultCompatibleSchema"],
    "qa",
  ],
  [
    "deterministic-rebuild-initialize-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-initialize-v1.mjs", "--capability", "schema:initializeResultSchema", "--test", "tests/unit/deterministic-rebuild-initialize-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-initialize-v1.json", "--evidence-id", "public-capability:schema:initializeResultSchema"],
    "qa",
  ],
  [
    "deterministic-rebuild-job-result-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-job-result-v1.mjs", "--capability", "schema:jobStartResultV1Schema", "--test", "tests/unit/deterministic-rebuild-job-result-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-job-result-v1.json", "--evidence-id", "public-capability:schema:jobStartResultV1Schema"],
    "qa",
  ],
  [
    "deterministic-rebuild-rpc-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-rpc-v1.mjs", "--capability", "rpc:job/start", "--test", "tests/unit/deterministic-rebuild-rpc-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-rpc-v1.json", "--evidence-id", "public-capability:rpc:job/start"],
    "qa",
  ],
  [
    "deterministic-rebuild-status-compatible-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-status-compatible-v1.mjs", "--capability", "schema:serviceStatusV1CompatibleSchema", "--test", "tests/unit/deterministic-rebuild-status-compatible-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-status-compatible-v1.json", "--evidence-id", "public-capability:schema:serviceStatusV1CompatibleSchema"],
    "qa",
  ],
  [
    "deterministic-rebuild-status-v1",
    ["node", "scripts/contracts/verify-deterministic-rebuild-status-v1.mjs", "--capability", "schema:serviceStatusV1Schema", "--test", "tests/unit/deterministic-rebuild-status-v1-capability.test.ts", "--fixture", "tests/fixtures/deterministic-rebuild-status-v1.json", "--evidence-id", "public-capability:schema:serviceStatusV1Schema"],
    "qa",
  ],
  [
    "graph-bootstrap-job-request-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-job-request-v1.mjs", "--capability", "schema:jobStartRequestV1Schema", "--test", "tests/unit/graph-bootstrap-job-request-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-job-request-v1.json", "--evidence-id", "public-capability:schema:jobStartRequestV1Schema"],
    "qa",
  ],
  /**
   * 第 24 个 gate 精确覆盖 producer、Story consumer 与 dedicated Win32 配置的二十二条影响路径；
   * triggerPaths 只描述影响面，本地 architecture-required 仍必须始终执行该 blocking gate。
   */
  [
    "host-path-identity-win32-v1",
    ["node", "scripts/ci/verify-host-path-identity-v1.mjs"],
    "qa",
    [
      "apps/graph-service/src/analyzer-config.ts",
      "apps/graph-service/src/host-path-identity.ts",
      "apps/graph-service/src/index-job-runtime.ts",
      "apps/graph-service/src/index-read-set.ts",
      "apps/graph-service/src/index.ts",
      "apps/graph-service/src/workspace-scanner.ts",
      "ci/quality-gates.v1.yaml",
      "packages/adapters/analyzer-typescript/src/analyzer-worker.ts",
      "packages/adapters/analyzer-typescript/src/module-target-resolver.ts",
      "packages/adapters/analyzer-typescript/src/typescript-analyzer.ts",
      "packages/adapters/analyzer-typescript/src/worker-analysis.ts",
      "packages/application/src/ports/analyzer-port.ts",
      "scripts/ci/verify-host-path-identity-v1.mjs",
      "tests/contract/host-path-identity-win32.test.ts",
      "tests/contract/quality-gates-manifest.test.ts",
      "tests/unit/analyzer-config-capture.test.ts",
      "tests/unit/host-path-identity.test.ts",
      "tests/unit/index-job-runtime.test.ts",
      "tests/unit/index-read-set.test.ts",
      "tests/unit/typescript-analyzer-worker.test.ts",
      "tests/unit/typescript-module-resolution.test.ts",
      "vitest.contract.win32.config.ts",
    ],
  ],
  ["lint", ["pnpm", "lint"], "dev-enablement"],
  ["planning-traceability", ["pnpm", "planning-trace"], "architecture-po"],
  [
    "public-gate-definition-v1",
    ["node", "scripts/contracts/verify-public-gate-definition-v1.mjs", "--capability", "schema:gateDefinitionV1Schema", "--test", "tests/unit/public-gate-definition-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-definition-v1.json", "--evidence-id", "public-capability:schema:gateDefinitionV1Schema"],
    "qa",
  ],
  [
    "public-gate-evaluation-context-v1",
    ["node", "scripts/contracts/verify-public-gate-evaluation-context-v1.mjs", "--capability", "schema:gateEvaluationContextV1Schema", "--test", "tests/unit/public-gate-evaluation-context-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-evaluation-context-v1.json", "--evidence-id", "public-capability:schema:gateEvaluationContextV1Schema"],
    "qa",
  ],
  [
    "public-gate-evidence-v1",
    ["node", "scripts/contracts/verify-public-gate-evidence-v1.mjs", "--capability", "schema:gateEvidenceV1Schema", "--test", "tests/unit/public-gate-evidence-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-evidence-v1.json", "--evidence-id", "public-capability:schema:gateEvidenceV1Schema"],
    "qa",
  ],
  [
    "public-gate-output-v1",
    ["node", "scripts/contracts/verify-public-gate-output-v1.mjs", "--capability", "schema:gateOutputV1Schema", "--test", "tests/unit/public-gate-output-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-output-v1.json", "--evidence-id", "public-capability:schema:gateOutputV1Schema"],
    "qa",
  ],
  [
    "public-gate-registry-v1",
    ["node", "scripts/contracts/verify-public-gate-registry-v1.mjs", "--capability", "schema:gateRegistryV1Schema", "--test", "tests/unit/public-gate-registry-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-registry-v1.json", "--evidence-id", "public-capability:schema:gateRegistryV1Schema"],
    "qa",
  ],
  [
    "repository-contract-preflight",
    ["node", "scripts/contracts/validate-repository-contract.mjs"],
    "dev-enablement",
  ],
  ["type", ["pnpm", "type"], "dev-enablement"],
  [
    "typescript-module-analysis-v1",
    ["node", "scripts/ci/verify-typescript-module-analysis-v1.mjs"],
    "qa",
  ],
  ["unit", ["pnpm", "unit"], "qa"],
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("quality-gates.v1 registry", () => {
  it("locks the Story 1.5 verifier unit and process regression manifest", () => {
    const originalUnitTests = [
      "tests/unit/analyzer-config-capture.test.ts",
      "tests/unit/analyzer-config-snapshot.test.ts",
      "tests/unit/composite-graph-patch.test.ts",
      "tests/unit/index-job-runtime.test.ts",
      "tests/unit/index-read-set.test.ts",
      "tests/unit/module-dependency-domain.test.ts",
      "tests/unit/module-fact-batch.test.ts",
      "tests/unit/sqlite-graph-store.test.ts",
      "tests/unit/sqlite-module-dependencies.test.ts",
      "tests/unit/typescript-analyzer-worker.test.ts",
      "tests/unit/typescript-module-resolution.test.ts",
      "tests/unit/typescript-module-syntax.test.ts",
    ] as const;
    expect(TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST).toEqual({
      buildFilters: [
        "@codegraph/domain",
        "@codegraph/contracts",
        "@codegraph/application",
        "@codegraph/service-client",
        "@codegraph/adapter-analyzer-typescript",
        "@codegraph/adapter-git-local",
        "@codegraph/adapter-store-sqlite",
        "@codegraph/graph-service",
      ],
      contractTests: ["tests/contract/graph-service-process.test.ts"],
      unitShards: [
        {
          expectedTestCount: 257,
          shardId: "default-unit",
          tests: originalUnitTests.filter(
            (testPath) => testPath !== "tests/unit/sqlite-module-dependencies.test.ts",
          ),
        },
        {
          expectedTestCount: 24,
          shardId: "sqlite-module-dependencies",
          tests: ["tests/unit/sqlite-module-dependencies.test.ts"],
        },
      ],
      version: 1,
    });

    const unitShards = TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.unitShards;
    const unitTests = unitShards.flatMap(({ tests }) => tests);
    expect(unitShards.map(({ shardId }) => shardId)).toEqual([
      "default-unit",
      "sqlite-module-dependencies",
    ]);
    expect(new Set(unitTests).size).toBe(unitTests.length);
    expect([...unitTests].sort()).toEqual([...originalUnitTests].sort());
    expect(unitShards.reduce((total, { expectedTestCount }) => total + expectedTestCount, 0))
      .toBe(281);
  });

  it("CR7-006 locks a clean-checkout build topology without relying on pre-existing dist", () => {
    const buildFilters = TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.buildFilters;
    const order = new Map(buildFilters.map((filter, index) => [filter, index]));
    const dependencies = new Map<string, readonly string[]>([
      ["@codegraph/application", ["@codegraph/domain"]],
      ["@codegraph/service-client", ["@codegraph/application", "@codegraph/contracts"]],
      ["@codegraph/adapter-analyzer-typescript", ["@codegraph/application", "@codegraph/domain"]],
      ["@codegraph/adapter-git-local", ["@codegraph/application", "@codegraph/domain"]],
      ["@codegraph/adapter-store-sqlite", ["@codegraph/application", "@codegraph/domain"]],
      ["@codegraph/graph-service", [
        "@codegraph/contracts",
        "@codegraph/application",
        "@codegraph/service-client",
        "@codegraph/adapter-analyzer-typescript",
        "@codegraph/adapter-git-local",
        "@codegraph/adapter-store-sqlite",
      ]],
    ]);

    for (const [dependent, required] of dependencies) {
      for (const dependency of required) {
        expect(order.get(dependency), `${dependency} 必须先于 ${dependent} 构建`)
          .toBeLessThan(order.get(dependent)!);
      }
    }
  });

  it("登记唯一、升序且由本地 runner 始终执行的二十五项 blocking gate", async () => {
    const loaded = await loadQualityGateRegistry(repositoryRoot);
    const expectedGateIds = expectedGates.map(([gateId]) => gateId);
    const workflowShas = new Set<string>(loaded.registry.gates.map(({
      gateDefinition,
    }: {
      gateDefinition: { evidenceProducerId: string; gateId: string };
    }) => {
      const match = /@([a-f0-9]{40})#/u.exec(gateDefinition.evidenceProducerId);
      if (match === null) {
        throw new Error(`gate ${gateDefinition.gateId} producer SHA 无法解析。`);
      }
      return match[1]!;
    }));
    expect(workflowShas.size).toBe(1);
    const workflowSha = [...workflowShas][0]!;

    expect(loaded.gateRegistryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.registry.gates).toHaveLength(expectedGates.length);
    expectedGates.forEach(([gateId, command, capabilityOwner, triggerPaths], index) => {
      const entry = loaded.registry.gates[index]!;
      expect(entry.gateDefinition).toEqual({
        blocking: true,
        capabilityOwner,
        checkId: gateId,
        command,
        evidenceProducerId: `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@${workflowSha}#${gateId}`,
        gateId,
        ...(triggerPaths === undefined ? {} : { triggerPaths }),
      });
      expect(entry.gateDefinitionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.hasOwn(entry.gateDefinition, "triggerPaths")).toBe(
        triggerPaths !== undefined,
      );
    });

    expect(QUALITY_GATES).toEqual(expectedGateIds);
    const execute = vi.fn(async () => ({
      status: "pass" as const,
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
      stdout: Buffer.alloc(0),
      stdoutTruncated: false,
      termination: { code: 0, kind: "exit" as const },
    }));
    const result = await runArchitectureRequired({
      execute,
      registry: loaded.registry,
      writeArtifacts: false,
    });

    expect(execute).toHaveBeenCalledTimes(expectedGates.length);
    expect(result.gates.map(({ gateId, status }) => ({ gateId, status }))).toEqual(
      expectedGateIds.map((gateId) => ({ gateId, status: "pass" })),
    );
  });

  it.each([
    ["unknown root field", (registry: Record<string, unknown>) => ({ ...registry, unknown: true })],
    [
      "definition digest drift",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as {
          gates: Array<{ gateDefinitionDigest: string }>;
        };
        copy.gates[0]!.gateDefinitionDigest = "0".repeat(64);
        return copy;
      },
    ],
    [
      "no-op command",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as {
          gates: Array<{ gateDefinition: { command: string[] } }>;
        };
        copy.gates[0]!.gateDefinition.command = ["true"];
        return copy;
      },
    ],
    [
      "attached node inline command",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as {
          gates: Array<{ gateDefinition: { command: string[] } }>;
        };
        copy.gates[0]!.gateDefinition.command = ["node", "--eval=process.exit(0)"];
        return copy;
      },
    ],
    [
      "unsorted gates",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as { gates: unknown[] };
        [copy.gates[0], copy.gates[1]] = [copy.gates[1], copy.gates[0]];
        return copy;
      },
    ],
  ])("拒绝 %s", async (_label, mutate) => {
    const loaded = await loadQualityGateRegistry(repositoryRoot);
    expect(() => validateQualityGateRegistry(mutate(loaded.registry))).toThrow();
  });

  it("从隔离根目录读取固定 ci/quality-gates.v1.yaml，而不扫描其他清单", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-gate-registry-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "ci"), { recursive: true });
    await writeFile(
      path.join(root, "ci", "quality-gates.v1.yaml"),
      JSON.stringify({ gates: [], schemaVersion: 1 }),
      "utf8",
    );

    await expect(loadQualityGateRegistry(root)).rejects.toThrow(/gates/u);
  });
});
