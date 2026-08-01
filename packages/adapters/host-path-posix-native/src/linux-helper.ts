import { spawn, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, open } from "node:fs/promises";
import path from "node:path";
import {
  HOST_PATH_POSIX_ABI_VERSION,
  HOST_PATH_POSIX_PROTOCOL_VERSION,
  hasExactKeys,
  isRecord,
  isSha256,
  isStableToken,
  type HostPathPosixCapabilityV1,
  type HostPathPosixCaptureRequestV1,
  type HostPathPosixCaptureResponseV1,
  type HostPathPosixNativeProviderV1,
} from "./protocol.js";

export const LINUX_HELPER_PROTOCOL_VERSION = 1 as const;
export const LINUX_HELPER_ABI_VERSION = 1 as const;
export const LINUX_HELPER_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const LINUX_HELPER_MAX_DEADLINE_MS = 60_000;

const LINUX_HELPER_PROVIDER_ID = "codegraph-linux-snapshot-helper-v1";
const LINUX_HELPER_INSTALL_PATHS = Object.freeze({
  bridgeExecutable: "/usr/libexec/codegraph-host-path-bridge",
  keyPath: "/etc/codegraph-host-path/client.key",
  provenancePath: "/usr/share/codegraph-host-path/provenance.json",
  socketPath: "/run/codegraph-host-path/helper.sock",
});
const LINUX_HELPER_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  PATH: "/usr/sbin:/usr/bin",
});
const RESPONSE_KEYS = [
  "abiVersion",
  "batchDigest",
  "capabilityDigest",
  "daemonEpoch",
  "items",
  "nonce",
  "protocolVersion",
  "provenance",
  "requestDigest",
  "requestId",
  "rootObjectId",
  "sequence",
  "snapshotFence",
  "snapshotView",
  "status",
  "transcriptMac",
  "volumeId",
] as const;

export interface LinuxHelperBridgeInvocationV1 {
  args: string[];
  env: Readonly<Record<string, string>>;
  executable: string;
  shell: false;
  stdio: Array<"pipe" | number>;
}

export interface LinuxHelperResponseBindingV1 {
  batchDigest: string;
  binarySha256?: string;
  capabilityDigest: string;
  daemonEpoch?: string;
  nonce: string;
  requestDigest?: string;
  requestId: string;
  sequence?: number;
  signerId?: string;
}

interface LinuxHelperBridgeRequestV1 {
  abiVersion: number;
  batchDigest: string;
  candidates: Array<{
    assertedRelativePath: string;
    candidateIndex: number;
    logicalPath: string;
    trustedRelativePath: string;
  }>;
  capabilityDigest: string;
  nonce: string;
  protocolVersion: number;
  requestDigest: string;
  requestId: string;
}

export interface LinuxSnapshotHelperProviderOptionsV1 {
  binarySha256: string;
  bridgeExecutable: string;
  deadlineMs?: number;
  keyPath: string;
  provenancePath: string;
  signerId: string;
  socketPath: string;
}

/** 只为 Linux snapshot-only helper 构造既有 strict strong capability。 */
export function createLinuxSnapshotHelperCapabilityV1(input: {
  binarySha256: string;
  signerId: string;
}): HostPathPosixCapabilityV1 {
  if (!isSha256(input.binarySha256) || !isStableToken(input.signerId)) {
    throw new Error("Linux helper provenance 非法。");
  }
  return Object.freeze({
    abiVersion: HOST_PATH_POSIX_ABI_VERSION,
    authority: Object.freeze({
      kind: "privileged-helper" as const,
      providerId: LINUX_HELPER_PROVIDER_ID,
    }),
    failClosedReason: null,
    fence: Object.freeze({
      lifetime: "capture" as const,
      namespace: "complete" as const,
      strength: "strong" as const,
    }),
    platform: "linux" as const,
    primitiveKind: "filesystem-snapshot" as const,
    protocolVersion: HOST_PATH_POSIX_PROTOCOL_VERSION,
    provenance: Object.freeze({
      binarySha256: input.binarySha256,
      entitlement: "linux-filesystem-snapshot" as const,
      kind: "signed-privileged-helper" as const,
      signerId: input.signerId,
    }),
    status: "available" as const,
    supportScope: Object.freeze({
      candidateSet: "complete-request-batch" as const,
      root: "indexing-root" as const,
      volume: "native-fixed-volume" as const,
    }),
  });
}

