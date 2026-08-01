import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gateId = "host-path-posix-helper-v1";
const verifierPath = "scripts/ci/verify-host-path-posix-helper-v1.mjs";

export const HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST = Object.freeze({
  cargoManifest: "Cargo.toml",
  crateRoot: "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper",
  lockedAdapterDigests: Object.freeze({
    "packages/adapters/host-path-posix-native/src/capability.ts":
      "4e2f2746660aeb8fafab091af382192acd4ebb74a57029a02cda36d35ef8cb06",
    "packages/adapters/host-path-posix-native/src/index.ts":
      "6527a99e366018dec0775f10bbfe2ac67e581ae7802f820b2c21da7de7230a99",
    "packages/adapters/host-path-posix-native/src/protocol.ts":
      "570165c6accc38c6ac20cfa545437d6eeeed914b5d9c9dc5862262cc4759ae47",
  }),
  packagingPaths: Object.freeze([
    "packaging/linux/README.md",
    "packaging/linux/deb/control",
    "packaging/linux/install-layout.v1.json",
    "packaging/linux/provenance.template.json",
    "packaging/linux/rpm/codegraph-host-path-helper.spec",
    "packaging/linux/sbom/codegraph-host-path-helper.cdx.json",
    "packaging/linux/sbom/codegraph-host-path-helper.spdx.json",
    "packaging/linux/systemd/codegraph-host-path-helper.service",
    "packaging/linux/systemd/codegraph-host-path-helper.socket",
    "packaging/linux/sysusers.d/codegraph-host-path-helper.conf",
    "packaging/linux/tmpfiles.d/codegraph-host-path-helper.conf",
  ]),
  rustSources: Object.freeze([
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/backend.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/bin/bridge.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/bin/daemon.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/canonical.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/command.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/engine.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/lib.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/path_boundary.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/protocol.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/security.rs",
    "packages/adapters/host-path-posix-native/native/codegraph-host-path-helper/src/transport.rs",
  ]),
  triggerPaths: Object.freeze([
    ".github/workflows/host-path-posix-linux.yml",
    "Cargo.lock",
    "Cargo.toml",
    "ci/quality-gates.v1.yaml",
    "packages/adapters/host-path-posix-native/**",
    "packaging/linux/**",
    "rust-toolchain.toml",
    verifierPath,
    "tests/contract/host-path-posix-helper-protocol.test.ts",
    "tests/contract/quality-gates-manifest.test.ts",
    "tests/platform/linux-host-path-helper/**",
    "tests/unit/host-path-posix-capability.test.ts",
  ]),
  version: 1,
});

/** 正向锁定 helper 源码、权限边界、打包和 focused executable tests。 */
export async function verifyHostPathPosixHelperV1() {
  await validateStaticClosure();
  await validateGateRegistration();
  runCargo(["metadata", "--locked", "--offline", "--format-version", "1"], true);
  runPnpm(["--filter", "@codegraph/adapter-host-path-posix-native", "type"]);
  runPnpm([
    "exec", "vitest", "run", "--config", "vitest.config.ts",
    "tests/unit/host-path-posix-capability.test.ts",
  ]);
  runPnpm([
    "exec", "vitest", "run", "--config", "vitest.contract.config.ts",
    "tests/contract/host-path-posix-helper-protocol.test.ts",
  ]);
  runPnpm([
    "exec", "vitest", "run", "--config",
    "tests/platform/linux-host-path-helper/vitest.config.ts",
  ]);

  const rustExecution = process.platform === "linux"
    ? runLinuxRustValidation()
    : "deferred-to-fixed-linux-gate";
  return {
    gateId,
    outcome: "pass",
    rustExecution,
    schemaVersion: 1,
  };
}

