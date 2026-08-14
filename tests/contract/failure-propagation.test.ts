import { describe, expect, it, vi } from "vitest";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARCHITECTURE_GATE_TIMEOUT_MS,
  executeRegistryGate,
  loadProviderEvaluation,
  QUALITY_GATES,
  runArchitectureRequired,
  sanitizeDiagnosticText,
} from "../../scripts/ci/run-architecture-required.mjs";
import { DEFAULT_PROCESS_CLEANUP_GRACE_MS } from "../../scripts/ci/run-process-with-deadline.mjs";
import { loadQualityGateRegistry } from "../../scripts/ci/load-quality-gates.mjs";
import { sha256CanonicalJson } from "../../packages/contracts/src/canonical-json.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const loadedRegistry = await loadQualityGateRegistry(repositoryRoot);

/** 创建用于 runner 注入的稳定执行结果。 */
function executionResult(status: "fail" | "invalid" | "pass") {
  return {
    status,
    stderr: Buffer.alloc(0),
    stderrTruncated: false,
    stdout: Buffer.from(status),
    stdoutTruncated: false,
    termination:
      status === "invalid"
        ? { kind: "spawn-error" as const, stableCode: "ENOENT" }
        : { code: status === "pass" ? 0 : 23, kind: "exit" as const },
  };
}

/** 读取并解析 runner 结构化诊断，保持测试只依赖公开文件合同。 */
async function readRunnerDiagnostic(outputRoot: string): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(outputRoot, "runner-diagnostic.json"), "utf8"),
  ) as unknown;
}

