import { expect, it } from "vitest";
import {
  SERVICE_METHODS,
  validateJobStartResult,
} from "../../packages/contracts/src/index.js";
import { runBoundPublicCapabilityTest } from "../../scripts/contracts/run-public-capability-verification.mjs";

it("验证确定性 rebuild job/start 公共 RPC 的正负向合同", async () => {
  if (process.env.CODEGRAPH_PUBLIC_CAPABILITY !== "rpc:job/start") {
    return;
  }
  await runBoundPublicCapabilityTest({
    capabilityId: "rpc:job/start",
    evidenceId: "public-capability:rpc:job/start",
    fixturePath: "tests/fixtures/deterministic-rebuild-rpc-v1.json",
    verifyNegative: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateJobStartResult({ ...fixture, root: "C:\\secret" })).toBe(false);
    },
    verifyPositive: async ({ fixture }: { fixture: Record<string, unknown> }) => {
      expect(validateJobStartResult(fixture)).toBe(true);
      if (SERVICE_METHODS.startJob !== "job/start") {
        throw new Error("公共 RPC 方法必须保持为 job/start。");
      }
    },
  });
});
