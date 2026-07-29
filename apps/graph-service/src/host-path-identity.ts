import { createHash } from "node:crypto";
import { lstat as nativeLstat, open as nativeOpen, realpath as nativeRealpath } from "node:fs/promises";

export const DEFAULT_MAX_HOST_PATH_CANDIDATES = 256;
export const MAX_HOST_PATH_CANDIDATES = 4096;

/** 宿主状态只暴露形成物理身份所需字段，避免 fake 依赖 Node Stats 的其余表面。 */
export interface HostPathIdentityStat {
  birthtimeNs?: bigint;
  dev: bigint;
  ino: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** 已打开句柄用于把路径查找结果绑定到实际对象，而不是仅信任路径字符串。 */
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

/** 已证明存在的宿主文件身份；identity 不含可被 Worker 重新解释的路径折叠规则。 */
export interface PresentHostPathIdentityV1 {
  canonicalPath: string;
  evidenceDigest: string;
  identity: string;
  requestedPath: string;
  status: "present";
  version: 1;
  volumeIdentity: string;
}

/** 无法取得现存身份证明时返回封闭失败状态，调用者不得从字符串猜测身份。 */
export interface FailedHostPathIdentityV1 {
  code: string;
  requestedPath: string;
  retryable: boolean;
  status: "missing" | "unreadable" | "changed" | "unsupported" | "error";
  version: 1;
}

export type HostPathIdentityObservationV1 =
  | PresentHostPathIdentityV1
  | FailedHostPathIdentityV1;

/** TypeScript 主进程交给 broker 的逻辑候选与实际宿主路径。 */
export interface HostPathIdentityCandidateV1 {
  absolutePath: string;
  logicalPath: string;
}

/** 单个逻辑候选的宿主证明，失败项仍保留以驱动 watcher/CAS fail-closed 序列。 */
export interface HostPathIdentityCandidateEntryV1 {
  logicalPath: string;
  observation: HostPathIdentityObservationV1;
}

/** 相同 opaque identity 下的 logical aliases；排序只使用精确字符串序。 */
export interface HostPathAliasGroupV1 {
  identity: string;
  logicalPaths: string[];
}

/** 完成或部分失败的有界候选证明。 */
export interface HostPathCandidateProofV1 {
  aliasGroups: HostPathAliasGroupV1[];
  entries: HostPathIdentityCandidateEntryV1[];
  generation: number;
  proofDigest: string;
  status: "complete" | "failed";
  version: 1;
}

/** 输入边界自身不可信时拒绝整批请求，且绝不返回截断后的伪完整 map。 */
export interface RejectedHostPathCandidateProofV1 {
  aliasGroups: [];
  code: "HOST_PATH_CANDIDATE_INVALID" | "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED" | "HOST_PATH_LOGICAL_ALIAS_CONFLICT";
  entries: [];
  generation: number;
  proofDigest: string;
  status: "rejected";
  version: 1;
}

export type HostPathCandidateResolutionV1 =
  | HostPathCandidateProofV1
  | RejectedHostPathCandidateProofV1;

/** 单路径观察允许注入实际宿主能力，但不允许注入字符串身份算法。 */
export interface ObserveHostPathIdentityOptions {
  fileSystem?: HostPathIdentityFileSystem;
  platform?: NodeJS.Platform;
}

/** broker 配置只控制文件系统边界、宿主平台证据和候选上限。 */
export interface HostPathIdentityBrokerOptions extends ObserveHostPathIdentityOptions {
  maxCandidates?: number;
}

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
 * 通过 lstat、已打开句柄和 realpath 的闭环观察现存文件。
 *
 * 任何路径消失、权限错误或竞态都会返回显式失败联合；这里刻意不提供字符串大小写
 * 归并后备，因为 Unicode 字符串等价不代表 Windows 卷上的文件等价。
 */
export async function observeHostPathIdentity(
  requestedPath: string,
  options: ObserveHostPathIdentityOptions = {},
): Promise<HostPathIdentityObservationV1> {
  if (!isValidPathInput(requestedPath)) {
    return createFailure(requestedPath, "unsupported", "HOST_PATH_INVALID", false);
  }

  const fileSystem = options.fileSystem ?? nodeHostPathIdentityFileSystem;
  const platform = options.platform ?? process.platform;
  let handle: HostPathIdentityFileHandle | undefined;
  let pathWasPresent = false;
  let observation: HostPathIdentityObservationV1;
  try {
    const before = await fileSystem.lstat(requestedPath);
    pathWasPresent = true;
    if (!isSupportedRegularFile(before)) {
      observation = createFailure(
        requestedPath,
        "unsupported",
        before.isSymbolicLink() ? "HOST_PATH_SYMBOLIC_LINK" : "HOST_PATH_NOT_REGULAR_FILE",
        false,
      );
    } else {
      handle = await fileSystem.open(requestedPath);
      const opened = await handle.stat();
      const canonicalPath = await fileSystem.realpath(requestedPath);
      const canonical = await fileSystem.lstat(canonicalPath);
      const after = await fileSystem.lstat(requestedPath);
      if (
        !isSupportedRegularFile(opened) ||
        !isSupportedRegularFile(canonical) ||
        !isSupportedRegularFile(after) ||
        !hasStablePhysicalIdentity(before) ||
        !samePhysicalIdentity(before, opened) ||
        !samePhysicalIdentity(opened, canonical) ||
        !samePhysicalIdentity(canonical, after)
      ) {
        observation = createFailure(
          requestedPath,
          "changed",
          "HOST_PATH_CHANGED",
          true,
        );
      } else {
        observation = createPresentObservation(requestedPath, canonicalPath, opened, platform);
      }
    }
  } catch (error) {
    observation = classifyFileSystemFailure(requestedPath, error, pathWasPresent);
  }

  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      return createFailure(requestedPath, "error", "HOST_PATH_CLOSE_FAILED", true);
    }
  }
  return observation;
}

