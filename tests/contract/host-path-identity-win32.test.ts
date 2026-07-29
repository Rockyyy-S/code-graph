import { spawnSync } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { HostPathIdentityBroker } from "../../apps/graph-service/src/host-path-identity.js";

const temporaryRoots: string[] = [];

/** 仅删除本测试通过 mkdtemp 创建并登记的隔离目录。 */
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

/** 创建当前真实 Windows 临时卷上的隔离合同目录。 */
async function createWindowsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-host-path-identity-"));
  temporaryRoots.push(root);
  return root;
}

/** 通过 Windows 卷管理 API 查询测试卷文件系统，禁止零样本能力通过。 */
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

/** 只翻转 ASCII 字母大小写，不对 Unicode 执行 JavaScript case-fold。 */
function invertAsciiCase(input: string): string {
  return [...input].map((character) => {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      return String.fromCharCode(code + 32);
    }
    if (code >= 97 && code <= 122) {
      return String.fromCharCode(code - 32);
    }
    return character;
  }).join("");
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
      "Unicode、ADS、hardlink 与 FILE_ID_INFO 合同必须在 NTFS 测试卷执行。",
    ).toBe("NTFS");
  });

  it("binds root, directory and leaf casing aliases plus hardlinks in one snapshot", async () => {
    const root = await createWindowsRoot();
    const directoryName = "MixedDirectory";
    const fileName = "AliasFile.ts";
    const hardlinkName = "HardLink.ts";
    const directoryPath = path.join(root, directoryName);
    const canonicalPath = path.join(directoryPath, fileName);
    const hardlinkPath = path.join(directoryPath, hardlinkName);
    await mkdir(directoryPath);
    await writeFile(canonicalPath, "export const value = 1;\n", { flag: "wx" });
    await link(canonicalPath, hardlinkPath);

    const aliasRoot = invertAsciiCase(root);
    const aliasPath = path.join(
      aliasRoot,
      invertAsciiCase(directoryName),
      invertAsciiCase(fileName),
    );
    const broker = createBroker(aliasRoot);
    const proof = await broker.resolveCandidates([
      {
        absolutePath: canonicalPath,
        logicalPath: `${directoryName}/${fileName}`,
      },
      {
        absolutePath: aliasPath,
        logicalPath: `${directoryName}/${fileName}`,
      },
      {
        absolutePath: hardlinkPath,
        logicalPath: `${directoryName}/${hardlinkName}`,
      },
    ]);

    expect(proof.status, JSON.stringify(proof)).toBe("complete");
    expect(proof.snapshotIdentity).toMatch(/^host-snapshot-v1:/u);
    expect(proof.entries).toHaveLength(2);
    expect(proof.entries.every(({ observation }) => observation.status === "present")).toBe(true);
    const identities = proof.entries.map(({ observation }) =>
      observation.status === "present" ? observation.identity : "failed"
    );
    expect(new Set(identities).size).toBe(1);
    expect(proof.aliasGroups).toEqual([
      {
        identity: identities[0],
        logicalPaths: [
          `${directoryName}/${fileName}`,
          `${directoryName}/${hardlinkName}`,
        ],
      },
    ]);
    expect(JSON.stringify(proof)).not.toContain(root);
    expect(JSON.stringify(proof)).not.toContain(aliasRoot);
    expect(JSON.stringify(proof)).not.toContain(canonicalPath);
  });

  it("executes both Unicode lowercase-collision samples without merging identities", async () => {
    const root = await createWindowsRoot();
    const pairs = [
      ["ẞ.ts", "ß.ts"],
      ["İ.ts", "i̇.ts"],
    ] as const;
    const candidates: Array<{ absolutePath: string; logicalPath: string }> = [];

    for (const [leftName, rightName] of pairs) {
      const pairDirectory = Buffer.from(leftName).toString("hex");
      const pairRoot = path.join(root, pairDirectory);
      await mkdir(pairRoot);
      for (const [name, value] of [[leftName, "left"], [rightName, "right"]] as const) {
        const absolutePath = path.join(pairRoot, name);
        await writeFile(absolutePath, `export const ${value} = 1;\n`, { flag: "wx" });
        candidates.push({ absolutePath, logicalPath: `${pairDirectory}/${name}` });
      }
    }

    const proof = await createBroker(root).resolveCandidates(candidates);
    expect(proof.status, JSON.stringify(proof)).toBe("complete");
    expect(proof.entries).toHaveLength(pairs.length * 2);
    expect(proof.aliasGroups).toHaveLength(pairs.length * 2);
    expect(new Set(proof.aliasGroups.map(({ identity }) => identity)).size).toBe(pairs.length * 2);
  });

  it("rejects alternate streams before I/O and fails closed on external junctions", async () => {
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

    const insideFile = path.join(root, "inside.ts");
    const outsideHardlink = path.join(outsideRoot, "outside-hardlink.ts");
    await writeFile(insideFile, "export const inside = 1;\n", { flag: "wx" });
    await link(insideFile, outsideHardlink);
    const escapedHardlink = await broker.resolveCandidates([
      { absolutePath: outsideHardlink, logicalPath: "inside.ts" },
    ]);
    expect(escapedHardlink.status).toBe("failed");
    expect(escapedHardlink.entries[0]?.observation).toMatchObject({
      code: "HOST_PATH_OUTSIDE_INDEXING_ROOT",
      retryable: false,
      status: "unsupported",
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
      code: "HOST_PATH_REPARSE_POINT",
      retryable: false,
      status: "unsupported",
    });
    expect(JSON.stringify(escaped)).not.toContain(outsideRoot);
  });

  it("limits identity to one capture across rename and real unlink plus replacement", async () => {
    const root = await createWindowsRoot();
    const broker = createBroker(root);
    const beforePath = path.join(root, "before.ts");
    const afterPath = path.join(root, "after.ts");
    await writeFile(beforePath, "export const value = 1;\n", { flag: "wx" });

    const before = await broker.observe(beforePath);
    expect(before.observation.status).toBe("present");
    await rename(beforePath, afterPath);
    const renamed = await broker.observe(afterPath);
    expect(renamed.observation.status).toBe("present");
    if (before.observation.status !== "present" || renamed.observation.status !== "present") {
      throw new Error("rename 前后文件必须分别取得句柄快照证明。");
    }
    expect(before.observation.identityLifetime).toBe("snapshot");
    expect(renamed.observation.identityLifetime).toBe("snapshot");
    expect(renamed.observation.identity).not.toBe(before.observation.identity);
    expect(renamed.snapshotIdentity).not.toBe(before.snapshotIdentity);

    await unlink(afterPath);
    await writeFile(afterPath, "export const replacement = 2;\n", { flag: "wx" });
    const replacement = await broker.observe(afterPath);
    expect(replacement.observation.status).toBe("present");
    if (replacement.observation.status !== "present") {
      throw new Error("unlink 后创建的替换文件必须取得新的句柄快照证明。");
    }
    expect(replacement.observation.identityLifetime).toBe("snapshot");
    expect(replacement.observation.identity).not.toBe(renamed.observation.identity);
    expect(replacement.snapshotIdentity).not.toBe(renamed.snapshotIdentity);
    expect(JSON.stringify([before, renamed, replacement])).not.toContain(root);
  }, 30_000);
});
