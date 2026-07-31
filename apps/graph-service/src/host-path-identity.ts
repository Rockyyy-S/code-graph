import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_MAX_HOST_PATH_CANDIDATES = 256;
export const MAX_HOST_PATH_CANDIDATES = 4096;
export const DEFAULT_MAX_HOST_PATH_LOGICAL_BYTES = 4096;
export const MAX_HOST_PATH_LOGICAL_BYTES = 16 * 1024;
export const DEFAULT_MAX_HOST_PATH_ABSOLUTE_BYTES = 32 * 1024;
export const MAX_HOST_PATH_ABSOLUTE_BYTES = 128 * 1024;
export const DEFAULT_MAX_HOST_PATH_BATCH_BYTES = 2 * 1024 * 1024;
export const MAX_HOST_PATH_BATCH_BYTES = 8 * 1024 * 1024;

const WINDOWS_SNAPSHOT_FENCE = "non-delete-shared-handle-lease-v1";
const WINDOWS_CAPTURE_TIMEOUT_MS = 30_000;
const WINDOWS_CAPTURE_OUTPUT_LIMIT = 1024 * 1024;

/** 已证明存在的宿主文件身份只在同一原生句柄快照内有效。 */
export interface PresentHostPathIdentityV1 {
  evidenceDigest: string;
  identity: string;
  identityLifetime: "snapshot";
  logicalMappingDigest: string;
  rootIdentity: string;
  snapshotIdentity: string;
  status: "present";
  version: 1;
  volumeIdentity: string;
}

/** 无法取得现存身份证明时返回封闭失败状态。 */
export interface FailedHostPathIdentityV1 {
  code: string;
  retryable: boolean;
  status: "missing" | "unreadable" | "changed" | "unsupported" | "error";
  version: 1;
}

export type HostPathIdentityObservationV1 =
  | PresentHostPathIdentityV1
  | FailedHostPathIdentityV1;

/** TypeScript 主进程交给 broker 的规范逻辑候选与宿主路径断言。 */
export interface HostPathIdentityCandidateV1 {
  absolutePath: string;
  logicalPath: string;
}

/** 单个逻辑候选的宿主证明。 */
export interface HostPathIdentityCandidateEntryV1 {
  logicalPath: string;
  observation: HostPathIdentityObservationV1;
}

/** 相同快照身份下的 logical aliases。 */
export interface HostPathAliasGroupV1 {
  identity: string;
  logicalPaths: string[];
}