/** snapshot-only 切片只允许三类已经明确资格化的 Linux 存储后端。 */
export function isLinuxSnapshotFilesystemSupportedV1(fileSystem: string): boolean {
  return fileSystem === "btrfs" || fileSystem === "zfs" || fileSystem === "lvm";
}

/**
 * 固定 bridge executable/argv/env，并把实际已打开目录 FD 放入子进程 fd 3。
 * 这里不接受 token 代替 FD，避免伪造 root handle 证明。
 */
export function createLinuxHelperBridgeInvocationV1(input: {
  bridgeExecutable: string;
  deadlineMs: number;
  keyPath: string;
  provenancePath: string;
  rootFd: number;
  socketPath: string;
}): LinuxHelperBridgeInvocationV1 {
  for (const [label, value] of [
    ["bridge executable", input.bridgeExecutable],
    ["helper socket", input.socketPath],
    ["client key", input.keyPath],
    ["provenance manifest", input.provenancePath],
  ] as const) {
    if (!isCanonicalLinuxAbsolutePath(value)) {
      throw new Error(`${label} 必须是 canonical Linux 绝对路径。`);
    }
  }
  for (const [field, expected] of Object.entries(LINUX_HELPER_INSTALL_PATHS)) {
    if (input[field as keyof typeof LINUX_HELPER_INSTALL_PATHS] !== expected) {
      throw new Error(`Linux helper ${field} 必须匹配固定安装布局。`);
    }
  }
  if (!Number.isInteger(input.rootFd) || input.rootFd < 3) {
    throw new Error("root FD 必须是可继承的真实文件描述符。");
  }
  if (
    !Number.isInteger(input.deadlineMs) ||
    input.deadlineMs < 1 ||
    input.deadlineMs > LINUX_HELPER_MAX_DEADLINE_MS
  ) {
    throw new Error("helper deadline 超出固定预算。");
  }
  return {
    args: [
      "capture-v1",
      "--socket",
      input.socketPath,
      "--key",
      input.keyPath,
      "--provenance",
      input.provenancePath,
      "--deadline-ms",
      String(input.deadlineMs),
    ],
    env: LINUX_HELPER_ENVIRONMENT,
    executable: input.bridgeExecutable,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", input.rootFd],
  };
}

