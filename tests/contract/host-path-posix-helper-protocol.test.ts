import { describe, expect, it } from "vitest";
import {
  LINUX_HELPER_ABI_VERSION,
  LINUX_HELPER_PROTOCOL_VERSION,
  createLinuxHelperBridgeInvocationV1,
  decodeLinuxHelperFrameV1,
  encodeLinuxHelperFrameV1,
  mapLinuxHelperBridgeResponseV1,
  validateLinuxHelperResponseEnvelopeV1,
} from "../../packages/adapters/host-path-posix-native/src/linux-helper.js";

const digest = "a".repeat(64);

describe("Linux HostPath helper protocol v1 / ABI v2", () => {
  it("使用大端长度前缀并拒绝非 canonical JSON", () => {
    const frame = encodeLinuxHelperFrameV1({ b: 2, a: 1 });

    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(frame.subarray(4).toString("utf8")).toBe('{"a":1,"b":2}');
    expect(decodeLinuxHelperFrameV1(frame)).toEqual({ a: 1, b: 2 });

    const nonCanonicalPayload = Buffer.from('{"b":2,"a":1}', "utf8");
    const nonCanonicalFrame = Buffer.allocUnsafe(4 + nonCanonicalPayload.length);
    nonCanonicalFrame.writeUInt32BE(nonCanonicalPayload.length, 0);
    nonCanonicalPayload.copy(nonCanonicalFrame, 4);
    expect(() => decodeLinuxHelperFrameV1(nonCanonicalFrame)).toThrow(/canonical/u);
  });

  it("将 bridge 固定为 shell:false、最小环境与真实继承 root FD", () => {
    const invocation = createLinuxHelperBridgeInvocationV1({
      bridgeExecutable: "/usr/libexec/codegraph-host-path-bridge",
      deadlineMs: 30_000,
      keyPath: "/etc/codegraph-host-path/client.key",
      provenancePath: "/usr/share/codegraph-host-path/provenance.json",
      publicKeyPath: "/usr/share/codegraph-host-path/release.pub",
      rootFd: 47,
      socketPath: "/run/codegraph-host-path/helper.sock",
    });

    expect(invocation).toEqual({
      args: [
        "capture-v1",
        "--socket",
        "/run/codegraph-host-path/helper.sock",
        "--key",
        "/etc/codegraph-host-path/client.key",
        "--provenance",
        "/usr/share/codegraph-host-path/provenance.json",
        "--public-key",
        "/usr/share/codegraph-host-path/release.pub",
        "--deadline-ms",
        "30000",
      ],
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/sbin:/usr/bin" },
      executable: "/usr/libexec/codegraph-host-path-bridge",
      shell: false,
      stdio: ["pipe", "pipe", "pipe", 47],
    });
  });

  it("严格绑定响应 envelope、snapshot fence 与安装 provenance", () => {
    const expected = {
      batchDigest: digest,
      bridgeBinarySha256: "d".repeat(64),
      capabilityDigest: "b".repeat(64),
      daemonEpoch: "epoch-1",
      nonce: "nonce-1",
      requestDigest: "c".repeat(64),
      requestId: "request-1",
      sequence: 7,
      signerId: "codegraph-release-key-1",
    } as const;
    const response = {
      abiVersion: LINUX_HELPER_ABI_VERSION,
      batchDigest: expected.batchDigest,
      capabilityDigest: expected.capabilityDigest,
      daemonEpoch: expected.daemonEpoch,
      items: [{ candidateIndex: 0, objectId: "8:1:100:9" }],
      nonce: expected.nonce,
      protocolVersion: LINUX_HELPER_PROTOCOL_VERSION,
      provenance: {
        bridgeBinarySha256: "d".repeat(64),
        daemonBinarySha256: "1".repeat(64),
        manifestSha256: "e".repeat(64),
        schemaVersion: 2,
        signatureKeyId: "codegraph-linux-release-1",
        signerId: "codegraph-release-key-1",
      },
      requestDigest: expected.requestDigest,
      requestId: expected.requestId,
      rootObjectId: "8:1:2:3",
      sequence: expected.sequence,
      snapshotFence: "btrfs:readonly:42",
      snapshotView: "btrfs:subvolume:42@snapshot-7",
      status: "complete",
      transcriptMac: "f".repeat(64),
      volumeId: "btrfs:11111111-1111-1111-1111-111111111111:42",
    };

    expect(validateLinuxHelperResponseEnvelopeV1(response, expected)).toEqual({
      response,
      status: "accepted",
    });
    expect(validateLinuxHelperResponseEnvelopeV1(
      { ...response, requestId: "request-2" },
      expected,
    )).toEqual({ reason: "RESPONSE_BINDING_MISMATCH", status: "rejected" });
    expect(validateLinuxHelperResponseEnvelopeV1(
      { ...response, unexpected: true },
      expected,
    )).toEqual({ reason: "RESPONSE_SHAPE_INVALID", status: "rejected" });
    expect(validateLinuxHelperResponseEnvelopeV1(
      {
        ...response,
        provenance: { ...response.provenance, bridgeBinarySha256: "0".repeat(64) },
      },
      expected,
    )).toEqual({ reason: "RESPONSE_BINDING_MISMATCH", status: "rejected" });
    expect(() => mapLinuxHelperBridgeResponseV1(
      response,
      {
        abiVersion: 1,
        candidates: [],
        capabilityDigest: expected.capabilityDigest,
        captureNonce: expected.nonce,
        indexingRoot: "/workspace",
        platform: "linux",
        protocolVersion: 1,
      },
      {
        abiVersion: LINUX_HELPER_ABI_VERSION,
        batchDigest: expected.batchDigest,
        candidates: [],
        capabilityDigest: expected.capabilityDigest,
        nonce: expected.nonce,
        protocolVersion: LINUX_HELPER_PROTOCOL_VERSION,
        requestDigest: "9".repeat(64),
        requestId: expected.requestId,
      },
      {
        bridgeBinarySha256: expected.bridgeBinarySha256,
        bridgeExecutable: "/usr/libexec/codegraph-host-path-bridge",
        deadlineMs: 30_000,
        keyPath: "/etc/codegraph-host-path/client.key",
        provenancePath: "/usr/share/codegraph-host-path/provenance.json",
        publicKeyPath: "/usr/share/codegraph-host-path/release.pub",
        signerId: expected.signerId,
        socketPath: "/run/codegraph-host-path/helper.sock",
      },
    )).toThrow("Linux helper bridge 响应非法。");
  });

  it("只接受完整绑定的 authenticated failed envelope 并保留 retryable", () => {
    const expected = {
      batchDigest: digest,
      bridgeBinarySha256: "d".repeat(64),
      capabilityDigest: "b".repeat(64),
      daemonEpoch: "epoch-1",
      nonce: "nonce-1",
      requestDigest: "c".repeat(64),
      requestId: "request-1",
      sequence: 7,
      signerId: "codegraph-release-key-1",
    } as const;
    const failedResponse = {
      abiVersion: LINUX_HELPER_ABI_VERSION,
      batchDigest: expected.batchDigest,
      capabilityDigest: expected.capabilityDigest,
      daemonEpoch: expected.daemonEpoch,
      error: {
        class: "namespace-drift",
        code: "ROOT_CHANGED_DURING_FIRST_PASS",
        retryable: true,
      },
      items: [],
      nonce: expected.nonce,
      protocolVersion: LINUX_HELPER_PROTOCOL_VERSION,
      provenance: {
        bridgeBinarySha256: expected.bridgeBinarySha256,
        daemonBinarySha256: "1".repeat(64),
        manifestSha256: "e".repeat(64),
        schemaVersion: 2,
        signatureKeyId: "codegraph-linux-release-1",
        signerId: expected.signerId,
      },
      requestDigest: expected.requestDigest,
      requestId: expected.requestId,
      rootObjectId: null,
      sequence: expected.sequence,
      snapshotFence: "btrfs:readonly:42",
      snapshotView: "btrfs:subvolume:42@snapshot-7",
      status: "failed",
      transcriptMac: "f".repeat(64),
      volumeId: null,
    };

    expect(validateLinuxHelperResponseEnvelopeV1(failedResponse, expected)).toEqual({
      response: failedResponse,
      status: "accepted",
    });
    expect(validateLinuxHelperResponseEnvelopeV1(
      { ...failedResponse, requestId: "request-2" },
      expected,
    )).toEqual({ reason: "RESPONSE_BINDING_MISMATCH", status: "rejected" });
    expect(validateLinuxHelperResponseEnvelopeV1(
      { ...failedResponse, error: { ...failedResponse.error, retryable: "yes" } },
      expected,
    )).toEqual({ reason: "RESPONSE_SHAPE_INVALID", status: "rejected" });
    expect(validateLinuxHelperResponseEnvelopeV1(
      { ...failedResponse, error: { ...failedResponse.error, class: "unknown" } },
      expected,
    )).toEqual({ reason: "RESPONSE_SHAPE_INVALID", status: "rejected" });
    const request = {
      abiVersion: 1 as const,
      candidates: [],
      capabilityDigest: expected.capabilityDigest,
      captureNonce: expected.nonce,
      indexingRoot: "/workspace",
      platform: "linux" as const,
      protocolVersion: 1 as const,
    };
    const bridgeRequest = {
      abiVersion: LINUX_HELPER_ABI_VERSION,
      batchDigest: expected.batchDigest,
      candidates: [],
      capabilityDigest: expected.capabilityDigest,
      nonce: expected.nonce,
      protocolVersion: LINUX_HELPER_PROTOCOL_VERSION,
      requestDigest: expected.requestDigest,
      requestId: expected.requestId,
    };
    const options = {
      bridgeBinarySha256: expected.bridgeBinarySha256,
      bridgeExecutable: "/usr/libexec/codegraph-host-path-bridge",
      deadlineMs: 30_000,
      keyPath: "/etc/codegraph-host-path/client.key",
      provenancePath: "/usr/share/codegraph-host-path/provenance.json",
      publicKeyPath: "/usr/share/codegraph-host-path/release.pub",
      signerId: expected.signerId,
      socketPath: "/run/codegraph-host-path/helper.sock",
    };

    expect(() => mapLinuxHelperBridgeResponseV1(
      failedResponse,
      request,
      { ...bridgeRequest, requestDigest: "9".repeat(64) },
      options,
    )).toThrow("Linux helper bridge 响应非法。");
    for (const [error, failClosedReason] of [
      [failedResponse.error, "CAPTURE_CHANGED"],
      [{ class: "volume-drift", code: "VOLUME_BINDING_DRIFT", retryable: true }, "VOLUME_MISMATCH"],
      [{ class: "path-boundary", code: "PATH_MISSING", retryable: false }, "PATH_MISSING"],
      [{ class: "path-boundary", code: "PATH_UNREADABLE", retryable: false }, "PATH_UNREADABLE"],
      [{ class: "path-boundary", code: "LOGICAL_MAPPING_MISMATCH", retryable: false }, "LOGICAL_MAPPING_MISMATCH"],
      [{ class: "path-boundary", code: "PATH_CROSSES_MOUNT", retryable: false }, "PATH_OUTSIDE_ROOT"],
      [{ class: "snapshot", code: "COMMAND_NONZERO", retryable: true }, "PROVIDER_ERROR"],
    ] as const) {
      expect(mapLinuxHelperBridgeResponseV1(
        { ...failedResponse, error },
        request,
        bridgeRequest,
        options,
      )).toEqual({
        abiVersion: 1,
        capabilityDigest: expected.capabilityDigest,
        captureNonce: expected.nonce,
        failClosedReason,
        platform: "linux",
        protocolVersion: 1,
        retryable: error.retryable,
        status: "failed",
      });
    }
    for (const forgedError of [
      { ...failedResponse.error, retryable: "yes" },
      { ...failedResponse.error, class: "unknown" },
      { class: "authentication", code: "TRANSCRIPT_MAC_INVALID", retryable: true },
    ]) {
      expect(() => mapLinuxHelperBridgeResponseV1(
        { ...failedResponse, error: forgedError },
        request,
        bridgeRequest,
        options,
      )).toThrow("Linux helper bridge 响应非法。");
    }
  });
});
