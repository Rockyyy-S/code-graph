import path from "node:path";
import { TextDecoder } from "node:util";
import {
  sha256CanonicalJson,
} from "../../packages/contracts/runtime/canonical-json.mjs";
import { validateQualityGateRegistry } from "./load-quality-gates.mjs";
import { runProcessWithDeadline } from "./run-process-with-deadline.mjs";

const defaultGitTimeoutMs = 30_000;

/** 校验 objectFormat 对应的完整小写 Git OID。 */
export function validateFullGitOid(oid, objectFormat) {
  const expectedLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  return (
    expectedLength > 0 &&
    typeof oid === "string" &&
    oid.length === expectedLength &&
    /^[a-f0-9]+$/u.test(oid)
  );
}

/** 对 merge-base --all 完整结果排序并选择字典序最小 OID。 */
export function selectComparisonBaseOid(mergeBases, objectFormat) {
  if (!Array.isArray(mergeBases) || mergeBases.length === 0) {
    throw new Error("git merge-base --all 结果为空，评估上下文 invalid。");
  }
  if (mergeBases.some((oid) => !validateFullGitOid(oid, objectFormat))) {
    throw new Error("git merge-base --all 返回非法或非完整 OID。");
  }
  return [...mergeBases].sort()[0];
}

/** 解析 git diff --name-status -z --no-renames 的 NUL token。 */
export function parseNameStatusZ(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  if (bytes.length > 0 && bytes.at(-1) !== 0) {
    throw new Error("git name-status NUL 输出缺少结尾分隔符。");
  }
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("git name-status 包含非法 UTF-8 路径字节。", { cause: error });
  }
  const tokens = decoded.split("\0");
  if (tokens.at(-1) === "") {
    tokens.pop();
  }
  if (tokens.length % 2 !== 0) {
    throw new Error("git name-status NUL 输出缺少 status/path 配对。");
  }
  const entries = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index];
    const relativePath = tokens[index + 1];
    if (!/^[ADMTCUXB]$/u.test(status)) {
      throw new Error(`git name-status 返回未知状态 ${status ?? "missing"}。`);
    }
    if (!isSafeRelativePosixPath(relativePath)) {
      throw new Error("git name-status 返回绝对、逃逸或平台相关路径。");
    }
    entries.push({ path: relativePath, status });
  }
  return entries;
}

/** 根据 registry 与 affected paths 计算 required/not-applicable/invalid。 */
export function evaluateRegistryApplicability(registry, affectedPaths, requestedGateIds) {
  try {
    validateQualityGateRegistry(registry);
  } catch (error) {
    throw new Error("registry 无效，无法计算 gate applicability。", { cause: error });
  }
  if (!Array.isArray(affectedPaths) || affectedPaths.some((entry) => !isSafeRelativePosixPath(entry))) {
    throw new Error("affected paths 包含非法仓库路径。");
  }
  const definitions = new Map(
    registry.gates.map(({ gateDefinition }) => [gateDefinition.gateId, gateDefinition]),
  );
  const gateIds = requestedGateIds ?? [...definitions.keys()];
  return gateIds.map((gateId) => {
    const definition = definitions.get(gateId);
    if (definition === undefined) {
      return { gateId, status: "invalid" };
    }
    if (!Object.hasOwn(definition, "triggerPaths")) {
      return { gateId, status: "required" };
    }
    const required = definition.triggerPaths.some((triggerPath) => {
      const expression = globToRegExp(triggerPath);
      return affectedPaths.some((relativePath) => expression.test(relativePath));
    });
    return { gateId, status: required ? "required" : "not-applicable" };
  });
}

