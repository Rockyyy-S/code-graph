import { expect, it } from "vitest";
import { validateGateRegistryV1 } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 GateRegistryV1 公共能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:gateRegistryV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:gateRegistryV1Schema",
    evidenceId: "public-capability:schema:gateRegistryV1Schema",
    fixturePath: "tests/fixtures/public-gate-registry-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateGateRegistryV1({ ...fixture, unknown: true })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateGateRegistryV1(fixture)).toBe(true);
    },
  });
});
