import { describe, expect, it } from "vitest";
import {
  computeEvaluationContextDigest,
  computeGateDefinitionDigest,
  computeGateEvidenceDigest,
  computeGateRegistryDigest,
  type GateDefinitionV1,
  type GateEvaluationContextV1,
  type GateEvidenceV1,
  type GateOutputV1,
  type GateRegistryV1,
  gateDefinitionV1Schema,
  gateEvaluationContextV1Schema,
  gateEvidenceV1Schema,
  gateOutputV1Schema,
  gateRegistryV1Schema,
  validateGateDefinitionV1,
  validateGateEvaluationContextV1,
  validateGateEvidenceV1,
  validateGateOutputV1,
  validateGateRegistryV1,
} from "../../packages/contracts/src/index.js";

const producerSha = "1".repeat(40);

/** 创建用于合同测试的最小合法 gate 定义。 */
function createDefinition(overrides: Partial<GateDefinitionV1> = {}): GateDefinitionV1 {
  return {
    blocking: true,
    capabilityOwner: "dev-enablement",
    checkId: "type",
    command: ["pnpm", "type"],
    evidenceProducerId: `gha-oidc://1303415307/example/controller/.github/workflows/produce-gate-evidence.yml@${producerSha}#type`,
    gateId: "type",
    ...overrides,
  };
}

/** 为给定定义创建摘要已闭合的 registry。 */
function createRegistry(definitions: GateDefinitionV1[]): GateRegistryV1 {
  return {
    gates: definitions.map((gateDefinition) => ({
      gateDefinition,
      gateDefinitionDigest: computeGateDefinitionDigest(gateDefinition),
    })),
    schemaVersion: 1,
  };
}

