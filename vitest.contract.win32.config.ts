import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    exclude: ["tests/fixtures/**"],
    /** Win32/NTFS suite 独占真实宿主资源，禁止与其他测试文件并行。 */
    fileParallelism: false,
    include: ["tests/contract/host-path-identity-win32.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
