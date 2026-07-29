import { describe, expect, it, vi } from "vitest";
import {
  HostPathIdentityBroker,
  observeHostPathIdentity,
  type HostPathIdentityFileSystem,
  type HostPathIdentityStat,
} from "../../apps/graph-service/src/host-path-identity.js";
import { validateHostPathIdentitySource } from "../../scripts/ci/verify-host-path-identity-v1.mjs";

interface FakeFileRecord {
  canonicalPath: string;
  closeHook?: () => void;
  dev: bigint;
  ino: bigint;
  kind?: "directory" | "file" | "symbolic-link";
  openError?: string;
}

/** 创建带稳定错误码的宿主错误，供 fail-closed 分支精确断言。 */
function createHostError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** 把测试记录投影为 broker 只允许读取的文件状态。 */
function toStat(record: FakeFileRecord): HostPathIdentityStat {
  const kind = record.kind ?? "file";
  return {
    birthtimeNs: 1n,
    dev: record.dev,
    ino: record.ino,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symbolic-link",
  } as HostPathIdentityStat;
}

/** 构造可变文件系统，使测试能表达 root、rename、替换与拓扑竞态。 */
function createFakeFileSystem(initial: Record<string, FakeFileRecord>) {
  const records = new Map(Object.entries(initial));
  const lstat = vi.fn(async (input: string) => {
    const record = records.get(input);
    if (record === undefined) {
      throw createHostError("ENOENT");
    }
    return toStat(record);
  });
  const open = vi.fn(async (input: string) => {
    const record = records.get(input);
    if (record === undefined) {
      throw createHostError("ENOENT");
    }
    if (record.openError !== undefined) {
      throw createHostError(record.openError);
    }
    return {
      close: vi.fn(async () => record.closeHook?.()),
      stat: async () => toStat(record),
    };
  });
  const realpath = vi.fn(async (input: string) => {
    const record = records.get(input);
    if (record === undefined) {
      throw createHostError("ENOENT");
    }
    return record.canonicalPath;
  });
  const fileSystem: HostPathIdentityFileSystem = { lstat, open, realpath };
  return { fileSystem, lstat, open, realpath, records };
}

/** 创建绑定 `/repo` 的 POSIX broker，避免测试从宿主 Windows 路径语义借力。 */
function createPosixBroker(
  fake: ReturnType<typeof createFakeFileSystem>,
  options: Record<string, number> = {},
): HostPathIdentityBroker {
  return new HostPathIdentityBroker({
    fileSystem: fake.fileSystem,
    indexingRoot: "/repo",
    platform: "linux",
    ...options,
  });
}

/** 提供可证明的 indexing root 与两个普通文件。 */
function createBasicFake() {
  return createFakeFileSystem({
    "/repo": {
      canonicalPath: "/repo",
      dev: 1n,
      ino: 1n,
      kind: "directory",
    },
    "/repo/a.ts": { canonicalPath: "/repo/a.ts", dev: 1n, ino: 10n },
    "/repo/b.ts": { canonicalPath: "/repo/b.ts", dev: 1n, ino: 11n },
  });
}