describe("quality gate contract", () => {
  it("所有根对象 Schema 都严格拒绝未知字段", () => {
    expect(gateDefinitionV1Schema.additionalProperties).toBe(false);
    expect(gateRegistryV1Schema.additionalProperties).toBe(false);
    expect(gateEvaluationContextV1Schema.additionalProperties).toBe(false);
    expect(gateEvidenceV1Schema.additionalProperties).toBe(false);
    expect(gateOutputV1Schema.additionalProperties).toBe(false);

    expect(validateGateDefinitionV1({ ...createDefinition(), unknown: true })).toBe(false);
  });

  it("公共 validator 拒绝 no-op、缺字段、非法 owner 和 argv", () => {
    expect(validateGateDefinitionV1(createDefinition({ command: ["true"] }))).toBe(false);
    expect(validateGateDefinitionV1(createDefinition({ command: ["node", "--eval", "0"] }))).toBe(false);
    expect(validateGateDefinitionV1({ ...createDefinition(), capabilityOwner: "unknown" })).toBe(false);
    expect(validateGateDefinitionV1({ ...createDefinition(), command: ["pnpm", "\0"] })).toBe(false);
    const missingCommand = { ...createDefinition() } as Partial<GateDefinitionV1>;
    delete missingCommand.command;
    expect(validateGateDefinitionV1(missingCommand)).toBe(false);
  });

  it("保留 triggerPaths 缺失语义并拒绝空、乱序、重复或非法 glob", () => {
    const alwaysApplicable = createDefinition();
    expect(validateGateDefinitionV1(alwaysApplicable)).toBe(true);
    expect(Object.hasOwn(alwaysApplicable, "triggerPaths")).toBe(false);

    for (const triggerPaths of [
      [],
      ["packages/**", "apps/**"],
      ["apps/**", "apps/**"],
      ["!apps/**"],
      ["/apps/**"],
      ["..\\apps\\**"],
      ["../apps/**"],
      ["src/[ab].ts"],
      [""],
    ]) {
      expect(validateGateDefinitionV1({ ...alwaysApplicable, triggerPaths })).toBe(false);
    }
  });

  it("definition digest 覆盖 producer 且字段缺失不等价于空数组", () => {
    const definition = createDefinition();
    const changedProducer = createDefinition({
      evidenceProducerId: definition.evidenceProducerId.replace("example", "trusted"),
    });
    expect(computeGateDefinitionDigest(definition)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeGateDefinitionDigest(changedProducer)).not.toBe(
      computeGateDefinitionDigest(definition),
    );
    expect(computeGateDefinitionDigest({ ...definition, triggerPaths: [] })).not.toBe(
      computeGateDefinitionDigest(definition),
    );
  });

  it("registry 要求 gateId 唯一升序且摘要匹配", () => {
    const lint = createDefinition({
      checkId: "lint",
      command: ["pnpm", "lint"],
      evidenceProducerId: createDefinition().evidenceProducerId.replace(/#type$/, "#lint"),
      gateId: "lint",
    });
    const type = createDefinition();
    const registry = createRegistry([lint, type]);

    expect(validateGateRegistryV1(registry)).toBe(true);
    expect(computeGateRegistryDigest(registry)).toMatch(/^[a-f0-9]{64}$/);
    expect(validateGateRegistryV1(createRegistry([type, lint]))).toBe(false);
    expect(validateGateRegistryV1(createRegistry([type, type]))).toBe(false);
    expect(
      validateGateRegistryV1(
        createRegistry([
          { ...lint, checkId: "shared-check" },
          { ...type, checkId: "shared-check" },
        ]),
      ),
    ).toBe(false);
    expect(
      validateGateRegistryV1({
        ...registry,
        gates: [{ ...registry.gates[0]!, gateDefinitionDigest: "0".repeat(64) }, registry.gates[1]!],
      }),
    ).toBe(false);
  });

  it("GateOutputV1 使用封闭 Schema 并校验字节计数与 termination", () => {
    const output: GateOutputV1 = {
      gateId: "unit",
      schemaVersion: 1,
      stderrBytes: 0,
      stderrDigest: "a".repeat(64),
      stderrTruncated: false,
      stdoutBytes: 4,
      stdoutDigest: "b".repeat(64),
      stdoutTruncated: false,
      termination: { code: 0, kind: "exit" },
    };

    expect(validateGateOutputV1(output)).toBe(true);
    expect(validateGateOutputV1({ ...output, schemaVersion: 2 })).toBe(false);
    expect(validateGateOutputV1({ ...output, stdoutBytes: -1 })).toBe(false);
    expect(validateGateOutputV1({ ...output, unknown: true })).toBe(false);
    expect(
      validateGateOutputV1({
        ...output,
        termination: { code: 0, kind: "exit", signalName: "SIGTERM" },
      }),
    ).toBe(false);
  });

  it("evaluation context 绑定 object format、完整 OID、registry 与自身摘要", () => {
    const withoutDigest = {
      baseOid: "a".repeat(40),
      comparisonBaseOid: "b".repeat(40),
      gateRegistryDigest: "c".repeat(64),
      headOid: "d".repeat(40),
      objectFormat: "sha1" as const,
      providerRepositoryId: "1303415307",
      schemaVersion: 1 as const,
    };
    const context: GateEvaluationContextV1 = {
      ...withoutDigest,
      evaluationContextDigest: computeEvaluationContextDigest(withoutDigest),
    };

    expect(validateGateEvaluationContextV1(context)).toBe(true);
    expect(validateGateEvaluationContextV1({ ...context, headOid: "d".repeat(12) })).toBe(false);
    expect(
      validateGateEvaluationContextV1({ ...context, evaluationContextDigest: "0".repeat(64) }),
    ).toBe(false);
  });

  it("evidence 绑定 definition、producer、context、head、output 与自身摘要", () => {
    const definition = createDefinition();
    const withoutDigest = {
      evaluationContextDigest: "a".repeat(64),
      evidenceProducerId: definition.evidenceProducerId,
      gateDefinitionDigest: computeGateDefinitionDigest(definition),
      gateId: definition.gateId,
      headOid: "b".repeat(40),
      outputDigest: "c".repeat(64),
      schemaVersion: 1 as const,
      status: "pass" as const,
    };
    const evidence: GateEvidenceV1 = {
      ...withoutDigest,
      gateEvidenceDigest: computeGateEvidenceDigest(withoutDigest),
    };

    expect(validateGateEvidenceV1(evidence)).toBe(true);
    expect(validateGateEvidenceV1({ ...evidence, status: "unknown" })).toBe(false);
    expect(
      validateGateEvidenceV1({ ...evidence, gateEvidenceDigest: "0".repeat(64) }),
    ).toBe(false);
  });
});
