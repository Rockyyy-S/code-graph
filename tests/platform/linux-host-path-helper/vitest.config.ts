import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    fileParallelism: false,
    include: ["tests/platform/linux-host-path-helper/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
