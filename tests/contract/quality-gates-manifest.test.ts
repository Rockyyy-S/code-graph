import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  assertTypeScriptModuleAnalysisBuildTopology,
  TYPESCRIPT_VERIFIER_CHILD_TIMEOUT_MS,
  TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST,
  VITEST_REPORT_MAX_BYTES,
  verifyTypeScriptModuleAnalysis,
} from "../../scripts/ci/verify-typescript-module-analysis-v1.mjs";
import { attestVitestJsonReport } from "../../scripts/ci/attest-vitest-json-report.mjs";
import {
  PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY,
  PROCESS_LIFECYCLE_CHILD_TIMEOUT_MS,
  verifyProcessLifecycle,
} from "../../scripts/ci/verify-process-lifecycle.mjs";
import { HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST } from
  "../../scripts/ci/verify-host-path-posix-helper-v1.mjs";
import unitVitestConfig from "../../vitest.config.js";
import processLifecycleVitestConfig, {
  PROCESS_LIFECYCLE_BUDGET,
} from "../../vitest.process-deadline.config.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];

type VitestAssertionStatus = "disabled" | "failed" | "passed" | "pending" | "skipped" | "todo";

interface VitestAuthority {
  attestationVersion: number;
  expectedSuiteCount: number;
  expectedTestCount: number;
  expectedTestResults: readonly {
    filePath: string;
    suites: readonly {
      ancestorTitles: readonly string[];
      expectedAssertionCount: number;
    }[];
  }[];
  shardId: string;
}

interface FakeProcessResult {
  cleanupComplete: boolean;
  containment: string | null;
  residualProcessTree: number | null;
  signalEscalation: string[];
  status: "fail" | "invalid" | "pass";
  stderr: Buffer;
  streamsDrained: boolean;
  stdout: Buffer;
  termination:
    | { code: number; kind: "exit" }
    | { kind: "signal"; signalName: NodeJS.Signals }
    | { kind: "spawn-error"; stableCode: string };
  timedOut: boolean;
}

/** 由独立 authority 构造与 Vitest JSON reporter 同形的完整运行结果。 */
function createVitestReport(
  authority: VitestAuthority,
  statuses: readonly VitestAssertionStatus[] = Array.from(
    { length: authority.expectedTestCount },
    () => "passed" as const,
  ),
): string {
  if (statuses.length !== authority.expectedTestCount) {
    throw new Error("测试 fixture 的 assertion 数必须先与 authority 闭合。");
  }
  const passed = statuses.filter((status) => status === "passed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const pending = statuses.filter(
    (status) => status === "pending" || status === "skipped" || status === "disabled",
  ).length;
  const todo = statuses.filter((status) => status === "todo").length;
  const hasNonPassing = failed > 0 || pending > 0 || todo > 0;
  let assertionIndex = 0;
  const testResults = authority.expectedTestResults.map((expectedResult) => {
    const assertionResults = expectedResult.suites.flatMap((suite) =>
      Array.from({ length: suite.expectedAssertionCount }, () => {
        const status = statuses[assertionIndex]!;
        assertionIndex += 1;
        return { ancestorTitles: [...suite.ancestorTitles], status };
      }));
    return {
      assertionResults,
      name: path.join(repositoryRoot, expectedResult.filePath),
      status: assertionResults.some(({ status }) => status === "failed")
        ? "failed"
        : assertionResults.some(({ status }) => status !== "passed")
          ? "pending"
          : "passed",
    };
  });
  const failedSuites = failed > 0 ? 1 : 0;
  const pendingSuites = failed === 0 && (pending > 0 || todo > 0) ? 1 : 0;

  return JSON.stringify({
    numFailedTestSuites: failedSuites,
    numFailedTests: failed,
    numPassedTestSuites: authority.expectedSuiteCount - failedSuites - pendingSuites,
    numPassedTests: passed,
    numPendingTestSuites: pendingSuites,
    numPendingTests: pending,
    numTodoTests: todo,
    numTotalTestSuites: authority.expectedSuiteCount,
    numTotalTests: statuses.length,
    success: !hasNonPassing,
    testResults,
  });
}

