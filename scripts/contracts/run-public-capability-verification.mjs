import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const execFileAsync = promisify(execFile);

/**
 * 消费能力专属 gate 的封闭参数，读取 fixture，执行唯一测试文件并输出 evidence 闭合结果。
 */
export async function runPublicCapabilityVerification({
  argv,
  capabilityId,
  evidenceId,
  fixturePath,
  testPath,
}, dependencies = {}) {
  const parsed = parseVerificationArguments(argv);
  const expected = { capabilityId, evidenceId, fixturePath, testPath };
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error("公共能力 verification argv 未与 binding 精确闭合。\n");
  }
  const fixtureBytes = await (dependencies.readFixture ?? readFile)(fixturePath);
  if (fixtureBytes.length === 0) {
    throw new Error("公共能力 verification fixture 为空。\n");
  }
  const fixtureDigest = sha256Hex(fixtureBytes);
  const challenge = (dependencies.createChallenge ?? createChallenge)();
  if (typeof challenge !== "string" || challenge.length < 16) {
    throw new Error("公共能力 verification challenge 无效。\n");
  }
  const configPath = testPath.startsWith("tests/contract/")
    ? "vitest.contract.config.ts"
    : testPath.startsWith("tests/unit/")
      ? "vitest.config.ts"
      : null;
  if (configPath === null) {
    throw new Error("公共能力 verification testPath 必须位于 tests/unit 或 tests/contract。\n");
  }
  const proof = await (dependencies.executeTest ?? executeVerificationTest)({
    capabilityId,
    challenge,
    configPath,
    evidenceId,
    fixtureDigest,
    fixturePath,
    testPath,
  });
  validateVerificationProof(proof, {
    capabilityId,
    challenge,
    evidenceId,
    fixtureDigest,
    fixturePath,
    testPath,
  });
  const verificationDigest = sha256Hex(
    Buffer.from(JSON.stringify(proof), "utf8"),
  );
  (dependencies.writeOutput ?? process.stdout.write.bind(process.stdout))(`${JSON.stringify({
    capabilityId,
    evidenceId,
    fixtureBytes: fixtureBytes.length,
    fixtureDigest,
    fixturePath,
    schemaVersion: 1,
    testPath,
    verificationDigest,
  })}\n`);
}

/** 使用冻结 pnpm 入口执行唯一 Vitest 文件，并验证其写出的 challenge-bound 证据。 */
async function executeVerificationTest({
  capabilityId,
  challenge,
  configPath,
  evidenceId,
  fixtureDigest,
  fixturePath,
  testPath,
}) {
  const evidenceDirectory = await mkdtemp(
    path.join(tmpdir(), "public-capability-verification-"),
  );
  const evidencePath = path.join(evidenceDirectory, "evidence.json");
  const invocation = createPnpmInvocation(process.env.npm_execpath, [
    "exec",
    "vitest",
    "run",
    "--config",
    configPath,
    testPath,
  ]);
  try {
    await execFileAsync(invocation.executable, invocation.args, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEGRAPH_PUBLIC_CAPABILITY: capabilityId,
        CODEGRAPH_PUBLIC_CAPABILITY_CHALLENGE: challenge,
        CODEGRAPH_PUBLIC_CAPABILITY_EVIDENCE_FILE: evidencePath,
        CODEGRAPH_PUBLIC_CAPABILITY_EVIDENCE_ID: evidenceId,
        CODEGRAPH_PUBLIC_CAPABILITY_FIXTURE: fixturePath,
        CODEGRAPH_PUBLIC_CAPABILITY_FIXTURE_DIGEST: fixtureDigest,
        CODEGRAPH_PUBLIC_CAPABILITY_TEST: testPath,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    });
    return JSON.parse(await readFile(evidencePath, "utf8"));
  } finally {
    await rm(evidenceDirectory, { force: true, recursive: true });
  }
}

/**
 * 在能力专属 Vitest case 内读取真实 fixture，执行正向/负向验证，并写出单次 challenge 证据。
 */
