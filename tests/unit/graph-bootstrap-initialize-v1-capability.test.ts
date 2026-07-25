import { expect, it } from "vitest";
import { validateInitializeResult } from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证 InitializeResult canonical 能力的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "schema:initializeResultSchema") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "schema:initializeResultSchema",
    evidenceId: "public-capability:schema:initializeResultSchema",
    fixturePath: "tests/fixtures/graph-bootstrap-initialize-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateInitializeResult({ ...fixture, futureField: true })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateInitializeResult(fixture)).toBe(true);
    },
  });
});
