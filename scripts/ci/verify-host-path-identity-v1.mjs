import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gateId = "host-path-identity-win32-v1";
const sourcePath = "apps/graph-service/src/host-path-identity.ts";
const unitTestPath = "tests/unit/host-path-identity.test.ts";
const contractTestPath = "tests/contract/host-path-identity-win32.test.ts";
const dedicatedContractConfigPath = "vitest.contract.win32.config.ts";
const manifestTestPath = "tests/contract/quality-gates-manifest.test.ts";
const verifierPath = "scripts/ci/verify-host-path-identity-v1.mjs";
const triggerPaths = [
  "apps/graph-service/src/analyzer-config.ts",
  sourcePath,
  "apps/graph-service/src/index-job-runtime.ts",
  "apps/graph-service/src/index-read-set.ts",
  "apps/graph-service/src/index.ts",
  "apps/graph-service/src/workspace-scanner.ts",
  "ci/quality-gates.v1.yaml",
  "packages/adapters/analyzer-typescript/src/analyzer-worker.ts",
  "packages/adapters/analyzer-typescript/src/typescript-analyzer.ts",
  "packages/adapters/analyzer-typescript/src/worker-analysis.ts",
  "packages/application/src/ports/analyzer-port.ts",
  verifierPath,
  contractTestPath,
  manifestTestPath,
  "tests/unit/analyzer-config-capture.test.ts",
  unitTestPath,
  "tests/unit/index-job-runtime.test.ts",
  "tests/unit/index-read-set.test.ts",
  "tests/unit/typescript-analyzer-worker.test.ts",
  "tests/unit/typescript-module-resolution.test.ts",
];
const allowedProductionImports = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs/promises",
  "node:os",
  "node:path",
]);
const expectedProductionSourceDigest = "b4b75125b60cd0775bbad0492dd4555a5b8e41e7ba1181fe00f9f1dc7e4b1d64";
const expectedWindowsSnapshotScriptDigest = "67cea8cc0483baca6f2f226850a8c0b6b7cf0d2dac28047dbfe2fd13d226c863";
const requiredProductionCalls = new Map([
  ["HostPathIdentityBroker.resolveCandidates", [
    "prepareCandidates",
    "createCaptureNonce",
    "capture",
    "validateCompleteCapture",
    "createCapturedIdentityContext",
    "createPresentObservation",
    "buildAliasGroups",
    "createProof",
  ]],
  ["createDefaultHostPathIdentitySnapshotProvider", [
    "createSnapshotFailure",
    "captureWindows",
    "capturePosix",
  ]],
  ["prepareCandidates", ["validateAbsoluteHostPath", "createTrustedPath"]],
  ["capturePosixDeviceInodeSnapshot", [
    "capturePosixState",
    "createSnapshotFailure",
    "classifyNativeFailure",
    "readErrorCode",
    "digestJson",
  ]],
  ["capturePosixState", [
    "readPosixPathChain",
    "statfs",
    "createPosixObjectId",
    "toUnsignedHex",
    "containsPosixObject",
    "samePosixObject",
    "digestJson",
  ]],
  ["readPosixPathChain", ["createNativeCaptureError", "lstat"]],
  ["createPosixObjectId", ["toUnsignedHex"]],
  ["captureWindowsHandleSnapshot", [
    "mkdtemp",
    "writeFile",
    "runBoundedProcess",
    "parse",
    "isSnapshotCapture",
    "classifyNativeFailure",
    "rm",
  ]],
  ["createCapturedIdentityContext", ["digestJson"]],
  ["createPresentObservation", ["digestJson"]],
]);
/** PowerShell/Get-Volume 的内部安全 deadline 固定为 10 秒，禁止由调用方放宽。 */
export const WINDOWS_TEST_ROOT_PROBE_TIMEOUT_MS = 10_000;
const WINDOWS_GATE_ENVELOPE_SCHEMA_VERSION = 1;
const TRUSTED_WINDOWS_PREFLIGHT_ENV = "CODEGRAPH_TRUSTED_WIN32_PREFLIGHT_V1";
const MAX_TRUSTED_WINDOWS_PREFLIGHT_BYTES = 32 * 1024;

/** 独立校验完整生产闭包与固定原生脚本，执行 mutation oracle 后运行黑盒回归。 */
export async function verifyHostPathIdentityV1() {
  const source = await readVerifiedCandidateSource();
  validateHostPathIdentitySource(source, sourcePath);
  validateMutationOracle(source);
  await validateGateRegistration();

  const unitStatus = runVitest("vitest.config.ts", [unitTestPath]);
  if (unitStatus !== 0) {
    writeHostPathIdentityEnvelope({
      classification: "unit-suite-failure",
      outcome: "fail",
    });
    return unitStatus;
  }
  const preflight = runWindowsContractPreflight();
  if (!preflight.ok) {
    writeHostPathIdentityEnvelope({
      classification: preflight.classification,
      outcome: "fail",
      preflight: preflight.preflight,
    });
    return 1;
  }
  const suite = runVitestWithRequiredCounts(dedicatedContractConfigPath, contractTestPath);
  writeHostPathIdentityEnvelope({
    classification: suite.classification,
    outcome: suite.ok ? "pass" : "fail",
    preflight: preflight.preflight,
    suite: suite.suite,
  });
  return suite.ok ? 0 : 1;
}

/**
 * 读取实际工作树文件与 exact candidate Git blob，并要求二者只经 CRLF→LF 后绑定固定摘要。
 *
 * @param {{
 *   candidateRevision?: string;
 *   expectedDigest?: string;
 *   relativePath?: string;
 *   repositoryRoot?: string;
 * }} [options] 候选读取参数。
 * @returns {Promise<string>} 经唯一合法换行规范化后的生产源码。
 */
