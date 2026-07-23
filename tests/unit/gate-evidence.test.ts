import { describe, expect, it } from "vitest";
import {
  createGateEvidenceV1,
  createGateOutputV1,
  validateGateEvidenceBinding,
} from "../../scripts/ci/create-gate-evidence.mjs";
import {
  computeGateDefinitionDigest,
  validateGateEvidenceV1,
  type GateDefinitionV1,
} from "../../packages/contracts/src/index.js";
import { sha256Hex } from "../../packages/contracts/src/canonical-json.js";

const definition: GateDefinitionV1 = {
  blocking: true,
  capabilityOwner: "qa",
  checkId: "unit",
  command: ["pnpm", "unit"],
  evidenceProducerId: `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@${"1".repeat(40)}#unit`,
  gateId: "unit",
};

describe("gate evidence", () => {
  it.each([
    [{ code: 0, kind: "exit" as const }],
    [{ kind: "signal" as const, signalName: "SIGTERM" }],
    [{ kind: "spawn-error" as const, stableCode: "ENOENT" }],
  ])("生成封闭 GateOutputV1 termination %#", (termination) => {
    const stdout = Buffer.from([0, 1, 2, 255]);
    const stderr = Buffer.from("错误", "utf8");
    const output = createGateOutputV1({
      gateId: "unit",
      stderr,
      stderrTruncated: true,
      stdout,
      stdoutTruncated: false,
      termination,
    });

    expect(output).toEqual({
      gateId: "unit",
      schemaVersion: 1,
      stderrBytes: stderr.length,
      stderrDigest: sha256Hex(stderr),
      stderrTruncated: true,
      stdoutBytes: stdout.length,
      stdoutDigest: sha256Hex(stdout),
      stdoutTruncated: false,
      termination,
    });
  });

  it("创建摘要闭合并绑定 definition/producer/context/head/output 的 evidence", () => {
    const gateDefinitionDigest = computeGateDefinitionDigest(definition);
    const output = createGateOutputV1({
      gateId: "unit",
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
      stdout: Buffer.from("pass"),
      stdoutTruncated: false,
      termination: { code: 0, kind: "exit" },
    });
    const evidence = createGateEvidenceV1({
      definition,
      evaluationContextDigest: "a".repeat(64),
      gateDefinitionDigest,
      headOid: "b".repeat(40),
      output,
      status: "pass",
    });

    expect(validateGateEvidenceV1(evidence)).toBe(true);
    expect(
      validateGateEvidenceBinding({
        definition,
        evaluationContextDigest: "a".repeat(64),
        evidence,
        gateDefinitionDigest,
        headOid: "b".repeat(40),
      }),
    ).toEqual({ status: "accepted" });
  });

  it.each([
    ["producer", { evidenceProducerId: "gha-oidc://1303415307/a/b/.github/workflows/x.yml@1111111111111111111111111111111111111111#unit" }],
    ["definition", { gateDefinitionDigest: "c".repeat(64) }],
    ["context", { evaluationContextDigest: "d".repeat(64) }],
    ["head", { headOid: "e".repeat(40) }],
  ])("拒绝 %s 绑定漂移", (_label, override) => {
    const gateDefinitionDigest = computeGateDefinitionDigest(definition);
    const output = createGateOutputV1({
      gateId: "unit",
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
      stdout: Buffer.alloc(0),
      stdoutTruncated: false,
      termination: { code: 0, kind: "exit" },
    });
    const evidence = {
      ...createGateEvidenceV1({
        definition,
        evaluationContextDigest: "a".repeat(64),
        gateDefinitionDigest,
        headOid: "b".repeat(40),
        output,
        status: "pass",
      }),
      ...override,
    };

    expect(
      validateGateEvidenceBinding({
        definition,
        evaluationContextDigest: "a".repeat(64),
        evidence,
        gateDefinitionDigest,
        headOid: "b".repeat(40),
      }),
    ).toEqual({ reason: expect.any(String), status: "invalid" });
  });
});
