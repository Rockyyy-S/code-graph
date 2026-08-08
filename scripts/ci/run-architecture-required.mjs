import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  sha256CanonicalJson,
  sha256Hex,
} from "../../packages/contracts/runtime/canonical-json.mjs";
import {
  createGateEvidenceV1,
  createGateOutputV1,
} from "./create-gate-evidence.mjs";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";
import { runProcessWithDeadline } from "./run-process-with-deadline.mjs";
import { createPnpmInvocation } from "../quality/resolve-pnpm-invocation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loadedRegistry = await loadQualityGateRegistry(repositoryRoot);
const outputLimitBytes = 1024 * 1024;
const runnerDiagnosticFileName = "runner-diagnostic.json";
const gateEvidenceFileName = "gate-evidence.json";
const diagnosticWriteFailureMarker =
  "@@ARCHITECTURE_RUNNER_DIAGNOSTIC_WRITE_FAILED_V1@@";
/** 真实 contract gate 包含 Worker 冷启动与 SQLite 锁竞争，三分钟覆盖并行 Windows CI 的已测上界。 */
export const ARCHITECTURE_GATE_TIMEOUT_MS = 3 * 60 * 1000;
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
  const outputRoot = resolveOutputRoot(options.outputRoot);
  const diagnosticEnabled =
    options.outputRoot !== undefined || options.writeArtifacts !== false;
  const diagnosticContext = {
    currentGateId: null,
    gateRegistryDigest: null,
    invocationId: randomUUID(),
    outputRoot,
    phase: "diagnostic-initialization",
  };
  try {
    if (diagnosticEnabled) {
      await initializeArtifactPublication(outputRoot);
    }

    diagnosticContext.phase = "registry-load";
    const runtimeLoadedRegistry =
      options.loadRegistry === undefined
        ? loadedRegistry
        : await options.loadRegistry(repositoryRoot);
    const registry = options.registry ?? runtimeLoadedRegistry.registry;
    const gateRegistryDigest =
      registry === runtimeLoadedRegistry.registry &&
      typeof runtimeLoadedRegistry.gateRegistryDigest === "string"
        ? runtimeLoadedRegistry.gateRegistryDigest
        : registry === loadedRegistry.registry
          ? loadedRegistry.gateRegistryDigest
          : sha256CanonicalJson(registry);
    diagnosticContext.gateRegistryDigest = gateRegistryDigest;
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
      diagnosticContext.currentGateId = definition.gateId;
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
      diagnosticContext.phase = "gate-execution";
      const execution =
        remainingMs <= 0
          ? createTotalDeadlineExecution()
          : execute === undefined
            ? await executeRegistryGate(definition.gateId, definition.command, {
                timeoutMs: Math.min(
                  options.gateTimeoutMs ?? ARCHITECTURE_GATE_TIMEOUT_MS,
                  remainingMs,
                ),
              })
            : await execute(definition.gateId, definition.command);
      diagnosticContext.phase = "gate-output-contract";
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
        diagnosticContext.phase = "gate-evidence-contract";
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
    diagnosticContext.currentGateId = null;
    diagnosticContext.phase = "result-construction";
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
      .filter(
        ({ gateId, status }) => status === "invalid" && blockingGateIds.has(gateId),
      )
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
      diagnosticContext.phase = "artifact-publication";
      const publishArtifacts = options.publishArtifacts ?? writeArtifactSet;
      await publishArtifacts(outputRoot, result);
    }
    diagnosticContext.phase = "complete";
    return result;
  } catch (error) {
    if (diagnosticEnabled) {
      try {
        await publishRunnerDiagnostic(diagnosticContext, error);
      } catch (publicationError) {
        emitDiagnosticWriteFailureMarker(
          diagnosticContext,
          error,
          publicationError,
        );
      }
    }
    throw error;
  }
}

/** 将显式或默认 outputRoot 解析为当前 invocation 的唯一绝对发布根。 */
function resolveOutputRoot(outputRoot) {
  return path.resolve(
    outputRoot ?? path.join(repositoryRoot, "artifacts", "architecture-required"),
  );
}

/** 启动新 invocation 时清除可冒充本轮结果的旧 diagnostic 与完整 evidence。 */
async function initializeArtifactPublication(outputRoot) {
  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    rm(path.join(outputRoot, runnerDiagnosticFileName), { force: true }),
    rm(path.join(outputRoot, gateEvidenceFileName), { force: true }),
  ]);
}

/** 将 unexpected exception 以独立、原子、可归因的结构化 artifact 发布。 */
async function publishRunnerDiagnostic(context, error) {
  const errorSummary = summarizeError(error);
  const stackSource =
    error instanceof Error && typeof error.stack === "string"
      ? error.stack
      : `${errorSummary.name}: ${errorSummary.message}`;
  const diagnostic = {
    artifactOutput: describeOutputRoot(context.outputRoot),
    currentGateId: context.currentGateId,
    error: {
      ...errorSummary,
      stackSha256: sha256Hex(Buffer.from(stackSource, "utf8")),
    },
    gateRegistryDigest: context.gateRegistryDigest,
    invocationId: context.invocationId,
    phase: context.phase,
    process: {
      packageManagerExecutable: safeBasename(process.env.npm_execpath),
      runtimeExecutable: safeBasename(process.execPath),
    },
    recordedAt: new Date().toISOString(),
    schema: "runner-diagnostic",
    schemaVersion: 2,
  };
  const targetPath = path.join(context.outputRoot, runnerDiagnosticFileName);
  const temporaryPath = path.join(
    context.outputRoot,
    `.runner-diagnostic.${context.invocationId}.tmp`,
  );
  await mkdir(context.outputRoot, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(diagnostic)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, targetPath);
  } catch (publicationError) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw publicationError;
  }
}

