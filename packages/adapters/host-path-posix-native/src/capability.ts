import { createHash } from "node:crypto";
import {
  HOST_PATH_POSIX_ABI_VERSION,
  HOST_PATH_POSIX_PROTOCOL_VERSION,
  hasExactKeys,
  isRecord,
  isSha256,
  isStableToken,
  type HostPathPosixCapabilityRejectionReasonV1,
  type HostPathPosixCapabilityV1,
  type HostPathPosixPlatformV1,
  type HostPathPosixPrimitiveKindV1,
} from "./protocol.js";

/** 组合根维护的 provenance allowlist，native provider 无权扩写。 */
export interface HostPathPosixTrustedProvenanceV1 {
  authorityKind: HostPathPosixCapabilityV1["authority"]["kind"];
  binarySha256: string;
  entitlement: HostPathPosixCapabilityV1["provenance"]["entitlement"];
  platform: HostPathPosixPlatformV1;
  primitiveKind: HostPathPosixPrimitiveKindV1;
  providerId: string;
  provenanceKind: HostPathPosixCapabilityV1["provenance"]["kind"];
  signerId: string;
}

/** 只有本模块完成全部校验后才能产生的 opaque capability token。 */
export interface ValidatedHostPathPosixCapabilityV1 {
  readonly capability: HostPathPosixCapabilityV1;
  readonly capabilityDigest: string;
}

export type HostPathPosixCapabilityValidationV1 =
  | { status: "accepted"; validated: ValidatedHostPathPosixCapabilityV1 }
  | { reason: HostPathPosixCapabilityRejectionReasonV1; status: "rejected" };

const validatedCapabilities = new WeakSet<object>();

/** 只有三类强原语可能满足 namespace complete。 */
const STRONG_PRIMITIVE_KINDS = new Set<HostPathPosixPrimitiveKindV1>([
  "complete-namespace-interposition",
  "filesystem-freeze",
  "filesystem-snapshot",
]);

/** 校验 capability 的版本、平台、强度、范围、特权 provenance 与外部 allowlist。 */
export function validateHostPathPosixCapabilityV1(
  value: unknown,
  options: {
    platform: HostPathPosixPlatformV1;
    trustedProvenance: readonly HostPathPosixTrustedProvenanceV1[];
  },
): HostPathPosixCapabilityValidationV1 {
  if (value === undefined || value === null) {
    return rejectCapability("CAPABILITY_MISSING");
  }
  if (!isRecord(value)) {
    return rejectCapability("CAPABILITY_SHAPE_INVALID");
  }
  if (!("authority" in value) || !("provenance" in value)) {
    return rejectCapability("PRIVILEGED_PROVENANCE_REQUIRED");
  }
  if (!validateCapabilityShape(value)) {
    return rejectCapability("CAPABILITY_SHAPE_INVALID");
  }
  const parsed = value as unknown as HostPathPosixCapabilityV1;
  const versionFailure = validateCapabilityVersions(parsed);
  if (versionFailure !== null) {
    return rejectCapability(versionFailure);
  }
  if (!validateCapabilityPlatform(parsed, options.platform)) {
    return rejectCapability("PLATFORM_MISMATCH");
  }
  const primitiveFailure = validateCapabilityPrimitive(parsed);
  if (primitiveFailure !== null) {
    return rejectCapability(primitiveFailure);
  }
  if (!validateCapabilitySupportScope(parsed)) {
    return rejectCapability("SUPPORT_SCOPE_INCOMPLETE");
  }
  if (!validateCapabilityFence(parsed)) {
    return rejectCapability("FENCE_NOT_STRONG");
  }
  if (!validateCapabilityAuthority(parsed) || !validateCapabilityProvenance(parsed)) {
    return rejectCapability("PRIVILEGED_PROVENANCE_REQUIRED");
  }
  if (
    !validatePlatformPrimitiveAuthorityCombination(parsed) ||
    !validateTrustedProvenance(parsed, options.trustedProvenance)
  ) {
    return rejectCapability("PROVENANCE_NOT_ALLOWLISTED");
  }

  const capability = freezeCapability(parsed);
  const validated = Object.freeze({
    capability,
    capabilityDigest: createHash("sha256")
      .update(JSON.stringify(capability), "utf8")
      .digest("hex"),
  });
  validatedCapabilities.add(validated);
  return { status: "accepted", validated };
}