async function validateStaticClosure() {
  const toolchain = await readText("rust-toolchain.toml");
  assertIncludes(toolchain, ['channel = "1.88.0"', 'profile = "minimal"'], "rust toolchain");
  const workspace = await readText("Cargo.toml");
  assertIncludes(workspace, [
    "codegraph-host-path-helper",
    'panic = "abort"',
    'overflow-checks = true',
  ], "Cargo workspace");
  const lock = await readText("Cargo.lock");
  assertIncludes(lock, ["version = 4", 'name = "codegraph-host-path-helper"'], "Cargo.lock");

  const sources = new Map();
  for (const sourcePath of HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.rustSources) {
    sources.set(sourcePath, await readText(sourcePath));
  }
  const joined = [...sources.values()].join("\n");
  assertIncludes(joined, [
    "RESOLVE_BENEATH",
    "RESOLVE_NO_MAGICLINKS",
    "RESOLVE_NO_XDEV",
    "STATX_MNT_ID",
    "SCM_RIGHTS",
    "SCM_MULTIPLE_FDS",
    "SO_PEERCRED",
    "ReplayCache",
    "SEQUENCE_NOT_MONOTONIC",
    "PROVENANCE_SIGNATURE_INVALID",
    "ROOTLESS_CONTAINER_UNSUPPORTED",
    "OVERLAYFS_UNSUPPORTED",
    "EXT4_XFS_FREEZE_DEFERRED",
    "BTRFS_NESTED_SUBVOLUME",
    "subvolid=5,nosuid,nodev,noexec",
    "ZFS_CLOSURE_UNSUPPORTED",
    "dataset_guid",
    "LVM_THICK_ORIGIN_UNSUPPORTED",
    "LVM_SNAPSHOT_SPACE_INVALID",
    "ro,norecovery,nouuid,nosuid,nodev,noexec",
    "REQUEST_EXPIRED_DURING_CAPTURE",
    "SNAPSHOT_CLEANUP_FAILED",
    "completed_mutations",
  ], "Rust security closure");
  if (joined.includes("remove_dir_all")) {
    throw new Error("snapshot mount target 禁止递归删除。 ");
  }
  for (const [sourcePath, source] of sources) {
    if (sourcePath.endsWith("command.rs")) {
      assertIncludes(source, [
        "EXECUTABLE_ALLOWLIST",
        ".env_clear()",
        "COMMAND_OUTPUT_LIMIT",
        "COMMAND_TIMEOUT",
        "thread::spawn",
      ], sourcePath);
    } else if (/Command::new|\.sh\b|bash\b|powershell\b/u.test(source)) {
      throw new Error(`${sourcePath}: 外部命令只能由 command.rs 固定执行。`);
    }
    if (/setuid|setgid|npm[_-]?lifecycle|shell\s*[:=]\s*true/iu.test(source)) {
      throw new Error(`${sourcePath}: 禁止 setuid/npm lifecycle/shell 提权。`);
    }
  }

  const packageJson = JSON.parse(await readText(
    "packages/adapters/host-path-posix-native/package.json",
  ));
  if (
    packageJson.scripts?.preinstall !== undefined ||
    packageJson.scripts?.install !== undefined ||
    packageJson.scripts?.postinstall !== undefined ||
    packageJson.exports?.["./linux-helper"] === undefined
  ) {
    throw new Error("POSIX adapter 必须导出 linux-helper 且不得含安装 lifecycle。 ");
  }
  const linuxHelper = await readText(
    "packages/adapters/host-path-posix-native/src/linux-helper.ts",
  );
  assertIncludes(linuxHelper, [
    "stdio: [\"pipe\", \"pipe\", \"pipe\", input.rootFd]",
    "shell: false",
    "O_DIRECTORY",
    "O_NOFOLLOW",
    "filesystem-snapshot",
    "complete-request-batch",
    "validateLinuxHelperResponseEnvelopeV1(value",
    "binarySha256: options.binarySha256",
  ], "TypeScript bridge");
  if (/CAP_SYS_ADMIN|setuid|sudo\b/u.test(linuxHelper)) {
    throw new Error("Node bridge 不得获取或请求特权。 ");
  }

  for (const [sourcePath, expectedDigest] of Object.entries(
    HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.lockedAdapterDigests,
  )) {
    const source = (await readText(sourcePath)).replaceAll("\r\n", "\n");
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    if (digest !== expectedDigest) {
      throw new Error(`${sourcePath}: 旧 strict capability/Win32 消费边界摘要漂移。`);
    }
  }

  const service = await readText(
    "packaging/linux/systemd/codegraph-host-path-helper.service",
  );
  assertIncludes(service, [
    "CapabilityBoundingSet=CAP_SYS_ADMIN",
    "AmbientCapabilities=CAP_SYS_ADMIN",
    "NoNewPrivileges=yes",
    "PrivateMounts=yes",
    "PrivateNetwork=yes",
    "ProtectSystem=strict",
    "RestrictAddressFamilies=AF_UNIX",
  ], "systemd service");
  const installLayout = JSON.parse(await readText("packaging/linux/install-layout.v1.json"));
  if (
    installLayout.nodeProcessCapabilities?.length !== 0 ||
    JSON.stringify(installLayout.serviceCapabilities) !== JSON.stringify(["CAP_SYS_ADMIN"]) ||
    !installLayout.forbiddenInstallMechanisms?.includes("setuid")
  ) {
    throw new Error("Linux 安装布局未保持 Node 无 capability 与 helper 最小权限。 ");
  }
  for (const packagingPath of HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.packagingPaths) {
    await readText(packagingPath);
  }
  const provenanceTemplate = await readText("packaging/linux/provenance.template.json");
  if (/"[a-f0-9]{64}"/u.test(provenanceTemplate)) {
    throw new Error("provenance template 不得伪装成已签名 release。 ");
  }
  const workflow = await readText(".github/workflows/host-path-posix-linux.yml");
  assertIncludes(workflow, [
    "ubuntu-24.04",
    "rustup toolchain install 1.88.0 --profile minimal --no-self-update",
    "pnpm install --frozen-lockfile",
    "verify-host-path-posix-helper-v1.mjs",
  ], "Linux workflow");

  const actualRustFiles = await listFiles(
    path.join(repositoryRoot, HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.crateRoot, "src"),
  );
  const expectedRustFiles = HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.rustSources
    .map((value) => path.join(repositoryRoot, ...value.split("/")))
    .sort(compareOrdinal);
  if (JSON.stringify(actualRustFiles) !== JSON.stringify(expectedRustFiles)) {
    throw new Error("Rust source closure 与 verifier manifest 不一致。 ");
  }
}

