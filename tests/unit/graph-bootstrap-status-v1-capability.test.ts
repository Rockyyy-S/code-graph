import { expect, it } from "vitest";
import { validateServiceStatusV1 } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 ServiceStatusV1 canonical 能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:serviceStatusV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:serviceStatusV1Schema",
    evidenceId: "public-capability:schema:serviceStatusV1Schema",
    fixturePath: "tests/fixtures/graph-bootstrap-status-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateServiceStatusV1({ ...fixture, graphRevision: 1 })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateServiceStatusV1(fixture)).toBe(true);
    },
  });
});
