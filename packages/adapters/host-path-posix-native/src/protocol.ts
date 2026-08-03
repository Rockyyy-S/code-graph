/** POSIX HostPath 原生边界的协议版本。 */
export const HOST_PATH_POSIX_PROTOCOL_VERSION = 1 as const;

/** POSIX HostPath 原生边界的 ABI 版本。 */
export const HOST_PATH_POSIX_ABI_VERSION = 1 as const;

/** 当前协议只允许显式支持的 POSIX 平台。 */
export type HostPathPosixPlatformV1 = "darwin" | "linux";

/** 原生能力只允许快照、冻结、完整拦截或保守 watcher 四类。 */
export type HostPathPosixPrimitiveKindV1 =
  | "complete-namespace-interposition"
  | "filesystem-freeze"
  | "filesystem-snapshot"
  | "watcher-conservative-invalidation";

/** 能力权威必须来自特权 helper 或 system extension。 */
export interface HostPathPosixAuthorityV1 {
  kind: "privileged-helper" | "system-extension";
  providerId: string;
}

/** provenance 必须绑定签名二进制、签名者与所需 entitlement。 */
export interface HostPathPosixProvenanceV1 {
  binarySha256: string;
  entitlement:
    | "linux-cap-sys-admin"
    | "linux-complete-namespace-interposition"
    | "linux-filesystem-snapshot"
    | "macos-apfs-snapshot"
    | "macos-complete-namespace-interposition";
  kind: "signed-privileged-helper" | "signed-system-extension";
  signerId: string;
}

/** 支持范围必须覆盖 indexing root、完整候选批次与单一固定卷。 */
export interface HostPathPosixSupportScopeV1 {
  candidateSet: "complete-request-batch" | "observed-events";
  root: "indexing-root";
  volume: "native-fixed-volume" | "unknown";
}

/** namespace fence 必须显式区分强 complete 与保守失效提示。 */
export interface HostPathPosixFenceV1 {
  lifetime: "capture" | "event-stream";
  namespace: "complete" | "none";
  strength: "conservative-invalidation" | "strong";
}

/** 原生 provider 声明的版本化能力对象；所有字段均由运行时封闭校验。 */
export interface HostPathPosixCapabilityV1 {
  abiVersion: 1;
  authority: HostPathPosixAuthorityV1;
  failClosedReason: null;
  fence: HostPathPosixFenceV1;
  platform: HostPathPosixPlatformV1;
  primitiveKind: HostPathPosixPrimitiveKindV1;
  protocolVersion: 1;
  provenance: HostPathPosixProvenanceV1;
  status: "available";
  supportScope: HostPathPosixSupportScopeV1;
}

/** capability 不能用于 complete 时返回稳定、封闭的拒绝原因。 */
export type HostPathPosixCapabilityRejectionReasonV1 =
  | "ABI_VERSION_INCOMPATIBLE"
  | "CAPABILITY_MISSING"
  | "CAPABILITY_SHAPE_INVALID"
  | "FENCE_NOT_STRONG"
  | "PLATFORM_MISMATCH"
  | "PRIMITIVE_NOT_ALLOWLISTED"
  | "PRIVILEGED_PROVENANCE_REQUIRED"
  | "PROTOCOL_VERSION_INCOMPATIBLE"
  | "PROVENANCE_NOT_ALLOWLISTED"
  | "SUPPORT_SCOPE_INCOMPLETE"
  | "WATCHER_ONLY";

/** 原生捕获失败只允许可审计的封闭原因。 */
export type HostPathPosixCaptureFailureReasonV1 =
  | "CAPABILITY_REVOKED"
  | "CAPTURE_CHANGED"
  | "LOGICAL_MAPPING_MISMATCH"
  | "PATH_MISSING"
  | "PATH_OUTSIDE_ROOT"
  | "PATH_UNREADABLE"
  | "PRIVILEGE_LOST"
  | "PROVIDER_ERROR"
  | "VOLUME_MISMATCH";

/** 协议或 provider 边界拒绝当前请求时使用的稳定原因。 */
export type HostPathPosixProtocolRejectionReasonV1 =
  | HostPathPosixCapabilityRejectionReasonV1
  | "CAPABILITY_BINDING_MISMATCH"
  | "CAPTURE_RESPONSE_INVALID"
  | "PROVIDER_ERROR";

