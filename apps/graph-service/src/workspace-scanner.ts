import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type Dirent,
} from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat as nativeLstat,
  open as nativeOpen,
  opendir as nativeOpendir,
  realpath as nativeRealpath,
} from "node:fs/promises";
import path from "node:path";
import {
  compareCanonicalGraphText,
  isSupportedSourceFile,
  normalizeRelativeGraphPath,
} from "@codegraph/application";
import { sha256CanonicalJson } from "@codegraph/contracts";
import type { ManifestEntryV1 } from "@codegraph/application";
import {
  isBuiltinIgnoredPath,
  type EffectiveIgnoreSnapshotV1,
} from "./ignore-bootstrap.js";

/** 单次可信扫描允许纳入的最大源码文件数。 */
export const MAX_CANDIDATE_SOURCE_FILES = 20_000;

/** 单次可信扫描允许观察的最大目录项总数。 */
export const MAX_SCANNED_ENTRIES = 100_000;

/** 单个源码文件允许参与 manifest hash 的最大原始字节数。 */
export const MAX_SOURCE_FILE_BYTES = 10 * 1024 * 1024;

/** 单次完整 read-set 允许读取的源码总字节预算，约束最终同步双重 collect 的最坏阻塞。 */
export const MAX_TOTAL_SOURCE_BYTES = 512 * 1024 * 1024;

/** 文件系统大小写探测的只读注入边界，仅用于受控宿主与跨平台回归。 */
export interface FileSystemCaseSensitivityProbeOptions {
  /** 测试或受控宿主可替换的只读路径状态查询。 */
  lstat?: (candidate: string) => {
    dev: bigint | number;
    ino: bigint | number;
    isDirectory: () => boolean;
  };
  /** 路径语义仅用于跨平台测试；生产默认使用当前宿主语义。 */
  pathStyle?: "native" | "posix" | "win32";
  /** 测试或受控宿主可替换的只读目录枚举。 */
  readDirectory?: (directory: string) => readonly string[];
  /** 测试或受控宿主可替换的真实路径解析。 */
  realpath?: (candidate: string) => string;
}

/**
 * 通过同卷实体的大小写变体只读探测文件系统语义。
 *
 * 当 indexing root 的所有路径段都没有 ASCII 字母时，Windows 继续探测卷根盘符；
 * POSIX 则有界枚举同卷既有目录项。任何路径都不会被创建或改名，无法取得同实体证明时
 * 仍保持大小写敏感的封闭默认。
 */
export function isFileSystemCaseSensitive(
  existingPath: string,
  probe: FileSystemCaseSensitivityProbeOptions = {},
): boolean {
  const pathApi = probe.pathStyle === "win32"
    ? path.win32
    : probe.pathStyle === "posix"
      ? path.posix
      : path;
  const lstat = probe.lstat ?? ((candidate: string) => lstatSync(candidate, { bigint: true }));
  const readDirectory = probe.readDirectory ?? ((directory: string) =>
    readdirSync(directory, { withFileTypes: true }).map((entry) => entry.name));
  const realpath = probe.realpath ?? realpathSync.native;
  const resolvedPath = realpath(existingPath);
  let resolvedStatus: ReturnType<typeof lstat>;
  try {
    resolvedStatus = lstat(resolvedPath);
  } catch {
    return true;
  }
  const volumeDevice = resolvedStatus.dev;
  let current = resolvedPath;
  while (true) {
    const baseName = pathApi.basename(current);
    const alternateName = toggleFirstAsciiLetterCase(baseName);
    if (alternateName !== baseName) {
      const originalStatus = safeCaseProbeLstat(current, lstat);
      if (originalStatus === null || originalStatus.dev !== volumeDevice) {break;}
      const alternatePath = pathApi.join(pathApi.dirname(current), alternateName);
      return compareCaseVariantIdentity(originalStatus, alternatePath, lstat);
    }
    const parent = pathApi.dirname(current);
    if (parent === current) {break;}
    current = parent;
  }

  const volumeRoot = pathApi.parse(resolvedPath).root;
  const alternateRoot = toggleFirstAsciiLetterCase(volumeRoot);
  if (alternateRoot !== volumeRoot) {
    const rootStatus = safeCaseProbeLstat(volumeRoot, lstat);
    if (rootStatus !== null && rootStatus.dev === volumeDevice) {
      return compareCaseVariantIdentity(rootStatus, alternateRoot, lstat);
    }
  }

  current = resolvedStatus.isDirectory() ? resolvedPath : pathApi.dirname(resolvedPath);
  for (let depth = 0; depth < 128; depth += 1) {
    const directoryStatus = safeCaseProbeLstat(current, lstat);
    if (directoryStatus === null || directoryStatus.dev !== volumeDevice) {break;}
    let entryNames: readonly string[];
    try {
      entryNames = readDirectory(current);
    } catch {
      entryNames = [];
    }
    for (const entryName of entryNames.slice(0, 256)) {
      const alternateName = toggleFirstAsciiLetterCase(entryName);
      if (alternateName === entryName) {continue;}
      const originalPath = pathApi.join(current, entryName);
      const originalStatus = safeCaseProbeLstat(originalPath, lstat);
      if (originalStatus === null || originalStatus.dev !== volumeDevice) {continue;}
      return compareCaseVariantIdentity(
        originalStatus,
        pathApi.join(current, alternateName),
        lstat,
      );
    }
    const parent = pathApi.dirname(current);
    if (parent === current) {break;}
    current = parent;
  }
  return true;
}

/** 以只读方式读取探测实体；失败由调用方按封闭默认处理。 */
function safeCaseProbeLstat<T extends { dev: bigint | number; ino: bigint | number }>(
  candidate: string,
  lstat: (candidate: string) => T,
): T | null {
  try {
    return lstat(candidate);
  } catch {
    return null;
  }
}

