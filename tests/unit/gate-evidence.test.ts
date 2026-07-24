import { describe, expect, it } from "vitest";
import {
  createGateEvidenceV1,
  createGateOutputV1,
  validateGateEvidenceBinding,
} from "../../scripts/ci/create-gate-evidence.mjs";
import {
  computeGateDefinitionDigest,
  validateGateEvidenceV1,
  validateGateOutputV1,
  type GateDefinitionV1,
} from "../../packages/contracts/src/index.js";
import {
  sha256CanonicalJson,
  sha256Hex,
} from "../../packages/contracts/src/canonical-json.js";

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
      stderrBytes: stderr.length + 1,
      stderrTruncated: true,
      stdout,
      stdoutTruncated: false,
      termination,
    });

    expect(output).toEqual({
      gateId: "unit",
      schemaVersion: 1,
      stderrBytes: stderr.length + 1,
      stderrDigest: sha256Hex(stderr),
      stderrTruncated: true,
      stdoutBytes: stdout.length,
      stdoutDigest: sha256Hex(stdout),
      stdoutTruncated: false,
      termination,
    });
    expect(validateGateOutputV1(output)).toBe(true);
  });

  it("拒绝非字节输出、非法截断标记和 gateId", () => {
    expect(() =>
      createGateOutputV1({
        gateId: "unit",
        stderr: "错误" as unknown as Buffer,
        stderrTruncated: false,
        stdout: Buffer.alloc(0),
        stdoutTruncated: false,
        termination: { code: 0, kind: "exit" },
      }),
    ).toThrow(/字节/u);
    expect(() =>
      createGateOutputV1({
        gateId: "invalid gate",
        stderr: Buffer.alloc(0),
        stderrTruncated: false,
        stdout: Buffer.alloc(0),
        stdoutTruncated: "false" as unknown as boolean,
        termination: { code: 0, kind: "exit" },
      }),
    ).toThrow(/GateOutputV1/u);
    expect(() =>
      createGateOutputV1({
        gateId: "unit",
        stderr: Buffer.alloc(0),
        stderrBytes: 0,
        stderrTruncated: true,
        stdout: Buffer.alloc(0),
        stdoutTruncated: false,
        termination: { code: 0, kind: "exit" },
      }),
    ).toThrow(/GateOutputV1/u);
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

  it("拒绝 status 与 termination 不一致的 evidence", () => {
    const output = createGateOutputV1({
      gateId: "unit",
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
      stdout: Buffer.alloc(0),
      stdoutTruncated: false,
      termination: { code: 23, kind: "exit" },
    });

    expect(() =>
      createGateEvidenceV1({
        definition,
        evaluationContextDigest: "a".repeat(64),
        gateDefinitionDigest: computeGateDefinitionDigest(definition),
        headOid: "b".repeat(40),
        output,
        status: "pass",
      }),
    ).toThrow(/status|termination/u);
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

  it("绑定校验拒绝自摘要闭合但 Schema 非法的 evidence", () => {
    const gateDefinitionDigest = computeGateDefinitionDigest(definition);
    const output = createGateOutputV1({
      gateId: "unit",
      stderr: Buffer.alloc(0),
      stderrTruncated: false,
      stdout: Buffer.alloc(0),
      stdoutTruncated: false,
      termination: { code: 0, kind: "exit" },
    });
    const validEvidence = createGateEvidenceV1({
      definition,
      evaluationContextDigest: "a".repeat(64),
      gateDefinitionDigest,
      headOid: "b".repeat(40),
      output,
      status: "pass",
    });
    const validDigestInput = structuredClone(validEvidence);
    Reflect.deleteProperty(validDigestInput, "gateEvidenceDigest");
    const invalidDigestInput = {
      ...validDigestInput,
      outputDigest: "not-a-digest",
      schemaVersion: 999,
      unknown: true,
    };
    const evidence = {
      ...invalidDigestInput,
      gateEvidenceDigest: sha256CanonicalJson(invalidDigestInput),
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

  it("绑定校验把非字符串 producer 收敛为稳定 invalid", () => {
    const evidence = {
      evaluationContextDigest: "a".repeat(64),
      evidenceProducerId: 1,
      gateDefinitionDigest: "b".repeat(64),
      gateEvidenceDigest: "c".repeat(64),
      gateId: "unit",
      headOid: "d".repeat(40),
      outputDigest: "e".repeat(64),
      schemaVersion: 1,
      status: "pass",
    };

    expect(
      validateGateEvidenceBinding({
        definition,
        evaluationContextDigest: "a".repeat(64),
        evidence,
        gateDefinitionDigest: "b".repeat(64),
        headOid: "d".repeat(40),
      }),
    ).toEqual({ reason: expect.any(String), status: "invalid" });
  });
});
