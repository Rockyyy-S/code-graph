import { describe, expect, it, vi } from "vitest";
import {
  createDefaultHostPathIdentitySnapshotProvider,
} from "../../apps/graph-service/src/host-path-identity.js";
import {
  captureHostPathPosixNativeV1,
  HOST_PATH_POSIX_ABI_VERSION,
  HOST_PATH_POSIX_PROTOCOL_VERSION,
  isValidatedHostPathPosixCapabilityV1,
  validateHostPathPosixCapabilityV1,
  type HostPathPosixCapabilityV1,
  type HostPathPosixNativeProviderV1,
  type HostPathPosixTrustedProvenanceV1,
} from "../../packages/adapters/host-path-posix-native/src/index.js";

const binarySha256 = "a".repeat(64);

const linuxFreezeCapability: HostPathPosixCapabilityV1 = {
  abiVersion: HOST_PATH_POSIX_ABI_VERSION,
  authority: {
    kind: "privileged-helper",
    providerId: "codegraph-linux-freeze-helper",
  },
  failClosedReason: null,
  fence: {
    lifetime: "capture",
    namespace: "complete",
    strength: "strong",
  },
  platform: "linux",
  primitiveKind: "filesystem-freeze",
  protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
  provenance: {
    binarySha256,
    entitlement: "linux-cap-sys-admin",
    kind: "signed-privileged-helper",
    signerId: "codegraph-release-key-1",
  },
  status: "available",
  supportScope: {
    candidateSet: "complete-request-batch",
    root: "indexing-root",
    volume: "native-fixed-volume",
  },
};

const trustedLinuxFreeze: HostPathPosixTrustedProvenanceV1 = {
  authorityKind: "privileged-helper",
  binarySha256,
  entitlement: "linux-cap-sys-admin",
  platform: "linux",
  primitiveKind: "filesystem-freeze",
  providerId: "codegraph-linux-freeze-helper",
  provenanceKind: "signed-privileged-helper",
  signerId: "codegraph-release-key-1",
};

/** 复制 capability，便于构造不污染共享夹具的负向输入。 */
function copyCapability(): HostPathPosixCapabilityV1 {
  return structuredClone(linuxFreezeCapability);
}

/** 创建只表达协议未来可接入性的确定性 provider，不调用任何宿主原语。 */
function createProtocolOnlyProvider(
  capability: unknown = copyCapability(),
): HostPathPosixNativeProviderV1 {
  return {
    getCapability: vi.fn(async () => capability),
    capture: vi.fn<HostPathPosixNativeProviderV1["capture"]>(async (request) => ({
      abiVersion: request.abiVersion,
      capabilityDigest: request.capabilityDigest,
      captureNonce: request.captureNonce,
      items: request.candidates.map((candidate) => ({
        candidateIndex: candidate.candidateIndex,
        objectId: `posix-object-${candidate.candidateIndex}`,
      })),
      platform: request.platform,
      protocolVersion: request.protocolVersion,
      rootObjectId: "posix-root-object-1",
      status: "complete",
      volumeId: "posix-volume-object-1",
    })),
  };
}

