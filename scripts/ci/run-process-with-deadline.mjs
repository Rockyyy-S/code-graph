import { spawn } from "node:child_process";

/**
 * 以 shell:false 执行进程，并用绝对 deadline、升级终止和有界输出保证最终收敛。
 *
 * @param {{args:string[],cleanupProcessTree?:(child:import("node:child_process").ChildProcess,timeoutMs:number)=>Promise<void>,cleanupProcessTreeOnExit?:boolean,cwd:string,env?:NodeJS.ProcessEnv,executable:string,killGraceMs?:number,outputLimitBytes?:number,spawnProcess?:typeof spawn,timeoutMs:number,windowsVerbatimArguments?:boolean}} options 进程执行参数。
 */
export function runProcessWithDeadline(options) {
  const timeoutMs = options.timeoutMs;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const outputLimitBytes = options.outputLimitBytes ?? 16 * 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(killGraceMs) ||
    killGraceMs <= 0 ||
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes <= 0
  ) {
    throw new TypeError("进程 deadline、终止宽限和输出上限必须是正安全整数。");
  }
  return new Promise((resolve) => {
    const stdout = createBoundedCollector(outputLimitBytes);
    const stderr = createBoundedCollector(outputLimitBytes);
    let child;
    let deadline;
    let forceKill;
    let settleFallback;
    let postExitDeadline;
    let settled = false;
    let timedOut = false;
    let closeObserved = false;
    let cleanupStarted = false;
    let cleanupSucceeded = options.cleanupProcessTreeOnExit === false;
    let exitResult = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      clearTimeout(forceKill);
      clearTimeout(settleFallback);
      clearTimeout(postExitDeadline);
      resolve({
        ...result,
        stderr: stderr.bytes(),
        stderrBytes: stderr.totalBytes(),
        stderrTruncated: stderr.truncated(),
        stdout: stdout.bytes(),
        stdoutBytes: stdout.totalBytes(),
        stdoutTruncated: stdout.truncated(),
      });
    };
    const finishExitedProcess = () => {
      if (exitResult !== null && closeObserved && cleanupSucceeded) {
        finish(exitResult);
      }
    };
    const beginExitCleanup = () => {
      if (cleanupStarted) {
        finishExitedProcess();
        return;
      }
      cleanupStarted = true;
      // close 依赖后代释放继承的 stdio；无论 cleanup Promise 如何结束都保留硬收敛上限。
      postExitDeadline = setTimeout(() => {
        finish(postExitFailure(cleanupSucceeded ? "EPIPEOPEN" : "EPROCESSCLEANUPTIMEOUT"));
      }, killGraceMs);
      if (cleanupSucceeded) {
        finishExitedProcess();
        return;
      }
      const cleanup = options.cleanupProcessTree ?? cleanupProcessTreeAfterExit;
      void Promise.resolve()
        .then(() => cleanup(child, killGraceMs))
        .then(() => {
          if (settled) {
            return;
          }
          cleanupSucceeded = true;
          finishExitedProcess();
        })
        .catch(() => {
          finish(postExitFailure("EPROCESSCLEANUP"));
        });
    };
    try {
      const spawnProcess = options.spawnProcess ?? spawn;
      child = spawnProcess(options.executable, options.args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env ?? process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: options.windowsVerbatimArguments === true,
      });
    } catch (error) {
      finish(spawnError(error));
      return;
    }
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => {
      if (!timedOut) {
        finish(spawnError(error));
      }
    });
    child.once("exit", (code, signal) => {
      if (timedOut || settled) {
        return;
      }
      // 主进程已经退出后，原执行 deadline 不得再覆盖其真实退出结论。
      clearTimeout(deadline);
      exitResult = processExitResult(code, signal);
      beginExitCleanup();
    });
    child.once("close", (code, signal) => {
      if (timedOut) {
        return;
      }
      closeObserved = true;
      if (exitResult === null) {
        clearTimeout(deadline);
        exitResult = processExitResult(code, signal);
        beginExitCleanup();
      }
      finishExitedProcess();
    });
    deadline = setTimeout(() => {
      if (settled || exitResult !== null) {
        return;
      }
      timedOut = true;
      if (process.platform === "win32") {
        // taskkill /T /F 已同时完成树遍历和强制终止，无需重复同步调用。
        void terminateProcessTree(child, "SIGKILL", killGraceMs)
          .catch(() => undefined)
          .finally(() => finish(timeoutResult()));
        return;
      }
      void terminateProcessTree(child, "SIGTERM", killGraceMs).catch(() => undefined).finally(() => {
        forceKill = setTimeout(() => {
          void terminateProcessTree(child, "SIGKILL", killGraceMs).catch(() => undefined).finally(() => {
            settleFallback = setTimeout(() => finish(timeoutResult()), killGraceMs);
          });
        }, killGraceMs);
      });
    }, timeoutMs);
  });
}

