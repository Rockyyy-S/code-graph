import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HostPathIdentityBroker,
  observeHostPathIdentity,
  type CompleteHostPathSnapshotV1,
  type FailedHostPathSnapshotV1,
  type HostPathIdentitySnapshotProvider,
  type HostPathSnapshotCapabilityV1,
  type HostPathSnapshotCandidateV1,
} from "../../apps/graph-service/src/host-path-identity.js";
import { validateHostPathIdentitySource } from "../../scripts/ci/verify-host-path-identity-v1.mjs";

interface FakeHostObject {
  objectId: string;
  volumeId?: string;
}

interface FakeSnapshotProvider {
  capture: ReturnType<typeof vi.fn<HostPathIdentitySnapshotProvider["capture"]>>;
  objects: Map<string, FakeHostObject>;
  provider: HostPathIdentitySnapshotProvider;
  setFailure(failure: FailedHostPathSnapshotV1 | null): void;
}

const supportedCapability: HostPathSnapshotCapabilityV1 = {
  fileIdInfo: true,
  fileSystemType: "NTFS",
  fixedVolume: true,
  snapshotFence: "non-delete-shared-handle-lease-v1",
};

/** 构造显式 FILE_ID_INFO 与句柄租约能力的确定性原生边界。 */
function createFakeSnapshotProvider(
  initial: Record<string, FakeHostObject>,
  capability: HostPathSnapshotCapabilityV1 = supportedCapability,
): FakeSnapshotProvider {
  const objects = new Map(Object.entries(initial));
  let nextFailure: FailedHostPathSnapshotV1 | null = null;
  const capture = vi.fn<HostPathIdentitySnapshotProvider["capture"]>(async (request) => {
    if (nextFailure !== null) {
      const failure = nextFailure;
      nextFailure = null;
      return failure;
    }
    const root = objects.get(request.indexingRoot);
    if (root === undefined) {
      return { code: "ENOENT", retryable: true, status: "missing" };
    }
    const items: CompleteHostPathSnapshotV1["items"] = [];
    for (const candidate of request.candidates) {
      const trusted = objects.get(candidate.trustedPath);
      const asserted = objects.get(candidate.absolutePath);
      if (trusted === undefined || asserted === undefined) {
        return { code: "ENOENT", retryable: true, status: "missing" };
      }
      if ((trusted.volumeId ?? "volume-a") !== (root.volumeId ?? "volume-a")) {
        return {
          code: "HOST_PATH_VOLUME_MISMATCH",
          retryable: false,
          status: "unsupported",
        };
      }
      if (trusted.objectId !== asserted.objectId) {
        return {
          code: "HOST_PATH_LOGICAL_MAPPING_MISMATCH",
          retryable: false,
          status: "unsupported",
        };
      }
      items.push({
        candidateIndex: candidate.candidateIndex,
        objectId: trusted.objectId,
      });
    }
    return {
      capability,
      captureNonce: request.captureNonce,
      items,
      rootObjectId: root.objectId,
      status: "complete",
      volumeId: root.volumeId ?? "volume-a",
    };
  });
  return {
    capture,
    objects,
    provider: { capture },
    setFailure: (failure) => {
      nextFailure = failure;
    },
  };
}

/** 创建绑定 `/repo` 的 broker。 */
function createPosixBroker(
  fake: FakeSnapshotProvider,
  options: Record<string, number> = {},
): HostPathIdentityBroker {
  return new HostPathIdentityBroker({
    indexingRoot: "/repo",
    platform: "linux",
    snapshotProvider: fake.provider,
    ...options,
  });
}

/** 提供 root 与两个普通文件。 */
function createBasicFake(): FakeSnapshotProvider {
  return createFakeSnapshotProvider({
    "/repo": { objectId: "root-object-0001" },
    "/repo/a.ts": { objectId: "file-object-0010" },
    "/repo/b.ts": { objectId: "file-object-0011" },
  });
}

