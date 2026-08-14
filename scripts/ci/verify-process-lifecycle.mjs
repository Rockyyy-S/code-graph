import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assertBoundedProcessSuccess,
  attestVitestJsonReport,
  VITEST_JSON_REPORT_MAX_BYTES,
} from "./attest-vitest-json-report.mjs";
import {
  DEFAULT_PROCESS_CLEANUP_GRACE_MS,
  runProcessWithDeadline,
} from "./run-process-with-deadline.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const markerOutputLimitBytes = 1024 * 1024;
/** process-lifecycle 继承 architecture gate 的三分钟硬上限，不允许无界执行。 */
export const PROCESS_LIFECYCLE_CHILD_TIMEOUT_MS = 3 * 60 * 1000;

/** 由真实 Vitest reporter 冻结的 process-lifecycle 机器权威。 */
export const PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY = Object.freeze({
  attestationVersion: 1,
  expectedSuiteCount: 2,
  expectedTestCount: 15,
  expectedTestResults: Object.freeze([
    Object.freeze({
      filePath: "tests/unit/process-deadline.test.ts",
      suites: Object.freeze([
        Object.freeze({
          ancestorTitles: Object.freeze(["process deadline"]),
          expectedAssertionCount: 15,
        }),
      ]),
    }),
  ]),
  shardId: "process-lifecycle",
});

/**
 * 运行 marker 检查和真实 process-lifecycle reporter，并验证 PF-A containment 终态。
 *
 * @param {{executeNode?:typeof runNode,executePnpm?:typeof runPnpm}} [dependencies] 仅供 contract 负向测试注入。
 * @returns {Promise<number>} 0 表示 marker、runtime cardinality 与 cleanup 证明全部通过。
 */
export async function verifyProcessLifecycle(dependencies = {}) {
  const executeNode = dependencies.executeNode ?? runNode;
  const executePnpm = dependencies.executePnpm ?? runPnpm;
  try {
    const markerResult = await executeNode(["scripts/quality/check-test-markers.mjs"]);
    assertBoundedProcessSuccess(markerResult, "process-lifecycle-markers", "MARKER");

    const reporterResult = await executePnpm([
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.process-deadline.config.ts",
      "--reporter=json",
      ...PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY.expectedTestResults.map(({ filePath }) => filePath),
    ]);
    assertBoundedProcessSuccess(reporterResult, "process-lifecycle", "VITEST");
    const attestation = attestVitestJsonReport(
      reporterResult.stdout,
      PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY,
      { repositoryRoot },
    );
    console.log(
      `[process-lifecycle] ${attestation.passed}/${attestation.total} tests，${attestation.suites}/${PROCESS_LIFECYCLE_ATTESTATION_AUTHORITY.expectedSuiteCount} suites passed。`,
    );
    return 0;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "[process-lifecycle] UNKNOWN_FAILURE: 未知验证错误。",
    );
    return 1;
  }
}

/** 使用 PF-A runner 有界执行 Node marker 检查。 */
async function runNode(args) {
  return runProcessWithDeadline({
    args,
    cwd: repositoryRoot,
    env: process.env,
    executable: process.execPath,
    killGraceMs: DEFAULT_PROCESS_CLEANUP_GRACE_MS,
    outputLimitBytes: markerOutputLimitBytes,
    timeoutMs: PROCESS_LIFECYCLE_CHILD_TIMEOUT_MS,
  });
}

/** 使用冻结 pnpm 入口和 PF-A runner 有界执行真实 Vitest reporter。 */
async function runPnpm(args) {
  const invocation = createPnpmInvocation(process.env.npm_execpath, args);
  return runProcessWithDeadline({
    args: invocation.args,
    cwd: repositoryRoot,
    env: process.env,
    executable: invocation.executable,
    killGraceMs: DEFAULT_PROCESS_CLEANUP_GRACE_MS,
    outputLimitBytes: VITEST_JSON_REPORT_MAX_BYTES,
    timeoutMs: PROCESS_LIFECYCLE_CHILD_TIMEOUT_MS,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await verifyProcessLifecycle();
}
