import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInstalledLinuxSnapshotHelperBindingV1,
  createLinuxSnapshotHelperCapabilityV1,
  isLinuxSnapshotFilesystemSupportedV1,
  LINUX_HELPER_INSTALL_PATHS_V1,
  LinuxSnapshotHelperInitializationError,
} from "../../packages/adapters/host-path-posix-native/src/linux-helper.js";
import {
  validateHostPathPosixCapabilityV1,
  type HostPathPosixTrustedProvenanceV1,
} from "../../packages/adapters/host-path-posix-native/src/capability.js";
import type { HostPathPosixNativeProviderV1 } from
  "../../packages/adapters/host-path-posix-native/src/protocol.js";
import { createProductionHostPathIdentityComposition } from
  "../../apps/graph-service/src/index.js";

const binarySha256 = "a".repeat(64);
const trusted: HostPathPosixTrustedProvenanceV1 = {
  authorityKind: "privileged-helper",
  binarySha256,
  entitlement: "linux-filesystem-snapshot",
  platform: "linux",
  primitiveKind: "filesystem-snapshot",
  providerId: "codegraph-linux-snapshot-helper-v1",
  provenanceKind: "signed-privileged-helper",
  signerId: "codegraph-release-key-1",
};

/** 构造与 production adapter 相同 capability/response 形状的确定性 Linux binding。 */
function createLinuxBinding() {
  const provider: HostPathPosixNativeProviderV1 = {
    getCapability: async () => createLinuxSnapshotHelperCapabilityV1({
      binarySha256,
      signerId: trusted.signerId,
    }),
    capture: async (request) => ({
      abiVersion: request.abiVersion,
      capabilityDigest: request.capabilityDigest,
      captureNonce: request.captureNonce,
      items: request.candidates.map(({ candidateIndex }) => ({
        candidateIndex,
        objectId: `linux-object-${candidateIndex}`,
      })),
      platform: "linux",
      protocolVersion: request.protocolVersion,
      rootObjectId: "linux-root-object",
      status: "complete",
      volumeId: "linux-volume-object",
    }),
  };
  return { provider, trustedProvenance: [trusted] } as const;
}

