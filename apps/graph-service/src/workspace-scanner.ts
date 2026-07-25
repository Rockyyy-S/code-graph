import type { Dirent, Stats } from "node:fs";
import {
  lstat as nativeLstat,
  readdir as nativeReaddir,
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
  readDirectory?: (input: string) => Promise<readonly ScannerDirectoryEntry[]>;
  realpath?: (input: string) => Promise<string>;
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
  const maxCandidateFiles = normalizeLimit(
    options.maxCandidateFiles ?? MAX_CANDIDATE_SOURCE_FILES,
  );

  try {
    const rootRealpath = await resolveRealpath(options.indexingRoot);
    const rootStatus = await readStatus(rootRealpath);
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "indexing root 不是规范真实目录。");
    }

    const candidateFiles: string[] = [];
    let excludedPathCount = 0;
    const pendingDirectories = [""];
    while (pendingDirectories.length > 0) {
      const directoryPath = pendingDirectories.pop()!;
      const absoluteDirectory = directoryPath.length === 0
        ? rootRealpath
        : path.join(rootRealpath, ...directoryPath.split("/"));
      const entries = [...await readDirectory(absoluteDirectory)]
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = normalizeRelativeGraphPath(
          directoryPath.length === 0 ? entry.name : `${directoryPath}/${entry.name}`,
        );
        if (isBuiltinIgnoredPath(relativePath, options.ignoreSnapshot)) {
          excludedPathCount += 1;
          continue;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        const absolutePath = path.join(rootRealpath, ...relativePath.split("/"));
        if (entry.isDirectory()) {
          const status = await readStatus(absolutePath);
          if (!status.isDirectory() || status.isSymbolicLink()) {
            continue;
          }
          await assertRealpathContained(rootRealpath, absolutePath, resolveRealpath);
          pendingDirectories.push(relativePath);
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
        const status = await readStatus(absolutePath);
        if (!status.isFile() || status.isSymbolicLink()) {
          continue;
        }
        await assertRealpathContained(rootRealpath, absolutePath, resolveRealpath);
        candidateFiles.push(relativePath);
      }
    }
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
async function defaultReadDirectory(input: string): Promise<readonly Dirent[]> {
  return nativeReaddir(input, { withFileTypes: true });
}

/** 使用 path.relative 语义确认真实路径仍位于同一 indexing root。 */
async function assertRealpathContained(
  rootRealpath: string,
  candidatePath: string,
  resolveRealpath: (input: string) => Promise<string>,
): Promise<void> {
  const candidateRealpath = await resolveRealpath(candidatePath);
  const relative = path.relative(rootRealpath, candidateRealpath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new WorkspaceScanError("GRAPH_SCAN_FAILED", "候选真实路径逃逸 indexing root。");
  }
}

/** 将测试注入或生产默认的文件数预算收敛为正整数。 */
function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_CANDIDATE_SOURCE_FILES) {
    throw new RangeError("候选文件预算必须位于安全上限内。");
  }
  return value;
}
