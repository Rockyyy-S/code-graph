import { createHash } from "node:crypto";
import { lstat as nativeLstat, open as nativeOpen, realpath as nativeRealpath } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_HOST_PATH_CANDIDATES = 256;
export const MAX_HOST_PATH_CANDIDATES = 4096;
export const DEFAULT_MAX_HOST_PATH_LOGICAL_BYTES = 4096;
export const MAX_HOST_PATH_LOGICAL_BYTES = 16 * 1024;
export const DEFAULT_MAX_HOST_PATH_ABSOLUTE_BYTES = 32 * 1024;
export const MAX_HOST_PATH_ABSOLUTE_BYTES = 128 * 1024;
export const DEFAULT_MAX_HOST_PATH_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_HOST_PATH_BATCH_BYTES = 8 * 1024 * 1024;

/** 宿主状态只暴露形成 opened-object identity 与拓扑证明所需字段。 */
export interface HostPathIdentityStat {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** 已打开句柄把 identity 绑定到实际对象，不从路径或 creation time 猜测。 */
export interface HostPathIdentityFileHandle {
  close(): Promise<void>;
  stat(): Promise<HostPathIdentityStat>;
}

/** 可注入文件系统边界让竞态、缺失与权限错误可被确定性测试。 */
export interface HostPathIdentityFileSystem {
  lstat(input: string): Promise<HostPathIdentityStat>;
  open(input: string): Promise<HostPathIdentityFileHandle>;
  realpath(input: string): Promise<string>;
}

/** 已证明存在的宿主文件身份；公开字段均为 opaque digest，不泄漏绝对路径。 */
export interface PresentHostPathIdentityV1 {
  evidenceDigest: string;
  identity: string;
  rootIdentity: string;
  status: "present";
  version: 1;
  volumeIdentity: string;
}

/** 无法取得现存身份证明时返回封闭失败状态，调用者不得从字符串猜测身份。 */
export interface FailedHostPathIdentityV1 {
  code: string;
  retryable: boolean;
  status: "missing" | "unreadable" | "changed" | "unsupported" | "error";
  version: 1;
}

export type HostPathIdentityObservationV1 =
  | PresentHostPathIdentityV1
  | FailedHostPathIdentityV1;

/** TypeScript 主进程交给 broker 的规范逻辑候选与实际宿主路径。 */
export interface HostPathIdentityCandidateV1 {
  absolutePath: string;
  logicalPath: string;
}

/** 单个逻辑候选的宿主证明；失败项只保留规范 logical path。 */
export interface HostPathIdentityCandidateEntryV1 {
  logicalPath: string;
  observation: HostPathIdentityObservationV1;
}

/** 相同 opaque identity 下的 logical aliases；排序只使用精确字符串序。 */
export interface HostPathAliasGroupV1 {
  identity: string;
  logicalPaths: string[];
}

/** 完成或整批失败的候选证明，readSetDigest 绑定两次一致观察。 */
export interface HostPathCandidateProofV1 {
  aliasGroups: HostPathAliasGroupV1[];
  entries: HostPathIdentityCandidateEntryV1[];
  generation: number;
  proofDigest: string;
  readSetDigest: string;
  status: "complete" | "failed";
  version: 1;
}

export type RejectedHostPathCandidateCode =
  | "HOST_PATH_ABSOLUTE_PATH_LIMIT_EXCEEDED"
  | "HOST_PATH_ALTERNATE_DATA_STREAM"
  | "HOST_PATH_BATCH_LIMIT_EXCEEDED"
  | "HOST_PATH_CANDIDATE_INVALID"
  | "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED"
  | "HOST_PATH_DEVICE_PATH"
  | "HOST_PATH_LOGICAL_ALIAS_CONFLICT"
  | "HOST_PATH_LOGICAL_PATH_LIMIT_EXCEEDED"
  | "HOST_PATH_OUTSIDE_INDEXING_ROOT"
  | "HOST_PATH_RELATIVE_PATH";

/** 输入边界不可信时拒绝整批请求，且绝不返回截断后的伪完整 map。 */
export interface RejectedHostPathCandidateProofV1 {
  aliasGroups: [];
  code: RejectedHostPathCandidateCode;
  entries: [];
  generation: number;
  proofDigest: string;
  readSetDigest: null;
  status: "rejected";
  version: 1;
}

export type HostPathCandidateResolutionV1 =
  | HostPathCandidateProofV1
  | RejectedHostPathCandidateProofV1;

/** 单路径观察显式绑定 indexing root，不允许无根路径证明。 */
export interface ObserveHostPathIdentityOptions {
  fileSystem?: HostPathIdentityFileSystem;
  indexingRoot: string;
  platform?: NodeJS.Platform;
}

/** broker 配置固定 root、宿主能力和所有输入预算。 */
export interface HostPathIdentityBrokerOptions extends ObserveHostPathIdentityOptions {
  maxAbsolutePathBytes?: number;
  maxBatchBytes?: number;
  maxCandidates?: number;
  maxLogicalPathBytes?: number;
}

/** 单路径证明同时暴露 generation 与 read-set fence，但不暴露绝对路径。 */
export interface HostPathIdentitySingleProofV1 {
  generation: number;
  observation: HostPathIdentityObservationV1;
  proofDigest: string;
  readSetDigest: string;
  version: 1;
}

interface HostPathInputBudgets {
  maxAbsolutePathBytes: number;
  maxBatchBytes: number;
  maxCandidates: number;
  maxLogicalPathBytes: number;
}

interface RootProof {
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
  rootIdentity: string;
  volumeIdentity: string;
}

interface CapturedPresentFile {
  observation: PresentHostPathIdentityV1;
  status: "present";
}

interface CapturedFailedFile {
  observation: FailedHostPathIdentityV1;
  status: "failed";
}

type CapturedFile = CapturedPresentFile | CapturedFailedFile;

interface PreparedCandidate extends HostPathIdentityCandidateV1 {}

type PreparedCandidatesResult =
  | { candidates: PreparedCandidate[]; status: "ready" }
  | { code: RejectedHostPathCandidateCode; status: "rejected" };

type RootProofResult =
  | { proof: RootProof; status: "present" }
  | { observation: FailedHostPathIdentityV1; status: "failed" };

/** Node 默认适配器统一请求 bigint 状态，避免 inode 或设备号经过 number 精度损失。 */
const nodeHostPathIdentityFileSystem: HostPathIdentityFileSystem = {
  lstat: async (input) => toHostPathIdentityStat(await nativeLstat(input, { bigint: true })),
  open: async (input) => {
    const handle = await nativeOpen(input, "r");
    return {
      close: async () => handle.close(),
      stat: async () => toHostPathIdentityStat(await handle.stat({ bigint: true })),
    };
  },
  realpath: nativeRealpath,
};

/**
 * 通过已证明 indexing root、opened handle、realpath containment 和双读 read-set
 * 观察单个文件；任何不一致都 fail closed，且不向调用方返回宿主绝对路径。
 */
export async function observeHostPathIdentity(
  requestedPath: string,
  options: ObserveHostPathIdentityOptions,
): Promise<HostPathIdentityObservationV1> {
  const broker = new HostPathIdentityBroker(options);
  return (await broker.observe(requestedPath)).observation;
}

/** 为主进程候选建立 root-bound、预算有界、排序唯一且可 CAS 的证明序列。 */
export class HostPathIdentityBroker {
  readonly #budgets: HostPathInputBudgets;
  readonly #fileSystem: HostPathIdentityFileSystem;
  readonly #indexingRoot: string;
  readonly #platform: NodeJS.Platform;
  #generation = 0;

  public constructor(options: HostPathIdentityBrokerOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("HostPathIdentityBroker 必须显式提供 indexingRoot。");
    }
    const platform = options.platform ?? process.platform;
    const rootValidation = validateAbsoluteHostPath(options.indexingRoot, platform);
    if (rootValidation !== null) {
      throw new TypeError(`indexingRoot 不是受支持的绝对宿主路径：${rootValidation}。`);
    }
    this.#budgets = {
      maxAbsolutePathBytes: validateBudget(
        options.maxAbsolutePathBytes ?? DEFAULT_MAX_HOST_PATH_ABSOLUTE_BYTES,
        MAX_HOST_PATH_ABSOLUTE_BYTES,
        "maxAbsolutePathBytes",
      ),
      maxBatchBytes: validateBudget(
        options.maxBatchBytes ?? DEFAULT_MAX_HOST_PATH_BATCH_BYTES,
        MAX_HOST_PATH_BATCH_BYTES,
        "maxBatchBytes",
      ),
      maxCandidates: validateBudget(
        options.maxCandidates ?? DEFAULT_MAX_HOST_PATH_CANDIDATES,
        MAX_HOST_PATH_CANDIDATES,
        "maxCandidates",
      ),
      maxLogicalPathBytes: validateBudget(
        options.maxLogicalPathBytes ?? DEFAULT_MAX_HOST_PATH_LOGICAL_BYTES,
        MAX_HOST_PATH_LOGICAL_BYTES,
        "maxLogicalPathBytes",
      ),
    };
    this.#fileSystem = options.fileSystem ?? nodeHostPathIdentityFileSystem;
    this.#indexingRoot = options.indexingRoot;
    this.#platform = platform;
  }

  /** 观察单个路径并绑定 broker 的单调 generation、root proof 与 read-set digest。 */
  public async observe(requestedPath: string): Promise<HostPathIdentitySingleProofV1> {
    const generation = this.#nextGeneration();
    const invalidCode = typeof requestedPath === "string" &&
      Buffer.byteLength(requestedPath, "utf8") > this.#budgets.maxAbsolutePathBytes
      ? "HOST_PATH_ABSOLUTE_PATH_LIMIT_EXCEEDED"
      : validateAbsoluteHostPath(requestedPath, this.#platform) ??
        (isLexicallyContained(this.#indexingRoot, requestedPath, this.#platform)
          ? null
          : "HOST_PATH_OUTSIDE_INDEXING_ROOT");
    if (invalidCode !== null) {
      return createSingleProof(
        generation,
        createFailure("unsupported", invalidCode, false),
      );
    }

    const rootBefore = await captureRootProof(
      this.#indexingRoot,
      this.#fileSystem,
      this.#platform,
    );
    if (rootBefore.status === "failed") {
      return createSingleProof(generation, rootBefore.observation);
    }
    const first = await captureFileProof(
      requestedPath,
      rootBefore.proof,
      this.#fileSystem,
      this.#platform,
    );
    if (first.status === "failed") {
      return createSingleProof(generation, first.observation);
    }
    const validation = await captureFileProof(
      requestedPath,
      rootBefore.proof,
      this.#fileSystem,
      this.#platform,
    );
    const rootAfter = await captureRootProof(
      this.#indexingRoot,
      this.#fileSystem,
      this.#platform,
    );
    if (
      validation.status === "failed" ||
      rootAfter.status === "failed" ||
      !sameRootProof(rootBefore.proof, rootAfter.proof) ||
      validation.observation.evidenceDigest !== first.observation.evidenceDigest
    ) {
      return createSingleProof(
        generation,
        createFailure("changed", "HOST_PATH_CHANGED", true),
      );
    }
    return createSingleProof(generation, first.observation);
  }

  /** 解析 logical path 到 opaque opened-object identity 的整批证明。 */
  public async resolveCandidates(
    candidates: readonly HostPathIdentityCandidateV1[],
  ): Promise<HostPathCandidateResolutionV1> {
    const generation = this.#nextGeneration();
    const prepared = prepareCandidates(
      candidates,
      this.#budgets,
      this.#indexingRoot,
      this.#platform,
    );
    if (prepared.status === "rejected") {
      return createRejectedProof(generation, prepared.code);
    }

    const rootBefore = await captureRootProof(
      this.#indexingRoot,
      this.#fileSystem,
      this.#platform,
    );
    if (rootBefore.status === "failed") {
      return createFailedProof(
        generation,
        prepared.candidates,
        rootBefore.observation,
      );
    }

    const firstCaptures = await captureCandidates(
      prepared.candidates,
      rootBefore.proof,
      this.#fileSystem,
      this.#platform,
    );
    const firstEntries = toCandidateEntries(prepared.candidates, firstCaptures);
    if (firstEntries.some(({ observation }) => observation.status !== "present")) {
      return createProof(generation, firstEntries, [], "failed");
    }

    const validationCaptures = await captureCandidates(
      prepared.candidates,
      rootBefore.proof,
      this.#fileSystem,
      this.#platform,
    );
    const validationEntries = toCandidateEntries(prepared.candidates, validationCaptures);
    const rootAfter = await captureRootProof(
      this.#indexingRoot,
      this.#fileSystem,
      this.#platform,
    );
    if (
      rootAfter.status === "failed" ||
      !sameRootProof(rootBefore.proof, rootAfter.proof) ||
      !samePresentReadSet(firstEntries, validationEntries)
    ) {
      const changedEntries = prepared.candidates.map(({ logicalPath }) => ({
        logicalPath,
        observation: createFailure(
          "changed",
          "HOST_PATH_BATCH_CHANGED",
          true,
        ),
      }));
      return createProof(generation, changedEntries, [], "failed", {
        firstEntries,
        validationEntries,
      });
    }

    return createProof(
      generation,
      firstEntries,
      buildAliasGroups(firstEntries),
      "complete",
    );
  }

  /** generation 只在当前 broker 实例内单调，不伪装成跨进程持久 revision。 */
  #nextGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }
}

/** 把 Node BigIntStats 缩减为可替换的宿主身份状态。 */
function toHostPathIdentityStat(status: {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): HostPathIdentityStat {
  return {
    dev: status.dev,
    ino: status.ino,
    isDirectory: () => status.isDirectory(),
    isFile: () => status.isFile(),
    isSymbolicLink: () => status.isSymbolicLink(),
  };
}

/** 捕获 indexing root 的 canonical directory tuple，并拒绝 root symlink 或不完整 tuple。 */
async function captureRootProof(
  indexingRoot: string,
  fileSystem: HostPathIdentityFileSystem,
  platform: NodeJS.Platform,
): Promise<RootProofResult> {
  let pathWasPresent = false;
  try {
    const before = await fileSystem.lstat(indexingRoot);
    pathWasPresent = true;
    if (!isSupportedDirectory(before)) {
      return {
        observation: createFailure(
          "unsupported",
          before.isSymbolicLink()
            ? "HOST_PATH_INDEXING_ROOT_SYMBOLIC_LINK"
            : "HOST_PATH_INDEXING_ROOT_NOT_DIRECTORY",
          false,
        ),
        status: "failed",
      };
    }
    if (!hasStableObjectIdentity(before)) {
      return {
        observation: createFailure(
          "unsupported",
          "HOST_PATH_IDENTITY_UNSUPPORTED",
          false,
        ),
        status: "failed",
      };
    }
    const canonicalPath = await fileSystem.realpath(indexingRoot);
    const canonical = await fileSystem.lstat(canonicalPath);
    const after = await fileSystem.lstat(indexingRoot);
    if (
      !isSupportedDirectory(canonical) ||
      !isSupportedDirectory(after) ||
      !hasStableObjectIdentity(canonical) ||
      !hasStableObjectIdentity(after) ||
      !sameObjectIdentity(before, canonical) ||
      !sameObjectIdentity(canonical, after)
    ) {
      return {
        observation: createFailure("changed", "HOST_PATH_CHANGED", true),
        status: "failed",
      };
    }
    const volumeIdentity = createVolumeIdentity(platform, before.dev);
    return {
      proof: {
        canonicalPath,
        dev: before.dev,
        ino: before.ino,
        rootIdentity: `host-root-v1:${digestJson([
          "host-root-v1",
          platform,
          before.dev.toString(),
          before.ino.toString(),
        ])}`,
        volumeIdentity,
      },
      status: "present",
    };
  } catch (error) {
    return {
      observation: classifyFileSystemFailure(error, pathWasPresent),
      status: "failed",
    };
  }
}

/** 捕获文件的 opened-object tuple，并在同一闭环验证 canonical containment。 */
async function captureFileProof(
  requestedPath: string,
  root: RootProof,
  fileSystem: HostPathIdentityFileSystem,
  platform: NodeJS.Platform,
): Promise<CapturedFile> {
  let handle: HostPathIdentityFileHandle | undefined;
  let pathWasPresent = false;
  let result: CapturedFile;
  try {
    const before = await fileSystem.lstat(requestedPath);
    pathWasPresent = true;
    if (!isSupportedRegularFile(before)) {
      result = {
        observation: createFailure(
          "unsupported",
          before.isSymbolicLink() ? "HOST_PATH_SYMBOLIC_LINK" : "HOST_PATH_NOT_REGULAR_FILE",
          false,
        ),
        status: "failed",
      };
    } else if (!hasStableObjectIdentity(before)) {
      result = {
        observation: createFailure(
          "unsupported",
          "HOST_PATH_IDENTITY_UNSUPPORTED",
          false,
        ),
        status: "failed",
      };
    } else {
      handle = await fileSystem.open(requestedPath);
      const opened = await handle.stat();
      if (!isSupportedRegularFile(opened)) {
        result = {
          observation: createFailure("changed", "HOST_PATH_CHANGED", true),
          status: "failed",
        };
      } else if (!hasStableObjectIdentity(opened)) {
        result = {
          observation: createFailure(
            "unsupported",
            "HOST_PATH_IDENTITY_UNSUPPORTED",
            false,
          ),
          status: "failed",
        };
      } else {
        const canonicalPath = await fileSystem.realpath(requestedPath);
        if (!isCanonicalContained(root.canonicalPath, canonicalPath, platform)) {
          result = {
            observation: createFailure(
              "unsupported",
              "HOST_PATH_OUTSIDE_INDEXING_ROOT",
              false,
            ),
            status: "failed",
          };
        } else {
          const canonical = await fileSystem.lstat(canonicalPath);
          const after = await fileSystem.lstat(requestedPath);
          if (opened.dev !== root.dev) {
            result = {
              observation: createFailure(
                "unsupported",
                "HOST_PATH_VOLUME_MISMATCH",
                false,
              ),
              status: "failed",
            };
          } else if (
            !isSupportedRegularFile(canonical) ||
            !isSupportedRegularFile(after) ||
            !hasStableObjectIdentity(canonical) ||
            !hasStableObjectIdentity(after) ||
            !sameObjectIdentity(before, opened) ||
            !sameObjectIdentity(opened, canonical) ||
            !sameObjectIdentity(canonical, after)
          ) {
            result = {
              observation: createFailure("changed", "HOST_PATH_CHANGED", true),
              status: "failed",
            };
          } else {
            result = {
              observation: createPresentObservation(
                root,
                canonicalPath,
                opened,
                platform,
              ),
              status: "present",
            };
          }
        }
      }
    }
  } catch (error) {
    result = {
      observation: classifyFileSystemFailure(error, pathWasPresent),
      status: "failed",
    };
  }

  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      return {
        observation: createFailure("error", "HOST_PATH_CLOSE_FAILED", true),
        status: "failed",
      };
    }
  }
  return result;
}