/** 完成或整批失败的候选证明。 */
export interface HostPathCandidateProofV1 {
  aliasGroups: HostPathAliasGroupV1[];
  entries: HostPathIdentityCandidateEntryV1[];
  generation: number;
  proofDigest: string;
  readSetDigest: string;
  snapshotIdentity: string | null;
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
  | "HOST_PATH_LOGICAL_PATH_LIMIT_EXCEEDED"
  | "HOST_PATH_NETWORK_PATH"
  | "HOST_PATH_RELATIVE_PATH";

/** 输入边界不可信时拒绝整批请求。 */
export interface RejectedHostPathCandidateProofV1 {
  aliasGroups: [];
  code: RejectedHostPathCandidateCode;
  entries: [];
  generation: number;
  proofDigest: string;
  readSetDigest: null;
  snapshotIdentity: null;
  status: "rejected";
  version: 1;
}

export type HostPathCandidateResolutionV1 =
  | HostPathCandidateProofV1
  | RejectedHostPathCandidateProofV1;

/** 原生快照必须声明明确的卷与句柄栅栏能力。 */
export interface HostPathSnapshotCapabilityV1 {
  fileIdInfo: boolean;
  fileSystemType: string;
  fixedVolume: boolean;
  snapshotFence: string;
}

/** 传给受信任原生边界的单项请求。 */
export interface HostPathSnapshotCandidateV1 {
  absolutePath: string;
  candidateIndex: number;
  logicalPath: string;
  trustedPath: string;
}

/** 原生边界返回的单项对象身份不包含任何路径。 */
export interface HostPathSnapshotItemV1 {
  candidateIndex: number;
  objectId: string;
}

/** 同一批句柄同时存活期间形成的原生快照。 */
export interface CompleteHostPathSnapshotV1 {
  capability: HostPathSnapshotCapabilityV1;
  captureNonce: string;
  items: HostPathSnapshotItemV1[];
  rootObjectId: string;
  status: "complete";
  volumeId: string;
}

/** 原生边界失败必须携带封闭、可重试分类。 */
export interface FailedHostPathSnapshotV1 {
  code: string;
  retryable: boolean;
  status: "missing" | "unreadable" | "changed" | "unsupported" | "error";
}

export type HostPathSnapshotCaptureV1 =
  | CompleteHostPathSnapshotV1
  | FailedHostPathSnapshotV1;

/** 可替换的受信任宿主边界用于确定性注入竞态与能力缺失。 */
export interface HostPathIdentitySnapshotProvider {
  capture(request: {
    candidates: readonly HostPathSnapshotCandidateV1[];
    captureNonce: string;
    indexingRoot: string;
    platform: NodeJS.Platform;
  }): Promise<HostPathSnapshotCaptureV1>;
}

/** 单路径观察显式绑定 indexing root。 */
export interface ObserveHostPathIdentityOptions {
  indexingRoot: string;
  platform?: NodeJS.Platform;
  snapshotProvider?: HostPathIdentitySnapshotProvider;
}

/** broker 配置固定 root、宿主能力和所有输入预算。 */
export interface HostPathIdentityBrokerOptions extends ObserveHostPathIdentityOptions {
  maxAbsolutePathBytes?: number;
  maxBatchBytes?: number;
  maxCandidates?: number;
  maxLogicalPathBytes?: number;
}

/** 单路径证明显式说明 generation 不是文件系统 epoch。 */
export interface HostPathIdentitySingleProofV1 {
  generation: number;
  observation: HostPathIdentityObservationV1;
  proofDigest: string;
  readSetDigest: string;
  snapshotIdentity: string | null;
  version: 1;
}

interface HostPathInputBudgets {
  maxAbsolutePathBytes: number;
  maxBatchBytes: number;
  maxCandidates: number;
  maxLogicalPathBytes: number;
}

interface PreparedCandidate extends HostPathIdentityCandidateV1 {
  candidateIndex: number;
  trustedPath: string;
}

type PreparedCandidatesResult =
  | { candidates: PreparedCandidate[]; status: "ready" }
  | { code: RejectedHostPathCandidateCode; status: "rejected" };

interface CapturedIdentityContext {
  rootIdentity: string;
  snapshotIdentity: string;
  volumeIdentity: string;
}

/** 默认宿主边界只在真实 Win32 上提供 FILE_ID_INFO 与非删除共享句柄快照。 */
const nativeSnapshotProvider: HostPathIdentitySnapshotProvider = {
  capture: async (request) => {
    if (request.platform !== "win32" || process.platform !== "win32") {
      return createSnapshotFailure(
        "unsupported",
        "HOST_PATH_IDENTITY_UNSUPPORTED",
        false,
      );
    }
    return captureWindowsHandleSnapshot(request);
  },
};

/** 观察单个文件，并返回只在该原生句柄快照内有效的 opaque identity。 */
export async function observeHostPathIdentity(
  requestedPath: string,
  options: ObserveHostPathIdentityOptions,
): Promise<HostPathIdentityObservationV1> {
  const broker = new HostPathIdentityBroker(options);
  return (await broker.observe(requestedPath)).observation;
}

/** 为主进程候选建立预算有界、root-derived mapping 与句柄快照证明。 */
export class HostPathIdentityBroker {
  readonly #budgets: HostPathInputBudgets;
  readonly #indexingRoot: string;
  readonly #platform: NodeJS.Platform;
  readonly #snapshotProvider: HostPathIdentitySnapshotProvider;
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
    this.#indexingRoot = options.indexingRoot;
    this.#platform = platform;
    this.#snapshotProvider = options.snapshotProvider ?? nativeSnapshotProvider;
  }

  /** 单路径只把 requested path 当作断言，containment 由原生 root ancestry 证明。 */
  public async observe(requestedPath: string): Promise<HostPathIdentitySingleProofV1> {
    const generation = this.#nextGeneration();
    const invalidCode = typeof requestedPath === "string" &&
        Buffer.byteLength(requestedPath, "utf8") > this.#budgets.maxAbsolutePathBytes
      ? "HOST_PATH_ABSOLUTE_PATH_LIMIT_EXCEEDED"
      : validateAbsoluteHostPath(requestedPath, this.#platform);
    if (invalidCode !== null) {
      return createSingleProof(
        generation,
        createFailure("unsupported", invalidCode, false),
        null,
      );
    }

    const captureNonce = createCaptureNonce();
    const capture = await this.#snapshotProvider.capture({
      candidates: [{
        absolutePath: requestedPath,
        candidateIndex: 0,
        logicalPath: "single-observation",
        trustedPath: requestedPath,
      }],
      captureNonce,
      indexingRoot: this.#indexingRoot,
      platform: this.#platform,
    });
    if (capture.status !== "complete") {
      return createSingleProof(generation, toObservationFailure(capture), null);
    }
    const validation = validateCompleteCapture(capture, captureNonce, 1);
    if (validation !== null) {
      return createSingleProof(generation, validation, null);
    }
    const item = capture.items[0];
    if (item === undefined || item.candidateIndex !== 0) {
      return createSingleProof(
        generation,
        createFailure("error", "HOST_PATH_SNAPSHOT_INVALID", false),
        null,
      );
    }
    const context = createCapturedIdentityContext(capture, this.#platform);
    const observation = createPresentObservation(
      context,
      item.objectId,
      "single-observation",
      this.#platform,
    );
    return createSingleProof(generation, observation, context.snapshotIdentity);
  }

