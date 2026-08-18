import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_PROCESS_CLEANUP_GRACE_MS,
  runProcessWithDeadline,
} from "./run-process-with-deadline.mjs";
import {
  assertBoundedProcessSuccess,
  attestVitestJsonReport,
  getBoundedProcessFailureCode,
  VITEST_JSON_REPORT_MAX_BYTES,
} from "./attest-vitest-json-report.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** JSON reporter 的 stdout/stderr 各自最多保留 4 MiB，避免异常测试无限占用内存。 */
export const VITEST_REPORT_MAX_BYTES = VITEST_JSON_REPORT_MAX_BYTES;
export { attestVitestJsonReport };
/** 单个 build/Vitest 子进程的硬上限；外层 gate 仍可施加更小的整体 deadline。 */
export const TYPESCRIPT_VERIFIER_CHILD_TIMEOUT_MS = 120_000;
const BUILD_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

/** Story verifier 的固定清单由 contract 回归锁定，禁止静默缩小。 */
export const TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST = Object.freeze({
  /** clean checkout 不含 dist，必须按 project reference 拓扑先构建所有被依赖包。 */
  buildFilters: Object.freeze([
    "@codegraph/domain",
    "@codegraph/contracts",
    "@codegraph/application",
    "@codegraph/service-client",
    "@codegraph/adapter-analyzer-typescript",
    "@codegraph/adapter-git-local",
    "@codegraph/adapter-host-path-posix-native",
    "@codegraph/adapter-store-sqlite",
    "@codegraph/graph-service",
  ]),
  contractShards: Object.freeze([
    Object.freeze({
      attestationVersion: 1,
      expectedSuiteCount: 4,
      expectedTestCount: 10,
      expectedTestResults: Object.freeze([
        Object.freeze({
          filePath: "tests/contract/basic-symbol-contract.test.ts",
          suites: Object.freeze([
            Object.freeze({
              ancestorTitles: Object.freeze(["Story 1.6 BasicSymbolV1 contract"]),
              expectedAssertionCount: 4,
            }),
          ]),
        }),
        Object.freeze({
          filePath: "tests/contract/graph-service-process.test.ts",
          suites: Object.freeze([
            Object.freeze({
              ancestorTitles: Object.freeze(["real graph-service process"]),
              expectedAssertionCount: 6,
            }),
          ]),
        }),
      ]),
      shardId: "graph-service-process",
    }),
  ]),
  /** 按数组顺序串行启动独立 Vitest 进程，隔离 SQLite 锁与构建后并行资源竞争。 */
  unitShards: Object.freeze([
    Object.freeze({
      attestationVersion: 1,
      expectedSuiteCount: 24,
      expectedTestCount: 292,
      expectedTestResults: Object.freeze([
        Object.freeze({
          filePath: "tests/unit/analyzer-config-capture.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 Analyzer configuration capture"]),
            expectedAssertionCount: 53,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/analyzer-config-snapshot.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 analyzer config snapshot"]),
            expectedAssertionCount: 8,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/basic-symbol.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.6 BasicSymbolV1"]),
            expectedAssertionCount: 11,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/composite-graph-patch.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 composite graph patch"]),
            expectedAssertionCount: 8,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/index-job-runtime.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["index job runtime"]),
            expectedAssertionCount: 33,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/index-read-set.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["index read-set provider"]),
            expectedAssertionCount: 41,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/module-dependency-domain.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 module dependency domain"]),
            expectedAssertionCount: 6,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/module-fact-batch.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 source module FactBatch"]),
            expectedAssertionCount: 4,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/sqlite-graph-store.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["sqlite graph store"]),
            expectedAssertionCount: 79,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/typescript-analyzer-worker.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 TypeScript Analyzer Worker"]),
            expectedAssertionCount: 19,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/typescript-module-resolution.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 module target priority"]),
            expectedAssertionCount: 17,
          })]),
        }),
        Object.freeze({
          filePath: "tests/unit/typescript-module-syntax.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 AD-24 TypeScript syntax mapping"]),
            expectedAssertionCount: 13,
          })]),
        }),
      ]),
      shardId: "default-unit",
    }),
    Object.freeze({
      /** 该计数是独立审阅后的权威，禁止从 reporter actual 动态派生并自授权。 */
      attestationVersion: 1,
      expectedSuiteCount: 2,
      expectedTestCount: 60,
      expectedTestResults: Object.freeze([
        Object.freeze({
          filePath: "tests/unit/sqlite-module-dependencies.test.ts",
          suites: Object.freeze([Object.freeze({
            ancestorTitles: Object.freeze(["Story 1.5 SQLite module dependency storage"]),
            expectedAssertionCount: 60,
          })]),
        }),
      ]),
      shardId: "sqlite-module-dependencies",
    }),
  ]),
  version: 2,
});

/**
 * 锁定 graph-service clean-checkout 所需的 POSIX adapter 构建前置。
 *
 * @param {readonly string[]} buildFilters 待校验的构建过滤器。
 * @throws {Error} 过滤器重复、缺失或顺序错误时抛出稳定错误。
 */