/** 对同一绝对路径只捕获一次，多个 logical alias 复用同一 opened-object 结果。 */
async function captureCandidates(
  candidates: readonly PreparedCandidate[],
  root: RootProof,
  fileSystem: HostPathIdentityFileSystem,
  platform: NodeJS.Platform,
): Promise<Map<string, CapturedFile>> {
  const captures = new Map<string, CapturedFile>();
  for (const candidate of candidates) {
    if (!captures.has(candidate.absolutePath)) {
      captures.set(
        candidate.absolutePath,
        await captureFileProof(candidate.absolutePath, root, fileSystem, platform),
      );
    }
  }
  return captures;
}

/** 把内部绝对路径映射投影为只含 logical path 与 opaque observation 的公开条目。 */
function toCandidateEntries(
  candidates: readonly PreparedCandidate[],
  captures: ReadonlyMap<string, CapturedFile>,
): HostPathIdentityCandidateEntryV1[] {
  return candidates.map(({ absolutePath, logicalPath }) => ({
    logicalPath,
    observation: captures.get(absolutePath)?.observation ??
      createFailure("error", "HOST_PATH_IO_ERROR", true),
  }));
}

/** 只有非符号链接普通文件可进入身份证明。 */
function isSupportedRegularFile(status: HostPathIdentityStat): boolean {
  return status.isFile() && !status.isSymbolicLink();
}

