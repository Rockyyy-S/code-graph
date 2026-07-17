import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/fixtures/**"],
    include: ["tests/unit/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
