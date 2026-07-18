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
      // 最小诊断日志失败不能扩大为服务崩溃；完整日志健康治理属于 Story 1.16。
    }
  }

  /** 关闭日志句柄。 */
  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close();
  }
}

/** 在受限 workspace 缓存目录创建本地日志。 */
export async function createSafeLocalLogger(
  workspaceDirectory: string,
): Promise<SafeLocalLogger> {
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  const logPath = path.join(workspaceDirectory, "service.log");
  const handle = await open(logPath, "a", 0o600);
  if (process.platform !== "win32") {
    await chmod(logPath, 0o600);
  }
  return new SafeLocalLogger(handle);
}