/** indexing root 必须是非符号链接目录。 */
function isSupportedDirectory(status: HostPathIdentityStat): boolean {
  return status.isDirectory() && !status.isSymbolicLink();
}

/** dev 与 ino 必须都是正 bigint；缺失或零值不得降级为路径身份。 */
function hasStableObjectIdentity(status: HostPathIdentityStat): boolean {
  return typeof status.dev === "bigint" &&
    typeof status.ino === "bigint" &&
    status.dev > 0n &&
    status.ino > 0n;
}

/** 路径状态与 opened handle 必须指向同一完整 volume/file tuple。 */
function sameObjectIdentity(left: HostPathIdentityStat, right: HostPathIdentityStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** 两次 root proof 必须保持 canonical location 与 opaque root identity 一致。 */
function sameRootProof(left: RootProof, right: RootProof): boolean {
  return left.canonicalPath === right.canonicalPath &&
    left.rootIdentity === right.rootIdentity &&
    left.volumeIdentity === right.volumeIdentity;
}

/** 从 opened handle tuple 生成 identity，并仅以 digest 绑定 canonical 相对位置。 */
function createPresentObservation(
  root: RootProof,
  canonicalPath: string,
  status: HostPathIdentityStat,
  platform: NodeJS.Platform,
): PresentHostPathIdentityV1 {
  const identity = `host-file-v1:${digestJson([
    "host-file-v1",
    platform,
    status.dev.toString(),
    status.ino.toString(),
  ])}`;
  const canonicalRelativePathDigest = digestJson([
    "host-canonical-relative-v1",
    toCanonicalRelativePath(root.canonicalPath, canonicalPath, platform),
  ]);
  const evidence = {
    canonicalRelativePathDigest,
    identity,
    rootIdentity: root.rootIdentity,
    version: 1 as const,
    volumeIdentity: root.volumeIdentity,
  };
  return {
    evidenceDigest: digestJson(evidence),
    identity,
    rootIdentity: root.rootIdentity,
    status: "present",
    version: 1,
    volumeIdentity: root.volumeIdentity,
  };
}

/** volume identity 只来自宿主平台与 opened/root dev，不接收路径或时间字段。 */
function createVolumeIdentity(platform: NodeJS.Platform, dev: bigint): string {
  return `host-volume-v1:${digestJson([
    "host-volume-v1",
    platform,
    dev.toString(),
  ])}`;
}

/** 把宿主 errno 收敛为消费者可穷举的失败联合。 */
function classifyFileSystemFailure(
  error: unknown,
  pathWasPresent: boolean,
): FailedHostPathIdentityV1 {
  const code = readErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return pathWasPresent
      ? createFailure("changed", "HOST_PATH_CHANGED", true)
      : createFailure("missing", code, true);
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFailure("unreadable", code, false);
  }
  if (code === "ELOOP" || code === "EISDIR") {
    return pathWasPresent
      ? createFailure("changed", "HOST_PATH_CHANGED", true)
      : createFailure("unsupported", code, false);
  }
  return createFailure("error", code, true);
}