/** 构造 authority 对应的全部通过 reporter 输出。 */
function createPassingVitestReport(authority: VitestAuthority): string {
  return createVitestReport(authority);
}

/** 只改变 root/detail assertion 总数，供 59/61 与上下漂移 fail-closed 回归使用。 */
function createDriftedVitestReport(authority: VitestAuthority, actualTestCount: number): string {
  const report = JSON.parse(createPassingVitestReport(authority)) as {
    numPassedTests: number;
    numTotalTests: number;
    testResults: Array<{ assertionResults: Array<{ ancestorTitles: string[]; status: "passed" }> }>;
  };
  const lastAssertions = report.testResults.at(-1)!.assertionResults;
  if (actualTestCount === authority.expectedTestCount - 1) {
    lastAssertions.pop();
  } else if (actualTestCount === authority.expectedTestCount + 1) {
    lastAssertions.push({
      ancestorTitles: [
        ...authority.expectedTestResults.at(-1)!.suites.at(-1)!.ancestorTitles,
      ],
      status: "passed",
    });
  } else {
    throw new Error("漂移 fixture 只允许 authority 上下各一条。");
  }
  report.numPassedTests = actualTestCount;
  report.numTotalTests = actualTestCount;
  return JSON.stringify(report);
}

/** 构造已正常退出且携带 reporter stdout 的受控进程结果。 */
function createProcessResult(stdout = "", overrides: Partial<FakeProcessResult> = {}): FakeProcessResult {
  return {
    cleanupComplete: true,
    containment: "test-stable-identity",
    residualProcessTree: 0,
    signalEscalation: [],
    status: "pass",
    stderr: Buffer.alloc(0),
    streamsDrained: true,
    stdout: Buffer.from(stdout, "utf8"),
    termination: { code: 0, kind: "exit" },
    timedOut: false,
    ...overrides,
  };
}

/** 严格提取 hosted POSIX workflow 的 pull_request.paths，避免 YAML 宽松解析掩盖顺序或重复。 */
function parsePullRequestPaths(source: string): string[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const pullRequestIndex = lines.indexOf("  pull_request:");
  const pathsIndex = lines.indexOf("    paths:", pullRequestIndex + 1);
  if (pullRequestIndex < 0 || pathsIndex !== pullRequestIndex + 1) {
    throw new Error("host-path-posix-linux workflow 缺少规范 pull_request.paths。");
  }
  const triggerPaths: string[] = [];
  for (let index = pathsIndex + 1; index < lines.length; index += 1) {
    const match = /^      - "([^"]+)"$/u.exec(lines[index]!);
    if (match === null) {
      break;
    }
    triggerPaths.push(match[1]!);
  }
  if (triggerPaths.length === 0 || new Set(triggerPaths).size !== triggerPaths.length) {
    throw new Error("host-path-posix-linux pull_request.paths 必须非空且无重复。");
  }
  return triggerPaths;
}

const storyShardAuthorities = [
  ...TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.unitShards,
  ...TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.contractShards,
] as readonly VitestAuthority[];
const defaultUnitAuthority = storyShardAuthorities[0]!;

/**
 * 通过真实 verifier 编排入口注入受控子进程结果，证明计数权威没有停留在静态 manifest。
 */
