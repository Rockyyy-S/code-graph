import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ServiceErrorCode } from "@codegraph/contracts";

/** 最小本地安全日志字段；不接受任意对象、路径、token 或堆栈。 */
export interface SafeLogEntry {
  code?: ServiceErrorCode;
  event: "connection-error" | "handshake-rejected" | "service-started";
  logId: string;
}

/** Story 1.2 的最小追加日志，不提前实现轮转或容量治理。 */
export class SafeLocalLogger {
  readonly #handle: FileHandle;
  #closed = false;
  #closingPromise: Promise<void> | null = null;

  public constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  /** 写入已收敛字段的单行 JSON 记录。 */
  public async record(entry: SafeLogEntry): Promise<void> {
    if (this.#closed) {
      return;
    }
    try {
      await this.#handle.appendFile(
        `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
        "utf8",
      );
    } catch {
      /** 最小诊断日志失败不能扩大为服务崩溃；完整日志健康治理属于 Story 1.16。 */
    }
  }

  /** 关闭日志句柄。 */
  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (this.#closingPromise !== null) {
      return this.#closingPromise;
    }
    this.#closingPromise = this.#handle.close()
      .then(() => {
        this.#closed = true;
      })
      .finally(() => {
        this.#closingPromise = null;
      });
    return this.#closingPromise;
  }
}

/**
 * 创建安全日志的原子打开标志。
 *
 * POSIX 必须使用 O_NOFOLLOW 拒绝预先放置的符号链接；可注入标志值仅用于跨平台测试。
 */
export function createSafeLogOpenFlags(
  platform: NodeJS.Platform = process.platform,
  noFollowFlag: number = fsConstants.O_NOFOLLOW ?? 0,
  nonBlockFlag: number = fsConstants.O_NONBLOCK ?? 0,
): number {
  const baseFlags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY;
  if (platform === "win32") {
    return baseFlags;
  }
  if (noFollowFlag === 0 || nonBlockFlag === 0) {
    throw new Error("当前 POSIX 平台缺少安全文件打开标志，拒绝创建安全日志。");
  }
  return baseFlags | noFollowFlag | nonBlockFlag;
}

/** 在受限 workspace 缓存目录创建本地日志，并在打开前收紧既有目录权限。 */
export async function createSafeLocalLogger(
  workspaceDirectory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<SafeLocalLogger> {
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  if (platform !== "win32") {
    await chmod(workspaceDirectory, 0o700);
  }
  const logPath = path.join(workspaceDirectory, "service.log");
  const handle = await open(logPath, createSafeLogOpenFlags(platform), 0o600);
  try {
    const statistics = await handle.stat();
    if (!statistics.isFile()) {
      throw new Error("安全日志路径必须是普通文件。");
    }
    if (statistics.nlink !== 1) {
      throw new Error("安全日志路径不能存在额外硬链接。");
    }
    if (platform !== "win32") {
      await handle.chmod(0o600);
    }
    return new SafeLocalLogger(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
