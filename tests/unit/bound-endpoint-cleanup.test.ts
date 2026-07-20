import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSafeLocalLogger } from "../../apps/graph-service/src/safe-log.js";
import { createBoundIpcEndpoint } from "../../apps/graph-service/src/server.js";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
} from "../../packages/contracts/src/index.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("bound IPC endpoint cleanup", () => {
  it("closes a POSIX listener when socket permission hardening fails", async () => {
    if (process.platform === "win32") {
      expect(process.platform).toBe("win32");
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-bound-endpoint-"));
    roots.push(root);
    const paths = createWorkspacePaths("8".repeat(64), {
      cacheRoot: root,
      platform: process.platform,
    });
    const logger = await createSafeLocalLogger(paths.workspaceDirectory);

    await expect(
      createBoundIpcEndpoint({
        endpoint: paths.endpoint,
        endpointKind: "unix-socket",
        logger,
        setEndpointPermissions: async () => {
          throw new Error("chmod failed");
        },
      }),
    ).rejects.toThrow("chmod failed");

    await expect(connect(paths.endpoint)).rejects.toBeDefined();
    await logger.close();
  });

  it("preserves a pre-existing POSIX path when listen fails before binding", async () => {
    if (process.platform === "win32") {
      expect(process.platform).toBe("win32");
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-bound-conflict-"));
    roots.push(root);
    const paths = createWorkspacePaths("6".repeat(64), {
      cacheRoot: root,
      platform: process.platform,
    });
    // 日志初始化会创建受保护的 workspace 目录，冲突文件必须在目录就绪后写入。
    const logger = await createSafeLocalLogger(paths.workspaceDirectory);
    await writeFile(paths.endpoint, "foreign-owner", "utf8");
    try {
      await expect(
        createBoundIpcEndpoint({
          endpoint: paths.endpoint,
          endpointKind: "unix-socket",
          logger,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });

      expect(await readFile(paths.endpoint, "utf8")).toBe("foreign-owner");
    } finally {
      await logger.close();
    }
  });

  it("keeps a socket connected across the metadata-to-handshake publication window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-pending-handshake-"));
    roots.push(root);
    const paths = createWorkspacePaths("7".repeat(64), {
      cacheRoot: root,
      platform: process.platform,
    });
    const logger = await createSafeLocalLogger(paths.workspaceDirectory);
    let endpoint: Awaited<ReturnType<typeof createBoundIpcEndpoint>> | null = null;
    let socket: net.Socket | null = null;
    try {
      endpoint = await createBoundIpcEndpoint({
        endpoint: paths.endpoint,
        endpointKind: paths.endpointKind,
        logger,
      });
      socket = await openSocket(paths.endpoint);

      await endpoint.openHandshake({
        serviceInstanceId: "instance-test",
        sessionToken: "session-token-test",
        shutdown: async () => undefined,
        statusEpoch: "epoch-test",
        workspaceKey: paths.workspaceKey,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(socket.destroyed).toBe(false);
    } finally {
      socket?.destroy();
      await endpoint?.close();
      await logger.close();
    }
  });

  it("retries a rejected protocol shutdown without creating an unhandled rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-shutdown-retry-"));
    roots.push(root);
    const paths = createWorkspacePaths("5".repeat(64), {
      cacheRoot: root,
      platform: process.platform,
    });
    const logger = await createSafeLocalLogger(paths.workspaceDirectory);
    let endpoint: Awaited<ReturnType<typeof createBoundIpcEndpoint>> | null = null;
    let socket: net.Socket | null = null;
    const shutdown = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockImplementation(async () => endpoint?.close());
    try {
      endpoint = await createBoundIpcEndpoint({
        endpoint: paths.endpoint,
        endpointKind: paths.endpointKind,
        logger,
      });
      await endpoint.openHandshake({
        serviceInstanceId: "instance-shutdown-test",
        sessionToken: "session-token-shutdown-test",
        shutdown,
        statusEpoch: "epoch-shutdown-test",
        workspaceKey: paths.workspaceKey,
      });
      socket = await openSocket(paths.endpoint);
      await sendJsonRpcRequest(socket, 1, "initialize", {
        clientVersion: "0.0.0-test",
        protocolVersion: PROTOCOL_VERSION,
        sessionToken: "session-token-shutdown-test",
        supportedSchemaVersions: {
          cli: [CLI_SCHEMA_VERSION],
          graph: [GRAPH_SCHEMA_VERSION],
          rules: [RULES_SCHEMA_VERSION],
        },
        workspaceKey: paths.workspaceKey,
      });

      await expect(sendJsonRpcRequest(socket, 2, "service/shutdown", {})).resolves.toEqual({
        accepted: true,
      });
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(2));
    } finally {
      socket?.destroy();
      await endpoint?.close().catch(() => undefined);
      await logger.close();
    }
  });

  it("forces termination when every protocol shutdown cleanup attempt fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-shutdown-fatal-"));
    roots.push(root);
    const paths = createWorkspacePaths("4".repeat(64), {
      cacheRoot: root,
      platform: process.platform,
    });
    const logger = await createSafeLocalLogger(paths.workspaceDirectory);
    const forceTerminate = vi.fn();
    let endpoint: Awaited<ReturnType<typeof createBoundIpcEndpoint>> | null = null;
    let socket: net.Socket | null = null;
    const shutdown = vi.fn(async () => {
      throw new Error("persistent cleanup failure");
    });
    try {
      endpoint = await createBoundIpcEndpoint({
        endpoint: paths.endpoint,
        endpointKind: paths.endpointKind,
        forceTerminate,
        logger,
      });
      await endpoint.openHandshake({
        serviceInstanceId: "instance-shutdown-fatal",
        sessionToken: "session-token-shutdown-fatal",
        shutdown,
        statusEpoch: "epoch-shutdown-fatal",
        workspaceKey: paths.workspaceKey,
      });
      socket = await openSocket(paths.endpoint);
      await sendJsonRpcRequest(socket, 1, "initialize", {
        clientVersion: "0.0.0-test",
        protocolVersion: PROTOCOL_VERSION,
        sessionToken: "session-token-shutdown-fatal",
        supportedSchemaVersions: {
          cli: [CLI_SCHEMA_VERSION],
          graph: [GRAPH_SCHEMA_VERSION],
          rules: [RULES_SCHEMA_VERSION],
        },
        workspaceKey: paths.workspaceKey,
      });

      await sendJsonRpcRequest(socket, 2, "service/shutdown", {});
      await vi.waitFor(() => expect(forceTerminate).toHaveBeenCalledWith(1));
      expect(shutdown).toHaveBeenCalledTimes(3);
    } finally {
      socket?.destroy();
      await endpoint?.close().catch(() => undefined);
      await logger.close();
    }
  });
});

