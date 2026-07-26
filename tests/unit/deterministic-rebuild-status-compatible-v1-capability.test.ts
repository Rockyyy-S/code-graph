import { expect, it } from "vitest";
import { validateServiceStatusV1Compatible } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证确定性 rebuild ServiceStatusV1 兼容解析能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:serviceStatusV1CompatibleSchema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:serviceStatusV1CompatibleSchema",
    evidenceId: "public-capability:schema:serviceStatusV1CompatibleSchema",
    fixturePath: "tests/fixtures/deterministic-rebuild-status-compatible-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateServiceStatusV1Compatible({ ...fixture, currentIndexJob: "invalid" })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateServiceStatusV1Compatible(fixture)).toBe(true);
    },
  });
});
