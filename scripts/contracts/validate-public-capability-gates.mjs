import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { parse } from "yaml";
import { sha256CanonicalJson } from "../../packages/contracts/runtime/canonical-json.mjs";

const execFileAsync = promisify(execFile);
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const capabilityBindingsPath = "ci/public-capability-gates.v1.json";
const gateRegistryPath = "ci/quality-gates.v1.yaml";
const cliManifestPath = "apps/cli/package.json";
const cliDispatchPath = "apps/cli/src/public-command-dispatch.ts";
const cliRegistryPath = "apps/cli/src/public-command-registry.ts";
const extensionManifestPath = "apps/extension/package.json";
const contractsIndexPath = "packages/contracts/src/index.ts";
const rpcContractPath = "packages/contracts/src/service-control.ts";
const verificationRuntimePath = "scripts/contracts/run-public-capability-verification.mjs";

/**
 * 对固定 provider base/head 比较公共 CLI、RPC、extension 与 Schema 表面。
 *
 * 新增能力或既有公共 Schema 的语义结构变化，必须通过显式映射绑定到同一变更新增的
 * blocking gate。基线尚未建立 registry/mapping 时按空集合 bootstrap，避免首次迁移自锁。
 */
export async function validatePublicCapabilityGateDiff(repositoryRoot, baseOid, headOid) {
  if (!oidPattern.test(baseOid ?? "") || !oidPattern.test(headOid ?? "")) {
    throw new Error("公共能力门禁比较必须绑定完整 base/head Git OID。");
  }
  const [baseFiles, headFiles] = await Promise.all([
    readSurfaceSnapshot(repositoryRoot, baseOid),
    readSurfaceSnapshot(repositoryRoot, headOid),
  ]);
  return evaluatePublicCapabilityGateDiff({
    baseBindings: parsePublicCapabilityGateBindings(
      baseFiles.get(capabilityBindingsPath),
      { allowMissing: true },
    ),
    baseFiles,
    baseGateIds: collectGateIds(baseFiles.get(gateRegistryPath), true),
    baseSurface: collectPublicCapabilitySurface(baseFiles, { allowBootstrap: true }),
    headBindings: parsePublicCapabilityGateBindings(headFiles.get(capabilityBindingsPath), {
      allowMissing: true,
    }),
    headFiles,
    headRegistry: parseRegistry(headFiles.get(gateRegistryPath), false),
    headSurface: collectPublicCapabilitySurface(headFiles),
  });
}

/** 对已提取快照执行无副作用的 AC4 差异判定。 */
export function evaluatePublicCapabilityGateDiff({
  baseBindings,
  baseFiles = new Map(),
  baseGateIds,
  baseSurface,
  headBindings,
  headFiles = new Map(),
  headRegistry,
  headSurface,
}) {
  const normalizedBaseSurface = normalizeCapabilitySurface(baseSurface);
  const normalizedHeadSurface = normalizeCapabilitySurface(headSurface);
  const headGateById = new Map(
    headRegistry.gates.map(({ gateDefinition }) => [gateDefinition.gateId, gateDefinition]),
  );
  const addedGateById = new Map(
    [...headGateById].filter(([gateId]) => !baseGateIds.has(gateId)),
  );
  const baseBindingByCapability = new Map(
    baseBindings.bindings.map((binding) => [binding.capabilityId, binding]),
  );
  const headBindingByCapability = new Map(
    headBindings.bindings.map((binding) => [binding.capabilityId, binding]),
  );
  const violations = [];

  for (const binding of headBindings.bindings) {
    const { capabilityId, gateId } = binding;
    const definition = headGateById.get(gateId);
    const status = binding.status ?? "active";
    const surfaceExists = normalizedHeadSurface.has(capabilityId);
    const validSurfaceReference = status === "removed"
      ? !surfaceExists && normalizedBaseSurface.has(capabilityId)
      : surfaceExists;
    if (!validSurfaceReference || definition === undefined) {
      violations.push(
        publicCapabilityViolation(
          `公共能力映射 '${capabilityId}' → '${gateId}' 引用了候选表面、基线退役对象或 Gate Registry 中不存在的对象。`,
          "修正 active/removed 状态，或恢复对应公共能力与真实 GateDefinitionV1",
        ),
      );
    } else if (definition.blocking !== true) {
      violations.push(
        publicCapabilityViolation(
          `公共能力映射 '${capabilityId}' → '${gateId}' 指向 non-blocking gate。`,
          "把能力映射到真实 blocking gate，并保留诊断性 non-blocking gate 的独立用途",
        ),
      );
    }
  }

  for (const capabilityId of normalizedHeadSurface.keys()) {
    const binding = headBindingByCapability.get(capabilityId);
    if (binding !== undefined && binding.status !== "removed") {
      continue;
    }
    violations.push(
      publicCapabilityViolation(
        `候选 bindings 未完整覆盖公共能力 '${capabilityId}'，或把仍存在的能力错误标记为 removed。`,
        `在 ${capabilityBindingsPath} 保留 '${capabilityId}' 的 active binding，禁止静默删除治理映射`,
      ),
    );
  }

  for (const capabilityId of normalizedBaseSurface.keys()) {
    if (normalizedHeadSurface.has(capabilityId)) {
      continue;
    }
    const binding = headBindingByCapability.get(capabilityId);
    if (binding?.status === "removed") {
      continue;
    }
    violations.push(
      publicCapabilityViolation(
        `基线公共能力 '${capabilityId}' 已从候选表面消失，但没有保留显式 removed binding。`,
        `在 ${capabilityBindingsPath} 为 '${capabilityId}' 声明 removed binding，并绑定新增迁移 gate 与专属验证证据`,
      ),
    );
  }

  const changedCapabilities = new Set();
  for (const capabilityId of new Set([
    ...normalizedBaseSurface.keys(),
    ...normalizedHeadSurface.keys(),
  ])) {
    if (normalizedBaseSurface.get(capabilityId) !== normalizedHeadSurface.get(capabilityId)) {
      changedCapabilities.add(capabilityId);
    }
  }
  for (const [capabilityId, baseBinding] of baseBindingByCapability) {
    const headBinding = headBindingByCapability.get(capabilityId);
    if (headBinding !== undefined && !sameBindingContract(baseBinding, headBinding)) {
      changedCapabilities.add(capabilityId);
    }
  }

  const changedGateUseCount = new Map();
  for (const capabilityId of changedCapabilities) {
    const binding = headBindingByCapability.get(capabilityId);
    if (binding !== undefined) {
      changedGateUseCount.set(
        binding.gateId,
        (changedGateUseCount.get(binding.gateId) ?? 0) + 1,
      );
    }
  }
  for (const capabilityId of [...changedCapabilities].sort()) {
    const binding = headBindingByCapability.get(capabilityId);
    if (binding === undefined) {
      continue;
    }
    const strictViolation = validateStrictCapabilityVerification({
      addedGateById,
      baseFiles,
      binding,
      capabilityId,
      changedGateUseCount,
      headFiles,
      headRegistry,
    });
    if (strictViolation !== null) {
      violations.push(strictViolation);
    }
  }

  return violations;
}

/** 从已读取文件提取公共能力 ID 及其稳定语义指纹。 */
export function collectPublicCapabilitySurface(files, options = {}) {
  const capabilities = new Map();
  const workspace = createTypeScriptWorkspace(files);
  collectCliCapabilities(files, workspace, capabilities, options);
  collectExtensionCapabilities(files, workspace, capabilities, options);
  collectRpcCapabilities(workspace, capabilities, options);
  collectExportedSchemaCapabilities(workspace, capabilities, options);
  return capabilities;
}

/** 解析 capability→gate 显式映射的封闭 V1 合同。 */
export function parsePublicCapabilityGateBindings(source, options = {}) {
  if (source === undefined) {
    if (options.allowMissing === true) {
      return { bindings: [], schemaVersion: 1 };
    }
    throw new Error(`${capabilityBindingsPath} 缺失。`);
  }
  const value = JSON.parse(source);
  assertClosedObject(value, ["bindings", "schemaVersion"], capabilityBindingsPath);
  if (value.schemaVersion !== 1 || !Array.isArray(value.bindings)) {
    throw new Error(`${capabilityBindingsPath} 必须是 schemaVersion=1 且包含 bindings 数组。`);
  }
  let previousCapabilityId = "";
  const seenCapabilityIds = new Set();
  const seenEvidenceIds = new Set();
  const seenVerificationPaths = new Set();
  for (const binding of value.bindings) {
    const bindingKeys = ["capabilityId", "gateId"];
    if (Object.hasOwn(binding, "status")) {
      bindingKeys.push("status");
    }
    if (Object.hasOwn(binding, "verification")) {
      bindingKeys.push("verification");
    }
    assertClosedObject(binding, bindingKeys, capabilityBindingsPath);
    if (
      typeof binding.capabilityId !== "string" ||
      binding.capabilityId.length === 0 ||
      typeof binding.gateId !== "string" ||
      binding.gateId.length === 0
    ) {
      throw new Error(`${capabilityBindingsPath} 的 capabilityId/gateId 必须是非空字符串。`);
    }
    if (
      binding.capabilityId.localeCompare(previousCapabilityId) <= 0 ||
      seenCapabilityIds.has(binding.capabilityId)
    ) {
      throw new Error(`${capabilityBindingsPath} 的 bindings 必须按 capabilityId 严格升序且唯一。`);
    }
    previousCapabilityId = binding.capabilityId;
    seenCapabilityIds.add(binding.capabilityId);
    if (binding.status !== undefined && binding.status !== "active" && binding.status !== "removed") {
      throw new Error(`${capabilityBindingsPath} 的 status 只允许 active|removed。`);
    }
    if (binding.verification !== undefined) {
      validateVerificationContract(
        binding.capabilityId,
        binding.verification,
        seenEvidenceIds,
        seenVerificationPaths,
      );
    }
  }
  return value;
}

/** 从已校验 binding 派生 repository preflight 唯一允许的能力验证命令。 */
export function collectPublicCapabilityVerificationCommands(source) {
  const bindings = parsePublicCapabilityGateBindings(source, { allowMissing: true });
  return new Set(
    bindings.bindings
      .filter((binding) => binding.verification !== undefined)
      .map((binding) => JSON.stringify(
        expectedVerificationCommand(binding.capabilityId, binding.verification),
      )),
  );
}

/**
 * 验证变化能力的 gate、测试、fixture、入口与 evidence 是否形成唯一且同 PR 更新的闭环。
 */
