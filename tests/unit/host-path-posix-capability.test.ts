import { describe, expect, it } from "vitest";
import {
  createLinuxSnapshotHelperCapabilityV1,
  isLinuxSnapshotFilesystemSupportedV1,
} from "../../packages/adapters/host-path-posix-native/src/linux-helper.js";
import {
  validateHostPathPosixCapabilityV1,
  type HostPathPosixTrustedProvenanceV1,
} from "../../packages/adapters/host-path-posix-native/src/capability.js";

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
});