/** 未提供 errno 时使用稳定通用错误码，避免把不受控 message 作为协议字段。 */
function readErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return "HOST_PATH_IO_ERROR";
}

/** 创建不携带任何路径或猜测 identity 的失败结果。 */
function createFailure(
  status: FailedHostPathIdentityV1["status"],
  code: string,
  retryable: boolean,
): FailedHostPathIdentityV1 {
  return { code, retryable, status, version: 1 };
}

/** 在读取任何元素前校验原始数组长度，再逐项执行路径与 UTF-8 预算 admission。 */
function prepareCandidates(
  candidates: readonly HostPathIdentityCandidateV1[],
  budgets: HostPathInputBudgets,
  indexingRoot: string,
  platform: NodeJS.Platform,
): PreparedCandidatesResult {
  if (!Array.isArray(candidates)) {
    return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
  }
  if (candidates.length > budgets.maxCandidates) {
    return { code: "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED", status: "rejected" };
  }

  const unique = new Map<string, string>();
  let batchBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    if (index >= budgets.maxCandidates) {
      return { code: "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED", status: "rejected" };
    }
    const candidate = candidates[index];
    if (typeof candidate !== "object" || candidate === null) {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }

    let logicalPath: unknown;
    try {
      logicalPath = candidate.logicalPath;
    } catch {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }
    if (typeof logicalPath !== "string") {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }
    const logicalBytes = Buffer.byteLength(logicalPath, "utf8");
    if (logicalBytes > budgets.maxLogicalPathBytes) {
      return {
        code: "HOST_PATH_LOGICAL_PATH_LIMIT_EXCEEDED",
        status: "rejected",
      };
    }
    batchBytes += logicalBytes;
    if (batchBytes > budgets.maxBatchBytes) {
      return { code: "HOST_PATH_BATCH_LIMIT_EXCEEDED", status: "rejected" };
    }
    if (!isCanonicalLogicalPath(logicalPath)) {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }

    let absolutePath: unknown;
    try {
      absolutePath = candidate.absolutePath;
    } catch {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }
    if (typeof absolutePath !== "string") {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }
    const absoluteBytes = Buffer.byteLength(absolutePath, "utf8");
    if (absoluteBytes > budgets.maxAbsolutePathBytes) {
      return {
        code: "HOST_PATH_ABSOLUTE_PATH_LIMIT_EXCEEDED",
        status: "rejected",
      };
    }
    batchBytes += absoluteBytes;
    if (batchBytes > budgets.maxBatchBytes) {
      return { code: "HOST_PATH_BATCH_LIMIT_EXCEEDED", status: "rejected" };
    }
    const absoluteValidation = validateAbsoluteHostPath(absolutePath, platform);
    if (absoluteValidation !== null) {
      return { code: absoluteValidation, status: "rejected" };
    }
    if (!isLexicallyContained(indexingRoot, absolutePath, platform)) {
      return { code: "HOST_PATH_OUTSIDE_INDEXING_ROOT", status: "rejected" };
    }

    const existing = unique.get(logicalPath);
    if (existing !== undefined && existing !== absolutePath) {
      return { code: "HOST_PATH_LOGICAL_ALIAS_CONFLICT", status: "rejected" };
    }
    unique.set(logicalPath, absolutePath);
  }

  const prepared = [...unique].map(([logicalPath, absolutePath]) => ({
    absolutePath,
    logicalPath,
  }));
  prepared.sort((left, right) => compareOrdinal(left.logicalPath, right.logicalPath));
  return { candidates: prepared, status: "ready" };
}

