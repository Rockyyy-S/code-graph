import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  sha256CanonicalJson,
} from "../../packages/contracts/runtime/canonical-json.mjs";

export const QUALITY_GATE_REGISTRY_PATH = "ci/quality-gates.v1.yaml";

const capabilityOwners = new Set([
  "architecture",
  "architecture-po",
  "dev-enablement",
  "qa",
  "security",
]);
const stableIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const producerPattern =
  /^gha-oidc:\/\/([1-9][0-9]*)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/\.github\/workflows\/([A-Za-z0-9_.-]+\.ya?ml)@([a-f0-9]{40})#([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u;
const forbiddenExecutables = new Set(["echo", "printf", "true"]);

/** 从唯一固定路径加载 GateRegistryV1，并返回旁路 registry digest。 */
export async function loadQualityGateRegistry(repositoryRoot) {
  const registryPath = path.join(
    repositoryRoot,
    ...QUALITY_GATE_REGISTRY_PATH.split("/"),
  );
  const source = await readFile(registryPath, "utf8");
  let registry;
  try {
    registry = parse(source, {
      maxAliasCount: 0,
      prettyErrors: false,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new Error(
      `${QUALITY_GATE_REGISTRY_PATH}: YAML 解析失败。Fix: 修复语法且不要使用 alias。`,
      { cause: error },
    );
  }
  validateQualityGateRegistry(registry);
  return {
    gateRegistryDigest: sha256CanonicalJson(registry),
    registry,
    registryPath: QUALITY_GATE_REGISTRY_PATH,
  };
}

/** 验证 GateRegistryV1 的封闭形状、顺序、唯一性、命令与摘要链。 */
export function validateQualityGateRegistry(value) {
  assertClosedObject(value, ["gates", "schemaVersion"], "GateRegistryV1");
  if (value.schemaVersion !== 1 || !Array.isArray(value.gates) || value.gates.length === 0) {
    throw new Error("GateRegistryV1.gates 必须是非空数组且 schemaVersion=1。");
  }
  let previousGateId = "";
  const checkIds = new Set();
  for (const entry of value.gates) {
    assertClosedObject(
      entry,
      ["gateDefinition", "gateDefinitionDigest"],
      "GateRegistryEntryV1",
    );
    validateGateDefinition(entry.gateDefinition);
    if (!digestPattern.test(entry.gateDefinitionDigest)) {
      throw new Error(`gate ${entry.gateDefinition.gateId} 的 definition digest 格式非法。`);
    }
    if (entry.gateDefinitionDigest !== sha256CanonicalJson(entry.gateDefinition)) {
      throw new Error(`gate ${entry.gateDefinition.gateId} 的 definition digest 漂移。`);
    }
    if (entry.gateDefinition.gateId <= previousGateId) {
      throw new Error("Gate Registry gates 必须按 gateId 严格升序且 ID 唯一。");
    }
    if (checkIds.has(entry.gateDefinition.checkId)) {
      throw new Error(`Gate Registry checkId '${entry.gateDefinition.checkId}' 重复。`);
    }
    checkIds.add(entry.gateDefinition.checkId);
    previousGateId = entry.gateDefinition.gateId;
  }
  return value;
}

/** 验证 GateDefinitionV1 的必填字段、producer 绑定和 argv 安全约束。 */
function validateGateDefinition(value) {
  const allowedKeys = [
    "blocking",
    "capabilityOwner",
    "checkId",
    "command",
    "evidenceProducerId",
    "gateId",
  ];
  if (Object.hasOwn(value ?? {}, "triggerPaths")) {
    allowedKeys.push("triggerPaths");
  }
  assertClosedObject(value, allowedKeys, "GateDefinitionV1");
  if (
    typeof value.blocking !== "boolean" ||
    !capabilityOwners.has(value.capabilityOwner) ||
    !stableIdPattern.test(value.checkId) ||
    !stableIdPattern.test(value.gateId) ||
    !Array.isArray(value.command) ||
    value.command.length === 0 ||
    value.command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.trim().length === 0 ||
        argument.includes("\0"),
    )
  ) {
    throw new Error(`gate ${value.gateId ?? "unknown"} 的字段或 argv command 非法。`);
  }
  const producerMatch = producerPattern.exec(value.evidenceProducerId);
  if (producerMatch === null || producerMatch[6] !== value.gateId) {
    throw new Error(`gate ${value.gateId} 的 evidenceProducerId 未绑定自身 gateId。`);
  }
  if (isNoOpCommand(value.command)) {
    throw new Error(`gate ${value.gateId} 使用 no-op 或内联恒成功命令。`);
  }
  if (Object.hasOwn(value, "triggerPaths")) {
    if (!Array.isArray(value.triggerPaths) || value.triggerPaths.length === 0) {
      throw new Error(`gate ${value.gateId} 的 triggerPaths 必须是非空数组。`);
    }
    value.triggerPaths.forEach((triggerPath, index) => {
      if (
        typeof triggerPath !== "string" ||
        !isCanonicalTriggerGlob(triggerPath) ||
        (index > 0 && value.triggerPaths[index - 1] >= triggerPath)
      ) {
        throw new Error(`gate ${value.gateId} 的 triggerPaths 非法、重复或未排序。`);
      }
    });
  }
}

/** 拒绝显然恒成功、仅输出文本或通过内联代码规避 checked-in 实现的命令。 */
function isNoOpCommand(command) {
  const executable = path.basename(command[0]).toLowerCase().replace(/\.exe$/u, "");
  if (forbiddenExecutables.has(executable)) {
    return true;
  }
  if (executable === "node") {
    return command.slice(1).some((argument) => ["-e", "--eval", "-p", "--print"].includes(argument));
  }
  return false;
}

/** trigger glob 必须是仓库内相对 POSIX path，且不含反选或平台语义。 */
function isCanonicalTriggerGlob(value) {
  if (
    value.length === 0 ||
    value.startsWith("!") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("//") ||
    value.endsWith("/") ||
    /[\[\]{}]/u.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** 验证普通对象精确包含允许字段，避免未知配置静默生效。 */
function assertClosedObject(value, allowedKeys, label) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} 必须是普通对象。`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 包含缺失或未知字段。`);
  }
}
