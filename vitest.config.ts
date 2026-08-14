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
    exclude: ["tests/fixtures/**", processDeadlineTest],
    include: unitIncludes,
    name: "unit",
    passWithNoTests: false,
    reporters: ["default", new FailOnSkippedReporter()],
    testTimeout: 10_000,
  },
});