describe("host path identity broker", () => {
  it("uses positive dependency closure checks and rejects fixed mutation oracles", () => {
    const source = readFileSync(
      new URL("../../apps/graph-service/src/host-path-identity.ts", import.meta.url),
      "utf8",
    );
    expect(() => validateHostPathIdentitySource(
      source,
      "apps/graph-service/src/host-path-identity.ts",
    )).not.toThrow();

    for (const mutation of [
      `const member = ["to", "LowerCase"].join(""); export const folded = "A"[member]();`,
      `import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./helper.cjs");`,
      `export const folded = Reflect.apply(String.prototype.toLowerCase, "A", []);`,
      `import helper = require("./helper.cjs"); export { helper };`,
      `import vm from "node:vm"; export const value = vm.runInNewContext("identity()");`,
      `export const value = eval("identity()");`,
      `export const value = Function("return identity()")();`,
      `import { identity } from "./helper.js"; export { identity };`,
      `export const value = (entry: { birthtimeNs: bigint }) => entry.birthtimeNs;`,
    ]) {
      expect(() => validateHostPathIdentitySource(
        `${source}\n${mutation}\n`,
        "mutation.ts",
      )).toThrow();
    }
  });

  it("groups hardlinks only when they coexist in one native handle snapshot", async () => {
    const fake = createFakeSnapshotProvider({
      "/repo": { objectId: "root-object-0001" },
      "/repo/a.ts": { objectId: "file-object-0010" },
      "/repo/hardlink.ts": { objectId: "file-object-0010" },
    });
    const proof = await createPosixBroker(fake).resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/hardlink.ts", logicalPath: "hardlink.ts" },
    ]);

    expect(proof.status).toBe("complete");
    expect(proof.aliasGroups).toHaveLength(1);
    expect(proof.aliasGroups[0]?.logicalPaths).toEqual(["a.ts", "hardlink.ts"]);
    expect(proof.entries.every(({ observation }) =>
      observation.status === "present" && observation.identityLifetime === "snapshot"
    )).toBe(true);
  });

  it("accepts Win32 root, intermediate and leaf casing aliases after object proof", async () => {
    const root = "C:\\Users\\repo";
    const trustedPath = "C:\\Users\\repo\\src\\AliasFile.ts";
    const assertedPath = "C:\\USERS\\REPO\\SRC\\ALIASFILE.TS";
    const fake = createFakeSnapshotProvider({
      [root]: { objectId: "root-object-0001" },
      [trustedPath]: { objectId: "file-object-0010" },
      [assertedPath]: { objectId: "file-object-0010" },
    });
    const broker = new HostPathIdentityBroker({
      indexingRoot: root,
      platform: "win32",
      snapshotProvider: fake.provider,
    });

    const proof = await broker.resolveCandidates([
      { absolutePath: trustedPath, logicalPath: "src/AliasFile.ts" },
      { absolutePath: assertedPath, logicalPath: "src/AliasFile.ts" },
    ]);

    expect(proof.status).toBe("complete");
    expect(proof.entries).toHaveLength(1);
    expect(fake.capture).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct Unicode objects separate without string folding", async () => {
    const fake = createFakeSnapshotProvider({
      "/repo": { objectId: "root-object-0001" },
      "/repo/ẞ.ts": { objectId: "file-object-0010" },
      "/repo/ß.ts": { objectId: "file-object-0011" },
      "/repo/İ.ts": { objectId: "file-object-0012" },
      "/repo/i̇.ts": { objectId: "file-object-0013" },
    });
    const broker = createPosixBroker(fake);

    for (const [leftPath, rightPath] of [
      ["/repo/ẞ.ts", "/repo/ß.ts"],
      ["/repo/İ.ts", "/repo/i̇.ts"],
    ] as const) {
      expect(leftPath.toLowerCase()).toBe(rightPath.toLowerCase());
      const proof = await broker.resolveCandidates([
        { absolutePath: leftPath, logicalPath: leftPath.slice(6) },
        { absolutePath: rightPath, logicalPath: rightPath.slice(6) },
      ]);
      expect(proof.status).toBe("complete");
      expect(proof.aliasGroups).toHaveLength(2);
      expect(JSON.stringify(proof)).not.toContain("/repo/");
    }
  });

  it("rejects relative, device, UNC and ADS paths before native capture", async () => {
    const fake = createBasicFake();
    const broker = new HostPathIdentityBroker({
      indexingRoot: "C:\\repo",
      platform: "win32",
      snapshotProvider: fake.provider,
    });

    for (const absolutePath of [
      "relative.ts",
      "C:drive-relative.ts",
      "\\relative-to-drive-root.ts",
      "\\\\server\\share\\file.ts",
      "\\\\?\\C:\\repo\\device.ts",
      "\\\\.\\C:\\repo\\device.ts",
      "C:\\repo\\inside.ts:secret",
    ]) {
      const proof = await broker.resolveCandidates([
        { absolutePath, logicalPath: "candidate.ts" },
      ]);
      expect(proof.status).toBe("rejected");
      expect(proof.entries).toEqual([]);
    }
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("requires canonical relative POSIX logical paths", async () => {
    const fake = createBasicFake();
    const broker = createPosixBroker(fake);

    for (const logicalPath of [
      "/absolute.ts",
      "../escape.ts",
      "a/../b.ts",
      "./a.ts",
      "a\\b.ts",
      "a//b.ts",
      "e\u0301.ts",
    ]) {
      await expect(broker.resolveCandidates([
        { absolutePath: "/repo/a.ts", logicalPath },
      ])).resolves.toMatchObject({
        code: "HOST_PATH_CANDIDATE_INVALID",
        status: "rejected",
      });
    }
  });

  it("fails closed when FILE_ID_INFO or fixed NTFS handle fencing is not explicit", async () => {
    for (const capability of [
      { ...supportedCapability, fileIdInfo: false },
      { ...supportedCapability, fileSystemType: "exFAT" },
      { ...supportedCapability, fixedVolume: false },
      { ...supportedCapability, snapshotFence: "broker-generation" },
    ]) {
      const fake = createFakeSnapshotProvider({
        "/repo": { objectId: "root-object-0001" },
        "/repo/a.ts": { objectId: "file-object-0010" },
      }, capability);
      await expect(observeHostPathIdentity("/repo/a.ts", {
        indexingRoot: "/repo",
        platform: "linux",
        snapshotProvider: fake.provider,
      })).resolves.toMatchObject({
        code: "HOST_PATH_IDENTITY_UNSUPPORTED",
        retryable: false,
        status: "unsupported",
      });
    }
  });

  it.each(["ENAMETOOLONG", "EINVAL", "ENOSYS", "ENOTSUP"])(
    "preserves permanent host capability error %s as non-retryable unsupported",
    async (code) => {
      const fake = createBasicFake();
      fake.setFailure({ code, retryable: false, status: "unsupported" });
      await expect(observeHostPathIdentity("/repo/a.ts", {
        indexingRoot: "/repo",
        platform: "linux",
        snapshotProvider: fake.provider,
      })).resolves.toMatchObject({ code, retryable: false, status: "unsupported" });
    },
  );

  it("prioritizes native topology change over stable outside or volume classifications", async () => {
    const fake = createBasicFake();
    fake.setFailure({
      code: "HOST_PATH_CHANGED",
      retryable: true,
      status: "changed",
    });

    await expect(observeHostPathIdentity("/repo/a.ts", {
      indexingRoot: "/repo",
      platform: "linux",
      snapshotProvider: fake.provider,
    })).resolves.toMatchObject({
      code: "HOST_PATH_CHANGED",
      retryable: true,
      status: "changed",
    });
  });

  it("rejects indexing-root ABA reported by the pinned root ancestry lease", async () => {
    const fake = createBasicFake();
    fake.setFailure({
      code: "HOST_PATH_CHANGED",
      retryable: true,
      status: "changed",
    });
    const proof = await createPosixBroker(fake).resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
    ]);

    expect(proof.status).toBe("failed");
    expect(proof.aliasGroups).toEqual([]);
  });

  it("never manufactures an alias group from a sequential ABA schedule", async () => {
    const fake = createBasicFake();
    const simultaneousObjects = new Map(fake.objects);
    const capture = vi.fn<HostPathIdentitySnapshotProvider["capture"]>(async (request) => {
      const items = request.candidates.map((candidate) => ({
        candidateIndex: candidate.candidateIndex,
        objectId: simultaneousObjects.get(candidate.trustedPath)?.objectId ?? "missing",
      }));
      return {
        capability: supportedCapability,
        captureNonce: request.captureNonce,
        items,
        rootObjectId: "root-object-0001",
        status: "complete",
        volumeId: "volume-a",
      };
    });
    const broker = new HostPathIdentityBroker({
      indexingRoot: "/repo",
      platform: "linux",
      snapshotProvider: { capture },
    });

    const proof = await broker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/b.ts", logicalPath: "b.ts" },
    ]);

    expect(proof.status).toBe("complete");
    expect(proof.aliasGroups).toHaveLength(2);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("checks raw count and byte budgets before sorting or native capture", async () => {
    const fake = createBasicFake();
    const broker = createPosixBroker(fake, {
      maxAbsolutePathBytes: 32,
      maxBatchBytes: 48,
      maxCandidates: 2,
      maxLogicalPathBytes: 16,
    });
    const unread = vi.fn(() => {
      throw new Error("不应读取超限数组的元素。");
    });
    const overCount = [
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      Object.defineProperties({}, {
        absolutePath: { get: unread },
        logicalPath: { get: unread },
      }),
    ] as unknown as Array<{ absolutePath: string; logicalPath: string }>;

    await expect(broker.resolveCandidates(overCount)).resolves.toMatchObject({
      code: "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED",
      status: "rejected",
    });
    expect(unread).not.toHaveBeenCalled();
    expect(fake.capture).not.toHaveBeenCalled();

    const lateRead = vi.fn(() => {
      throw new Error("超过字节预算后不得继续读取后续候选。");
    });
    const overBytes = [
      Object.defineProperties({}, {
        absolutePath: { get: lateRead },
        logicalPath: { value: "logical-path-too-long.ts" },
      }),
    ] as unknown as Array<{ absolutePath: string; logicalPath: string }>;
    await expect(broker.resolveCandidates(overBytes)).resolves.toMatchObject({
      code: "HOST_PATH_LOGICAL_PATH_LIMIT_EXCEEDED",
      status: "rejected",
    });
    expect(lateRead).not.toHaveBeenCalled();
    expect(fake.capture).not.toHaveBeenCalled();
  });

  it("sorts unique logical paths while keeping broker generation separate from snapshot identity", async () => {
    const fake = createBasicFake();
    const broker = createPosixBroker(fake);
    const input = [
      { absolutePath: "/repo/b.ts", logicalPath: "b.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
    ];

    const first = await broker.resolveCandidates(input);
    const second = await broker.resolveCandidates([...input].reverse());
    expect(first.status).toBe("complete");
    expect(second.status).toBe("complete");
    expect(first.entries.map(({ logicalPath }) => logicalPath)).toEqual(["a.ts", "b.ts"]);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(first.snapshotIdentity).not.toBe(second.snapshotIdentity);
    expect(first.proofDigest).not.toBe(second.proofDigest);
    expect(JSON.stringify(first)).not.toContain("/repo/");
  });

  it("scopes identity to one proof so File ID reuse cannot inherit an old identity", async () => {
    const fake = createBasicFake();
    const broker = createPosixBroker(fake);
    const before = await broker.observe("/repo/a.ts");
    const replacement = await broker.observe("/repo/a.ts");
    if (before.observation.status !== "present" || replacement.observation.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }

    expect(before.observation.identityLifetime).toBe("snapshot");
    expect(replacement.observation.identity).not.toBe(before.observation.identity);
    expect(replacement.snapshotIdentity).not.toBe(before.snapshotIdentity);
  });

  it("rejects a logical path whose root-derived mapping names another object", async () => {
    const fake = createBasicFake();
    const proof = await createPosixBroker(fake).resolveCandidates([
      { absolutePath: "/repo/b.ts", logicalPath: "a.ts" },
    ]);

    expect(proof.status).toBe("failed");
    expect(proof.aliasGroups).toEqual([]);
    expect(proof.entries[0]?.observation).toMatchObject({
      code: "HOST_PATH_LOGICAL_MAPPING_MISMATCH",
      retryable: false,
      status: "unsupported",
    });
  });

  it("keeps missing, unreadable and unknown failures fail-closed", async () => {
    const cases: FailedHostPathSnapshotV1[] = [
      { code: "ENOENT", retryable: true, status: "missing" },
      { code: "EACCES", retryable: false, status: "unreadable" },
      { code: "EIO", retryable: true, status: "error" },
    ];
    for (const failure of cases) {
      const fake = createBasicFake();
      fake.setFailure(failure);
      await expect(observeHostPathIdentity("/repo/a.ts", {
        indexingRoot: "/repo",
        platform: "linux",
        snapshotProvider: fake.provider,
      })).resolves.toMatchObject(failure);
    }
  });

  it("fails closed on duplicate logical candidates that prove different objects", async () => {
    const capture = vi.fn<HostPathIdentitySnapshotProvider["capture"]>(async (request) => ({
      capability: supportedCapability,
      captureNonce: request.captureNonce,
      items: request.candidates.map((candidate, index) => ({
        candidateIndex: candidate.candidateIndex,
        objectId: `file-object-00${index + 10}`,
      })),
      rootObjectId: "root-object-0001",
      status: "complete",
      volumeId: "volume-a",
    }));
    const broker = new HostPathIdentityBroker({
      indexingRoot: "/repo",
      platform: "linux",
      snapshotProvider: { capture },
    });
    const proof = await broker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "same.ts" },
      { absolutePath: "/repo/b.ts", logicalPath: "same.ts" },
    ]);

    expect(proof.status).toBe("failed");
    expect(proof.entries[0]?.observation).toMatchObject({
      code: "HOST_PATH_LOGICAL_ALIAS_CONFLICT",
      retryable: false,
      status: "unsupported",
    });
  });

  it("sends only root-derived trusted paths to the native provider", async () => {
    const fake = createBasicFake();
    await createPosixBroker(fake).resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
    ]);

    const request = fake.capture.mock.calls[0]?.[0];
    expect(request?.candidates).toEqual([
      {
        absolutePath: "/repo/a.ts",
        candidateIndex: 0,
        logicalPath: "a.ts",
        trustedPath: "/repo/a.ts",
      } satisfies HostPathSnapshotCandidateV1,
    ]);
  });
});
