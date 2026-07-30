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

/** 以有界子进程独立复验实际 tmpdir 的卷能力与 ordinary/non-reparse 根属性。 */
function probeWindowsTestRoot(input: string): {
  drive: string;
  driveType: string;
  fileSystem: string;
  ordinary: boolean;
  reparse: boolean;
  root: string;
} {
  const driveLetter = path.parse(path.resolve(input)).root.match(/^([A-Za-z]):\\$/u)?.[1];
  if (driveLetter === undefined) {
    throw new Error(`CODEGRAPH_WIN32_CONTRACT_PREFLIGHT ${JSON.stringify({
      candidateRoot: input,
      code: "ROOT_WITHOUT_DRIVE",
      processPlatform: process.platform,
    })}`);
  }
  const probeRoot = path.resolve(input);
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$ErrorActionPreference='Stop'",
        `$volume=Get-Volume -DriveLetter '${driveLetter}' -ErrorAction Stop`,
        "$item=Get-Item -LiteralPath $env:CODEGRAPH_CONTRACT_TMPDIR -Force -ErrorAction Stop",
        "$result=[ordered]@{drive=[string]$volume.DriveLetter;driveType=[string]$volume.DriveType;fileSystem=[string]$volume.FileSystem;ordinary=[bool]$item.PSIsContainer;reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint);root=[IO.Path]::GetFullPath($item.FullName)}",
        "$result | ConvertTo-Json -Compress",
      ].join(";"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CODEGRAPH_CONTRACT_TMPDIR: probeRoot },
      shell: false,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const spawnErrorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const diagnostic = {
    candidateRoot: probeRoot,
    code: spawnErrorCode === "ETIMEDOUT"
      ? "GET_VOLUME_TIMEOUT"
      : result.error !== undefined || result.status !== 0
        ? "GET_VOLUME_ERROR"
        : "OK",
    getVolume: {
      status: result.status,
      stderr: result.stderr.slice(0, 8_192),
      stdout: result.stdout.slice(0, 8_192),
      timeout: spawnErrorCode === "ETIMEDOUT",
    },
    processPlatform: process.platform,
  };
  if (diagnostic.code !== "OK") {
    throw new Error(`CODEGRAPH_WIN32_CONTRACT_PREFLIGHT ${JSON.stringify(diagnostic)}`);
  }
  let probe;
  try {
    probe = JSON.parse(result.stdout) as ReturnType<typeof probeWindowsTestRoot>;
  } catch {
    throw new Error(`CODEGRAPH_WIN32_CONTRACT_PREFLIGHT ${JSON.stringify({
      ...diagnostic,
      code: "GET_VOLUME_INVALID_JSON",
    })}`);
  }
  if (
    probe.fileSystem !== "NTFS" ||
    probe.driveType !== "Fixed" ||
    probe.ordinary !== true ||
    probe.reparse !== false ||
    path.resolve(probe.root).toLowerCase() !== probeRoot.toLowerCase()
  ) {
    throw new Error(`CODEGRAPH_WIN32_CONTRACT_PREFLIGHT ${JSON.stringify({
      ...diagnostic,
      code: "UNSAFE_TEST_ROOT",
      probe,
    })}`);
  }
  return probe;
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
    if (process.platform !== "win32") {
      throw new Error(`CODEGRAPH_WIN32_CONTRACT_PREFLIGHT ${JSON.stringify({
        candidateRoot: tmpdir(),
        code: "NON_WIN32",
        processPlatform: process.platform,
      })}`);
    }
    const probe = probeWindowsTestRoot(tmpdir());
    expect(probe).toMatchObject({
      driveType: "Fixed",
      fileSystem: "NTFS",
      ordinary: true,
      reparse: false,
    });
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
