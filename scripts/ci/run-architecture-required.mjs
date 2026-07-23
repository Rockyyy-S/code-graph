import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sha256CanonicalJson } from "../../packages/contracts/runtime/canonical-json.mjs";
import {
  createGateEvidenceV1,
  createGateOutputV1,
} from "./create-gate-evidence.mjs";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";
import { runProcessWithDeadline } from "./run-process-with-deadline.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loadedRegistry = await loadQualityGateRegistry(repositoryRoot);
const outputLimitBytes = 1024 * 1024;
const defaultGateTimeoutMs = 2 * 60 * 1000;
const defaultTotalTimeoutMs = 20 * 60 * 1000;

/** @type {string[]} */
export const QUALITY_GATES = loadedRegistry.registry.gates.map(
  ({ gateDefinition }) => gateDefinition.gateId,
);

/**
 * 从唯一 registry 运行全部 required gate，收集 GateOutput/GateEvidence 并最终 fail closed。
 *
 * 注入 execute 仅用于隔离负向测试；生产路径始终使用 shell:false 的真实子进程。
 */
export async function runArchitectureRequired(options = {}) {
  const registry = options.registry ?? loadedRegistry.registry;
  const gateRegistryDigest =
    registry === loadedRegistry.registry
      ? loadedRegistry.gateRegistryDigest
      : sha256CanonicalJson(registry);
  const execute = options.execute;
  const providerEvaluation = options.providerEvaluation;
  if (
    providerEvaluation !== undefined &&
    (providerEvaluation.hostedEvidenceEligible !== true ||
      providerEvaluation.evaluationContext?.gateRegistryDigest !== gateRegistryDigest)
  ) {
    throw new Error("provider evidence 只能由绑定当前 registry 的外部可信 Harness 注入。\n");
  }
  const applicability = new Map(
    providerEvaluation?.applicability?.map((entry) => [entry.gateId, entry.status]) ??
      registry.gates.map(({ gateDefinition }) => [gateDefinition.gateId, "required"]),
  );
  const gates = [];
  const evidence = [];
  const totalDeadlineAt =
    Date.now() + (options.totalTimeoutMs ?? defaultTotalTimeoutMs);
  for (const entry of registry.gates) {
    const definition = entry.gateDefinition;
    const applicabilityStatus = applicability.get(definition.gateId) ?? "invalid";
    if (applicabilityStatus === "not-applicable") {
      gates.push({ gateId: definition.gateId, status: "not-applicable" });
      continue;
    }
    if (applicabilityStatus !== "required") {
      gates.push({ gateId: definition.gateId, status: "invalid" });
      continue;
    }
    const remainingMs = totalDeadlineAt - Date.now();
    const execution =
      remainingMs <= 0
        ? createTotalDeadlineExecution()
        : execute === undefined
          ? await executeRegistryGate(definition.gateId, definition.command, {
              timeoutMs: Math.min(
                options.gateTimeoutMs ?? defaultGateTimeoutMs,
                remainingMs,
              ),
            })
          : await execute(definition.gateId, definition.command);
    const output = createGateOutputV1({
      gateId: definition.gateId,
      stderr: execution.stderr,
      stderrBytes: execution.stderrBytes,
      stderrTruncated: execution.stderrTruncated,
      stdout: execution.stdout,
      stdoutBytes: execution.stdoutBytes,
      stdoutTruncated: execution.stdoutTruncated,
      termination: execution.termination,
    });
    let gateEvidence;
    if (
      providerEvaluation !== undefined &&
      options.suppressEvidenceForGate !== definition.gateId
    ) {
      gateEvidence = createGateEvidenceV1({
        definition,
        evaluationContextDigest:
          providerEvaluation.evaluationContext.evaluationContextDigest,
        gateDefinitionDigest: entry.gateDefinitionDigest,
        headOid: providerEvaluation.evaluationContext.headOid,
        output,
        status: execution.status,
      });
      evidence.push(gateEvidence);
    }
    gates.push({
      ...(gateEvidence === undefined ? {} : { evidence: gateEvidence }),
      gateId: definition.gateId,
      output,
      status: execution.status,
      stderr: execution.stderr,
      stdout: execution.stdout,
    });
  }
  const requiredGateIds = registry.gates
    .filter(
      ({ gateDefinition }) =>
        gateDefinition.blocking &&
        applicability.get(gateDefinition.gateId) === "required",
    )
    .map(({ gateDefinition }) => gateDefinition.gateId);
  const blockingGateIds = new Set(
    registry.gates
      .filter(({ gateDefinition }) => gateDefinition.blocking)
      .map(({ gateDefinition }) => gateDefinition.gateId),
  );
  const evidenceGateIds = new Set(evidence.map((entry) => entry.gateId));
  const missingEvidenceGateIds =
    providerEvaluation === undefined
      ? []
      : requiredGateIds.filter((gateId) => !evidenceGateIds.has(gateId));
  const failedGateIds = gates
    .filter(({ gateId, status }) => status === "fail" && blockingGateIds.has(gateId))
    .map(({ gateId }) => gateId);
  const invalidGateIds = gates
    .filter(({ gateId, status }) => status === "invalid" && blockingGateIds.has(gateId))
    .map(({ gateId }) => gateId);
  const summary = {
    failedGateIds,
    invalidGateIds,
    missingEvidenceGateIds,
    passedGateIds: gates
      .filter(({ status }) => status === "pass")
      .map(({ gateId }) => gateId),
  };
  const result = {
    contextKind: providerEvaluation === undefined ? "local" : "provider-event",
    evidence,
    exitCode:
      failedGateIds.length === 0 &&
      invalidGateIds.length === 0 &&
      missingEvidenceGateIds.length === 0
        ? 0
        : 1,
    gateRegistryDigest,
    gates,
    summary,
  };
  if (options.writeArtifacts !== false) {
    await writeArtifactSet(options.outputRoot, result);
  }
  return result;
}

