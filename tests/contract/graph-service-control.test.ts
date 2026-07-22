import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as canonicalValidators from "../../packages/contracts/dist/index.js";
import { startGraphService } from "../../apps/graph-service/src/index.js";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  validateErrorV1,
  validateInitializeResult,
  validateServiceStatusV1,
} from "../../packages/contracts/src/index.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const roots: string[] = [];
const runtimes: Array<{ close: () => Promise<void> }> = [];
const workspaceKey = "3".repeat(64);

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建当前平台真实 IPC 服务。 */
async function createRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-server-"));
  roots.push(root);
  const paths = createWorkspacePaths(workspaceKey, {
    cacheRoot: root,
    platform: process.platform,
  });
  const runtime = await startGraphService({ paths });
  runtimes.push(runtime);
  return { paths, runtime };
}

/** 创建合法 initialize 参数。 */
function createInitializeRequest(sessionToken: string) {
  return {
    clientVersion: "0.0.0-test",
    protocolVersion: PROTOCOL_VERSION,
    sessionToken,
    supportedSchemaVersions: {
      cli: [CLI_SCHEMA_VERSION],
      graph: [GRAPH_SCHEMA_VERSION],
      rules: [RULES_SCHEMA_VERSION],
    },
    workspaceKey,
  };
}

describe("graph-service JSON-RPC control plane", () => {
  it("initializes over a real local IPC endpoint and returns authoritative absent status", async () => {
    const initializeValidator = vi.spyOn(
      canonicalValidators,
      "validateInitializeResult",
    );
    const statusValidator = vi.spyOn(
      canonicalValidators,
      "validateServiceStatusV1",
    );
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);

    try {
      const initialize = await client.request(
        "initialize",
        createInitializeRequest(runtime.sessionToken),
      );
      const status = await client.request("service/status", {});

      expect(validateInitializeResult(initialize.result)).toBe(true);
      expect(validateServiceStatusV1(status.result)).toBe(true);
      expect(initializeValidator).toHaveBeenCalledWith(initialize.result);
      expect(statusValidator).toHaveBeenCalledWith(status.result);
      expect(initialize.result).toMatchObject({
        serviceStatus: status.result,
      });
      expect(status.result).not.toHaveProperty("graphRevision");
      expect(status.result).not.toHaveProperty("nodes");
      expect(status.result).not.toHaveProperty("edges");
      const log = await readFile(
        path.join(paths.workspaceDirectory, "service.log"),
        "utf8",
      );
      expect(log).toContain("service-started");
      expect(log).not.toContain(runtime.sessionToken);
      if (process.platform === "win32") {
        expect(paths.endpoint).toMatch(/^\\\\\.\\pipe\\codegraph-/);
      } else {
        expect((await stat(paths.endpoint)).mode & 0o777).toBe(0o600);
      }
    } finally {
      initializeValidator.mockRestore();
      statusValidator.mockRestore();
    }

    await client.close();
  });

  it("rejects status before initialize with ErrorV1 and closes the connection", async () => {
    const { paths } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);

    const response = await client.request("service/status", {});

    expect(response.error?.data).toMatchObject({
      code: "SERVICE_INITIALIZE_REQUIRED",
    });
    expect(validateErrorV1(response.error?.data)).toBe(true);
    await expect(client.waitForClose()).resolves.toBeUndefined();
  });

  it("keeps a canonical response failure terminal until the connection closes", async () => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);
    let followUp: Promise<JsonRpcResponse> | undefined;
    const initializeValidator = vi
      .spyOn(canonicalValidators, "validateInitializeResult")
      .mockImplementationOnce(() => {
        followUp = client.request("service/status", {});
        return false;
      });

    try {
      const initialize = await client.request(
        "initialize",
        createInitializeRequest(runtime.sessionToken),
      );
      const status = await followUp;

      expect(initialize.error?.data).toMatchObject({
        code: "SERVICE_PROTOCOL_INCOMPATIBLE",
      });
      expect(status?.error?.data).toMatchObject({
        code: "SERVICE_PROTOCOL_INCOMPATIBLE",
      });
      await expect(client.waitForCloseWithin(500)).resolves.toBeUndefined();
    } finally {
      initializeValidator.mockRestore();
      await client.close();
    }
  });

  it("closes an unauthenticated connection that advertises an oversized frame", async () => {
    const { paths } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);

    client.writeRaw("Content-Length: 1048577\r\n\r\n");

    await expect(client.waitForCloseWithin(500)).resolves.toBeUndefined();
  });

  it.each([
    ["missing jsonrpc", { id: 1, method: "initialize" }],
    ["forged jsonrpc", { id: 1, jsonrpc: "1.0", method: "initialize" }],
  ])("closes a request with a %s envelope before initialize", async (_label, envelope) => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);

    client.writeRaw(createRawEnvelopeFrame({
      ...envelope,
      params: createInitializeRequest(runtime.sessionToken),
    }));

    await expect(client.waitForCloseWithin(500)).resolves.toBeUndefined();
  });

  it("rejects a second frame queued before initialize is processed", async () => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);
    const initialize = createRawRequestFrame(
      1,
      "initialize",
      createInitializeRequest(runtime.sessionToken),
    );
    const status = createRawRequestFrame(2, "service/status", {});

    client.writeRaw(Buffer.concat([initialize, status]));

    await expect(client.waitForCloseWithin(500)).resolves.toBeUndefined();
  });

  it("rejects an invalid token without echoing it", async () => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);
    const invalidToken = `${runtime.sessionToken}-invalid`;

    const response = await client.request(
      "initialize",
      createInitializeRequest(invalidToken),
    );

    expect(response.error?.data).toMatchObject({ code: "SERVICE_AUTH_FAILED" });
    expect(JSON.stringify(response.error)).not.toContain(invalidToken);
    await expect(client.waitForClose()).resolves.toBeUndefined();
  });

  it.each([
    ["workspace", { workspaceKey: "9".repeat(64) }, "SERVICE_WORKSPACE_MISMATCH"],
    ["protocol", { protocolVersion: 2 }, "SERVICE_PROTOCOL_INCOMPATIBLE"],
  ])("rejects an invalid %s and closes after one attempt", async (_label, override, code) => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);

    const response = await client.request("initialize", {
      ...createInitializeRequest(runtime.sessionToken),
      ...override,
    });

    expect(response.error?.data).toMatchObject({ code });
    expect(validateErrorV1(response.error?.data)).toBe(true);
    await expect(client.waitForClose()).resolves.toBeUndefined();
  });

  it("rejects a second endpoint owner without listening on a fallback", async () => {
    const { paths } = await createRuntime();
    const conflictingPaths = createWorkspacePaths(workspaceKey, {
      cacheRoot: path.dirname(path.dirname(path.dirname(paths.workspaceDirectory))),
      platform: process.platform,
    });

    await expect(startGraphService({ paths: conflictingPaths })).rejects.toMatchObject({
      code: "SERVICE_INSTANCE_CONFLICT",
    });
    await expect(JsonRpcTestClient.connect(conflictingPaths.endpoint)).rejects.toBeDefined();
  });

  it("performs controlled shutdown and removes owned discovery resources", async () => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);
    await client.request("initialize", createInitializeRequest(runtime.sessionToken));

    const shutdown = await client.request("service/shutdown", {});

    expect(shutdown.result).toEqual({ accepted: true });
    await expect(waitForMissing(paths.metadataPath)).resolves.toBeUndefined();
    await expect(waitForMissing(paths.tokenPath)).resolves.toBeUndefined();
  });

  it("rejects unknown control request fields through the shared request schema", async () => {
    const { paths, runtime } = await createRuntime();
    const client = await JsonRpcTestClient.connect(paths.endpoint);
    await client.request("initialize", createInitializeRequest(runtime.sessionToken));

    const invalidStatus = await client.request("service/status", { futureField: true });
    const validStatus = await client.request("service/status", {});

    expect(invalidStatus.error?.data).toMatchObject({ code: "SERVICE_INVALID_REQUEST" });
    expect(validateErrorV1(invalidStatus.error?.data)).toBe(true);
    expect(validateServiceStatusV1(validStatus.result)).toBe(true);
    await client.close();
  });
});

