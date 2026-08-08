import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  runProcessWithDeadline,
  terminatePosixProcessTreeForTests,
} from "../../scripts/ci/run-process-with-deadline.mjs";
import { PROCESS_LIFECYCLE_BUDGET } from "../../vitest.process-deadline.config.js";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
/** Windows taskkill 在并行测试的高进程负载下需要独立且有界的 10 秒清理预算。 */
const processCleanupGraceMs = process.platform === "win32" ? 10_000 : 50;
const requestedStressRounds = Number.parseInt(
  process.env.CODEGRAPH_PROCESS_DEADLINE_STRESS_ROUNDS ?? "1",
  10,
);
/** 压力轮数必须显式受控，避免无界环境值把 blocking unit 变为资源耗尽。 */
const processDeadlineStressRounds = Number.isSafeInteger(requestedStressRounds) &&
  requestedStressRounds >= 1 && requestedStressRounds <= 20
  ? requestedStressRounds
  : 1;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      // Windows 刚终止进程树时句柄释放存在短暂延迟，使用 fs.rm 的有界 EBUSY 重试。
      rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
    ),
  );
});

/** 等待指定 PID 确认消失，超时后由测试清理兜底终止。 */
async function expectProcessGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PID ${pid} 在终态证明后仍存活。`);
}

/** 构造会写出 PID 正向握手、随后尝试写 marker 的长期后代脚本。 */
function createReadyDescendant(marker: string, delayMs = 750): string {
  return [
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), ${delayMs});`,
    "setInterval(() => {}, 1_000);",
  ].join("");
}

/** 构造可注入 POSIX 快照的 PID + 启动时刻稳定身份记录。 */
function posixIdentity(
  pid: number,
  parentPid: number,
  start: number,
  processGroupId = pid,
  sessionId = processGroupId,
) {
  return { identity: `${pid}:${start}`, parentPid, pid, processGroupId, sessionId };
}

