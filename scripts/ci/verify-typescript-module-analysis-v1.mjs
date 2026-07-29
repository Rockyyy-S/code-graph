import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Story verifier 的固定清单由 contract 回归锁定，禁止静默缩小。 */
export const TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST = Object.freeze({
  /** clean checkout 不含 dist，必须按 project reference 拓扑先构建所有被依赖包。 */
  buildFilters: Object.freeze([
    "@codegraph/domain",
    "@codegraph/contracts",
    "@codegraph/application",
    "@codegraph/service-client",
    "@codegraph/adapter-analyzer-typescript",
    "@codegraph/adapter-git-local",
    "@codegraph/adapter-store-sqlite",
    "@codegraph/graph-service",
  ]),
  contractTests: Object.freeze([
    "tests/contract/graph-service-process.test.ts",
  ]),
  unitTests: Object.freeze([
    "tests/unit/analyzer-config-capture.test.ts",
    "tests/unit/analyzer-config-snapshot.test.ts",
    "tests/unit/composite-graph-patch.test.ts",
    "tests/unit/index-job-runtime.test.ts",
    "tests/unit/index-read-set.test.ts",
    "tests/unit/module-dependency-domain.test.ts",
    "tests/unit/module-fact-batch.test.ts",
    "tests/unit/sqlite-graph-store.test.ts",
    "tests/unit/sqlite-module-dependencies.test.ts",
    "tests/unit/typescript-analyzer-worker.test.ts",
    "tests/unit/typescript-module-resolution.test.ts",
    "tests/unit/typescript-module-syntax.test.ts",
  ]),
  version: 1,
});

/**
 * 构建真实 Worker 产物并运行 Story 1.5 不可缩小的模块分析回归集。
 */
export function verifyTypeScriptModuleAnalysis() {
  for (const filter of TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.buildFilters) {
    const status = runPnpm(["--filter", filter, "build"]);
    if (status !== 0) {return status;}
  }
  const unitStatus = runPnpm([
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    ...TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.unitTests,
  ]);
  if (unitStatus !== 0) {return unitStatus;}
  return runPnpm([
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.contract.config.ts",
    ...TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST.contractTests,
  ]);
}

/** 使用冻结 pnpm 入口运行单个固定 argv。 */
function runPnpm(args) {
  const invocation = createPnpmInvocation(process.env.npm_execpath, args);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
  });
  if (result.error !== undefined) {
    console.error("TypeScript 模块分析 Gate 无法启动。Fix: 检查 pnpm 与测试运行环境。");
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = verifyTypeScriptModuleAnalysis();
}