export async function readVerifiedCandidateSource(options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const relativePath = options.relativePath ?? sourcePath;
  const expectedDigest = options.expectedDigest ?? expectedProductionSourceDigest;
  const candidateRevision = options.candidateRevision ?? "HEAD";
  if (
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("host identity 源码路径必须是规范仓库相对 POSIX path。");
  }
  const workingTreeBytes = await readFile(path.join(root, ...relativePath.split("/")));
  const candidate = spawnSync(
    "git",
    ["rev-parse", "--verify", `${candidateRevision}^{commit}`],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  const candidateSha = candidate.stdout?.trim();
  if (
    candidate.error !== undefined ||
    candidate.status !== 0 ||
    candidateSha === undefined ||
    !/^[a-f0-9]{40}$/u.test(candidateSha)
  ) {
    throw new Error("host identity exact candidate commit 无法解析。");
  }
  const blob = spawnSync(
    "git",
    ["cat-file", "blob", `${candidateSha}:${relativePath}`],
    { cwd: root, encoding: null, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  );
  if (blob.error !== undefined || blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
    throw new Error("host identity exact candidate Git blob 缺失或无法读取。");
  }
  return validateCandidateSourceIdentity({
    expectedDigest,
    gitBlobBytes: blob.stdout,
    relativePath,
    workingTreeBytes,
  });
}

/**
 * 严格校验工作树与 Git blob 的 UTF-8 表示、唯一换行规范化和三方摘要闭合。
 *
 * @param {{
 *   expectedDigest: string;
 *   gitBlobBytes: Buffer;
 *   relativePath?: string;
 *   workingTreeBytes: Buffer;
 * }} input 待闭合的两份候选字节。
 * @returns {string} 工作树规范文本。
 */
export function validateCandidateSourceIdentity(input) {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedDigest)) {
    throw new Error("host identity 固定期望摘要格式非法。");
  }
  const label = input.relativePath ?? sourcePath;
  const workingTreeSource = canonicalizeStrictUtf8(input.workingTreeBytes, `${label} 工作树`);
  const gitBlobSource = canonicalizeStrictUtf8(input.gitBlobBytes, `${label} Git blob`);
  const workingTreeDigest = createHash("sha256")
    .update(workingTreeSource, "utf8")
    .digest("hex");
  const gitBlobDigest = createHash("sha256").update(gitBlobSource, "utf8").digest("hex");
  if (
    workingTreeDigest !== gitBlobDigest ||
    workingTreeDigest !== input.expectedDigest ||
    gitBlobDigest !== input.expectedDigest
  ) {
    throw new Error(
      `${label}: 工作树 canonical digest、exact candidate Git blob digest 与固定期望 digest 未闭合。`,
    );
  }
  return workingTreeSource;
}

/**
 * 为 Win32 Hosted 分区优先绑定 Harness 注入的专用 pnpm.exe；专用值存在但非法时禁止回退。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment 受控 Gate 环境。
 * @param {string[]} args pnpm 参数。
 * @returns {{ args: string[]; executable: string; windowsVerbatimArguments?: boolean }} shell:false 调用形状。
 */
export function createHostPathIdentityPnpmInvocation(environment, args) {
  const trustedExecutable = environment.CODEGRAPH_TRUSTED_PNPM_EXE;
  if (trustedExecutable !== undefined) {
    const nativeAbsolute = path.isAbsolute(trustedExecutable);
    const win32Absolute = path.win32.isAbsolute(trustedExecutable);
    const isLocalWindowsPath = !win32Absolute || /^[a-z]:[\\/]/iu.test(trustedExecutable);
    const basename = win32Absolute
      ? path.win32.basename(trustedExecutable)
      : path.basename(trustedExecutable);
    if (
      trustedExecutable.length === 0 ||
      trustedExecutable.includes("\0") ||
      (!nativeAbsolute && !win32Absolute) ||
      !isLocalWindowsPath ||
      basename.toLowerCase() !== "pnpm.exe"
    ) {
      throw new Error(
        "Win32 host identity 专用 pnpm launcher 必须是绝对本地 pnpm.exe，且非法时禁止回退。",
      );
    }
    return { args, executable: trustedExecutable };
  }
  return createPnpmInvocation(environment.npm_execpath, args);
}

/**
 * 以 shell:false 执行解析后的 pnpm 调用，并保持 Harness 提供的 sanitized env 不扩散。
 *
 * @param {string[]} args pnpm 参数。
 * @param {{
 *   environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
 *   spawnOptions?: import("node:child_process").SpawnSyncOptions;
 * }} [options] 可测试的进程边界。
 * @returns {import("node:child_process").SpawnSyncReturns<Buffer | string>} 同步执行结果。
 */