/** 已存在大小写变体且物理身份相同，才足以证明当前卷不区分大小写。 */
function compareCaseVariantIdentity<T extends { dev: bigint | number; ino: bigint | number }>(
  original: T,
  alternatePath: string,
  lstat: (candidate: string) => T,
): boolean {
  try {
    const alternate = lstat(alternatePath);
    return original.dev !== alternate.dev || original.ino !== alternate.ino;
  } catch {
    return true;
  }
}

/** 仅切换首个 ASCII 字母，避免 locale 大小写扩展改变路径段长度。 */
function toggleFirstAsciiLetterCase(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x41 && code <= 0x5a) {
      return `${value.slice(0, index)}${value[index]!.toLowerCase()}${value.slice(index + 1)}`;
    }
    if (code >= 0x61 && code <= 0x7a) {
      return `${value.slice(0, index)}${value[index]!.toUpperCase()}${value.slice(index + 1)}`;
    }
  }
  return value;
}

/** 扫描失败使用的稳定内部错误，runtime 会映射为 ErrorV1。 */
export class WorkspaceScanError extends Error {
  public readonly code: "GRAPH_SCAN_FAILED" | "GRAPH_SCAN_LIMIT_EXCEEDED";

  public constructor(
    code: "GRAPH_SCAN_FAILED" | "GRAPH_SCAN_LIMIT_EXCEEDED",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkspaceScanError";
    this.code = code;
  }
}

/** 仅表示 AbortSignal 主动取消；独立扫描失败不得因随后 shutdown 被误分类。 */
export class WorkspaceScanCancelledError extends WorkspaceScanError {
  public constructor(message: string, cause?: unknown) {
    super("GRAPH_SCAN_FAILED", message, cause);
    this.name = "WorkspaceScanCancelledError";
  }
}

/** scanner 可注入的最小目录项边界。 */
export interface ScannerDirectoryEntry {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  name: string;
}

/** scanner 用于校验类型与物理身份的最小路径状态。 */
export interface ScannerPathStatus {
  ctimeNs?: bigint;
  dev?: bigint | number;
  ino?: bigint | number;
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  mtimeNs?: bigint;
  nlink?: bigint | number;
  size?: bigint | number;
}

/** scanner 只依赖文件句柄的同步身份字段与有界 read/close 能力。 */
export interface ScannerFileHandle {
  close: () => Promise<void>;
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
  stat: (options: { bigint: true }) => Promise<ScannerOpenedFileStatus>;
}

/** 已打开文件参与替换检测的稳定身份与时间字段。 */
export interface ScannerOpenedFileStatus {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  isFile: () => boolean;
  mtimeNs: bigint;
  nlink?: bigint;
  size: bigint;
}

/** 仅驻留于 graph-service 内存的同步最终复核路径元数据。 */
export interface WorkspacePathVerificationProof {
  ctimeNs: bigint;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  nlink: bigint;
  path: string;
  size: bigint;
}

/** 完整扫描交付的内部证明，不进入公共合同、GraphPatch 或 SQLite。 */
export interface WorkspaceVerificationProof {
  directories: readonly {
    semanticEntriesDigest: string;
    status: WorkspacePathVerificationProof;
  }[];
  files: readonly WorkspacePathVerificationProof[];
  manifestDigest: string;
}

/** 安全工作区扫描参数。 */
export interface ScanWorkspaceOptions {
  ignoreSnapshot: EffectiveIgnoreSnapshotV1;
  indexingRoot: string;
  lstat?: (input: string) => Promise<ScannerPathStatus>;
  maxCandidateFiles?: number;
  maxScannedEntries?: number;
  maxTotalSourceBytes?: number;
  openFile?: (input: string, flags: number) => Promise<ScannerFileHandle>;
  platform?: NodeJS.Platform;
  readDirectory?: (
    input: string,
    remainingEntryBudget: number,
    signal?: AbortSignal,
  ) => Promise<readonly ScannerDirectoryEntry[]>;
  realpath?: (input: string) => Promise<string>;
  signal?: AbortSignal;
}

/** 已过滤候选与脱敏排除计数。 */
export interface WorkspaceScanResult {
  candidateFiles: readonly string[];
  coverage?: "complete" | "partial";
  excludedPathCount: number;
  manifest: readonly ManifestEntryV1[];
  manifestDigest: string;
  sourceFiles?: readonly WorkspaceSourceSnapshotV1[];
  verificationProof?: WorkspaceVerificationProof;
}

/** Analyzer 使用的不可变源码字节快照，与同次 manifest hash 绑定。 */
export interface WorkspaceSourceSnapshotV1 extends ManifestEntryV1 {
  bytes: Uint8Array;
}

/** SQLite 首次写入前使用的同步完整 read-set 复核参数。 */
export interface VerifyWorkspaceReadSetSyncOptions {
  expectedManifest: readonly ManifestEntryV1[];
  forceContentHash?: boolean;
  ignoreSnapshot: EffectiveIgnoreSnapshotV1;
  indexingRoot: string;
  maxCandidateFiles?: number;
  maxScannedEntries?: number;
  maxTotalSourceBytes?: number;
  platform?: NodeJS.Platform;
  verificationProof?: WorkspaceVerificationProof;
}

/**
 * 遍历 realpath 后的 indexing root，并为 BuiltinIgnoreV1 保护下的 TS/JS 候选生成 manifest。
 *
 * 源码字节只在受信任文件句柄内参与 SHA-256，不返回正文、句柄或绝对路径。
 */