/** 原始合同客户端解析的最小 JSON-RPC 响应。 */
interface JsonRpcResponse {
  error?: { code: number; data?: unknown; message: string };
  id: number;
  jsonrpc: "2.0";
  result?: unknown;
}

/** 仅供合同测试使用的最小 Content-Length JSON-RPC 客户端。 */
class JsonRpcTestClient {
  readonly #pending = new Map<number, (response: JsonRpcResponse) => void>();
  readonly #socket: net.Socket;
  #buffer = Buffer.alloc(0);
  #closePromise: Promise<void>;
  #nextId = 1;

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    this.#closePromise = new Promise((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.on("data", (chunk: Buffer) => this.#consume(chunk));
  }

  /** 连接真实 Named Pipe 或 UDS。 */
  public static async connect(endpoint: string): Promise<JsonRpcTestClient> {
    const socket = net.createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new JsonRpcTestClient(socket);
  }

  /** 发送单个 JSON-RPC 请求并等待对应响应。 */
  public async request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = this.#nextId++;
    const payload = Buffer.from(
      JSON.stringify({ id, jsonrpc: "2.0", method, params }),
      "utf8",
    );
    const response = new Promise<JsonRpcResponse>((resolve) => this.#pending.set(id, resolve));
    this.#socket.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
    this.#socket.write(payload);
    return response;
  }

  /** 等待服务端关闭连接。 */
  public async waitForClose(): Promise<void> {
    return this.#closePromise;
  }

  /** 在短界限内等待服务端主动关闭连接。 */
  public async waitForCloseWithin(timeoutMs: number): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#closePromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("等待 IPC 连接关闭超时。")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  /** 发送用于边界测试的原始帧字节。 */
  public writeRaw(source: string | Buffer): void {
    this.#socket.write(source);
  }

  /** 主动关闭测试连接。 */
  public async close(): Promise<void> {
    if (this.#socket.destroyed) {
      return;
    }
    this.#socket.end();
    await this.#closePromise;
  }

  /** 解析 vscode-jsonrpc 使用的 Content-Length 帧。 */
  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /Content-Length: (\d+)/i.exec(header);
      if (lengthMatch === null) {
        throw new Error("JSON-RPC 响应缺少 Content-Length。");
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.#buffer.byteLength < bodyStart + length) {
        return;
      }
      const body = this.#buffer.subarray(bodyStart, bodyStart + length);
      this.#buffer = this.#buffer.subarray(bodyStart + length);
      const response = JSON.parse(body.toString("utf8")) as JsonRpcResponse;
      this.#pending.get(response.id)?.(response);
      this.#pending.delete(response.id);
    }
  }
}

/** 创建边界测试使用的完整 Content-Length 请求帧。 */
function createRawRequestFrame(id: number, method: string, params: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify({ id, jsonrpc: "2.0", method, params }), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

/** 创建可故意绕过 JSON-RPC 2.0 信封约束的原始帧。 */
function createRawEnvelopeFrame(envelope: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

/** 在短界限内等待 owned 资源被 shutdown 清理。 */
async function waitForMissing(filePath: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    try {
      await access(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待服务清理 owned 资源超时。");
}