  /** logical path 先派生 trusted host path，再由同批原生句柄核验 absolutePath 断言。 */
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

    const captureNonce = createCaptureNonce();
    const capture = await this.#snapshotProvider.capture({
      candidates: prepared.candidates,
      captureNonce,
      indexingRoot: this.#indexingRoot,
      platform: this.#platform,
    });
    if (capture.status !== "complete") {
      return createFailedProof(generation, prepared.candidates, toObservationFailure(capture));
    }
    const validation = validateCompleteCapture(
      capture,
      captureNonce,
      prepared.candidates.length,
    );
    if (validation !== null) {
      return createFailedProof(generation, prepared.candidates, validation);
    }

    const objectByCandidate = new Map<number, string>();
    for (const item of capture.items) {
      if (
        !Number.isSafeInteger(item.candidateIndex) ||
        item.candidateIndex < 0 ||
        item.candidateIndex >= prepared.candidates.length ||
        objectByCandidate.has(item.candidateIndex) ||
        !isOpaqueNativeIdentifier(item.objectId)
      ) {
        return createFailedProof(
          generation,
          prepared.candidates,
          createFailure("error", "HOST_PATH_SNAPSHOT_INVALID", false),
        );
      }
      objectByCandidate.set(item.candidateIndex, item.objectId);
    }

    const objectByLogicalPath = new Map<string, string>();
    for (const candidate of prepared.candidates) {
      const objectId = objectByCandidate.get(candidate.candidateIndex);
      if (objectId === undefined) {
        return createFailedProof(
          generation,
          prepared.candidates,
          createFailure("error", "HOST_PATH_SNAPSHOT_INVALID", false),
        );
      }
      const existing = objectByLogicalPath.get(candidate.logicalPath);
      if (existing !== undefined && existing !== objectId) {
        return createFailedProof(
          generation,
          prepared.candidates,
          createFailure(
            "unsupported",
            "HOST_PATH_LOGICAL_ALIAS_CONFLICT",
            false,
          ),
        );
      }
      objectByLogicalPath.set(candidate.logicalPath, objectId);
    }

    const context = createCapturedIdentityContext(capture, this.#platform);
    const entries = [...objectByLogicalPath]
      .sort(([left], [right]) => compareOrdinal(left, right))
      .map(([logicalPath, objectId]) => ({
        logicalPath,
        observation: createPresentObservation(
          context,
          objectId,
          logicalPath,
          this.#platform,
        ),
      }));
    return createProof(
      generation,
      entries,
      buildAliasGroups(entries),
      "complete",
      context.snapshotIdentity,
    );
  }

  /** generation 只表示当前 broker 请求顺序，不参与宿主身份或快照语义。 */
  #nextGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }
}

/** 原生 complete 结果必须满足封闭 Win32 能力合同。 */
function validateCompleteCapture(
  capture: CompleteHostPathSnapshotV1,
  captureNonce: string,
  expectedItems: number,
): FailedHostPathIdentityV1 | null {
  if (
    capture.captureNonce !== captureNonce ||
    capture.items.length !== expectedItems ||
    !isOpaqueNativeIdentifier(capture.rootObjectId) ||
    !isOpaqueNativeIdentifier(capture.volumeId)
  ) {
    return createFailure("error", "HOST_PATH_SNAPSHOT_INVALID", false);
  }
  if (
    capture.capability.fileSystemType !== "NTFS" ||
    capture.capability.fileIdInfo !== true ||
    capture.capability.fixedVolume !== true ||
    capture.capability.snapshotFence !== WINDOWS_SNAPSHOT_FENCE
  ) {
    return createFailure(
      "unsupported",
      "HOST_PATH_IDENTITY_UNSUPPORTED",
      false,
    );
  }
  return null;
}

