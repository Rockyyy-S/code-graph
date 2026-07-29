import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HostPathIdentityBroker } from "../../apps/graph-service/src/host-path-identity.js";

const temporaryRoots: string[] = [];

/** 仅删除本测试通过 mkdtemp 创建的已登记目录。 */
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

/** 创建当前实际 Windows 临时卷上的隔离合同目录。 */
async function createWindowsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-host-path-identity-"));
  temporaryRoots.push(root);
  return root;
}

/** 通过 Windows 卷管理 API 查询临时目录的文件系统类型，拒绝零样本能力通过。 */
function readWindowsVolumeFileSystem(input: string): string {
  const driveLetter = path.parse(path.resolve(input)).root.match(/^([A-Za-z]):\\$/u)?.[1];
  if (driveLetter === undefined) {
    throw new Error("blocking contract 需要具有盘符的受控 Windows 测试卷。");
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Volume -DriveLetter '${driveLetter}').FileSystem`,
    ],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error("无法验证 blocking contract 所在 Windows 卷能力。", {
      cause: result.error,
    });
  }
  return result.stdout.trim();
}

/** 为真实测试根创建只绑定该 indexing root 的 broker。 */
function createBroker(indexingRoot: string): HostPathIdentityBroker {
  return new HostPathIdentityBroker({ indexingRoot, platform: "win32" });
}

describe("Windows host path identity contract", () => {
  beforeAll(() => {
    expect(process.platform, "该 blocking contract 必须在真实 Windows runner 上执行。").toBe("win32");
    expect(
      readWindowsVolumeFileSystem(tmpdir()),
      "Unicode、ADS、hardlink 与稳定 file ID 合同必须在 NTFS 测试卷执行。",
    ).toBe("NTFS");
  });

  it("resolves ASCII casing aliases and legal hardlinks to one identity", async () => {
    const root = await createWindowsRoot();
    const broker = createBroker(root);
    const canonicalPath = path.join(root, "AliasFile.ts");
    const aliasPath = path.join(root, "aLIASfILE.TS");
    const hardlinkPath = path.join(root, "HardLink.ts");
    await writeFile(canonicalPath, "export const value = 1;\n", { flag: "wx" });
    await link(canonicalPath, hardlinkPath);

    const canonical = await broker.observe(canonicalPath);
    const alias = await broker.observe(aliasPath);
    const hardlink = await broker.observe(hardlinkPath);
    expect(canonical.observation.status).toBe("present");
    expect(alias.observation.status).toBe("present");
    expect(hardlink.observation.status).toBe("present");
    if (
      canonical.observation.status !== "present" ||
      alias.observation.status !== "present" ||
      hardlink.observation.status !== "present"
    ) {
      throw new Error("当前 NTFS 卷未提供完整 opened-handle identity。");
    }
    expect(alias.observation.identity).toBe(canonical.observation.identity);
    expect(hardlink.observation.identity).toBe(canonical.observation.identity);
    expect(JSON.stringify([canonical, alias, hardlink])).not.toContain(root);
  });

  it("requires both lowercase-collision Unicode pairs to coexist and remain distinct", async () => {
    const root = await createWindowsRoot();
    const broker = createBroker(root);
    const pairs = [
      ["ẞ.ts", "ß.ts"],
      ["İ.ts", "i̇.ts"],
    ] as const;
    let executedPairs = 0;

    for (const [leftName, rightName] of pairs) {
      const pairRoot = path.join(root, Buffer.from(leftName).toString("hex"));
      await mkdir(pairRoot);
      const leftPath = path.join(pairRoot, leftName);
      const rightPath = path.join(pairRoot, rightName);
      await writeFile(leftPath, "export const left = 1;\n", { flag: "wx" });
      await writeFile(rightPath, "export const right = 1;\n", { flag: "wx" });

      expect(leftName.toLowerCase()).toBe(rightName.toLowerCase());
      const left = await broker.observe(leftPath);
      const right = await broker.observe(rightPath);
      expect(left.observation.status).toBe("present");
      expect(right.observation.status).toBe("present");
      if (left.observation.status !== "present" || right.observation.status !== "present") {
        throw new Error("已共存 Unicode 文件必须获得完整 opened-handle identity。");
      }
      expect(left.observation.identity).not.toBe(right.observation.identity);
      executedPairs += 1;
    }
    expect(executedPairs).toBe(pairs.length);
  });

  it("rejects NTFS alternate streams and external junction traversal", async () => {
    const root = await createWindowsRoot();
    const outsideRoot = await createWindowsRoot();
    const broker = createBroker(root);
    const basePath = path.join(root, "base.ts");
    await writeFile(basePath, "export const base = 1;\n", { flag: "wx" });
    await writeFile(`${basePath}:private`, "secret\n", { flag: "wx" });

    await expect(broker.resolveCandidates([
      { absolutePath: `${basePath}:private`, logicalPath: "base.ts" },
    ])).resolves.toMatchObject({
      code: "HOST_PATH_ALTERNATE_DATA_STREAM",
      status: "rejected",
    });

    const outsideFile = path.join(outsideRoot, "outside.ts");
    const junctionPath = path.join(root, "external");
    await writeFile(outsideFile, "export const outside = 1;\n", { flag: "wx" });
    await symlink(outsideRoot, junctionPath, "junction");
    const escaped = await broker.resolveCandidates([
      {
        absolutePath: path.join(junctionPath, "outside.ts"),
        logicalPath: "external/outside.ts",
      },
    ]);
    expect(escaped.status).toBe("failed");
    expect(escaped.aliasGroups).toEqual([]);
    expect(escaped.entries[0]?.observation).toMatchObject({
      code: "HOST_PATH_OUTSIDE_INDEXING_ROOT",
      retryable: false,
      status: "unsupported",
    });
  });

  it("preserves identity across rename and changes it after delete plus replace", async () => {
    const root = await createWindowsRoot();
    const broker = createBroker(root);
    const beforePath = path.join(root, "before.ts");
    const afterPath = path.join(root, "after.ts");
    await writeFile(beforePath, "export const value = 1;\n", { flag: "wx" });
    const before = await broker.observe(beforePath);
    expect(before.observation.status).toBe("present");
    if (before.observation.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }

    await rename(beforePath, afterPath);
    const missing = await broker.observe(beforePath);
    const renamed = await broker.observe(afterPath);
    expect(missing.observation.status).toBe("missing");
    expect(renamed.observation.status).toBe("present");
    if (renamed.observation.status !== "present") {
      throw new Error("rename 后文件必须能获得宿主身份证明。");
    }
    expect(renamed.observation.identity).toBe(before.observation.identity);

    await writeFile(beforePath, "export const replacement = 2;\n", { flag: "wx" });
    const replacement = await broker.observe(beforePath);
    expect(replacement.observation.status).toBe("present");
    if (replacement.observation.status !== "present") {
      throw new Error("替换文件必须能获得宿主身份证明。");
    }
    expect(replacement.observation.identity).not.toBe(before.observation.identity);
  });
});