async function validateGateRegistration() {
  const loaded = await loadQualityGateRegistry(repositoryRoot);
  const matching = loaded.registry.gates.filter(
    ({ gateDefinition }) => gateDefinition.gateId === gateId,
  );
  if (matching.length !== 1) {
    throw new Error(`ci/quality-gates.v1.yaml 必须唯一登记 ${gateId}。`);
  }
  const definition = matching[0].gateDefinition;
  if (
    definition.blocking !== true ||
    definition.checkId !== gateId ||
    definition.capabilityOwner !== "security" ||
    JSON.stringify(definition.command) !== JSON.stringify(["node", verifierPath]) ||
    JSON.stringify(definition.triggerPaths) !==
      JSON.stringify(HOST_PATH_POSIX_HELPER_VERIFIER_MANIFEST.triggerPaths)
  ) {
    throw new Error(`${gateId}: blocking/security/argv/trigger closure 漂移。`);
  }
}

function runLinuxRustValidation() {
  runCargo(["test", "--locked", "--workspace", "--all-targets"]);
  runCargo([
    "check", "--locked", "--workspace", "--all-targets",
    "--target", "x86_64-unknown-linux-gnu",
  ]);
  const componentProbe = runRustup(["component", "list", "--installed"], false);
  if (componentProbe.stdout.includes("clippy")) {
    runCargo([
      "clippy", "--locked", "--workspace", "--all-targets", "--all-features",
      "--", "-D", "warnings",
    ]);
    return "test-check-clippy";
  }
  return "test-check";
}

function runPnpm(args) {
  const invocation = createPnpmInvocation(process.env.npm_execpath, args);
  runProcess(invocation.executable, invocation.args, invocation.windowsVerbatimArguments === true);
}

function runCargo(args, suppressStdout = false) {
  runProcess(resolveTool("CARGO", "CARGO_HOME", "cargo"), args, false, true, suppressStdout);
}

function runRustup(args, failClosed = true) {
  return runProcess(resolveTool("RUSTUP", "CARGO_HOME", "rustup"), args, false, failClosed);
}

function resolveTool(explicitName, homeName, basename) {
  if (process.env[explicitName] !== undefined) {
    return process.env[explicitName];
  }
  if (process.env[homeName] !== undefined) {
    return path.join(
      process.env[homeName],
      "bin",
      process.platform === "win32" ? `${basename}.exe` : basename,
    );
  }
  return basename;
}

function runProcess(
  executable,
  args,
  windowsVerbatimArguments,
  failClosed = true,
  suppressStdout = false,
) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 180_000,
    windowsHide: true,
    windowsVerbatimArguments,
  });
  if (!suppressStdout && result.stdout?.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr?.length > 0) {
    process.stderr.write(result.stderr);
  }
  if (result.error !== undefined || result.status !== 0) {
    if (!failClosed) {
      return { status: result.status, stdout: result.stdout ?? "" };
    }
    throw new Error(`${path.basename(executable)} ${args[0] ?? ""} 失败。`);
  }
  return { status: result.status, stdout: result.stdout ?? "" };
}

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8");
}

async function listFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result.sort(compareOrdinal);
}

function assertIncludes(source, fragments, label) {
  for (const fragment of fragments) {
    if (!source.includes(fragment)) {
      throw new Error(`${label}: 缺少 '${fragment}'。`);
    }
  }
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyHostPathPosixHelperV1()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "unknown verifier error"}\n`);
      process.exitCode = 1;
    });
}