/** 在同一轮中执行一个带 descendant-ready/PID 正向握手的 Windows 进程树场景。 */
async function runReadyWindowsScenario(
  kind: "normal-exit-background" | "orphan-grandchild" | "timeout",
  round: number,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `process-deadline-${kind}-${round}-`));
  temporaryRoots.push(root);
  const marker = path.join(root, "descendant-survived.txt");
  const readyPath = path.join(root, "descendant.pid");
  const descendant = createReadyDescendant(marker, kind === "timeout" ? 5_000 : 750);
  const directParent = [
    "const { spawn } = require(\"node:child_process\");",
    "const { writeFileSync } = require(\"node:fs\");",
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));`,
    "child.unref();",
    ...(kind === "timeout" ? ["setInterval(() => {}, 1_000);"] : []),
  ].join("");
  const intermediate = [
    "const { spawn } = require(\"node:child_process\");",
    "const { writeFileSync } = require(\"node:fs\");",
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], ` +
      "{ detached: true, stdio: \"ignore\" });",
    `writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));`,
    "child.unref();",
  ].join("");
  const orphanParent = [
    "const { spawn } = require(\"node:child_process\");",
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(intermediate)}], ` +
      "{ stdio: \"ignore\" });",
    "child.once(\"exit\", () => process.exit(0));",
  ].join("");
  const result = await runProcessWithDeadline({
    args: ["-e", kind === "orphan-grandchild" ? orphanParent : directParent],
    cwd: root,
    executable: process.execPath,
    killGraceMs: processCleanupGraceMs,
    outputLimitBytes: 1024,
    timeoutMs: kind === "timeout" ? 3_000 : 8_000,
    windowsDescendantReadyPath: readyPath,
  });
  const descendantPid = Number.parseInt(await readFile(readyPath, "utf8"), 10);

  expect(result).toMatchObject({
    status: kind === "timeout" ? "invalid" : "pass",
    termination: kind === "timeout"
      ? { kind: "spawn-error", stableCode: "ETIMEDOUT" }
      : { code: 0, kind: "exit" },
    windowsJob: {
      activeProcesses: 0,
      descendantPid,
      terminalProof: "query-information-job-object",
    },
  });
  await expectProcessGone(descendantPid);
  await new Promise((resolve) => setTimeout(resolve, kind === "timeout" ? 100 : 900));
  await expect(access(marker)).rejects.toBeDefined();
}
describe("process deadline", () => {
  it("CR6-011 rejects timeout and cleanup values above the Node timer ceiling", () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    };
    fakeChild.kill = () => true;
    fakeChild.pid = 4311;
    fakeChild.stderr = new PassThrough();
    fakeChild.stdout = new PassThrough();
    const spawnProcess = (() => {
      queueMicrotask(() => {
        fakeChild.emit("exit", 0, null);
        fakeChild.emit("close", 0, null);
      });
      return fakeChild;
    }) as never;
    const base = {
      args: [],
      cleanupProcessTreeOnExit: false,
      cwd: process.cwd(),
      executable: process.execPath,
      outputLimitBytes: 1024,
      spawnProcess,
    };

    expect(() => runProcessWithDeadline({
      ...base,
      killGraceMs: 50,
      timeoutMs: 3_000_000_000,
    })).toThrow(/timer|上限/u);
    expect(() => runProcessWithDeadline({
      ...base,
      killGraceMs: 3_000_000_000,
      timeoutMs: 50,
    })).toThrow(/timer|上限/u);
  });

  it.each([
    [
      "setsid/setpgid 逃逸后代仍由稳定身份闭包升级终止并证明 residual=0",
      [
        [posixIdentity(5100, 1, 11), posixIdentity(5101, 5100, 12, 5101, 5101)],
        [posixIdentity(5100, 1, 11), posixIdentity(5101, 1, 12, 5101, 5101)],
        [posixIdentity(5101, 1, 12, 5101, 5101)],
        [],
        [],
      ],
      null,
    ],
    ["containment provider 不可用时 fail closed", [[]], "EPROCESSCONTAINMENTUNAVAILABLE"],
    [
      "同 PID 启动身份变化时拒绝歧义并 fail closed",
      [[posixIdentity(5200, 1, 21)], [posixIdentity(5200, 1, 22)]],
      "EPROCESSIDENTITYAMBIGUOUS",
    ],
  ] as const)("PF-A %s", async (_label, scriptedSnapshots, expectedStableCode) => {
    let snapshotIndex = 0;
    const processSignals: Array<{ pid: number; signal: string }> = [];
    const groupSignals: Array<{ pid: number; signal: string }> = [];
    const snapshotProvider = async () => scriptedSnapshots[
      Math.min(snapshotIndex++, scriptedSnapshots.length - 1)
    ];
    const run = terminatePosixProcessTreeForTests(
      { pid: expectedStableCode === "EPROCESSIDENTITYAMBIGUOUS" ? 5200 : 5100 },
      100,
      snapshotProvider,
      {
        signalGroup: (pid: number, signal: string) => groupSignals.push({ pid, signal }),
        signalProcess: (pid: number, signal: string) => processSignals.push({ pid, signal }),
        sleep: async () => undefined,
        termSettleMs: 0,
      },
    );

    if (expectedStableCode !== null) {
      await expect(run).rejects.toMatchObject({ stableCode: expectedStableCode });
      return;
    }
    await expect(run).resolves.toMatchObject({
      cleanupComplete: true,
      containment: "posix-stable-identity-descendant-closure",
      residualProcessTree: 0,
      signalEscalation: ["SIGTERM", "SIGKILL"],
    });
    expect(groupSignals).toEqual([{ pid: 5100, signal: "SIGTERM" }]);
    expect(processSignals).toContainEqual({ pid: 5101, signal: "SIGKILL" });
  });

  it.each(["stdout/stderr"])("PF-A %s 双流必须在 cleanup 后完整排空", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    };
    child.kill = () => true;
    child.pid = 5300;
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();
    const resultPromise = runProcessWithDeadline({
      args: [],
      cleanupProcessTree: async () => ({
        cleanupComplete: true,
        containment: "test-stable-identity",
        residualProcessTree: 0,
        signalEscalation: [],
      }),
      cwd: process.cwd(),
      executable: process.execPath,
      killGraceMs: 100,
      outputLimitBytes: 1024,
      spawnProcess: (() => child) as never,
      timeoutMs: 500,
    });
    child.stdout.write("stdout-complete");
    child.stderr.write("stderr-complete");
    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      cleanupComplete: true,
      residualProcessTree: 0,
      status: "pass",
      streamsDrained: true,
    });
    const result = await resultPromise;
    expect(result.stdout.toString("utf8")).toBe("stdout-complete");
    expect(result.stderr.toString("utf8")).toBe("stderr-complete");
  });

  it.each(["setsid escape"])("PF-A POSIX runtime fixture: %s", async () => {
    if (process.platform === "win32") {
      console.warn("PF-A POSIX runtime fixture NOT_RUN on win32");
      return;
    }
    const escapedChild = [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("escaped-child-ready\\n");',
      "setInterval(() => {}, 1_000);",
    ].join("");
    const root = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(escapedChild)}], ` +
        '{ detached: true, stdio: ["ignore", "inherit", "inherit"] });',
      'process.stdout.write(`escaped-pid:${child.pid}\\n`);',
      "setInterval(() => {}, 1_000);",
    ].join("");
    const result = await runProcessWithDeadline({
      args: ["-e", root],
      cwd: process.cwd(),
      executable: process.execPath,
      killGraceMs: 2_000,
      outputLimitBytes: 4_096,
      timeoutMs: 300,
    });
    const pidMatch = /escaped-pid:([1-9][0-9]*)/u.exec(result.stdout.toString("utf8"));

    expect(pidMatch).not.toBeNull();
    expect(result).toMatchObject({
      cleanupComplete: true,
      containment: "posix-stable-identity-descendant-closure",
      residualProcessTree: 0,
      signalEscalation: ["SIGTERM", "SIGKILL"],
      status: "invalid",
      streamsDrained: true,
      termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
      timedOut: true,
    });
    await expectProcessGone(Number.parseInt(pidMatch![1]!, 10));
  });

  it("CR6-005 does not treat root exit as Windows descendant-tree convergence", async () => {
    const module = await import("../../scripts/ci/run-process-with-deadline.mjs") as {
      terminateWindowsProcessTreeForTests?: (
        child: EventEmitter & { kill: () => boolean; pid: number },
        timeoutMs: number,
        runTaskkill: () => Promise<void>,
      ) => Promise<void>;
    };
    expect(module.terminateWindowsProcessTreeForTests).toBeTypeOf("function");
    if (module.terminateWindowsProcessTreeForTests === undefined) {return;}
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean; pid: number };
    child.kill = () => {
      queueMicrotask(() => {
        child.emit("exit", 0, "SIGBREAK");
        child.emit("close", 0, "SIGBREAK");
      });
      return true;
    };
    child.pid = 4305;

    await expect(module.terminateWindowsProcessTreeForTests(
      child,
      50,
      async () => {throw new Error("taskkill failed");},
    )).rejects.toThrow(/taskkill failed/u);
  });

  it("CR7-005 returns EPROCESSCLEANUP when taskkill 128 leaves a detached descendant alive", async () => {
    const module = await import("../../scripts/ci/run-process-with-deadline.mjs") as {
      terminateWindowsProcessTreeForTests?: (
        child: EventEmitter & { kill: () => boolean; pid: number },
        timeoutMs: number,
        runTaskkill: () => Promise<{ code: number }>,
        verifyDescendants: (rootPid: number, timeoutMs: number) => Promise<boolean>,
        waitForRootClose?: (timeoutMs: number) => Promise<void>,
      ) => Promise<void>;
    };
    expect(module.terminateWindowsProcessTreeForTests).toBeTypeOf("function");
    if (module.terminateWindowsProcessTreeForTests === undefined) {return;}
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    };
    child.kill = () => true;
    child.pid = 4307;
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();

    const result = await runProcessWithDeadline({
      args: [],
      cleanupProcessTree: async (_cleanupChild, timeoutMs) =>
        module.terminateWindowsProcessTreeForTests!(
          child,
          timeoutMs,
          async () => ({ code: 128 }),
          async () => false,
        ),
      cwd: process.cwd(),
      executable: process.execPath,
      killGraceMs: 50,
      outputLimitBytes: 1024,
      spawnProcess: (() => {
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      }) as never,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "EPROCESSCLEANUP" },
    });

    /** VAL14：无后代根进程必须先完成 close，再执行同一次后代级收敛证明。 */
    const childWithoutDescendants = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
    };
    let closeObserved = false;
    childWithoutDescendants.kill = () => {
      setImmediate(() => {
        closeObserved = true;
        childWithoutDescendants.emit("exit", 0, "SIGBREAK");
        childWithoutDescendants.emit("close", 0, "SIGBREAK");
      });
      return true;
    };
    childWithoutDescendants.pid = 4308;

    const waitForRootClose = async () => {
      if (closeObserved) {return;}
      await new Promise<void>((resolve) =>
        childWithoutDescendants.once("close", () => resolve()),
      );
    };
    await expect(module.terminateWindowsProcessTreeForTests(
      childWithoutDescendants,
      50,
      async () => ({ code: 128 }),
      async () => closeObserved,
      waitForRootClose,
    )).resolves.toBeUndefined();
  });

  it("主进程正常退出后使用独立 cleanup deadline，不被原执行 deadline 覆盖", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    };
    child.kill = () => true;
    child.pid = 4321;
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();
    const startedAt = Date.now();
    const result = await runProcessWithDeadline({
      args: [],
      cleanupProcessTree: async () =>
        new Promise<void>((resolve) => setTimeout(resolve, 80)),
      cwd: process.cwd(),
      executable: process.execPath,
      killGraceMs: 150,
      outputLimitBytes: 1024,
      spawnProcess: (() => {
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      }) as never,
      timeoutMs: 40,
    });

    expect(result).toMatchObject({
      status: "pass",
      termination: { code: 0, kind: "exit" },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(70);
  });

  it("cleanup 失败时返回稳定 invalid，不保留主进程 pass", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    };
    child.kill = () => true;
    child.pid = 4322;
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();

    const result = await runProcessWithDeadline({
      args: [],
      cleanupProcessTree: async () => {
        throw new Error("cleanup failed");
      },
      cwd: process.cwd(),
      executable: process.execPath,
      killGraceMs: 50,
      outputLimitBytes: 1024,
      spawnProcess: (() => {
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      }) as never,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "EPROCESSCLEANUP" },
    });
  });

  it("主进程 exit 后即使 cleanup resolve，缺失 close 也在独立预算内收敛", async () => {
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean;
      pid: number;
      stderr: PassThrough;
      stdout: PassThrough;
    };
    child.kill = () => true;
    child.pid = 4323;
    child.stderr = new PassThrough();
    child.stdout = new PassThrough();
    const startedAt = Date.now();

    const result = await runProcessWithDeadline({
      args: [],
      cleanupProcessTree: async () => undefined,
      cwd: process.cwd(),
      executable: process.execPath,
      killGraceMs: 40,
      outputLimitBytes: 1024,
      spawnProcess: (() => {
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as never,
      timeoutMs: 500,
    });

    expect(result).toMatchObject({
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "EPIPEOPEN" },
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it(
    "VALIDATION16 在并行短 Git 正常退出后释放 helper 与临时仓库",
    async () => {
      if (process.platform !== "win32") {
        expect(process.platform).not.toBe("win32");
        return;
      }
      const roots = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const root = await mkdtemp(path.join(tmpdir(), "process-deadline-git-"));
          temporaryRoots.push(root);
          await execFileAsync("git", ["-C", root, "init", "-q"], {
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: "NUL",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_TERMINAL_PROMPT: "0",
            },
          });
          return root;
        }),
      );

      const results = await Promise.all(
        roots.map((root) => runProcessWithDeadline({
          args: ["-C", root, "rev-parse", "--show-object-format"],
          cleanupProcessTreeOnExit: false,
          cwd: root,
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "NUL",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          executable: "git",
          timeoutMs: 30_000,
        })),
      );

      expect(results.map(({ status }) => status)).toEqual(Array(8).fill("pass"));
      await Promise.all(
        roots.map((root) => rm(root, {
          force: true,
          maxRetries: 5,
          recursive: true,
          retryDelay: 100,
        })),
      );
      for (const root of roots) {
        const index = temporaryRoots.indexOf(root);
        if (index >= 0) {temporaryRoots.splice(index, 1);}
      }
    },
    PROCESS_LIFECYCLE_BUDGET.gitTestTimeoutMs,
  );

  it(
    "Windows ready-handshaked 三类进程树逐轮覆盖正常退出、孤儿后代与 timeout 收敛",
    async () => {
      if (process.platform !== "win32") {
        expect(process.platform).not.toBe("win32");
        return;
      }
      for (let round = 1; round <= processDeadlineStressRounds; round += 1) {
        await Promise.all([
          runReadyWindowsScenario("timeout", round),
          runReadyWindowsScenario("normal-exit-background", round),
          runReadyWindowsScenario("orphan-grandchild", round),
        ]);
      }
    },
    PROCESS_LIFECYCLE_BUDGET.windowsMatrixTimeoutMs,
  );

  it("Windows Job bootstrap 缺失 ready proof 时 fail closed", async () => {
    if (process.platform !== "win32") {
      expect(process.platform).not.toBe("win32");
      return;
    }
    const result = await runProcessWithDeadline({
      args: [],
      cwd: process.cwd(),
      executable: path.join(tmpdir(), "missing-codegraph-bootstrap.exe"),
      killGraceMs: processCleanupGraceMs,
      outputLimitBytes: 1024,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "EPROCESSBOOTSTRAP" },
    });
  });

  it("Windows Job 缺失 descendant attestation 时不发布伪终态", async () => {
    if (process.platform !== "win32") {
      expect(process.platform).not.toBe("win32");
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "process-cleanup-fail-"));
    temporaryRoots.push(root);
    const result = await runProcessWithDeadline({
      args: ["-e", "process.exit(0)"],
      cwd: root,
      executable: process.execPath,
      killGraceMs: processCleanupGraceMs,
      outputLimitBytes: 1024,
      timeoutMs: 1_000,
      windowsDescendantReadyPath: path.join(root, "missing-descendant.pid"),
    });

    expect(result).toMatchObject({
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "EPROCESSCLEANUP" },
    });
    expect(result.windowsJob).toBeUndefined();
  });
});