export async function scanWorkspace(options: ScanWorkspaceOptions): Promise<WorkspaceScanResult> {
  const resolveRealpath = options.realpath ?? nativeRealpath;
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const readStatus = options.lstat ?? defaultReadStatus;
  const platform = options.platform ?? process.platform;
  const signal = options.signal;
  const maxCandidateFiles = normalizeLimit(
    options.maxCandidateFiles ?? MAX_CANDIDATE_SOURCE_FILES,
    MAX_CANDIDATE_SOURCE_FILES,
    "候选文件预算",
  );
  const openFile = options.openFile ?? nativeOpen;
  const maxScannedEntries = normalizeLimit(
    options.maxScannedEntries ?? MAX_SCANNED_ENTRIES,
    MAX_SCANNED_ENTRIES,
    "扫描目录项预算",
  );
  const maxTotalSourceBytes = normalizeLimit(
    options.maxTotalSourceBytes ?? MAX_TOTAL_SOURCE_BYTES,
    MAX_TOTAL_SOURCE_BYTES,
    "源码总字节预算",
  );
  try {
    throwIfAborted(signal);
    const trustedRootRealpath = options.indexingRoot;
    const rootStatus = await waitAbortable(readStatus(trustedRootRealpath), signal);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 不是规范真实目录。");
    }
    const trustedRootIdentity = readPathIdentity(rootStatus);
    await assertTrustedRootUnchanged(
      trustedRootRealpath,
      trustedRootIdentity,
      readStatus,
      resolveRealpath,
      signal,
    );

    const candidates: Array<{
      absolutePath: string;
      expectedIdentity: PathIdentity | null;
      path: string;
    }> = [];
    const canonicalPaths = new Set<string>();
    const directoryProofs: Array<WorkspaceVerificationProof["directories"][number]> = [];
    let verificationProofAvailable = true;
    let excludedPathCount = 0;
    let plannedSourceBytes = 0;
    let scannedEntryCount = 0;
    const pendingDirectories = [{
      absolutePath: trustedRootRealpath,
      expectedIdentity: trustedRootIdentity,
      expectedRealpath: trustedRootRealpath,
      logicalPath: "",
    }];
    while (pendingDirectories.length > 0) {
      throwIfAborted(signal);
      const directory = pendingDirectories.pop()!;
      const beforeDirectoryStatus = await waitAbortable(readStatus(directory.absolutePath), signal);
      assertDirectoryIdentity(
        beforeDirectoryStatus,
        directory.expectedIdentity,
        "扫描目录已在排队后被替换。",
      );
      const beforeReadRealpath = await assertRealpathContained(
        trustedRootRealpath,
        directory.absolutePath,
        resolveRealpath,
        directory.logicalPath.length === 0,
        signal,
      );
      if (beforeReadRealpath !== directory.expectedRealpath) {
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "扫描目录已在排队后被替换。");
      }
      const entries = [...await waitAbortable(
        readDirectory(
          directory.absolutePath,
          maxScannedEntries - scannedEntryCount,
          signal,
        ),
        signal,
      )]
        .sort((left, right) => compareCanonicalGraphText(left.name, right.name));
      const afterDirectoryStatus = await waitAbortable(readStatus(directory.absolutePath), signal);
      assertDirectoryIdentity(
        afterDirectoryStatus,
        readPathIdentity(beforeDirectoryStatus),
        "扫描目录在读取期间被替换。",
      );
      const afterReadRealpath = await assertRealpathContained(
        trustedRootRealpath,
        directory.absolutePath,
        resolveRealpath,
        directory.logicalPath.length === 0,
        signal,
      );
      if (afterReadRealpath !== beforeReadRealpath) {
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "扫描目录在读取期间被替换。");
      }
      const semanticEntries: Array<{ kind: "directory" | "source-file"; path: string }> = [];
      for (const entry of entries) {
        throwIfAborted(signal);
        scannedEntryCount += 1;
        if (scannedEntryCount > maxScannedEntries) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_LIMIT_EXCEEDED",
            "工作区目录项总数超过安全预算。",
          );
        }
        const relativePath = createLogicalRelativePath(
          directory.logicalPath,
          entry.name,
          platform,
        );
        if (canonicalPaths.has(relativePath)) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_FAILED",
            "工作区包含规范化后冲突的路径。",
          );
        }
        canonicalPaths.add(relativePath);
        if (isBuiltinIgnoredPath(relativePath, options.ignoreSnapshot)) {
          excludedPathCount += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        /** 文件系统访问始终使用 Dirent 的原始名称，公共图谱路径只用于身份。 */
        const absolutePath = path.join(directory.absolutePath, entry.name);
        if (entry.isDirectory()) {
          const status = await waitAbortable(readStatus(absolutePath), signal);
          if (!status.isDirectory() || status.isSymbolicLink()) {
            continue;
          }
          const childRealpath = await assertRealpathContained(
            trustedRootRealpath,
            absolutePath,
            resolveRealpath,
            false,
            signal,
          );
          pendingDirectories.push({
            absolutePath,
            expectedIdentity: readPathIdentity(status),
            expectedRealpath: childRealpath,
            logicalPath: relativePath,
          });
          semanticEntries.push({ kind: "directory", path: relativePath });
          continue;
        }
        if (!entry.isFile() || !isSupportedSourceFile(relativePath)) {
          continue;
        }
        if (candidates.length >= maxCandidateFiles) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_LIMIT_EXCEEDED",
            "候选源码文件数超过安全预算。",
          );
        }
        const status = await waitAbortable(readStatus(absolutePath), signal);
        if (!status.isFile() || status.isSymbolicLink()) {
          continue;
        }
        assertSingleLink(status, "候选源码不得使用多硬链接身份。");
        if (status.size !== undefined) {
          plannedSourceBytes += Number(status.size);
          if (!Number.isSafeInteger(plannedSourceBytes) || plannedSourceBytes > maxTotalSourceBytes) {
            throw new WorkspaceScanError(
              "GRAPH_SCAN_LIMIT_EXCEEDED",
              "工作区源码总字节数超过 512 MiB 安全上限。",
            );
          }
        }
        await assertRealpathContained(
          trustedRootRealpath,
          absolutePath,
          resolveRealpath,
          false,
          signal,
        );
        candidates.push({
          absolutePath,
          expectedIdentity: readPathIdentity(status),
          path: relativePath,
        });
        semanticEntries.push({ kind: "source-file", path: relativePath });
      }
      const finalDirectoryStatus = await waitAbortable(readStatus(directory.absolutePath), signal);
      assertDirectoryIdentity(
        finalDirectoryStatus,
        readPathIdentity(afterDirectoryStatus),
        "扫描目录在成员分类期间被替换。",
      );
      if (await assertRealpathContained(
        trustedRootRealpath,
        directory.absolutePath,
        resolveRealpath,
        directory.logicalPath.length === 0,
        signal,
      ) !== afterReadRealpath) {
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "扫描目录在成员分类期间被替换。");
      }
      const directoryProof = readPathVerificationProof(
        finalDirectoryStatus,
        directory.logicalPath,
      );
      if (directoryProof === null) {
        verificationProofAvailable = false;
      } else {
        directoryProofs.push(Object.freeze({
          semanticEntriesDigest: sha256CanonicalJson(semanticEntries),
          status: directoryProof,
        }));
      }
    }
    await assertTrustedRootUnchanged(
      trustedRootRealpath,
      trustedRootIdentity,
      readStatus,
      resolveRealpath,
      signal,
    );
    const manifest: ManifestEntryV1[] = [];
    const sourceFiles: WorkspaceSourceSnapshotV1[] = [];
    const fileProofs: WorkspacePathVerificationProof[] = [];
    let hashedSourceBytes = 0;
    for (const candidate of candidates.sort((left, right) =>
      compareCanonicalGraphText(left.path, right.path))) {
      const hashed = await hashTrustedFile(
        trustedRootRealpath,
        candidate.absolutePath,
        candidate.expectedIdentity,
        candidate.path,
        openFile,
        readStatus,
        resolveRealpath,
        signal,
      );
      manifest.push(Object.freeze({
        contentHash: hashed.contentHash,
        path: candidate.path,
      }));
      sourceFiles.push(Object.freeze({
        bytes: hashed.bytes,
        contentHash: hashed.contentHash,
        path: candidate.path,
      }));
      hashedSourceBytes += hashed.byteLength;
      if (hashedSourceBytes > maxTotalSourceBytes) {
        throw new WorkspaceScanError(
          "GRAPH_SCAN_LIMIT_EXCEEDED",
          "工作区源码总字节数超过 512 MiB 安全上限。",
        );
      }
      if (hashed.verificationProof === null) {
        verificationProofAvailable = false;
      } else {
        fileProofs.push(hashed.verificationProof);
      }
    }
    await assertTrustedRootUnchanged(
      trustedRootRealpath,
      trustedRootIdentity,
      readStatus,
      resolveRealpath,
      signal,
    );
    const manifestDigest = sha256CanonicalJson(manifest);
    return Object.freeze({
      candidateFiles: Object.freeze(manifest.map((entry) => entry.path)),
      coverage: "complete",
      excludedPathCount,
      manifest: Object.freeze(manifest),
      manifestDigest,
      sourceFiles: Object.freeze(sourceFiles),
      ...(verificationProofAvailable ? {
        verificationProof: Object.freeze({
          directories: Object.freeze(directoryProofs),
          files: Object.freeze(fileProofs),
          manifestDigest,
        }),
      } : {}),
    });
  } catch (error) {
    if (error instanceof WorkspaceScanError) {
      throw error;
    }
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区安全扫描失败。", error);
  }
}