describe("host path identity broker", () => {
  it("uses AST auxiliary checks that ignore comments and reject dead, computed or imported bypasses", () => {
    expect(() => validateHostPathIdentitySource(`
      import { createHash } from "node:crypto";
      // 注释中的 toLowerCase、birthtimeNs 与 ẞ 不构成实现能力。
      export const identity = createHash("sha256");
    `, "comment-only.ts")).not.toThrow();

    for (const mutation of [
      `if (false) { "A"["to" + "LowerCase"](); }`,
      `import { identity } from "./hidden-helper.js"; export { identity };`,
      `const proof = { birthtimeNs: 1n }; export { proof };`,
      `const unicodeExceptions = ["ẞ"]; export { unicodeExceptions };`,
    ]) {
      expect(() => validateHostPathIdentitySource(mutation, "mutation.ts")).toThrow();
    }
  });

  it("returns one opaque identity for ASCII casing aliases and hardlinks of one opened file", async () => {
    const canonicalPath = "C:\\repo\\AliasFile.ts";
    const fake = createFakeFileSystem({
      "C:\\repo": {
        canonicalPath: "C:\\repo",
        dev: 7n,
        ino: 1n,
        kind: "directory",
      },
      "C:\\repo\\ALIASFILE.TS": { canonicalPath, dev: 7n, ino: 11n },
      "C:\\repo\\AliasFile.ts": { canonicalPath, dev: 7n, ino: 11n },
      "C:\\repo\\HardLink.ts": {
        canonicalPath: "C:\\repo\\HardLink.ts",
        dev: 7n,
        ino: 11n,
      },
    });
    const broker = new HostPathIdentityBroker({
      fileSystem: fake.fileSystem,
      indexingRoot: "C:\\repo",
      platform: "win32",
    });

    const canonical = await broker.observe("C:\\repo\\AliasFile.ts");
    const alias = await broker.observe("C:\\repo\\ALIASFILE.TS");
    const hardlink = await broker.observe("C:\\repo\\HardLink.ts");
    expect(canonical.observation.status).toBe("present");
    expect(alias.observation.status).toBe("present");
    expect(hardlink.observation.status).toBe("present");
    if (
      canonical.observation.status !== "present" ||
      alias.observation.status !== "present" ||
      hardlink.observation.status !== "present"
    ) {
      throw new Error("测试前置条件不成立。");
    }
    expect(alias.observation.identity).toBe(canonical.observation.identity);
    expect(hardlink.observation.identity).toBe(canonical.observation.identity);
    expect(JSON.stringify(canonical)).not.toContain("C:\\\\repo");
  });

  it("keeps distinct Unicode files separate without exposing absolute paths", async () => {
    const fake = createFakeFileSystem({
      "/repo": { canonicalPath: "/repo", dev: 1n, ino: 1n, kind: "directory" },
      "/repo/ẞ.ts": { canonicalPath: "/repo/ẞ.ts", dev: 1n, ino: 10n },
      "/repo/ß.ts": { canonicalPath: "/repo/ß.ts", dev: 1n, ino: 11n },
      "/repo/İ.ts": { canonicalPath: "/repo/İ.ts", dev: 1n, ino: 12n },
      "/repo/i̇.ts": { canonicalPath: "/repo/i̇.ts", dev: 1n, ino: 13n },
    });
    const broker = createPosixBroker(fake);

    for (const [leftPath, rightPath] of [
      ["/repo/ẞ.ts", "/repo/ß.ts"],
      ["/repo/İ.ts", "/repo/i̇.ts"],
    ] as const) {
      expect(leftPath.toLowerCase()).toBe(rightPath.toLowerCase());
      const left = await broker.observe(leftPath);
      const right = await broker.observe(rightPath);
      if (left.observation.status !== "present" || right.observation.status !== "present") {
        throw new Error("测试前置条件不成立。");
      }
      expect(left.observation.identity).not.toBe(right.observation.identity);
      expect(JSON.stringify([left, right])).not.toContain("/repo/");
    }
  });

  it("binds proof to the indexing root and rejects relative, device, ADS and external paths", async () => {
    const fake = createFakeFileSystem({
      "C:\\repo": {
        canonicalPath: "C:\\repo",
        dev: 7n,
        ino: 1n,
        kind: "directory",
      },
      "C:\\repo\\inside.ts": {
        canonicalPath: "C:\\outside\\inside.ts",
        dev: 7n,
        ino: 12n,
      },
      "C:\\outside\\inside.ts": {
        canonicalPath: "C:\\outside\\inside.ts",
        dev: 7n,
        ino: 12n,
      },
    });
    const broker = new HostPathIdentityBroker({
      fileSystem: fake.fileSystem,
      indexingRoot: "C:\\repo",
      platform: "win32",
    });

    for (const absolutePath of [
      "relative.ts",
      "C:drive-relative.ts",
      "\\relative-to-drive-root.ts",
      "\\\\?\\C:\\repo\\device.ts",
      "\\\\.\\C:\\repo\\device.ts",
      "C:\\repo\\inside.ts:secret",
      "C:\\outside\\outside.ts",
    ]) {
      const proof = await broker.resolveCandidates([
        { absolutePath, logicalPath: "candidate.ts" },
      ]);
      expect(proof.status).toBe("rejected");
      expect(proof.entries).toEqual([]);
    }

    const junctionEscape = await broker.resolveCandidates([
      { absolutePath: "C:\\repo\\inside.ts", logicalPath: "inside.ts" },
    ]);
    expect(junctionEscape.status).toBe("failed");
    expect(junctionEscape.aliasGroups).toEqual([]);
    expect(junctionEscape.entries[0]?.observation).toMatchObject({
      code: "HOST_PATH_OUTSIDE_INDEXING_ROOT",
      retryable: false,
      status: "unsupported",
    });
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

  it("uses opened dev/ino identity and ignores mutable birth time", async () => {
    const fake = createBasicFake();
    const first = await observeHostPathIdentity("/repo/a.ts", {
      fileSystem: fake.fileSystem,
      indexingRoot: "/repo",
      platform: "linux",
    });
    if (first.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }

    const originalLstat = fake.lstat.getMockImplementation();
    fake.lstat.mockImplementation(async (input: string) => {
      const status = await originalLstat!(input);
      return { ...status, birthtimeNs: 999999n };
    });
    const second = await observeHostPathIdentity("/repo/a.ts", {
      fileSystem: fake.fileSystem,
      indexingRoot: "/repo",
      platform: "linux",
    });
    if (second.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }
    expect(second.identity).toBe(first.identity);
  });

  it("returns non-retryable unsupported when a complete opened identity tuple is unavailable", async () => {
    const fake = createBasicFake();
    fake.records.set("/repo/a.ts", {
      canonicalPath: "/repo/a.ts",
      dev: 0n,
      ino: 10n,
    });

    await expect(observeHostPathIdentity("/repo/a.ts", {
      fileSystem: fake.fileSystem,
      indexingRoot: "/repo",
      platform: "linux",
    })).resolves.toMatchObject({
      code: "HOST_PATH_IDENTITY_UNSUPPORTED",
      retryable: false,
      status: "unsupported",
    });
  });

  it("classifies topology errors after initial presence as changed and retryable", async () => {
    const fake = createBasicFake();
    fake.records.get("/repo/a.ts")!.openError = "EISDIR";

    await expect(observeHostPathIdentity("/repo/a.ts", {
      fileSystem: fake.fileSystem,
      indexingRoot: "/repo",
      platform: "linux",
    })).resolves.toMatchObject({
      code: "HOST_PATH_CHANGED",
      retryable: true,
      status: "changed",
    });

    fake.lstat.mockRejectedValueOnce(createHostError("ELOOP"));
    await expect(observeHostPathIdentity("/repo/a.ts", {
      fileSystem: fake.fileSystem,
      indexingRoot: "/repo",
      platform: "linux",
    })).resolves.toMatchObject({
      code: "ELOOP",
      retryable: false,
      status: "unsupported",
    });
  });

  it("revalidates the whole read-set and rejects aliases that never coexisted", async () => {
    const fake = createBasicFake();
    let moved = false;
    fake.records.get("/repo/a.ts")!.closeHook = () => {
      if (moved) {
        return;
      }
      moved = true;
      fake.records.set("/repo/a.ts", {
        canonicalPath: "/repo/a.ts",
        dev: 1n,
        ino: 12n,
      });
      fake.records.set("/repo/b.ts", {
        canonicalPath: "/repo/b.ts",
        dev: 1n,
        ino: 10n,
      });
    };
    const broker = createPosixBroker(fake);

    const proof = await broker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/b.ts", logicalPath: "b.ts" },
    ]);
    expect(proof.status).toBe("failed");
    expect(proof.aliasGroups).toEqual([]);
    expect(proof.entries).toHaveLength(2);
    expect(proof.entries.every(({ observation }) =>
      observation.status === "changed" && observation.retryable
    )).toBe(true);
    expect(proof).toHaveProperty("readSetDigest");
  });

  it("checks raw count and byte budgets before later allocation, sorting or I/O", async () => {
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
    expect(fake.lstat).not.toHaveBeenCalled();

    const lateRead = vi.fn(() => {
      throw new Error("超过字节预算后不得继续读取后续候选。");
    });
    const sameCandidateAbsoluteRead = vi.fn(() => {
      throw new Error("logicalPath 超限后不得读取同一候选的 absolutePath。");
    });
    const overBytes = [
      Object.defineProperties({}, {
        absolutePath: { get: sameCandidateAbsoluteRead },
        logicalPath: { value: "logical-path-too-long.ts" },
      }),
      Object.defineProperties({}, {
        absolutePath: { get: lateRead },
        logicalPath: { get: lateRead },
      }),
    ] as unknown as Array<{ absolutePath: string; logicalPath: string }>;
    await expect(broker.resolveCandidates(overBytes)).resolves.toMatchObject({
      code: "HOST_PATH_LOGICAL_PATH_LIMIT_EXCEEDED",
      status: "rejected",
    });
    expect(sameCandidateAbsoluteRead).not.toHaveBeenCalled();
    expect(lateRead).not.toHaveBeenCalled();
    expect(fake.lstat).not.toHaveBeenCalled();

    const cumulativeLateRead = vi.fn(() => {
      throw new Error("累计 UTF-8 预算超限后不得读取后续候选。");
    });
    const cumulativeBroker = createPosixBroker(fake, {
      maxAbsolutePathBytes: 32,
      maxBatchBytes: 20,
      maxCandidates: 3,
      maxLogicalPathBytes: 16,
    });
    await expect(cumulativeBroker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/b.ts", logicalPath: "b.ts" },
      Object.defineProperties({}, {
        absolutePath: { get: cumulativeLateRead },
        logicalPath: { get: cumulativeLateRead },
      }) as { absolutePath: string; logicalPath: string },
    ])).resolves.toMatchObject({
      code: "HOST_PATH_BATCH_LIMIT_EXCEEDED",
      status: "rejected",
    });
    expect(cumulativeLateRead).not.toHaveBeenCalled();
    expect(fake.lstat).not.toHaveBeenCalled();
  });

  it("sorts unique logical paths and keeps generation/proof digests deterministic", async () => {
    const fake = createBasicFake();
    const firstBroker = createPosixBroker(fake);
    const secondBroker = createPosixBroker(fake);
    const input = [
      { absolutePath: "/repo/b.ts", logicalPath: "b.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
    ];

    const first = await firstBroker.resolveCandidates(input);
    const second = await secondBroker.resolveCandidates([...input].reverse());
    expect(first.status).toBe("complete");
    expect(second.status).toBe("complete");
    expect(first.entries.map(({ logicalPath }) => logicalPath)).toEqual(["a.ts", "b.ts"]);
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(1);
    expect(first.proofDigest).toBe(second.proofDigest);
    expect(JSON.stringify(first)).not.toContain("/repo/");
  });

  it("preserves identity across rename and changes it after delete plus replace", async () => {
    const fake = createBasicFake();
    const broker = createPosixBroker(fake);
    const before = await broker.observe("/repo/a.ts");
    if (before.observation.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }

    fake.records.delete("/repo/a.ts");
    fake.records.set("/repo/renamed.ts", {
      canonicalPath: "/repo/renamed.ts",
      dev: 1n,
      ino: 10n,
    });
    const renamed = await broker.observe("/repo/renamed.ts");
    if (renamed.observation.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }
    expect(renamed.observation.identity).toBe(before.observation.identity);

    fake.records.set("/repo/a.ts", {
      canonicalPath: "/repo/a.ts",
      dev: 1n,
      ino: 99n,
    });
    const replacement = await broker.observe("/repo/a.ts");
    if (replacement.observation.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }
    expect(replacement.observation.identity).not.toBe(before.observation.identity);
  });

  it("keeps missing, unreadable, conflict and unknown I/O failures fail-closed", async () => {
    const fake = createBasicFake();
    fake.records.set("/repo/private.ts", {
      canonicalPath: "/repo/private.ts",
      dev: 1n,
      ino: 20n,
      openError: "EACCES",
    });
    fake.records.set("/repo/error.ts", {
      canonicalPath: "/repo/error.ts",
      dev: 1n,
      ino: 21n,
      openError: "EIO",
    });
    const broker = createPosixBroker(fake);

    await expect(broker.observe("/repo/missing.ts")).resolves.toMatchObject({
      observation: { code: "ENOENT", status: "missing" },
    });
    await expect(broker.observe("/repo/private.ts")).resolves.toMatchObject({
      observation: { code: "EACCES", status: "unreadable" },
    });
    await expect(broker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "same.ts" },
      { absolutePath: "/repo/b.ts", logicalPath: "same.ts" },
    ])).resolves.toMatchObject({
      code: "HOST_PATH_LOGICAL_ALIAS_CONFLICT",
      status: "rejected",
    });
    const failed = await broker.resolveCandidates([
      { absolutePath: "/repo/error.ts", logicalPath: "error.ts" },
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.aliasGroups).toEqual([]);
    expect(failed.entries[0]?.observation).toMatchObject({ code: "EIO", status: "error" });
  });
});
