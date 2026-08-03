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
import { afterEach, describe, expect, it } from "vitest";
import {
  createDefaultHostPathIdentitySnapshotProvider,
  HostPathIdentityBroker,
} from "../../apps/graph-service/src/host-path-identity.js";
import {
  createServiceScopedWin32HostPathIdentityHelper,
  type ServiceScopedWin32HostPathIdentityHelper,
} from "../../apps/graph-service/src/index.js";
import {
  createAnalyzerSemanticContextCapture,
} from "../../apps/graph-service/src/analyzer-config.js";
import { createInitialIgnoreState } from "../../apps/graph-service/src/ignore-bootstrap.js";
import {
  scanWorkspace,
  verifyWorkspaceReadSetSync,
} from "../../apps/graph-service/src/workspace-scanner.js";
import {
  analyzeTypeScriptModules,
  observeTypeScriptConfiguration,
} from "../../packages/adapters/analyzer-typescript/src/worker-analysis.js";

const temporaryRoots: string[] = [];
const hostPathIdentityHelpers: ServiceScopedWin32HostPathIdentityHelper[] = [];

/** 仅删除本测试通过 mkdtemp 创建并登记的隔离目录。 */
afterEach(async () => {
  await Promise.all(hostPathIdentityHelpers.splice(0).map((helper) => helper.close()));
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
  return createBrokerFixture(indexingRoot).broker;
}

/** 同时返回 helper 诊断端口，用于证明多次 capture 未重复冷启动 PowerShell。 */
function createBrokerFixture(indexingRoot: string): {
  broker: HostPathIdentityBroker;
  helper: ServiceScopedWin32HostPathIdentityHelper;
} {
  const helper = createServiceScopedWin32HostPathIdentityHelper();
  hostPathIdentityHelpers.push(helper);
  return {
    broker: new HostPathIdentityBroker({
      indexingRoot,
      platform: "win32",
      snapshotProvider: createDefaultHostPathIdentitySnapshotProvider({
        caseSensitiveFileNames: false,
        captureWindows: helper.capture,
        platform: "win32",
      }),
    }),
    helper,
  };
}

describe("Windows host path identity contract", () => {
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
    const { broker, helper } = createBrokerFixture(root);
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
    expect(helper.readDiagnostics()).toMatchObject({
      pendingRequests: 0,
      processRunning: true,
      processStarts: 1,
    });
    expect(JSON.stringify([before, renamed, replacement])).not.toContain(root);
  }, 30_000);

  it("closes CR10-001 across scanner, Story capture, Worker aliases, and stale fences", async () => {
    const root = await createWindowsRoot();
    const sourceRoot = path.join(root, "src");
    await mkdir(sourceRoot);
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }), { flag: "wx" });
    await writeFile(path.join(sourceRoot, "index.ts"), [
      'import { capital } from "./ẞ.js";',
      'import { lower } from "./ß.js";',
      'import { alias } from "./alias.js";',
      "void capital; void lower; void alias;",
    ].join("\n"), { flag: "wx" });
    await writeFile(path.join(sourceRoot, "ẞ.ts"), "export const capital = 1;\n", { flag: "wx" });
    await writeFile(path.join(sourceRoot, "ß.ts"), "export const lower = 2;\n", { flag: "wx" });
    const aliasPath = path.join(sourceRoot, "Alias.ts");
    await writeFile(aliasPath, "export const alias = 3;\n", { flag: "wx" });
    const ignoreState = await createInitialIgnoreState(root);
    if (ignoreState.kind !== "ready") {throw new Error("Win32 contract ignore 前置条件不成立。");}
    const scan = await scanWorkspace({
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      platform: "win32",
    });
    const analyzer = {
      analyze: async () => ({ consultedLogicalPaths: [], files: [] }),
      close: () => undefined,
      observeConfiguration: async (input: Parameters<typeof observeTypeScriptConfiguration>[0]) =>
        observeTypeScriptConfiguration(input),
    };
    const context = await createAnalyzerSemanticContextCapture({
      analyzer,
      effectiveIgnoreSnapshot: ignoreState.snapshot,
      hostPathIdentityBroker: createBroker(root),
      indexingRoot: root,
      workspaceKey: "c".repeat(64),
    })(scan);
    const output = analyzeTypeScriptModules({
      ...(context.caseSensitiveFileNames === undefined
        ? {}
        : { caseSensitiveFileNames: context.caseSensitiveFileNames }),
      configDigest: context.configDigest,
      configSnapshot: context.configSnapshot,
      configurationEntryPaths: context.configurationEntryPaths,
      configurationFiles: context.configurationFiles,
      detectedAt: "2026-07-31T00:00:00.000Z",
      ...(context.hostPathIdentitySidecar === undefined
        ? {}
        : { hostPathIdentitySidecar: context.hostPathIdentitySidecar }),
      inputDigest: context.inputDigest,
      resolutionFiles: context.resolutionFiles,
      sourceFiles: context.sourceFiles,
      workspaceKey: "c".repeat(64),
    });
    const targets = output.files.find((file) => file.path === "src/index.ts")?.relations
      .flatMap((relation) => relation.target.kind === "internal-file"
        ? [relation.target.resolvedPath]
        : []);
    const sidecar = context.hostPathIdentitySidecar;
    if (sidecar === undefined || scan.verificationProof === undefined) {
      throw new Error("Win32 Story consumer 必须产生 transient proof 与 scanner fence。");
    }
    const identityByPath = new Map(sidecar.entries.map((entry) => [entry.logicalPath, entry.identity]));

    expect(targets).toEqual(expect.arrayContaining(["src/ẞ.ts", "src/ß.ts", "src/Alias.ts"]));
    expect(identityByPath.get("src/ẞ.ts")).not.toBe(identityByPath.get("src/ß.ts"));
    expect(identityByPath.get("src/alias.ts")).toBe(identityByPath.get("src/Alias.ts"));
    expect(JSON.stringify(context.configSnapshot)).not.toContain(sidecar.snapshotIdentity);
    expect(verifyWorkspaceReadSetSync({
      expectedManifest: scan.manifest,
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      platform: "win32",
      verificationProof: scan.verificationProof,
    })).toBe(true);

    await rename(aliasPath, path.join(sourceRoot, "Renamed.ts"));
    expect(verifyWorkspaceReadSetSync({
      expectedManifest: scan.manifest,
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      platform: "win32",
      verificationProof: scan.verificationProof,
    })).toBe(false);
    await unlink(path.join(sourceRoot, "ß.ts"));
    expect(verifyWorkspaceReadSetSync({
      expectedManifest: scan.manifest,
      ignoreSnapshot: ignoreState.snapshot,
      indexingRoot: root,
      platform: "win32",
      verificationProof: scan.verificationProof,
    })).toBe(false);
  }, 60_000);
});