export async function runBoundPublicCapabilityTest(
  {
    capabilityId,
    evidenceId,
    fixturePath,
    verifyNegative,
    verifyPositive,
  },
  dependencies = {},
) {
  if (typeof verifyPositive !== "function" || typeof verifyNegative !== "function") {
    throw new TypeError("公共能力测试必须提供正向与负向验证回调。");
  }
  const environment = dependencies.environment ?? process.env;
  const expected = {
    capabilityId: environment.CODEGRAPH_PUBLIC_CAPABILITY,
    evidenceId: environment.CODEGRAPH_PUBLIC_CAPABILITY_EVIDENCE_ID,
    fixturePath: environment.CODEGRAPH_PUBLIC_CAPABILITY_FIXTURE,
  };
  if (
    capabilityId !== expected.capabilityId ||
    evidenceId !== expected.evidenceId ||
    fixturePath !== expected.fixturePath
  ) {
    throw new Error("公共能力测试未与 runtime 注入的 capability/fixture/evidence 闭合。");
  }
  const challenge = environment.CODEGRAPH_PUBLIC_CAPABILITY_CHALLENGE;
  const evidencePath = environment.CODEGRAPH_PUBLIC_CAPABILITY_EVIDENCE_FILE;
  const fixtureDigest = environment.CODEGRAPH_PUBLIC_CAPABILITY_FIXTURE_DIGEST;
  const testPath = environment.CODEGRAPH_PUBLIC_CAPABILITY_TEST;
  if (
    typeof challenge !== "string" ||
    challenge.length < 16 ||
    typeof evidencePath !== "string" ||
    evidencePath.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(fixtureDigest ?? "") ||
    typeof testPath !== "string" ||
    testPath.length === 0
  ) {
    throw new Error("公共能力测试缺少可信 challenge、fixture digest 或 evidence 目标。");
  }
  const fixtureBytes = await (dependencies.readFixture ?? readFile)(fixturePath);
  if (sha256Hex(fixtureBytes) !== fixtureDigest) {
    throw new Error("公共能力测试读取的 fixture digest 已漂移。");
  }
  let fixture;
  try {
    fixture = JSON.parse(Buffer.from(fixtureBytes).toString("utf8"));
  } catch {
    throw new Error("公共能力测试 fixture 必须是有效 JSON。");
  }
  const context = Object.freeze({
    capabilityId,
    evidenceId,
    fixture,
    fixtureBytes: Buffer.from(fixtureBytes),
    fixtureDigest,
    fixturePath,
    testPath,
  });
  await verifyPositive(context);
  await verifyNegative(context);
  const proof = {
    capabilityId,
    challenge,
    evidenceId,
    fixtureDigest,
    fixturePath,
    schemaVersion: 1,
    testPath,
  };
  await (dependencies.writeEvidence ?? writeFile)(
    evidencePath,
    `${JSON.stringify(proof)}\n`,
    "utf8",
  );
  return proof;
}

/** 验证测试子进程只能提交本次 challenge 与真实 fixture digest 的封闭证据。 */
function validateVerificationProof(proof, expected) {
  if (
    typeof proof !== "object" ||
    proof === null ||
    Array.isArray(proof) ||
    Object.getPrototypeOf(proof) !== Object.prototype
  ) {
    throw new Error("公共能力 verification evidence 必须是普通对象。");
  }
  const expectedProof = {
    capabilityId: expected.capabilityId,
    challenge: expected.challenge,
    evidenceId: expected.evidenceId,
    fixtureDigest: expected.fixtureDigest,
    fixturePath: expected.fixturePath,
    schemaVersion: 1,
    testPath: expected.testPath,
  };
  if (
    JSON.stringify(Object.keys(proof).sort()) !==
      JSON.stringify(Object.keys(expectedProof).sort()) ||
    JSON.stringify(proof) !== JSON.stringify(expectedProof)
  ) {
    throw new Error("公共能力 verification challenge evidence 未与本次执行精确闭合。");
  }
}

/** 生成只在单次 verification 进程内有效的随机 challenge。 */
function createChallenge() {
  return randomBytes(32).toString("hex");
}

/** 计算 fixture 与 verification evidence 使用的 SHA-256 小写十六进制摘要。 */
function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** 严格按固定顺序解析八个 flag/value token，拒绝缺失、重复与未知参数。 */
function parseVerificationArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 8 ||
    !argv.every((value) => typeof value === "string" && value.length > 0)
  ) {
    throw new Error("公共能力 verification 参数数量或类型无效。\n");
  }
  const expectedFlags = ["--capability", "--test", "--fixture", "--evidence-id"];
  for (let index = 0; index < expectedFlags.length; index += 1) {
    if (argv[index * 2] !== expectedFlags[index]) {
      throw new Error("公共能力 verification 参数顺序或名称无效。\n");
    }
  }
  return {
    capabilityId: argv[1],
    evidenceId: argv[7],
    fixturePath: argv[5],
    testPath: argv[3],
  };
}