describe("Linux snapshot helper capability", () => {
  it("只签发既有 strict strong snapshot capability", () => {
    const capability = createLinuxSnapshotHelperCapabilityV1({
      binarySha256,
      signerId: trusted.signerId,
    });

    expect(validateHostPathPosixCapabilityV1(capability, {
      platform: "linux",
      trustedProvenance: [trusted],
    }).status).toBe("accepted");
    expect(capability).toMatchObject({
      authority: {
        kind: "privileged-helper",
        providerId: "codegraph-linux-snapshot-helper-v1",
      },
      fence: { lifetime: "capture", namespace: "complete", strength: "strong" },
      primitiveKind: "filesystem-snapshot",
      supportScope: {
        candidateSet: "complete-request-batch",
        root: "indexing-root",
        volume: "native-fixed-volume",
      },
    });
  });

  it.each([
    ["btrfs", true],
    ["zfs", true],
    ["lvm", true],
    ["ext4", false],
    ["xfs", false],
    ["overlayfs", false],
    ["nfs", false],
    ["fuse", false],
    ["unknown", false],
  ])("对 %s 保持 snapshot-only allowlist=%s", (fileSystem, expected) => {
    expect(isLinuxSnapshotFilesystemSupportedV1(fileSystem)).toBe(expected);
  });

  it("从签名安装材料创建真实 Linux binding 并拒绝 bridge 摘要漂移", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bridgeBytes = Buffer.from("signed-linux-bridge", "utf8");
    const bridgeBinarySha256 = createHash("sha256").update(bridgeBytes).digest("hex");
    const payload = {
      bridgeBinarySha256,
      daemonBinarySha256: "b".repeat(64),
      schemaVersion: 2,
      signatureKeyId: "codegraph-linux-release-1",
      signerId: trusted.signerId,
    } as const;
    const canonicalPayload = JSON.stringify(payload);
    const provenance = `${JSON.stringify({
      bridgeBinarySha256: payload.bridgeBinarySha256,
      daemonBinarySha256: payload.daemonBinarySha256,
      manifestSha256: createHash("sha256").update(canonicalPayload).digest("hex"),
      schemaVersion: payload.schemaVersion,
      signature: sign(null, Buffer.from(canonicalPayload), privateKey).toString("hex"),
      signatureKeyId: payload.signatureKeyId,
      signerId: payload.signerId,
    })}\n`;
    const publicKeyBytes = (publicKey.export({ format: "der", type: "spki" }) as Buffer)
      .subarray(-32);
    const readBytes = async (filePath: string): Promise<Buffer> => {
      switch (filePath) {
        case LINUX_HELPER_INSTALL_PATHS_V1.bridgeExecutable:
          return bridgeBytes;
        case LINUX_HELPER_INSTALL_PATHS_V1.provenancePath:
          return Buffer.from(provenance, "utf8");
        case LINUX_HELPER_INSTALL_PATHS_V1.publicKeyPath:
          return Buffer.from(`${publicKeyBytes.toString("hex")}\n`, "utf8");
        default:
          throw new Error("测试读取了未授权安装路径。");
      }
    };
    const binding = await createInstalledLinuxSnapshotHelperBindingV1({
      ensureAccess: async () => undefined,
      platform: "linux",
      readBytes,
    });
    await expect(binding.provider.getCapability()).resolves.toMatchObject({
      platform: "linux",
      provenance: { binarySha256: bridgeBinarySha256 },
      status: "available",
    });
    expect(binding.trustedProvenance).toEqual([{
      ...trusted,
      binarySha256: bridgeBinarySha256,
    }]);

    await expect(createInstalledLinuxSnapshotHelperBindingV1({
      ensureAccess: async () => undefined,
      platform: "linux",
      readBytes: async (filePath) =>
        filePath === LINUX_HELPER_INSTALL_PATHS_V1.bridgeExecutable
          ? Buffer.from("replaced-linux-bridge", "utf8")
          : readBytes(filePath),
    })).rejects.toBeInstanceOf(LinuxSnapshotHelperInitializationError);
  });

  it("Linux production composition 注入真实 binding，初始化失败时拒绝启动", async () => {
    const loadInstalledLinuxBinding = async () => createLinuxBinding();
    const composition = await createProductionHostPathIdentityComposition({
      caseSensitiveFileNames: false,
      loadInstalledLinuxBinding,
      platform: "linux",
    });
    await expect(composition.snapshotProvider.capture({
      candidates: [{
        absolutePath: "/repo/a.ts",
        candidateIndex: 0,
        logicalPath: "a.ts",
        trustedPath: "/repo/a.ts",
      }],
      captureNonce: "linux-composition-capture",
      indexingRoot: "/repo",
      platform: "linux",
    })).resolves.toMatchObject({ status: "complete" });

    await expect(createProductionHostPathIdentityComposition({
      caseSensitiveFileNames: false,
      loadInstalledLinuxBinding: async () => {
        throw new LinuxSnapshotHelperInitializationError();
      },
      platform: "linux",
    })).rejects.toBeInstanceOf(LinuxSnapshotHelperInitializationError);
  });

  it("Darwin 没有真实 binding 时稳定 fail closed，且不会调用 Linux loader", async () => {
    let linuxLoaderCalls = 0;
    const composition = await createProductionHostPathIdentityComposition({
      caseSensitiveFileNames: false,
      loadInstalledLinuxBinding: async () => {
        linuxLoaderCalls += 1;
        return createLinuxBinding();
      },
      platform: "darwin",
    });
    await expect(composition.snapshotProvider.capture({
      candidates: [],
      captureNonce: "darwin-composition-capture",
      indexingRoot: "/repo",
      platform: "darwin",
    })).resolves.toEqual({
      code: "HOST_PATH_POSIX_CAPABILITY_MISSING",
      retryable: false,
      status: "unsupported",
    });
    expect(linuxLoaderCalls).toBe(0);
  });

  it("Win32 production composition 保留 service-scoped helper capture 与 close", async () => {
    let captureCalls = 0;
    let closeCalls = 0;
    const composition = await createProductionHostPathIdentityComposition({
      caseSensitiveFileNames: false,
      createWin32Helper: () => ({
        capture: async (request) => {
          captureCalls += 1;
          return {
            capability: {
              caseSensitiveFileNames: false,
              fileIdInfo: true,
              fileSystemType: "NTFS",
              fixedVolume: true,
              snapshotFence: "non-delete-shared-handle-lease-v1",
            },
            captureNonce: request.captureNonce,
            items: [],
            rootObjectId: "win32-root-object",
            status: "complete",
            volumeId: "win32-volume-object",
          };
        },
        close: async () => {
          closeCalls += 1;
        },
        readDiagnostics: () => ({
          pendingRequests: 0,
          processRunning: false,
          processStarts: 0,
        }),
      }),
      platform: "win32",
    });
    await expect(composition.snapshotProvider.capture({
      candidates: [],
      captureNonce: "win32-composition-capture",
      indexingRoot: "C:\\repo",
      platform: "win32",
    })).resolves.toMatchObject({ status: "complete" });
    await composition.closeHostPathIdentityHelper?.();
    expect({ captureCalls, closeCalls }).toEqual({ captureCalls: 1, closeCalls: 1 });
  });
});
