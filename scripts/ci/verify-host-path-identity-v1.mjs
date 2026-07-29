import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gateId = "host-path-identity-win32-v1";
const sourcePath = "apps/graph-service/src/host-path-identity.ts";
const unitTestPath = "tests/unit/host-path-identity.test.ts";
const contractTestPath = "tests/contract/host-path-identity-win32.test.ts";
const manifestTestPath = "tests/contract/quality-gates-manifest.test.ts";
const verifierPath = "scripts/ci/verify-host-path-identity-v1.mjs";
const triggerPaths = [
  sourcePath,
  "ci/quality-gates.v1.yaml",
  verifierPath,
  contractTestPath,
  manifestTestPath,
  unitTestPath,
];
const forbiddenMemberNames = new Set([
  "birthtime",
  "birthtimeMs",
  "birthtimeNs",
  "caseFold",
  "casefold",
  "localeCompare",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toUpperCase",
  "unicodeCaseFold",
]);
const forbiddenUnicodeLiterals = new Set(["ẞ", "ß", "İ", "ı"]);

/**
 * 独立校验 Win32 host identity 平台合同，并运行固定的黑盒 unit/contract 回归集。
 *
 * AST 检查只作为禁止第二套字符串算法与 helper 绕过的辅助防线；能力证明来自真实 API
 * 负向/变异测试与 NTFS 合同，不依赖注释、死代码或 source 字符串标记。
 */
export async function verifyHostPathIdentityV1() {
  const source = await readRepositoryFile(sourcePath);
  validateHostPathIdentitySource(source, sourcePath);
  await validateGateRegistration();

  const unitStatus = runVitest("vitest.config.ts", [unitTestPath]);
  if (unitStatus !== 0) {
    return unitStatus;
  }
  return runVitest("vitest.contract.config.ts", [contractTestPath, manifestTestPath]);
}

/**
 * 用 TypeScript AST 拒绝字符串 case-fold、birthtime fallback、计算属性与 helper import。
 *
 * @param {string} source 待检查的 TypeScript 模块源码。
 * @param {string} modulePath 用于稳定诊断的仓库相对路径。
 */
export function validateHostPathIdentitySource(source, modulePath = sourcePath) {
  const sourceFile = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];

  /** 遍历全部 AST，包括不可达分支，避免死代码承载第二套 identity 算法。 */
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith("node:")) {
        violations.push(`禁止从 '${specifier}' 导入可隐藏 identity 算法的 helper。`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = evaluateStaticString(node.arguments[0]);
      if (specifier === undefined || !specifier.startsWith("node:")) {
        violations.push("禁止 dynamic import 隐藏 identity helper。");
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      violations.push("禁止 require 隐藏 identity helper。");
    }
    if (ts.isIdentifier(node) && forbiddenMemberNames.has(node.text)) {
      violations.push(`禁止标识符 '${node.text}'。`);
    }
    if (ts.isStringLiteralLike(node)) {
      if (forbiddenMemberNames.has(node.text)) {
        violations.push(`禁止字符串成员 '${node.text}'。`);
      }
      for (const forbidden of forbiddenUnicodeLiterals) {
        if (node.text.indexOf(forbidden) >= 0) {
          violations.push(`禁止硬编码 Unicode 例外 '${forbidden}'。`);
        }
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const propertyName = evaluateStaticString(node.argumentExpression);
      if (propertyName !== undefined && forbiddenMemberNames.has(propertyName)) {
        violations.push(`禁止计算属性 '${propertyName}'。`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (violations.length > 0) {
    throw new Error(
      `${modulePath}: host identity AST 合同失败。Fix: 仅使用 root-bound opened-handle identity。\n${[
        ...new Set(violations),
      ].join("\n")}`,
    );
  }
}

/**
 * 对字符串字面量、无替换模板和 `+` 连接求静态值，覆盖计算属性绕过。
 *
 * @param {import("typescript").Expression | undefined} expression AST 表达式。
 * @returns {string | undefined} 可静态证明时的字符串值。
 */
function evaluateStaticString(expression) {
  if (expression === undefined) {
    return undefined;
  }
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateStaticString(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateStaticString(expression.left);
    const right = evaluateStaticString(expression.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  return undefined;
}

/** Gate 必须阻断、固定执行本 verifier，并覆盖全部六条平台 owned path。 */
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
      `ci/quality-gates.v1.yaml: ${gateId} 定义漂移。Fix: 恢复 blocking、固定 argv 与六条 owned triggerPaths。`,
    );
  }
}

/** 从仓库固定相对路径读取 UTF-8 文本，不接受调用参数缩小检查范围。 */
async function readRepositoryFile(relativePath) {
  return readFile(path.join(repositoryRoot, ...relativePath.split("/")), "utf8");
}

/** 使用固定配置与路径运行不可由 Gate 参数缩小的 Vitest 黑盒测试。 */
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