/** logical path 必须已经是 NFC、相对、无反斜杠的规范 POSIX 表示。 */
function isCanonicalLogicalPath(input: string): boolean {
  const segments = input.split("/");
  return input.length > 0 &&
    !input.includes("\0") &&
    !input.includes("\\") &&
    !path.posix.isAbsolute(input) &&
    input !== "." &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    input.normalize("NFC") === input &&
    path.posix.normalize(input) === input;
}

/** 校验宿主绝对路径，并在任何 I/O 前拒绝 Win32 device namespace 与 ADS。 */
function validateAbsoluteHostPath(
  input: unknown,
  platform: NodeJS.Platform,
): RejectedHostPathCandidateCode | null {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    return "HOST_PATH_CANDIDATE_INVALID";
  }
  if (platform !== "win32") {
    return path.posix.isAbsolute(input) ? null : "HOST_PATH_RELATIVE_PATH";
  }

  const normalizedSeparators = input.replaceAll("/", "\\");
  if (
    normalizedSeparators.startsWith("\\\\?\\") ||
    normalizedSeparators.startsWith("\\\\.\\") ||
    normalizedSeparators.startsWith("\\??\\") ||
    normalizedSeparators.startsWith("\\\\??\\")
  ) {
    return "HOST_PATH_DEVICE_PATH";
  }
  const parsedRoot = path.win32.parse(normalizedSeparators).root;
  const isDriveAbsolute = /^[A-Za-z]:\\/u.test(normalizedSeparators);
  const isUncAbsolute = normalizedSeparators.startsWith("\\\\") && parsedRoot.length > 2;
  if (!isDriveAbsolute && !isUncAbsolute) {
    return "HOST_PATH_RELATIVE_PATH";
  }
  if (normalizedSeparators.slice(parsedRoot.length).includes(":")) {
    return "HOST_PATH_ALTERNATE_DATA_STREAM";
  }
  return null;
}

