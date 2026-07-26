import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const testPaths = [
  "tests/unit/deterministic-graph-patch.test.ts",
  "tests/unit/index-read-set.test.ts",
  "tests/unit/workspace-scanner.test.ts",
  "tests/unit/sqlite-graph-store.test.ts",
  "tests/unit/index-job-runtime.test.ts",
  "tests/unit/index-job-state.test.ts",
  "tests/unit/service-state.test.ts",
];
const processTestPaths = ["tests/contract/graph-service-process.test.ts"];

/**
 * 运行 Story 1.19 的原子提交与确定性 rebuild 专属回归集。
 *
 * 测试路径固定在受版本控制的脚本中，避免 Gate 清单通过动态参数缩小验证范围。
 */
export function verifyDeterministicRebuild() {
  const unitStatus = runVitest("vitest.config.ts", testPaths);
  if (unitStatus !== 0) {
    return unitStatus;
  }
  // 真实 IPC 进程测试依赖 build 产物，并单独使用 contract 配置避免扩大到无关合同集。
  return runVitest("vitest.contract.config.ts", processTestPaths);
}

/** 使用固定配置与路径运行一组不可由 Gate 参数缩小的 Vitest 测试。 */
function runVitest(configPath, paths) {
  const invocation = createPnpmInvocation(process.env.npm_execpath, [
    "exec",
    "vitest",
    "run",
    "--config",
    configPath,
    ...paths,
  ]);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
  if (result.error !== undefined) {
    console.error("确定性 rebuild 回归集无法启动。Fix: 检查 pnpm 与测试运行环境。");
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = verifyDeterministicRebuild();
}