/** 正常退出后使用独立 deadline 清理残留后代，不复用已完成的执行 deadline。 */
function cleanupProcessTreeAfterExit(child, timeoutMs) {
  if (process.platform !== "win32") {
    return terminateProcessTree(child, "SIGTERM", timeoutMs).then(() =>
      terminateProcessTree(child, "SIGKILL", timeoutMs),
    );
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return Promise.resolve();
  }
  return runWindowsTaskkill(child.pid, timeoutMs);
}

/** 使用异步 taskkill 和独立 timeout 回收 Windows 进程树，禁止阻塞事件循环。 */
function runWindowsTaskkill(pid, timeoutMs) {
  return new Promise((resolve, reject) => {
    let complete = false;
    let cleanupChild;
    const finish = (error) => {
      if (complete) {
        return;
      }
      complete = true;
      clearTimeout(fallback);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const fallback = setTimeout(() => {
      cleanupChild?.kill();
      finish(new Error("Windows process tree cleanup timed out."));
    }, timeoutMs);
    try {
      cleanupChild = spawn(
        "taskkill.exe",
        ["/PID", `${pid}`, "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      cleanupChild.once("error", (error) => finish(error));
      cleanupChild.once("close", (code) => {
        // 128 表示目标已不存在；主进程已经退出时这是安全的幂等结果。
        finish(code === 0 || code === 128
          ? undefined
          : new Error(`taskkill exited with code ${code ?? "unknown"}.`));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("taskkill spawn failed."));
    }
  });
}

/** 终止完整进程树；POSIX 使用独立进程组，Windows 使用 taskkill /T。 */
async function terminateProcessTree(child, signal, timeoutMs) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return;
  }
  if (process.platform === "win32") {
    await runWindowsTaskkill(child.pid, timeoutMs);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) {
      child.kill(signal);
    }
  }
}

/** 缓存主进程的真实退出结论，供 close 与独立 cleanup 完成后统一发布。 */
function processExitResult(code, signal) {
  return {
    status: code === 0 ? "pass" : "fail",
    termination:
      signal === null
        ? { code: code ?? 1, kind: "exit" }
        : { kind: "signal", signalName: signal },
  };
}

/** 创建只保留固定上限、同时记录原始总字节数的 collector。 */
function createBoundedCollector(limitBytes) {
  const chunks = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      const remaining = limitBytes - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    },
    bytes: () => Buffer.concat(chunks),
    totalBytes: () => totalBytes,
    truncated: () => totalBytes > capturedBytes,
  };
}

/** 将启动异常收敛为不泄露本机路径或堆栈的稳定 invalid。 */
function spawnError(error) {
  return {
    status: "invalid",
    termination: {
      kind: "spawn-error",
      stableCode:
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "UNKNOWN",
    },
  };
}

/** deadline 到期统一使用稳定 ETIMEDOUT，不依赖平台信号名称。 */
function timeoutResult() {
  return {
    status: "invalid",
    termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
  };
}

/** cleanup 或 stdio 收敛失败统一返回稳定 invalid，不得保留原进程 pass。 */
function postExitFailure(stableCode) {
  return {
    status: "invalid",
    termination: { kind: "spawn-error", stableCode },
  };
}
