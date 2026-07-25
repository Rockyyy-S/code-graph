import { expect, it } from "vitest";
import { validateGateEvaluationContextV1 } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 GateEvaluationContextV1 公共能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:gateEvaluationContextV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:gateEvaluationContextV1Schema",
    evidenceId: "public-capability:schema:gateEvaluationContextV1Schema",
    fixturePath: "tests/fixtures/public-gate-evaluation-context-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateGateEvaluationContextV1({ ...fixture, unknown: true })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateGateEvaluationContextV1(fixture)).toBe(true);
    },
  });
});
