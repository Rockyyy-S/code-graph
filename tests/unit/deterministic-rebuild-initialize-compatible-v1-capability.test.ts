import { expect, it } from "vitest";
import { validateInitializeResultCompatible } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证确定性 rebuild InitializeResult 兼容解析能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:initializeResultCompatibleSchema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:initializeResultCompatibleSchema",
    evidenceId: "public-capability:schema:initializeResultCompatibleSchema",
    fixturePath: "tests/fixtures/deterministic-rebuild-initialize-compatible-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateInitializeResultCompatible({ ...fixture, serviceVersion: undefined })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateInitializeResultCompatible(fixture)).toBe(true);
    },
  });
});
