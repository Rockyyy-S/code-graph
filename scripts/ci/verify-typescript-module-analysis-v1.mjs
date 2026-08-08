import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_PROCESS_CLEANUP_GRACE_MS,
  runProcessWithDeadline,
} from "./run-process-with-deadline.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** JSON reporter 的 stdout/stderr 各自最多保留 4 MiB，避免异常测试无限占用内存。 */
export const VITEST_REPORT_MAX_BYTES = 4 * 1024 * 1024;
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
      expectedTestCount: 6,
      shardId: "graph-service-process",
      tests: Object.freeze([
        "tests/contract/graph-service-process.test.ts",
      ]),
    }),
  ]),
  /** 按数组顺序串行启动独立 Vitest 进程，隔离 SQLite 锁与构建后并行资源竞争。 */
  unitShards: Object.freeze([
    Object.freeze({
      expectedTestCount: 273,
      shardId: "default-unit",
      tests: Object.freeze([
        "tests/unit/analyzer-config-capture.test.ts",
        "tests/unit/analyzer-config-snapshot.test.ts",
        "tests/unit/composite-graph-patch.test.ts",
        "tests/unit/index-job-runtime.test.ts",
        "tests/unit/index-read-set.test.ts",
        "tests/unit/module-dependency-domain.test.ts",
        "tests/unit/module-fact-batch.test.ts",
        "tests/unit/sqlite-graph-store.test.ts",
        "tests/unit/typescript-analyzer-worker.test.ts",
        "tests/unit/typescript-module-resolution.test.ts",
        "tests/unit/typescript-module-syntax.test.ts",
      ]),
    }),
    Object.freeze({
      /** 该计数是独立审阅后的权威，禁止从 reporter actual 动态派生并自授权。 */
      expectedTestCount: 50,
      shardId: "sqlite-module-dependencies",
      tests: Object.freeze([
        "tests/unit/sqlite-module-dependencies.test.ts",
      ]),
    }),
  ]),
  version: 1,
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
 * 解析并证明单个 Vitest JSON reporter 输出的完整性与精确运行数量。
 *
 * @param {string | Buffer | Uint8Array} output Vitest reporter stdout。
 * @param {{ expectedTestCount: number; shardId: string }} authority 固定 shard 权威。
 * @returns {{ failed: number; passed: number; pending: number; skipped: number; todo: number; total: number }}
 * @throws {Error} 输出为空、超限、格式错误、计数不一致或存在非通过测试时抛出稳定错误。
 */