/** 使用 provider-authenticated identity 构造可生成 Hosted evidence 的完整上下文。 */
export async function createProviderGateEvaluation(repositoryRoot, input) {
  if (!/^[1-9][0-9]*$/u.test(input.providerRepositoryId ?? "")) {
    throw new Error("providerRepositoryId 必须来自 provider event 且为正整数 identity。\n");
  }
  const common = await evaluateFixedGitContext(repositoryRoot, input);
  const contextWithoutDigest = {
    baseOid: input.baseOid,
    comparisonBaseOid: common.comparisonBaseOid,
    gateRegistryDigest: input.gateRegistryDigest,
    headOid: input.headOid,
    objectFormat: input.objectFormat,
    providerRepositoryId: input.providerRepositoryId,
    schemaVersion: 1,
  };
  return {
    ...common,
    contextKind: "provider-event",
    evaluationContext: {
      ...contextWithoutDigest,
      evaluationContextDigest: sha256CanonicalJson(contextWithoutDigest),
    },
    hostedEvidenceEligible: true,
  };
}

/**
 * 使用显式 fixture OID 运行本地 Git 评估。
 *
 * 结果明确标记为 local-fixture 且不可生成 Hosted evidence，避免伪造 provider identity。
 */
export async function createLocalGateFixtureEvaluation(repositoryRoot, input) {
  const common = await evaluateFixedGitContext(repositoryRoot, input);
  return {
    ...common,
    contextKind: "local-fixture",
    gateRegistryDigest: input.gateRegistryDigest,
    hostedEvidenceEligible: false,
  };
}

/** 固定 OID、验证 registry digest，并读取 merge-base/NUL diff。 */
async function evaluateFixedGitContext(repositoryRoot, input) {
  if (
    !["sha1", "sha256"].includes(input.objectFormat) ||
    !validateFullGitOid(input.baseOid, input.objectFormat) ||
    !validateFullGitOid(input.headOid, input.objectFormat)
  ) {
    throw new Error("provider/local fixture 的 objectFormat 或完整 base/head OID 无效。\n");
  }
  validateQualityGateRegistry(input.registry);
  const actualRegistryDigest = sha256CanonicalJson(input.registry);
  if (input.gateRegistryDigest !== actualRegistryDigest) {
    throw new Error("gateRegistryDigest 与 registry 内容不匹配。\n");
  }
  const repositoryObjectFormat = (
    await runGit(repositoryRoot, ["rev-parse", "--show-object-format"], input.gitTimeoutMs)
  )
    .toString("utf8")
    .trim();
  if (repositoryObjectFormat !== input.objectFormat) {
    throw new Error("Git repository objectFormat 与评估输入不匹配。\n");
  }
  const mergeBaseOutput = await runGit(repositoryRoot, [
    "merge-base",
    "--all",
    input.baseOid,
    input.headOid,
  ], input.gitTimeoutMs);
  const mergeBases = mergeBaseOutput
    .toString("utf8")
    .split(/\r?\n/u)
    .filter(Boolean);
  const comparisonBaseOid = selectComparisonBaseOid(mergeBases, input.objectFormat);
  const diffOutput = await runGit(repositoryRoot, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    comparisonBaseOid,
    input.headOid,
  ], input.gitTimeoutMs);
  const affectedPaths = [
    ...new Set(parseNameStatusZ(diffOutput).map(({ path: relativePath }) => relativePath)),
  ].sort();
  return {
    affectedPaths,
    applicability: evaluateRegistryApplicability(input.registry, affectedPaths),
    comparisonBaseOid,
  };
}

/** 将已校验的受限 POSIX glob 编译为整路径正则。 */
function globToRegExp(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    const next = glob[index + 1];
    if (character === "*" && next === "*") {
      if (glob[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`, "u");
}

/** 路径只能是无 NUL、无反斜杠、无逃逸段的仓库相对 POSIX path。 */
function isSafeRelativePosixPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** 以 shell:false 执行固定 Git argv，并保留原始 stdout 字节。 */
async function runGit(repositoryRoot, args, timeoutMs = defaultGitTimeoutMs) {
  const result = await runProcessWithDeadline({
    args: ["-C", repositoryRoot, ...args],
    cleanupProcessTreeOnExit: false,
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    executable: "git",
    timeoutMs,
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`git ${args[0]} 输出超过受控上限，评估上下文 invalid。`);
  }
  if (result.status !== "pass") {
    throw new Error(
      `git ${args[0]} 失败（termination=${JSON.stringify(result.termination)}）：${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}