/** 从可信原生材料生成只在当前 captureNonce 内有效的身份上下文。 */
function createCapturedIdentityContext(
  capture: CompleteHostPathSnapshotV1,
  platform: NodeJS.Platform,
): CapturedIdentityContext {
  const volumeIdentity = `host-volume-v2:${digestJson([
    "host-volume-v2",
    platform,
    capture.volumeId,
    capture.capability.fileSystemType,
  ])}`;
  const snapshotIdentity = `host-snapshot-v1:${digestJson([
    "host-snapshot-v1",
    platform,
    capture.captureNonce,
    capture.rootObjectId,
    volumeIdentity,
    capture.items
      .map(({ candidateIndex, objectId }) => [candidateIndex, objectId])
      .sort(([left], [right]) => Number(left) - Number(right)),
  ])}`;
  const rootIdentity = `host-root-v2:${digestJson([
    "host-root-v2",
    snapshotIdentity,
    capture.rootObjectId,
  ])}`;
  return { rootIdentity, snapshotIdentity, volumeIdentity };
}

/** 对象 identity 绑定句柄租约快照，避免 File ID 跨生命周期复用。 */
function createPresentObservation(
  context: CapturedIdentityContext,
  objectId: string,
  logicalPath: string,
  platform: NodeJS.Platform,
): PresentHostPathIdentityV1 {
  const identity = `host-file-v2:${digestJson([
    "host-file-v2",
    platform,
    context.snapshotIdentity,
    objectId,
  ])}`;
  const evidence = {
    identity,
    identityLifetime: "snapshot" as const,
    logicalMappingDigest: digestJson(["host-logical-mapping-v1", logicalPath]),
    rootIdentity: context.rootIdentity,
    snapshotIdentity: context.snapshotIdentity,
    version: 1 as const,
    volumeIdentity: context.volumeIdentity,
  };
  return {
    evidenceDigest: digestJson(evidence),
    ...evidence,
    status: "present",
  };
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

  const prepared: PreparedCandidate[] = [];
  let batchBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
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
      return { code: "HOST_PATH_LOGICAL_PATH_LIMIT_EXCEEDED", status: "rejected" };
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
      return { code: "HOST_PATH_ABSOLUTE_PATH_LIMIT_EXCEEDED", status: "rejected" };
    }
    batchBytes += absoluteBytes;
    if (batchBytes > budgets.maxBatchBytes) {
      return { code: "HOST_PATH_BATCH_LIMIT_EXCEEDED", status: "rejected" };
    }
    const absoluteValidation = validateAbsoluteHostPath(absolutePath, platform);
    if (absoluteValidation !== null) {
      return { code: absoluteValidation, status: "rejected" };
    }

    const trustedPath = createTrustedPath(indexingRoot, logicalPath, platform);
    if (Buffer.byteLength(trustedPath, "utf8") > budgets.maxAbsolutePathBytes) {
      return { code: "HOST_PATH_ABSOLUTE_PATH_LIMIT_EXCEEDED", status: "rejected" };
    }
    prepared.push({
      absolutePath,
      candidateIndex: index,
      logicalPath,
      trustedPath,
    });
  }
  prepared.sort((left, right) =>
    compareOrdinal(left.logicalPath, right.logicalPath) ||
    compareOrdinal(left.absolutePath, right.absolutePath) ||
    left.candidateIndex - right.candidateIndex
  );
  prepared.forEach((candidate, index) => {
    candidate.candidateIndex = index;
  });
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

/** trusted path 只能从 authority root 与 canonical logical path 派生。 */
function createTrustedPath(
  indexingRoot: string,
  logicalPath: string,
  platform: NodeJS.Platform,
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.join(indexingRoot, ...logicalPath.split("/"));
}

/** 校验宿主绝对路径，并在任何 I/O 前拒绝 device namespace、UNC 与 ADS。 */
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
  if (normalizedSeparators.startsWith("\\\\")) {
    return "HOST_PATH_NETWORK_PATH";
  }
  const parsedRoot = path.win32.parse(normalizedSeparators).root;
  if (!/^[A-Za-z]:\\$/u.test(parsedRoot) || !/^[A-Za-z]:\\/u.test(normalizedSeparators)) {
    return "HOST_PATH_RELATIVE_PATH";
  }
  if (normalizedSeparators.slice(parsedRoot.length).includes(":")) {
    return "HOST_PATH_ALTERNATE_DATA_STREAM";
  }
  return null;
}

/** 把原生失败投影为公共失败联合。 */
function toObservationFailure(capture: FailedHostPathSnapshotV1): FailedHostPathIdentityV1 {
  return createFailure(capture.status, capture.code, capture.retryable);
}

