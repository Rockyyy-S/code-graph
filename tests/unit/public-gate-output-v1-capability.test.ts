import { expect, it } from "vitest";
import { validateGateOutputV1 } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 GateOutputV1 公共能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:gateOutputV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:gateOutputV1Schema",
    evidenceId: "public-capability:schema:gateOutputV1Schema",
    fixturePath: "tests/fixtures/public-gate-output-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateGateOutputV1({ ...fixture, unknown: true })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateGateOutputV1(fixture)).toBe(true);
    },
  });
});