/**
 * 同步重放 scanner 的成员资格、路径 containment 与文件身份规则。
 *
 * 该函数只用于 SQLite 事务首次写入前的最终栅栏，禁止跨 await，避免事件循环回调
 * 在 `isCurrent` 与同步 commit 之间迟到而让旧 read-set 越过提交边界。
 */
export function verifyWorkspaceReadSetSync(
  options: VerifyWorkspaceReadSetSyncOptions,
): boolean {
  const platform = options.platform ?? process.platform;
  const maxCandidateFiles = normalizeLimit(
    options.maxCandidateFiles ?? MAX_CANDIDATE_SOURCE_FILES,
    MAX_CANDIDATE_SOURCE_FILES,
    "候选文件预算",
  );
  const maxScannedEntries = normalizeLimit(
    options.maxScannedEntries ?? MAX_SCANNED_ENTRIES,
    MAX_SCANNED_ENTRIES,
    "扫描目录项预算",
  );
  const maxTotalSourceBytes = normalizeLimit(
    options.maxTotalSourceBytes ?? MAX_TOTAL_SOURCE_BYTES,
    MAX_TOTAL_SOURCE_BYTES,
    "源码总字节预算",
  );
  const verificationProof = options.forceContentHash === true
    ? undefined
    : options.verificationProof;
  if (
    verificationProof !== undefined &&
    verificationProof.manifestDigest !== sha256CanonicalJson(options.expectedManifest)
  ) {
    return false;
  }

  try {
    const trustedRootRealpath = options.indexingRoot;
    const rootStatus = lstatSync(trustedRootRealpath, { bigint: true });
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 不是规范真实目录。");
    }
    const trustedRootIdentity = readPathIdentity(rootStatus);
    assertTrustedRootUnchangedSync(trustedRootRealpath, trustedRootIdentity);

    const candidates: Array<{
      absolutePath: string;
      expectedIdentity: PathIdentity | null;
      path: string;
    }> = [];
    const canonicalPaths = new Set<string>();
    const expectedDirectoryProofs = new Map(
      verificationProof?.directories.map((proof) => [proof.status.path, proof] as const) ?? [],
    );
    const expectedFileProofs = new Map(
      verificationProof?.files.map((proof) => [proof.path, proof] as const) ?? [],
    );
    const seenDirectoryProofs = new Set<string>();
    const seenFileProofs = new Set<string>();
    let scannedEntryCount = 0;
    let plannedSourceBytes = 0;
    const pendingDirectories = [{
      absolutePath: trustedRootRealpath,
      expectedIdentity: trustedRootIdentity,
      expectedRealpath: trustedRootRealpath,
      logicalPath: "",
    }];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop()!;
      const beforeDirectoryStatus = lstatSync(directory.absolutePath, { bigint: true });
      assertDirectoryIdentity(
        beforeDirectoryStatus,
        directory.expectedIdentity,
        "扫描目录已在排队后被替换。",
      );
      const beforeReadRealpath = assertRealpathContainedSync(
        trustedRootRealpath,
        directory.absolutePath,
        directory.logicalPath.length === 0,
      );
      if (beforeReadRealpath !== directory.expectedRealpath) {
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "扫描目录已在排队后被替换。");
      }
      const entries = readdirSync(directory.absolutePath, { withFileTypes: true })
        .sort((left, right) => compareCanonicalGraphText(left.name, right.name));
      const afterDirectoryStatus = lstatSync(directory.absolutePath, { bigint: true });
      assertDirectoryIdentity(
        afterDirectoryStatus,
        readPathIdentity(beforeDirectoryStatus),
        "扫描目录在读取期间被替换。",
      );
      if (assertRealpathContainedSync(
        trustedRootRealpath,
        directory.absolutePath,
        directory.logicalPath.length === 0,
      ) !== beforeReadRealpath) {
        throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "扫描目录在读取期间被替换。");
      }
      const semanticEntries: Array<{ kind: "directory" | "source-file"; path: string }> = [];

      for (const entry of entries) {
        scannedEntryCount += 1;
        if (scannedEntryCount > maxScannedEntries) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_LIMIT_EXCEEDED",
            "工作区目录项总数超过安全预算。",
          );
        }
        const relativePath = createLogicalRelativePath(
          directory.logicalPath,
          entry.name,
          platform,
        );
        if (canonicalPaths.has(relativePath)) {
          throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区包含规范化后冲突的路径。");
        }
        canonicalPaths.add(relativePath);
        if (isBuiltinIgnoredPath(relativePath, options.ignoreSnapshot) || entry.isSymbolicLink()) {
          continue;
        }
        const absolutePath = path.join(directory.absolutePath, entry.name);
        if (entry.isDirectory()) {
          const status = lstatSync(absolutePath, { bigint: true });
          if (!status.isDirectory() || status.isSymbolicLink()) {
            continue;
          }
          pendingDirectories.push({
            absolutePath,
            expectedIdentity: readPathIdentity(status),
            expectedRealpath: assertRealpathContainedSync(
              trustedRootRealpath,
              absolutePath,
              false,
            ),
            logicalPath: relativePath,
          });
          semanticEntries.push({ kind: "directory", path: relativePath });
          continue;
        }
        if (!entry.isFile() || !isSupportedSourceFile(relativePath)) {
          continue;
        }
        if (candidates.length >= maxCandidateFiles) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_LIMIT_EXCEEDED",
            "候选源码文件数超过安全预算。",
          );
        }
        const status = lstatSync(absolutePath, { bigint: true });
        if (!status.isFile() || status.isSymbolicLink()) {
          continue;
        }
        assertSingleLink(status, "候选源码不得使用多硬链接身份。");
        plannedSourceBytes += Number(status.size);
        if (!Number.isSafeInteger(plannedSourceBytes) || plannedSourceBytes > maxTotalSourceBytes) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_LIMIT_EXCEEDED",
            "工作区源码总字节数超过 512 MiB 安全上限。",
          );
        }
        assertRealpathContainedSync(trustedRootRealpath, absolutePath, false);
        candidates.push({
          absolutePath,
          expectedIdentity: readPathIdentity(status),
          path: relativePath,
        });
        semanticEntries.push({ kind: "source-file", path: relativePath });
        if (verificationProof !== undefined) {
          const currentFileProof = readPathVerificationProof(status, relativePath);
          const expectedFileProof = expectedFileProofs.get(relativePath);
          if (
            currentFileProof === null ||
            expectedFileProof === undefined ||
            !samePathVerificationProof(currentFileProof, expectedFileProof)
          ) {
            return false;
          }
          seenFileProofs.add(relativePath);
        }
      }
      if (verificationProof !== undefined) {
        const finalDirectoryStatus = lstatSync(directory.absolutePath, { bigint: true });
        assertDirectoryIdentity(
          finalDirectoryStatus,
          readPathIdentity(afterDirectoryStatus),
          "扫描目录在成员分类期间被替换。",
        );
        const currentDirectoryProof = readPathVerificationProof(
          finalDirectoryStatus,
          directory.logicalPath,
        );
        const expectedDirectoryProof = expectedDirectoryProofs.get(directory.logicalPath);
        if (
          currentDirectoryProof === null ||
          expectedDirectoryProof === undefined ||
          !sameDirectoryIdentityProof(currentDirectoryProof, expectedDirectoryProof.status) ||
          sha256CanonicalJson(semanticEntries) !== expectedDirectoryProof.semanticEntriesDigest
        ) {
          return false;
        }
        seenDirectoryProofs.add(directory.logicalPath);
      }
    }
    assertTrustedRootUnchangedSync(trustedRootRealpath, trustedRootIdentity);
    if (verificationProof !== undefined) {
      const candidatePaths = candidates
        .map((candidate) => candidate.path)
        .sort(compareCanonicalGraphText);
      const expectedPaths = options.expectedManifest.map((entry) => entry.path);
      return sha256CanonicalJson(candidatePaths) === sha256CanonicalJson(expectedPaths) &&
        seenDirectoryProofs.size === expectedDirectoryProofs.size &&
        seenFileProofs.size === expectedFileProofs.size;
    }
    const manifest: ManifestEntryV1[] = [];
    let hashedSourceBytes = 0;
    for (const candidate of candidates.sort((left, right) =>
      compareCanonicalGraphText(left.path, right.path))) {
      const hashed = hashTrustedFileSync(
        trustedRootRealpath,
        candidate.absolutePath,
        candidate.expectedIdentity,
      );
      hashedSourceBytes += hashed.byteLength;
      if (hashedSourceBytes > maxTotalSourceBytes) {
        throw new WorkspaceScanError(
          "GRAPH_SCAN_LIMIT_EXCEEDED",
          "工作区源码总字节数超过 512 MiB 安全上限。",
        );
      }
      manifest.push(Object.freeze({
        contentHash: hashed.contentHash,
        path: candidate.path,
      }));
    }
    assertTrustedRootUnchangedSync(trustedRootRealpath, trustedRootIdentity);
    return sha256CanonicalJson(manifest) === sha256CanonicalJson(options.expectedManifest);
  } catch (error) {
    if (error instanceof WorkspaceScanError) {
      throw error;
    }
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区同步最终复核失败。", error);
  }
}

