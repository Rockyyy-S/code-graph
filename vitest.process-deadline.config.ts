import { defineConfig } from "vitest/config";
import FailOnSkippedReporter from "./scripts/quality/fail-on-skipped-reporter.mjs";

const gateTimeoutMs = 180_000;
const requiredMarginMs = 30_000;
const fastTestCount = 8;
const testTimeoutMs = 8_000;
const gitTestTimeoutMs = 45_000;
const windowsMatrixTimeoutMs = 30_000;
const declaredTestBudgetMs =
  fastTestCount * testTimeoutMs + gitTestTimeoutMs + windowsMatrixTimeoutMs;

/**
 * 独立 blocking gate 的声明预算必须在 architecture 的 180 秒 deadline 前至少留出 30 秒，
 * 供 Vitest 汇总、stdio close 与进程树终态证明使用。
 */
export const PROCESS_LIFECYCLE_BUDGET = Object.freeze({
  declaredTestBudgetMs,
  expectedTestCount: fastTestCount + 2,
  fastTestCount,
  gateTimeoutMs,
  gitTestTimeoutMs,
  requiredMarginMs,
  testTimeoutMs,
  windowsMatrixTimeoutMs,
});

if (gateTimeoutMs - declaredTestBudgetMs < requiredMarginMs) {
  throw new Error("process-lifecycle gate 声明预算未保留至少 30 秒终态收敛余量。");
}

export default defineConfig({
  test: {
    allowOnly: false,
    exclude: ["tests/fixtures/**"],
    fileParallelism: false,
    include: ["tests/unit/process-deadline.test.ts"],
    isolate: true,
    maxWorkers: 1,
    name: "process-lifecycle",
    passWithNoTests: false,
    pool: "forks",
    reporters: ["default", new FailOnSkippedReporter()],
    testTimeout: testTimeoutMs,
  },
});
