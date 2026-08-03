/** @file graph-service 的唯一组合根与可测试启动 API。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createErrorV1, sha256CanonicalJson } from "@codegraph/contracts";
import { openSqliteGraphStore } from "@codegraph/adapter-store-sqlite";
import { createTypeScriptAnalyzer } from "@codegraph/adapter-analyzer-typescript";
import {
  bootstrapServiceInstance,
  GraphServiceStartupError,
  type OwnedServiceInstance,
} from "./instance-owner.js";
import { createBoundIpcEndpoint } from "./server.js";
import { createSafeLocalLogger, type SafeLocalLogger } from "./safe-log.js";
import type { ServiceInstancePaths } from "./instance-owner.js";
import { createInitialIgnoreState } from "./ignore-bootstrap.js";
import { createVerifiedIndexJobRuntime } from "./index-job-runtime.js";
import {
  createDefaultHostPathIdentitySnapshotProvider,
  HostPathIdentityBroker,
  MAX_HOST_PATH_BATCH_BYTES,
  MAX_HOST_PATH_CANDIDATES,
  WINDOWS_HOST_IDENTITY_SNAPSHOT_SCRIPT,
  type HostPathIdentitySnapshotProvider,
  type HostPathSnapshotCaptureV1,
} from "./host-path-identity.js";
import { isFileSystemCaseSensitive } from "./workspace-scanner.js";

const STARTUP_LOGGER_CLOSE_TIMEOUT_MS = 250;
const WIN32_HOST_IDENTITY_CAPTURE_TIMEOUT_MS = 30_000;
const WIN32_HOST_IDENTITY_CLOSE_TIMEOUT_MS = 200;
const WIN32_HOST_IDENTITY_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const WIN32_HOST_IDENTITY_INPUT_LIMIT_BYTES = MAX_HOST_PATH_BATCH_BYTES + (64 * 1024);
const WIN32_HOST_IDENTITY_MAX_PENDING_REQUESTS = 8;

type Win32HostPathIdentityCaptureRequest = Parameters<
  HostPathIdentitySnapshotProvider["capture"]
>[0];

/** 持久 Win32 helper 的最小可观测状态，不暴露路径、nonce 或对象身份。 */
export interface ServiceScopedWin32HostPathIdentityHelperDiagnostics {
  pendingRequests: number;
  processRunning: boolean;
  processStarts: number;
}

/** 持久 Win32 helper 的 service-instance 生命周期端口。 */
export interface ServiceScopedWin32HostPathIdentityHelper {
  capture: HostPathIdentitySnapshotProvider["capture"];
  close(): Promise<void>;
  readDiagnostics(): ServiceScopedWin32HostPathIdentityHelperDiagnostics;
}

/** 仅允许测试替换进程启动边界；生产始终使用固定 PowerShell argv。 */
export interface CreateServiceScopedWin32HostPathIdentityHelperOptions {
  spawnProcess?: (scriptPath: string) => ChildProcessWithoutNullStreams;
}

interface PendingWin32HostPathIdentityCapture {
  frame: Buffer;
  reject: (error: Error) => void;
  request: Win32HostPathIdentityCaptureRequest;
  requestId: string;
  resolve: (capture: HostPathSnapshotCaptureV1) => void;
  timeout: NodeJS.Timeout | null;
}

interface Win32HostPathIdentityProcessState {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  invalidated: boolean;
  rejectClosed: (error: Error) => void;
  resolveClosed: () => void;
  root: string;
}

/**
 * 创建 service-instance 级持久 helper。
 *
 * PowerShell 与 Add-Type 只冷启动一次；每个请求仍在脚本函数内重建句柄集合，
 * Node 侧以单在途请求、固定队列、固定帧上限和 requestId 严格串行化协议。
 */
export function createServiceScopedWin32HostPathIdentityHelper(
  options: CreateServiceScopedWin32HostPathIdentityHelperOptions = {},
): ServiceScopedWin32HostPathIdentityHelper {
  const controller = new PersistentWin32HostPathIdentityHelperController(
    options.spawnProcess ?? spawnWin32HostPathIdentityProcess,
  );
  return {
    capture: (request) => controller.capture(request),
    close: () => controller.close(),
    readDiagnostics: () => controller.readDiagnostics(),
  };
}