function validateStrictCapabilityVerification({
  addedGateById,
  baseFiles,
  binding,
  capabilityId,
  changedGateUseCount,
  headFiles,
  headRegistry,
}) {
  const verification = binding.verification;
  if (verification === undefined) {
    return publicCapabilityViolation(
      `变化能力 '${capabilityId}' 缺少能力专属测试、fixture、独立 gate 入口与 evidence 合同。`,
      `为 '${capabilityId}' 增加 verification 封闭对象，并绑定同一变更新增的唯一 blocking gate`,
    );
  }
  const definition = addedGateById.get(binding.gateId);
  if (definition?.blocking !== true) {
    return publicCapabilityViolation(
      `变化能力 '${capabilityId}' 未绑定同一变更新增的 blocking gate。`,
      `新增 '${binding.gateId}' 的 GateDefinitionV1，并由 architecture-required 产生独立 evidence`,
    );
  }
  if ((changedGateUseCount.get(binding.gateId) ?? 0) !== 1) {
    return publicCapabilityViolation(
      `变化能力 '${capabilityId}' 与其他能力共享 gate '${binding.gateId}'，无法证明能力专属覆盖。`,
      "为每个变化能力使用唯一新增 gate、命令、测试、fixture 与 evidenceId",
    );
  }
  const expectedCommand = expectedVerificationCommand(capabilityId, verification);
  if (!Array.isArray(definition.command) || !sameOrderedStrings(definition.command, expectedCommand)) {
    return publicCapabilityViolation(
      `变化能力 '${capabilityId}' 的 gate '${binding.gateId}' 未使用绑定专属资产的独立入口命令。`,
      `把 gate command 精确设置为 ${JSON.stringify(expectedCommand)}`,
    );
  }
  const commandKey = JSON.stringify(definition.command);
  const duplicateCommand = headRegistry.gates.some(
    ({ gateDefinition }) =>
      gateDefinition.gateId !== binding.gateId &&
      JSON.stringify(gateDefinition.command) === commandKey,
  );
  if (duplicateCommand) {
    return publicCapabilityViolation(
      `变化能力 '${capabilityId}' 的 gate 命令与无关 gate 重复，不能作为专属覆盖证据。`,
      "为该能力建立唯一 gate 入口和不可复用的验证命令",
    );
  }
  for (const relativePath of [
    verification.entryPath,
    verification.testPath,
    verification.fixturePath,
  ]) {
    const headSource = headFiles.get(relativePath);
    if (headSource === undefined || baseFiles.get(relativePath) === headSource) {
      return publicCapabilityViolation(
        `变化能力 '${capabilityId}' 的专属资产 '${relativePath}' 未在同一变更新增或更新。`,
        "随能力变更同步提交独立入口、真实测试和 fixture，并由新增 gate 执行",
      );
    }
  }
  const assetIssue = validateCapabilityVerificationAssets(
    capabilityId,
    verification,
    headFiles,
  );
  if (assetIssue !== null) {
    return publicCapabilityViolation(
      `变化能力 '${capabilityId}' 的专属入口、测试、fixture 或 evidence 合同无效：${assetIssue}`,
      "使用受控 verification runtime 消费全部封闭参数，执行含正向/负向断言的指定测试并读取非空 fixture",
    );
  }
  return null;
}

/** 生成能力专属 gate 的唯一 argv 合同。 */
function expectedVerificationCommand(capabilityId, verification) {
  return [
    "node",
    verification.entryPath,
    "--capability",
    capabilityId,
    "--test",
    verification.testPath,
    "--fixture",
    verification.fixturePath,
    "--evidence-id",
    verification.evidenceId,
  ];
}

/** 静态验证能力入口确实把封闭 argv 交给受控 runtime，并绑定真实测试与 fixture。 */
function validateCapabilityVerificationAssets(capabilityId, verification, files) {
  const entrySource = files.get(verification.entryPath);
  const testSource = files.get(verification.testPath);
  const fixtureSource = files.get(verification.fixturePath);
  const assertionTargetSource = files.get(verification.assertionTarget.modulePath);
  if (
    entrySource === undefined ||
    testSource === undefined ||
    fixtureSource === undefined ||
    assertionTargetSource === undefined
  ) {
    return "专属资产缺失";
  }
  const entryIssue = validateCapabilityVerificationEntry(
    entrySource,
    capabilityId,
    verification,
  );
  if (entryIssue !== null) {
    return entryIssue;
  }
  const testIssue = validateCapabilityVerificationTest(
    testSource,
    capabilityId,
    verification,
  );
  if (testIssue !== null) {
    return testIssue;
  }
  try {
    const fixture = JSON.parse(fixtureSource);
    const populated = Array.isArray(fixture)
      ? fixture.length > 0
      : typeof fixture === "object" && fixture !== null && Object.keys(fixture).length > 0;
    if (!populated) {
      return "fixture 必须是非空 JSON 对象或数组";
    }
  } catch {
    return "fixture 必须是可解析的非空 JSON";
  }
  return null;
}

/** verification entry 只允许一个固定 runtime 调用，禁止用死代码伪造参数字符串。 */
function validateCapabilityVerificationEntry(source, capabilityId, verification) {
  const sourceFile = ts.createSourceFile(
    verification.entryPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    return "entry 无法解析";
  }
  const expectedSpecifier = relativeModuleSpecifier(
    verification.entryPath,
    verificationRuntimePath,
  );
  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  const runtimeImport = imports.find(
    (statement) =>
      statement.moduleSpecifier.text === expectedSpecifier &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          element.name.text === "runPublicCapabilityVerification" &&
          (element.propertyName?.text ?? element.name.text) === "runPublicCapabilityVerification",
      ),
  );
  const executableStatements = sourceFile.statements.filter(
    (statement) => !ts.isImportDeclaration(statement),
  );
  if (runtimeImport === undefined || executableStatements.length !== 1) {
    return "entry 必须唯一导入并调用受控 verification runtime";
  }
  const statement = executableStatements[0];
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
    return "entry 必须在顶层 await 受控 verification runtime";
  }
  const call = unwrapExpression(statement.expression.expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "runPublicCapabilityVerification" ||
    call.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(call.arguments[0])
  ) {
    return "entry runtime 调用形状无效";
  }
  const properties = new Map();
  for (const property of call.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property)) {
      return "entry runtime 参数必须是显式封闭属性";
    }
    const name = propertyNameText(property.name);
    if (name === null || properties.has(name)) {
      return "entry runtime 参数包含动态或重复字段";
    }
    properties.set(name, unwrapExpression(property.initializer));
  }
  if (!sameOrderedStrings([...properties.keys()].sort(), [
    "argv",
    "capabilityId",
    "evidenceId",
    "fixturePath",
    "testPath",
  ])) {
    return "entry runtime 参数字段不封闭";
  }
  if (!isProcessArgvSlice(properties.get("argv"))) {
    return "entry 未消费完整 process.argv.slice(2)";
  }
  for (const [field, expected] of [
    ["capabilityId", capabilityId],
    ["evidenceId", verification.evidenceId],
    ["fixturePath", verification.fixturePath],
    ["testPath", verification.testPath],
  ]) {
    const expression = properties.get(field);
    if (!ts.isStringLiteral(expression) || expression.text !== expected) {
      return `entry 的 ${field} 未与 binding 精确闭合`;
    }
  }
  return null;
}

/** 测试必须在真实 Vitest case 中执行 challenge-bound runtime，并提供正向/负向回调。 */
function validateCapabilityVerificationTest(source, capabilityId, verification) {
  const sourceFile = ts.createSourceFile(
    verification.testPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    verification.testPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  if ((sourceFile.parseDiagnostics ?? []).length > 0) {
    return "test 无法解析";
  }
  const testFramework = collectTestFrameworkBindings(sourceFile);
  const assertionTargets = collectAssertionTargetBindings(
    sourceFile,
    verification.testPath,
    verification.assertionTarget,
  );
  if (assertionTargets.size !== 1) {
    return `test 必须从 assertionTarget 导入 '${verification.assertionTarget.exportName}'`;
  }
  const expectedSpecifier = relativeModuleSpecifier(
    verification.testPath,
    verificationRuntimePath,
  );
  const runtimeImport = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .find(
      (statement) =>
        statement.moduleSpecifier.text === expectedSpecifier &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (element) =>
            !element.isTypeOnly &&
            element.name.text === "runBoundPublicCapabilityTest" &&
            (element.propertyName?.text ?? element.name.text) ===
              "runBoundPublicCapabilityTest",
        ),
    );
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runBoundPublicCapabilityTest"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (runtimeImport === undefined || calls.length !== 1) {
    return "test 必须唯一导入并执行受控 challenge-bound runtime";
  }
  const call = calls[0];
  const testCallback = findEnclosingVitestCallback(call, testFramework.caseNames);
  if (
    !ts.isAwaitExpression(call.parent) ||
    testCallback === null ||
    !isReachableWithinFunction(call, testCallback) ||
    call.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(call.arguments[0])
  ) {
    return "test 必须在可达 Vitest case 中 await 受控 verification runtime";
  }
  const properties = new Map();
  for (const property of call.arguments[0].properties) {
    if (!ts.isPropertyAssignment(property)) {
      return "test runtime 参数必须是显式封闭属性";
    }
    const name = propertyNameText(property.name);
    if (name === null || properties.has(name)) {
      return "test runtime 参数包含动态或重复字段";
    }
    properties.set(name, unwrapExpression(property.initializer));
  }
  if (!sameOrderedStrings([...properties.keys()].sort(), [
    "capabilityId",
    "evidenceId",
    "fixturePath",
    "verifyNegative",
    "verifyPositive",
  ])) {
    return "test runtime 参数字段不封闭";
  }
  for (const [field, expected] of [
    ["capabilityId", verification.evidenceId.replace(/^public-capability:/u, "")],
    ["evidenceId", verification.evidenceId],
    ["fixturePath", verification.fixturePath],
  ]) {
    const expression = properties.get(field);
    if (!ts.isStringLiteral(expression) || expression.text !== expected) {
      return `test runtime 的 ${field} 未与 binding 精确闭合`;
    }
  }
  if (
    !validateVerificationCallback(
      properties.get("verifyPositive"),
      false,
      testFramework,
      assertionTargets,
    )
  ) {
    return "test 的 verifyPositive 必须对 runtime 提供的 capability/fixture 执行断言";
  }
  if (
    !validateVerificationCallback(
      properties.get("verifyNegative"),
      true,
      testFramework,
      assertionTargets,
    )
  ) {
    return "test 的 verifyNegative 必须对 runtime 提供的上下文执行负向断言";
  }
  return null;
}

/** assertionTarget 必须由测试以命名导入取得，禁止本地同名伪实现。 */
function collectAssertionTargetBindings(sourceFile, testPath, assertionTarget) {
  const expectedSpecifier = relativeRuntimeModuleSpecifier(
    testPath,
    assertionTarget.modulePath,
  );
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly === true ||
      statement.moduleSpecifier.text !== expectedSpecifier ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (
        !element.isTypeOnly &&
        (element.propertyName?.text ?? element.name.text) === assertionTarget.exportName
      ) {
        bindings.add(element.name.text);
      }
    }
  }
  return bindings;
}

/** 收集来自真实 Vitest 与 node:assert/strict 的本地绑定，拒绝同名伪实现。 */
function collectTestFrameworkBindings(sourceFile) {
  const framework = {
    assertFunctionNames: new Map(),
    assertObjectNames: new Set(),
    caseNames: new Set(),
    expectNames: new Set(),
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (importClause === undefined) {
      continue;
    }
    if (
      specifier === "vitest" &&
      importClause.namedBindings !== undefined &&
      ts.isNamedImports(importClause.namedBindings)
    ) {
      for (const element of importClause.namedBindings.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "expect") {
          framework.expectNames.add(element.name.text);
        } else if (["it", "test"].includes(importedName)) {
          framework.caseNames.add(element.name.text);
        }
      }
      continue;
    }
    if (!["node:assert", "node:assert/strict"].includes(specifier)) {
      continue;
    }
    if (importClause.name !== undefined) {
      framework.assertObjectNames.add(importClause.name.text);
    }
    if (
      importClause.namedBindings !== undefined &&
      ts.isNamespaceImport(importClause.namedBindings)
    ) {
      framework.assertObjectNames.add(importClause.namedBindings.name.text);
    } else if (
      importClause.namedBindings !== undefined &&
      ts.isNamedImports(importClause.namedBindings)
    ) {
      for (const element of importClause.namedBindings.elements) {
        if (!element.isTypeOnly) {
          framework.assertFunctionNames.set(
            element.name.text,
            element.propertyName?.text ?? element.name.text,
          );
        }
      }
    }
  }
  return framework;
}

/** 定位包裹 runtime 调用的最近真实 Vitest it/test 回调。 */
function findEnclosingVitestCallback(node, caseNames) {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const call = current.parent;
      return ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        caseNames.has(call.expression.text) &&
        call.arguments.includes(current)
        ? current
        : null;
    }
    current = current.parent;
  }
  return null;
}

