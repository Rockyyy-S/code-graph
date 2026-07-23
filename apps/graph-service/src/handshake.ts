import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CLI_SCHEMA_VERSION,
  createErrorV1,
  GRAPH_SCHEMA_VERSION,
  isProtocolCompatible,
  RULES_SCHEMA_VERSION,
  type ErrorV1,
  type InitializeRequest,
  validateInitializeRequest,
} from "@codegraph/contracts";

/** 握手门禁构造参数。 */
export interface HandshakeGuardOptions {
  createLogId?: () => string;
  handshakeTimeoutMs?: number;
  sessionToken: string;
  workspaceKey: string;
}

/** 首请求握手结果；任何失败都要求传输层立即关闭当前连接。 */
export type HandshakeDecision =
  | { accepted: true; request: InitializeRequest }
  | { accepted: false; closeConnection: true; error: ErrorV1 };

/**
 * 强制每条连接的第一条请求为 initialize，并按 token、workspace、协议顺序校验。
 *
 * token 只保留 SHA-256 摘要，比较固定长度摘要以避免长度侧信道；一次失败后实例永久
 * 进入失败态，由传输层关闭连接，禁止在同一连接重复试探。
 */
export class HandshakeGuard {
  readonly #createLogId: () => string;
  readonly #expectedTokenDigest: Buffer;
  readonly #handshakeTimeoutMs: number;
  readonly #workspaceKey: string;
  #state: "failed" | "initialized" | "pending" = "pending";
  #terminalError: ErrorV1 | null = null;
  #timeout: NodeJS.Timeout | null = null;

  public constructor(options: HandshakeGuardOptions) {
    this.#createLogId = options.createLogId ?? randomUUID;
    this.#expectedTokenDigest = digestToken(options.sessionToken);
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
    this.#workspaceKey = options.workspaceKey;
  }

  /** 当前连接是否已经通过握手。 */
  public get initialized(): boolean {
    return this.#state === "initialized";
  }

  /**
   * 启动握手超时；超时后返回脱敏认证错误并要求传输层关闭连接。
   *
   * 返回函数可由连接清理路径取消计时器。
   */
  public armTimeout(onTimeout: (decision: HandshakeDecision) => void): () => void {
    this.#clearTimeout();
    if (this.#state !== "pending") {
      return () => undefined;
    }
    this.#timeout = setTimeout(() => {
      if (this.#state === "pending") {
        onTimeout(
          this.#reject("SERVICE_AUTH_FAILED", "initialize 握手超时。"),
        );
      }
    }, this.#handshakeTimeoutMs);
    this.#timeout.unref();
    return () => this.#clearTimeout();
  }

  /** 校验当前连接的第一条 JSON-RPC 请求。 */
  public evaluateFirstRequest(method: string, params: unknown): HandshakeDecision {
    if (this.#terminalError !== null) {
      return { accepted: false, closeConnection: true, error: this.#terminalError };
    }
    if (this.#state !== "pending" || method !== "initialize") {
      return this.#reject("SERVICE_INITIALIZE_REQUIRED");
    }

    const receivedToken = readSessionToken(params);
    if (
      receivedToken === null ||
      !timingSafeEqual(this.#expectedTokenDigest, digestToken(receivedToken))
    ) {
      return this.#reject("SERVICE_AUTH_FAILED");
    }
    if (!validateInitializeRequest(params)) {
      return this.#reject(
        "SERVICE_INITIALIZE_REQUIRED",
        "initialize 请求不符合协议定义。",
      );
    }
    if (params.workspaceKey !== this.#workspaceKey) {
      return this.#reject("SERVICE_WORKSPACE_MISMATCH");
    }
    if (!isProtocolCompatible(params.protocolVersion)) {
      return this.#reject("SERVICE_PROTOCOL_INCOMPATIBLE");
    }
    if (!supportsCurrentSchemaVersions(params)) {
      return this.#reject(
        "SERVICE_PROTOCOL_INCOMPATIBLE",
        "客户端不支持服务当前使用的 Schema 版本。",
      );
    }

    this.#clearTimeout();
    this.#state = "initialized";
    return { accepted: true, request: params };
  }

  /** 生成稳定 ErrorV1 并将当前连接锁定为失败态。 */
  #reject(
    code: Parameters<typeof createErrorV1>[0],
    message?: string,
  ): HandshakeDecision {
    this.#clearTimeout();
    this.#state = "failed";
    this.#terminalError = createErrorV1(code, this.#createLogId(), message);
    return { accepted: false, closeConnection: true, error: this.#terminalError };
  }

  /** 取消当前连接的握手计时器。 */
  #clearTimeout(): void {
    if (this.#timeout !== null) {
      clearTimeout(this.#timeout);
      this.#timeout = null;
    }
  }
}

/** 将任意长度 token 收敛为可安全比较的固定长度摘要。 */
function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** 在完整请求校验前只读取认证所需字段，避免提前泄露 workspace 状态。 */
function readSessionToken(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("sessionToken" in value)) {
    return null;
  }
  const sessionToken = value.sessionToken;
  return typeof sessionToken === "string" ? sessionToken : null;
}

/** 验证客户端对三套独立 Schema 当前版本均声明支持。 */
function supportsCurrentSchemaVersions(request: InitializeRequest): boolean {
  return (
    request.supportedSchemaVersions.cli.includes(CLI_SCHEMA_VERSION) &&
    request.supportedSchemaVersions.graph.includes(GRAPH_SCHEMA_VERSION) &&
    request.supportedSchemaVersions.rules.includes(RULES_SCHEMA_VERSION)
  );
}
