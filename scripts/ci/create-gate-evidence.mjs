import {
  sha256CanonicalJson,
  sha256Hex,
} from "../../packages/contracts/runtime/canonical-json.mjs";

/** 从原始有界 stdout/stderr 与封闭 termination 创建 GateOutputV1。 */
export function createGateOutputV1({
  gateId,
  stderr,
  stderrTruncated,
  stdout,
  stdoutTruncated,
  termination,
}) {
  validateTermination(termination);
  return {
    gateId,
    schemaVersion: 1,
    stderrBytes: stderr.length,
    stderrDigest: sha256Hex(stderr),
    stderrTruncated,
    stdoutBytes: stdout.length,
    stdoutDigest: sha256Hex(stdout),
    stdoutTruncated,
    termination,
  };
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

/** termination 只能是 exit、signal 或 spawn-error 三种封闭联合。 */
function validateTermination(termination) {
  const keys = Object.keys(termination ?? {}).sort().join(",");
  const valid =
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
      termination.stableCode.length > 0);
  if (!valid) {
    throw new Error("GateOutputV1.termination 必须是封闭的 exit|signal|spawn-error 联合。\n");
  }
}
