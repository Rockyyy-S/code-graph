import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runProcessWithDeadline } from "../../scripts/ci/run-process-with-deadline.mjs";

const temporaryRoots: string[] = [];
const processCleanupGraceMs = process.platform === "win32" ? 2_000 : 50;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("process deadline", () => {
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
  });

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
  });
});