/** 单个候选同时携带 root-derived trusted path 与调用方断言路径。 */
export interface HostPathPosixCaptureCandidateV1 {
  absolutePath: string;
  candidateIndex: number;
  logicalPath: string;
  trustedPath: string;
}

/** 发给受信任原生 provider 的完整捕获请求。 */
export interface HostPathPosixCaptureRequestV1 {
  abiVersion: 1;
  candidates: readonly HostPathPosixCaptureCandidateV1[];
  capabilityDigest: string;
  captureNonce: string;
  indexingRoot: string;
  platform: HostPathPosixPlatformV1;
  protocolVersion: 1;
}

/** complete 响应只返回不含路径的原生对象身份。 */
export interface HostPathPosixCompleteCaptureResponseV1 {
  abiVersion: 1;
  capabilityDigest: string;
  captureNonce: string;
  items: Array<{ candidateIndex: number; objectId: string }>;
  platform: HostPathPosixPlatformV1;
  protocolVersion: 1;
  rootObjectId: string;
  status: "complete";
  volumeId: string;
}

/** failed 响应必须显式说明是否可重试。 */
export interface HostPathPosixFailedCaptureResponseV1 {
  abiVersion: 1;
  capabilityDigest: string;
  captureNonce: string;
  failClosedReason: HostPathPosixCaptureFailureReasonV1;
  platform: HostPathPosixPlatformV1;
  protocolVersion: 1;
  retryable: boolean;
  status: "failed";
}

export type HostPathPosixCaptureResponseV1 =
  | HostPathPosixCompleteCaptureResponseV1
  | HostPathPosixFailedCaptureResponseV1;

/** native provider 只暴露 capability 与捕获两个版本化协议入口。 */
export interface HostPathPosixNativeProviderV1 {
  capture(request: HostPathPosixCaptureRequestV1): Promise<unknown>;
  getCapability(): Promise<unknown>;
}

/** 判断未知值是否为无原型要求的普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 对象字段集合必须与合同逐项完全相等。 */
export function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareOrdinal);
  const expected = [...expectedKeys].sort(compareOrdinal);
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

/** 标识字段只接受短小、无空白的稳定 token。 */
export function isStableToken(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value);
}

/** SHA-256 provenance 必须是小写十六进制。 */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** 校验 native capture 响应并拒绝未知字段、错版与绑定漂移。 */
export function validateHostPathPosixCaptureResponseV1(
  value: unknown,
  expected: {
    candidateCount: number;
    capabilityDigest: string;
    captureNonce: string;
    platform: HostPathPosixPlatformV1;
  },
):
  | { response: HostPathPosixCaptureResponseV1; status: "accepted" }
  | { reason: "CAPABILITY_BINDING_MISMATCH" | "CAPTURE_RESPONSE_INVALID"; status: "rejected" } {
  if (!isRecord(value) || typeof value.status !== "string") {
    return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
  }
  if (value.status === "complete") {
    return validateCompleteCaptureResponse(value, expected);
  }
  if (value.status === "failed") {
    return validateFailedCaptureResponse(value, expected);
  }
  return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
}