export function attestVitestJsonReport(output, authority) {
  const shardId = typeof authority?.shardId === "string" && authority.shardId.length > 0
    ? authority.shardId
    : "unknown-shard";
  if (!Number.isSafeInteger(authority?.expectedTestCount) || authority.expectedTestCount < 0) {
    throw createAttestationError(shardId, "VITEST_AUTHORITY_INVALID", "expectedTestCount 必须是非负安全整数。");
  }

  const outputBuffer = toOutputBuffer(output, shardId);
  if (outputBuffer.byteLength > VITEST_REPORT_MAX_BYTES) {
    throw createAttestationError(
      shardId,
      "VITEST_REPORT_OVERSIZED",
      `reporter 输出超过 ${VITEST_REPORT_MAX_BYTES} bytes。`,
    );
  }
  if (outputBuffer.byteLength === 0 || outputBuffer.toString("utf8").trim().length === 0) {
    throw createAttestationError(shardId, "VITEST_REPORT_EMPTY", "reporter 未输出 JSON。");
  }

  let report;
  try {
    report = JSON.parse(outputBuffer.toString("utf8"));
  } catch {
    throw createAttestationError(shardId, "VITEST_REPORT_MALFORMED", "reporter 输出不是单个有效 JSON 文档。");
  }
  if (!isRecord(report) || report.success !== true && report.success !== false) {
    throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "reporter 根对象或 success 字段无效。");
  }

  const rootCounts = {
    failed: readReportCount(report, "numFailedTests", shardId),
    passed: readReportCount(report, "numPassedTests", shardId),
    pending: readReportCount(report, "numPendingTests", shardId),
    todo: readReportCount(report, "numTodoTests", shardId),
    total: readReportCount(report, "numTotalTests", shardId),
  };
  const suiteCounts = {
    failed: readReportCount(report, "numFailedTestSuites", shardId),
    passed: readReportCount(report, "numPassedTestSuites", shardId),
    pending: readReportCount(report, "numPendingTestSuites", shardId),
    total: readReportCount(report, "numTotalTestSuites", shardId),
  };
  if (rootCounts.passed + rootCounts.failed + rootCounts.pending + rootCounts.todo !== rootCounts.total
    || suiteCounts.passed + suiteCounts.failed + suiteCounts.pending !== suiteCounts.total) {
    throw createAttestationError(shardId, "VITEST_REPORT_INCOMPLETE", "reporter 汇总计数无法闭合。");
  }
  if (!Array.isArray(report.testResults)) {
    throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "testResults 必须是数组。");
  }

  const derivedCounts = {
    failed: 0,
    passed: 0,
    pending: 0,
    skipped: 0,
    todo: 0,
    total: 0,
  };
  for (const testResult of report.testResults) {
    if (!isRecord(testResult) || !Array.isArray(testResult.assertionResults)) {
      throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "assertionResults 必须完整存在。");
    }
    for (const assertion of testResult.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.status !== "string") {
        throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "测试状态字段无效。");
      }
      derivedCounts.total += 1;
      switch (assertion.status) {
        case "passed":
          derivedCounts.passed += 1;
          break;
        case "failed":
          derivedCounts.failed += 1;
          break;
        case "pending":
          derivedCounts.pending += 1;
          break;
        case "skipped":
        case "disabled":
          derivedCounts.skipped += 1;
          break;
        case "todo":
          derivedCounts.todo += 1;
          break;
        default:
          throw createAttestationError(
            shardId,
            "VITEST_REPORT_SCHEMA_INVALID",
            `未知测试状态 ${assertion.status}。`,
          );
      }
    }
  }

  if (derivedCounts.total !== rootCounts.total
    || derivedCounts.passed !== rootCounts.passed
    || derivedCounts.failed !== rootCounts.failed
    || derivedCounts.pending + derivedCounts.skipped !== rootCounts.pending
    || derivedCounts.todo !== rootCounts.todo) {
    throw createAttestationError(shardId, "VITEST_REPORT_INCOMPLETE", "逐项状态与 reporter 汇总不一致。");
  }
  if (rootCounts.total !== authority.expectedTestCount) {
    throw createAttestationError(
      shardId,
      "VITEST_COUNT_MISMATCH",
      `expected=${authority.expectedTestCount} actual=${rootCounts.total}。`,
    );
  }
  if (rootCounts.failed > 0) {
    throw createAttestationError(shardId, "VITEST_FAILED", `failed=${rootCounts.failed}。`);
  }
  if (rootCounts.pending > 0 || rootCounts.todo > 0) {
    throw createAttestationError(
      shardId,
      "VITEST_NONPASSING",
      `pendingOrSkipped=${rootCounts.pending} todo=${rootCounts.todo}。`,
    );
  }
  if (!report.success || rootCounts.passed !== rootCounts.total || suiteCounts.failed > 0 || suiteCounts.pending > 0) {
    throw createAttestationError(shardId, "VITEST_REPORT_INCOMPLETE", "成功标记、suite 与测试汇总不一致。");
  }

  return Object.freeze({ ...derivedCounts });
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
    ...shard.tests,
  ], { captureOutput: true });

  try {
    assertVitestTermination(result, shard.shardId);
    const attestation = attestVitestJsonReport(result.stdout, shard);
    console.log(
      `[typescript-module-analysis-v1:${shard.shardId}] ${attestation.passed}/${attestation.total} tests passed。`,
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
  const failure = stableProcessFailure(result, "VITEST");
  if (failure !== null) {
    throw createAttestationError(shardId, failure, "测试子进程未形成可证明的有界成功终态。");
  }
}

/** 将 runner 结果归一化为不含路径、命令或堆栈的稳定失败代码。 */
function stableProcessFailure(result, prefix) {
  const stableCode = result?.termination?.kind === "spawn-error"
    ? result.termination.stableCode
    : null;
  if (
    [
      "EPROCESSCLEANUP",
      "EPROCESSCLEANUPTIMEOUT",
      "EPROCESSCONTAINMENTUNAVAILABLE",
      "EPROCESSIDENTITYAMBIGUOUS",
      "EPIPEOPEN",
    ].includes(stableCode) ||
    result?.cleanupComplete !== true ||
    result?.streamsDrained !== true ||
    result?.residualProcessTree !== 0
  ) {
    return `${prefix}_CLEANUP_UNPROVEN`;
  }
  if (stableCode === "ETIMEDOUT" || result?.timedOut === true) {
    return `${prefix}_TIMEOUT`;
  }
  if (result?.status !== "pass") {
    return result?.termination?.kind === "signal"
      ? `${prefix}_ABNORMAL_TERMINATION`
      : `${prefix}_EXIT_NONZERO`;
  }
  if (result?.termination?.kind !== "exit" || result.termination.code !== 0) {
    return `${prefix}_EXIT_NONZERO`;
  }
  return null;
}

/** 将 reporter 输出统一为 Buffer，以字节长度实施平台无关上界。 */
function toOutputBuffer(output, shardId) {
  if (typeof output === "string") {
    return Buffer.from(output, "utf8");
  }
  if (Buffer.isBuffer(output) || output instanceof Uint8Array) {
    return Buffer.from(output);
  }
  throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", "reporter stdout 类型无效。");
}

/** 从 reporter 根对象读取非负安全整数。 */
function readReportCount(report, field, shardId) {
  const value = report[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw createAttestationError(shardId, "VITEST_REPORT_SCHEMA_INVALID", `${field} 必须是非负安全整数。`);
  }
  return value;
}

/** 判断值是否为非数组对象。 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 创建包含稳定代码与 shard 身份的错误。 */
function createAttestationError(shardId, code, detail) {
  return new Error(`[typescript-module-analysis-v1:${shardId}] ${code}: ${detail}`);
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
