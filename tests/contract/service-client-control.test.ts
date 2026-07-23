import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  type ServiceMetadataPayloadV1,
  type ServiceMetadataV1,
} from "../../packages/contracts/src/index.js";
import {
  startGraphService,
  type OwnedServiceInstance,
  type ServiceInstancePaths,
} from "../../apps/graph-service/src/index.js";
import {
  connectToGraphServiceWithCacheRootForTests,
  openServiceConnectionForTests,
  type GraphServiceConnection,
} from "../../packages/service-client/src/connection.js";
import { calculateMetadataIntegrity } from "../../packages/service-client/src/discovery.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const roots: string[] = [];
const clients: GraphServiceConnection[] = [];
let runtime: OwnedServiceInstance | null = null;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await runtime?.close();
  runtime = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("shared service-client control API", () => {
  it("reuses one instance for two clients and keeps connection lifecycles independent", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-client-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-client-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const start = vi.fn(async (paths: ServiceInstancePaths) => {
      runtime = await startGraphService({ paths });
    });
    const common = {
      clientVersion: "0.0.0-test",
      indexingRoot,
      launcher: { start },
      pollIntervalMs: 5,
      startTimeoutMs: 5_000,
      trust: { isTrusted: true },
    } as const;

    const first = await connectToGraphServiceWithCacheRootForTests(common, cacheRoot);
    clients.push(first);
    const second = await connectToGraphServiceWithCacheRootForTests(common, cacheRoot);
    clients.push(second);

    expect(start).toHaveBeenCalledTimes(1);
    expect(first.initializeResult.serviceStatus.serviceInstanceId).toBe(
      second.initializeResult.serviceStatus.serviceInstanceId,
    );
    expect(first.initializeResult.serviceStatus.statusEpoch).toBe(
      second.initializeResult.serviceStatus.statusEpoch,
    );

    await first.close();
    expect((await second.status()).availability).toBe("absent");
    await second.shutdown();
  });

  it("maps an absent launcher timeout to SERVICE_START_TIMEOUT", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-timeout-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-timeout-cache-"));
    roots.push(indexingRoot, cacheRoot);

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        indexingRoot,
        launcher: { start: async () => undefined },
        pollIntervalMs: 5,
        startTimeoutMs: 50,
        trust: { isTrusted: true },
      }, cacheRoot),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
  });

  it.each([
    ["malformed JSON", Buffer.from("Content-Length: 1\r\n\r\n{", "ascii")],
    ["oversized frame", Buffer.from("Content-Length: 1048577\r\n\r\n", "ascii")],
    ["invalid response envelope", encodeJsonRpcMessage({ id: 0, jsonrpc: "2.0" })],
    ["null response envelope", encodeJsonRpcMessage(null)],
    ["whitespace before Content-Length colon", Buffer.from("Content-Length : 2\r\n\r\n{}", "ascii")],
    ["header line without a colon", Buffer.from("Content-Length: 2\r\nBroken\r\n\r\n{}", "ascii")],
    ["server request during initialize", encodeJsonRpcMessage({
      id: 99,
      jsonrpc: "2.0",
      method: "server/ping",
      params: {},
    })],
    ["server notification during initialize", encodeJsonRpcMessage({
      jsonrpc: "2.0",
      method: "server/progress",
      params: {},
    })],
    ["multiple responses during initialize", Buffer.concat([
      encodeJsonRpcMessage({ id: 99, jsonrpc: "2.0", result: {} }),
      encodeJsonRpcMessage({ id: 100, jsonrpc: "2.0", result: {} }),
    ])],
    ["mismatched response id", encodeJsonRpcMessage({
      id: 99,
      jsonrpc: "2.0",
      result: {},
    })],
  ])("rejects a %s response immediately as protocol incompatible", async (_label, frame) => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-invalid-rpc-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-invalid-rpc-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const workspaceKey = "7".repeat(64);
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot,
      platform: process.platform,
    });
    await mkdir(paths.workspaceDirectory, { recursive: true });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.write(frame));
    });
    await listen(server, paths.endpoint);
    const startedAt = Date.now();
    try {
      await expect(
        openServiceConnectionForTests(
          {
            metadata: {
              createdAt: new Date().toISOString(),
              endpoint: paths.endpoint,
              endpointKind: paths.endpointKind,
              integrity: "test-only",
              pid: process.pid,
              serviceInstanceId: "invalid-rpc-instance",
              statusEpoch: "invalid-rpc-epoch",
              version: 1,
              workspaceKey,
            },
            sessionToken: "test-session-token",
          },
          {
            identity: { kind: "local", uri: "file:///invalid-rpc", version: 1 },
            indexingRoot,
            workspaceKey,
          },
          "0.0.0-test",
          1_000,
          2_000,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_INCOMPATIBLE" });
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it("rejects a non-2.0 response even when its initialize result is otherwise valid", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-rpc-version-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-rpc-version-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const workspaceKey = "8".repeat(64);
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot,
      platform: process.platform,
    });
    await mkdir(paths.workspaceDirectory, { recursive: true });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.write(encodeJsonRpcMessage({
        id: 0,
        jsonrpc: "1.0",
        result: {
          capabilities: SERVICE_CAPABILITIES,
          cliSchemaVersion: CLI_SCHEMA_VERSION,
          graphSchemaVersion: GRAPH_SCHEMA_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          rulesSchemaVersion: RULES_SCHEMA_VERSION,
          serviceStatus: {
            availability: "absent",
            committed: null,
            completeness: "empty",
            configRevision: 1,
            freshness: null,
            lifecycle: "running",
            serviceInstanceId: "rpc-version-instance",
            serviceStatusRevision: 1,
            statusEpoch: "rpc-version-epoch",
            statusRevision: 1,
            telemetry: { effective: "off", pending: false, requested: "off" },
            version: 1,
            viewConfigRevision: 1,
          },
          serviceVersion: "0.0.0-test",
        },
      })));
    });
    await listen(server, paths.endpoint);
    try {
      await expect(
        openServiceConnectionForTests(
          {
            metadata: {
              createdAt: new Date().toISOString(),
              endpoint: paths.endpoint,
              endpointKind: paths.endpointKind,
              integrity: "test-only",
              pid: process.pid,
              serviceInstanceId: "rpc-version-instance",
              statusEpoch: "rpc-version-epoch",
              version: 1,
              workspaceKey,
            },
            sessionToken: "test-session-token",
          },
          {
            identity: { kind: "local", uri: "file:///rpc-version", version: 1 },
            indexingRoot,
            workspaceKey,
          },
          "0.0.0-test",
          1_000,
          2_000,
        ),
      ).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_INCOMPATIBLE" });
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it("does not arm a recurring partial-message timer for client responses", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-partial-rpc-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-partial-rpc-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const workspaceKey = "6".repeat(64);
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot,
      platform: process.platform,
    });
    await mkdir(paths.workspaceDirectory, { recursive: true });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.write("Content-Length: 64\r\n\r\n{}"));
    });
    await listen(server, paths.endpoint);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let partialTimerArmed = false;
    try {
      await expect(openServiceConnectionForTests(
        {
          metadata: {
            createdAt: new Date().toISOString(),
            endpoint: paths.endpoint,
            endpointKind: paths.endpointKind,
            integrity: "test-only",
            pid: process.pid,
            serviceInstanceId: "partial-rpc-instance",
            statusEpoch: "partial-rpc-epoch",
            version: 1,
            workspaceKey,
          },
          sessionToken: "test-session-token",
        },
        {
          identity: { kind: "local", uri: "file:///partial-rpc", version: 1 },
          indexingRoot,
          workspaceKey,
        },
        "0.0.0-test",
        1_000,
        25,
      )).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
      partialTimerArmed = timeoutSpy.mock.calls.some((call) => call[1] === 10_000);
    } finally {
      /** 失败基线下手动清理 vscode-jsonrpc 泄漏的 timer，避免测试进程被挂住。 */
      timeoutSpy.mock.calls.forEach((call, index) => {
        if (call[1] === 10_000) {
          const handle = timeoutSpy.mock.results[index]?.value as NodeJS.Timeout | undefined;
          if (handle !== undefined) {
            clearTimeout(handle);
          }
        }
      });
      timeoutSpy.mockRestore();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
    expect(partialTimerArmed).toBe(false);
  });

  it("accepts concurrent status responses that arrive in reverse request order", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-concurrent-status-root-"));
    /** 保留 POSIX UDS 路径预算，避免合同测试夹具名称触发产品长度门禁。 */
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "cgs-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const workspaceKey = "5".repeat(64);
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot,
      platform: process.platform,
    });
    await mkdir(paths.workspaceDirectory, { recursive: true });
    const serviceInstanceId = "concurrent-status-instance";
    const statusEpoch = "concurrent-status-epoch";
    const serviceStatus = createAbsentStatus(serviceInstanceId, statusEpoch);
    const sockets = new Set<net.Socket>();
    const statusRequestIds: number[] = [];
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      consumeJsonRpcMessages(socket, (message) => {
        if (message.method === "initialize") {
          socket.write(encodeJsonRpcMessage({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: SERVICE_CAPABILITIES,
              cliSchemaVersion: CLI_SCHEMA_VERSION,
              graphSchemaVersion: GRAPH_SCHEMA_VERSION,
              protocolVersion: PROTOCOL_VERSION,
              rulesSchemaVersion: RULES_SCHEMA_VERSION,
              serviceStatus,
              serviceVersion: "0.0.0-test",
            },
          }));
          return;
        }
        if (message.method === "service/status") {
          statusRequestIds.push(message.id);
          if (statusRequestIds.length === 2) {
            socket.write(encodeJsonRpcMessage({
              id: statusRequestIds[1],
              jsonrpc: "2.0",
              result: serviceStatus,
            }));
            /** 留出一次 promise 清理时隙，确保响应预算不能靠集合首 token 偶然通过。 */
            setTimeout(() => {
              socket.write(encodeJsonRpcMessage({
                id: statusRequestIds[0],
                jsonrpc: "2.0",
                result: serviceStatus,
              }));
            }, 25);
          }
        }
      });
    });
    await listen(server, paths.endpoint);
    let client: GraphServiceConnection | null = null;
    try {
      client = await openServiceConnectionForTests(
        {
          metadata: {
            createdAt: new Date().toISOString(),
            endpoint: paths.endpoint,
            endpointKind: paths.endpointKind,
            integrity: "test-only",
            pid: process.pid,
            serviceInstanceId,
            statusEpoch,
            version: 1,
            workspaceKey,
          },
          sessionToken: "test-session-token",
        },
        {
          identity: { kind: "local", uri: "file:///concurrent-status", version: 1 },
          indexingRoot,
          workspaceKey,
        },
        "0.0.0-test",
        1_000,
        1_000,
      );

      await expect(Promise.all([client.status(), client.status()])).resolves.toEqual([
        serviceStatus,
        serviceStatus,
      ]);
    } finally {
      await client?.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(server);
    }
  });

  it.each([
    ["connect timeout", { connectTimeoutMs: 0 }],
    ["request timeout", { requestTimeoutMs: Number.POSITIVE_INFINITY }],
  ])("rejects an invalid %s before launching a service", async (_label, override) => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-invalid-option-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-invalid-option-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const start = vi.fn();

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        indexingRoot,
        launcher: { start },
        trust: { isTrusted: true },
        ...override,
      }, cacheRoot),
    ).rejects.toBeInstanceOf(TypeError);
    expect(start).not.toHaveBeenCalled();
  });

  it("applies the public absolute deadline to workspace identity derivation", async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-identity-timeout-cache-"));
    roots.push(cacheRoot);
    const start = vi.fn();
    const startedAt = Date.now();

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        identityOptions: {
          realpath: async () => new Promise<never>(() => undefined),
        },
        indexingRoot: "C:\\workspace\\identity-timeout",
        launcher: { start },
        startTimeoutMs: 25,
        trust: { isTrusted: true },
      }, cacheRoot),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(start).not.toHaveBeenCalled();
  });

  it("maps identity permission failures to a redacted stable ErrorV1", async () => {
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-identity-error-cache-"));
    roots.push(cacheRoot);
    const secretPath = "C:\\Users\\Example\\Secret Workspace";
    const start = vi.fn();

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        identityOptions: {
          realpath: async () => {
            const error = new Error(`permission denied: ${secretPath}`) as NodeJS.ErrnoException;
            error.code = "EACCES";
            throw error;
          },
        },
        indexingRoot: secretPath,
        launcher: { start },
        trust: { isTrusted: true },
      }, cacheRoot),
    ).rejects.toMatchObject({
      category: "transport",
      code: "SERVICE_ENDPOINT_START_FAILED",
      retryable: true,
    });
    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        identityOptions: {
          realpath: async () => {
            throw new Error(secretPath);
          },
        },
        indexingRoot: secretPath,
        launcher: { start },
        trust: { isTrusted: true },
      }, cacheRoot),
    ).rejects.not.toHaveProperty("message", expect.stringContaining(secretPath));
    expect(start).not.toHaveBeenCalled();
  });

  it("maps endpoint path construction failures to stable ErrorV1", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-invalid-path-root-"));
    roots.push(indexingRoot);

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        indexingRoot,
        launcher: { start: vi.fn() },
        trust: { isTrusted: true },
      }, "relative-cache"),
    ).rejects.toMatchObject({
      category: "transport",
      code: "SERVICE_ENDPOINT_START_FAILED",
      retryable: true,
    });
  });

  it("fails closed when the launcher exposes stale token evidence", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-stale-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-stale-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const start = vi.fn(async (paths: ServiceInstancePaths) => {
      await mkdir(paths.workspaceDirectory, { recursive: true });
      await writeFile(paths.tokenPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    });

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        indexingRoot,
        launcher: { start },
        pollIntervalMs: 5,
        startTimeoutMs: 500,
        trust: { isTrusted: true },
      }, cacheRoot),
    ).rejects.toMatchObject({ code: "SERVICE_INSTANCE_CONFLICT" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("rejects initialize identity that differs from discovery metadata", async () => {
    const indexingRoot = await mkdtemp(path.join(tmpdir(), "codegraph-identity-root-"));
    const cacheRoot = await mkdtemp(path.join(tmpdir(), "codegraph-identity-cache-"));
    roots.push(indexingRoot, cacheRoot);
    const start = vi.fn(async (paths: ServiceInstancePaths) => {
      runtime = await startGraphService({ paths });
      const metadata = JSON.parse(
        await readFile(paths.metadataPath, "utf8"),
      ) as ServiceMetadataV1;
      const payload: ServiceMetadataPayloadV1 = {
        createdAt: metadata.createdAt,
        endpoint: metadata.endpoint,
        endpointKind: metadata.endpointKind,
        pid: metadata.pid,
        serviceInstanceId: "forged-instance",
        statusEpoch: metadata.statusEpoch,
        version: metadata.version,
        workspaceKey: metadata.workspaceKey,
      };
      await writeFile(
        paths.metadataPath,
        `${JSON.stringify({
          ...payload,
          integrity: calculateMetadataIntegrity(payload),
        })}\n`,
        { mode: 0o600 },
      );
    });

    await expect(
      connectToGraphServiceWithCacheRootForTests({
        clientVersion: "0.0.0-test",
        indexingRoot,
        launcher: { start },
        pollIntervalMs: 5,
        startTimeoutMs: 5_000,
        trust: { isTrusted: true },
      }, cacheRoot),
    ).rejects.toMatchObject({ code: "SERVICE_INSTANCE_CONFLICT" });
  });
});

