import { defineConfig } from "vitest/config";
import FailOnSkippedReporter from "./scripts/quality/fail-on-skipped-reporter.mjs";

export default defineConfig({
  test: {
    allowOnly: false,
    exclude: [
      "tests/fixtures/**",
      "tests/contract/host-path-identity-win32.test.ts",
    ],
    /** 真实进程与 SQLite 锁合同共享宿主资源，串行文件可避免 Windows 过载伪造超时。 */
    fileParallelism: false,
    include: ["tests/contract/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default", new FailOnSkippedReporter()],
    testTimeout: 10_000,
  },
});