/** graph-service 只接受当前模块实际签发的 capability token。 */
export function isValidatedHostPathPosixCapabilityV1(
  value: unknown,
): value is ValidatedHostPathPosixCapabilityV1 {
  return typeof value === "object" &&
    value !== null &&
    validatedCapabilities.has(value);
}

/** 顶层及全部嵌套对象都拒绝未知或缺失字段。 */
function validateCapabilityShape(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    "abiVersion",
    "authority",
    "failClosedReason",
    "fence",
    "platform",
    "primitiveKind",
    "protocolVersion",
    "provenance",
    "status",
    "supportScope",
  ]) &&
    isRecord(value.authority) &&
    hasExactKeys(value.authority, ["kind", "providerId"]) &&
    isRecord(value.provenance) &&
    hasExactKeys(value.provenance, ["binarySha256", "entitlement", "kind", "signerId"]) &&
    isRecord(value.supportScope) &&
    hasExactKeys(value.supportScope, ["candidateSet", "root", "volume"]) &&
    isRecord(value.fence) &&
    hasExactKeys(value.fence, ["lifetime", "namespace", "strength"]) &&
    value.status === "available" &&
    value.failClosedReason === null;
}

/** 协议与 ABI 任一不兼容都必须在 capture 前拒绝。 */
function validateCapabilityVersions(
  value: HostPathPosixCapabilityV1,
): "ABI_VERSION_INCOMPATIBLE" | "PROTOCOL_VERSION_INCOMPATIBLE" | null {
  if (value.protocolVersion !== HOST_PATH_POSIX_PROTOCOL_VERSION) {
    return "PROTOCOL_VERSION_INCOMPATIBLE";
  }
  return value.abiVersion === HOST_PATH_POSIX_ABI_VERSION
    ? null
    : "ABI_VERSION_INCOMPATIBLE";
}

/** capability 平台必须与组合根请求的平台逐字相等。 */
function validateCapabilityPlatform(
  value: HostPathPosixCapabilityV1,
  platform: HostPathPosixPlatformV1,
): boolean {
  return (value.platform === "darwin" || value.platform === "linux") &&
    value.platform === platform;
}

/** watcher 只能提供保守失效，不得提升为 namespace fence。 */
function validateCapabilityPrimitive(
  value: HostPathPosixCapabilityV1,
): "CAPABILITY_SHAPE_INVALID" | "PRIMITIVE_NOT_ALLOWLISTED" | "WATCHER_ONLY" | null {
  if (
    value.primitiveKind !== "complete-namespace-interposition" &&
    value.primitiveKind !== "filesystem-freeze" &&
    value.primitiveKind !== "filesystem-snapshot" &&
    value.primitiveKind !== "watcher-conservative-invalidation"
  ) {
    return "CAPABILITY_SHAPE_INVALID";
  }
  if (value.primitiveKind === "watcher-conservative-invalidation") {
    return "WATCHER_ONLY";
  }
  return STRONG_PRIMITIVE_KINDS.has(value.primitiveKind)
    ? null
    : "PRIMITIVE_NOT_ALLOWLISTED";
}

/** complete 必须覆盖 root、完整请求批次与 native 固定卷。 */
function validateCapabilitySupportScope(value: HostPathPosixCapabilityV1): boolean {
  return value.supportScope.root === "indexing-root" &&
    value.supportScope.candidateSet === "complete-request-batch" &&
    value.supportScope.volume === "native-fixed-volume";
}

/** 只有 capture 生命周期内的 strong complete namespace fence 可被消费。 */
function validateCapabilityFence(value: HostPathPosixCapabilityV1): boolean {
  return value.fence.strength === "strong" &&
    value.fence.namespace === "complete" &&
    value.fence.lifetime === "capture";
}

/** authority 必须是已知特权边界并携带稳定 provider ID。 */
function validateCapabilityAuthority(value: HostPathPosixCapabilityV1): boolean {
  return (value.authority.kind === "privileged-helper" ||
    value.authority.kind === "system-extension") &&
    isStableToken(value.authority.providerId);
}