/** 通过 O_NOFOLLOW 文件描述符同步 hash，并把路径身份与句柄身份双向绑定。 */
function hashTrustedFileSync(
  trustedRootRealpath: string,
  absolutePath: string,
  expectedIdentity: PathIdentity | null,
): { byteLength: number; contentHash: string } {
  const beforePathStatus = lstatSync(absolutePath, { bigint: true });
  if (!beforePathStatus.isFile() || beforePathStatus.isSymbolicLink()) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码在 hash 前不再是普通文件。");
  }
  assertPathIdentity(beforePathStatus, expectedIdentity, "候选源码在排队后被替换。");
  assertSingleLink(beforePathStatus, "候选源码不得使用多硬链接身份。");
  const beforeRealpath = assertRealpathContainedSync(
    trustedRootRealpath,
    absolutePath,
    false,
  );
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "已打开候选源码不是普通文件。");
    }
    assertOpenedFileIdentity(before, expectedIdentity, "已打开候选源码物理身份不一致。");
    assertSingleLink(before, "已打开候选源码不得使用多硬链接身份。");
    if (before.size > BigInt(MAX_SOURCE_FILE_BYTES)) {
      throw new WorkspaceScanError(
        "GRAPH_SCAN_LIMIT_EXCEEDED",
        "单个源码文件超过 10 MiB 安全上限。",
      );
    }
    assertOpenedFileBoundToPathSync(
      trustedRootRealpath,
      absolutePath,
      beforeRealpath,
      before,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    let position = 0;
    while (true) {
      const remainingWithSentinel = MAX_SOURCE_FILE_BYTES - byteLength + 1;
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, remainingWithSentinel),
        position,
      );
      if (bytesRead === 0) {
        break;
      }
      byteLength += bytesRead;
      if (byteLength > MAX_SOURCE_FILE_BYTES) {
        throw new WorkspaceScanError(
          "GRAPH_SCAN_LIMIT_EXCEEDED",
          "单个源码文件在读取期间超过 10 MiB 安全上限。",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (byteLength !== Number(before.size) || !sameOpenedFile(before, after)) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码在 hash 期间被替换或截断。");
    }
    assertSingleLink(after, "候选源码在 hash 期间形成了多硬链接身份。");
    assertOpenedFileBoundToPathSync(
      trustedRootRealpath,
      absolutePath,
      beforeRealpath,
      after,
    );
    return { byteLength, contentHash: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

/** 同步最终栅栏中确认路径仍绑定已打开的同一普通文件。 */
function assertOpenedFileBoundToPathSync(
  trustedRootRealpath: string,
  absolutePath: string,
  expectedRealpath: string,
  openedStatus: ScannerOpenedFileStatus,
): void {
  const pathStatus = lstatSync(absolutePath, { bigint: true });
  if (!pathStatus.isFile() || pathStatus.isSymbolicLink()) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码路径不再绑定普通文件。");
  }
  assertPathIdentity(
    pathStatus,
    { dev: openedStatus.dev, ino: openedStatus.ino },
    "候选源码路径与已打开文件身份不一致。",
  );
  if (assertRealpathContainedSync(trustedRootRealpath, absolutePath, false) !== expectedRealpath) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码在 hash 期间被路径替换。");
  }
}