/** 持久 helper 的有界串行控制器；任何进程或协议异常都会淘汰当前实例。 */
class PersistentWin32HostPathIdentityHelperController {
  readonly #spawnProcess: (scriptPath: string) => ChildProcessWithoutNullStreams;
  readonly #queue: PendingWin32HostPathIdentityCapture[] = [];
  #active: PendingWin32HostPathIdentityCapture | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #draining = false;
  #process: Win32HostPathIdentityProcessState | null = null;
  #processStarts = 0;
  #starting: Promise<Win32HostPathIdentityProcessState> | null = null;
  #stderrBytes = 0;
  #stdoutBuffer = Buffer.alloc(0);

  public constructor(
    spawnProcess: (scriptPath: string) => ChildProcessWithoutNullStreams,
  ) {
    this.#spawnProcess = spawnProcess;
  }

  /** 将请求放入固定容量队列；每个请求只允许一个完整响应帧。 */
  public capture(
    request: Win32HostPathIdentityCaptureRequest,
  ): Promise<HostPathSnapshotCaptureV1> {
    if (this.#closed) {
      return Promise.reject(createWin32HelperError(
        "Windows host identity helper is closed",
        "HOST_PATH_IDENTITY_HELPER_CLOSED",
      ));
    }
    if (this.#queue.length + (this.#active === null ? 0 : 1) >=
      WIN32_HOST_IDENTITY_MAX_PENDING_REQUESTS) {
      return Promise.reject(createWin32HelperError(
        "Windows host identity helper queue is full",
        "HOST_PATH_CAPTURE_QUEUE_LIMIT",
      ));
    }
    const requestId = randomUUID();
    const frame = Buffer.from(`${JSON.stringify({
      request: {
        candidates: request.candidates,
        captureNonce: request.captureNonce,
        indexingRoot: request.indexingRoot,
      },
      requestId,
    })}\n`, "utf8");
    if (frame.length > WIN32_HOST_IDENTITY_INPUT_LIMIT_BYTES) {
      return Promise.reject(createWin32HelperError(
        "Windows host identity request exceeds the bounded frame",
        "HOST_PATH_CAPTURE_INPUT_LIMIT",
      ));
    }
    return new Promise<HostPathSnapshotCaptureV1>((resolve, reject) => {
      this.#queue.push({
        frame,
        reject,
        request,
        requestId,
        resolve,
        timeout: null,
      });
      void this.#drainQueue();
    });
  }

  /** 返回不含宿主身份材料的诊断计数，供合同证明 helper 未重复冷启动。 */
  public readDiagnostics(): ServiceScopedWin32HostPathIdentityHelperDiagnostics {
    return {
      pendingRequests: this.#queue.length + (this.#active === null ? 0 : 1),
      processRunning: this.#process !== null && !this.#process.invalidated,
      processStarts: this.#processStarts,
    };
  }

  /** 幂等关闭 helper，并在固定 200ms 内等待进程句柄与自有临时根收敛。 */
  public close(): Promise<void> {
    if (this.#closePromise === null) {
      this.#closed = true;
      this.#closePromise = waitForWin32HelperWithinLimit(
        this.#shutdown(),
        WIN32_HOST_IDENTITY_CLOSE_TIMEOUT_MS,
        "HOST_PATH_HELPER_CLOSE_TIMEOUT",
      );
    }
    return this.#closePromise;
  }

  /** 只有收到响应或淘汰当前进程后才会派发下一项。 */
  async #drainQueue(): Promise<void> {
    if (this.#draining || this.#active !== null || this.#closed) {
      return;
    }
    this.#draining = true;
    try {
      while (!this.#closed && this.#active === null && this.#queue.length > 0) {
        const pending = this.#queue.shift();
        if (pending === undefined) {
          return;
        }
        this.#active = pending;
        let state: Win32HostPathIdentityProcessState;
        try {
          state = await this.#ensureStarted();
        } catch (error) {
          this.#active = null;
          pending.reject(normalizeWin32HelperError(error));
          continue;
        }
        if (this.#closed || state.invalidated || this.#process !== state) {
          this.#active = null;
          pending.reject(createWin32HelperError(
            "Windows host identity helper became unavailable before dispatch",
            "HOST_PATH_CAPTURE_PROCESS_FAILED",
          ));
          continue;
        }
        this.#stdoutBuffer = Buffer.alloc(0);
        this.#stderrBytes = 0;
        pending.timeout = setTimeout(() => {
          if (this.#active?.requestId === pending.requestId) {
            this.#invalidateProcess(state, createWin32HelperError(
              "Windows host identity capture timeout",
              "HOST_PATH_CAPTURE_TIMEOUT",
            ));
          }
        }, WIN32_HOST_IDENTITY_CAPTURE_TIMEOUT_MS);
        state.child.stdin.write(pending.frame, (error) => {
          if (error !== null && error !== undefined) {
            this.#invalidateProcess(state, createWin32HelperError(
              error.message,
              "HOST_PATH_CAPTURE_PROCESS_FAILED",
            ));
          }
        });
        return;
      }
    } finally {
      this.#draining = false;
    }
  }

  /** 首次请求创建进程；淘汰后的后续请求可以创建全新 helper。 */
  async #ensureStarted(): Promise<Win32HostPathIdentityProcessState> {
    if (this.#process !== null) {
      if (!this.#process.invalidated) {
        return this.#process;
      }
      await this.#process.closed;
      if (this.#closed) {
        throw createWin32HelperError(
          "Windows host identity helper closed before rebuild",
          "HOST_PATH_IDENTITY_HELPER_CLOSED",
        );
      }
      return this.#ensureStarted();
    }
    if (this.#starting !== null) {
      return this.#starting;
    }
    this.#starting = this.#startProcess().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** 写入固定语义的持久包装脚本并绑定 stdout/stderr/exit 生命周期。 */
  async #startProcess(): Promise<Win32HostPathIdentityProcessState> {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-host-identity-"));
    const scriptPath = path.join(root, "helper.ps1");
    try {
      await writeFile(scriptPath, createPersistentWin32HostPathIdentityScript(), {
        encoding: "utf8",
        flag: "wx",
      });
      if (this.#closed) {
        throw createWin32HelperError(
          "Windows host identity helper closed during startup",
          "HOST_PATH_IDENTITY_HELPER_CLOSED",
        );
      }
      const child = this.#spawnProcess(scriptPath);
      let resolveClosed: () => void = () => undefined;
      let rejectClosed: (error: Error) => void = () => undefined;
      const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
      });
      void closed.catch(() => undefined);
      const state: Win32HostPathIdentityProcessState = {
        child,
        closed,
        invalidated: false,
        rejectClosed,
        resolveClosed,
        root,
      };
      this.#process = state;
      this.#processStarts += 1;
      child.stdout.on("data", (chunk: Buffer) => this.#acceptStdout(state, chunk));
      child.stderr.on("data", (chunk: Buffer) => this.#acceptStderr(state, chunk));
      child.once("error", (error) => {
        this.#invalidateProcess(state, createWin32HelperError(
          error.message,
          "HOST_PATH_CAPTURE_PROCESS_FAILED",
        ));
      });
      child.once("close", (code) => {
        void this.#settleClosedProcess(state, code);
      });
      return state;
    } catch (error) {
      await rm(root, { force: true, recursive: true });
      throw error;
    }
  }

  /** stdout 仅接受与当前 requestId 绑定的一条 LF 终止 JSON。 */
  #acceptStdout(state: Win32HostPathIdentityProcessState, chunk: Buffer): void {
    if (this.#process !== state || state.invalidated || this.#active === null) {
      this.#invalidateProcess(state, createWin32HelperError(
        "Windows host identity helper emitted an unsolicited response",
        "HOST_PATH_CAPTURE_PROTOCOL_INVALID",
      ));
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.length > WIN32_HOST_IDENTITY_OUTPUT_LIMIT_BYTES) {
      this.#invalidateProcess(state, createWin32HelperError(
        "Windows host identity helper stdout exceeds the bounded frame",
        "HOST_PATH_CAPTURE_OUTPUT_LIMIT",
      ));
      return;
    }
    const newlineIndex = this.#stdoutBuffer.indexOf(0x0a);
    if (newlineIndex < 0) {
      return;
    }
    const remainder = this.#stdoutBuffer.subarray(newlineIndex + 1);
    if (remainder.length > 0) {
      this.#invalidateProcess(state, createWin32HelperError(
        "Windows host identity helper emitted extra response bytes",
        "HOST_PATH_CAPTURE_PROTOCOL_INVALID",
      ));
      return;
    }
    const line = this.#stdoutBuffer.subarray(0, newlineIndex)
      .toString("utf8")
      .replace(/\r$/u, "");
    const pending = this.#active;
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.#invalidateProcess(state, createWin32HelperError(
        "Windows host identity helper emitted invalid JSON",
        "HOST_PATH_CAPTURE_PROTOCOL_INVALID",
      ));
      return;
    }
    if (!isWin32HelperResponseBoundToRequest(response, pending)) {
      this.#invalidateProcess(state, createWin32HelperError(
        "Windows host identity helper response is invalid or out of order",
        "HOST_PATH_CAPTURE_PROTOCOL_INVALID",
      ));
      return;
    }
    this.#active = null;
    this.#stdoutBuffer = Buffer.alloc(0);
    if (pending.timeout !== null) {
      clearTimeout(pending.timeout);
    }
    pending.resolve(response.capture);
    void this.#drainQueue();
  }

  /** stderr 同样执行固定字节上限，避免常驻进程积累无界诊断。 */
  #acceptStderr(state: Win32HostPathIdentityProcessState, chunk: Buffer): void {
    if (this.#process !== state || state.invalidated) {
      return;
    }
    this.#stderrBytes += chunk.length;
    if (this.#stderrBytes > WIN32_HOST_IDENTITY_OUTPUT_LIMIT_BYTES) {
      this.#invalidateProcess(state, createWin32HelperError(
        "Windows host identity helper stderr exceeds the bounded frame",
        "HOST_PATH_CAPTURE_OUTPUT_LIMIT",
      ));
    }
  }

  /** 超时、I/O、错序或超量统一拒绝在途请求并终止失效进程。 */
  #invalidateProcess(state: Win32HostPathIdentityProcessState, error: Error): void {
    if (this.#process !== state || state.invalidated) {
      return;
    }
    state.invalidated = true;
    const pending = this.#active;
    this.#active = null;
    if (pending !== null) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    try {
      state.child.kill();
    } catch {
      /** close 的固定上限会把无法终止的 helper 作为关闭失败传播。 */
    }
  }

  /** 进程 close 后先删除本实例创建的临时根，再允许队列重建 helper。 */
  async #settleClosedProcess(
    state: Win32HostPathIdentityProcessState,
    code: number | null,
  ): Promise<void> {
    const ownsCurrentProcess = this.#process === state;
    if (ownsCurrentProcess) {
      this.#process = null;
    }
    const pending = ownsCurrentProcess ? this.#active : null;
    if (ownsCurrentProcess) {
      this.#active = null;
    }
    if (pending !== null) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      pending.reject(createWin32HelperError(
        `Windows host identity helper exited with code ${String(code)}`,
        "HOST_PATH_CAPTURE_PROCESS_FAILED",
      ));
    }
    this.#stdoutBuffer = Buffer.alloc(0);
    this.#stderrBytes = 0;
    try {
      await rm(state.root, { force: true, recursive: true });
      state.resolveClosed();
      if (!this.#closed) {
        void this.#drainQueue();
      }
    } catch (error) {
      const cleanupError = normalizeWin32HelperError(error);
      state.rejectClosed(cleanupError);
      this.#rejectQueued(cleanupError);
    }
  }

  /** 关闭时拒绝全部请求、终止当前进程并等待其 close+teardown。 */
  async #shutdown(): Promise<void> {
    const error = createWin32HelperError(
      "Windows host identity helper is closing",
      "HOST_PATH_IDENTITY_HELPER_CLOSED",
    );
    this.#rejectQueued(error);
    const pending = this.#active;
    this.#active = null;
    if (pending !== null) {
      if (pending.timeout !== null) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    await this.#starting?.catch(() => undefined);
    const state = this.#process;
    if (state === null) {
      return;
    }
    state.invalidated = true;
    try {
      state.child.kill();
    } catch {
      /** 下方有界等待会保留失败语义。 */
    }
    await state.closed;
  }

  /** 队列拒绝集中处理，避免 close/cleanup 分支遗漏未派发请求。 */
  #rejectQueued(error: Error): void {
    for (const pending of this.#queue.splice(0)) {
      pending.reject(error);
    }
  }
}

