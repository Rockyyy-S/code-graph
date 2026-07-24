import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  executeRegistryGate,
  loadProviderEvaluation,
  QUALITY_GATES,
  runArchitectureRequired,
} from "../../scripts/ci/run-architecture-required.mjs";
import { loadQualityGateRegistry } from "../../scripts/ci/load-quality-gates.mjs";
import { sha256CanonicalJson } from "../../packages/contracts/src/canonical-json.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const loadedRegistry = await loadQualityGateRegistry(repositoryRoot);

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
          gateRegistryDigest: loadedRegistry.gateRegistryDigest,
          headOid: "b".repeat(40),
        },
        hostedEvidenceEligible: true,
      },
      suppressEvidenceForGate: QUALITY_GATES.at(-1),
      writeArtifacts: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.invalidGateIds).toContain(QUALITY_GATES[0]);
    expect(result.summary.missingEvidenceGateIds).toEqual([QUALITY_GATES.at(-1)]);
  });

  it("non-blocking gate 失败不会阻断聚合结论", async () => {
    const registry = structuredClone(loadedRegistry.registry);
    registry.gates[0]!.gateDefinition.blocking = false;
    const nonBlockingGateId = registry.gates[0]!.gateDefinition.gateId;
    const execute = vi.fn(async (gateId: string) =>
      executionResult(gateId === nonBlockingGateId ? "fail" : "pass"),
    );

    const result = await runArchitectureRequired({
      execute,
      registry,
      writeArtifacts: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.failedGateIds).toEqual([]);
    expect(result.gates.find(({ gateId }) => gateId === nonBlockingGateId)?.status).toBe(
      "fail",
    );
  });

  it("注入 registry 时报告实际执行 registry 的摘要", async () => {
    const registry = structuredClone(loadedRegistry.registry);
    registry.gates[0]!.gateDefinition.capabilityOwner =
      registry.gates[0]!.gateDefinition.capabilityOwner === "qa" ? "security" : "qa";

    const result = await runArchitectureRequired({
      execute: async () => executionResult("pass"),
      registry,
      writeArtifacts: false,
    });

    expect(result.gateRegistryDigest).toBe(sha256CanonicalJson(registry));
    expect(result.gateRegistryDigest).not.toBe(loadedRegistry.gateRegistryDigest);
  });

  it("CLI 拒绝本地 provider context 注入", async () => {
    await expect(
      loadProviderEvaluation(["--provider-context", "fixture.json"]),
    ).rejects.toThrow(/禁止注入 provider context/u);
  });

  it("总 deadline 耗尽后不再启动 gate，并为剩余项生成稳定 invalid", async () => {
    const execute = vi.fn(async () => executionResult("pass"));

    const result = await runArchitectureRequired({
      execute,
      totalTimeoutMs: -1,
      writeArtifacts: false,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.summary.invalidGateIds).toEqual(QUALITY_GATES);
    expect(result.gates.every(({ status }) => status === "invalid")).toBe(true);
  });

  it("以绝对 deadline 终止挂起 gate 并返回稳定 invalid", async () => {
    const result = await executeRegistryGate(
      "hanging-gate",
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      { killGraceMs: 50, timeoutMs: 50 },
    );

    expect(result.status).toBe("invalid");
    expect(result.termination).toEqual({
      kind: "spawn-error",
      stableCode: "ETIMEDOUT",
    });
  });
});