/** 同步路径 containment 检查与异步 scanner 保持相同的 root 身份语义。 */
function assertRealpathContainedSync(
  rootRealpath: string,
  candidatePath: string,
  requireRootIdentity: boolean,
): string {
  const candidateRealpath = realpathSync(candidatePath);
  if (requireRootIdentity && candidateRealpath !== rootRealpath) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 已在启动后被替换。");
  }
  const relative = path.relative(rootRealpath, candidateRealpath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选真实路径逃逸 indexing root。");
  }
  return candidateRealpath;
}

/** 同步最终栅栏开始和结束都确认受信任 root 未被替换。 */
function assertTrustedRootUnchangedSync(
  trustedRootRealpath: string,
  expectedIdentity: PathIdentity | null,
): void {
  const status = lstatSync(trustedRootRealpath, { bigint: true });
  assertDirectoryIdentity(status, expectedIdentity, "indexing root 已在启动后被替换。");
  if (realpathSync(trustedRootRealpath) !== trustedRootRealpath) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 已在启动后被替换。");
  }
}

/**
 * 通过真实打开的文件句柄读取原始字节，并在读取前后验证身份与长度保持稳定。
 */
async function hashTrustedFile(
  trustedRootRealpath: string,
  absolutePath: string,
  expectedIdentity: PathIdentity | null,
  logicalPath: string,
  openFile: NonNullable<ScanWorkspaceOptions["openFile"]>,
  readStatus: NonNullable<ScanWorkspaceOptions["lstat"]>,
  resolveRealpath: NonNullable<ScanWorkspaceOptions["realpath"]>,
  signal?: AbortSignal,
): Promise<{
  byteLength: number;
  bytes: Uint8Array;
  contentHash: string;
  verificationProof: WorkspacePathVerificationProof | null;
}> {
  const beforePathStatus = await waitAbortable(readStatus(absolutePath), signal);
  if (!beforePathStatus.isFile() || beforePathStatus.isSymbolicLink()) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码在 hash 前不再是普通文件。");
  }
  assertPathIdentity(
    beforePathStatus,
    expectedIdentity,
    "候选源码在排队后被替换。",
  );
  assertSingleLink(beforePathStatus, "候选源码不得使用多硬链接身份。");
  const beforeRealpath = await assertRealpathContained(
    trustedRootRealpath,
    absolutePath,
    resolveRealpath,
    false,
    signal,
  );
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await waitAbortableResource(
    openFile(absolutePath, constants.O_RDONLY | noFollow),
    signal,
    (resource) => resource.close(),
  );
  try {
    const before = await waitAbortable(handle.stat({ bigint: true }), signal);
    if (!before.isFile()) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "已打开候选源码不是普通文件。");
    }
    assertOpenedFileIdentity(
      before,
      expectedIdentity,
      "已打开候选源码与扫描阶段记录的物理身份不一致。",
    );
    assertSingleLink(before, "已打开候选源码不得使用多硬链接身份。");
    if (before.size > BigInt(MAX_SOURCE_FILE_BYTES)) {
      throw new WorkspaceScanError(
        "GRAPH_SCAN_LIMIT_EXCEEDED",
        "单个源码文件超过 10 MiB 安全上限。",
      );
    }
    await assertOpenedFileBoundToPath(
      trustedRootRealpath,
      absolutePath,
      beforeRealpath,
      before,
      readStatus,
      resolveRealpath,
      signal,
    );
    const { byteLength, bytes, contentHash } = await hashOpenedFileWithinLimit(handle, signal);
    const after = await waitAbortable(handle.stat({ bigint: true }), signal);
    if (
      byteLength !== Number(before.size) ||
      !sameOpenedFile(before, after)
    ) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码在 hash 期间被替换或截断。");
    }
    assertSingleLink(after, "候选源码在 hash 期间形成了多硬链接身份。");
    await assertOpenedFileBoundToPath(
      trustedRootRealpath,
      absolutePath,
      beforeRealpath,
      after,
      readStatus,
      resolveRealpath,
      signal,
    );
    return {
      byteLength,
      bytes,
      contentHash,
      verificationProof: readPathVerificationProof(after, logicalPath),
    };
  } finally {
    await handle.close();
  }
}