/** 创建原生边界失败。 */
function createSnapshotFailure(
  status: FailedHostPathSnapshotV1["status"],
  code: string,
  retryable: boolean,
): FailedHostPathSnapshotV1 {
  return { code, retryable, status };
}

/** 永久宿主错误必须 non-retryable unsupported。 */
function classifyNativeFailure(code: string): FailedHostPathSnapshotV1 {
  if (["ENAMETOOLONG", "EINVAL", "ENOSYS", "ENOTSUP"].includes(code)) {
    return createSnapshotFailure("unsupported", code, false);
  }
  if (code === "EACCES" || code === "EPERM") {
    return createSnapshotFailure("unreadable", code, false);
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return createSnapshotFailure("missing", code, true);
  }
  return createSnapshotFailure("error", code, true);
}

/** 创建不携带路径或猜测 identity 的失败结果。 */
function createFailure(
  status: FailedHostPathIdentityV1["status"],
  code: string,
  retryable: boolean,
): FailedHostPathIdentityV1 {
  return { code, retryable, status, version: 1 };
}

/** 单路径 proof 只绑定 observation 与可选原生快照。 */
function createSingleProof(
  generation: number,
  observation: HostPathIdentityObservationV1,
  snapshotIdentity: string | null,
): HostPathIdentitySingleProofV1 {
  const readSetDigest = digestJson({ observation, snapshotIdentity, version: 1 });
  const body = {
    generation,
    observation,
    readSetDigest,
    snapshotIdentity,
    version: 1 as const,
  };
  return { ...body, proofDigest: digestJson(body) };
}

/** 生成批次 proof。 */
function createProof(
  generation: number,
  entries: HostPathIdentityCandidateEntryV1[],
  aliasGroups: HostPathAliasGroupV1[],
  status: HostPathCandidateProofV1["status"],
  snapshotIdentity: string | null,
): HostPathCandidateProofV1 {
  const readSetDigest = digestJson({ entries, snapshotIdentity, version: 1 });
  const body = {
    aliasGroups,
    entries,
    generation,
    readSetDigest,
    snapshotIdentity,
    status,
    version: 1 as const,
  };
  return { ...body, proofDigest: digestJson(body) };
}

/** 原生快照失败时整批 logical entries 使用相同封闭失败。 */
function createFailedProof(
  generation: number,
  candidates: readonly PreparedCandidate[],
  observation: FailedHostPathIdentityV1,
): HostPathCandidateProofV1 {
  const logicalPaths = [...new Set(candidates.map(({ logicalPath }) => logicalPath))]
    .sort(compareOrdinal);
  return createProof(
    generation,
    logicalPaths.map((logicalPath) => ({ logicalPath, observation })),
    [],
    "failed",
    null,
  );
}

/** 生成拒绝结果时 generation 只防止调用方误用旧 admission。 */
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
    snapshotIdentity: null,
    status: "rejected" as const,
    version: 1 as const,
  };
  return { ...body, proofDigest: digestJson(body) };
}

/** 只对成功项按快照 identity 分组。 */
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

