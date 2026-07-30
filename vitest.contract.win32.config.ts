import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    exclude: ["tests/fixtures/**"],
    /** Win32/NTFS suite 独占真实宿主资源，禁止与其他测试文件并行。 */
    fileParallelism: false,
    /** 外层 hook 预留 30 秒，使内部 10 秒探测先 fail-closed 并输出结构化诊断。 */
    hookTimeout: 30_000,
    include: ["tests/contract/host-path-identity-win32.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