/** 对 canonical JSON 添加 u32 大端长度前缀。 */
export function encodeLinuxHelperFrameV1(value: unknown): Buffer {
  const payload = Buffer.from(canonicalJson(value), "utf8");
  if (payload.length === 0 || payload.length > LINUX_HELPER_MAX_FRAME_BYTES) {
    throw new Error("Linux helper frame 超出长度预算。");
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** 解码时要求长度精确、UTF-8 严格且原始字节已经 canonical。 */
export function decodeLinuxHelperFrameV1(frame: Buffer): unknown {
  if (frame.length < 5) {
    throw new Error("Linux helper frame 长度非法。");
  }
  const length = frame.readUInt32BE(0);
  if (length === 0 || length > LINUX_HELPER_MAX_FRAME_BYTES || frame.length !== length + 4) {
    throw new Error("Linux helper frame 长度前缀不匹配。");
  }
  const bytes = frame.subarray(4);
  if (bytes.includes(0) || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
    throw new Error("Linux helper frame 含 BOM/NUL。");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Linux helper frame 不是严格 UTF-8。");
  }
  const parsed = JSON.parse(source) as unknown;
  if (canonicalJson(parsed) !== source) {
    throw new Error("Linux helper frame 不是 canonical JSON。");
  }
  return parsed;
}

/** Node 边界再次锁定 bridge 已认证响应的关键 request/snapshot/provenance 字段。 */
export function validateLinuxHelperResponseEnvelopeV1(
  value: unknown,
  expected: LinuxHelperResponseBindingV1,
):
  | { response: Record<string, unknown>; status: "accepted" }
  | { reason: "RESPONSE_BINDING_MISMATCH" | "RESPONSE_SHAPE_INVALID"; status: "rejected" } {
  if (!isRecord(value) || !hasExactKeys(value, RESPONSE_KEYS)) {
    return { reason: "RESPONSE_SHAPE_INVALID", status: "rejected" };
  }
  if (
    value.protocolVersion !== LINUX_HELPER_PROTOCOL_VERSION ||
    value.abiVersion !== LINUX_HELPER_ABI_VERSION ||
    value.status !== "complete" ||
    !Array.isArray(value.items) ||
    !isStableToken(value.rootObjectId) ||
    !isStableToken(value.volumeId) ||
    !isStableToken(value.snapshotView) ||
    !isStableToken(value.snapshotFence) ||
    !isSha256(value.transcriptMac) ||
    !isRecord(value.provenance) ||
    !hasExactKeys(value.provenance, [
      "binarySha256",
      "manifestSha256",
      "signatureKeyId",
      "signerId",
    ]) ||
    !isSha256(value.provenance.binarySha256) ||
    !isSha256(value.provenance.manifestSha256) ||
    !isStableToken(value.provenance.signatureKeyId) ||
    !isStableToken(value.provenance.signerId)
  ) {
    return { reason: "RESPONSE_SHAPE_INVALID", status: "rejected" };
  }
  if (
    value.batchDigest !== expected.batchDigest ||
    value.capabilityDigest !== expected.capabilityDigest ||
    value.nonce !== expected.nonce ||
    value.requestId !== expected.requestId ||
    (expected.daemonEpoch !== undefined && value.daemonEpoch !== expected.daemonEpoch) ||
    (expected.requestDigest !== undefined && value.requestDigest !== expected.requestDigest) ||
    (expected.sequence !== undefined && value.sequence !== expected.sequence) ||
    (expected.binarySha256 !== undefined &&
      value.provenance.binarySha256 !== expected.binarySha256) ||
    (expected.signerId !== undefined && value.provenance.signerId !== expected.signerId)
  ) {
    return { reason: "RESPONSE_BINDING_MISMATCH", status: "rejected" };
  }
  return { response: value, status: "accepted" };
}

/**
 * 创建由独立 Rust bridge 驱动的 provider；Node 只继承 root FD，不获得 helper 权限。
 */
export function createLinuxSnapshotHelperProviderV1(
  options: LinuxSnapshotHelperProviderOptionsV1,
): HostPathPosixNativeProviderV1 {
  const capability = createLinuxSnapshotHelperCapabilityV1(options);
  const deadlineMs = options.deadlineMs ?? 30_000;
  return Object.freeze({
    capture: async (request: HostPathPosixCaptureRequestV1) =>
      captureWithLinuxBridge(request, { ...options, deadlineMs }),
    getCapability: async () => capability,
  });
}

/** 仅把位于 indexing root 下的相对表示发送到特权边界。 */
function createBridgeRequest(request: HostPathPosixCaptureRequestV1): LinuxHelperBridgeRequestV1 {
  if (request.platform !== "linux") {
    throw new Error("Linux helper 拒绝非 Linux 请求。");
  }
  const candidates = request.candidates.map((candidate) => ({
    assertedRelativePath: relativeBeneath(request.indexingRoot, candidate.absolutePath),
    candidateIndex: candidate.candidateIndex,
    logicalPath: candidate.logicalPath,
    trustedRelativePath: relativeBeneath(request.indexingRoot, candidate.trustedPath),
  }));
  const batchDigest = sha256Canonical(candidates);
  const requestId = `capture-${request.captureNonce}`;
  const requestBody = {
    abiVersion: LINUX_HELPER_ABI_VERSION,
    batchDigest,
    candidates,
    capabilityDigest: request.capabilityDigest,
    nonce: request.captureNonce,
    protocolVersion: LINUX_HELPER_PROTOCOL_VERSION,
    requestId,
  };
  return {
    ...requestBody,
    requestDigest: sha256Canonical(requestBody),
  };
}

/** 执行固定 bridge，stdout 只接受单个有界 frame。 */
async function captureWithLinuxBridge(
  request: HostPathPosixCaptureRequestV1,
  options: Required<LinuxSnapshotHelperProviderOptionsV1>,
): Promise<HostPathPosixCaptureResponseV1> {
  if (process.platform !== "linux") {
    throw new Error("Linux helper 只能在 Linux 宿主执行。");
  }
  const root = await open(
    request.indexingRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const invocation = createLinuxHelperBridgeInvocationV1({
      ...options,
      rootFd: root.fd,
    });
    const bridgeRequest = createBridgeRequest(request);
    const result = await runBridge(
      invocation,
      encodeLinuxHelperFrameV1(bridgeRequest),
      options.deadlineMs,
    );
    const decoded = decodeLinuxHelperFrameV1(result);
    return mapBridgeResponse(decoded, request, bridgeRequest, options);
  } finally {
    await root.close();
  }
}

/** 子进程 deadline、stdout 与 stderr 都有固定预算，任何异常均 fail closed。 */
function runBridge(
  invocation: LinuxHelperBridgeInvocationV1,
  request: Buffer,
  deadlineMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      env: invocation.env,
      shell: invocation.shell,
      stdio: invocation.stdio as StdioOptions,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(Buffer.concat(stdout));
      }
    };
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.on("error", () => undefined);
      child.kill("SIGKILL");
      reject(new Error("Linux helper bridge stdio 未按固定管道创建。"));
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Linux helper bridge timeout。"));
    }, deadlineMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > LINUX_HELPER_MAX_FRAME_BYTES + 4) {
        child.kill("SIGKILL");
        finish(new Error("Linux helper bridge stdout 超限。"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Linux helper bridge stderr 超限。"));
        return;
      }
      stderr.push(chunk);
    });
    child.stdin.on("error", (error) => finish(error));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`Linux helper bridge 失败：${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }
      finish();
    });
    child.stdin.end(request);
  });
}

/** bridge 最终只暴露既有 adapter capture 联合，额外安全绑定停留在内部 ABI。 */
function mapBridgeResponse(
  value: unknown,
  request: HostPathPosixCaptureRequestV1,
  bridgeRequest: LinuxHelperBridgeRequestV1,
  options: Required<LinuxSnapshotHelperProviderOptionsV1>,
): HostPathPosixCaptureResponseV1 {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("Linux helper bridge 响应非法。");
  }
  if (value.status === "failed") {
    return {
      abiVersion: request.abiVersion,
      capabilityDigest: request.capabilityDigest,
      captureNonce: request.captureNonce,
      failClosedReason: "PROVIDER_ERROR",
      platform: "linux",
      protocolVersion: request.protocolVersion,
      retryable: false,
      status: "failed",
    };
  }
  const validated = validateLinuxHelperResponseEnvelopeV1(value, {
    batchDigest: bridgeRequest.batchDigest,
    binarySha256: options.binarySha256,
    capabilityDigest: bridgeRequest.capabilityDigest,
    nonce: bridgeRequest.nonce,
    requestId: bridgeRequest.requestId,
    signerId: options.signerId,
  });
  if (validated.status !== "accepted") {
    throw new Error("Linux helper bridge complete 响应非法。");
  }
  const response = validated.response;
  return {
    abiVersion: request.abiVersion,
    capabilityDigest: request.capabilityDigest,
    captureNonce: request.captureNonce,
    items: response.items as HostPathPosixCaptureResponseV1 extends { items: infer T } ? T : never,
    platform: "linux",
    protocolVersion: request.protocolVersion,
    rootObjectId: response.rootObjectId as string,
    status: "complete",
    volumeId: response.volumeId as string,
  };
}

/** Linux 配置路径不接受反斜杠、NUL、`.`、`..` 或重复分隔符。 */
function isCanonicalLinuxAbsolutePath(value: string): boolean {
  return value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    path.posix.normalize(value) === value &&
    !value.split("/").some((segment, index) =>
      index > 0 && (segment === "" || segment === "." || segment === "..")
    );
}

/** 生成无 `..` 的 root-relative POSIX path；后续仍由 openat2 边界验证。 */
function relativeBeneath(root: string, candidate: string): string {
  if (!isCanonicalLinuxAbsolutePath(root) || !isCanonicalLinuxAbsolutePath(candidate)) {
    throw new Error("Linux helper 路径必须是 canonical 绝对路径。");
  }
  const relative = path.posix.relative(root, candidate);
  if (
    relative.length === 0 ||
    path.posix.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    throw new Error("Linux helper 候选路径不在 indexing root 内。");
  }
  return relative;
}

/** 当前 ABI 只使用整数、字符串、布尔、null、数组与普通对象。 */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("Linux helper canonical JSON 只允许安全整数。");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort(compareOrdinal).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  throw new Error("Linux helper canonical JSON 类型非法。");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
