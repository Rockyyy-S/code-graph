import { describe, expect, it, vi } from "vitest";
import {
  runBoundPublicCapabilityTest,
  runPublicCapabilityVerification,
} from "../../scripts/contracts/run-public-capability-verification.mjs";

const contract = {
  capabilityId: "rpc:graph/query",
  evidenceId: "public-capability:rpc:graph/query",
  fixturePath: "tests/fixtures/graph-query.request.json",
  testPath: "tests/contract/graph-query.contract.test.ts",
};
type VerificationInput = typeof contract & { challenge: string; fixtureDigest: string };

/** 构造与 GateDefinition 命令完全一致的封闭参数序列。 */
function argv(): string[] {
  return [
    "--capability",
    contract.capabilityId,
    "--test",
    contract.testPath,
    "--fixture",
    contract.fixturePath,
    "--evidence-id",
    contract.evidenceId,
  ];
}

describe("public capability verification runtime", () => {
  it("读取绑定 fixture、执行唯一测试并输出 evidenceId 闭合结果", async () => {
    const executeTest = vi.fn(async (input: VerificationInput) => ({
      capabilityId: input.capabilityId,
      challenge: input.challenge,
      evidenceId: input.evidenceId,
      fixtureDigest: input.fixtureDigest,
      fixturePath: input.fixturePath,
      schemaVersion: 1,
      testPath: input.testPath,
    }));
    const writeOutput = vi.fn();

    await runPublicCapabilityVerification(
      { ...contract, argv: argv() },
      {
        createChallenge: () => "fixed-challenge-0123456789abcdef",
        executeTest,
        readFixture: async () => Buffer.from('{"request":true}'),
        writeOutput,
      },
    );

    expect(executeTest).toHaveBeenCalledWith(expect.objectContaining(contract));
    expect(executeTest).toHaveBeenCalledWith(expect.objectContaining({
      challenge: "fixed-challenge-0123456789abcdef",
      fixtureDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    expect(writeOutput).toHaveBeenCalledWith(expect.stringMatching(/verificationDigest/u));
  });

  it("拒绝缺失、重排或追加的 argv，且不执行测试", async () => {
    const executeTest = vi.fn(async () => undefined);

    await expect(
      runPublicCapabilityVerification(
        { ...contract, argv: [...argv(), "--extra"] },
        {
          executeTest,
          readFixture: async () => Buffer.from("{}"),
          writeOutput: vi.fn(),
        },
      ),
    ).rejects.toThrow(/参数/u);
    expect(executeTest).not.toHaveBeenCalled();
  });

  it("拒绝测试进程伪造 capability、fixture digest 或 challenge 证据", async () => {
    await expect(
      runPublicCapabilityVerification(
        { ...contract, argv: argv() },
        {
          createChallenge: () => "fixed-challenge-0123456789abcdef",
          executeTest: async (input: VerificationInput) => ({
            capabilityId: input.capabilityId,
            challenge: "forged-challenge-0123456789abcdef",
            evidenceId: input.evidenceId,
            fixtureDigest: input.fixtureDigest,
            fixturePath: input.fixturePath,
            schemaVersion: 1,
            testPath: input.testPath,
          }),
          readFixture: async () => Buffer.from("{}"),
          writeOutput: vi.fn(),
        },
      ),
    ).rejects.toThrow(/challenge|evidence|闭合/u);
  });

  it("bound test runtime 读取真实 fixture 并在正负回调完成后写入 challenge 证据", async () => {
    const verifyPositive = vi.fn(async ({ capabilityId, fixture }) => {
      expect(capabilityId).toBe(contract.capabilityId);
      expect(fixture).toEqual({ request: true });
    });
    const verifyNegative = vi.fn(async ({ fixtureBytes }) => {
      expect(fixtureBytes.length).toBeGreaterThan(0);
    });
    const writeEvidence = vi.fn();
    const fixtureBytes = Buffer.from('{"request":true}');

    const proof = await runBoundPublicCapabilityTest(
      { ...contract, verifyNegative, verifyPositive },
      {
        environment: {
          CODEGRAPH_PUBLIC_CAPABILITY: contract.capabilityId,
          CODEGRAPH_PUBLIC_CAPABILITY_CHALLENGE: "fixed-challenge-0123456789abcdef",
          CODEGRAPH_PUBLIC_CAPABILITY_EVIDENCE_FILE: "evidence.json",
          CODEGRAPH_PUBLIC_CAPABILITY_EVIDENCE_ID: contract.evidenceId,
          CODEGRAPH_PUBLIC_CAPABILITY_FIXTURE: contract.fixturePath,
          CODEGRAPH_PUBLIC_CAPABILITY_FIXTURE_DIGEST:
            "bc0060f1167f73954be5452b4fed4c8d6c80dabb5b54bad3a635f041a7e39089",
          CODEGRAPH_PUBLIC_CAPABILITY_TEST: contract.testPath,
        },
        readFixture: async () => fixtureBytes,
        writeEvidence,
      },
    );

    expect(verifyPositive).toHaveBeenCalledOnce();
    expect(verifyNegative).toHaveBeenCalledOnce();
    expect(writeEvidence).toHaveBeenCalledWith(
      "evidence.json",
      `${JSON.stringify(proof)}\n`,
      "utf8",
    );
  });
});