/** 以固定小缓冲分块 hash，并在观察到第 10 MiB 之后的首个字节时立即失败。 */
async function hashOpenedFileWithinLimit(
  handle: ScannerFileHandle,
  signal?: AbortSignal,
): Promise<{ byteLength: number; bytes: Uint8Array; contentHash: string }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let position = 0;
  while (true) {
    throwIfAborted(signal);
    const remainingWithSentinel = MAX_SOURCE_FILE_BYTES - byteLength + 1;
    const readLength = Math.min(buffer.byteLength, remainingWithSentinel);
    const result = await waitAbortable(
      handle.read(buffer, 0, readLength, position),
      signal,
    );
    if (result.bytesRead === 0) {
      break;
    }
    byteLength += result.bytesRead;
    if (byteLength > MAX_SOURCE_FILE_BYTES) {
      throw new WorkspaceScanError(
        "GRAPH_SCAN_LIMIT_EXCEEDED",
        "单个源码文件在读取期间超过 10 MiB 安全上限。",
      );
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    position += result.bytesRead;
  }
  return {
    byteLength,
    bytes: copyChunksToSharedBuffer(chunks, byteLength),
    contentHash: hash.digest("hex"),
  };
}

/** 将 scanner 唯一源码快照落入共享内存，Worker structured clone 不再复制正文。 */
function copyChunksToSharedBuffer(chunks: readonly Buffer[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(new SharedArrayBuffer(byteLength));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** 在读取前后把路径当前身份与已打开句柄绑定，拒绝同路径替换与 reparse 竞态。 */
async function assertOpenedFileBoundToPath(
  trustedRootRealpath: string,
  absolutePath: string,
  expectedRealpath: string,
  openedStatus: ScannerOpenedFileStatus,
  readStatus: NonNullable<ScanWorkspaceOptions["lstat"]>,
  resolveRealpath: NonNullable<ScanWorkspaceOptions["realpath"]>,
  signal?: AbortSignal,
): Promise<void> {
  const pathStatus = await waitAbortable(readStatus(absolutePath), signal);
  if (!pathStatus.isFile() || pathStatus.isSymbolicLink()) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码路径不再绑定普通文件。");
  }
  assertPathIdentity(
    pathStatus,
    { dev: openedStatus.dev, ino: openedStatus.ino },
    "候选源码路径与已打开文件身份不一致。",
  );
  const currentRealpath = await assertRealpathContained(
    trustedRootRealpath,
    absolutePath,
    resolveRealpath,
    false,
    signal,
  );
  if (currentRealpath !== expectedRealpath) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选源码在 hash 期间被路径替换。");
  }
}

/** 已打开文件在 hash 前后必须保持设备、inode、长度与时间戳不变。 */
function sameOpenedFile(left: ScannerOpenedFileStatus, right: ScannerOpenedFileStatus): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink;
}

interface PathIdentity {
  dev: bigint;
  ino: bigint;
}

interface VerificationStatusFields {
  ctimeNs?: bigint;
  dev?: bigint | number;
  ino?: bigint | number;
  mtimeNs?: bigint;
  nlink?: bigint | number;
  size?: bigint | number;
}

/** 生产 fs.Stat 的稳定字段齐全时生成仅驻留内存的最终复核证明。 */
function readPathVerificationProof(
  status: VerificationStatusFields,
  logicalPath: string,
): WorkspacePathVerificationProof | null {
  if (
    status.ctimeNs === undefined ||
    status.dev === undefined ||
    status.ino === undefined ||
    status.mtimeNs === undefined ||
    status.nlink === undefined ||
    status.size === undefined
  ) {
    return null;
  }
  return Object.freeze({
    ctimeNs: status.ctimeNs,
    dev: BigInt(status.dev),
    ino: BigInt(status.ino),
    mtimeNs: status.mtimeNs,
    nlink: BigInt(status.nlink),
    path: logicalPath,
    size: BigInt(status.size),
  });
}