export function assertTypeScriptModuleAnalysisBuildTopology(buildFilters) {
  const uniqueFilters = new Set(buildFilters);
  const posixAdapter = "@codegraph/adapter-host-path-posix-native";
  const graphService = "@codegraph/graph-service";
  const posixIndex = buildFilters.indexOf(posixAdapter);
  const graphServiceIndex = buildFilters.indexOf(graphService);

  if (uniqueFilters.size !== buildFilters.length
    || posixIndex < 0
    || graphServiceIndex < 0
    || posixIndex >= graphServiceIndex) {
    throw new Error(
      "[typescript-module-analysis-v1] BUILD_TOPOLOGY_INVALID: POSIX adapter 必须唯一存在且先于 graph-service 构建。",
    );
  }
}

/**
 * 构建真实 Worker 产物并运行 Story 1.5 不可缩小的模块分析回归集。
 *
 * @param {{ executePnpm?: typeof runPnpm }} [dependencies] 测试可注入的受控命令执行边界。
 * @returns {Promise<number>} 0 表示所有构建与运行时证明均通过。
 */
export async function verifyTypeScriptModuleAnalysis(dependencies = {}) {
  const executePnpm = dependencies.executePnpm ?? runPnpm;
  try {
    assertTypeScriptModuleAnalysisBuildTopology(
      TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.buildFilters,
    );
  } catch (error) {
    console.error(toStableErrorMessage(error));
    return 1;
  }

  for (const filter of TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.buildFilters) {
    const result = await executePnpm(["--filter", filter, "build"], { captureOutput: false });
    const buildFailure = stableProcessFailure(result, "BUILD");
    if (buildFailure !== null) {
      console.error(`[typescript-module-analysis-v1] ${buildFailure}: ${filter} 未成功构建。`);
      return 1;
    }
  }

  for (const shard of TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.unitShards) {
    if (await runVitestShard(executePnpm, "vitest.config.ts", shard) !== 0) {
      return 1;
    }
  }
  for (const shard of TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.contractShards) {
    if (await runVitestShard(executePnpm, "vitest.contract.config.ts", shard) !== 0) {
      return 1;
    }
  }
  return 0;
}

/** 使用机器可解析 reporter 运行并证明单个固定 shard。 */
async function runVitestShard(executePnpm, configPath, shard) {
  const result = await executePnpm([
    "exec",
    "vitest",
    "run",
    "--config",
    configPath,
    "--reporter=json",
    ...shard.expectedTestResults.map(({ filePath }) => filePath),
  ], { captureOutput: true });

  try {
    assertVitestTermination(result, shard.shardId);
    const attestation = attestVitestJsonReport(result.stdout, shard, { repositoryRoot });
    console.log(
      `[typescript-module-analysis-v1:${shard.shardId}] ${attestation.passed}/${attestation.total} tests，${attestation.suites}/${shard.expectedSuiteCount} suites passed。`,
    );
    return 0;
  } catch (error) {
    console.error(toStableErrorMessage(error));
    return 1;
  }
}

/** 使用冻结 pnpm 入口复用 deadline/process-tree primitive，不允许 spawnSync 无界等待。 */
async function runPnpm(args, options = {}) {
  const invocation = createPnpmInvocation(process.env.npm_execpath, args);
  const captureOutput = options.captureOutput === true;
  const result = await runProcessWithDeadline({
    args: invocation.args,
    cwd: repositoryRoot,
    env: process.env,
    executable: invocation.executable,
    killGraceMs: DEFAULT_PROCESS_CLEANUP_GRACE_MS,
    outputLimitBytes: captureOutput ? VITEST_REPORT_MAX_BYTES : BUILD_OUTPUT_MAX_BYTES,
    timeoutMs: TYPESCRIPT_VERIFIER_CHILD_TIMEOUT_MS,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
  /** 失败输出可能含本机绝对路径；失败只发布下游 stableProcessFailure 代码。 */
  if (!captureOutput && stableProcessFailure(result, "BUILD") === null) {
    if (result.stdout.length > 0) {process.stdout.write(result.stdout);}
    if (result.stderr.length > 0) {process.stderr.write(result.stderr);}
  }
  return result;
}

/** 校验 Vitest 子进程的退出、timeout、双流排空与 residual=0 均有稳定证明。 */
function assertVitestTermination(result, shardId) {
  assertBoundedProcessSuccess(result, shardId, "VITEST");
}

/** 将 runner 结果归一化为不含路径、命令或堆栈的稳定失败代码。 */
function stableProcessFailure(result, prefix) {
  return getBoundedProcessFailureCode(result, prefix);
}

/** 将未知异常收敛为稳定、无堆栈的用户可见错误。 */
function toStableErrorMessage(error) {
  return error instanceof Error
    ? error.message
    : "[typescript-module-analysis-v1] UNKNOWN_FAILURE: 未知验证错误。";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await verifyTypeScriptModuleAnalysis();
}
