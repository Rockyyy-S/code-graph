import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runProcessWithDeadline } from "../../scripts/ci/run-process-with-deadline.mjs";

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);
/** Windows taskkill 在并行测试的高进程负载下需要独立且有界的 10 秒清理预算。 */
const processCleanupGraceMs = process.platform === "win32" ? 10_000 : 50;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      // Windows 刚终止进程树时句柄释放存在短暂延迟，使用 fs.rm 的有界 EBUSY 重试。
      rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
    ),
  );
});

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
    45_000,
  );

  it("正常退出后仍清理继承进程组的后台后代", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "process-tree-success-"));
    temporaryRoots.push(root);
    const marker = path.join(root, "descendant-survived.txt");
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 500); setInterval(() => {}, 1_000);`;
    const parent = `const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); child.unref();`;

    const result = await runProcessWithDeadline({
      args: ["-e", parent],
      cwd: root,
      executable: process.execPath,
      killGraceMs: processCleanupGraceMs,
      outputLimitBytes: 1024,
      timeoutMs: 8_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(result).toMatchObject({
      status: "pass",
      termination: { code: 0, kind: "exit" },
    });
    await expect(access(marker)).rejects.toBeDefined();
  }, 25_000);

  it(
    "CR8-004 kills an orphaned detached grandchild after its intermediate parent exits",
    async () => {
      if (process.platform !== "win32") {
        expect(process.platform).not.toBe("win32");
        return;
      }
      const root = await mkdtemp(path.join(tmpdir(), "process-tree-orphaned-grandchild-"));
      temporaryRoots.push(root);
      const marker = path.join(root, "grandchild-survived.txt");
      const pidFile = path.join(root, "grandchild.pid");
      const grandchild = [
        `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 750);`,
        "setInterval(() => {}, 1_000);",
      ].join("");
      const intermediate = [
        "const { spawn } = require(\"node:child_process\");",
        "const { writeFileSync } = require(\"node:fs\");",
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], ` +
          "{ detached: true, stdio: \"ignore\" });",
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "child.unref();",
      ].join("");
      const parent = [
        "const { spawn } = require(\"node:child_process\");",
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(intermediate)}], ` +
          "{ stdio: \"ignore\" });",
        "child.once(\"exit\", () => process.exit(0));",
      ].join("");
      let grandchildPid: number | undefined;

      try {
        const result = await runProcessWithDeadline({
          args: ["-e", parent],
          cwd: root,
          executable: process.execPath,
          killGraceMs: processCleanupGraceMs,
          outputLimitBytes: 1024,
          timeoutMs: 8_000,
        });
        grandchildPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
        await new Promise((resolve) => setTimeout(resolve, 900));

        expect(result).toMatchObject({
          status: "pass",
          termination: { code: 0, kind: "exit" },
        });
        expect(() => process.kill(grandchildPid!, 0)).toThrow();
        await expect(access(marker)).rejects.toBeDefined();
      } finally {
        if (grandchildPid !== undefined) {
          try {process.kill(grandchildPid, "SIGKILL");} catch {
            /** 测试清理只兜底终止本用例创建且尚未被生产逻辑回收的进程。 */
          }
        }
      }
    },
    25_000,
  );

  it("终止挂起进程及其继承进程组的后代", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "process-tree-deadline-"));
    temporaryRoots.push(root);
    const marker = path.join(root, "descendant-survived.txt");
    const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 500); setInterval(() => {}, 1_000);`;
    const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1_000);`;

    const result = await runProcessWithDeadline({
      args: ["-e", parent],
      cwd: root,
      executable: process.execPath,
      killGraceMs: processCleanupGraceMs,
      outputLimitBytes: 1024,
      timeoutMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(result).toMatchObject({
      status: "invalid",
      termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
    });
    await expect(access(marker)).rejects.toBeDefined();
  }, 25_000);
});