/** 最终栅栏按全部稳定元数据字段精确比较同一路径证明。 */
function samePathVerificationProof(
  left: WorkspacePathVerificationProof,
  right: WorkspacePathVerificationProof,
): boolean {
  return left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink;
}

/** 目录元数据会因 ignored/non-source 子项变化而改变；只绑定物理目录与语义成员摘要。 */
function sameDirectoryIdentityProof(
  left: WorkspacePathVerificationProof,
  right: WorkspacePathVerificationProof,
): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino;
}

/** 多硬链接会允许从 ignored 或根外别名改写源码而绕过根内 watcher。 */
function assertSingleLink(status: { nlink?: bigint | number }, message: string): void {
  if (status.nlink !== undefined && BigInt(status.nlink) !== 1n) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", message);
  }
}

/** 生产文件状态携带 dev/ino；测试替身可省略并由其余安全检查约束。 */
function readPathIdentity(status: ScannerPathStatus): PathIdentity | null {
  if (status.dev === undefined || status.ino === undefined) {
    return null;
  }
  return { dev: BigInt(status.dev), ino: BigInt(status.ino) };
}

/** 若预期身份可用，则路径必须继续指向同一物理对象。 */
function assertPathIdentity(
  status: ScannerPathStatus,
  expected: PathIdentity | null,
  message: string,
): void {
  if (expected === null) {
    return;
  }
  const current = readPathIdentity(status);
  if (current === null || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", message);
  }
}

/** 打开句柄必须仍指向扫描阶段记录的物理文件，防止预检查后的 swap-and-restore。 */
function assertOpenedFileIdentity(
  status: ScannerOpenedFileStatus,
  expected: PathIdentity | null,
  message: string,
): void {
  if (
    expected !== null &&
    (status.dev !== expected.dev || status.ino !== expected.ino)
  ) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", message);
  }
}

/** 目录必须保持普通目录类型与最初记录的物理身份。 */
function assertDirectoryIdentity(
  status: ScannerPathStatus,
  expected: PathIdentity | null,
  message: string,
): void {
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", message);
  }
  assertPathIdentity(status, expected, message);
}

/** 默认使用 bigint dev/ino，避免大文件标识在 number 转换时丢失精度。 */
async function defaultReadStatus(input: string): Promise<ScannerPathStatus> {
  return nativeLstat(input, { bigint: true });
}

/** 默认目录读取只返回 Dirent 元数据，不读取源码内容。 */
async function defaultReadDirectory(
  input: string,
  remainingEntryBudget: number,
  signal?: AbortSignal,
): Promise<readonly Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await waitAbortableResource(
    nativeOpendir(input),
    signal,
    (resource) => resource.close(),
  );
  for await (const entry of directory) {
    throwIfAborted(signal);
    if (entries.length >= remainingEntryBudget) {
      throw new WorkspaceScanError(
        "GRAPH_SCAN_LIMIT_EXCEEDED",
        "单目录读取超过剩余安全预算。",
      );
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * 为句柄类资源提供可取消获取：abort 先胜出时，迟到的成功结果会立即关闭而不会遗留锁。
 */
async function waitAbortableResource<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  closeResource: (resource: T) => Promise<void>,
): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) {
    return operation;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const removeAbortListener = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      void operation.then(
        (resource) => closeResource(resource).catch(() => undefined),
        () => undefined,
      );
      reject(new WorkspaceScanCancelledError("工作区扫描已被安全取消。"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    void operation.then(
      (resource) => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener();
        resolve(resource);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener();
        reject(error);
      },
    );
  });
}

/** 使用 path.relative 语义确认真实路径仍位于同一 indexing root。 */
async function assertRealpathContained(
  rootRealpath: string,
  candidatePath: string,
  resolveRealpath: (input: string) => Promise<string>,
  requireRootIdentity = false,
  signal?: AbortSignal,
): Promise<string> {
  const candidateRealpath = await waitAbortable(resolveRealpath(candidatePath), signal);
  if (requireRootIdentity && candidateRealpath !== rootRealpath) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 已在启动后被替换。");
  }
  const relative = path.relative(rootRealpath, candidateRealpath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选真实路径逃逸 indexing root。");
  }
  return candidateRealpath;
}

/** 每次扫描开始和结束都确认启动时受信任的物理 root 未被替换。 */
async function assertTrustedRootUnchanged(
  trustedRootRealpath: string,
  expectedIdentity: PathIdentity | null,
  readStatus: NonNullable<ScanWorkspaceOptions["lstat"]>,
  resolveRealpath: (input: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
  const status = await waitAbortable(readStatus(trustedRootRealpath), signal);
  assertDirectoryIdentity(status, expectedIdentity, "indexing root 已在启动后被替换。");
  const currentRealpath = await waitAbortable(resolveRealpath(trustedRootRealpath), signal);
  if (currentRealpath !== trustedRootRealpath) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 已在启动后被替换。");
  }
}

/** 在每个异步文件系统边界传播 shutdown 取消，避免关闭流程等待不可控扫描。 */
async function waitAbortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (signal === undefined) {
    return operation;
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new WorkspaceScanCancelledError("工作区扫描已被安全取消。"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** 在同步循环边界快速响应 shutdown 取消。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new WorkspaceScanCancelledError("工作区扫描已被安全取消。");
  }
}

/** 从原始目录项生成 NFC/POSIX 公共路径，并拒绝 POSIX 反斜杠名称歧义。 */
function createLogicalRelativePath(
  directoryPath: string,
  entryName: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32" && entryName.includes("\\")) {
    throw new WorkspaceScanError(
      "GRAPH_SCAN_FAILED",
      "POSIX 文件名包含无法安全映射的反斜杠。",
    );
  }
  return normalizeRelativeGraphPath(
    directoryPath.length === 0 ? entryName : `${directoryPath}/${entryName}`,
  );
}

/** 将测试注入或生产默认预算收敛为正整数。 */
function normalizeLimit(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label}必须位于安全上限内。`);
  }
  return value;
}