/** 总 deadline 耗尽后让剩余 gate 稳定 invalid，并继续生成完整诊断 artifact。 */
function createTotalDeadlineExecution() {
  return {
    status: "invalid",
    stderr: Buffer.alloc(0),
    stderrBytes: 0,
    stderrTruncated: false,
    stdout: Buffer.alloc(0),
    stdoutBytes: 0,
    stdoutTruncated: false,
    termination: { kind: "spawn-error", stableCode: "ETIMEDOUT" },
  };
}

/** 以 shell:false 执行 registry argv，并捕获最多 1 MiB 的原始 stdout/stderr。 */
export async function executeRegistryGate(_gateId, registryCommand, options = {}) {
  const [registryExecutable, ...registryArgs] = registryCommand;
  const resolved = resolveLocalCommand(registryExecutable, registryArgs);
  return runProcessWithDeadline({
    args: resolved.args,
    cwd: repositoryRoot,
    env: process.env,
    executable: resolved.executable,
    killGraceMs: options.killGraceMs,
    outputLimitBytes,
    timeoutMs: options.timeoutMs ?? defaultGateTimeoutMs,
  });
}

/** 将 registry 的 node/pnpm 名称解析为当前平台仍保持 shell:false 的真实 argv。 */
function resolveLocalCommand(executable, args) {
  if (executable === "node") {
    return { args, executable: process.execPath };
  }
  if (executable === "pnpm" && process.env.npm_execpath) {
    return {
      args: [process.env.npm_execpath, ...args],
      executable: process.execPath,
    };
  }
  return { args, executable };
}

/** 将原始日志作为旁路文件写入，结构化 evidence 不嵌入日志文本。 */
async function writeArtifactSet(outputRoot, result) {
  const root = outputRoot ?? path.join(repositoryRoot, "artifacts", "architecture-required");
  await mkdir(root, { recursive: true });
  for (const gate of result.gates) {
    if (gate.stdout !== undefined) {
      await writeFile(path.join(root, `${gate.gateId}.stdout.log`), gate.stdout);
      await writeFile(path.join(root, `${gate.gateId}.stderr.log`), gate.stderr);
    }
  }
  const serializable = {
    ...result,
    gates: result.gates.map(({ stderr: _stderr, stdout: _stdout, ...gate }) => gate),
  };
  await writeFile(
    path.join(root, "gate-evidence.json"),
    `${JSON.stringify(serializable)}\n`,
    "utf8",
  );
}

/** CLI 只允许明确的本地执行，Hosted provider evidence 由仓库外 Harness 独占。 */
export async function loadProviderEvaluation(argv) {
  if (argv.length === 0) {
    return undefined;
  }
  throw new Error("CLI 禁止注入 provider context；Hosted evidence 只能由外部可信 Harness 生成。\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runArchitectureRequired({
      providerEvaluation: await loadProviderEvaluation(process.argv.slice(2)),
    });
    for (const gate of result.gates) {
      console.log(`${gate.gateId}: ${gate.status}`);
    }
    if (result.exitCode !== 0) {
      console.error(
        `architecture-required fail closed: ${JSON.stringify(result.summary)}`,
      );
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "architecture-required 未知错误。");
    process.exitCode = 1;
  }
}