/** 监听合同测试使用的受控本机 IPC endpoint。 */
async function listen(server: net.Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** 关闭测试 IPC server；活动 socket 由调用方先行销毁。 */
async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/** 编码合同测试使用的单帧 JSON-RPC 消息。 */
function encodeJsonRpcMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

/** 并发响应合同测试使用的最小 JSON-RPC 请求形状。 */
interface TestJsonRpcRequest {
  id: number;
  method: string;
}

/** 从真实 socket 增量解析 Content-Length 请求帧。 */
function consumeJsonRpcMessages(
  socket: net.Socket,
  onMessage: (message: TestJsonRpcRequest) => void,
): void {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /Content-Length: (\d+)/iu.exec(header);
      if (lengthMatch === null) {
        throw new Error("JSON-RPC 请求缺少 Content-Length。");
      }
      const contentLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.byteLength < bodyStart + contentLength) {
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + contentLength);
      buffer = buffer.subarray(bodyStart + contentLength);
      onMessage(JSON.parse(body.toString("utf8")) as TestJsonRpcRequest);
    }
  });
}

/** 创建并发 status 测试使用的权威空状态。 */
function createAbsentStatus(serviceInstanceId: string, statusEpoch: string) {
  return {
    availability: "absent" as const,
    committed: null,
    completeness: "empty" as const,
    configRevision: 1,
    freshness: null,
    lifecycle: "running" as const,
    serviceInstanceId,
    serviceStatusRevision: 1,
    statusEpoch,
    statusRevision: 1,
    telemetry: { effective: "off" as const, pending: false, requested: "off" as const },
    version: 1 as const,
    viewConfigRevision: 1,
  };
}