/** 验证回调使用真实测试框架并对 runtime 上下文执行非恒真的断言。 */
function validateVerificationCallback(
  expression,
  requireNegative,
  framework,
  assertionTargets,
) {
  if (
    expression === undefined ||
    (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) ||
    expression.parameters.length !== 1 ||
    !ts.isBlock(expression.body)
  ) {
    return false;
  }
  const boundNames = collectBindingNames(expression.parameters[0].name);
  if (boundNames.size === 0) {
    return false;
  }
  let valid = false;
  const visit = (node) => {
    if (
      !valid &&
      ts.isCallExpression(node) &&
      isReachableWithinFunction(node, expression) &&
      isBoundAssertionCall(
        node,
        boundNames,
        framework,
        requireNegative,
        assertionTargets,
      )
    ) {
      valid = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression.body);
  return valid;
}

/** 收集参数标识符或对象/数组解构中的全部本地绑定名。 */
function collectBindingNames(name, result = new Set()) {
  if (ts.isIdentifier(name)) {
    result.add(name.text);
    return result;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, result);
    }
  }
  return result;
}

/** 判断节点是否消费给定任一本地绑定。 */
function nodeContainsAnyIdentifier(node, names) {
  let found = false;
  const visit = (child) => {
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** 识别与 runtime 上下文绑定的 Vitest/node:assert 断言，并拒绝自比较。 */
function isBoundAssertionCall(
  call,
  boundNames,
  framework,
  requireNegative,
  assertionTargets,
) {
  const vitest = analyzeVitestAssertion(call, framework.expectNames);
  if (vitest !== null) {
    const allowedMatchers = new Set([
      "toBe",
      "toBeDefined",
      "toBeGreaterThan",
      "toBeGreaterThanOrEqual",
      "toBeInstanceOf",
      "toBeLessThan",
      "toBeLessThanOrEqual",
      "toContain",
      "toContainEqual",
      "toEqual",
      "toHaveLength",
      "toHaveProperty",
      "toMatch",
      "toMatchObject",
      "toStrictEqual",
      "toThrow",
      "toThrowError",
    ]);
    const matcher = vitest.chain[0];
    const negated = vitest.chain.includes("not");
    const negative = isFalseAssertionExpected(vitest.expected) ||
      (!negated && vitest.chain.some((name) =>
        ["rejects", "toThrow", "toThrowError"].includes(name)
      ));
    return (
      allowedMatchers.has(matcher) &&
      (!requireNegative || negative) &&
      isAssertionOnCapabilityInvocation(vitest.actual, boundNames, assertionTargets) &&
      !sameAssertionOperand(vitest.actual, vitest.expected)
    );
  }
  const nodeAssert = analyzeNodeAssertCall(call, framework);
  if (nodeAssert === null) {
    return false;
  }
  const negative = ["notDeepStrictEqual", "notStrictEqual", "rejects", "throws"].includes(
    nodeAssert.method,
  ) || isFalseAssertionExpected(nodeAssert.expected);
  return (
    (!requireNegative || negative) &&
    isAssertionOnCapabilityInvocation(nodeAssert.actual, boundNames, assertionTargets) &&
    !sameAssertionOperand(nodeAssert.actual, nodeAssert.expected)
  );
}

/** 断言实际值必须直接执行受绑定能力；逗号表达式或无关上下文断言不得充当证据。 */
function isAssertionOnCapabilityInvocation(expression, boundNames, assertionTargets) {
  const value = unwrapExpression(expression);
  if (ts.isAwaitExpression(value)) {
    return isAssertionOnCapabilityInvocation(value.expression, boundNames, assertionTargets);
  }
  if (
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    assertionTargets.has(value.expression.text)
  ) {
    return value.arguments.some((argument) => nodeContainsAnyIdentifier(argument, boundNames));
  }
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
    if (!ts.isBlock(value.body)) {
      return isAssertionOnCapabilityInvocation(value.body, boundNames, assertionTargets);
    }
    return value.body.statements.some((statement) => {
      if (ts.isExpressionStatement(statement)) {
        return isAssertionOnCapabilityInvocation(
          statement.expression,
          boundNames,
          assertionTargets,
        );
      }
      return ts.isReturnStatement(statement) && statement.expression !== undefined &&
        isAssertionOnCapabilityInvocation(
          statement.expression,
          boundNames,
          assertionTargets,
        );
    });
  }
  return false;
}

/** 解析 Vitest matcher chain，要求根 expect 来自真实 vitest import。 */
function analyzeVitestAssertion(call, expectNames) {
  if (!ts.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const chain = [];
  let current = call.expression;
  while (ts.isPropertyAccessExpression(current)) {
    chain.push(current.name.text);
    current = current.expression;
  }
  if (
    !ts.isCallExpression(current) ||
    !ts.isIdentifier(current.expression) ||
    !expectNames.has(current.expression.text) ||
    current.arguments.length !== 1
  ) {
    return null;
  }
  return {
    actual: current.arguments[0],
    chain,
    expected: call.arguments[0],
  };
}

/** 解析真实 node:assert/strict 对象方法或命名函数调用。 */
function analyzeNodeAssertCall(call, framework) {
  const allowed = new Set([
    "deepStrictEqual",
    "match",
    "notDeepStrictEqual",
    "notStrictEqual",
    "rejects",
    "strictEqual",
    "throws",
  ]);
  let method = null;
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    framework.assertObjectNames.has(call.expression.expression.text)
  ) {
    method = call.expression.name.text;
  } else if (ts.isIdentifier(call.expression)) {
    method = framework.assertFunctionNames.get(call.expression.text) ?? null;
  }
  if (method === null || !allowed.has(method) || call.arguments.length === 0) {
    return null;
  }
  return { actual: call.arguments[0], expected: call.arguments[1], method };
}

/** 相同表达式的 actual/expected 是恒真或恒假自比较，不能作为能力证据。 */
function sameAssertionOperand(actual, expected) {
  return expected !== undefined && unwrapExpression(actual).getText() === unwrapExpression(expected).getText();
}

/** validator 返回 false 是明确的负向拒绝语义。 */
function isFalseAssertionExpected(expected) {
  return expected !== undefined && unwrapExpression(expected).kind === ts.SyntaxKind.FalseKeyword;
}

/** entry 与受控 runtime 之间只允许规范相对 ESM specifier。 */
function relativeModuleSpecifier(fromPath, targetPath) {
  const relative = path.posix.relative(path.posix.dirname(fromPath), targetPath);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** TypeScript 源模块在 ESM 测试中必须使用对应的 .js runtime specifier。 */
function relativeRuntimeModuleSpecifier(fromPath, targetPath) {
  return relativeModuleSpecifier(fromPath, targetPath).replace(/\.(?:cts|mts|ts)$/u, ".js");
}

/** 精确识别 process.argv.slice(2)，禁止候选丢弃或重排封闭参数。 */
function isProcessArgvSlice(expression) {
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isNumericLiteral(expression.arguments[0]) &&
    expression.arguments[0].text === "2" &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "slice" &&
    ts.isPropertyAccessExpression(expression.expression.expression) &&
    ts.isIdentifier(expression.expression.expression.expression) &&
    expression.expression.expression.expression.text === "process" &&
    expression.expression.expression.name.text === "argv"
  );
}

/** 验证单个能力 verification 的封闭字段、路径与唯一 evidence 身份。 */
function validateVerificationContract(
  capabilityId,
  verification,
  seenEvidenceIds,
  seenVerificationPaths,
) {
  assertClosedObject(
    verification,
    ["assertionTarget", "entryPath", "evidenceId", "fixturePath", "testPath"],
    capabilityBindingsPath,
  );
  assertClosedObject(
    verification.assertionTarget,
    ["exportName", "modulePath"],
    capabilityBindingsPath,
  );
  if (
    !isSafeRepositoryRelativePath(verification.assertionTarget.modulePath) ||
    !/\.(?:[cm]?[jt]s)$/u.test(verification.assertionTarget.modulePath) ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(verification.assertionTarget.exportName)
  ) {
    throw new Error(`${capabilityBindingsPath} 的 assertionTarget 不是合法模块导出。`);
  }
  if (verification.evidenceId !== `public-capability:${capabilityId}`) {
    throw new Error(
      `${capabilityBindingsPath} 的 evidenceId 必须精确绑定 capabilityId '${capabilityId}'。`,
    );
  }
  if (seenEvidenceIds.has(verification.evidenceId)) {
    throw new Error(`${capabilityBindingsPath} 的 evidenceId 必须唯一。`);
  }
  seenEvidenceIds.add(verification.evidenceId);
  const pathContracts = [
    ["entryPath", verification.entryPath, /^scripts\/.*\.(?:c?js|mjs)$/u],
    [
      "testPath",
      verification.testPath,
      /^tests\/(?:unit|contract)\/.*\.test\.(?:[cm]?[jt]s)$/u,
    ],
    ["fixturePath", verification.fixturePath, /^tests\/fixtures\/[^/]+/u],
  ];
  for (const [field, relativePath, rolePattern] of pathContracts) {
    if (!isSafeRepositoryRelativePath(relativePath) || !rolePattern.test(relativePath)) {
      throw new Error(`${capabilityBindingsPath} 的 ${field} 不是合法的仓库内专属资产路径。`);
    }
    if (seenVerificationPaths.has(relativePath)) {
      throw new Error(`${capabilityBindingsPath} 的专属资产路径必须由单个能力独占。`);
    }
    seenVerificationPaths.add(relativePath);
  }
}

/** 从可能尚未通过完整校验的绑定文件中提取候选验证资产路径。 */
function collectDeclaredVerificationPaths(source) {
  if (source === undefined) {
    return [];
  }
  try {
    const value = JSON.parse(source);
    return [...new Set(
      (Array.isArray(value?.bindings) ? value.bindings : [])
        .flatMap((binding) => [
          binding?.verification?.entryPath,
          binding?.verification?.testPath,
          binding?.verification?.fixturePath,
          binding?.verification?.assertionTarget?.modulePath,
        ])
        .filter((relativePath) => isSafeRepositoryRelativePath(relativePath)),
    )].sort();
  } catch {
    return [];
  }
}

/** 判断路径是规范 POSIX 仓库相对路径，禁止逃逸、反斜杠与空段。 */
function isSafeRepositoryRelativePath(relativePath) {
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    !relativePath.startsWith("/") &&
    !relativePath.includes("\\") &&
    path.posix.normalize(relativePath) === relativePath &&
    !relativePath.split("/").includes("..")
  );
}

/** 比较基线与候选 binding 的治理语义；字段顺序不影响结论。 */
function sameBindingContract(left, right) {
  return JSON.stringify(normalizeBindingContract(left)) === JSON.stringify(normalizeBindingContract(right));
}

/** 把 binding 投影为固定字段顺序的比较对象。 */
function normalizeBindingContract(binding) {
  return {
    capabilityId: binding.capabilityId,
    gateId: binding.gateId,
    status: binding.status ?? "active",
    verification: binding.verification ?? null,
  };
}