/**
 * 为主进程候选建立有界、排序、唯一且可 CAS 的证明序列。
 *
 * generation 每次调用都推进；proofDigest 绑定 generation 和全部成功/失败项，后续
 * watcher consumer 可拒绝较旧证明，而无需让 Worker 重新推导宿主 Unicode 语义。
 */
export class HostPathIdentityBroker {
  readonly #fileSystem: HostPathIdentityFileSystem;
  readonly #maxCandidates: number;
  readonly #platform: NodeJS.Platform;
  #generation = 0;

  public constructor(options: HostPathIdentityBrokerOptions = {}) {
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_HOST_PATH_CANDIDATES;
    if (
      !Number.isSafeInteger(maxCandidates) ||
      maxCandidates < 1 ||
      maxCandidates > MAX_HOST_PATH_CANDIDATES
    ) {
      throw new RangeError(
        `maxCandidates 必须是 1 到 ${MAX_HOST_PATH_CANDIDATES} 的安全整数。`,
      );
    }
    this.#fileSystem = options.fileSystem ?? nodeHostPathIdentityFileSystem;
    this.#maxCandidates = maxCandidates;
    this.#platform = options.platform ?? process.platform;
  }

  /** 观察单个路径并绑定 broker 的单调 generation 与 proof digest。 */
  public async observe(requestedPath: string): Promise<{
    generation: number;
    observation: HostPathIdentityObservationV1;
    proofDigest: string;
    version: 1;
  }> {
    const generation = this.#nextGeneration();
    const observation = await observeHostPathIdentity(requestedPath, {
      fileSystem: this.#fileSystem,
      platform: this.#platform,
    });
    const body = { generation, observation, version: 1 as const };
    return { ...body, proofDigest: digestJson(body) };
  }

  /** 解析 logical path 到实际 canonical path/opaque identity 的整批证明。 */
  public async resolveCandidates(
    candidates: readonly HostPathIdentityCandidateV1[],
  ): Promise<HostPathCandidateResolutionV1> {
    const generation = this.#nextGeneration();
    const prepared = prepareCandidates(candidates);
    if (prepared.status === "rejected") {
      return createRejectedProof(generation, prepared.code);
    }
    if (prepared.candidates.length > this.#maxCandidates) {
      return createRejectedProof(generation, "HOST_PATH_CANDIDATE_LIMIT_EXCEEDED");
    }

    const observations = new Map<string, Promise<HostPathIdentityObservationV1>>();
    const entries: HostPathIdentityCandidateEntryV1[] = [];
    for (const candidate of prepared.candidates) {
      let observation = observations.get(candidate.absolutePath);
      if (observation === undefined) {
        observation = observeHostPathIdentity(candidate.absolutePath, {
          fileSystem: this.#fileSystem,
          platform: this.#platform,
        });
        observations.set(candidate.absolutePath, observation);
      }
      entries.push({
        logicalPath: candidate.logicalPath,
        observation: await observation,
      });
    }

    const aliasGroups = buildAliasGroups(entries);
    const status: HostPathCandidateProofV1["status"] = entries.every(
      (entry) => entry.observation.status === "present",
    )
      ? "complete"
      : "failed";
    const body = {
      aliasGroups,
      entries,
      generation,
      status,
      version: 1 as const,
    };
    return { ...body, proofDigest: digestJson(body) };
  }

  /** generation 只在当前 broker 实例内单调，不伪装成跨进程持久 revision。 */
  #nextGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }
}