describe("host-path POSIX native capability contract", () => {
  it("fails closed when the default POSIX composition root has no native binding", async () => {
    const provider = createDefaultHostPathIdentitySnapshotProvider({
      caseSensitiveFileNames: false,
      platform: "linux",
    });

    await expect(provider.capture({
      candidates: [],
      captureNonce: "capture-nonce-default-posix",
      indexingRoot: "/repo",
      platform: "linux",
    })).resolves.toEqual({
      code: "HOST_PATH_POSIX_CAPABILITY_MISSING",
      retryable: false,
      status: "unsupported",
    });
  });

  it("accepts only an allowlisted future strong primitive structure", () => {
    const result = validateHostPathPosixCapabilityV1(copyCapability(), {
      platform: "linux",
      trustedProvenance: [trustedLinuxFreeze],
    });

    expect(result.status).toBe("accepted");
    if (result.status === "accepted") {
      expect(isValidatedHostPathPosixCapabilityV1(result.validated)).toBe(true);
      expect(result.validated.capabilityDigest).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it.each([
    ["missing", undefined, "CAPABILITY_MISSING"],
    ["unknown top-level field", { ...copyCapability(), unexpected: true }, "CAPABILITY_SHAPE_INVALID"],
    ["unknown primitive", { ...copyCapability(), primitiveKind: "fanotify-batch-fence" }, "CAPABILITY_SHAPE_INVALID"],
    ["caller-reported fixedVolume", { ...copyCapability(), fixedVolume: true }, "CAPABILITY_SHAPE_INVALID"],
    ["caller-reported batchFence", { ...copyCapability(), batchFence: true }, "CAPABILITY_SHAPE_INVALID"],
    ["protocol mismatch", { ...copyCapability(), protocolVersion: 2 }, "PROTOCOL_VERSION_INCOMPATIBLE"],
    ["ABI mismatch", { ...copyCapability(), abiVersion: 2 }, "ABI_VERSION_INCOMPATIBLE"],
    ["platform mismatch", { ...copyCapability(), platform: "darwin" }, "PLATFORM_MISMATCH"],
    ["missing authority", (({ authority: _authority, ...rest }) => rest)(copyCapability()), "PRIVILEGED_PROVENANCE_REQUIRED"],
    ["missing provenance", (({ provenance: _provenance, ...rest }) => rest)(copyCapability()), "PRIVILEGED_PROVENANCE_REQUIRED"],
  ] as const)("rejects %s", (_label, capability, reason) => {
    expect(validateHostPathPosixCapabilityV1(capability, {
      platform: "linux",
      trustedProvenance: [trustedLinuxFreeze],
    })).toEqual({ reason, status: "rejected" });
  });

  it("rejects watcher-only capability even when it forges strong/complete fields", () => {
    const capability = copyCapability();
    capability.primitiveKind = "watcher-conservative-invalidation";

    expect(validateHostPathPosixCapabilityV1(capability, {
      platform: "linux",
      trustedProvenance: [{
        ...trustedLinuxFreeze,
        primitiveKind: "watcher-conservative-invalidation",
      }],
    })).toEqual({ reason: "WATCHER_ONLY", status: "rejected" });
  });

  it("rejects non-strong fence and incomplete support scope", () => {
    const weakFence = copyCapability();
    weakFence.fence = {
      lifetime: "event-stream",
      namespace: "none",
      strength: "conservative-invalidation",
    };
    expect(validateHostPathPosixCapabilityV1(weakFence, {
      platform: "linux",
      trustedProvenance: [trustedLinuxFreeze],
    })).toEqual({ reason: "FENCE_NOT_STRONG", status: "rejected" });

    const incompleteScope = copyCapability();
    incompleteScope.supportScope = {
      candidateSet: "observed-events",
      root: "indexing-root",
      volume: "unknown",
    };
    expect(validateHostPathPosixCapabilityV1(incompleteScope, {
      platform: "linux",
      trustedProvenance: [trustedLinuxFreeze],
    })).toEqual({ reason: "SUPPORT_SCOPE_INCOMPLETE", status: "rejected" });
  });

  it("rejects missing or non-allowlisted privileged provenance", () => {
    expect(validateHostPathPosixCapabilityV1(copyCapability(), {
      platform: "linux",
      trustedProvenance: [],
    })).toEqual({ reason: "PROVENANCE_NOT_ALLOWLISTED", status: "rejected" });

    expect(validateHostPathPosixCapabilityV1(copyCapability(), {
      platform: "linux",
      trustedProvenance: [{
        ...trustedLinuxFreeze,
        signerId: "untrusted-release-key",
      }],
    })).toEqual({ reason: "PROVENANCE_NOT_ALLOWLISTED", status: "rejected" });
  });

  it("binds capture to the negotiated protocol, ABI, platform, nonce and capability digest", async () => {
    const provider = createProtocolOnlyProvider();
    const result = await captureHostPathPosixNativeV1({
      binding: {
        provider,
        trustedProvenance: [trustedLinuxFreeze],
      },
      candidates: [{
        absolutePath: "/repo/A.ts",
        candidateIndex: 0,
        logicalPath: "a.ts",
        trustedPath: "/repo/a.ts",
      }],
      captureNonce: "capture-nonce-1",
      indexingRoot: "/repo",
      platform: "linux",
    });

    expect(result.status).toBe("complete");
    expect(provider.capture).toHaveBeenCalledTimes(1);
    expect(provider.capture).toHaveBeenCalledWith(expect.objectContaining({
      abiVersion: HOST_PATH_POSIX_ABI_VERSION,
      captureNonce: "capture-nonce-1",
      platform: "linux",
      protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
    }));
  });

  it("rejects forged complete responses with unknown fields or capability binding drift", async () => {
    for (const responseMutation of [
      (request: Parameters<HostPathPosixNativeProviderV1["capture"]>[0]) => ({
        abiVersion: request.abiVersion,
        capabilityDigest: request.capabilityDigest,
        captureNonce: request.captureNonce,
        items: [{ candidateIndex: 0, objectId: "posix-object-0" }],
        platform: request.platform,
        protocolVersion: request.protocolVersion,
        rootObjectId: "posix-root-object-1",
        status: "complete",
        unexpected: true,
        volumeId: "posix-volume-object-1",
      }),
      (request: Parameters<HostPathPosixNativeProviderV1["capture"]>[0]) => ({
        abiVersion: request.abiVersion,
        capabilityDigest: "b".repeat(64),
        captureNonce: request.captureNonce,
        items: [{ candidateIndex: 0, objectId: "posix-object-0" }],
        platform: request.platform,
        protocolVersion: request.protocolVersion,
        rootObjectId: "posix-root-object-1",
        status: "complete",
        volumeId: "posix-volume-object-1",
      }),
    ]) {
      const provider = createProtocolOnlyProvider();
      provider.capture = vi.fn(async (request) => responseMutation(request));
      const result = await captureHostPathPosixNativeV1({
        binding: { provider, trustedProvenance: [trustedLinuxFreeze] },
        candidates: [{
          absolutePath: "/repo/a.ts",
          candidateIndex: 0,
          logicalPath: "a.ts",
          trustedPath: "/repo/a.ts",
        }],
        captureNonce: "capture-nonce-2",
        indexingRoot: "/repo",
        platform: "linux",
      });
      expect(result.status).toBe("rejected");
    }
  });
});
