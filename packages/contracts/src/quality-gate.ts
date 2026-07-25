import { sha256CanonicalJson } from "./canonical-json.js";

/** Gate V1 固定责任边界。 */
export type GateCapabilityOwnerV1 =
  | "architecture"
  | "architecture-po"
  | "dev-enablement"
  | "qa"
  | "security";

/** Gate 定义的封闭、可摘要合同。 */
export interface GateDefinitionV1 {
  blocking: boolean;
  capabilityOwner: GateCapabilityOwnerV1;
  checkId: string;
  command: readonly string[];
  evidenceProducerId: string;
  gateId: string;
  triggerPaths?: readonly string[];
}

/** Gate Registry 中带定义摘要的单项。 */
export interface GateRegistryEntryV1 {
  gateDefinition: GateDefinitionV1;
  gateDefinitionDigest: string;
}

/** 普通 PR gate 定义的唯一机器注册表。 */
export interface GateRegistryV1 {
  gates: readonly GateRegistryEntryV1[];
  schemaVersion: 1;
}

/** Git 对象存储使用的摘要格式。 */
export type GitObjectFormatV1 = "sha1" | "sha256";

/** 固定 provider 与 Git OID 的 gate 评估上下文。 */
export interface GateEvaluationContextV1 {
  baseOid: string;
  comparisonBaseOid: string;
  evaluationContextDigest: string;
  gateRegistryDigest: string;
  headOid: string;
  objectFormat: GitObjectFormatV1;
  providerRepositoryId: string;
  schemaVersion: 1;
}

/** 计算上下文摘要时排除自引用字段后的输入。 */
export type GateEvaluationContextDigestInputV1 = Omit<
  GateEvaluationContextV1,
  "evaluationContextDigest"
>;

/** Child gate 的终态。 */
export type GateEvidenceStatusV1 = "fail" | "invalid" | "pass";

/** Gate 进程正常退出的封闭终止状态。 */
export interface GateExitTerminationV1 {
  code: number;
  kind: "exit";
}

/** Gate 进程被信号终止的封闭终止状态。 */
export interface GateSignalTerminationV1 {
  kind: "signal";
  signalName: string;
}

/** Gate 无法启动或超时的封闭终止状态。 */
export interface GateSpawnErrorTerminationV1 {
  kind: "spawn-error";
  stableCode: string;
}

/** GateOutputV1 允许的唯一终止联合。 */
export type GateTerminationV1 =
  | GateExitTerminationV1
  | GateSignalTerminationV1
  | GateSpawnErrorTerminationV1;

/** 绑定有界原始输出和终止原因的封闭 Gate 输出合同。 */
export interface GateOutputV1 {
  gateId: string;
  schemaVersion: 1;
  stderrBytes: number;
  stderrDigest: string;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stdoutDigest: string;
  stdoutTruncated: boolean;
  termination: GateTerminationV1;
}

/** Child gate 交付给外部 Controller 的唯一证据合同。 */
export interface GateEvidenceV1 {
  evaluationContextDigest: string;
  evidenceProducerId: string;
  gateDefinitionDigest: string;
  gateEvidenceDigest: string;
  gateId: string;
  headOid: string;
  outputDigest: string;
  schemaVersion: 1;
  status: GateEvidenceStatusV1;
}

/** 计算证据摘要时排除自引用字段后的输入。 */
export type GateEvidenceDigestInputV1 = Omit<GateEvidenceV1, "gateEvidenceDigest">;

/** 计算覆盖完整 GateDefinitionV1（含 producer）的定义摘要。 */
export function computeGateDefinitionDigest(definition: GateDefinitionV1): string {
  return sha256CanonicalJson(definition);
}

/** 计算完整 GateRegistryV1 的旁路摘要，不把摘要写回根对象。 */
export function computeGateRegistryDigest(registry: GateRegistryV1): string {
  return sha256CanonicalJson(registry);
}

/** 计算排除 evaluationContextDigest 后的评估上下文摘要。 */
export function computeEvaluationContextDigest(
  context: GateEvaluationContextDigestInputV1,
): string {
  return sha256CanonicalJson(context);
}

/** 计算排除 gateEvidenceDigest 后的 child evidence 摘要。 */
export function computeGateEvidenceDigest(evidence: GateEvidenceDigestInputV1): string {
  return sha256CanonicalJson(evidence);
}
