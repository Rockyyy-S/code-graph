import { describe, expect, it, vi } from "vitest";
import {
  HostPathIdentityBroker,
  observeHostPathIdentity,
  type HostPathIdentityFileSystem,
  type HostPathIdentityStat,
} from "../../apps/graph-service/src/host-path-identity.js";

interface FakeFileRecord {
  birthtimeNs?: bigint;
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  openError?: string;
}

/** 创建带稳定错误码的宿主错误，供 fail-closed 分支精确断言。 */
function createHostError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** 把测试记录投影为 broker 只允许读取的文件状态。 */
function toStat(record: FakeFileRecord): HostPathIdentityStat {
  return {
    birthtimeNs: record.birthtimeNs ?? 1n,
    dev: record.dev,
    ino: record.ino,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

/** 构造可变文件系统，使测试能表达 rename、替换与读取错误。 */
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
      close: vi.fn(async () => undefined),
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

describe("host path identity broker", () => {
  it("returns one opaque identity for ASCII casing aliases of the same opened file", async () => {
    const canonicalPath = "C:\\repo\\AliasFile.ts";
    const fake = createFakeFileSystem({
      "C:\\repo\\ALIASFILE.TS": { canonicalPath, dev: 7n, ino: 11n },
      "C:\\repo\\AliasFile.ts": { canonicalPath, dev: 7n, ino: 11n },
    });

    const first = await observeHostPathIdentity("C:\\repo\\AliasFile.ts", {
      fileSystem: fake.fileSystem,
      platform: "win32",
    });
    const alias = await observeHostPathIdentity("C:\\repo\\ALIASFILE.TS", {
      fileSystem: fake.fileSystem,
      platform: "win32",
    });

    expect(first).toMatchObject({ status: "present", canonicalPath });
    expect(alias).toMatchObject({ status: "present", canonicalPath });
    if (first.status !== "present" || alias.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }
    expect(alias.identity).toBe(first.identity);
    expect(alias.volumeIdentity).toBe(first.volumeIdentity);
  });

  it("keeps distinct Unicode files separate even when JavaScript lowercase collides", async () => {
    const fake = createFakeFileSystem({
      "/repo/ẞ.ts": { canonicalPath: "/repo/ẞ.ts", dev: 1n, ino: 10n },
      "/repo/ß.ts": { canonicalPath: "/repo/ß.ts", dev: 1n, ino: 11n },
      "/repo/İ.ts": { canonicalPath: "/repo/İ.ts", dev: 1n, ino: 12n },
      "/repo/i̇.ts": { canonicalPath: "/repo/i̇.ts", dev: 1n, ino: 13n },
    });

    for (const [leftPath, rightPath] of [
      ["/repo/ẞ.ts", "/repo/ß.ts"],
      ["/repo/İ.ts", "/repo/i̇.ts"],
    ] as const) {
      expect(leftPath.toLowerCase()).toBe(rightPath.toLowerCase());
      const left = await observeHostPathIdentity(leftPath, { fileSystem: fake.fileSystem });
      const right = await observeHostPathIdentity(rightPath, { fileSystem: fake.fileSystem });
      if (left.status !== "present" || right.status !== "present") {
        throw new Error("测试前置条件不成立。");
      }
      expect(left.identity).not.toBe(right.identity);
    }
  });

  it("returns explicit missing and unreadable results without fabricating identity", async () => {
    const fake = createFakeFileSystem({
      "/repo/private.ts": {
        canonicalPath: "/repo/private.ts",
        dev: 1n,
        ino: 2n,
        openError: "EACCES",
      },
    });

    await expect(observeHostPathIdentity("/repo/missing.ts", {
      fileSystem: fake.fileSystem,
    })).resolves.toMatchObject({ code: "ENOENT", status: "missing" });
    await expect(observeHostPathIdentity("/repo/private.ts", {
      fileSystem: fake.fileSystem,
    })).resolves.toMatchObject({ code: "EACCES", status: "unreadable" });
  });

  it("preserves identity across rename and changes identity after path replacement", async () => {
    const fake = createFakeFileSystem({
      "/repo/before.ts": { canonicalPath: "/repo/before.ts", dev: 1n, ino: 20n },
    });
    const before = await observeHostPathIdentity("/repo/before.ts", {
      fileSystem: fake.fileSystem,
    });
    if (before.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }

    fake.records.delete("/repo/before.ts");
    fake.records.set("/repo/after.ts", {
      canonicalPath: "/repo/after.ts",
      dev: 1n,
      ino: 20n,
    });
    const afterRename = await observeHostPathIdentity("/repo/after.ts", {
      fileSystem: fake.fileSystem,
    });
    await expect(observeHostPathIdentity("/repo/before.ts", {
      fileSystem: fake.fileSystem,
    })).resolves.toMatchObject({ status: "missing" });
    if (afterRename.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }
    expect(afterRename.identity).toBe(before.identity);
    expect(afterRename.evidenceDigest).not.toBe(before.evidenceDigest);

    fake.records.set("/repo/before.ts", {
      birthtimeNs: 2n,
      canonicalPath: "/repo/before.ts",
      dev: 1n,
      ino: 21n,
    });
    const replacement = await observeHostPathIdentity("/repo/before.ts", {
      fileSystem: fake.fileSystem,
    });
    if (replacement.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }
    expect(replacement.identity).not.toBe(before.identity);
  });

  it("detects a rename or replacement race while the path proof is being captured", async () => {
    const fake = createFakeFileSystem({
      "/repo/racing.ts": { canonicalPath: "/repo/racing.ts", dev: 1n, ino: 30n },
    });
    fake.realpath.mockImplementationOnce(async (input: string) => {
      fake.records.set(input, { canonicalPath: input, dev: 1n, ino: 31n });
      return input;
    });

    await expect(observeHostPathIdentity("/repo/racing.ts", {
      fileSystem: fake.fileSystem,
    })).resolves.toMatchObject({ code: "HOST_PATH_CHANGED", status: "changed" });
  });

  it("bounds, sorts and uniquifies the candidate logical-path proof", async () => {
    const fake = createFakeFileSystem({
      "/repo/a.ts": { canonicalPath: "/repo/a.ts", dev: 1n, ino: 40n },
      "/repo/z.ts": { canonicalPath: "/repo/z.ts", dev: 1n, ino: 41n },
    });
    const broker = new HostPathIdentityBroker({
      fileSystem: fake.fileSystem,
      maxCandidates: 2,
    });

    const proof = await broker.resolveCandidates([
      { absolutePath: "/repo/z.ts", logicalPath: "z.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
    ]);
    expect(proof.status).toBe("complete");
    expect(proof.entries.map((entry) => entry.logicalPath)).toEqual(["a.ts", "z.ts"]);
    expect(proof.aliasGroups).toHaveLength(2);
    expect(proof.proofDigest).toMatch(/^[a-f0-9]{64}$/u);

    const overLimit = await broker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "a.ts" },
      { absolutePath: "/repo/z.ts", logicalPath: "z.ts" },
      { absolutePath: "/repo/third.ts", logicalPath: "third.ts" },
    ]);
    expect(overLimit).toMatchObject({
      code: "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED",
      entries: [],
      status: "rejected",
    });
    expect(fake.open).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting logical aliases and propagates unknown I/O errors fail-closed", async () => {
    const fake = createFakeFileSystem({
      "/repo/a.ts": { canonicalPath: "/repo/a.ts", dev: 1n, ino: 50n },
      "/repo/b.ts": { canonicalPath: "/repo/b.ts", dev: 1n, ino: 51n },
      "/repo/error.ts": {
        canonicalPath: "/repo/error.ts",
        dev: 1n,
        ino: 52n,
        openError: "EIO",
      },
    });
    const broker = new HostPathIdentityBroker({ fileSystem: fake.fileSystem });

    await expect(broker.resolveCandidates([
      { absolutePath: "/repo/a.ts", logicalPath: "same.ts" },
      { absolutePath: "/repo/b.ts", logicalPath: "same.ts" },
    ])).resolves.toMatchObject({
      code: "HOST_PATH_LOGICAL_ALIAS_CONFLICT",
      entries: [],
      status: "rejected",
    });

    const failed = await broker.resolveCandidates([
      { absolutePath: "/repo/error.ts", logicalPath: "error.ts" },
    ]);
    expect(failed.status).toBe("failed");
    expect(failed.entries[0]?.observation).toMatchObject({ code: "EIO", status: "error" });
    expect(failed.aliasGroups).toEqual([]);
  });
});