/** complete 响应必须覆盖且只覆盖本次候选集合。 */
function validateCompleteCaptureResponse(
  value: Record<string, unknown>,
  expected: {
    candidateCount: number;
    capabilityDigest: string;
    captureNonce: string;
    platform: HostPathPosixPlatformV1;
  },
):
  | { response: HostPathPosixCompleteCaptureResponseV1; status: "accepted" }
  | { reason: "CAPABILITY_BINDING_MISMATCH" | "CAPTURE_RESPONSE_INVALID"; status: "rejected" } {
  if (!hasExactKeys(value, [
    "abiVersion",
    "capabilityDigest",
    "captureNonce",
    "items",
    "platform",
    "protocolVersion",
    "rootObjectId",
    "status",
    "volumeId",
  ])) {
    return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
  }
  if (!responseEnvelopeMatches(value, expected)) {
    return { reason: "CAPABILITY_BINDING_MISMATCH", status: "rejected" };
  }
  if (
    !Array.isArray(value.items) ||
    value.items.length !== expected.candidateCount ||
    !isStableToken(value.rootObjectId) ||
    !isStableToken(value.volumeId)
  ) {
    return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
  }
  const seen = new Set<number>();
  const items: HostPathPosixCompleteCaptureResponseV1["items"] = [];
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["candidateIndex", "objectId"]) ||
      !Number.isSafeInteger(item.candidateIndex) ||
      (item.candidateIndex as number) < 0 ||
      (item.candidateIndex as number) >= expected.candidateCount ||
      seen.has(item.candidateIndex as number) ||
      !isStableToken(item.objectId)
    ) {
      return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
    }
    seen.add(item.candidateIndex as number);
    items.push({
      candidateIndex: item.candidateIndex as number,
      objectId: item.objectId,
    });
  }
  return {
    response: {
      abiVersion: HOST_PATH_POSIX_ABI_VERSION,
      capabilityDigest: expected.capabilityDigest,
      captureNonce: expected.captureNonce,
      items,
      platform: expected.platform,
      protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
      rootObjectId: value.rootObjectId,
      status: "complete",
      volumeId: value.volumeId,
    },
    status: "accepted",
  };
}

/** failed 响应仍必须绑定同一 capability、平台与 nonce。 */
function validateFailedCaptureResponse(
  value: Record<string, unknown>,
  expected: {
    candidateCount: number;
    capabilityDigest: string;
    captureNonce: string;
    platform: HostPathPosixPlatformV1;
  },
):
  | { response: HostPathPosixFailedCaptureResponseV1; status: "accepted" }
  | { reason: "CAPABILITY_BINDING_MISMATCH" | "CAPTURE_RESPONSE_INVALID"; status: "rejected" } {
  if (!hasExactKeys(value, [
    "abiVersion",
    "capabilityDigest",
    "captureNonce",
    "failClosedReason",
    "platform",
    "protocolVersion",
    "retryable",
    "status",
  ])) {
    return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
  }
  if (!responseEnvelopeMatches(value, expected)) {
    return { reason: "CAPABILITY_BINDING_MISMATCH", status: "rejected" };
  }
  if (
    !isCaptureFailureReason(value.failClosedReason) ||
    typeof value.retryable !== "boolean"
  ) {
    return { reason: "CAPTURE_RESPONSE_INVALID", status: "rejected" };
  }
  return {
    response: {
      abiVersion: HOST_PATH_POSIX_ABI_VERSION,
      capabilityDigest: expected.capabilityDigest,
      captureNonce: expected.captureNonce,
      failClosedReason: value.failClosedReason,
      platform: expected.platform,
      protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
      retryable: value.retryable,
      status: "failed",
    },
    status: "accepted",
  };
}

/** 响应 envelope 必须与本次协商和请求完全相等。 */
function responseEnvelopeMatches(
  value: Record<string, unknown>,
  expected: {
    capabilityDigest: string;
    captureNonce: string;
    platform: HostPathPosixPlatformV1;
  },
): boolean {
  return value.protocolVersion === HOST_PATH_POSIX_PROTOCOL_VERSION &&
    value.abiVersion === HOST_PATH_POSIX_ABI_VERSION &&
    value.platform === expected.platform &&
    value.capabilityDigest === expected.capabilityDigest &&
    value.captureNonce === expected.captureNonce;
}

/** 捕获失败原因必须来自封闭词汇。 */
function isCaptureFailureReason(value: unknown): value is HostPathPosixCaptureFailureReasonV1 {
  return value === "CAPABILITY_REVOKED" ||
    value === "CAPTURE_CHANGED" ||
    value === "LOGICAL_MAPPING_MISMATCH" ||
    value === "PATH_MISSING" ||
    value === "PATH_OUTSIDE_ROOT" ||
    value === "PATH_UNREADABLE" ||
    value === "PRIVILEGE_LOST" ||
    value === "PROVIDER_ERROR" ||
    value === "VOLUME_MISMATCH";
}

/** 身份排序禁止依赖区域设置。 */
function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
