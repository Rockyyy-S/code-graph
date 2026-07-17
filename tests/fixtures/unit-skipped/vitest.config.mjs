import { defineConfig } from "vitest/config";
import FailOnSkippedReporter from "../../../scripts/quality/fail-on-skipped-reporter.mjs";

export default defineConfig({
  test: {
    include: ["tests/fixtures/unit-skipped/skipped.test.ts"],
    passWithNoTests: false,
    reporters: ["default", new FailOnSkippedReporter()],
  },
});
