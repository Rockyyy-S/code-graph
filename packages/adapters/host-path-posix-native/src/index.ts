import {
  validateHostPathPosixCapabilityV1,
  type HostPathPosixTrustedProvenanceV1,
  type ValidatedHostPathPosixCapabilityV1,
} from "./capability.js";
import {
  HOST_PATH_POSIX_ABI_VERSION,
  HOST_PATH_POSIX_PROTOCOL_VERSION,
  validateHostPathPosixCaptureResponseV1,
  type HostPathPosixCaptureCandidateV1,
  type HostPathPosixCaptureFailureReasonV1,
  type HostPathPosixNativeProviderV1,
  type HostPathPosixPlatformV1,
  type HostPathPosixProtocolRejectionReasonV1,
} from "./protocol.js";

export * from "./capability.js";
export * from "./protocol.js";

/** 组合根注入的 provider 与外部可信 provenance allowlist。 */
export interface HostPathPosixNativeBindingV1 {
  provider: HostPathPosixNativeProviderV1;
  trustedProvenance: readonly HostPathPosixTrustedProvenanceV1[];
}

export type HostPathPosixNativeCaptureOutcomeV1 =
  | {
    capability: ValidatedHostPathPosixCapabilityV1;
    items: Array<{ candidateIndex: number; objectId: string }>;
    rootObjectId: string;
    status: "complete";
    volumeId: string;
  }
  | {
    failClosedReason: HostPathPosixCaptureFailureReasonV1;
    retryable: boolean;
    status: "failed";
  }
  | {
    reason: HostPathPosixProtocolRejectionReasonV1;
    status: "rejected";
  };

/**
 * 先校验 capability 与 provenance，再发送绑定版本、平台、nonce 与 capability digest 的请求。
 *
 * 本函数不实现任何原生强原语；provider 缺失、错版、伪造或响应漂移都在边界内拒绝。
 */
export async function captureHostPathPosixNativeV1(options: {
  binding: HostPathPosixNativeBindingV1;
  candidates: readonly HostPathPosixCaptureCandidateV1[];
  captureNonce: string;
  indexingRoot: string;
  platform: HostPathPosixPlatformV1;
}): Promise<HostPathPosixNativeCaptureOutcomeV1> {
  let rawCapability: unknown;
  try {
    rawCapability = await options.binding.provider.getCapability();
  } catch (error) {
    reportProviderCaptureFailure(error);
    return { reason: "PROVIDER_ERROR", status: "rejected" };
  }
  const capability = validateHostPathPosixCapabilityV1(rawCapability, {
    platform: options.platform,
    trustedProvenance: options.binding.trustedProvenance,
  });
  if (capability.status === "rejected") {
    return capability;
  }

  let rawResponse: unknown;
  try {
    rawResponse = await options.binding.provider.capture({
      abiVersion: HOST_PATH_POSIX_ABI_VERSION,
      candidates: options.candidates,
      capabilityDigest: capability.validated.capabilityDigest,
      captureNonce: options.captureNonce,
      indexingRoot: options.indexingRoot,
      platform: options.platform,
      protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
    });
  } catch (error) {
    reportProviderCaptureFailure(error);
    return { reason: "PROVIDER_ERROR", status: "rejected" };
  }

  const response = validateHostPathPosixCaptureResponseV1(rawResponse, {
    candidateCount: options.candidates.length,
    capabilityDigest: capability.validated.capabilityDigest,
    captureNonce: options.captureNonce,
    platform: options.platform,
  });
  if (response.status === "rejected") {
    return response;
  }
  if (response.response.status === "failed") {
    return {
      failClosedReason: response.response.failClosedReason,
      retryable: response.response.retryable,
      status: "failed",
    };
  }
  return {
    capability: capability.validated,
    items: response.response.items,
    rootObjectId: response.response.rootObjectId,
    status: "complete",
    volumeId: response.response.volumeId,
  };
}

/** 只记录 bridge 暴露的封闭错误码；其他异常统一隐藏为稳定占位符。 */
function reportProviderCaptureFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "";
  const match = /^Linux helper bridge 失败：([A-Z0-9_]{1,128})\s*$/u.exec(message);
  process.stderr.write(`[codegraph-linux-helper] bridge:${match?.[1] ?? "PROVIDER_EXCEPTION"}\n`);
}
