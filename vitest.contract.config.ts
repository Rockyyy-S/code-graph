import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/fixtures/**"],
    /** 真实进程与 SQLite 锁合同共享宿主资源，串行文件可避免 Windows 过载伪造超时。 */
    fileParallelism: false,
    include: ["tests/contract/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