/** 读取固定 OID 上的公共表面、Gate Registry 与能力映射，不执行候选代码。 */
async function readSurfaceSnapshot(repositoryRoot, oid) {
  const { stdout: listed } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", oid],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    },
  );
  const listedPaths = listed
    .split(/\r?\n/u)
    .filter((relativePath) => relativePath.length > 0)
    .sort();
  const listedPathSet = new Set(listedPaths);
  const paths = listedPaths.filter((relativePath) => isPublicSurfacePath(relativePath));
  const files = new Map();
  for (const relativePath of paths) {
    const { stdout } = await execFileAsync(
      "git",
      ["show", `${oid}:${relativePath}`],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    files.set(relativePath, stdout);
  }
  for (const relativePath of collectDeclaredVerificationPaths(
    files.get(capabilityBindingsPath),
  )) {
    if (files.has(relativePath) || !listedPathSet.has(relativePath)) {
      continue;
    }
    const { stdout } = await execFileAsync("git", ["show", `${oid}:${relativePath}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    });
    files.set(relativePath, stdout);
  }
  return files;
}

/** 仅保留公共表面分析需要的受控文件。 */
function isPublicSurfacePath(relativePath) {
  return (
    relativePath === cliManifestPath ||
    relativePath === extensionManifestPath ||
    relativePath === gateRegistryPath ||
    relativePath === capabilityBindingsPath ||
    /^apps\/cli\/src\/.*\.(?:ts|tsx)$/u.test(relativePath) ||
    /^apps\/extension\/src\/.*\.(?:ts|tsx)$/u.test(relativePath) ||
    /^apps\/graph-service\/src\/.*\.(?:ts|tsx)$/u.test(relativePath) ||
    (/^packages\/contracts\//u.test(relativePath) &&
      !/^packages\/contracts\/(?:dist|node_modules)\//u.test(relativePath) &&
      /\.(?:[cm]?[jt]sx?)$/u.test(relativePath))
  );
}

/** CLI manifest 必须与绑定真实 handler 的源码权威注册表逐项一致。 */
function collectCliCapabilities(files, workspace, capabilities, options) {
  const source = files.get(cliManifestPath);
  if (source === undefined && options.allowBootstrap === true) {
    return;
  }
  const manifest = parseJsonObject(source, cliManifestPath);
  const binaries = manifest.bin ?? {};
  if (typeof binaries !== "object" || binaries === null || Array.isArray(binaries)) {
    throw new Error(`${cliManifestPath} 的 bin 必须是对象。`);
  }
  for (const [name, target] of Object.entries(binaries).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (typeof target !== "string" || target.length === 0) {
      throw new Error(`${cliManifestPath} 的 bin '${name}' 必须绑定非空入口。`);
    }
    capabilities.set(`cli:binary:${name}`, `cli:binary:${name}`);
  }

  const commands =
    options.allowBootstrap === true && manifest.codegraph?.publicCommands === undefined
      ? []
      : manifest.codegraph?.publicCommands;
  if (
    !Array.isArray(commands) ||
    !commands.every((command) => typeof command === "string" && command.length > 0) ||
    !isStrictlySortedUnique(commands)
  ) {
    throw new Error(
      `${cliManifestPath} 必须以 codegraph.publicCommands 升序唯一字符串数组声明公共 CLI 命令。`,
    );
  }
  const registeredCommands = collectCliCommandRegistry(workspace, commands.length === 0);
  if (!sameOrderedStrings(commands, registeredCommands)) {
    throw new Error(
      `${cliManifestPath} 的 publicCommands 必须与 ${cliRegistryPath} 的 PUBLIC_COMMANDS 真实 handler 完全一致。`,
    );
  }
  if (commands.length > 0) {
    validateCliDispatchPath(workspace, binaries);
  }
  for (const command of commands) {
    capabilities.set(`cli:command:${command}`, `cli:command:${command}`);
  }
}

/** 公开命令只能由唯一 bin 入口通过受控 dispatcher 消费权威冻结注册表。 */
function validateCliDispatchPath(workspace, binaries) {
  const targets = [...new Set(Object.values(binaries))];
  if (Object.keys(binaries).length !== 1 || targets.length !== 1) {
    throw new Error(`${cliManifestPath} 的公开命令必须只有一个唯一 bin 分派入口。`);
  }
  const entryPath = resolveCliBinSourcePath(workspace, targets[0]);
  if (entryPath === null) {
    throw new Error(`${cliManifestPath} 的 bin 无法解析到 checked-in TypeScript 分派入口。`);
  }
  const sourceFile = workspace.sourceFiles.get(entryPath);
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, {
        importedName: element.propertyName?.text ?? element.name.text,
        specifier: statement.moduleSpecifier.text,
      });
    }
  }
  const registryImport = imports.get("PUBLIC_COMMANDS");
  const dispatchImport = imports.get("dispatchPublicCommand");
  if (
    registryImport?.importedName !== "PUBLIC_COMMANDS" ||
    resolveImportTarget(entryPath, registryImport.specifier) !== cliRegistryPath ||
    dispatchImport?.importedName !== "dispatchPublicCommand" ||
    resolveImportTarget(entryPath, dispatchImport.specifier) !== cliDispatchPath
  ) {
    throw new Error("CLI bin 分派入口必须直接导入 PUBLIC_COMMANDS 与受控 dispatchPublicCommand。 ");
  }
  const dispatcher = collectModuleExports(workspace, cliDispatchPath).get("dispatchPublicCommand");
  if (
    dispatcher === undefined ||
    !isVerifiedPublicCommandDispatcher(workspace, dispatcher)
  ) {
    throw new Error(`${cliDispatchPath} 必须导出真实 dispatchPublicCommand 实现。`);
  }
  const calls = [];
  const registryReferences = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === "PUBLIC_COMMANDS") {
      registryReferences.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "dispatchPublicCommand"
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const dispatchCall = calls.length === 1 ? calls[0] : null;
  if (
    dispatchCall === null ||
    dispatchCall.arguments.length !== 2 ||
    !ts.isIdentifier(dispatchCall.arguments[0]) ||
    dispatchCall.arguments[0].text !== "PUBLIC_COMMANDS" ||
    !isProcessArgvSlice(unwrapExpression(dispatchCall.arguments[1])) ||
    !isTopLevelAwaitedCall(dispatchCall, sourceFile) ||
    registryReferences.length !== 2
  ) {
    throw new Error("CLI bin 必须唯一调用 dispatchPublicCommand(PUBLIC_COMMANDS, process.argv.slice(2))。 ");
  }
}

/** bin 调用必须直接位于模块顶层并被 await，禁止藏在从未执行的函数中。 */
function isTopLevelAwaitedCall(call, sourceFile) {
  return (
    ts.isAwaitExpression(call.parent) &&
    ts.isExpressionStatement(call.parent.parent) &&
    call.parent.parent.parent === sourceFile
  );
}

/** dispatcher 必须以 own-property lookup 按 argv 选择并在可达路径调用 registry handler。 */
function isVerifiedPublicCommandDispatcher(workspace, binding) {
  const functionLike = binding.kind === "function"
    ? binding.declaration
    : binding.kind === "variable" && binding.declaration.initializer !== undefined
      ? unwrapExpression(binding.declaration.initializer)
      : null;
  if (
    functionLike === null ||
    (!ts.isFunctionDeclaration(functionLike) &&
      !ts.isFunctionExpression(functionLike) &&
      !ts.isArrowFunction(functionLike)) ||
    functionLike.parameters.length !== 2 ||
    !functionLike.parameters.every((parameter) => ts.isIdentifier(parameter.name)) ||
    !ts.isBlock(functionLike.body)
  ) {
    return false;
  }
  const commandsName = functionLike.parameters[0].name.text;
  const argvName = functionLike.parameters[1].name.text;
  const statements = functionLike.body.statements;
  let commandIdName = null;
  let guardIndex = -1;
  let handlerName = null;
  let selectionIndex = -1;
  let callIndex = -1;
  for (const [index, statement] of statements.entries()) {
    const declaration = singleVariableDeclaration(statement);
    if (
      commandIdName === null &&
      declaration !== null &&
      declaration.initializer !== undefined &&
      isCanonicalCommandIdDerivation(declaration.initializer, argvName)
    ) {
      commandIdName = declaration.name.text;
      continue;
    }
    if (
      commandIdName !== null &&
      guardIndex < 0 &&
      ts.isIfStatement(statement) &&
      isCanonicalOwnPropertyGuard(
        workspace,
        binding.modulePath,
        statement,
        commandsName,
        commandIdName,
      )
    ) {
      guardIndex = index;
      continue;
    }
    if (
      guardIndex >= 0 &&
      handlerName === null &&
      declaration !== null &&
      declaration.initializer !== undefined &&
      isCanonicalHandlerSelection(
        declaration.initializer,
        commandsName,
        commandIdName,
      )
    ) {
      handlerName = declaration.name.text;
      selectionIndex = index;
      continue;
    }
    if (
      handlerName !== null &&
      isCanonicalHandlerInvocation(statement, handlerName, argvName)
    ) {
      callIndex = index;
    }
  }
  return (
    commandIdName !== null &&
    guardIndex >= 0 &&
    selectionIndex > guardIndex &&
    callIndex > selectionIndex
  );
}

/** 顶层变量语句必须只声明一个标识符，避免隐藏额外数据流。 */
function singleVariableDeclaration(statement) {
  if (
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1 ||
    !ts.isIdentifier(statement.declarationList.declarations[0].name)
  ) {
    return null;
  }
  return statement.declarationList.declarations[0];
}

/** commandId 只允许直接来自 `argv[0] ?? ""`，禁止逗号表达式或无关别名。 */
function isCanonicalCommandIdDerivation(rawExpression, argvName) {
  const expression = unwrapExpression(rawExpression);
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken
  ) {
    return false;
  }
  const left = unwrapExpression(expression.left);
  const right = unwrapExpression(expression.right);
  return (
    ts.isElementAccessExpression(left) &&
    ts.isIdentifier(left.expression) &&
    left.expression.text === argvName &&
    left.argumentExpression !== undefined &&
    ts.isNumericLiteral(unwrapExpression(left.argumentExpression)) &&
    unwrapExpression(left.argumentExpression).text === "0" &&
    (ts.isStringLiteral(right) || ts.isNoSubstitutionTemplateLiteral(right)) &&
    right.text === ""
  );
}

/** own-property guard 必须位于同一顶层 block，失败分支必须确定退出。 */
function isCanonicalOwnPropertyGuard(
  workspace,
  modulePath,
  statement,
  commandsName,
  commandIdName,
) {
  const condition = unwrapExpression(statement.expression);
  if (!ts.isPrefixUnaryExpression(condition) || condition.operator !== ts.SyntaxKind.ExclamationToken) {
    return false;
  }
  const call = unwrapExpression(condition.operand);
  return (
    ts.isCallExpression(call) &&
    call.arguments.length === 2 &&
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "Object" &&
    call.expression.name.text === "hasOwn" &&
    resolveLocalBinding(workspace, modulePath, "Object") === null &&
    isIdentifierNamed(call.arguments[0], commandsName) &&
    isIdentifierNamed(call.arguments[1], commandIdName) &&
    statementAlwaysExits(statement.thenStatement)
  );
}

/** handler 必须以同一受保护 commandId 直接索引 registry。 */
function isCanonicalHandlerSelection(rawExpression, commandsName, commandIdName) {
  const expression = unwrapExpression(rawExpression);
  return (
    ts.isElementAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === commandsName &&
    expression.argumentExpression !== undefined &&
    isIdentifierNamed(expression.argumentExpression, commandIdName)
  );
}

/** handler 调用必须在同一顶层 block 中 await，并只接收 `argv.slice(1)`。 */
function isCanonicalHandlerInvocation(statement, handlerName, argvName) {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
    return false;
  }
  const call = unwrapExpression(statement.expression.expression);
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === handlerName &&
    call.arguments.length === 1 &&
    isArgvTailSlice(call.arguments[0], argvName)
  );
}

/** 精确识别 `argv.slice(1)`。 */
function isArgvTailSlice(rawExpression, argvName) {
  const expression = unwrapExpression(rawExpression);
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isNumericLiteral(unwrapExpression(expression.arguments[0])) &&
    unwrapExpression(expression.arguments[0]).text === "1" &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === argvName &&
    expression.expression.name.text === "slice"
  );
}

/** 失败分支必须以 throw/return 收敛，不能只在无关路径检查 own-property。 */
function statementAlwaysExits(statement) {
  if (ts.isThrowStatement(statement) || ts.isReturnStatement(statement)) {
    return true;
  }
  return ts.isBlock(statement) &&
    statement.statements.length > 0 &&
    statementAlwaysExits(statement.statements.at(-1));
}

/** 判断表达式是否是给定标识符。 */
function isIdentifierNamed(rawExpression, expectedName) {
  const expression = unwrapExpression(rawExpression);
  return ts.isIdentifier(expression) && expression.text === expectedName;
}

/** 排除嵌套函数以及字面量 false/true 控制流中的静态不可达节点。 */
function isReachableWithinFunction(node, functionLike) {
  let current = node;
  while (current !== functionLike.body) {
    const parent = current.parent;
    if (parent === undefined) {
      return false;
    }
    if (
      parent !== functionLike &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent))
    ) {
      return false;
    }
    if (ts.isIfStatement(parent)) {
      const condition = staticBooleanValue(parent.expression);
      if (
        (current === parent.thenStatement && condition === false) ||
        (current === parent.elseStatement && condition === true)
      ) {
        return false;
      }
    }
    if (ts.isConditionalExpression(parent)) {
      const condition = staticBooleanValue(parent.condition);
      if (
        (current === parent.whenTrue && condition === false) ||
        (current === parent.whenFalse && condition === true)
      ) {
        return false;
      }
    }
    if (
      (ts.isWhileStatement(parent) || ts.isForStatement(parent)) &&
      current === parent.statement &&
      parent.expression !== undefined &&
      staticBooleanValue(parent.expression) === false
    ) {
      return false;
    }
    current = parent;
  }
  return true;
}

/** 仅解析控制流验证所需的布尔字面量。 */
function staticBooleanValue(expression) {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (value.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return null;
}

/** 将 manifest 的 dist bin 目标确定性映射到候选源码入口。 */
function resolveCliBinSourcePath(workspace, target) {
  if (typeof target !== "string" || target.length === 0) {
    return null;
  }
  const normalized = path.posix.normalize(path.posix.join("apps/cli", target));
  const candidates = [
    normalized,
    normalized.replace(/^apps\/cli\/dist\//u, "apps/cli/src/").replace(/\.js$/u, ".ts"),
    normalized.replace(/\.js$/u, ".ts"),
  ];
  return candidates.find((candidate) => workspace.sourceFiles.has(candidate)) ?? null;
}

/** 只解析相对 import 目标，不允许 bin 分派依赖外部或逃逸模块。 */
function resolveImportTarget(fromPath, specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) {
    return null;
  }
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(fromPath), specifier))
    .replace(/\.js$/u, ".ts");
}

/** 读取源码命令注册表并确认每个键都绑定可调用实现。 */
function collectCliCommandRegistry(workspace, allowMissing) {
  if (!workspace.sourceFiles.has(cliRegistryPath)) {
    if (allowMissing) {
      return [];
    }
    throw new Error(`${cliRegistryPath} 缺失。`);
  }
  const exported = collectModuleExports(workspace, cliRegistryPath);
  const binding = exported.get("PUBLIC_COMMANDS");
  if (binding === undefined || binding.kind !== "variable") {
    throw new Error(`${cliRegistryPath} 必须 export const PUBLIC_COMMANDS。`);
  }
  const object = resolveFrozenPublicCommandsObject(workspace, binding);
  const commands = [];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error("PUBLIC_COMMANDS 禁止 spread；每个公共命令必须显式绑定 handler。");
    }
    const command = propertyNameText(property.name);
    const handler = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isMethodDeclaration(property)
          ? property
          : null;
    if (
      command === null ||
      handler === null ||
      !isCallableExpression(workspace, binding.modulePath, handler, new Set())
    ) {
      throw new Error("PUBLIC_COMMANDS 的每个公共命令必须以静态键绑定真实函数实现。");
    }
    commands.push(command);
  }
  commands.sort();
  if (!isStrictlySortedUnique(commands)) {
    throw new Error("PUBLIC_COMMANDS 的命令 ID 必须唯一。");
  }
  return commands;
}

/**
 * PUBLIC_COMMANDS 必须是本模块 export const 的 Object.freeze(直接对象字面量)，且符号不得再次被读取或写入。
 */
function resolveFrozenPublicCommandsObject(workspace, binding) {
  if (binding.modulePath !== cliRegistryPath) {
    throw new Error("PUBLIC_COMMANDS 必须在权威注册表模块直接声明，禁止整对象别名或 re-export。");
  }
  const declarationList = binding.declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    (declarationList.flags & ts.NodeFlags.Const) === 0
  ) {
    throw new Error("PUBLIC_COMMANDS 必须使用 export const 声明。");
  }
  const expression = binding.declaration.initializer === undefined
    ? undefined
    : unwrapExpression(binding.declaration.initializer);
  if (
    expression === undefined ||
    !ts.isCallExpression(expression) ||
    expression.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.expression.expression.text !== "Object" ||
    expression.expression.name.text !== "freeze" ||
    !ts.isObjectLiteralExpression(expression.arguments[0])
  ) {
    throw new Error("PUBLIC_COMMANDS 必须是 Object.freeze(直接对象字面量)。");
  }
  if (resolveLocalBinding(workspace, binding.modulePath, "Object") !== null) {
    throw new Error("PUBLIC_COMMANDS 必须调用未被局部绑定遮蔽的全局 Object.freeze。");
  }
  const sourceFile = workspace.sourceFiles.get(binding.modulePath);
  let escaped = false;
  const visit = (node) => {
    if (
      node !== binding.declaration.name &&
      ts.isIdentifier(node) &&
      node.text === "PUBLIC_COMMANDS"
    ) {
      escaped = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (escaped) {
    throw new Error("PUBLIC_COMMANDS 禁止声明后的 mutation、Object.assign 或别名逃逸。");
  }
  return expression.arguments[0];
}

/** extension manifest 与真实 registerCommand 调用必须逐项闭合。 */
function collectExtensionCapabilities(files, workspace, capabilities, options) {
  const source = files.get(extensionManifestPath);
  if (source === undefined && options.allowBootstrap === true) {
    return;
  }
  const manifest = parseJsonObject(source, extensionManifestPath);
  const commands = manifest.contributes?.commands ?? [];
  if (!Array.isArray(commands)) {
    throw new Error(`${extensionManifestPath} contributes.commands 必须是数组。`);
  }
  const manifestCommands = new Set();
  for (const command of commands) {
    if (typeof command?.command !== "string" || command.command.length === 0) {
      throw new Error("extension 公共 command 必须包含非空 command ID。");
    }
    if (manifestCommands.has(command.command)) {
      throw new Error("extension contributes.commands 包含重复 command ID。");
    }
    manifestCommands.add(command.command);
    capabilities.set(
      `extension:command:${command.command}`,
      `extension:command:${command.command}`,
    );
  }
  const registeredCommands = collectExtensionRegisteredCommands(workspace);
  if (!sameStringSet(manifestCommands, registeredCommands)) {
    throw new Error(
      "extension contributes.commands 必须与 apps/extension/src 的真实 registerCommand 调用逐项一致。",
    );
  }
}

/** 收集 extension 源码中的直接命令注册；别名逃逸或动态 ID 一律 fail closed。 */
function collectExtensionRegisteredCommands(workspace) {
  const registered = new Set();
  for (const [modulePath, sourceFile] of workspace.sourceFiles) {
    if (!/^apps\/extension\/src\//u.test(modulePath)) {
      continue;
    }
    const visit = (node) => {
      const commandRegistration = extensionRegisterCommandAccess(node);
      if (commandRegistration !== null) {
        const parent = node.parent;
        if (!ts.isCallExpression(parent) || parent.expression !== node) {
          throw new Error(`${modulePath} 的 registerCommand 禁止别名逃逸或脱离直接调用。`);
        }
        const commandId = parent.arguments[0] === undefined
          ? null
          : evaluateStringExpression(workspace, modulePath, parent.arguments[0], new Set());
        if (commandId === null || commandId.length === 0 || registered.has(commandId)) {
          throw new Error(`${modulePath} 的 registerCommand 必须使用唯一非空静态 command ID。`);
        }
        registered.add(commandId);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return registered;
}

/** 识别属性、元素或命名导入形式的 registerCommand 访问。 */
function extensionRegisterCommandAccess(node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === "registerCommand") {
    return node;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
    node.argumentExpression.text === "registerCommand"
  ) {
    return node;
  }
  if (ts.isIdentifier(node) && node.text === "registerCommand") {
    const parent = node.parent;
    if (
      ts.isImportSpecifier(parent) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
    ) {
      return null;
    }
    return node;
  }
  return null;
}

/** SERVICE_METHODS 必须与 graph-service 的真实请求处理路径逐项闭合。 */
function collectRpcCapabilities(workspace, capabilities, options) {
  if (!workspace.sourceFiles.has(rpcContractPath) && options.allowBootstrap === true) {
    return;
  }
  const exported = collectModuleExports(workspace, rpcContractPath);
  const binding = exported.get("SERVICE_METHODS");
  if (binding === undefined || binding.kind !== "variable") {
    throw new Error(`${rpcContractPath} 缺少 export const SERVICE_METHODS。`);
  }
  assertBindingRuntimeStable(workspace, binding, "SERVICE_METHODS");
  const resolvedObject = resolveObjectLiteral(workspace, binding, new Set());
  const methods = new Set();
  const methodsByProperty = new Map();
  for (const property of resolvedObject.object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadBinding = resolveExpressionBinding(
        workspace,
        resolvedObject.modulePath,
        property.expression,
      );
      if (spreadBinding === null || spreadBinding.kind !== "variable") {
        throw new Error("SERVICE_METHODS spread 必须引用静态 const 对象。");
      }
      const nested = resolveObjectLiteral(workspace, spreadBinding, new Set());
      collectRpcObjectMethods(workspace, nested.modulePath, nested.object, methods, methodsByProperty);
      continue;
    }
    collectRpcPropertyMethod(
      workspace,
      resolvedObject.modulePath,
      property,
      methods,
      methodsByProperty,
    );
  }
  const handledMethods = collectRpcHandledMethods(workspace, methodsByProperty);
  if (!sameStringSet(methods, handledMethods)) {
    throw new Error(
      "SERVICE_METHODS 必须与 apps/graph-service/src 的真实 onRequest/方法分支逐项一致。",
    );
  }
  for (const method of [...methods].sort()) {
    capabilities.set(`rpc:${method}`, `rpc:${method}`);
  }
}

/** 提取一个 RPC 对象的静态字符串值。 */
function collectRpcObjectMethods(workspace, modulePath, object, methods, methodsByProperty) {
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error("嵌套 SERVICE_METHODS spread 不受支持；请展开为显式静态属性。");
    }
    collectRpcPropertyMethod(workspace, modulePath, property, methods, methodsByProperty);
  }
}

/** 把单个 RPC 属性解析为唯一方法名。 */
function collectRpcPropertyMethod(workspace, modulePath, property, methods, methodsByProperty) {
  const propertyName = propertyNameText(property.name);
  const expression = ts.isShorthandPropertyAssignment(property)
    ? property.name
    : ts.isPropertyAssignment(property)
      ? property.initializer
      : null;
  const method = expression === null
    ? null
    : evaluateStringExpression(workspace, modulePath, expression, new Set());
  if (propertyName === null || method === null || method.length === 0 || methods.has(method)) {
    throw new Error("SERVICE_METHODS 的每个属性必须解析为唯一非空静态字符串。");
  }
  methods.add(method);
  methodsByProperty.set(propertyName, method);
}

/** 从真实 onRequest 注册、method 比较与 SERVICE_METHODS 引用收集可调用 RPC。 */
function collectRpcHandledMethods(workspace, methodsByProperty) {
  const handled = new Set();
  for (const [modulePath, sourceFile] of workspace.sourceFiles) {
    if (!/^apps\/graph-service\/src\//u.test(modulePath)) {
      continue;
    }
    const requestMethodNames = new Set(["method"]);
    const serviceMethodObjectNames = collectImportedServiceMethodObjectNames(sourceFile);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        isNamedPropertyCall(node.expression, "onRequest")
      ) {
        const firstArgument = node.arguments[0];
        if (firstArgument !== undefined) {
          const directMethod = evaluateStringExpression(
            workspace,
            modulePath,
            firstArgument,
            new Set(),
          );
          if (directMethod !== null) {
            handled.add(directMethod);
          } else if (
            (ts.isArrowFunction(firstArgument) || ts.isFunctionExpression(firstArgument)) &&
            firstArgument.parameters[0] !== undefined &&
            ts.isIdentifier(firstArgument.parameters[0].name)
          ) {
            requestMethodNames.add(firstArgument.parameters[0].name.text);
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        serviceMethodObjectNames.has(node.expression.text)
      ) {
        const declaredMethod = methodsByProperty.get(node.name.text);
        if (declaredMethod !== undefined) {
          handled.add(declaredMethod);
        }
      }
      if (ts.isBinaryExpression(node) && isEqualityOperator(node.operatorToken.kind)) {
        const method = methodComparisonLiteral(
          workspace,
          modulePath,
          node.left,
          node.right,
          requestMethodNames,
        ) ?? methodComparisonLiteral(
          workspace,
          modulePath,
          node.right,
          node.left,
          requestMethodNames,
        );
        if (method !== null) {
          handled.add(method);
        }
      }
      if (
        ts.isCaseClause(node) &&
        ts.isSwitchStatement(node.parent?.parent) &&
        ts.isIdentifier(unwrapExpression(node.parent.parent.expression)) &&
        requestMethodNames.has(unwrapExpression(node.parent.parent.expression).text)
      ) {
        const method = evaluateStringExpression(workspace, modulePath, node.expression, new Set());
        if (method !== null) {
          handled.add(method);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return handled;
}

/** 收集 graph-service 从 contracts 导入的 SERVICE_METHODS 本地名称。 */
function collectImportedServiceMethodObjectNames(sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly === true ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === "SERVICE_METHODS") {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/** 识别对象方法调用，避免把同名普通变量误当作 RPC 注册 API。 */
function isNamedPropertyCall(expression, name) {
  return (
    (ts.isPropertyAccessExpression(expression) && expression.name.text === name) ||
    (ts.isElementAccessExpression(expression) &&
      expression.argumentExpression !== undefined &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression)) &&
      expression.argumentExpression.text === name)
  );
}

/** 从 `method === "literal"` 或反向比较提取静态 RPC 方法名。 */
function methodComparisonLiteral(workspace, modulePath, candidate, value, requestMethodNames) {
  const unwrappedCandidate = unwrapExpression(candidate);
  if (!ts.isIdentifier(unwrappedCandidate) || !requestMethodNames.has(unwrappedCandidate.text)) {
    return null;
  }
  return evaluateStringExpression(workspace, modulePath, value, new Set());
}

/** RPC 方法分支只接受严格相等或不等比较。 */
function isEqualityOperator(kind) {
  return [
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ].includes(kind);
}

/** 从 contracts 根 index 递归解析 export/re-export，并为 Schema 结构生成语义指纹。 */
function collectExportedSchemaCapabilities(workspace, capabilities, options) {
  if (!workspace.sourceFiles.has(contractsIndexPath) && options.allowBootstrap === true) {
    return;
  }
  const exported = collectModuleExports(workspace, contractsIndexPath);
  collectSchemaCapabilitiesFromExports(workspace, exported, "", capabilities, new Set());
}

/** 递归展开 namespace export，使用真实公共访问路径作为稳定 capability ID。 */
function collectSchemaCapabilitiesFromExports(
  workspace,
  exported,
  prefix,
  capabilities,
  namespaceStack,
) {
  for (const [exportName, binding] of [...exported].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (binding.kind === "namespace") {
      if (namespaceStack.has(binding.modulePath)) {
        throw new Error(`公共 namespace 导出图包含循环：${binding.modulePath}。`);
      }
      namespaceStack.add(binding.modulePath);
      collectSchemaCapabilitiesFromExports(
        workspace,
        collectModuleExports(workspace, binding.modulePath),
        `${prefix}${exportName}.`,
        capabilities,
        namespaceStack,
      );
      namespaceStack.delete(binding.modulePath);
      continue;
    }
    if (binding.kind !== "variable" || !isPublicSchemaBinding(workspace, exportName, binding)) {
      continue;
    }
    assertBindingRuntimeStable(workspace, binding, "公共 Schema");
    capabilities.set(
      `schema:${prefix}${exportName}`,
      fingerprintBinding(workspace, binding, new Set()),
    );
  }
}

/**
 * 依据真实声明名或 JSON-Schema 结构识别公共 Schema，禁止用候选可控导出别名隐藏能力。
 */
function isPublicSchemaBinding(workspace, exportName, binding) {
  const declaredName = binding.declaration.name?.text ?? "";
  if (exportName.endsWith("Schema") || declaredName.endsWith("Schema")) {
    return true;
  }
  return isSchemaLikeBinding(workspace, binding, new Set());
}

/** 静态跟随 const 别名，识别具有约束关键字的 JSON-Schema 对象。 */
function isSchemaLikeBinding(workspace, binding, stack) {
  const key = bindingKey(binding);
  if (stack.has(key) || binding.kind !== "variable") {
    return false;
  }
  stack.add(key);
  let expression = binding.declaration.initializer;
  expression = expression === undefined ? undefined : unwrapExpression(expression);
  expression = unwrapApprovedObjectFreeze(workspace, binding.modulePath, expression);
  if (expression && (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression))) {
    const target = resolveExpressionBinding(workspace, binding.modulePath, expression);
    const result = target === null ? false : isSchemaLikeBinding(workspace, target, stack);
    stack.delete(key);
    return result;
  }
  stack.delete(key);
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    return false;
  }
  const names = new Set(
    expression.properties
      .map((property) => propertyNameText(property.name))
      .filter((name) => name !== null),
  );
  const standaloneSchemaKeywords = [
    "$defs",
    "$ref",
    "allOf",
    "anyOf",
    "const",
    "else",
    "enum",
    "if",
    "not",
    "oneOf",
    "then",
  ];
  return (
    names.has("$schema") ||
    standaloneSchemaKeywords.some((name) => names.has(name)) ||
    (names.has("type") &&
      [
        "additionalProperties",
        "allOf",
        "anyOf",
        "const",
        "enum",
        "items",
        "oneOf",
        "properties",
        "required",
      ].some((name) => names.has(name)))
  );
}

/** 创建只解析候选源码、不执行候选模块的 TypeScript 工作区。 */
function createTypeScriptWorkspace(files) {
  const sourceFiles = new Map();
  for (const [relativePath, source] of files) {
    if (!/\.(?:[cm]?[jt]sx?)$/u.test(relativePath)) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      relativePath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : /\.(?:js|mjs|cjs)$/u.test(relativePath)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
    );
    if ((sourceFile.parseDiagnostics ?? []).length > 0) {
      throw new Error(`${relativePath} 无法作为 TypeScript AST 解析。`);
    }
    sourceFiles.set(relativePath, sourceFile);
  }
  return {
    exportCache: new Map(),
    fingerprintCache: new Map(),
    runtimeStabilityCache: new Set(),
    sourceFiles,
  };
}

/** 递归收集一个模块的值导出，检测歧义 re-export。 */
function collectModuleExports(workspace, modulePath, stack = new Set()) {
  const cached = workspace.exportCache.get(modulePath);
  if (cached !== undefined) {
    return cached;
  }
  if (stack.has(modulePath)) {
    throw new Error(`公共导出图包含循环：${modulePath}。`);
  }
  const sourceFile = workspace.sourceFiles.get(modulePath);
  if (sourceFile === undefined) {
    throw new Error(`公共导出模块缺失：${modulePath}。`);
  }
  stack.add(modulePath);
  const exported = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          addExport(exported, declaration.name.text, {
            declaration,
            kind: "variable",
            modulePath,
          });
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      const exportedName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        ? "default"
        : statement.name?.text;
      if (exportedName === undefined) {
        throw new Error(`${modulePath} 的匿名函数导出必须使用 default。`);
      }
      addExport(exported, exportedName, {
        declaration: statement,
        kind: "function",
        modulePath,
      });
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const binding = resolveExpressionBinding(workspace, modulePath, statement.expression);
      if (binding === null) {
        throw new Error(`${modulePath} 的 default export 必须引用静态值绑定。`);
      }
      addExport(exported, "default", binding);
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      continue;
    }
    if (statement.moduleSpecifier !== undefined) {
      const targetPath = resolveModulePath(
        workspace,
        modulePath,
        statement.moduleSpecifier.text,
      );
      const targetExports = collectModuleExports(workspace, targetPath, stack);
      if (statement.exportClause === undefined) {
        for (const [name, binding] of targetExports) {
          if (name !== "default") {
            addExport(exported, name, binding);
          }
          }
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        addExport(exported, statement.exportClause.name.text, {
          kind: "namespace",
          modulePath: targetPath,
        });
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const importedName = element.propertyName?.text ?? element.name.text;
          const binding = targetExports.get(importedName);
          if (binding === undefined) {
            throw new Error(`${modulePath} re-export 了不存在的值 '${importedName}'。`);
          }
          addExport(exported, element.name.text, binding);
        }
      }
      continue;
    }
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const localName = element.propertyName?.text ?? element.name.text;
        const binding = resolveLocalBinding(workspace, modulePath, localName);
        if (binding === null) {
          throw new Error(`${modulePath} 导出了不存在的本地值 '${localName}'。`);
        }
        addExport(exported, element.name.text, binding);
      }
    }
  }
  stack.delete(modulePath);
  workspace.exportCache.set(modulePath, exported);
  return exported;
}

/** 只把未被局部遮蔽的全局 Object.freeze 单参数调用视为 Schema 透明包装。 */
function unwrapApprovedObjectFreeze(workspace, modulePath, expression) {
  if (
    expression !== undefined &&
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Object" &&
    expression.expression.name.text === "freeze" &&
    resolveLocalBinding(workspace, modulePath, "Object") === null
  ) {
    return unwrapExpression(expression.arguments[0]);
  }
  return expression;
}

/** 解析同模块声明或命名 import 对应的真实值绑定。 */
function resolveLocalBinding(workspace, modulePath, localName) {
  const sourceFile = workspace.sourceFiles.get(modulePath);
  if (sourceFile === undefined) {
    return null;
  }
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === localName) {
          return { declaration, kind: "variable", modulePath };
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === localName
    ) {
      return { declaration: statement, kind: "function", modulePath };
    } else if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const importClause = statement.importClause;
      if (importClause === undefined) {
        continue;
      }
      if (importClause.name?.text === localName) {
        const targetPath = resolveModulePath(
          workspace,
          modulePath,
          statement.moduleSpecifier.text,
        );
        return collectModuleExports(workspace, targetPath).get("default") ?? null;
      }
      if (
        importClause.namedBindings === undefined ||
        !ts.isNamedImports(importClause.namedBindings)
      ) {
        continue;
      }
      for (const element of importClause.namedBindings.elements) {
        if (element.isTypeOnly || element.name.text !== localName) {
          continue;
        }
        const targetPath = resolveModulePath(
          workspace,
          modulePath,
          statement.moduleSpecifier.text,
        );
        return collectModuleExports(workspace, targetPath).get(
          element.propertyName?.text ?? element.name.text,
        ) ?? null;
      }
    }
  }
  return null;
}

/** 解析 namespace import 的目标模块；普通命名/default import 返回 null。 */
function resolveNamespaceImport(workspace, modulePath, localName) {
  const sourceFile = workspace.sourceFiles.get(modulePath);
  if (sourceFile === undefined) {
    return null;
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const importClause = statement.importClause;
    if (
      importClause === undefined ||
      importClause.isTypeOnly ||
      importClause.namedBindings === undefined ||
      !ts.isNamespaceImport(importClause.namedBindings) ||
      importClause.namedBindings.name.text !== localName
    ) {
      continue;
    }
    return resolveModulePath(workspace, modulePath, statement.moduleSpecifier.text);
  }
  return null;
}

/** 解析相对 ESM specifier 到快照内 TypeScript 源文件。 */
function resolveModulePath(workspace, fromPath, specifier) {
  if (!specifier.startsWith(".")) {
    throw new Error(`${fromPath} 的公共表面禁止依赖外部模块 '${specifier}'。`);
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [
    joined,
    joined.replace(/\.js$/u, ".ts").replace(/\.mjs$/u, ".mts"),
    `${joined}.ts`,
    `${joined}.js`,
    `${joined}/index.ts`,
    `${joined}/index.js`,
  ];
  const resolved = candidates.find((candidate) => workspace.sourceFiles.has(candidate));
  if (resolved === undefined) {
    throw new Error(`${fromPath} 无法解析公共模块 '${specifier}'。`);
  }
  return resolved;
}

/** 为静态 const 值生成忽略注释、格式和常量别名的稳定语义指纹。 */
function fingerprintBinding(workspace, binding, stack) {
  const key = bindingKey(binding);
  const cached = workspace.fingerprintCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  if (stack.has(key)) {
    throw new Error(`公共 Schema 常量包含循环：${key}。`);
  }
  stack.add(key);
  const normalized = normalizeBindingValue(workspace, binding, stack, new Map());
  stack.delete(key);
  const fingerprint = sha256CanonicalJson(normalized);
  workspace.fingerprintCache.set(key, fingerprint);
  return fingerprint;
}

/** 把绑定值归一化为可 canonical hash 的封闭 AST 语义对象。 */
function normalizeBindingValue(workspace, binding, stack, parameters) {
  if (binding.kind === "function") {
    return normalizeFunctionLike(workspace, binding.modulePath, binding.declaration, stack, parameters);
  }
  if (binding.declaration.initializer === undefined) {
    throw new Error(`${bindingKey(binding)} 缺少静态 initializer。`);
  }
  return normalizeExpression(
    workspace,
    binding.modulePath,
    binding.declaration.initializer,
    stack,
    parameters,
  );
}

/** 归一化 Schema 使用的受控 TypeScript 表达式。 */
function normalizeExpression(workspace, modulePath, rawExpression, stack, parameters) {
  const expression = unwrapExpression(rawExpression);
  const frozenValue = unwrapApprovedObjectFreeze(workspace, modulePath, expression);
  if (frozenValue !== expression) {
    return normalizeExpression(workspace, modulePath, frozenValue, stack, parameters);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { kind: "string", value: expression.text };
  }
  if (ts.isNumericLiteral(expression)) {
    return { kind: "number", value: Number(expression.text) };
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) {
    return { kind: "boolean", value: expression.kind === ts.SyntaxKind.TrueKeyword };
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    return { kind: "null" };
  }
  if (ts.isIdentifier(expression)) {
    const parameterIndex = parameters.get(expression.text);
    if (parameterIndex !== undefined) {
      return { index: parameterIndex, kind: "parameter" };
    }
    const binding = resolveLocalBinding(workspace, modulePath, expression.text);
    if (binding === null) {
      return { kind: "identifier", name: expression.text };
    }
    const key = bindingKey(binding);
    if (stack.has(key)) {
      throw new Error(`公共 Schema 常量包含循环：${key}。`);
    }
    stack.add(key);
    const normalized = normalizeBindingValue(workspace, binding, stack, parameters);
    stack.delete(key);
    return normalized;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return {
      items: expression.elements.map((element) =>
        ts.isSpreadElement(element)
          ? {
              kind: "spread",
              value: normalizeExpression(workspace, modulePath, element.expression, stack, parameters),
            }
          : normalizeExpression(workspace, modulePath, element, stack, parameters),
      ),
      kind: "array",
    };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const properties = expression.properties.map((property) =>
      normalizeObjectProperty(workspace, modulePath, property, stack, parameters),
    );
    const sortable = properties.every(({ kind }) => kind === "property");
    return {
      kind: "object",
      properties: sortable
        ? properties.sort((left, right) => left.name.localeCompare(right.name))
        : properties,
    };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === "Number" &&
      resolveLocalBinding(workspace, modulePath, "Number") === null
    ) {
      if (expression.name.text === "MAX_SAFE_INTEGER") {
        return { kind: "number", value: Number.MAX_SAFE_INTEGER };
      }
    }
    return {
      expression: normalizeExpression(workspace, modulePath, expression.expression, stack, parameters),
      kind: "property-access",
      name: expression.name.text,
      optional: expression.questionDotToken !== undefined,
    };
  }
  if (ts.isElementAccessExpression(expression)) {
    return {
      argument: expression.argumentExpression === undefined
        ? null
        : normalizeExpression(
            workspace,
            modulePath,
            expression.argumentExpression,
            stack,
            parameters,
          ),
      expression: normalizeExpression(workspace, modulePath, expression.expression, stack, parameters),
      kind: "element-access",
      optional: expression.questionDotToken !== undefined,
    };
  }
  if (ts.isCallExpression(expression)) {
    return {
      arguments: expression.arguments.map((argument) =>
        normalizeExpression(workspace, modulePath, argument, stack, parameters),
      ),
      expression: normalizeExpression(workspace, modulePath, expression.expression, stack, parameters),
      kind: "call",
      optional: expression.questionDotToken !== undefined,
    };
  }
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return normalizeFunctionLike(workspace, modulePath, expression, stack, parameters);
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return {
      kind: "prefix",
      operand: normalizeExpression(workspace, modulePath, expression.operand, stack, parameters),
      operator: ts.tokenToString(expression.operator) ?? `${expression.operator}`,
    };
  }
  throw new Error(`${modulePath} 包含公共 Schema 指纹不支持的表达式 '${expression.getText()}'。`);
}

/** 归一化对象属性；无 spread 时属性顺序不参与 Schema 语义。 */
function normalizeObjectProperty(workspace, modulePath, property, stack, parameters) {
  if (ts.isSpreadAssignment(property)) {
    return {
      kind: "spread",
      value: normalizeExpression(workspace, modulePath, property.expression, stack, parameters),
    };
  }
  const name = propertyNameText(property.name);
  if (name === null) {
    throw new Error(`${modulePath} 的公共 Schema 禁止动态属性名。`);
  }
  if (ts.isPropertyAssignment(property)) {
    return {
      kind: "property",
      name,
      value: normalizeExpression(workspace, modulePath, property.initializer, stack, parameters),
    };
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return {
      kind: "property",
      name,
      value: normalizeExpression(workspace, modulePath, property.name, stack, parameters),
    };
  }
  throw new Error(`${modulePath} 的公共 Schema 只允许静态属性与 spread。`);
}

/** 归一化函数参数槽位和表达式函数体。 */
function normalizeFunctionLike(workspace, modulePath, expression, stack, outerParameters) {
  const parameters = new Map(outerParameters);
  const parameterBase = parameters.size === 0
    ? 0
    : Math.max(...parameters.values()) + 1;
  expression.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      throw new Error(`${modulePath} 的公共 Schema 回调只允许标识符参数。`);
    }
    parameters.set(parameter.name.text, parameterBase + index);
  });
  if (ts.isBlock(expression.body)) {
    throw new Error(`${modulePath} 的公共 Schema 回调必须使用表达式函数体。`);
  }
  return {
    async: hasModifier(expression, ts.SyntaxKind.AsyncKeyword),
    body: normalizeExpression(workspace, modulePath, expression.body, stack, parameters),
    generator: expression.asteriskToken !== undefined,
    kind: "function",
    parameterCount: expression.parameters.length,
    parameters: expression.parameters.map((parameter) => ({
      defaultValue: parameter.initializer === undefined
        ? null
        : normalizeExpression(
            workspace,
            modulePath,
            parameter.initializer,
            stack,
            parameters,
          ),
      optional: parameter.questionToken !== undefined,
      rest: parameter.dotDotDotToken !== undefined,
    })),
  };
}

/** 将 const 绑定解析为最终对象字面量。 */
function resolveObjectLiteral(workspace, binding, stack) {
  const key = bindingKey(binding);
  if (stack.has(key)) {
    throw new Error(`静态对象绑定包含循环：${key}。`);
  }
  stack.add(key);
  let expression = binding.kind === "variable" ? binding.declaration.initializer : undefined;
  expression = expression === undefined ? undefined : unwrapExpression(expression);
  if (expression && (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression))) {
    const target = resolveExpressionBinding(workspace, binding.modulePath, expression);
    if (target === null || target.kind !== "variable") {
      throw new Error(`${key} 必须引用静态 const 对象。`);
    }
    const resolved = resolveObjectLiteral(workspace, target, stack);
    stack.delete(key);
    return resolved;
  }
  stack.delete(key);
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    throw new Error(`${key} 必须是静态对象字面量。`);
  }
  return { modulePath: binding.modulePath, object: expression };
}

/** 把静态字符串字面量或常量别名解析为最终值。 */
function evaluateStringExpression(workspace, modulePath, rawExpression, stack) {
  const expression = unwrapExpression(rawExpression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) {
    return null;
  }
  const binding = resolveExpressionBinding(workspace, modulePath, expression);
  if (binding === null || binding.kind !== "variable" || binding.declaration.initializer === undefined) {
    return null;
  }
  const key = bindingKey(binding);
  if (stack.has(key)) {
    throw new Error(`静态字符串别名包含循环：${key}。`);
  }
  stack.add(key);
  const value = evaluateStringExpression(
    workspace,
    binding.modulePath,
    binding.declaration.initializer,
    stack,
  );
  stack.delete(key);
  return value;
}

/** 判断命令注册值最终是否解析为函数声明、箭头函数或函数表达式。 */
function isCallableExpression(workspace, modulePath, rawExpression, stack) {
  if (ts.isMethodDeclaration(rawExpression)) {
    return hasMeaningfulFunctionBody(rawExpression);
  }
  const expression = unwrapExpression(rawExpression);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return hasMeaningfulFunctionBody(expression);
  }
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) {
    return false;
  }
  const binding = resolveExpressionBinding(workspace, modulePath, expression);
  if (binding === null) {
    return false;
  }
  if (binding.kind === "function") {
    return hasMeaningfulFunctionBody(binding.declaration);
  }
  const key = bindingKey(binding);
  if (stack.has(key) || binding.declaration.initializer === undefined) {
    return false;
  }
  stack.add(key);
  const callable = isCallableExpression(
    workspace,
    binding.modulePath,
    binding.declaration.initializer,
    stack,
  );
  stack.delete(key);
  return callable;
}

/** 拒绝空 block、裸 undefined 与只返回 undefined 的公共命令 handler。 */
function hasMeaningfulFunctionBody(expression) {
  const body = expression.body;
  if (body === undefined) {
    return false;
  }
  if (!ts.isBlock(body)) {
    const value = unwrapExpression(body);
    return !(
      (ts.isIdentifier(value) && value.text === "undefined") ||
      value.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(value)
    );
  }
  return body.statements.some(statementHasRuntimeEffect);
}

/** 只接受可证明会调用、赋值、抛错或返回有效值的 handler 语句。 */
function statementHasRuntimeEffect(statement) {
  if (ts.isEmptyStatement(statement)) {
    return false;
  }
  if (ts.isThrowStatement(statement)) {
    return true;
  }
  if (ts.isReturnStatement(statement)) {
    const value = statement.expression === undefined
      ? undefined
      : unwrapExpression(statement.expression);
    return !(
      value === undefined ||
      (ts.isIdentifier(value) && value.text === "undefined") ||
      value.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(value)
    );
  }
  if (ts.isExpressionStatement(statement)) {
    return expressionHasRuntimeEffect(statement.expression);
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(
      (declaration) =>
        declaration.initializer !== undefined &&
        expressionHasRuntimeEffect(declaration.initializer),
    );
  }
  if (ts.isBlock(statement)) {
    return statement.statements.some(statementHasRuntimeEffect);
  }
  if (ts.isIfStatement(statement)) {
    return (
      statementHasRuntimeEffect(statement.thenStatement) ||
      (statement.elseStatement !== undefined && statementHasRuntimeEffect(statement.elseStatement))
    );
  }
  if (
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement)
  ) {
    return statementHasRuntimeEffect(statement.statement);
  }
  if (ts.isTryStatement(statement)) {
    return (
      statement.tryBlock.statements.some(statementHasRuntimeEffect) ||
      statement.catchClause?.block.statements.some(statementHasRuntimeEffect) === true ||
      statement.finallyBlock?.statements.some(statementHasRuntimeEffect) === true
    );
  }
  return false;
}

/** 识别执行期副作用表达式，拒绝字符串/数字/标识符等纯求值占位。 */
function expressionHasRuntimeEffect(rawExpression) {
  const expression = unwrapExpression(rawExpression);
  if (
    ts.isCallExpression(expression) ||
    ts.isNewExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isYieldExpression(expression) ||
    ts.isDeleteExpression(expression) ||
    ts.isPostfixUnaryExpression(expression)
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
      expression.operator,
    );
  }
  if (ts.isBinaryExpression(expression)) {
    return expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionHasRuntimeEffect(expression.whenTrue) ||
      expressionHasRuntimeEffect(expression.whenFalse)
    );
  }
  return false;
}

/** 拒绝公共对象经属性赋值、别名或标准 mutator 在声明后改变运行时表面。 */
function assertBindingRuntimeStable(workspace, binding, label) {
  const targetKey = resolveBindingOriginKey(workspace, binding, new Set());
  const cacheKey = `${label}:${targetKey}`;
  if (workspace.runtimeStabilityCache.has(cacheKey)) {
    return;
  }
  for (const [modulePath, sourceFile] of workspace.sourceFiles) {
    let mutated = false;
    const visit = (node) => {
      if (mutated) {
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind) &&
        expressionTargetsBinding(workspace, modulePath, node.left, targetKey)
      ) {
        mutated = true;
        return;
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        expressionTargetsBinding(workspace, modulePath, node.operand, targetKey)
      ) {
        mutated = true;
        return;
      }
      if (
        ts.isDeleteExpression(node) &&
        expressionTargetsBinding(workspace, modulePath, node.expression, targetKey)
      ) {
        mutated = true;
        return;
      }
      if (
        ts.isCallExpression(node) &&
        callEscapesOrMutatesBinding(workspace, modulePath, node, targetKey)
      ) {
        mutated = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (mutated) {
      throw new Error(`${label} 禁止声明后的 mutation、别名写入或运行时修改：${modulePath}。`);
    }
  }
  workspace.runtimeStabilityCache.add(cacheKey);
}

/** 未批准的函数参数逃逸、receiver 调用与标准 mutator 都可能修改公共对象。 */
function callEscapesOrMutatesBinding(workspace, modulePath, call, targetKey) {
  if (
    (ts.isPropertyAccessExpression(call.expression) ||
      ts.isElementAccessExpression(call.expression)) &&
    expressionTargetsBinding(workspace, modulePath, call.expression.expression, targetKey)
  ) {
    return true;
  }
  const targetArgumentIndexes = [];
  call.arguments.forEach((argument, index) => {
    if (expressionTargetsBinding(workspace, modulePath, argument, targetKey)) {
      targetArgumentIndexes.push(index);
    }
  });
  if (targetArgumentIndexes.length === 0) {
    return false;
  }
  if (
    isKnownObjectMutator(call.expression) &&
    targetArgumentIndexes.includes(0)
  ) {
    return true;
  }
  return !isApprovedSchemaConsumerCall(workspace, modulePath, call, targetArgumentIndexes);
}

/** 仅允许真实 Ajv2020 实例的 compile 只读消费 Schema，其他未知调用均拒绝。 */
function isApprovedSchemaConsumerCall(workspace, modulePath, call, targetArgumentIndexes) {
  if (
    targetArgumentIndexes.length !== 1 ||
    targetArgumentIndexes[0] !== 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "compile" ||
    !ts.isIdentifier(call.expression.expression)
  ) {
    return false;
  }
  const receiverName = call.expression.expression.text;
  const receiver = resolveLocalBinding(workspace, modulePath, receiverName);
  if (
    receiver?.kind !== "variable" ||
    receiver.modulePath !== modulePath ||
    receiver.declaration.initializer === undefined
  ) {
    return false;
  }
  const initializer = unwrapExpression(receiver.declaration.initializer);
  if (
    !ts.isNewExpression(initializer) ||
    !ts.isIdentifier(initializer.expression)
  ) {
    return false;
  }
  return hasNamedImport(
    workspace.sourceFiles.get(modulePath),
    "ajv/dist/2020.js",
    "Ajv2020",
    initializer.expression.text,
  );
}

/** 验证模块从固定 specifier 导入指定值并绑定到预期本地名称。 */
function hasNamedImport(sourceFile, specifier, importedName, localName) {
  if (sourceFile === undefined) {
    return false;
  }
  return sourceFile.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text === specifier &&
      statement.importClause?.isTypeOnly !== true &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) =>
          !element.isTypeOnly &&
          (element.propertyName?.text ?? element.name.text) === importedName &&
          element.name.text === localName,
      ),
  );
}

/** 判断表达式最终指向目标绑定本身或其任意属性。 */
function expressionTargetsBinding(workspace, modulePath, rawExpression, targetKey) {
  const expression = unwrapExpression(rawExpression);
  let directBinding = null;
  try {
    directBinding = resolveExpressionBinding(workspace, modulePath, expression);
  } catch (error) {
    if (!(error instanceof Error && /禁止依赖外部模块/u.test(error.message))) {
      throw error;
    }
  }
  if (
    directBinding !== null &&
    resolveBindingOriginKey(workspace, directBinding, new Set()) === targetKey
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return expressionTargetsBinding(workspace, modulePath, expression.expression, targetKey);
  }
  return false;
}

/** 跟随 const/import 别名，得到公共对象的最终声明身份。 */
function resolveBindingOriginKey(workspace, binding, stack) {
  const key = bindingKey(binding);
  if (stack.has(key) || binding.kind !== "variable") {
    return key;
  }
  const initializer = binding.declaration.initializer;
  if (initializer === undefined) {
    return key;
  }
  const expression = unwrapExpression(initializer);
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) {
    return key;
  }
  const target = resolveExpressionBinding(workspace, binding.modulePath, expression);
  if (target === null || bindingKey(target) === key) {
    return key;
  }
  stack.add(key);
  const targetKey = resolveBindingOriginKey(workspace, target, stack);
  stack.delete(key);
  return targetKey;
}

/** 识别会修改首个对象参数的标准运行时 API。 */
function isKnownObjectMutator(expression) {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !ts.isIdentifier(expression.expression)
  ) {
    return false;
  }
  const methodsByOwner = {
    Object: new Set(["assign", "defineProperties", "defineProperty", "setPrototypeOf"]),
    Reflect: new Set(["defineProperty", "deleteProperty", "set", "setPrototypeOf"]),
  };
  return methodsByOwner[expression.expression.text]?.has(expression.name.text) === true;
}

/** 判断 token 是否会写入二元表达式左值。 */
function isAssignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** 从表达式解析直接标识符绑定。 */
function resolveExpressionBinding(workspace, modulePath, rawExpression) {
  const expression = unwrapExpression(rawExpression);
  if (ts.isIdentifier(expression)) {
    return resolveLocalBinding(workspace, modulePath, expression.text);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const targetModulePath = resolveNamespaceImport(
      workspace,
      modulePath,
      expression.expression.text,
    );
    return targetModulePath === null
      ? null
      : collectModuleExports(workspace, targetModulePath).get(expression.name.text) ?? null;
  }
  return null;
}

/** 移除不改变运行时值的 TypeScript 包装节点。 */
function unwrapExpression(rawExpression) {
  let expression = rawExpression;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

/** 读取静态对象属性名。 */
function propertyNameText(name) {
  if (name === undefined) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/** 判断声明是否具有 export modifier。 */
function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

/** 判断节点是否具有指定 modifier。 */
function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/** 添加唯一导出；同名不同绑定视为歧义并 fail closed。 */
function addExport(exported, name, binding) {
  const existing = exported.get(name);
  if (existing !== undefined && bindingKey(existing) !== bindingKey(binding)) {
    throw new Error(`公共导出 '${name}' 存在歧义来源。`);
  }
  exported.set(name, binding);
}

/** 生成绑定的稳定模块内身份。 */
function bindingKey(binding) {
  if (binding.kind === "namespace") {
    return `${binding.modulePath}#namespace`;
  }
  const name = binding.declaration.name?.text ?? "anonymous";
  return `${binding.modulePath}#${name}`;
}

/** 解析 Gate Registry；bootstrap 基线缺失时返回空 gates。 */
function parseRegistry(source, allowMissing) {
  if (source === undefined) {
    if (allowMissing) {
      return { gates: [], schemaVersion: 1 };
    }
    throw new Error(`${gateRegistryPath} 缺失。`);
  }
  const registry = parse(source, { maxAliasCount: 0, uniqueKeys: true });
  if (!Array.isArray(registry?.gates)) {
    throw new Error(`${gateRegistryPath} 缺少 gates。`);
  }
  return registry;
}

/** 收集基线 gateId；候选只能通过真正新增 gate 满足 AC4。 */
function collectGateIds(source, allowMissing) {
  return new Set(
    parseRegistry(source, allowMissing).gates.map(
      ({ gateDefinition }) => gateDefinition?.gateId,
    ),
  );
}

/** 解析并限制公共 package manifest 为普通 JSON 对象。 */
function parseJsonObject(source, relativePath) {
  if (source === undefined) {
    throw new Error(`${relativePath} 缺失。`);
  }
  const value = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${relativePath} 必须是 JSON 对象。`);
  }
  return value;
}

/** 验证 JSON 对象精确字段集合。 */
function assertClosedObject(value, expectedKeys, relativePath) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${relativePath} 必须是封闭对象。`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (!sameOrderedStrings(actualKeys, sortedExpected)) {
    throw new Error(`${relativePath} 必须是封闭对象，字段必须为 ${sortedExpected.join(", ")}。`);
  }
}

/** 兼容测试输入的 Set，并统一为 capability→fingerprint Map。 */
function normalizeCapabilitySurface(surface) {
  return surface instanceof Map
    ? surface
    : new Map([...surface].map((capabilityId) => [capabilityId, capabilityId]));
}

/** 判断字符串数组是否严格升序且唯一。 */
function isStrictlySortedUnique(values) {
  return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) < 0);
}

/** 比较两个已排序数组。 */
function sameOrderedStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 比较两个字符串集合，不允许遗漏或额外公共注册项。 */
function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/** 创建稳定、可执行的公共能力门禁诊断。 */
function publicCapabilityViolation(message, suggestion) {
  return {
    message,
    relativePath: capabilityBindingsPath,
    rule: "public-capability-gate",
    suggestion,
  };
}
