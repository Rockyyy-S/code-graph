import { expect, it } from "vitest";
import { validateJobStartRequest } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 JobStartRequestV1 能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:jobStartRequestV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:jobStartRequestV1Schema",
    evidenceId: "public-capability:schema:jobStartRequestV1Schema",
    fixturePath: "tests/fixtures/graph-bootstrap-job-request-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateJobStartRequest({ ...fixture, root: "/secret" })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateJobStartRequest(fixture)).toBe(true);
    },
  });
});