/** 用规范化后的精确前缀做 I/O 前 containment；不引入第二套大小写身份算法。 */
function isLexicallyContained(
  indexingRoot: string,
  candidatePath: string,
  platform: NodeJS.Platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedRoot = pathApi.normalize(indexingRoot);
  const normalizedCandidate = pathApi.normalize(candidatePath);
  const separator = platform === "win32" ? "\\" : "/";
  const rootPrefix = normalizedRoot.endsWith(separator)
    ? normalizedRoot
    : `${normalizedRoot}${separator}`;
  return normalizedCandidate.startsWith(rootPrefix);
}

/** canonical containment 只比较 realpath 返回的规范前缀，不使用 locale/Unicode folding。 */
function isCanonicalContained(
  canonicalRoot: string,
  canonicalCandidate: string,
  platform: NodeJS.Platform,
): boolean {
  return isLexicallyContained(canonicalRoot, canonicalCandidate, platform);
}

/** 从已验证 containment 的 canonical 路径提取相对 POSIX 形式，仅进入 evidence digest。 */
function toCanonicalRelativePath(
  canonicalRoot: string,
  canonicalCandidate: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalizedRoot = pathApi.normalize(canonicalRoot);
  const normalizedCandidate = pathApi.normalize(canonicalCandidate);
  const separator = platform === "win32" ? "\\" : "/";
  const rootPrefix = normalizedRoot.endsWith(separator)
    ? normalizedRoot
    : `${normalizedRoot}${separator}`;
  return normalizedCandidate.slice(rootPrefix.length).replaceAll("\\", "/").normalize("NFC");
}

