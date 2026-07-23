import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProcessWithDeadline } from "../../scripts/ci/run-process-with-deadline.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("process deadline", () => {
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
      killGraceMs: 50,
      outputLimitBytes: 1024,
      timeoutMs: 2_000,
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
      killGraceMs: 50,
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
