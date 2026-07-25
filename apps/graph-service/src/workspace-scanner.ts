import type { Dirent, Stats } from "node:fs";
import {
  lstat as nativeLstat,
  opendir as nativeOpendir,
  realpath as nativeRealpath,
} from "node:fs/promises";
import path from "node:path";
import {
  isSupportedSourceFile,
  normalizeRelativeGraphPath,
} from "@codegraph/application";
import {
  isBuiltinIgnoredPath,
  type EffectiveIgnoreSnapshotV1,
} from "./ignore-bootstrap.js";

/** 单次可信扫描允许纳入的最大源码文件数。 */
export const MAX_CANDIDATE_SOURCE_FILES = 20_000;

/** 单次可信扫描允许观察的最大目录项总数。 */
export const MAX_SCANNED_ENTRIES = 100_000;

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

/** scanner 可注入的最小目录项边界。 */
export interface ScannerDirectoryEntry {
  isDirectory: () => boolean;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
  name: string;
}

/** 安全工作区扫描参数。 */
export interface ScanWorkspaceOptions {
  ignoreSnapshot: EffectiveIgnoreSnapshotV1;
  indexingRoot: string;
  lstat?: (input: string) => Promise<Pick<Stats, "isDirectory" | "isFile" | "isSymbolicLink">>;
  maxCandidateFiles?: number;
  maxScannedEntries?: number;
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
  excludedPathCount: number;
}

/**
 * 遍历 realpath 后的 indexing root，只返回 BuiltinIgnoreV1 保护下的 TS/JS 候选。
 *
 * 适配层不读取源码正文、不跟随符号链接，也不把绝对路径返回 application。
 */
export async function scanWorkspace(options: ScanWorkspaceOptions): Promise<WorkspaceScanResult> {
  const resolveRealpath = options.realpath ?? nativeRealpath;
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const readStatus = options.lstat ?? nativeLstat;
  const platform = options.platform ?? process.platform;
  const signal = options.signal;
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

  try {
    throwIfAborted(signal);
    const trustedRootRealpath = options.indexingRoot;
    await assertTrustedRootUnchanged(trustedRootRealpath, resolveRealpath, signal);
    const rootStatus = await waitAbortable(readStatus(trustedRootRealpath), signal);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 不是规范真实目录。");
    }

    const candidateFiles: string[] = [];
    const canonicalPaths = new Set<string>();
    let excludedPathCount = 0;
    let scannedEntryCount = 0;
    const pendingDirectories = [{
      absolutePath: trustedRootRealpath,
      expectedRealpath: trustedRootRealpath,
      logicalPath: "",
    }];
    while (pendingDirectories.length > 0) {
      throwIfAborted(signal);
      const directory = pendingDirectories.pop()!;
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
        .sort((left, right) => left.name.localeCompare(right.name));
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
            expectedRealpath: childRealpath,
            logicalPath: relativePath,
          });
          continue;
        }
        if (!entry.isFile() || !isSupportedSourceFile(relativePath)) {
          continue;
        }
        if (candidateFiles.length >= maxCandidateFiles) {
          throw new WorkspaceScanError(
            "GRAPH_SCAN_LIMIT_EXCEEDED",
            "候选源码文件数超过安全预算。",
          );
        }
        const status = await waitAbortable(readStatus(absolutePath), signal);
        if (!status.isFile() || status.isSymbolicLink()) {
          continue;
        }
        await assertRealpathContained(
          trustedRootRealpath,
          absolutePath,
          resolveRealpath,
          false,
          signal,
        );
        candidateFiles.push(relativePath);
      }
    }
    await assertTrustedRootUnchanged(trustedRootRealpath, resolveRealpath, signal);
    return Object.freeze({
      candidateFiles: Object.freeze(candidateFiles.sort((left, right) => left.localeCompare(right))),
      excludedPathCount,
    });
  } catch (error) {
    if (error instanceof WorkspaceScanError) {
      throw error;
    }
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区安全扫描失败。", error);
  }
}

/** 默认目录读取只返回 Dirent 元数据，不读取源码内容。 */
async function defaultReadDirectory(
  input: string,
  remainingEntryBudget: number,
  signal?: AbortSignal,
): Promise<readonly Dirent[]> {
  const entries: Dirent[] = [];
  const directory = await waitAbortable(nativeOpendir(input), signal);
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
  resolveRealpath: (input: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<void> {
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
        onAbort = () => reject(
          new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区扫描已被安全取消。"),
        );
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
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "工作区扫描已被安全取消。");
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