/** 只对成功项按 opaque identity 分组；失败 proof 永不产生 aliasGroups。 */
function buildAliasGroups(
  entries: readonly HostPathIdentityCandidateEntryV1[],
): HostPathAliasGroupV1[] {
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.observation.status !== "present") {
      continue;
    }
    const logicalPaths = groups.get(entry.observation.identity) ?? [];
    logicalPaths.push(entry.logicalPath);
    groups.set(entry.observation.identity, logicalPaths);
  }
  return [...groups]
    .map(([identity, logicalPaths]) => ({
      identity,
      logicalPaths: logicalPaths.sort(compareOrdinal),
    }))
    .sort((left, right) => compareOrdinal(left.identity, right.identity));
}

/** 两次验证必须覆盖相同 logical path 且得到相同 opaque evidence。 */
function samePresentReadSet(
  first: readonly HostPathIdentityCandidateEntryV1[],
  validation: readonly HostPathIdentityCandidateEntryV1[],
): boolean {
  if (first.length !== validation.length) {
    return false;
  }
  return first.every((entry, index) => {
    const validated = validation[index];
    return validated !== undefined &&
      validated.logicalPath === entry.logicalPath &&
      entry.observation.status === "present" &&
      validated.observation.status === "present" &&
      validated.observation.evidenceDigest === entry.observation.evidenceDigest;
  });
}

/** 生成单路径 proof，readSetDigest 只绑定 opaque observation。 */
function createSingleProof(
  generation: number,
  observation: HostPathIdentityObservationV1,
): HostPathIdentitySingleProofV1 {
  const readSetDigest = digestJson({ observation, version: 1 });
  const body = { generation, observation, readSetDigest, version: 1 as const };
  return { ...body, proofDigest: digestJson(body) };
}

/** 生成批次 proof，并允许 changed 结果绑定初次与复查 read-set。 */
function createProof(
  generation: number,
  entries: HostPathIdentityCandidateEntryV1[],
  aliasGroups: HostPathAliasGroupV1[],
  status: HostPathCandidateProofV1["status"],
  changedReadSets?: {
    firstEntries: HostPathIdentityCandidateEntryV1[];
    validationEntries: HostPathIdentityCandidateEntryV1[];
  },
): HostPathCandidateProofV1 {
  const readSetDigest = digestJson(
    changedReadSets ?? { entries, version: 1 },
  );
  const body = {
    aliasGroups,
    entries,
    generation,
    readSetDigest,
    status,
    version: 1 as const,
  };
  return { ...body, proofDigest: digestJson(body) };
}

/** root 无法证明时把整批 logical entries 投影为相同 fail-closed observation。 */
function createFailedProof(
  generation: number,
  candidates: readonly PreparedCandidate[],
  observation: FailedHostPathIdentityV1,
): HostPathCandidateProofV1 {
  return createProof(
    generation,
    candidates.map(({ logicalPath }) => ({ logicalPath, observation })),
    [],
    "failed",
  );
}

/** 生成拒绝结果时同样绑定 generation，防止调用方复用较旧 admission 判断。 */
function createRejectedProof(
  generation: number,
  code: RejectedHostPathCandidateCode,
): RejectedHostPathCandidateProofV1 {
  const body = {
    aliasGroups: [] as [],
    code,
    entries: [] as [],
    generation,
    readSetDigest: null,
    status: "rejected" as const,
    version: 1 as const,
  };
  return { ...body, proofDigest: digestJson(body) };
}

/** 校验所有数量与字节预算，禁止使用不安全整数或越过平台硬上限。 */
function validateBudget(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} 必须是 1 到 ${maximum} 的安全整数。`);
  }
  return value;
}

/** 使用与 locale 无关的 UTF-16 code-unit 序，保持不同 Unicode 名称彼此独立。 */
function compareOrdinal(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 输入对象均由本模块按稳定字段顺序构造，因此 JSON 字节可用于本地证明摘要。 */
function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