/** 校验所有数量与字节预算。 */
function validateBudget(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} 必须是 1 到 ${maximum} 的安全整数。`);
  }
  return value;
}

/** 只接受固定长度十六进制或受控 ASCII 原生标识。 */
function isOpaqueNativeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9:._-]{8,256}$/u.test(value);
}

/** 每次原生句柄租约使用独立随机 nonce，禁止跨快照复用 File ID。 */
function createCaptureNonce(): string {
  return randomBytes(32).toString("hex");
}

/** 使用与 locale 无关的 UTF-16 code-unit 序。 */
function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 稳定字段顺序的本地证明摘要。 */
function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** PowerShell/C# 原生边界固定使用 FILE_ID_INFO 与不共享删除的全路径句柄链。 */
export const WINDOWS_HOST_IDENTITY_SNAPSHOT_SCRIPT = String.raw`
param([string]$RequestPath)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class CodeGraphHostIdentityNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_ID_128 {
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
    public byte[] Identifier;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    public FILE_ID_128 FileId;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  public sealed class HandleInfo {
    public bool Directory;
    public string Id;
    public bool Reparse;
    public ulong VolumeSerialNumber;
  }

  public sealed class VolumeInfo {
    public uint FileSystemFlags;
    public string FileSystemName;
    public uint SerialNumber;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string name,
    uint access,
    uint share,
    IntPtr security,
    uint creation,
    uint flags,
    IntPtr template
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle,
    int infoClass,
    out FILE_ID_INFO info,
    uint size
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle,
    int infoClass,
    out FILE_ATTRIBUTE_TAG_INFO info,
    uint size
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetVolumeInformationW(
    string rootPath,
    StringBuilder volumeName,
    uint volumeNameSize,
    out uint serialNumber,
    out uint maximumComponentLength,
    out uint fileSystemFlags,
    StringBuilder fileSystemName,
    uint fileSystemNameSize
  );

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  private static extern uint GetDriveTypeW(string rootPath);

  public static SafeFileHandle OpenPinned(string input) {
    SafeFileHandle handle = CreateFileW(
      input,
      0x80,
      0x1 | 0x2,
      IntPtr.Zero,
      3,
      0x02000000 | 0x00200000,
      IntPtr.Zero
    );
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(code, "CG_WIN32:" + code);
    }
    return handle;
  }

  public static HandleInfo ReadHandle(SafeFileHandle handle) {
    FILE_ID_INFO identity;
    if (!GetFileInformationByHandleEx(
      handle,
      18,
      out identity,
      (uint)Marshal.SizeOf(typeof(FILE_ID_INFO))
    )) {
      int code = Marshal.GetLastWin32Error();
      throw new Win32Exception(code, "CG_WIN32:" + code);
    }
    FILE_ATTRIBUTE_TAG_INFO attributes;
    if (!GetFileInformationByHandleEx(
      handle,
      9,
      out attributes,
      (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO))
    )) {
      int code = Marshal.GetLastWin32Error();
      throw new Win32Exception(code, "CG_WIN32:" + code);
    }
    return new HandleInfo {
      Directory = (attributes.FileAttributes & 0x10) != 0,
      Id = BitConverter.ToString(identity.FileId.Identifier).Replace("-", "").ToLowerInvariant(),
      Reparse = (attributes.FileAttributes & 0x400) != 0,
      VolumeSerialNumber = identity.VolumeSerialNumber
    };
  }

  public static VolumeInfo ReadVolume(string rootPath) {
    if (GetDriveTypeW(rootPath) != 3) {
      throw new InvalidOperationException("CG_UNSUPPORTED:HOST_PATH_VOLUME_UNSUPPORTED");
    }
    StringBuilder volumeName = new StringBuilder(261);
    StringBuilder fileSystemName = new StringBuilder(261);
    uint serialNumber;
    uint maximumComponentLength;
    uint fileSystemFlags;
    if (!GetVolumeInformationW(
      rootPath,
      volumeName,
      (uint)volumeName.Capacity,
      out serialNumber,
      out maximumComponentLength,
      out fileSystemFlags,
      fileSystemName,
      (uint)fileSystemName.Capacity
    )) {
      int code = Marshal.GetLastWin32Error();
      throw new Win32Exception(code, "CG_WIN32:" + code);
    }
    return new VolumeInfo {
      FileSystemFlags = fileSystemFlags,
      FileSystemName = fileSystemName.ToString(),
      SerialNumber = serialNumber
    };
  }
}
"@

function Throw-Unsupported([string]$Code) {
  throw [System.InvalidOperationException]::new("CG_UNSUPPORTED:" + $Code)
}

