import { describe, expect, it, vi } from "vitest";
import {
  QUALITY_GATES,
  runArchitectureRequired,
} from "../../scripts/ci/run-architecture-required.mjs";

/** 创建用于 runner 注入的稳定执行结果。 */
function executionResult(status: "fail" | "invalid" | "pass") {
  return {
    status,
    stderr: Buffer.alloc(0),
    stderrTruncated: false,
    stdout: Buffer.from(status),
    stdoutTruncated: false,
    termination:
      status === "invalid"
        ? { kind: "spawn-error" as const, stableCode: "ENOENT" }
        : { code: status === "pass" ? 0 : 23, kind: "exit" as const },
  };
}

describe("architecture-required failure propagation", () => {
  for (const failingGate of QUALITY_GATES) {
    it(`executes every gate and returns non-zero when ${failingGate} fails`, async () => {
      const execute = vi.fn(async (gateId: string) =>
        executionResult(gateId === failingGate ? "fail" : "pass"),
      );

      const result = await runArchitectureRequired({ execute, writeArtifacts: false });

      expect(result.exitCode).toBe(1);
      expect(execute).toHaveBeenCalledTimes(QUALITY_GATES.length);
      expect(result.gates.map(({ gateId }) => gateId)).toEqual(QUALITY_GATES);
      expect(result.gates.find(({ gateId }) => gateId === failingGate)?.status).toBe(
        "fail",
      );
    });
  }

  it("returns zero only when every required gate passes", async () => {
    const execute = vi.fn(async () => executionResult("pass"));

    const result = await runArchitectureRequired({ execute, writeArtifacts: false });

    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledTimes(QUALITY_GATES.length);
  });

  it("treats invalid execution and missing provider evidence as fail-closed", async () => {
    const execute = vi.fn(async (gateId: string) =>
      executionResult(gateId === QUALITY_GATES[0] ? "invalid" : "pass"),
    );

    const result = await runArchitectureRequired({
      execute,
      providerEvaluation: {
        applicability: QUALITY_GATES.map((gateId) => ({ gateId, status: "required" })),
        evaluationContext: {
          evaluationContextDigest: "a".repeat(64),
          headOid: "b".repeat(40),
        },
      },
      suppressEvidenceForGate: QUALITY_GATES.at(-1),
      writeArtifacts: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.invalidGateIds).toContain(QUALITY_GATES[0]);
    expect(result.summary.missingEvidenceGateIds).toEqual([QUALITY_GATES.at(-1)]);
  });
});
