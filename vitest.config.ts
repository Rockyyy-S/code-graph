import { defineConfig } from "vitest/config";
import FailOnSkippedReporter from "./scripts/quality/fail-on-skipped-reporter.mjs";

const processDeadlineTest = "tests/unit/process-deadline.test.ts";
const unitIncludes = [
  "tests/unit/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "apps/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "packages/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
];

export default defineConfig({
  test: {
    allowOnly: false,
    passWithNoTests: false,
    projects: [
      {
        test: {
          allowOnly: false,
          exclude: ["tests/fixtures/**", processDeadlineTest],
          include: unitIncludes,
          name: "unit",
          sequence: { groupOrder: 0 },
          testTimeout: 10_000,
        },
      },
      {
        test: {
          allowOnly: false,
          exclude: ["tests/fixtures/**"],
          fileParallelism: false,
          include: [processDeadlineTest],
          isolate: true,
          maxWorkers: 1,
          name: "unit-process-deadline",
          pool: "forks",
          /** 后置独立 project 阻止 deadline 子进程与普通 unit worker 争用同一宿主资源。 */
          sequence: { groupOrder: 1 },
          testTimeout: 10_000,
        },
      },
    ],
    reporters: ["default", new FailOnSkippedReporter()],
    testTimeout: 10_000,
  },
});
