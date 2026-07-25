import { expect, it } from "vitest";
import { validateErrorV1 } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 ErrorV1 图谱失败能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:errorV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:errorV1Schema",
    evidenceId: "public-capability:schema:errorV1Schema",
    fixturePath: "tests/fixtures/graph-bootstrap-error-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateErrorV1({ ...fixture, category: "transport" })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateErrorV1(fixture)).toBe(true);
    },
  });
});