async function runStoryVerifierWithOverrides(overrides: ReadonlyMap<number, FakeProcessResult> = new Map()) {
  let vitestIndex = 0;
  const executePnpm = vi.fn(async (args: string[]) => {
    if (!args.includes("vitest")) {
      return createProcessResult();
    }
    const currentIndex = vitestIndex;
    vitestIndex += 1;
    return overrides.get(currentIndex)
      ?? createProcessResult(createPassingVitestReport(storyShardAuthorities[currentIndex]!));
  });

  return {
    executePnpm,
    status: await verifyTypeScriptModuleAnalysis({ executePnpm }),
  };
}

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
   * Win32 gate 精确覆盖 producer、Story consumer、POSIX capability adapter 与 dedicated Win32 配置的三十二条影响路径；
   * triggerPaths 只描述影响面，本地 architecture-required 仍必须始终执行该 blocking gate。
   */
  [
    "host-path-identity-win32-v1",
    ["node", "scripts/ci/verify-host-path-identity-v1.mjs"],
    "qa",
    [
      "apps/graph-service/package.json",
      "apps/graph-service/src/analyzer-config.ts",
      "apps/graph-service/src/host-path-identity.ts",
      "apps/graph-service/src/index-job-runtime.ts",
      "apps/graph-service/src/index-read-set.ts",
      "apps/graph-service/src/index.ts",
      "apps/graph-service/src/workspace-scanner.ts",
      "apps/graph-service/tsconfig.build.json",
      "ci/quality-gates.v1.yaml",
      "packages/adapters/analyzer-typescript/src/analyzer-worker.ts",
      "packages/adapters/analyzer-typescript/src/module-target-resolver.ts",
      "packages/adapters/analyzer-typescript/src/typescript-analyzer.ts",
      "packages/adapters/analyzer-typescript/src/worker-analysis.ts",
      "packages/adapters/host-path-posix-native/package.json",
      "packages/adapters/host-path-posix-native/src/capability.ts",
      "packages/adapters/host-path-posix-native/src/index.ts",
      "packages/adapters/host-path-posix-native/src/protocol.ts",
      "packages/adapters/host-path-posix-native/tsconfig.build.json",
      "packages/adapters/host-path-posix-native/tsconfig.json",
      "packages/application/src/ports/analyzer-port.ts",
      "pnpm-lock.yaml",
      "scripts/ci/verify-host-path-identity-v1.mjs",
      "tests/contract/host-path-identity-win32.test.ts",
      "tests/contract/host-path-posix-capability.test.ts",
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
  /**
   * Linux helper gate 锁定 Rust/TS ABI、权限分离打包、负向测试与固定 Linux workflow；本地仍始终执行静态/focused 边界。
   */
  [
    "host-path-posix-helper-v1",
    ["node", "scripts/ci/verify-host-path-posix-helper-v1.mjs"],
    "security",
    [
      ".github/workflows/host-path-posix-linux.yml",
      "Cargo.lock",
      "Cargo.toml",
      "apps/graph-service/package.json",
      "apps/graph-service/src/host-path-identity.ts",
      "apps/graph-service/src/index-job-runtime.ts",
      "apps/graph-service/src/index.ts",
      "ci/quality-gates.v1.yaml",
      "packages/adapters/host-path-posix-native/**",
      "packaging/linux/**",
      "rust-toolchain.toml",
      "scripts/ci/verify-host-path-posix-helper-v1.mjs",
      "tests/contract/host-path-posix-helper-protocol.test.ts",
      "tests/contract/quality-gates-manifest.test.ts",
      "tests/platform/linux-host-path-helper/**",
      "tests/unit/host-path-posix-capability.test.ts",
      "tests/unit/index-job-runtime.test.ts",
    ],
  ],
  ["lint", ["pnpm", "lint"], "dev-enablement"],
  ["planning-traceability", ["pnpm", "planning-trace"], "architecture-po"],
  ["process-lifecycle", ["pnpm", "process-lifecycle"], "qa"],
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
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("quality-gates.v1 registry", () => {
  it("locks the Story 1.5 verifier unit and process regression manifest", async () => {
    const originalUnitTests = [
      "tests/unit/analyzer-config-capture.test.ts",
      "tests/unit/analyzer-config-snapshot.test.ts",
      "tests/unit/basic-symbol.test.ts",
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
    expect(TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST).toMatchObject({
      buildFilters: [
        "@codegraph/domain",
        "@codegraph/contracts",
        "@codegraph/application",
        "@codegraph/service-client",
        "@codegraph/adapter-analyzer-typescript",
        "@codegraph/adapter-git-local",
        "@codegraph/adapter-host-path-posix-native",
        "@codegraph/adapter-store-sqlite",
        "@codegraph/graph-service",
      ],
      version: 2,
    });

    const unitShards = TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.unitShards;
    const allShards = [
      ...unitShards,
      ...TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.contractShards,
    ];
    const unitTests = unitShards.flatMap(({ expectedTestResults }) =>
      expectedTestResults.map(({ filePath }) => filePath));
    expect(unitShards.map(({ shardId }) => shardId)).toEqual([
      "default-unit",
      "sqlite-module-dependencies",
    ]);
    expect(new Set(unitTests).size).toBe(unitTests.length);
    expect([...unitTests].sort()).toEqual([...originalUnitTests].sort());
    expect(unitShards.reduce((total, { expectedTestCount }) => total + expectedTestCount, 0))
      .toBe(352);
    expect(allShards.reduce((total, { expectedTestCount }) => total + expectedTestCount, 0))
      .toBe(362);
    /** 这些 suite/assertion 值来自冻结前真实 reporter，禁止从当前待验证输出临时派生。 */
    expect(allShards.map((shard) => ({
      attestationVersion: shard.attestationVersion,
      expectedSuiteCount: shard.expectedSuiteCount,
      expectedTestCount: shard.expectedTestCount,
      results: shard.expectedTestResults.map((result) => ({
        filePath: result.filePath,
        suites: result.suites.map((suite) => ({
          ancestorTitles: suite.ancestorTitles,
          expectedAssertionCount: suite.expectedAssertionCount,
        })),
      })),
      shardId: shard.shardId,
    }))).toEqual([
      {
        attestationVersion: 1,
        expectedSuiteCount: 24,
        expectedTestCount: 292,
        results: [
          ["tests/unit/analyzer-config-capture.test.ts", "Story 1.5 Analyzer configuration capture", 53],
          ["tests/unit/analyzer-config-snapshot.test.ts", "Story 1.5 analyzer config snapshot", 8],
          ["tests/unit/basic-symbol.test.ts", "Story 1.6 BasicSymbolV1", 11],
          ["tests/unit/composite-graph-patch.test.ts", "Story 1.5 composite graph patch", 8],
          ["tests/unit/index-job-runtime.test.ts", "index job runtime", 33],
          ["tests/unit/index-read-set.test.ts", "index read-set provider", 41],
          ["tests/unit/module-dependency-domain.test.ts", "Story 1.5 module dependency domain", 6],
          ["tests/unit/module-fact-batch.test.ts", "Story 1.5 source module FactBatch", 4],
          ["tests/unit/sqlite-graph-store.test.ts", "sqlite graph store", 79],
          ["tests/unit/typescript-analyzer-worker.test.ts", "Story 1.5 TypeScript Analyzer Worker", 19],
          ["tests/unit/typescript-module-resolution.test.ts", "Story 1.5 module target priority", 17],
          ["tests/unit/typescript-module-syntax.test.ts", "Story 1.5 AD-24 TypeScript syntax mapping", 13],
        ].map(([filePath, ancestorTitle, expectedAssertionCount]) => ({
          filePath,
          suites: [{ ancestorTitles: [ancestorTitle], expectedAssertionCount }],
        })),
        shardId: "default-unit",
      },
      {
        attestationVersion: 1,
        expectedSuiteCount: 2,
        expectedTestCount: 60,
        results: [{
          filePath: "tests/unit/sqlite-module-dependencies.test.ts",
          suites: [{
            ancestorTitles: ["Story 1.5 SQLite module dependency storage"],
            expectedAssertionCount: 60,
          }],
        }],
        shardId: "sqlite-module-dependencies",
      },
      {
        attestationVersion: 1,
        expectedSuiteCount: 4,
        expectedTestCount: 10,
        results: [
          {
            filePath: "tests/contract/basic-symbol-contract.test.ts",
            suites: [{
              ancestorTitles: ["Story 1.6 BasicSymbolV1 contract"],
              expectedAssertionCount: 4,
            }],
          },
          {
            filePath: "tests/contract/graph-service-process.test.ts",
            suites: [{
              ancestorTitles: ["real graph-service process"],
              expectedAssertionCount: 6,
            }],
          },
        ],
        shardId: "graph-service-process",
      },
    ]);
    const verifierSource = await readFile(
      path.join(repositoryRoot, "scripts/ci/verify-typescript-module-analysis-v1.mjs"),
      "utf8",
    );
    expect(TYPESCRIPT_VERIFIER_CHILD_TIMEOUT_MS).toBe(120_000);
    expect(verifierSource).toContain("runProcessWithDeadline");
    expect(verifierSource).not.toMatch(/\bspawnSync\s*\(/u);
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
        "@codegraph/adapter-host-path-posix-native",
        "@codegraph/adapter-store-sqlite",
      ]],
    ]);

    for (const [dependent, required] of dependencies) {
      for (const dependency of required) {
        expect(order.get(dependency), `${dependency} 必须先于 ${dependent} 构建`)
          .toBeLessThan(order.get(dependent)!);
      }
    }

    expect(() => assertTypeScriptModuleAnalysisBuildTopology(
      buildFilters.filter((filter) => filter !== "@codegraph/adapter-host-path-posix-native"),
    )).toThrow(/BUILD_TOPOLOGY_INVALID/u);
    expect(() => assertTypeScriptModuleAnalysisBuildTopology([
      ...buildFilters.filter((filter) => filter !== "@codegraph/adapter-host-path-posix-native"),
      "@codegraph/adapter-host-path-posix-native",
    ])).toThrow(/BUILD_TOPOLOGY_INVALID/u);
  });

  it("consumes exact 292 + 60 unit and 10 contract runtime attestations", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { executePnpm, status } = await runStoryVerifierWithOverrides();

    expect(status).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(" ")).toContain("292/292 tests");
    expect(logSpy.mock.calls.flat().join(" ")).toContain("60/60 tests");
    expect(logSpy.mock.calls.flat().join(" ")).toContain("10/10 tests");
    expect(logSpy.mock.calls.flat().join(" ")).toContain("24/24 suites");

    const commands = executePnpm.mock.calls.map(([args]) => args);
    const buildFilters = commands
      .filter((args) => args[0] === "--filter")
      .map((args) => args[1]);
    expect(buildFilters).toEqual(TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.buildFilters);
    expect(buildFilters.indexOf("@codegraph/adapter-host-path-posix-native"))
      .toBeLessThan(buildFilters.indexOf("@codegraph/graph-service"));

    const vitestCommands = commands.filter((args) => args.includes("vitest"));
    expect(vitestCommands).toHaveLength(3);
    expect(vitestCommands.every((args) => args.includes("--reporter=json"))).toBe(true);
  });

  it("fails closed before Vitest when a build child reaches its deadline", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executePnpm = vi.fn(async () => createProcessResult("", {
      signalEscalation: ["SIGTERM", "SIGKILL"],
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
      timedOut: true,
    }));

    expect(await verifyTypeScriptModuleAnalysis({ executePnpm })).toBe(1);
    expect(executePnpm).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("BUILD_TIMEOUT");
  });

  it.each([
    ["default unit lower drift", 0, 291],
    ["SQLite unit lower drift", 1, 59],
    ["contract lower drift", 2, 9],
  ] as const)("rejects %s runtime totals", async (_label, shardIndex, reducedCount) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const overrides = new Map<number, FakeProcessResult>([
      [shardIndex, createProcessResult(createDriftedVitestReport(
        storyShardAuthorities[shardIndex]!,
        reducedCount,
      ))],
    ]);

    expect((await runStoryVerifierWithOverrides(overrides)).status).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("VITEST_COUNT_MISMATCH");
  });

  it("rejects SQLite unit upper drift instead of accepting actual >= expected", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const overrides = new Map<number, FakeProcessResult>([
      [1, createProcessResult(createDriftedVitestReport(storyShardAuthorities[1]!, 61))],
    ]);

    expect((await runStoryVerifierWithOverrides(overrides)).status).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("VITEST_COUNT_MISMATCH");
  });

  it.each([
    [
      "failed",
      createProcessResult(createVitestReport(defaultUnitAuthority, [
        ...Array.from({ length: 291 }, () => "passed" as const),
        "failed",
      ])),
      "VITEST_FAILED",
    ],
    [
      "pending",
      createProcessResult(createVitestReport(defaultUnitAuthority, [
        ...Array.from({ length: 291 }, () => "passed" as const),
        "pending",
      ])),
      "VITEST_NONPASSING",
    ],
    [
      "skipped",
      createProcessResult(createVitestReport(defaultUnitAuthority, [
        ...Array.from({ length: 291 }, () => "passed" as const),
        "skipped",
      ])),
      "VITEST_NONPASSING",
    ],
    [
      "todo",
      createProcessResult(createVitestReport(defaultUnitAuthority, [
        ...Array.from({ length: 291 }, () => "passed" as const),
        "todo",
      ])),
      "VITEST_NONPASSING",
    ],
    ["malformed", createProcessResult("{not-json"), "VITEST_REPORT_MALFORMED"],
    ["empty", createProcessResult("  \r\n"), "VITEST_REPORT_EMPTY"],
    [
      "oversized",
      createProcessResult("x".repeat(VITEST_REPORT_MAX_BYTES + 1)),
      "VITEST_REPORT_OVERSIZED",
    ],
    [
      "abnormal termination",
      createProcessResult(createPassingVitestReport(defaultUnitAuthority), {
        status: "fail",
        termination: { kind: "signal", signalName: "SIGTERM" },
      }),
      "VITEST_ABNORMAL_TERMINATION",
    ],
    [
      "deadline timeout",
      createProcessResult(createPassingVitestReport(defaultUnitAuthority), {
        signalEscalation: ["SIGTERM", "SIGKILL"],
        status: "invalid",
        termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
        timedOut: true,
      }),
      "VITEST_TIMEOUT",
    ],
    [
      "unproven cleanup",
      createProcessResult(createPassingVitestReport(defaultUnitAuthority), {
        cleanupComplete: false,
        containment: null,
        residualProcessTree: 1,
        status: "invalid",
        streamsDrained: false,
        termination: { kind: "spawn-error", stableCode: "EPROCESSCLEANUP" },
      }),
      "VITEST_CLEANUP_UNPROVEN",
    ],
  ] as const)("fails closed on %s reporter evidence", async (_label, result, expectedCode) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const overrides = new Map<number, FakeProcessResult>([[0, result]]);

    expect((await runStoryVerifierWithOverrides(overrides)).status).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain(expectedCode);
  });

  it("fails closed when reporter assertion details do not cover the aggregate total", async () => {
    const report = JSON.parse(createPassingVitestReport(defaultUnitAuthority)) as {
      testResults: Array<{ assertionResults: unknown[] }>;
    };
    report.testResults[0]!.assertionResults.pop();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const overrides = new Map<number, FakeProcessResult>([
      [0, createProcessResult(JSON.stringify(report))],
    ]);

    expect((await runStoryVerifierWithOverrides(overrides)).status).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("VITEST_SUITE_ASSERTION_MISMATCH");
  });

  it.each([
    ["lower", -1],
    ["upper", 1],
  ] as const)("rejects %s suite-count drift", (_label, delta) => {
    const report = JSON.parse(createPassingVitestReport(defaultUnitAuthority)) as {
      numPassedTestSuites: number;
      numTotalTestSuites: number;
    };
    report.numPassedTestSuites += delta;
    report.numTotalTestSuites += delta;

    expect(() => attestVitestJsonReport(
      JSON.stringify(report),
      defaultUnitAuthority,
      { repositoryRoot },
    )).toThrow(/VITEST_SUITE_COUNT_MISMATCH/u);
  });

  it.each([
    ["missing", (results: unknown[]) => results.pop()],
    ["extra", (results: unknown[]) => results.push(structuredClone(results[0]))],
  ] as const)("rejects %s testResult even when root totals remain unchanged", (_label, mutate) => {
    const report = JSON.parse(createPassingVitestReport(defaultUnitAuthority)) as {
      testResults: unknown[];
    };
    mutate(report.testResults);

    expect(() => attestVitestJsonReport(
      JSON.stringify(report),
      defaultUnitAuthority,
      { repositoryRoot },
    )).toThrow(/VITEST_TEST_RESULT_COUNT_MISMATCH/u);
  });

  it.each([
    ["missing", (assertions: Array<{ ancestorTitles: string[] }>) => {
      for (const assertion of assertions) {
        assertion.ancestorTitles = [];
      }
    }],
    ["extra", (assertions: Array<{ ancestorTitles: string[] }>) => {
      assertions[0]!.ancestorTitles = ["extra suite"];
    }],
  ] as const)("rejects %s suite topology", (_label, mutate) => {
    const report = JSON.parse(createPassingVitestReport(defaultUnitAuthority)) as {
      testResults: Array<{ assertionResults: Array<{ ancestorTitles: string[] }> }>;
    };
    mutate(report.testResults[0]!.assertionResults);

    expect(() => attestVitestJsonReport(
      JSON.stringify(report),
      defaultUnitAuthority,
      { repositoryRoot },
    )).toThrow(/VITEST_SUITE_ASSERTION_MISMATCH/u);
  });

  it("rejects assertion movement while suite and assertion root totals stay unchanged", () => {
    const report = JSON.parse(createPassingVitestReport(defaultUnitAuthority)) as {
      testResults: Array<{ assertionResults: Array<{ ancestorTitles: string[] }> }>;
    };
    report.testResults[0]!.assertionResults[0]!.ancestorTitles = ["moved suite"];

    expect(() => attestVitestJsonReport(
      JSON.stringify(report),
      defaultUnitAuthority,
      { repositoryRoot },
    )).toThrow(/VITEST_SUITE_ASSERTION_MISMATCH/u);
  });

  it("将普通 unit 与独立 process lifecycle blocking gate 的配置和预算锁定", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const processVerifierSource = await readFile(
      path.join(repositoryRoot, "scripts/ci/verify-process-lifecycle.mjs"),
      "utf8",
    );

    expect(packageJson.scripts.unit).toBe(
      "node scripts/quality/check-test-markers.mjs && vitest run --config vitest.config.ts",
    );
    expect(packageJson.scripts["process-lifecycle"]).toBe(
      "node scripts/ci/verify-process-lifecycle.mjs",
    );
    expect(PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY).toEqual({
      attestationVersion: 1,
      expectedSuiteCount: 2,
      expectedTestCount: 15,
      expectedTestResults: [{
        filePath: "tests/unit/process-deadline.test.ts",
        suites: [{ ancestorTitles: ["process deadline"], expectedAssertionCount: 15 }],
      }],
      shardId: "process-lifecycle",
    });
    expect(PROCESS_LIFECYCLE_BUDGET).toEqual({
      declaredTestBudgetMs: 140_000,
      expectedTestCount: 15,
      fastTestCount: 13,
      gateTimeoutMs: 180_000,
      gitTestTimeoutMs: 45_000,
      requiredMarginMs: 30_000,
      testTimeoutMs: 5_000,
      windowsMatrixTimeoutMs: 30_000,
    });
    expect(PROCESS_LIFECYCLE_BUDGET.expectedTestCount)
      .toBe(PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY.expectedTestCount);
    expect(PROCESS_LIFECYCLE_CHILD_TIMEOUT_MS).toBe(PROCESS_LIFECYCLE_BUDGET.gateTimeoutMs);
    expect(processVerifierSource).toContain("--reporter=json");
    expect(processVerifierSource).toContain("attestVitestJsonReport");
    expect(processVerifierSource).not.toMatch(/match\s*\(.*\\bit/du);
    expect(unitVitestConfig.test?.projects).toBeUndefined();
    expect(unitVitestConfig.test?.exclude).toContain("tests/unit/process-deadline.test.ts");
    expect(processLifecycleVitestConfig.test).toMatchObject({
      fileParallelism: false,
      include: ["tests/unit/process-deadline.test.ts"],
      maxWorkers: 1,
      name: "process-lifecycle",
      passWithNoTests: false,
      pool: "forks",
      testTimeout: PROCESS_LIFECYCLE_BUDGET.testTimeoutMs,
    });
    expect(
      PROCESS_LIFECYCLE_BUDGET.gateTimeoutMs -
        PROCESS_LIFECYCLE_BUDGET.declaredTestBudgetMs,
    ).toBeGreaterThanOrEqual(PROCESS_LIFECYCLE_BUDGET.requiredMarginMs);
  });

  it("process-lifecycle consumes the real reporter and PF-A bounded terminal proof", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const executeNode = vi.fn(async (_args: string[]) => createProcessResult());
    const executePnpm = vi.fn(async (_args: string[]) => createProcessResult(
      createPassingVitestReport(PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY),
    ));

    expect(await verifyProcessLifecycle({ executeNode, executePnpm })).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(" ")).toContain("15/15 tests");
    expect(logSpy.mock.calls.flat().join(" ")).toContain("2/2 suites");
    expect(executePnpm.mock.calls[0]?.[0]).toContain("--reporter=json");
  });

  it.each([
    ["it.each", "it.each([[1], [2]])('row', () => undefined)"],
    ["alias", "const caseOf = it; caseOf('alias', () => undefined)"],
    ["dynamic", "for (const row of rows) it(row.name, row.run)"],
    ["non-executed-text", "const sample = `it('not executed', () => {})`"],
  ] as const)("ignores %s source fixture and fails on runtime reporter drift", (_label, sourceFixture) => {
    expect(sourceFixture.length).toBeGreaterThan(0);
    expect(() => attestVitestJsonReport(
      createDriftedVitestReport(PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY, 14),
      PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY,
      { repositoryRoot },
    )).toThrow(/VITEST_COUNT_MISMATCH/u);
  });

  it("process-lifecycle rejects unproven cleanup even with a valid reporter", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const executeNode = vi.fn(async () => createProcessResult());
    const executePnpm = vi.fn(async () => createProcessResult(
      createPassingVitestReport(PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY),
      {
        cleanupComplete: false,
        residualProcessTree: 1,
        status: "invalid",
        streamsDrained: false,
        termination: { kind: "spawn-error", stableCode: "EPROCESSCLEANUP" },
      },
    ));

    expect(await verifyProcessLifecycle({ executeNode, executePnpm })).toBe(1);
  });

  it("登记唯一、升序且由本地 runner 始终执行的二十七项 blocking gate", async () => {
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
    const workflowTriggerPaths = parsePullRequestPaths(await readFile(
      path.join(repositoryRoot, ".github/workflows/host-path-posix-linux.yml"),
      "utf8",
    ));
    const posixGate = loaded.registry.gates.find(
      ({ gateDefinition }: { gateDefinition: { gateId: string } }) =>
        gateDefinition.gateId === "host-path-posix-helper-v1",
    );

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
    expect(workflowTriggerPaths).toEqual([
      ...HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.triggerPaths,
    ]);
    expect(posixGate?.gateDefinition.triggerPaths).toEqual(workflowTriggerPaths);

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