/** 生产进程入口固定 powershell.exe、shell:false 与隐藏窗口。 */
function spawnWin32HostPathIdentityProcess(
  scriptPath: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath],
    {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

/**
 * 从固定审计脚本机械派生常驻包装器：只提升 Add-Type/纯函数定义，
 * 原句柄打开、对象身份、错误分类与 finally 释放逻辑保持逐字复用。
 */
function createPersistentWin32HostPathIdentityScript(): string {
  const source = WINDOWS_HOST_IDENTITY_SNAPSHOT_SCRIPT.replaceAll("\r\n", "\n");
  const preambleStart = source.indexOf('$ErrorActionPreference = "Stop"');
  const captureStart = source.indexOf("$handles = [System.Collections.Generic.List[object]]::new()");
  if (preambleStart < 0 || captureStart <= preambleStart) {
    throw createWin32HelperError(
      "Windows host identity script markers are invalid",
      "HOST_PATH_CAPTURE_PROTOCOL_INVALID",
    );
  }
  const preamble = source.slice(preambleStart, captureStart).trimEnd();
  let captureBody = source.slice(captureStart).trim();
  captureBody = replaceWin32ScriptMarker(
    captureBody,
    "  $request = (Get-Content -Raw -Encoding UTF8 -LiteralPath $RequestPath | ConvertFrom-Json)\n",
    "",
  );
  captureBody = replaceWin32ScriptMarker(
    captureBody,
    "  } | ConvertTo-Json -Compress -Depth 8\n",
    "  }\n",
  );
  captureBody = replaceWin32ScriptMarker(
    captureBody,
    "  } | ConvertTo-Json -Compress\n",
    "  }\n",
  );
  const indentedCaptureBody = captureBody.split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `${preamble}

function Invoke-CodeGraphHostIdentityCapture([object]$request) {
${indentedCaptureBody}
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
while (($requestLine = [Console]::In.ReadLine()) -ne $null) {
  try {
    $requestEnvelope = ($requestLine | ConvertFrom-Json)
    if (
      $null -eq $requestEnvelope -or
      [string]::IsNullOrEmpty([string]$requestEnvelope.requestId) -or
      $null -eq $requestEnvelope.request
    ) {
      throw [System.InvalidOperationException]::new("CG_PROTOCOL:INVALID_REQUEST")
    }
    $capture = Invoke-CodeGraphHostIdentityCapture $requestEnvelope.request
    $responseJson = [pscustomobject]@{
      capture = $capture
      requestId = [string]$requestEnvelope.requestId
    } | ConvertTo-Json -Compress -Depth 10
    [Console]::Out.WriteLine($responseJson)
    [Console]::Out.Flush()
  } catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    [Console]::Error.Flush()
    exit 91
  }
}
`;
}

/** 固定脚本标记必须唯一，防止上游语义漂移时生成部分替换的 helper。 */
function replaceWin32ScriptMarker(
  source: string,
  marker: string,
  replacement: string,
): string {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw createWin32HelperError(
      "Windows host identity script marker is missing or duplicated",
      "HOST_PATH_CAPTURE_PROTOCOL_INVALID",
    );
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + marker.length)}`;
}

/** 响应必须是精确 envelope，并完整绑定当前 nonce 与候选索引集合。 */
function isWin32HelperResponseBoundToRequest(
  value: unknown,
  pending: PendingWin32HostPathIdentityCapture,
): value is { capture: HostPathSnapshotCaptureV1; requestId: string } {
  if (!isExactRecord(value, ["capture", "requestId"]) || value.requestId !== pending.requestId) {
    return false;
  }
  const capture = value.capture;
  if (!isExactRecord(capture, capture !== null && typeof capture === "object" &&
    "status" in capture && capture.status === "complete"
    ? ["capability", "captureNonce", "items", "rootObjectId", "status", "volumeId"]
    : ["code", "retryable", "status"])) {
    return false;
  }
  if (capture.status !== "complete") {
    return typeof capture.code === "string" &&
      typeof capture.retryable === "boolean" &&
      isWin32HelperFailureStatus(capture.status);
  }
  if (
    capture.captureNonce !== pending.request.captureNonce ||
    typeof capture.rootObjectId !== "string" ||
    typeof capture.volumeId !== "string" ||
    !Array.isArray(capture.items) ||
    capture.items.length !== pending.request.candidates.length ||
    !isExactRecord(capture.capability, [
      "fileIdInfo",
      "fileSystemType",
      "fixedVolume",
      "snapshotFence",
    ]) ||
    typeof capture.capability.fileIdInfo !== "boolean" ||
    typeof capture.capability.fileSystemType !== "string" ||
    typeof capture.capability.fixedVolume !== "boolean" ||
    typeof capture.capability.snapshotFence !== "string"
  ) {
    return false;
  }
  const expectedIndexes = new Set(pending.request.candidates.map(({ candidateIndex }) =>
    candidateIndex));
  const actualIndexes = new Set<number>();
  for (const item of capture.items) {
    const candidateIndex = isExactRecord(item, ["candidateIndex", "objectId"])
      ? item.candidateIndex
      : undefined;
    if (
      typeof candidateIndex !== "number" ||
      !Number.isSafeInteger(candidateIndex) ||
      !expectedIndexes.has(candidateIndex) ||
      actualIndexes.has(candidateIndex) ||
      !isExactRecord(item, ["candidateIndex", "objectId"]) ||
      typeof item.objectId !== "string"
    ) {
      return false;
    }
    actualIndexes.add(candidateIndex);
  }
  return actualIndexes.size === expectedIndexes.size;
}

/** 失败 capture 只能使用 host-path 公共封闭联合中的状态。 */
function isWin32HelperFailureStatus(value: unknown): value is Exclude<
  HostPathSnapshotCaptureV1["status"],
  "complete"
> {
  return value === "missing" || value === "unreadable" || value === "changed" ||
    value === "unsupported" || value === "error";
}

/** JSON 对象必须只含协议声明字段，拒绝隐式扩展与原型对象。 */
function isExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/** 为 helper 协议错误附加稳定内部 code。 */
function createWin32HelperError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** 未知异常在穿越 helper 生命周期边界前收敛为稳定 Error。 */
function normalizeWin32HelperError(error: unknown): Error {
  return error instanceof Error
    ? error
    : createWin32HelperError(String(error), "HOST_PATH_CAPTURE_PROCESS_FAILED");
}

/** helper 自身关闭也有固定上限，启动失败路径不依赖 runtime 才能收敛。 */
async function waitForWin32HelperWithinLimit(
  operation: Promise<void>,
  timeoutMs: number,
  code: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(createWin32HelperError(
          "Windows host identity helper close timeout",
          code,
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

/** graph-service 启动选项。 */
export interface StartGraphServiceOptions {
  forceTerminate?: (code: number) => void;
  indexingRoot: string;
  paths: ServiceInstancePaths;
  platform?: NodeJS.Platform;
}

/**
 * 启动本机 IPC 图谱服务，并在开放握手前完成 SQLite/ignore/runtime 屏障。
 */
export async function startGraphService(
  options: StartGraphServiceOptions,
): Promise<OwnedServiceInstance> {
  const indexingRoot = await validateTrustedIndexingRoot(options.indexingRoot);
  const logger = await createSafeLocalLogger(options.paths.workspaceDirectory);
  try {
    return await bootstrapServiceInstance({
      bindEndpoint: (endpoint, endpointKind) =>
        createBoundIpcEndpoint({
          endpoint,
          endpointKind,
          logger,
          ...(options.forceTerminate === undefined
            ? {}
            : { forceTerminate: options.forceTerminate }),
        }),
      paths: options.paths,
      initializeRuntime: async ({ serviceInstanceId, statusEpoch, workspaceKey }) => {
        let store: Awaited<ReturnType<typeof openSqliteGraphStore>> | null = null;
        const analyzer = createTypeScriptAnalyzer();
        /**
         * service instance 只创建一个 broker；每次 Analyzer capture 仍生成独立瞬态句柄批次，
         * snapshot identity 不会进入 store、digest 或进程外协议。
         */
        const platform = options.platform ?? process.platform;
        const caseSensitiveFileNames = isFileSystemCaseSensitive(indexingRoot);
        const hostPathIdentityHelper = platform === "win32"
          ? createServiceScopedWin32HostPathIdentityHelper()
          : null;
        const hostPathIdentitySnapshotProvider = createDefaultHostPathIdentitySnapshotProvider({
          caseSensitiveFileNames,
          platform,
          ...(hostPathIdentityHelper === null
            ? {}
            : { captureWindows: hostPathIdentityHelper.capture }),
        });
        const hostPathIdentityBroker = new HostPathIdentityBroker({
          caseSensitiveFileNames,
          indexingRoot,
          maxCandidates: MAX_HOST_PATH_CANDIDATES,
          platform,
          snapshotProvider: hostPathIdentitySnapshotProvider,
        });
        try {
          store = await openSqliteGraphStore({
            databasePath: path.join(options.paths.workspaceDirectory, "graph.sqlite"),
            digestPort: { digest: sha256CanonicalJson },
            workspaceKey,
          });
          const ignoreState = await createInitialIgnoreState(indexingRoot);
          return await createVerifiedIndexJobRuntime({
            analyzer,
            ...(hostPathIdentityHelper === null
              ? {}
              : { closeHostPathIdentityHelper: hostPathIdentityHelper.close }),
            hostPathIdentityBroker,
            ignoreState,
            indexingRoot,
            serviceInstanceId,
            statusEpoch,
            store,
            workspaceKey,
          });
        } catch (error) {
          await hostPathIdentityHelper?.close().catch(() => undefined);
          await analyzer.close().catch(() => undefined);
          store?.close();
          if (error instanceof GraphServiceStartupError) {
            throw error;
          }
          throw new GraphServiceStartupError(
            createErrorV1("GRAPH_STORE_OPEN_FAILED", randomUUID()),
          );
        }
      },
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });
  } catch (error) {
    await closeLoggerWithoutMaskingStartupError(logger);
    throw error;
  }
}

/** 在创建缓存、token 或 endpoint 前确认受信任 root 是规范绝对真实目录。 */
async function validateTrustedIndexingRoot(indexingRoot: string): Promise<string> {
  try {
    if (
      !path.isAbsolute(indexingRoot) ||
      path.normalize(indexingRoot) !== indexingRoot ||
      indexingRoot.includes("\0")
    ) {
      throw new Error("indexing root 不是规范绝对路径。");
    }
    /** 物理 root 不能做 Unicode 改写，否则 NFD 文件系统路径会被错误重定向。 */
    const resolved = await realpath(indexingRoot);
    const status = await lstat(resolved);
    if (!status.isDirectory() || status.isSymbolicLink() || resolved !== indexingRoot) {
      throw new Error("indexing root 不是规范真实目录。");
    }
    return resolved;
  } catch {
    throw new GraphServiceStartupError(
      createErrorV1("GRAPH_SCAN_FAILED", randomUUID()),
    );
  }
}

/** 为启动失败后的日志关闭设置硬界限，确保原始 fatal cleanup 错误一定可达入口。 */
async function closeLoggerWithoutMaskingStartupError(
  logger: SafeLocalLogger,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => logger.close())
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STARTUP_LOGGER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export * from "./instance-owner.js";
export * from "./analyzer-config.js";
export * from "./index-read-set.js";
export * from "./index-job-runtime.js";
export * from "./service-state.js";