export function runHostPathIdentityPnpm(args, options = {}) {
  const environment = options.environment ?? process.env;
  const invocation = createHostPathIdentityPnpmInvocation(environment, args);
  recordHostPathIdentityInvocation(environment, invocation, args);
  return spawnSync(invocation.executable, invocation.args, {
    ...(options.spawnOptions ?? {}),
    env: environment,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
}

/**
 * 将固定可信 launcher 与 shell:false 实际调用写入 Harness 指定的有界结构化证明文件。
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} environment 受控 Gate 环境。
 * @param {{args:string[],executable:string,windowsVerbatimArguments?:boolean}} invocation 实际调用。
 * @param {string[]} args 调用参数，仅记录摘要。
 */
function recordHostPathIdentityInvocation(environment, invocation, args) {
  const attestationPath = environment.CODEGRAPH_HOST_PATH_IDENTITY_ATTESTATION_PATH;
  if (attestationPath === undefined) {
    return;
  }
  if (!path.isAbsolute(attestationPath) || attestationPath.includes("\0")) {
    throw new Error("host identity invocation attestation 路径必须是绝对普通路径。");
  }
  const trustedExecutable = environment.CODEGRAPH_TRUSTED_PNPM_EXE;
  if (
    trustedExecutable === undefined ||
    invocation.executable !== trustedExecutable ||
    environment.npm_execpath !== undefined
  ) {
    throw new Error("host identity invocation attestation 未绑定 absent npm_execpath 与可信 launcher。");
  }
  let previous = { invocations: [] };
  try {
    previous = JSON.parse(readFileSync(attestationPath, "utf8"));
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  const invocations = Array.isArray(previous.invocations) ? previous.invocations : [];
  if (invocations.length >= 8) {
    throw new Error("host identity invocation attestation 超过固定事件上限。");
  }
  invocations.push({
    argsSha256: createHash("sha256").update(JSON.stringify(args), "utf8").digest("hex"),
    executable: invocation.executable,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
  writeFileSync(attestationPath, `${JSON.stringify({
    invocations,
    npmExecPathAbsent: true,
    pathLookupBypassed: true,
    processPlatform: process.platform,
    schemaVersion: 1,
    trustedExecutable,
  })}\n`, { encoding: "utf8", flag: "w" });
}

/** 将 spawnSync 的文本输出收敛为有界 UTF-8 字符串。 */
function boundedProcessText(value) {
  if (typeof value === "string") {
    return value.slice(0, 8_192);
  }
  return Buffer.isBuffer(value) ? value.toString("utf8", 0, 8_192) : "";
}

/**
 * 将 Harness 已验证的外层 Win32 preflight 重新绑定到当前 dedicated 根。
 *
 * @param {{
 *   base: object;
 *   candidateRoot: string;
 *   driveLetter: string;
 *   environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
 * }} input 可信外层证明及当前进程边界。
 * @returns {{classification:string;ok:boolean;preflight:object}|null} 无 Hosted 标记时返回 null。
 */
function reuseTrustedWindowsContractPreflight(input) {
  const serialized = input.environment[TRUSTED_WINDOWS_PREFLIGHT_ENV];
  const trustedLauncher = input.environment.CODEGRAPH_TRUSTED_PNPM_EXE;
  if (serialized === undefined && trustedLauncher === undefined) {
    return null;
  }
  const fail = (code, proof) => ({
    classification: "preflight-trusted-proof-invalid",
    ok: false,
    preflight: {
      ...input.base,
      code,
      source: "trusted-outer-preflight-v1",
      ...(proof === undefined ? {} : { proof }),
    },
  });
  if (trustedLauncher === undefined) {
    return fail("TRUSTED_PREFLIGHT_UNBOUND");
  }
  if (serialized === undefined) {
    return fail("TRUSTED_PREFLIGHT_MISSING");
  }
  if (
    serialized.length === 0 ||
    serialized.includes("\0") ||
    Buffer.byteLength(serialized, "utf8") > MAX_TRUSTED_WINDOWS_PREFLIGHT_BYTES
  ) {
    return fail("TRUSTED_PREFLIGHT_INVALID_ENVELOPE");
  }
  let proof;
  try {
    proof = JSON.parse(serialized);
  } catch {
    return fail("TRUSTED_PREFLIGHT_INVALID_JSON");
  }
  if (
    proof === null ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    proof.schemaVersion !== 1 ||
    proof.processPlatform !== "win32" ||
    proof.getVolume === null ||
    typeof proof.getVolume !== "object" ||
    Array.isArray(proof.getVolume)
  ) {
    return fail("TRUSTED_PREFLIGHT_INVALID_ENVELOPE");
  }
  if (proof.getVolume.timeout !== false || proof.getVolume.status !== 0) {
    return fail("TRUSTED_PREFLIGHT_QUERY_FAILED", proof);
  }
  if (
    !Number.isInteger(proof.probeDurationMs) ||
    proof.probeDurationMs < 0 ||
    proof.probeDurationMs > WINDOWS_TEST_ROOT_PROBE_TIMEOUT_MS
  ) {
    return fail("TRUSTED_PREFLIGHT_DEADLINE_DRIFT", proof);
  }
  if (
    typeof proof.selectedRoot !== "string" ||
    path.win32.resolve(proof.selectedRoot).toLowerCase() !== input.candidateRoot.toLowerCase()
  ) {
    return fail("TRUSTED_PREFLIGHT_ROOT_MISMATCH", proof);
  }
  if (
    proof.drive !== input.driveLetter ||
    proof.fileSystem !== "NTFS" ||
    proof.driveType !== "Fixed" ||
    proof.root?.ordinary !== true ||
    proof.root?.reparse !== false
  ) {
    return fail("TRUSTED_PREFLIGHT_UNSAFE_ROOT", proof);
  }
  const processEvidence = {
    ...input.base,
    getVolume: {
      status: proof.getVolume.status,
      stderr: boundedProcessText(proof.getVolume.stderr),
      stdout: boundedProcessText(proof.getVolume.stdout),
      timeout: false,
    },
    source: "trusted-outer-preflight-v1",
    trustedOuterProofSha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
  };
  return {
    classification: "preflight-pass",
    ok: true,
    preflight: {
      ...processEvidence,
      code: "OK",
      probe: {
        drive: proof.drive,
        driveType: proof.driveType,
        fileSystem: proof.fileSystem,
        ordinary: proof.root.ordinary,
        reparse: proof.root.reparse,
        root: input.candidateRoot,
      },
    },
  };
}

/**
 * 在 dedicated Vitest 启动前独立证明真实 Win32 固定 NTFS 根。
 *
 * @param {{
 *   environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
 *   platform?: NodeJS.Platform;
 *   spawnSyncImpl?: typeof spawnSync;
 *   testRoot?: string;
 * }} [options] 仅用于隔离平台边界的测试依赖。
 * @returns {{classification:string;ok:boolean;preflight:object}} reporter 外的封闭结果。
 */
export function runWindowsContractPreflight(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const candidateRoot = path.win32.resolve(options.testRoot ?? tmpdir());
  const base = {
    candidateRoot,
    getVolume: { status: null, stderr: "", stdout: "", timeout: false },
    processPlatform: platform,
  };
  if (platform !== "win32") {
    return {
      classification: "preflight-unsafe-root",
      ok: false,
      preflight: { ...base, code: "NON_WIN32" },
    };
  }
  const driveLetter = path.win32.parse(candidateRoot).root.match(/^([A-Za-z]):\\$/u)?.[1];
  if (driveLetter === undefined) {
    return {
      classification: "preflight-unsafe-root",
      ok: false,
      preflight: { ...base, code: "ROOT_WITHOUT_DRIVE" },
    };
  }
  const trustedPreflight = reuseTrustedWindowsContractPreflight({
    base,
    candidateRoot,
    driveLetter,
    environment,
  });
  if (trustedPreflight !== null) {
    return trustedPreflight;
  }
  const result = (options.spawnSyncImpl ?? spawnSync)(
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
      env: { ...environment, CODEGRAPH_CONTRACT_TMPDIR: candidateRoot },
      shell: false,
      timeout: WINDOWS_TEST_ROOT_PROBE_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const spawnErrorCode = result.error?.code;
  const processEvidence = {
    ...base,
    getVolume: {
      status: result.status,
      stderr: boundedProcessText(result.stderr),
      stdout: boundedProcessText(result.stdout),
      timeout: spawnErrorCode === "ETIMEDOUT",
    },
  };
  if (spawnErrorCode === "ETIMEDOUT") {
    return {
      classification: "preflight-timeout",
      ok: false,
      preflight: { ...processEvidence, code: "GET_VOLUME_TIMEOUT" },
    };
  }
  if (result.error !== undefined || result.status !== 0) {
    return {
      classification: "preflight-process-error",
      ok: false,
      preflight: {
        ...processEvidence,
        code: "GET_VOLUME_PROCESS_ERROR",
        processErrorCode: typeof spawnErrorCode === "string" ? spawnErrorCode : null,
      },
    };
  }
  let probe;
  try {
    probe = JSON.parse(processEvidence.getVolume.stdout);
  } catch {
    return {
      classification: "preflight-invalid-json",
      ok: false,
      preflight: { ...processEvidence, code: "GET_VOLUME_INVALID_JSON" },
    };
  }
  if (
    probe === null ||
    typeof probe !== "object" ||
    Array.isArray(probe) ||
    probe.fileSystem !== "NTFS" ||
    probe.driveType !== "Fixed" ||
    probe.ordinary !== true ||
    probe.reparse !== false ||
    typeof probe.root !== "string" ||
    path.win32.resolve(probe.root).toLowerCase() !== candidateRoot.toLowerCase()
  ) {
    return {
      classification: "preflight-unsafe-root",
      ok: false,
      preflight: { ...processEvidence, code: "UNSAFE_TEST_ROOT", probe },
    };
  }
  return {
    classification: "preflight-pass",
    ok: true,
    preflight: { ...processEvidence, code: "OK", probe },
  };
}

/** 将 verifier 的最终结论序列化为唯一单行 JSON envelope。 */
export function serializeHostPathIdentityEnvelope(result) {
  return JSON.stringify({
    schemaVersion: WINDOWS_GATE_ENVELOPE_SCHEMA_VERSION,
    gateId,
    outcome: result.outcome,
    classification: result.classification,
    ...(result.preflight === undefined ? {} : { preflight: result.preflight }),
    ...(result.suite === undefined ? {} : { suite: result.suite }),
  });
}

/** 将最终 envelope 写到 reporter 之外的 stdout，保证成功与失败使用同一通道。 */
function writeHostPathIdentityEnvelope(result) {
  process.stdout.write(`${serializeHostPathIdentityEnvelope(result)}\n`);
}

/**
 * 只接受无 BOM/NUL、合法 UTF-8 且换行仅为 LF 或 CRLF 的字节，并规范化 CRLF。
 *
 * @param {Buffer} bytes 原始文件字节。
 * @param {string} label 诊断标签。
 * @returns {string} 规范 UTF-8 文本。
 */
function canonicalizeStrictUtf8(bytes, label) {
  if (
    bytes.includes(0) ||
    (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  ) {
    throw new Error(`${label}: BOM 或 NUL 表示不受信任。`);
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: 文件不是严格合法 UTF-8。`);
  }
  if (source.includes("\uFEFF") || /\r(?!\n)/u.test(source)) {
    throw new Error(`${label}: BOM 或 lone CR 表示不受信任。`);
  }
  return source.replaceAll("\r\n", "\n");
}

/** 读取标识符、this 与属性访问组成的静态访问链，私有字段仅用于精确 broker 装配校验。 */
function readAccessPath(node) {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) {
    return ["this"];
  }
  if (ts.isPropertyAccessExpression(node)) {
    const prefix = readAccessPath(node.expression);
    if (prefix === null) {
      return null;
    }
    const name = node.name.text;
    return [...prefix, name === "#snapshotProvider" ? "snapshotProvider" : name];
  }
  return null;
}

/** 静态访问链必须逐段完全相等，禁止用源码 substring 或正则近似。 */
function accessPathEquals(node, expected) {
  const actual = readAccessPath(node);
  return actual !== null &&
    actual.length === expected.length &&
    actual.every((part, index) => part === expected[index]);
}

/** 比较 AST literal，布尔值使用 SyntaxKind 而不是源码文本。 */
function literalEquals(node, expected) {
  if (typeof expected === "string") {
    return ts.isStringLiteral(node) && node.text === expected;
  }
  if (expected === true) {
    return node.kind === ts.SyntaxKind.TrueKeyword;
  }
  if (expected === false) {
    return node.kind === ts.SyntaxKind.FalseKeyword;
  }
  return false;
}

/** 匹配左侧访问链与右侧访问链组成的精确二元表达式。 */
function isBinaryAccessComparison(node, left, operator, right) {
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind === operator &&
    accessPathEquals(node.left, left) &&
    accessPathEquals(node.right, right);
}

/** 匹配左侧访问链与右侧 literal 组成的精确二元表达式。 */
function isBinaryAccessLiteralComparison(node, left, operator, right) {
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind === operator &&
    accessPathEquals(node.left, left) &&
    literalEquals(node.right, right);
}

/** 匹配左侧访问链与右侧标识符组成的精确二元表达式。 */
function isBinaryAccessIdentifierComparison(node, left, operator, identifier) {
  return ts.isBinaryExpression(node) &&
    node.operatorToken.kind === operator &&
    accessPathEquals(node.left, left) &&
    ts.isIdentifier(node.right) &&
    node.right.text === identifier;
}

/** 在给定 AST 子树内收集全部满足条件的节点。 */
function collectAstNodes(root, predicate) {
  const matches = [];
  /** 深度遍历只消费 TypeScript AST，不读取或扫描源码文本。 */
  function visit(node) {
    if (predicate(node)) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return matches;
}

/** 子树只要存在一个满足条件的 AST 节点即返回 true。 */
function hasAstNode(root, predicate) {
  return collectAstNodes(root, predicate).length > 0;
}

/** 对象属性名只接受静态 identifier/string 名称。 */
function objectPropertyName(property) {
  if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
    return property.name.text;
  }
  return null;
}

/** 找到对象字面量中唯一的静态属性。 */
function findObjectProperty(objectLiteral, name) {
  const matches = objectLiteral.properties.filter((property) => objectPropertyName(property) === name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 判断语句子树是否返回精确的单参数静态调用。 */
function hasReturnCall(root, callableName, argumentName = "request") {
  return hasAstNode(root, (node) =>
    ts.isReturnStatement(node) &&
    node.expression !== undefined &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === callableName &&
    node.expression.arguments.length === 1 &&
    ts.isIdentifier(node.expression.arguments[0]) &&
    node.expression.arguments[0].text === argumentName
  );
}

/** 判断语句子树是否返回精确的 fail-closed HostPath failure。 */
function hasSnapshotFailureReturn(root, status, code, retryable) {
  return hasAstNode(root, (node) =>
    ts.isReturnStatement(node) &&
    node.expression !== undefined &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "createSnapshotFailure" &&
    node.expression.arguments.length === 3 &&
    literalEquals(node.expression.arguments[0], status) &&
    literalEquals(node.expression.arguments[1], code) &&
    literalEquals(node.expression.arguments[2], retryable)
  );
}

/** 校验 factory 的原生 fallback 只能静态绑定到指定生产 capture。 */
function validateNativeFallbackBinding(factory, variableName, optionName, nativeName, violations) {
  const declarations = collectAstNodes(factory, (node) =>
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === variableName
  );
  const initializer = declarations.length === 1 ? declarations[0].initializer : undefined;
  if (
    initializer === undefined ||
    !ts.isBinaryExpression(initializer) ||
    initializer.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
    !accessPathEquals(initializer.left, ["options", optionName]) ||
    !ts.isIdentifier(initializer.right) ||
    initializer.right.text !== nativeName
  ) {
    violations.push(`provider factory 的 '${variableName}' 未静态绑定 '${nativeName}'。`);
  }
}

/** 校验 broker 默认装配、平台 dispatch 与能力缺失路径全部结构化 fail-closed。 */
function validateProviderFactoryStructure(sourceFile, brokerConstructorBody, violations) {
  const factories = collectAstNodes(sourceFile, (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "createDefaultHostPathIdentitySnapshotProvider"
  );
  const factory = factories.length === 1 ? factories[0] : undefined;
  if (factory?.body === undefined) {
    violations.push("生产模块缺少唯一默认 HostPath provider factory。");
    return;
  }
  validateNativeFallbackBinding(
    factory,
    "captureWindows",
    "captureWindows",
    "captureWindowsHandleSnapshot",
    violations,
  );
  validateNativeFallbackBinding(
    factory,
    "capturePosix",
    "capturePosix",
    "capturePosixDeviceInodeSnapshot",
    violations,
  );

  const returnedObjects = collectAstNodes(factory.body, (node) =>
    ts.isReturnStatement(node) && node.expression !== undefined && ts.isObjectLiteralExpression(node.expression)
  );
  const providerObject = returnedObjects.length === 1 ? returnedObjects[0].expression : undefined;
  const captureProperty = providerObject === undefined
    ? undefined
    : findObjectProperty(providerObject, "capture");
  const captureFunction = captureProperty !== undefined && ts.isPropertyAssignment(captureProperty) &&
      (ts.isArrowFunction(captureProperty.initializer) || ts.isFunctionExpression(captureProperty.initializer))
    ? captureProperty.initializer
    : undefined;
  if (captureFunction === undefined || !ts.isBlock(captureFunction.body)) {
    violations.push("provider factory 必须返回唯一的结构化 capture dispatch。");
    return;
  }

  const mismatchBranches = collectAstNodes(captureFunction.body, (node) =>
    ts.isIfStatement(node) &&
    isBinaryAccessComparison(
      node.expression,
      ["request", "platform"],
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ["options", "platform"],
    )
  );
  if (
    mismatchBranches.length !== 1 ||
    !hasSnapshotFailureReturn(
      mismatchBranches[0].thenStatement,
      "unsupported",
      "HOST_PATH_PROVIDER_PLATFORM_MISMATCH",
      false,
    )
  ) {
    violations.push("provider factory 的平台不匹配路径未精确 fail-closed。");
  }

  const win32Branches = collectAstNodes(captureFunction.body, (node) =>
    ts.isIfStatement(node) &&
    isBinaryAccessLiteralComparison(
      node.expression,
      ["request", "platform"],
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      "win32",
    )
  );
  const win32Branch = win32Branches.length === 1 ? win32Branches[0] : undefined;
  const win32NativeGuard = win32Branch === undefined
    ? []
    : collectAstNodes(win32Branch.thenStatement, (node) =>
      ts.isIfStatement(node) &&
      hasAstNode(node.expression, (entry) =>
        ts.isPrefixUnaryExpression(entry) &&
        entry.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(entry.operand) &&
        entry.operand.text === "injectedWindows"
      ) &&
      hasAstNode(node.expression, (entry) =>
        isBinaryAccessLiteralComparison(
          entry,
          ["process", "platform"],
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          "win32",
        )
      )
    );
  if (
    win32Branch === undefined ||
    !hasReturnCall(win32Branch.thenStatement, "captureWindows") ||
    win32NativeGuard.length !== 1 ||
    !hasSnapshotFailureReturn(
      win32NativeGuard[0].thenStatement,
      "unsupported",
      "HOST_PATH_IDENTITY_UNSUPPORTED",
      false,
    )
  ) {
    violations.push("provider factory 的 Win32 原生 dispatch 或宿主保护不完整。");
  }

  const posixFailureBranches = collectAstNodes(captureFunction.body, (node) =>
    ts.isIfStatement(node) &&
    hasAstNode(node.expression, (entry) => accessPathEquals(entry, ["options", "caseSensitiveFileNames"])) &&
    hasAstNode(node.expression, (entry) => isBinaryAccessLiteralComparison(
      entry,
      ["request", "platform"],
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      "darwin",
    )) &&
    hasAstNode(node.expression, (entry) => isBinaryAccessLiteralComparison(
      entry,
      ["request", "platform"],
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      "linux",
    )) &&
    hasAstNode(node.expression, (entry) =>
      ts.isPrefixUnaryExpression(entry) &&
      entry.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(entry.operand) &&
      entry.operand.text === "injectedPosix"
    ) &&
    hasAstNode(node.expression, (entry) => isBinaryAccessComparison(
      entry,
      ["process", "platform"],
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ["request", "platform"],
    ))
  );
  if (
    posixFailureBranches.length !== 1 ||
    !hasSnapshotFailureReturn(
      posixFailureBranches[0].thenStatement,
      "unsupported",
      "HOST_PATH_IDENTITY_UNSUPPORTED",
      false,
    ) ||
    !hasReturnCall(captureFunction.body, "capturePosix")
  ) {
    violations.push("provider factory 的非 Win32 能力保护或 POSIX dispatch 不完整。");
  }

  if (brokerConstructorBody === undefined) {
    violations.push("HostPathIdentityBroker 缺少默认 provider 装配构造器。");
    return;
  }
  const providerAssignments = collectAstNodes(brokerConstructorBody, (node) =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    accessPathEquals(node.left, ["this", "snapshotProvider"])
  );
  const providerInitializer = providerAssignments.length === 1 ? providerAssignments[0].right : undefined;
  const providerFactoryCall = providerInitializer !== undefined &&
      ts.isBinaryExpression(providerInitializer) &&
      providerInitializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      accessPathEquals(providerInitializer.left, ["options", "snapshotProvider"]) &&
      ts.isCallExpression(providerInitializer.right) &&
      ts.isIdentifier(providerInitializer.right.expression) &&
      providerInitializer.right.expression.text === "createDefaultHostPathIdentitySnapshotProvider"
    ? providerInitializer.right
    : undefined;
  const providerOptions = providerFactoryCall?.arguments.length === 1 &&
      ts.isObjectLiteralExpression(providerFactoryCall.arguments[0])
    ? providerFactoryCall.arguments[0]
    : undefined;
  const caseSensitiveProperty = providerOptions === undefined
    ? undefined
    : findObjectProperty(providerOptions, "caseSensitiveFileNames");
  const platformProperty = providerOptions === undefined
    ? undefined
    : findObjectProperty(providerOptions, "platform");
  if (
    providerFactoryCall === undefined ||
    caseSensitiveProperty === undefined ||
    platformProperty === undefined
  ) {
    violations.push("HostPathIdentityBroker 默认路径未调用 provider factory 并传递平台能力。");
  }
}

/** 校验 complete capture 只能接受固定 Win32 或大小写不敏感 POSIX 对象能力。 */
function validateCapabilityDispatchStructure(sourceFile, violations) {
  const validators = collectAstNodes(sourceFile, (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "validateCompleteCapture"
  );
  const validator = validators.length === 1 ? validators[0] : undefined;
  if (validator?.body === undefined) {
    violations.push("生产模块缺少唯一 complete capture 能力校验。");
    return;
  }
  const declarations = new Map();
  for (const node of collectAstNodes(validator.body, (entry) => ts.isVariableDeclaration(entry))) {
    if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
      declarations.set(node.name.text, node.initializer);
    }
  }
  const win32 = declarations.get("win32Capability");
  const posix = declarations.get("posixCapability");
  const requiredWin32 = [
    ["fileSystemType", "NTFS"],
    ["fileIdInfo", true],
    ["fixedVolume", true],
  ];
  const requiredPosix = [
    ["fileSystemType", "POSIX"],
    ["fileIdInfo", false],
    ["fixedVolume", true],
    ["objectIdentityKind", "device-inode"],
    ["caseSensitiveFileNames", false],
  ];
  const win32Valid = win32 !== undefined && requiredWin32.every(([field, value]) =>
    hasAstNode(win32, (node) => isBinaryAccessLiteralComparison(
      node,
      ["capture", "capability", field],
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      value,
    ))
  ) && hasAstNode(win32, (node) => isBinaryAccessIdentifierComparison(
    node,
    ["capture", "capability", "snapshotFence"],
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    "WINDOWS_SNAPSHOT_FENCE",
  ));
  const posixValid = posix !== undefined && requiredPosix.every(([field, value]) =>
    hasAstNode(posix, (node) => isBinaryAccessLiteralComparison(
      node,
      ["capture", "capability", field],
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      value,
    ))
  ) && hasAstNode(posix, (node) => isBinaryAccessIdentifierComparison(
    node,
    ["capture", "capability", "snapshotFence"],
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    "POSIX_SNAPSHOT_FENCE",
  ));
  const rejectionBranches = collectAstNodes(validator.body, (node) =>
    ts.isIfStatement(node) &&
    hasAstNode(node.expression, (entry) =>
      ts.isPrefixUnaryExpression(entry) &&
      entry.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(entry.operand) &&
      entry.operand.text === "win32Capability"
    ) &&
    hasAstNode(node.expression, (entry) =>
      ts.isPrefixUnaryExpression(entry) &&
      entry.operator === ts.SyntaxKind.ExclamationToken &&
      ts.isIdentifier(entry.operand) &&
      entry.operand.text === "posixCapability"
    )
  );
  if (
    !win32Valid ||
    !posixValid ||
    rejectionBranches.length !== 1 ||
    !hasAstNode(rejectionBranches[0].thenStatement, (node) =>
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "createFailure" &&
      node.expression.arguments.length === 3 &&
      literalEquals(node.expression.arguments[0], "unsupported") &&
      literalEquals(node.expression.arguments[1], "HOST_PATH_IDENTITY_UNSUPPORTED") &&
      literalEquals(node.expression.arguments[2], false)
    )
  ) {
    violations.push("complete capture 未封闭校验 Win32/POSIX 能力与 fail-closed 分支。");
  }
}

/** 使用 AST 起止偏移应用唯一结构变异；目标不唯一即使 oracle 自身失败。 */
function applySingleAstMutation(source, mutation) {
  const sourceFile = ts.createSourceFile(
    "host-path-identity-mutation.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches = collectAstNodes(sourceFile, mutation.select);
  if (matches.length !== 1) {
    throw new Error(`${mutation.label}: AST 变异目标必须唯一，实际 ${matches.length}。`);
  }
  const target = mutation.target === undefined ? matches[0] : mutation.target(matches[0]);
  return `${source.slice(0, target.getStart(sourceFile))}${mutation.replacement}${source.slice(target.end)}`;
}

/**
 * 正向封闭完整生产源码、依赖边与关键调用图，不依赖有限语法或字符串黑名单。
 *
 * @param {string} source 待检查的 TypeScript 模块源码。
 * @param {string} modulePath 用于稳定诊断的仓库相对路径。
 */
export function validateHostPathIdentitySource(source, modulePath = sourcePath) {
  validateHostPathIdentitySourceInternal(source, modulePath, true);
}

/**
 * 结构化完整性校验可以在 mutation oracle 中关闭固定摘要，证明调用图本身会拒绝绕过。
 *
 * @param {string} source 待检查源码。
 * @param {string} modulePath 稳定诊断路径。
 * @param {boolean} enforceSourceDigest 是否同时锁定完整规范化源码摘要。
 */
function validateHostPathIdentitySourceInternal(source, modulePath, enforceSourceDigest) {
  if (/\r(?!\n)/u.test(source)) {
    throw new Error(`${modulePath}: host identity 源码包含不受信任的 lone CR。`);
  }
  source = source.replaceAll("\r\n", "\n");
  const sourceFile = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];
  const imports = new Set();
  const observedProductionCalls = new Map();
  let brokerConstructorBody;
  let windowsSnapshotScript;

  /** 记录指定函数或方法体内实际存在的直接与回调调用目标。 */
  function recordCalls(callableName, body) {
    const calls = new Set();

    /** 收集调用表达式的静态目标名称。 */
    function collect(node) {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          calls.add(node.expression.text);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          calls.add(node.expression.name.text);
        }
      }
      ts.forEachChild(node, collect);
    }

    collect(body);
    observedProductionCalls.set(callableName, calls);
  }

  /** 遍历完整 AST，建立封闭依赖集合和生产调用图证据。 */
  function visit(node) {
    if (ts.isImportEqualsDeclaration(node)) {
      violations.push("生产依赖闭包只允许五条固定静态 import。");
    }
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        violations.push("生产 import 必须使用静态字符串 specifier。");
      } else {
        const specifier = node.moduleSpecifier.text;
        imports.add(specifier);
        if (!allowedProductionImports.has(specifier)) {
          violations.push(`生产依赖闭包不允许 '${specifier}'。`);
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      violations.push("生产依赖闭包不允许 export-from 边。");
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      violations.push("生产依赖闭包不允许 dynamic import 边。");
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === "HostPathIdentityBroker"
    ) {
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
          brokerConstructorBody = member.body;
        }
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "resolveCandidates" &&
          member.body !== undefined
        ) {
          recordCalls("HostPathIdentityBroker.resolveCandidates", member.body);
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined &&
      requiredProductionCalls.has(node.name.text)
    ) {
      recordCalls(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "nativeSnapshotProvider"
    ) {
      violations.push("生产模块不得保留绕过 provider factory 的第二套默认身份实现。");
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "WINDOWS_HOST_IDENTITY_SNAPSHOT_SCRIPT" &&
      node.initializer !== undefined
    ) {
      const initializer = node.initializer;
      if (
        ts.isTaggedTemplateExpression(initializer) &&
        ts.isNoSubstitutionTemplateLiteral(initializer.template)
      ) {
        windowsSnapshotScript = initializer.template.rawText ?? initializer.template.text;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  validateProviderFactoryStructure(sourceFile, brokerConstructorBody, violations);
  validateCapabilityDispatchStructure(sourceFile, violations);
  const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");
  if (enforceSourceDigest && sourceDigest !== expectedProductionSourceDigest) {
    violations.push("生产模块完整源码摘要漂移，存在未审计的第二套身份语义。");
  }
  for (const required of allowedProductionImports) {
    if (!imports.has(required)) {
      violations.push(`生产依赖闭包缺少 '${required}'。`);
    }
  }
  if (imports.size !== allowedProductionImports.size) {
    violations.push("生产依赖闭包必须精确等于五个 Node 内建模块。");
  }
  for (const [callableName, requiredCalls] of requiredProductionCalls) {
    const calls = observedProductionCalls.get(callableName);
    if (calls === undefined) {
      violations.push(`生产调用图缺少 '${callableName}'。`);
      continue;
    }
    for (const requiredCall of requiredCalls) {
      if (!calls.has(requiredCall)) {
        violations.push(`生产调用图 '${callableName}' 缺少 '${requiredCall}'。`);
      }
    }
  }
  if (windowsSnapshotScript === undefined) {
    violations.push("生产模块缺少固定 Windows 原生句柄快照脚本。");
  } else {
    const digest = createHash("sha256").update(windowsSnapshotScript, "utf8").digest("hex");
    if (digest !== expectedWindowsSnapshotScriptDigest) {
      violations.push("Windows 原生句柄快照脚本摘要漂移。");
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `${modulePath}: host identity 正向合同失败。Fix: 保持完整源码闭包、root-derived mapping、FILE_ID_INFO 与句柄租约调用图。\n${[
        ...new Set(violations),
      ].join("\n")}`,
    );
  }
}

/**
 * 固定变异集同时验证完整源码摘要和 provider factory/platform/capability 结构合同。
 * 结构变异通过 AST 精确定位目标节点，并在关闭摘要后仍必须被正向调用图拒绝。
 */
export function validateMutationOracle(source) {
  const mutations = [
    `const mutationMember=["to","LowerCase"].join(""); export const mutationValue="A"[mutationMember]();`,
    `import { createRequire as mutationCreateRequire } from "node:module"; mutationCreateRequire(import.meta.url)("./helper.cjs");`,
    `export const mutationReflect=Reflect.apply(String.prototype.toLowerCase,"A",[]);`,
    `import mutationHelper = require("./helper.cjs"); export { mutationHelper };`,
    `import mutationVm from "node:vm"; export const mutationVmValue=mutationVm.runInNewContext("identity()");`,
    `export const mutationEval=eval("identity()");`,
    `export const mutationFunction=Function("return identity()")();`,
    `import { identity as mutationIdentity } from "./helper.js"; export { mutationIdentity };`,
    `export const mutationBirthtime=(value)=>value.birthtimeNs;`,
  ];
  for (const [index, mutation] of mutations.entries()) {
    let rejected = false;
    try {
      validateHostPathIdentitySource(`${source}\n${mutation}\n`, `mutation-oracle-${index}.ts`);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`mutation-oracle-${index}: verifier 未拒绝固定绕过样本。`);
    }
  }

  const structuralMutations = [
    {
      label: "broker-default-provider-factory",
      replacement: "captureWindowsHandleSnapshot",
      select: (node) => ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createDefaultHostPathIdentitySnapshotProvider",
    },
    {
      label: "win32-native-binding",
      replacement: "options.captureWindows ?? capturePosixDeviceInodeSnapshot",
      select: (node) => ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "captureWindows" &&
        node.initializer !== undefined,
      target: (node) => node.initializer,
    },
    {
      label: "posix-native-binding",
      replacement: "options.capturePosix ?? captureWindowsHandleSnapshot",
      select: (node) => ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "capturePosix" &&
        node.initializer !== undefined,
      target: (node) => node.initializer,
    },
    {
      label: "platform-mismatch-fail-closed",
      replacement: "request.platform === options.platform",
      select: (node) => isBinaryAccessComparison(
        node,
        ["request", "platform"],
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ["options", "platform"],
      ),
    },
    {
      label: "case-sensitive-posix-fail-closed",
      replacement: "false",
      select: (node) => ts.isIfStatement(node) &&
        hasAstNode(node.expression, (entry) =>
          accessPathEquals(entry, ["options", "caseSensitiveFileNames"])
        ) &&
        hasAstNode(node.expression, (entry) => isBinaryAccessLiteralComparison(
          entry,
          ["request", "platform"],
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          "darwin",
        )),
      target: (node) => node.expression,
    },
    {
      label: "posix-platform-dispatch",
      replacement: "captureWindows(request)",
      select: (node) => ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "capturePosix" &&
        node.arguments.length === 1 &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === "request",
    },
    {
      label: "posix-capability-fail-closed",
      replacement: "capture.capability.caseSensitiveFileNames === true",
      select: (node) => isBinaryAccessLiteralComparison(
        node,
        ["capture", "capability", "caseSensitiveFileNames"],
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        false,
      ),
    },
  ];
  for (const [index, mutation] of structuralMutations.entries()) {
    const mutated = applySingleAstMutation(source, mutation);
    let rejected = false;
    try {
      validateHostPathIdentitySourceInternal(
        mutated,
        `structural-mutation-oracle-${index}.ts`,
        false,
      );
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(
        `structural-mutation-oracle-${index}:${mutation.label}: verifier 未拒绝结构化绕过样本。`,
      );
    }
  }
}

/** Gate 必须阻断、固定执行本 verifier，并覆盖 producer 与 Story consumer 的二十条 owned path。 */
async function validateGateRegistration() {
  const loaded = await loadQualityGateRegistry(repositoryRoot);
  const matching = loaded.registry.gates.filter(
    ({ gateDefinition }) => gateDefinition.gateId === gateId,
  );
  if (matching.length !== 1) {
    throw new Error(`ci/quality-gates.v1.yaml: 必须唯一登记 ${gateId}。`);
  }
  const definition = matching[0].gateDefinition;
  if (
    definition.blocking !== true ||
    definition.checkId !== gateId ||
    definition.capabilityOwner !== "qa" ||
    JSON.stringify(definition.command) !== JSON.stringify(["node", verifierPath]) ||
    JSON.stringify(definition.triggerPaths) !== JSON.stringify(triggerPaths)
  ) {
    throw new Error(
      `ci/quality-gates.v1.yaml: ${gateId} 定义漂移。Fix: 恢复 blocking、固定 argv 与六条 owned triggerPaths。`,
    );
  }
}

/** 使用固定配置与路径运行不可由 Gate 参数缩小的 Vitest 黑盒测试。 */
function runVitest(configPath, paths) {
  const result = runHostPathIdentityPnpm([
    "exec",
    "vitest",
    "run",
    "--config",
    configPath,
    ...paths,
  ], {
    spawnOptions: {
      cwd: repositoryRoot,
      stdio: "inherit",
    },
  });
  if (result.error !== undefined) {
    console.error("Win32 host identity 回归集无法启动。Fix: 检查 pnpm 与测试运行环境。");
    return 1;
  }
  return result.status ?? 1;
}

/** 使用独立配置精确运行 Win32 suite，并证明四个业务测试全部真实执行。 */
function runVitestWithRequiredCounts(configPath, exactPath) {
  const result = runHostPathIdentityPnpm([
    "exec",
    "vitest",
    "run",
    "--config",
    configPath,
    exactPath,
    "--reporter=json",
  ], {
    spawnOptions: {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  });
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  return classifyDedicatedVitestResult(result, exactPath);
}

/**
 * 将 Vitest JSON 与进程结论收敛为互斥的 suite-hook/assertion/process/count 分类。
 *
 * @param {import("node:child_process").SpawnSyncReturns<string>} result dedicated 进程结果。
 * @param {string} exactPath 唯一允许执行的测试文件。
 */
export function classifyDedicatedVitestResult(result, exactPath) {
  if (result.error !== undefined) {
    return {
      classification: result.error.code === "ETIMEDOUT"
        ? "suite-process-timeout"
        : "suite-process-error",
      ok: false,
      suite: {
        processErrorCode: result.error.code ?? "UNKNOWN",
        processStatus: result.status,
      },
    };
  }
  let report;
  try {
    const jsonLine = result.stdout
      .trim()
      .split(/\r?\n/u)
      .findLast((line) => line.trimStart().startsWith("{"));
    report = JSON.parse(jsonLine ?? "null");
  } catch {
    return {
      classification: "suite-invalid-json",
      ok: false,
      suite: { processStatus: result.status },
    };
  }
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertionFailures = suites.flatMap((suite) =>
    (Array.isArray(suite.assertionResults) ? suite.assertionResults : [])
      .filter(({ status }) => status === "failed")
      .slice(0, 8)
      .map(({ failureMessages, fullName, title }) => ({
        failureMessages: (failureMessages ?? []).slice(0, 4),
        fullName,
        title,
      })),
  ).slice(0, 8);
  const suiteEvidence = {
    assertionFailures,
    numFailedTestSuites: report?.numFailedTestSuites,
    numFailedTests: report?.numFailedTests,
    numPassedTests: report?.numPassedTests,
    numPendingTests: report?.numPendingTests,
    numTodoTests: report?.numTodoTests,
    numTotalTestSuites: report?.numTotalTestSuites,
    numTotalTests: report?.numTotalTests,
    processStatus: result.status,
    suites: suites.slice(0, 4).map((suite) => ({
      message: typeof suite.message === "string" ? suite.message.slice(0, 16_384) : "",
      name: suite.name,
      status: suite.status,
    })),
  };
  if (assertionFailures.length > 0 || report?.numFailedTests > 0) {
    return { classification: "test-assertion-failure", ok: false, suite: suiteEvidence };
  }
  if (
    report?.numFailedTestSuites > 0 ||
    suites.some((suite) => suite?.status === "failed")
  ) {
    return { classification: "suite-hook-failure", ok: false, suite: suiteEvidence };
  }
  if (result.status !== 0 || report?.success !== true) {
    return { classification: "suite-process-error", ok: false, suite: suiteEvidence };
  }
  const normalizedResultPath = suites[0]?.name?.replaceAll("\\", "/");
  if (
    suites.length !== 1 ||
    !normalizedResultPath?.endsWith(`/${exactPath}`) ||
    report.numTotalTestSuites <= 0 ||
    report.numTotalTests !== 5 ||
    report.numPassedTests !== 5 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    return { classification: "suite-count-mismatch", ok: false, suite: suiteEvidence };
  }
  return { classification: "dedicated-pass", ok: true, suite: suiteEvidence };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyHostPathIdentityV1()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      writeHostPathIdentityEnvelope({
        classification: "verifier-error",
        outcome: "fail",
        suite: {
          message: error instanceof Error
            ? error.message.slice(0, 16_384)
            : "Win32 host identity verifier 未知错误。",
        },
      });
      process.exitCode = 1;
    });
}