/** 将 Error/cause 收敛为有界、无循环且已净化绝对路径的稳定摘要。 */
function summarizeError(error, state = { depth: 0, seen: new Set() }) {
  if (state.depth >= 4) {
    return { cause: null, code: null, message: "[cause-depth-limit]", name: "Error" };
  }
  if (typeof error === "object" && error !== null) {
    if (state.seen.has(error)) {
      return { cause: null, code: null, message: "[cause-cycle]", name: "Error" };
    }
    state.seen.add(error);
  }
  if (error instanceof Error) {
    return {
      cause: error.cause === undefined
        ? null
        : summarizeError(error.cause, { depth: state.depth + 1, seen: state.seen }),
      code: normalizeErrorCode(error.code),
      message: sanitizeDiagnosticText(error.message),
      name: sanitizeDiagnosticText(error.name),
    };
  }
  return {
    cause: null,
    code: null,
    message: sanitizeDiagnosticText(String(error)),
    name: "NonErrorThrown",
  };
}

/** error.code 只接受可稳定字符串化的标量。 */
function normalizeErrorCode(code) {
  const normalized = typeof code === "string" || typeof code === "number" ? String(code) : null;
  return normalized !== null && /^[a-z0-9_.-]{1,64}$/iu.test(normalized)
    ? normalized
    : null;
}

/** diagnostic 自身无法写入时向真实 stderr 发布稳定 fail-closed marker。 */
function emitDiagnosticWriteFailureMarker(context, originalError, publicationError) {
  const marker = {
    artifactOutput: describeOutputRoot(context.outputRoot),
    currentGateId: context.currentGateId,
    originalError: summarizeError(originalError),
    phase: context.phase,
    publicationError: summarizeError(publicationError),
    schemaVersion: 2,
  };
  try {
    process.stderr.write(
      `${diagnosticWriteFailureMarker} ${JSON.stringify(marker)}\n`,
    );
  } catch {
    // stderr 本身不可写时仍重新抛出原异常，禁止 marker 失败改变 library 终态。
  }
}

/**
 * 净化用户可见 diagnostic 文本中的 Windows、UNC、POSIX 与 file URL 绝对路径。
 *
 * @param {unknown} value 任意错误文本。
 * @returns {string} 仅保留稳定占位符的文本。
 */
export function sanitizeDiagnosticText(value) {
  let text = String(value);
  const placeholder = "[absolute-path]";
  text = text.replace(/\bfile:\/\/\/?[^\s"'<>]+/giu, placeholder);
  text = text.replace(/(?<![a-z0-9_])[a-z]:[\\/][^\s"'<>|]+/giu, placeholder);
  text = text.replace(/(?<![:a-z0-9_])(?:\\\\|\/\/)[^\\/\s"'<>|]+[\\/][^\s"'<>|]+/giu, placeholder);
  text = text.replace(
    /(^|[\s([{=,:;])\/(?:[^/\s"'<>|]+\/)*[^/\s"'<>|]+/gu,
    (_match, prefix) => `${prefix}${placeholder}`,
  );
  return text;
}

/** 对外部发布根只暴露枚举与稳定摘要；仓库内发布根仅暴露相对路径。 */
function describeOutputRoot(outputRoot) {
  const relative = path.relative(repositoryRoot, outputRoot);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)) {
    return {
      kind: "repository-relative",
      path: relative.replaceAll(path.sep, "/"),
    };
  }
  if (relative === "") {
    return { kind: "repository-relative", path: "." };
  }
  return {
    kind: "external",
    pathSha256: sha256Hex(Buffer.from(path.resolve(outputRoot), "utf8")),
  };
}

/** 进程字段只发布 basename，禁止泄露 cache/interpreter 的完整入口路径。 */
function safeBasename(value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  return sanitizeDiagnosticText(segments.at(-1) ?? "unknown");
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
    timeoutMs: options.timeoutMs ?? ARCHITECTURE_GATE_TIMEOUT_MS,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments === true,
  });
}

/** 将 registry 的 node/pnpm 名称解析为当前平台仍保持 shell:false 的真实 argv。 */
function resolveLocalCommand(executable, args) {
  if (executable === "node") {
    return { args, executable: process.execPath };
  }
  if (executable === "pnpm") {
    return createPnpmInvocation(process.env.npm_execpath, args);
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
  const targetPath = path.join(root, gateEvidenceFileName);
  const temporaryPath = path.join(root, `.gate-evidence.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(serializable)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
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
    console.error(
      error instanceof Error
        ? sanitizeDiagnosticText(error.message)
        : "architecture-required 未知错误。",
    );
    process.exitCode = 1;
  }
}
