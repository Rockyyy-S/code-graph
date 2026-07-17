import { defineConfig } from "vitest/config";
import FailOnSkippedReporter from "./scripts/quality/fail-on-skipped-reporter.mjs";

export default defineConfig({
  test: {
    allowOnly: false,
    exclude: ["tests/fixtures/**"],
    include: [
      "tests/unit/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "apps/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
      "packages/**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    ],
    passWithNoTests: false,
    reporters: ["default", new FailOnSkippedReporter()],
    testTimeout: 10_000,
  },
});
