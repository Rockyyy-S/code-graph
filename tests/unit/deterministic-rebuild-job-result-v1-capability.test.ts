import { expect, it } from "vitest";
import { validateJobStartResult } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证确定性 rebuild JobStartResultV1 能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:jobStartResultV1Schema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:jobStartResultV1Schema",
    evidenceId: "public-capability:schema:jobStartResultV1Schema",
    fixturePath: "tests/fixtures/deterministic-rebuild-job-result-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateJobStartResult({ ...fixture, accepted: false })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateJobStartResult(fixture)).toBe(true);
    },
  });
});
