import { defineConfig } from "vitest/config";
import FailOnSkippedReporter from "./scripts/quality/fail-on-skipped-reporter.mjs";

const graphServiceProcessTest = "tests/contract/graph-service-process.test.ts";
const dedicatedWin32Test = "tests/contract/host-path-identity-win32.test.ts";

export default defineConfig({
  test: {
    allowOnly: false,
    fileParallelism: false,
    passWithNoTests: false,
    projects: [
      {
        test: {
          allowOnly: false,
          exclude: [
            "tests/fixtures/**",
            graphServiceProcessTest,
            dedicatedWin32Test,
          ],
          /** 普通合同仍按文件串行，避免真实进程与 SQLite 锁之间产生宿主争用。 */
          fileParallelism: false,
          include: ["tests/contract/**/*.test.ts"],
          name: "contract-portable",
          sequence: { groupOrder: 0 },
          testTimeout: 10_000,
        },
      },
      {
        test: {
          allowOnly: false,
          exclude: ["tests/fixtures/**", dedicatedWin32Test],
          fileParallelism: false,
          include: [graphServiceProcessTest],
          isolate: true,
          maxWorkers: 1,
          name: "contract-graph-service-process",
          pool: "forks",
          /** 后置独立 fork 确保 graph-service 进程合同不复用普通合同 worker。 */
          sequence: { groupOrder: 1 },
          testTimeout: 10_000,
        },
      },
    ],
    reporters: ["default", new FailOnSkippedReporter()],
    testTimeout: 10_000,
  },
});