/** provenance 必须是签名产物、固定摘要、签名者与封闭 entitlement。 */
function validateCapabilityProvenance(value: HostPathPosixCapabilityV1): boolean {
  return (value.provenance.kind === "signed-privileged-helper" ||
    value.provenance.kind === "signed-system-extension") &&
    isSha256(value.provenance.binarySha256) &&
    isStableToken(value.provenance.signerId) &&
    isKnownEntitlement(value.provenance.entitlement);
}

/** 平台、原语、authority 与 entitlement 的组合必须来自固定强原语矩阵。 */
function validatePlatformPrimitiveAuthorityCombination(
  value: HostPathPosixCapabilityV1,
): boolean {
  const combination = [
    value.platform,
    value.primitiveKind,
    value.authority.kind,
    value.provenance.kind,
    value.provenance.entitlement,
  ].join(":");
  return combination === "linux:filesystem-freeze:privileged-helper:signed-privileged-helper:linux-cap-sys-admin" ||
    combination === "linux:filesystem-snapshot:privileged-helper:signed-privileged-helper:linux-filesystem-snapshot" ||
    combination === "linux:complete-namespace-interposition:privileged-helper:signed-privileged-helper:linux-complete-namespace-interposition" ||
    combination === "darwin:filesystem-snapshot:privileged-helper:signed-privileged-helper:macos-apfs-snapshot" ||
    combination === "darwin:complete-namespace-interposition:system-extension:signed-system-extension:macos-complete-namespace-interposition";
}

/** 外部 allowlist 必须逐字段匹配，provider 自报不能扩展信任集合。 */
function validateTrustedProvenance(
  value: HostPathPosixCapabilityV1,
  trustedProvenance: readonly HostPathPosixTrustedProvenanceV1[],
): boolean {
  return trustedProvenance.some((trusted) =>
    trusted.platform === value.platform &&
    trusted.primitiveKind === value.primitiveKind &&
    trusted.authorityKind === value.authority.kind &&
    trusted.providerId === value.authority.providerId &&
    trusted.provenanceKind === value.provenance.kind &&
    trusted.signerId === value.provenance.signerId &&
    trusted.binarySha256 === value.provenance.binarySha256 &&
    trusted.entitlement === value.provenance.entitlement
  );
}

/** entitlement 词汇必须封闭，禁止 provider 自定义强能力名称。 */
function isKnownEntitlement(
  value: unknown,
): value is HostPathPosixCapabilityV1["provenance"]["entitlement"] {
  return value === "linux-cap-sys-admin" ||
    value === "linux-complete-namespace-interposition" ||
    value === "linux-filesystem-snapshot" ||
    value === "macos-apfs-snapshot" ||
    value === "macos-complete-namespace-interposition";
}

/** 重建固定字段顺序并冻结，避免 provider 对已校验对象做后续变异。 */
function freezeCapability(value: HostPathPosixCapabilityV1): HostPathPosixCapabilityV1 {
  return Object.freeze({
    abiVersion: HOST_PATH_POSIX_ABI_VERSION,
    authority: Object.freeze({
      kind: value.authority.kind,
      providerId: value.authority.providerId,
    }),
    failClosedReason: null,
    fence: Object.freeze({
      lifetime: value.fence.lifetime,
      namespace: value.fence.namespace,
      strength: value.fence.strength,
    }),
    platform: value.platform,
    primitiveKind: value.primitiveKind,
    protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
    provenance: Object.freeze({
      binarySha256: value.provenance.binarySha256,
      entitlement: value.provenance.entitlement,
      kind: value.provenance.kind,
      signerId: value.provenance.signerId,
    }),
    status: "available",
    supportScope: Object.freeze({
      candidateSet: value.supportScope.candidateSet,
      root: value.supportScope.root,
      volume: value.supportScope.volume,
    }),
  });
}

/** 统一构造 capability 拒绝结果。 */
function rejectCapability(
  reason: HostPathPosixCapabilityRejectionReasonV1,
): HostPathPosixCapabilityValidationV1 {
  return { reason, status: "rejected" };
}