/** 断言本轮没有 unexpected runner diagnostic，防止旧 artifact 冒充当前结果。 */
async function expectRunnerDiagnosticAbsent(outputRoot: string): Promise<void> {
  await expect(
    access(path.join(outputRoot, "runner-diagnostic.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
}

describe("architecture-required failure propagation", () => {
  it("为真实合同 gate 和 Windows 进程树清理保留已验证预算", () => {
    expect(ARCHITECTURE_GATE_TIMEOUT_MS).toBe(3 * 60 * 1000);
    expect(DEFAULT_PROCESS_CLEANUP_GRACE_MS).toBe(
      process.platform === "win32" ? 10_000 : 2_000,
    );
  });

  for (const failingGate of QUALITY_GATES) {
    it(`executes every gate and returns non-zero when ${failingGate} fails`, async () => {
      const execute = vi.fn(async (gateId: string) =>
        executionResult(gateId === failingGate ? "fail" : "pass"),
      );

      const result = await runArchitectureRequired({ execute, writeArtifacts: false });

      expect(result.exitCode).toBe(1);
      expect(execute).toHaveBeenCalledTimes(QUALITY_GATES.length);
      expect(result.gates.map(({ gateId }) => gateId)).toEqual(QUALITY_GATES);
      expect(result.gates.find(({ gateId }) => gateId === failingGate)?.status).toBe(
        "fail",
      );
    });
  }

  it("returns zero only when every required gate passes", async () => {
    const execute = vi.fn(async () => executionResult("pass"));

    const result = await runArchitectureRequired({ execute, writeArtifacts: false });

    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledTimes(QUALITY_GATES.length);
  });

  it("treats invalid execution and missing provider evidence as fail-closed", async () => {
    const execute = vi.fn(async (gateId: string) =>
      executionResult(gateId === QUALITY_GATES[0] ? "invalid" : "pass"),
    );

    const result = await runArchitectureRequired({
      execute,
      providerEvaluation: {
        applicability: QUALITY_GATES.map((gateId) => ({ gateId, status: "required" })),
        evaluationContext: {
          evaluationContextDigest: "a".repeat(64),
          gateRegistryDigest: loadedRegistry.gateRegistryDigest,
          headOid: "b".repeat(40),
        },
        hostedEvidenceEligible: true,
      },
      suppressEvidenceForGate: QUALITY_GATES.at(-1),
      writeArtifacts: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.summary.invalidGateIds).toContain(QUALITY_GATES[0]);
    expect(result.summary.missingEvidenceGateIds).toEqual([QUALITY_GATES.at(-1)]);
  });

  it("non-blocking gate 失败不会阻断聚合结论", async () => {
    const registry = structuredClone(loadedRegistry.registry);
    registry.gates[0]!.gateDefinition.blocking = false;
    const nonBlockingGateId = registry.gates[0]!.gateDefinition.gateId;
    const execute = vi.fn(async (gateId: string) =>
      executionResult(gateId === nonBlockingGateId ? "fail" : "pass"),
    );

    const result = await runArchitectureRequired({
      execute,
      registry,
      writeArtifacts: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.failedGateIds).toEqual([]);
    expect(result.gates.find(({ gateId }) => gateId === nonBlockingGateId)?.status).toBe(
      "fail",
    );
  });

  it("注入 registry 时报告实际执行 registry 的摘要", async () => {
    const registry = structuredClone(loadedRegistry.registry);
    registry.gates[0]!.gateDefinition.capabilityOwner =
      registry.gates[0]!.gateDefinition.capabilityOwner === "qa" ? "security" : "qa";

    const result = await runArchitectureRequired({
      execute: async () => executionResult("pass"),
      registry,
      writeArtifacts: false,
    });

    expect(result.gateRegistryDigest).toBe(sha256CanonicalJson(registry));
    expect(result.gateRegistryDigest).not.toBe(loadedRegistry.gateRegistryDigest);
  });

  it("CLI 拒绝本地 provider context 注入", async () => {
    await expect(
      loadProviderEvaluation(["--provider-context", "fixture.json"]),
    ).rejects.toThrow(/禁止注入 provider context/u);
  });

  it("总 deadline 耗尽后不再启动 gate，并为剩余项生成稳定 invalid", async () => {
    const execute = vi.fn(async () => executionResult("pass"));

    const result = await runArchitectureRequired({
      execute,
      totalTimeoutMs: -1,
      writeArtifacts: false,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.summary.invalidGateIds).toEqual(QUALITY_GATES);
    expect(result.gates.every(({ status }) => status === "invalid")).toBe(true);
  });

  it("execute 提前抛错时发布独立 diagnostic，且不保留伪造完整 evidence", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "architecture-runner-execute-throw-"),
    );
    const injectedError = Object.assign(new Error("execute fixture exploded"), {
      cause: new Error("fixture cause"),
      code: "EEXECUTE_FIXTURE",
    });
    try {
      await writeFile(path.join(outputRoot, "gate-evidence.json"), "{}\n", "utf8");

      await expect(
        runArchitectureRequired({
          execute: async () => {
            throw injectedError;
          },
          outputRoot,
        }),
      ).rejects.toBe(injectedError);

      expect(await readRunnerDiagnostic(outputRoot)).toEqual({
        artifactOutput: {
          kind: "external",
          pathSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        currentGateId: QUALITY_GATES[0],
        error: {
          cause: {
            cause: null,
            code: null,
            message: "fixture cause",
            name: "Error",
          },
          code: "EEXECUTE_FIXTURE",
          message: "execute fixture exploded",
          name: "Error",
          stackSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        gateRegistryDigest: loadedRegistry.gateRegistryDigest,
        invocationId: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
        ),
        phase: "gate-execution",
        process: {
          packageManagerExecutable: process.env.npm_execpath === undefined
            ? null
            : process.env.npm_execpath.replaceAll("\\", "/").split("/").at(-1),
          runtimeExecutable: process.execPath.replaceAll("\\", "/").split("/").at(-1),
        },
        recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        schema: "runner-diagnostic",
        schemaVersion: 2,
      });
      await expect(
        access(path.join(outputRoot, "gate-evidence.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("artifact publication 抛错时发布 diagnostic 并保持 library rejection", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "architecture-runner-artifact-throw-"),
    );
    const injectedError = Object.assign(new Error("artifact fixture exploded"), {
      code: "EARTIFACT_FIXTURE",
    });
    const publishArtifacts = vi.fn(async () => {
      throw injectedError;
    });
    try {
      await expect(
        runArchitectureRequired({
          execute: async () => executionResult("pass"),
          outputRoot,
          publishArtifacts,
        }),
      ).rejects.toBe(injectedError);

      expect(publishArtifacts).toHaveBeenCalledTimes(1);
      expect(await readRunnerDiagnostic(outputRoot)).toMatchObject({
        currentGateId: null,
        error: {
          cause: null,
          code: "EARTIFACT_FIXTURE",
          message: "artifact fixture exploded",
          name: "Error",
        },
        gateRegistryDigest: loadedRegistry.gateRegistryDigest,
        phase: "artifact-publication",
        schema: "runner-diagnostic",
        schemaVersion: 2,
      });
      await expect(
        access(path.join(outputRoot, "gate-evidence.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["Windows drive", "failed at C:\\repo\\cache\\tool.exe"],
    ["UNC", "failed at \\\\server\\share\\cache\\tool.exe"],
    ["POSIX", "failed at /home/user/cache/tool.mjs"],
    ["quoted POSIX", "failed at '/g/2/cache/tool.mjs'"],
    ["file URL", "failed at file:///C:/repo/cache/tool.mjs"],
    ["mixed separators", "failed at D:\\repo/cache\\tool.mjs"],
  ] as const)("sanitizes %s absolute path text", (_label, message) => {
    const sanitized = sanitizeDiagnosticText(message);

    expect(sanitized).toContain("[absolute-path]");
    expect(sanitized).not.toContain("repo");
    expect(sanitized).not.toContain("cache");
    expect(sanitized).not.toContain("tool.mjs");
    expect(sanitized).not.toContain("tool.exe");
  });

  it("sanitizes nested causes before publishing runner diagnostic", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "architecture-runner-private-cause-"),
    );
    const deepest = new Error("file:///C:/repo/cache/deep.mjs");
    const nested = Object.assign(new Error("\\\\server\\share\\nested\\tool.exe"), {
      cause: deepest,
    });
    const injectedError = Object.assign(new Error("/home/user/repository/top.mjs"), {
      cause: nested,
      code: "EPRIVATE_FIXTURE",
    });
    try {
      await expect(
        runArchitectureRequired({
          execute: async () => {
            throw injectedError;
          },
          outputRoot,
        }),
      ).rejects.toBe(injectedError);

      const diagnosticText = JSON.stringify(await readRunnerDiagnostic(outputRoot));
      expect(diagnosticText.match(/\[absolute-path\]/gu)?.length).toBeGreaterThanOrEqual(3);
      // basename 是允许发布的稳定元数据；仅把带目录的启动命令视为敏感路径。
      const packageManagerPath = process.env.npm_execpath;
      for (const leaked of [
        "C:/repo/cache/deep.mjs",
        "server\\share\\nested",
        "/home/user/repository/top.mjs",
        path.resolve(outputRoot),
        process.execPath,
        packageManagerPath?.includes("/") || packageManagerPath?.includes("\\")
          ? packageManagerPath
          : undefined,
      ]) {
        if (leaked !== undefined) {
          expect(diagnosticText).not.toContain(leaked);
        }
      }
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("sanitizes diagnostic write-failure marker without publishing outputRoot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "architecture-runner-marker-"));
    const blockedOutputRoot = path.join(root, "blocked-output-root");
    await writeFile(blockedOutputRoot, "not-a-directory", "utf8");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runArchitectureRequired({ outputRoot: blockedOutputRoot })).rejects.toThrow();

      const marker = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(marker).toContain("@@ARCHITECTURE_RUNNER_DIAGNOSTIC_WRITE_FAILED_V1@@");
      expect(marker).toContain("\"schemaVersion\":2");
      expect(marker).toContain("[absolute-path]");
      expect(marker).not.toContain(path.resolve(blockedOutputRoot));
      expect(marker).not.toContain(root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("普通 gate exit 1 仍发布完整 result evidence，且不误报 unexpected exception", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "architecture-runner-normal-failure-"),
    );
    const failingGateId = QUALITY_GATES[0]!;
    try {
      const result = await runArchitectureRequired({
        execute: async (gateId: string) =>
          executionResult(gateId === failingGateId ? "fail" : "pass"),
        outputRoot,
      });
      const artifact = JSON.parse(
        await readFile(path.join(outputRoot, "gate-evidence.json"), "utf8"),
      ) as {
        exitCode: number;
        gateRegistryDigest: string;
        gates: Array<{ gateId: string; output: unknown; status: string }>;
        summary: { failedGateIds: string[] };
      };

      expect(result.exitCode).toBe(1);
      expect(result.summary.failedGateIds).toEqual([failingGateId]);
      expect(artifact.exitCode).toBe(1);
      expect(artifact.gateRegistryDigest).toBe(loadedRegistry.gateRegistryDigest);
      expect(artifact.summary.failedGateIds).toEqual([failingGateId]);
      expect(artifact.gates).toHaveLength(QUALITY_GATES.length);
      expect(artifact.gates.every(({ output }) => output !== undefined)).toBe(true);
      await expectRunnerDiagnosticAbsent(outputRoot);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("正常成功会清除旧 diagnostic，并仅发布本次完整 evidence", async () => {
    const outputRoot = await mkdtemp(
      path.join(tmpdir(), "architecture-runner-success-"),
    );
    try {
      await writeFile(
        path.join(outputRoot, "runner-diagnostic.json"),
        '{"schema":"stale"}\n',
        "utf8",
      );

      const result = await runArchitectureRequired({
        execute: async () => executionResult("pass"),
        outputRoot,
      });
      const artifact = JSON.parse(
        await readFile(path.join(outputRoot, "gate-evidence.json"), "utf8"),
      ) as { exitCode: number; gates: unknown[] };

      expect(result.exitCode).toBe(0);
      expect(artifact.exitCode).toBe(0);
      expect(artifact.gates).toHaveLength(QUALITY_GATES.length);
      await expectRunnerDiagnosticAbsent(outputRoot);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("以绝对 deadline 终止挂起 gate 并返回稳定 invalid", async () => {
    const result = await executeRegistryGate(
      "hanging-gate",
      [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
      {
        // 50ms 仍是 gate 执行 deadline；树清理使用平台默认的独立有界宽限。
        killGraceMs: DEFAULT_PROCESS_CLEANUP_GRACE_MS,
        timeoutMs: 50,
      },
    );

    expect(result.status).toBe("invalid");
    expect(result.termination).toEqual({
      kind: "spawn-error",
      stableCode: "ETIMEDOUT",
    });
  });
});
