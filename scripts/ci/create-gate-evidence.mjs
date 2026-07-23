import {
  sha256CanonicalJson,
  sha256Hex,
} from "../../packages/contracts/runtime/canonical-json.mjs";

const stableIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const gitOidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** 从原始有界 stdout/stderr 与封闭 termination 创建 GateOutputV1。 */
export function createGateOutputV1({
  gateId,
  stderr,
  stderrBytes = stderr?.length,
  stderrTruncated,
  stdout,
  stdoutBytes = stdout?.length,
  stdoutTruncated,
  termination,
}) {
  if (!(stderr instanceof Uint8Array) || !(stdout instanceof Uint8Array)) {
    throw new TypeError("GateOutputV1 stdout/stderr 必须是原始字节。");
  }
  if (
    !stableIdPattern.test(gateId ?? "") ||
    typeof stderrTruncated !== "boolean" ||
    typeof stdoutTruncated !== "boolean" ||
    !Number.isSafeInteger(stderrBytes) ||
    !Number.isSafeInteger(stdoutBytes) ||
    stderrBytes < stderr.length ||
    stdoutBytes < stdout.length ||
    (stderrTruncated ? stderrBytes <= stderr.length : stderrBytes !== stderr.length) ||
    (stdoutTruncated ? stdoutBytes <= stdout.length : stdoutBytes !== stdout.length)
  ) {
    throw new TypeError("GateOutputV1 gateId、字节计数或截断标记非法。");
  }
  validateTermination(termination);
  const output = {
    gateId,
    schemaVersion: 1,
    stderrBytes,
    stderrDigest: sha256Hex(stderr),
    stderrTruncated,
    stdoutBytes,
    stdoutDigest: sha256Hex(stdout),
    stdoutTruncated,
    termination,
  };
  if (!validateGateOutputValue(output)) {
    throw new TypeError("GateOutputV1 未满足封闭合同。");
  }
  return output;
}

/** 创建绑定 definition、producer、context、head 与 output 的 GateEvidenceV1。 */
export function createGateEvidenceV1({
  definition,
  evaluationContextDigest,
  gateDefinitionDigest,
  headOid,
  output,
  status,
}) {
  if (
    !stableIdPattern.test(definition?.gateId ?? "") ||
    !definition.evidenceProducerId?.endsWith(`#${definition.gateId}`) ||
    !digestPattern.test(evaluationContextDigest ?? "") ||
    !digestPattern.test(gateDefinitionDigest ?? "") ||
    !gitOidPattern.test(headOid ?? "") ||
    !/^(?:pass|fail|invalid)$/u.test(status ?? "") ||
    !validateGateOutputValue(output) ||
    output.gateId !== definition.gateId
  ) {
    throw new TypeError("GateEvidenceV1 输入未满足封闭合同。");
  }
  const expectedStatus = statusForTermination(output.termination);
  if (status !== expectedStatus) {
    throw new TypeError("GateEvidenceV1 status 与 GateOutputV1 termination 不一致。");
  }
  const evidenceWithoutDigest = {
    evaluationContextDigest,
    evidenceProducerId: definition.evidenceProducerId,
    gateDefinitionDigest,
    gateId: definition.gateId,
    headOid,
    outputDigest: sha256CanonicalJson(output),
    schemaVersion: 1,
    status,
  };
  return {
    ...evidenceWithoutDigest,
    gateEvidenceDigest: sha256CanonicalJson(evidenceWithoutDigest),
  };
}

/** 验证 evidence 与可信 definition/context/head 的逐字段绑定和自身摘要。 */
export function validateGateEvidenceBinding({
  definition,
  evaluationContextDigest,
  evidence,
  gateDefinitionDigest,
  headOid,
}) {
  if (!validateGateEvidenceValue(evidence)) {
    return { reason: "evidence 未满足封闭 GateEvidenceV1 Schema", status: "invalid" };
  }
  const expectedFields = {
    evaluationContextDigest,
    evidenceProducerId: definition.evidenceProducerId,
    gateDefinitionDigest,
    gateId: definition.gateId,
    headOid,
  };
  for (const [field, expected] of Object.entries(expectedFields)) {
    if (evidence?.[field] !== expected) {
      return { reason: `${field} 与可信绑定不一致`, status: "invalid" };
    }
  }
  if (!/^(?:pass|fail|invalid)$/u.test(evidence.status ?? "")) {
    return { reason: "evidence status 非法", status: "invalid" };
  }
  const {
    gateEvidenceDigest,
    ...digestInput
  } = evidence;
  if (
    !/^[a-f0-9]{64}$/u.test(gateEvidenceDigest ?? "") ||
    gateEvidenceDigest !== sha256CanonicalJson(digestInput)
  ) {
    return { reason: "gateEvidenceDigest 漂移", status: "invalid" };
  }
  return { status: "accepted" };
}

