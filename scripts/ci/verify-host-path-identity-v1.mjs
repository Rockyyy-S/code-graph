import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gateId = "host-path-identity-win32-v1";
const sourcePath = "apps/graph-service/src/host-path-identity.ts";
const unitTestPath = "tests/unit/host-path-identity.test.ts";
const contractTestPath = "tests/contract/host-path-identity-win32.test.ts";
const verifierPath = "scripts/ci/verify-host-path-identity-v1.mjs";
const triggerPaths = [
  sourcePath,
  "ci/quality-gates.v1.yaml",
  verifierPath,
  contractTestPath,
  unitTestPath,
];

const forbiddenSourcePatterns = [
  { label: "JavaScript lowercase", pattern: /\.toLowerCase\s*\(/u },
  { label: "JavaScript uppercase", pattern: /\.toUpperCase\s*\(/u },
  { label: "locale lowercase", pattern: /\.toLocaleLowerCase\s*\(/u },
  { label: "locale uppercase", pattern: /\.toLocaleUpperCase\s*\(/u },
  { label: "locale comparison", pattern: /\.localeCompare\s*\(/u },
  { label: "Unicode case-fold helper", pattern: /case[-_ ]?fold/iu },
  { label: "Unicode exception table", pattern: /unicode.{0,24}exception|exception.{0,24}unicode/iu },
  { label: "hard-coded sharp-s exception", pattern: /[ẞß]/u },
  { label: "hard-coded dotted-i exception", pattern: /[İı]/u },
];

/**
 * 独立校验 Win32 host identity 平台合同，并运行固定的 unit/contract 回归集。
 *
 * 静态检查只扫描生产实现，测试中的 lowercase 调用用于证明冲突样本，不能被实现复用。
 */
export async function verifyHostPathIdentityV1() {
  const source = await readRepositoryFile(sourcePath);
  validateSourceContract(source);
  await validateGateRegistration();

  const unitStatus = runVitest("vitest.config.ts", [unitTestPath]);
  if (unitStatus !== 0) {
    return unitStatus;
  }
  return runVitest("vitest.contract.config.ts", [contractTestPath]);
}

/** 生产代码必须形成真实宿主观察闭环，并且不得出现任何 case-fold 替代。 */
function validateSourceContract(source) {
  for (const forbidden of forbiddenSourcePatterns) {
    if (forbidden.pattern.test(source)) {
      throw new Error(
        `${sourcePath}: 禁止 ${forbidden.label} 作为文件身份。Fix: 仅使用 open/lstat/realpath 与 opaque 宿主身份。`,
      );
    }
  }
  for (const required of [
    "nativeOpen",
    "nativeLstat",
    "nativeRealpath",
    "dev",
    "ino",
    "birthtimeNs",
    "HostPathIdentityBroker",
    "resolveCandidates",
    "HOST_PATH_CHANGED",
    'status: "missing" | "unreadable" | "changed"',
  ]) {
    if (!source.includes(required)) {
      throw new Error(
        `${sourcePath}: 缺少平台合同标记 '${required}'。Fix: 恢复宿主身份、候选证明或 fail-closed 状态。`,
      );
    }
  }
}

/** Gate 必须阻断、固定执行本 verifier，并覆盖全部平台 owned paths。 */
async function validateGateRegistration() {
  const loaded = await loadQualityGateRegistry(repositoryRoot);
  const matching = loaded.registry.gates.filter(
    ({ gateDefinition }) => gateDefinition.gateId === gateId,
  );
  if (matching.length !== 1) {
    throw new Error(`ci/quality-gates.v1.yaml: 必须唯一登记 ${gateId}。`);
  }
  const definition = matching[0].gateDefinition;
  if (
    definition.blocking !== true ||
    definition.checkId !== gateId ||
    definition.capabilityOwner !== "qa" ||
    JSON.stringify(definition.command) !== JSON.stringify(["node", verifierPath]) ||
    JSON.stringify(definition.triggerPaths) !== JSON.stringify(triggerPaths)
  ) {
    throw new Error(
      `ci/quality-gates.v1.yaml: ${gateId} 定义漂移。Fix: 恢复 blocking、固定 argv 与排序后的 owned triggerPaths。`,
    );
  }
}

/** 从仓库固定相对路径读取 UTF-8 文本，不接受调用参数缩小检查范围。 */
async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8");
}

/** 使用固定配置与路径运行不可由 Gate 参数缩小的 Vitest 测试。 */
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
    console.error("Win32 host identity 回归集无法启动。Fix: 检查 pnpm 与测试运行环境。");
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyHostPathIdentityV1()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Win32 host identity verifier 未知错误。");
      process.exitCode = 1;
    });
}
