import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const allowedProductionImports = new Set([
  "node:child_process",
  "node:crypto",
  "node:fs/promises",
  "node:os",
  "node:path",
]);
const expectedProductionSourceDigest = "50dada1a79599a8f38d2ec099a6fd7934c0199d4454e3dfe37e47d988825e452";
const expectedWindowsSnapshotScriptDigest = "67cea8cc0483baca6f2f226850a8c0b6b7cf0d2dac28047dbfe2fd13d226c863";
const requiredProductionCalls = new Map([
  ["HostPathIdentityBroker.resolveCandidates", [
    "prepareCandidates",
    "createCaptureNonce",
    "capture",
    "validateCompleteCapture",
    "createCapturedIdentityContext",
    "createPresentObservation",
    "buildAliasGroups",
    "createProof",
  ]],
  ["nativeSnapshotProvider.capture", [
    "createSnapshotFailure",
    "captureWindowsHandleSnapshot",
  ]],
  ["prepareCandidates", ["validateAbsoluteHostPath", "createTrustedPath"]],
  ["captureWindowsHandleSnapshot", [
    "mkdtemp",
    "writeFile",
    "runBoundedProcess",
    "parse",
    "isSnapshotCapture",
    "classifyNativeFailure",
    "rm",
  ]],
  ["createCapturedIdentityContext", ["digestJson"]],
  ["createPresentObservation", ["digestJson"]],
]);

/** 独立校验完整生产闭包与固定原生脚本，执行 mutation oracle 后运行黑盒回归。 */
export async function verifyHostPathIdentityV1() {
  const source = await readRepositoryFile(sourcePath);
  validateHostPathIdentitySource(source, sourcePath);
  validateMutationOracle(source);
  await validateGateRegistration();

  const unitStatus = runVitest("vitest.config.ts", [unitTestPath]);
  if (unitStatus !== 0) {
    return unitStatus;
  }
  return runVitest("vitest.contract.config.ts", [contractTestPath, manifestTestPath]);
}

/**
 * 正向封闭完整生产源码、依赖边与关键调用图，不依赖有限语法或字符串黑名单。
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
  const imports = new Set();
  const observedProductionCalls = new Map();
  let windowsSnapshotScript;

  /** 记录指定函数或方法体内实际存在的直接与回调调用目标。 */
  function recordCalls(callableName, body) {
    const calls = new Set();

    /** 收集调用表达式的静态目标名称。 */
    function collect(node) {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          calls.add(node.expression.text);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          calls.add(node.expression.name.text);
        }
      }
      ts.forEachChild(node, collect);
    }

    collect(body);
    observedProductionCalls.set(callableName, calls);
  }

  /** 遍历完整 AST，建立封闭依赖集合和生产调用图证据。 */
  function visit(node) {
    if (ts.isImportEqualsDeclaration(node)) {
      violations.push("生产依赖闭包只允许五条固定静态 import。");
    }
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        violations.push("生产 import 必须使用静态字符串 specifier。");
      } else {
        const specifier = node.moduleSpecifier.text;
        imports.add(specifier);
        if (!allowedProductionImports.has(specifier)) {
          violations.push(`生产依赖闭包不允许 '${specifier}'。`);
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      violations.push("生产依赖闭包不允许 export-from 边。");
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      violations.push("生产依赖闭包不允许 dynamic import 边。");
    }
    if (
      ts.isClassDeclaration(node) &&
      node.name?.text === "HostPathIdentityBroker"
    ) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "resolveCandidates" &&
          member.body !== undefined
        ) {
          recordCalls("HostPathIdentityBroker.resolveCandidates", member.body);
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined &&
      requiredProductionCalls.has(node.name.text)
    ) {
      recordCalls(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "nativeSnapshotProvider" &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const captureProperty = node.initializer.properties.find((property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "capture"
      );
      if (
        captureProperty !== undefined &&
        ts.isPropertyAssignment(captureProperty) &&
        (ts.isArrowFunction(captureProperty.initializer) ||
          ts.isFunctionExpression(captureProperty.initializer))
      ) {
        recordCalls("nativeSnapshotProvider.capture", captureProperty.initializer.body);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "WINDOWS_HOST_IDENTITY_SNAPSHOT_SCRIPT" &&
      node.initializer !== undefined
    ) {
      const initializer = node.initializer;
      if (
        ts.isTaggedTemplateExpression(initializer) &&
        ts.isNoSubstitutionTemplateLiteral(initializer.template)
      ) {
        windowsSnapshotScript = initializer.template.rawText ?? initializer.template.text;
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const sourceDigest = createHash("sha256").update(source, "utf8").digest("hex");
  if (sourceDigest !== expectedProductionSourceDigest) {
    violations.push("生产模块完整源码摘要漂移，存在未审计的第二套身份语义。");
  }
  for (const required of allowedProductionImports) {
    if (!imports.has(required)) {
      violations.push(`生产依赖闭包缺少 '${required}'。`);
    }
  }
  if (imports.size !== allowedProductionImports.size) {
    violations.push("生产依赖闭包必须精确等于五个 Node 内建模块。");
  }
  for (const [callableName, requiredCalls] of requiredProductionCalls) {
    const calls = observedProductionCalls.get(callableName);
    if (calls === undefined) {
      violations.push(`生产调用图缺少 '${callableName}'。`);
      continue;
    }
    for (const requiredCall of requiredCalls) {
      if (!calls.has(requiredCall)) {
        violations.push(`生产调用图 '${callableName}' 缺少 '${requiredCall}'。`);
      }
    }
  }
  if (windowsSnapshotScript === undefined) {
    violations.push("生产模块缺少固定 Windows 原生句柄快照脚本。");
  } else {
    const digest = createHash("sha256").update(windowsSnapshotScript, "utf8").digest("hex");
    if (digest !== expectedWindowsSnapshotScriptDigest) {
      violations.push("Windows 原生句柄快照脚本摘要漂移。");
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `${modulePath}: host identity 正向合同失败。Fix: 保持完整源码闭包、root-derived mapping、FILE_ID_INFO 与句柄租约调用图。\n${[
        ...new Set(violations),
      ].join("\n")}`,
    );
  }
}

/** 固定变异集注入完整生产源码，必须全部破坏正向源码闭包而被拒绝。 */
function validateMutationOracle(source) {
  const mutations = [
    `const mutationMember=["to","LowerCase"].join(""); export const mutationValue="A"[mutationMember]();`,
    `import { createRequire as mutationCreateRequire } from "node:module"; mutationCreateRequire(import.meta.url)("./helper.cjs");`,
    `export const mutationReflect=Reflect.apply(String.prototype.toLowerCase,"A",[]);`,
    `import mutationHelper = require("./helper.cjs"); export { mutationHelper };`,
    `import mutationVm from "node:vm"; export const mutationVmValue=mutationVm.runInNewContext("identity()");`,
    `export const mutationEval=eval("identity()");`,
    `export const mutationFunction=Function("return identity()")();`,
    `import { identity as mutationIdentity } from "./helper.js"; export { mutationIdentity };`,
    `export const mutationBirthtime=(value)=>value.birthtimeNs;`,
  ];
  for (const [index, mutation] of mutations.entries()) {
    let rejected = false;
    try {
      validateHostPathIdentitySource(`${source}\n${mutation}\n`, `mutation-oracle-${index}.ts`);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`mutation-oracle-${index}: verifier 未拒绝固定绕过样本。`);
    }
  }
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

/** 从仓库固定相对路径读取 UTF-8 文本。 */
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