/** GateEvidenceV1 必须精确包含固定字段、合法格式和自摘要。 */
function validateGateEvidenceValue(evidence) {
  if (
    !isClosedObject(evidence, [
      "evaluationContextDigest",
      "evidenceProducerId",
      "gateDefinitionDigest",
      "gateEvidenceDigest",
      "gateId",
      "headOid",
      "outputDigest",
      "schemaVersion",
      "status",
    ]) ||
    evidence.schemaVersion !== 1 ||
    !stableIdPattern.test(evidence.gateId ?? "") ||
    typeof evidence.evidenceProducerId !== "string" ||
    !evidence.evidenceProducerId.endsWith(`#${evidence.gateId}`) ||
    !digestPattern.test(evidence.evaluationContextDigest ?? "") ||
    !digestPattern.test(evidence.gateDefinitionDigest ?? "") ||
    !digestPattern.test(evidence.gateEvidenceDigest ?? "") ||
    !digestPattern.test(evidence.outputDigest ?? "") ||
    !gitOidPattern.test(evidence.headOid ?? "") ||
    !/^(?:pass|fail|invalid)$/u.test(evidence.status ?? "")
  ) {
    return false;
  }
  const { gateEvidenceDigest, ...digestInput } = evidence;
  return gateEvidenceDigest === sha256CanonicalJson(digestInput);
}

/** GateOutputV1 的脚本侧检查与公共 Schema 保持同一封闭字段语义。 */
function validateGateOutputValue(output) {
  return (
    isClosedObject(output, [
      "gateId",
      "schemaVersion",
      "stderrBytes",
      "stderrDigest",
      "stderrTruncated",
      "stdoutBytes",
      "stdoutDigest",
      "stdoutTruncated",
      "termination",
    ]) &&
    output.schemaVersion === 1 &&
    stableIdPattern.test(output.gateId ?? "") &&
    Number.isSafeInteger(output.stderrBytes) &&
    output.stderrBytes >= 0 &&
    digestPattern.test(output.stderrDigest ?? "") &&
    typeof output.stderrTruncated === "boolean" &&
    Number.isSafeInteger(output.stdoutBytes) &&
    output.stdoutBytes >= 0 &&
    digestPattern.test(output.stdoutDigest ?? "") &&
    typeof output.stdoutTruncated === "boolean" &&
    isValidTermination(output.termination)
  );
}

/** 从封闭 termination 唯一派生 evidence status，禁止调用方自报通过。 */
function statusForTermination(termination) {
  if (termination.kind === "spawn-error") {
    return "invalid";
  }
  return termination.kind === "exit" && termination.code === 0 ? "pass" : "fail";
}

/** 验证普通对象精确包含固定字段。 */
function isClosedObject(value, allowedKeys) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** termination 只能是 exit、signal 或 spawn-error 三种封闭联合。 */
function validateTermination(termination) {
  if (!isValidTermination(termination)) {
    throw new Error("GateOutputV1.termination 必须是封闭的 exit|signal|spawn-error 联合。\n");
  }
}

/** 判断 termination 是否属于唯一封闭联合。 */
function isValidTermination(termination) {
  const keys = Object.keys(termination ?? {}).sort().join(",");
  return (
    (termination?.kind === "exit" &&
      keys === "code,kind" &&
      Number.isInteger(termination.code) &&
      termination.code >= 0) ||
    (termination?.kind === "signal" &&
      keys === "kind,signalName" &&
      typeof termination.signalName === "string" &&
      termination.signalName.length > 0) ||
    (termination?.kind === "spawn-error" &&
      keys === "kind,stableCode" &&
      typeof termination.stableCode === "string" &&
      termination.stableCode.length > 0)
  );
}