/** 尝试连接 IPC endpoint，并在成功时立即关闭测试 socket。 */
async function connect(endpoint: string): Promise<void> {
  const socket = await openSocket(endpoint);
  socket.destroy();
}

/** 打开真实 IPC socket 并返回给需要检查生命周期的测试。 */
async function openSocket(endpoint: string): Promise<net.Socket> {
  const socket = net.createConnection(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

/** 发送单个 Content-Length JSON-RPC 请求并解析对应结果。 */
async function sendJsonRpcRequest(
  socket: net.Socket,
  id: number,
  method: string,
  params: unknown,
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify({ id, jsonrpc: "2.0", method, params }), "utf8");
  const response = new Promise<unknown>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("等待 JSON-RPC 测试响应超时。"));
    }, 500);
    const onClose = (): void => {
      cleanup();
      reject(new Error("JSON-RPC 测试连接在响应前关闭。"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const lengthMatch = /content-length:\s*(\d+)/iu.exec(header);
      if (lengthMatch === null) {
        cleanup();
        reject(new Error("JSON-RPC 响应缺少 Content-Length。"));
        return;
      }
      const bodyLength = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.byteLength < bodyStart + bodyLength) {
        return;
      }
      const message = JSON.parse(
        buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8"),
      ) as { error?: unknown; result?: unknown };
      cleanup();
      if (message.error !== undefined) {
        reject(message.error);
      } else {
        resolve(message.result);
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
  socket.write(`Content-Length: ${payload.byteLength}\r\n\r\n`);
  socket.write(payload);
  return response;
}