function Get-PathChain([string]$InputPath) {
  $fullPath = [System.IO.Path]::GetFullPath($InputPath)
  $rootPath = [System.IO.Path]::GetPathRoot($fullPath)
  if ($rootPath -notmatch '^[A-Za-z]:\\$') {
    Throw-Unsupported "HOST_PATH_VOLUME_UNSUPPORTED"
  }
  $result = [System.Collections.Generic.List[string]]::new()
  $result.Add($rootPath)
  $current = $rootPath
  $relative = $fullPath.Substring($rootPath.Length)
  foreach ($segment in $relative.Split([char]'\', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [System.IO.Path]::Combine($current, $segment)
    $result.Add($current)
  }
  return $result.ToArray()
}

$handles = [System.Collections.Generic.List[object]]::new()
$opened = [System.Collections.Generic.Dictionary[string,object]]::new(
  [System.StringComparer]::Ordinal
)

function Open-Tracked([string]$InputPath, [bool]$Directory) {
  if ($opened.ContainsKey($InputPath)) {
    $existing = $opened[$InputPath]
    if ($existing.Directory -ne $Directory) {
      Throw-Unsupported "HOST_PATH_TOPOLOGY_UNSUPPORTED"
    }
    return $existing
  }
  $handle = [CodeGraphHostIdentityNative]::OpenPinned($InputPath)
  $handles.Add($handle)
  $info = [CodeGraphHostIdentityNative]::ReadHandle($handle)
  if ($info.Reparse) {
    Throw-Unsupported "HOST_PATH_REPARSE_POINT"
  }
  if ($info.Directory -ne $Directory) {
    Throw-Unsupported $(if ($Directory) {
      "HOST_PATH_NOT_DIRECTORY"
    } else {
      "HOST_PATH_NOT_REGULAR_FILE"
    })
  }
  $opened.Add($InputPath, $info)
  return $info
}

function Open-Chain([string]$InputPath, [bool]$FinalDirectory) {
  $chain = @(Get-PathChain $InputPath)
  for ($index = 0; $index -lt $chain.Count; $index += 1) {
    $isDirectory = $index -lt ($chain.Count - 1) -or $FinalDirectory
    Open-Tracked $chain[$index] $isDirectory | Out-Null
  }
  return $opened[$chain[$chain.Count - 1]]
}

try {
  $request = (Get-Content -Raw -Encoding UTF8 -LiteralPath $RequestPath | ConvertFrom-Json)
  $rootPath = [System.IO.Path]::GetFullPath([string]$request.indexingRoot)
  $driveRoot = [System.IO.Path]::GetPathRoot($rootPath)
  $volume = [CodeGraphHostIdentityNative]::ReadVolume($driveRoot)
  $requiredFlags = 0x00010000 -bor 0x01000000 -bor 0x02000000
  if ($volume.FileSystemName -cne "NTFS" -or ($volume.FileSystemFlags -band $requiredFlags) -ne $requiredFlags) {
    Throw-Unsupported "HOST_PATH_IDENTITY_UNSUPPORTED"
  }

  $rootInfo = Open-Chain $rootPath $true
  $items = [System.Collections.Generic.List[object]]::new()
  foreach ($candidate in @($request.candidates)) {
    $trustedInfo = Open-Chain ([string]$candidate.trustedPath) $false
    $assertedInfo = Open-Chain ([string]$candidate.absolutePath) $false
    if ($trustedInfo.VolumeSerialNumber -ne $rootInfo.VolumeSerialNumber) {
      Throw-Unsupported "HOST_PATH_VOLUME_MISMATCH"
    }
    if ($assertedInfo.VolumeSerialNumber -ne $rootInfo.VolumeSerialNumber) {
      Throw-Unsupported "HOST_PATH_VOLUME_MISMATCH"
    }
    if ($trustedInfo.Id -cne $assertedInfo.Id) {
      Throw-Unsupported "HOST_PATH_LOGICAL_MAPPING_MISMATCH"
    }
    foreach ($candidatePath in @(
      [string]$candidate.trustedPath,
      [string]$candidate.absolutePath
    )) {
      $candidateChain = @(Get-PathChain $candidatePath)
      $rootSeen = $false
      foreach ($component in $candidateChain) {
        $componentInfo = $opened[$component]
        if (
          $componentInfo.VolumeSerialNumber -eq $rootInfo.VolumeSerialNumber -and
          $componentInfo.Id -ceq $rootInfo.Id
        ) {
          $rootSeen = $true
        }
      }
      if (-not $rootSeen) {
        Throw-Unsupported "HOST_PATH_OUTSIDE_INDEXING_ROOT"
      }
    }
    $items.Add([pscustomobject]@{
      candidateIndex = [int]$candidate.candidateIndex
      objectId = $trustedInfo.Id
    })
  }

  [pscustomobject]@{
    capability = [pscustomobject]@{
      fileIdInfo = $true
      fileSystemType = "NTFS"
      fixedVolume = $true
      snapshotFence = "non-delete-shared-handle-lease-v1"
    }
    captureNonce = [string]$request.captureNonce
    items = $items
    rootObjectId = $rootInfo.Id
    status = "complete"
    volumeId = (
      $rootInfo.VolumeSerialNumber.ToString("x16") + ":" +
      $volume.SerialNumber.ToString("x8") + ":" +
      $volume.FileSystemFlags.ToString("x8")
    )
  } | ConvertTo-Json -Compress -Depth 8
} catch {
  $details = $_.Exception.ToString()
  $code = "HOST_PATH_IO_ERROR"
  $status = "error"
  $retryable = $true
  if ($details -match 'CG_UNSUPPORTED:([A-Z0-9_]+)') {
    $code = $Matches[1]
    $status = "unsupported"
    $retryable = $false
  } elseif ($details -match 'CG_WIN32:(\d+)') {
    $nativeCode = [int]$Matches[1]
    switch ($nativeCode) {
      2 { $code = "ENOENT"; $status = "missing"; $retryable = $true }
      3 { $code = "ENOTDIR"; $status = "missing"; $retryable = $true }
      5 { $code = "EACCES"; $status = "unreadable"; $retryable = $false }
      32 { $code = "HOST_PATH_CHANGED"; $status = "changed"; $retryable = $true }
      1 { $code = "ENOSYS"; $status = "unsupported"; $retryable = $false }
      50 { $code = "ENOTSUP"; $status = "unsupported"; $retryable = $false }
      87 { $code = "EINVAL"; $status = "unsupported"; $retryable = $false }
      120 { $code = "ENOSYS"; $status = "unsupported"; $retryable = $false }
      123 { $code = "EINVAL"; $status = "unsupported"; $retryable = $false }
      206 { $code = "ENAMETOOLONG"; $status = "unsupported"; $retryable = $false }
      default { $code = "WIN32_ERROR_" + $nativeCode }
    }
  }
  [pscustomobject]@{
    code = $code
    retryable = $retryable
    status = $status
  } | ConvertTo-Json -Compress
} finally {
  foreach ($handle in $handles) {
    $handle.Dispose()
  }
}
`;

/** 执行固定原生脚本，并限制时间、输出与可执行参数。 */
async function captureWindowsHandleSnapshot(request: {
  candidates: readonly HostPathSnapshotCandidateV1[];
  captureNonce: string;
  indexingRoot: string;
  platform: NodeJS.Platform;
}): Promise<HostPathSnapshotCaptureV1> {
  const payload = JSON.stringify({
    candidates: request.candidates,
    captureNonce: request.captureNonce,
    indexingRoot: request.indexingRoot,
  });
  const captureRoot = await mkdtemp(path.join(tmpdir(), "codegraph-host-identity-"));
  const scriptPath = path.join(captureRoot, "capture.ps1");
  const requestPath = path.join(captureRoot, "request.json");

  try {
    await Promise.all([
      writeFile(scriptPath, WINDOWS_HOST_IDENTITY_SNAPSHOT_SCRIPT, {
        encoding: "utf8",
        flag: "wx",
      }),
      writeFile(requestPath, payload, { encoding: "utf8", flag: "wx" }),
    ]);
    const output = await runBoundedProcess(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath, requestPath],
    );
    const parsed = JSON.parse(output) as unknown;
    if (!isSnapshotCapture(parsed)) {
      return createSnapshotFailure("error", "HOST_PATH_SNAPSHOT_INVALID", false);
    }
    return parsed;
  } catch (error) {
    return classifyNativeFailure(readErrorCode(error));
  } finally {
    await rm(captureRoot, { force: true, recursive: true });
  }
}

/** 子进程只接收固定 argv，stdout/stderr 均有界。 */
function runBoundedProcess(
  executable: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;

    /** 统一完成路径，避免 timeout、error 与 close 重复结算。 */
    const finish = (error?: Error, value?: string) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(value ?? "");
      }
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(Object.assign(new Error("Windows host identity capture timeout"), {
        code: "HOST_PATH_CAPTURE_TIMEOUT",
      }));
    }, WINDOWS_CAPTURE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > WINDOWS_CAPTURE_OUTPUT_LIMIT) {
        child.kill();
        finish(Object.assign(new Error("Windows host identity stdout overflow"), {
          code: "HOST_PATH_CAPTURE_OUTPUT_LIMIT",
        }));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= WINDOWS_CAPTURE_OUTPUT_LIMIT) {
        stderr.push(chunk);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(Object.assign(new Error(Buffer.concat(stderr).toString("utf8")), {
          code: "HOST_PATH_CAPTURE_PROCESS_FAILED",
        }));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end();
  });
}

/** 运行时只接受封闭快照联合，不信任 PowerShell JSON 形状。 */
function isSnapshotCapture(value: unknown): value is HostPathSnapshotCaptureV1 {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return false;
  }
  if (value.status === "complete") {
    return "capability" in value &&
      typeof value.capability === "object" &&
      value.capability !== null &&
      "captureNonce" in value &&
      typeof value.captureNonce === "string" &&
      "items" in value &&
      Array.isArray(value.items) &&
      "rootObjectId" in value &&
      typeof value.rootObjectId === "string" &&
      "volumeId" in value &&
      typeof value.volumeId === "string";
  }
  return ["missing", "unreadable", "changed", "unsupported", "error"].includes(
    String(value.status),
  ) &&
    "code" in value &&
    typeof value.code === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean";
}

/** 未提供 errno 时使用稳定通用错误码。 */
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
