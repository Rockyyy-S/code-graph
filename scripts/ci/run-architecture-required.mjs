import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  createGateEvidenceV1,
  createGateOutputV1,
} from "./create-gate-evidence.mjs";
import { createProviderGateEvaluation } from "./evaluate-gate-applicability.mjs";
import { loadQualityGateRegistry } from "./load-quality-gates.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const loadedRegistry = await loadQualityGateRegistry(repositoryRoot);
const outputLimitBytes = 1024 * 1024;

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
  const execute = options.execute ?? executeRegistryGate;
  const providerEvaluation = options.providerEvaluation;
  const applicability = new Map(
    providerEvaluation?.applicability?.map((entry) => [entry.gateId, entry.status]) ??
      registry.gates.map(({ gateDefinition }) => [gateDefinition.gateId, "required"]),
  );
  const gates = [];
  const evidence = [];
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
    const execution = await execute(definition.gateId, definition.command);
    const output = createGateOutputV1({
      gateId: definition.gateId,
      stderr: execution.stderr,
      stderrTruncated: execution.stderrTruncated,
      stdout: execution.stdout,
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
  const requiredGateIds = [...applicability]
    .filter(([, status]) => status === "required")
    .map(([gateId]) => gateId);
  const evidenceGateIds = new Set(evidence.map((entry) => entry.gateId));
  const missingEvidenceGateIds =
    providerEvaluation === undefined
      ? []
      : requiredGateIds.filter((gateId) => !evidenceGateIds.has(gateId));
  const failedGateIds = gates
    .filter(({ status }) => status === "fail")
    .map(({ gateId }) => gateId);
  const invalidGateIds = gates
    .filter(({ status }) => status === "invalid")
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
    gateRegistryDigest: loadedRegistry.gateRegistryDigest,
    gates,
    summary,
  };
  if (options.writeArtifacts !== false) {
    await writeArtifactSet(options.outputRoot, result);
  }
  return result;
}

/** 以 shell:false 执行 registry argv，并捕获最多 1 MiB 的原始 stdout/stderr。 */
async function executeRegistryGate(_gateId, registryCommand) {
  const [registryExecutable, ...registryArgs] = registryCommand;
  const resolved = resolveLocalCommand(registryExecutable, registryArgs);
  return new Promise((resolve) => {
    const stdout = createBoundedCollector();
    const stderr = createBoundedCollector();
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let child;
    try {
      child = spawn(resolved.executable, resolved.args, {
        cwd: repositoryRoot,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(spawnErrorResult(error, stdout, stderr));
      return;
    }
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => finish(spawnErrorResult(error, stdout, stderr)));
    child.once("close", (code, signal) =>
      finish({
        status: code === 0 ? "pass" : "fail",
        stderr: stderr.bytes(),
        stderrTruncated: stderr.truncated(),
        stdout: stdout.bytes(),
        stdoutTruncated: stdout.truncated(),
        termination:
          signal === null
            ? { code: code ?? 1, kind: "exit" }
            : { kind: "signal", signalName: signal },
      }),
    );
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

/** 创建 spawn-error 的稳定 invalid 结果，不记录本机异常路径或堆栈。 */
function spawnErrorResult(error, stdout, stderr) {
  return {
    status: "invalid",
    stderr: stderr.bytes(),
    stderrTruncated: stderr.truncated(),
    stdout: stdout.bytes(),
    stdoutTruncated: stdout.truncated(),
    termination: {
      kind: "spawn-error",
      stableCode:
        typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : "UNKNOWN",
    },
  };
}

/** 创建记录总流量但只保留固定上限原始字节的 collector。 */
function createBoundedCollector() {
  const chunks = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  return {
    append(chunk) {
      const buffer = Buffer.from(chunk);
      totalBytes += buffer.length;
      const remaining = outputLimitBytes - capturedBytes;
      if (remaining > 0) {
        const captured = buffer.subarray(0, remaining);
        chunks.push(captured);
        capturedBytes += captured.length;
      }
    },
    bytes: () => Buffer.concat(chunks),
    truncated: () => totalBytes > capturedBytes,
  };
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

/** 读取可选 provider event fixture；无参数时明确运行 local context。 */
async function loadProviderEvaluation(argv) {
  if (argv.length === 0) {
    return undefined;
  }
  if (argv.length !== 2 || argv[0] !== "--provider-context") {
    throw new Error("仅支持 --provider-context <trusted-event-json>，本地默认明确标记为 local。\n");
  }
  const providerInput = JSON.parse(await readFile(path.resolve(argv[1]), "utf8"));
  return createProviderGateEvaluation(repositoryRoot, {
    ...providerInput,
    gateRegistryDigest: loadedRegistry.gateRegistryDigest,
    registry: loadedRegistry.registry,
  });
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