/** 把 Node BigIntStats 缩减为可替换的宿主身份状态。 */
function toHostPathIdentityStat(status: {
  birthtimeNs: bigint;
  dev: bigint;
  ino: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): HostPathIdentityStat {
  return {
    birthtimeNs: status.birthtimeNs,
    dev: status.dev,
    ino: status.ino,
    isFile: () => status.isFile(),
    isSymbolicLink: () => status.isSymbolicLink(),
  };
}

/** 只有非符号链接普通文件可进入身份证明，其他宿主对象明确 fail closed。 */
function isSupportedRegularFile(status: HostPathIdentityStat): boolean {
  return status.isFile() && !status.isSymbolicLink();
}

/** 零 inode 无法提供可复查的宿主对象区分，因此不得降级为路径字符串身份。 */
function hasStablePhysicalIdentity(status: HostPathIdentityStat): boolean {
  return status.ino > 0n && status.dev >= 0n;
}

/** 路径前后与打开句柄必须指向相同 volume/file tuple。 */
function samePhysicalIdentity(
  left: HostPathIdentityStat,
  right: HostPathIdentityStat,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    (left.birthtimeNs ?? 0n) === (right.birthtimeNs ?? 0n);
}

/** 从宿主 tuple 生成 opaque identity，并把 canonical path 单独绑定到证据摘要。 */
function createPresentObservation(
  requestedPath: string,
  canonicalPath: string,
  status: HostPathIdentityStat,
  platform: NodeJS.Platform,
): PresentHostPathIdentityV1 {
  const volumeIdentity = `host-volume-v1:${digestJson([
    "host-volume-v1",
    platform,
    status.dev.toString(),
  ])}`;
  const identity = `host-file-v1:${digestJson([
    "host-file-v1",
    platform,
    status.dev.toString(),
    status.ino.toString(),
    (status.birthtimeNs ?? 0n).toString(),
  ])}`;
  const evidence = {
    canonicalPath,
    identity,
    requestedPath,
    version: 1 as const,
    volumeIdentity,
  };
  return {
    ...evidence,
    evidenceDigest: digestJson(evidence),
    status: "present",
  };
}

/** 把宿主 errno 收敛为消费者可穷举的失败联合。 */
function classifyFileSystemFailure(
  requestedPath: string,
  error: unknown,
  pathWasPresent: boolean,
): FailedHostPathIdentityV1 {
  const code = readErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return pathWasPresent
      ? createFailure(requestedPath, "changed", "HOST_PATH_CHANGED", true)
      : createFailure(requestedPath, "missing", code, true);
  }
  if (code === "EACCES" || code === "EPERM") {
    return createFailure(requestedPath, "unreadable", code, false);
  }
  if (code === "ELOOP" || code === "EISDIR") {
    return createFailure(requestedPath, "unsupported", code, false);
  }
  return createFailure(requestedPath, "error", code, true);
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

/** 创建不携带任何猜测 identity 的失败结果。 */
function createFailure(
  requestedPath: string,
  status: FailedHostPathIdentityV1["status"],
  code: string,
  retryable: boolean,
): FailedHostPathIdentityV1 {
  return { code, requestedPath, retryable, status, version: 1 };
}

/** 路径输入只做安全边界校验，不做 Unicode normalization 或大小写转换。 */
function isValidPathInput(input: string): boolean {
  return typeof input === "string" && input.length > 0 && !input.includes("\0");
}

/** 以 logical path 精确键去重；同键指向不同宿主路径时拒绝整批证明。 */
function prepareCandidates(candidates: readonly HostPathIdentityCandidateV1[]):
  | { candidates: HostPathIdentityCandidateV1[]; status: "ready" }
  | {
    code: "HOST_PATH_CANDIDATE_INVALID" | "HOST_PATH_LOGICAL_ALIAS_CONFLICT";
    status: "rejected";
  } {
  if (!Array.isArray(candidates)) {
    return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
  }
  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !isValidPathInput(candidate.logicalPath) ||
      !isValidPathInput(candidate.absolutePath)
    ) {
      return { code: "HOST_PATH_CANDIDATE_INVALID", status: "rejected" };
    }
    const existing = unique.get(candidate.logicalPath);
    if (existing !== undefined && existing !== candidate.absolutePath) {
      return { code: "HOST_PATH_LOGICAL_ALIAS_CONFLICT", status: "rejected" };
    }
    unique.set(candidate.logicalPath, candidate.absolutePath);
  }
  const prepared = [...unique].map(([logicalPath, absolutePath]) => ({
    absolutePath,
    logicalPath,
  }));
  prepared.sort((left, right) => compareOrdinal(left.logicalPath, right.logicalPath));
  return { candidates: prepared, status: "ready" };
}

/** 只对成功项按 opaque identity 分组；失败项绝不进入 alias 推断。 */
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

/** 生成拒绝结果时同样绑定 generation，防止调用方复用较旧边界判断。 */
function createRejectedProof(
  generation: number,
  code: RejectedHostPathCandidateProofV1["code"],
): RejectedHostPathCandidateProofV1 {
  const body = {
    aliasGroups: [] as [],
    code,
    entries: [] as [],
    generation,
    status: "rejected" as const,
    version: 1 as const,
  };
  return { ...body, proofDigest: digestJson(body) };
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
