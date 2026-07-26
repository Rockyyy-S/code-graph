import net from "node:net";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  ResponseError,
} from "../../packages/service-client/node_modules/vscode-jsonrpc/lib/node/main.js";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
} from "../../packages/contracts/src/index.js";
import {
  DEFAULT_SERVICE_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVICE_START_TIMEOUT_MS,
  GraphServiceConnection,
} from "../../packages/service-client/src/connection.js";
import { createBoundedJsonRpcInput } from "../../packages/service-client/src/bounded-json-rpc-input.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "../../packages/adapters/store-sqlite/src/index.js";

describe("GraphServiceConnection request deadlines", () => {
  it("keeps default request and startup deadlines above the SQLite busy timeout", () => {
    expect(DEFAULT_SERVICE_REQUEST_TIMEOUT_MS).toBeGreaterThan(SQLITE_BUSY_TIMEOUT_MS);
    expect(DEFAULT_SERVICE_START_TIMEOUT_MS).toBeGreaterThan(SQLITE_BUSY_TIMEOUT_MS);
  });

  it("times out status and closes a permanently pending connection", async () => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => new Promise<never>(() => undefined)),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = new GraphServiceConnection(
      connection,
      socket,
      {
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
          currentIndexJob: null,
          freshness: null,
          graphRevision: null,
          lastIndexJob: null,
          lifecycle: "running",
          serviceInstanceId: "instance",
          serviceStatusRevision: 1,
          statusEpoch: "epoch",
          statusRevision: 1,
          telemetry: { effective: "off", pending: false, requested: "off" },
          version: 1,
          viewConfigRevision: 1,
        },
        serviceVersion: "0.0.0-test",
      },
      {
        identity: { kind: "local", uri: "file:///workspace", version: 1 },
        indexingRoot: "/workspace",
        physicalRootKey: "9".repeat(64),
        workspaceKey: "9".repeat(64),
      },
      {
        createdAt: new Date(0).toISOString(),
        endpoint: "/tmp/service.sock",
        endpointKind: "unix-socket",
        integrity: `sha256:${"a".repeat(64)}`,
        pid: 1,
        serviceInstanceId: "instance",
        statusEpoch: "epoch",
        version: 1,
        workspaceKey: "9".repeat(64),
      },
      10,
    );

    await expect(client.status()).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("closes without sending status when the capability was not negotiated", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn();
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, ["service/shutdown"]);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(sendRequest).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("closes a terminal connection after an incompatible status response", async () => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => ({ future: "invalid" })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("keeps a healthy legacy connection open when job/start was not negotiated", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn(async () => createConnectionStatus());
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, ["service/shutdown", "service/status"]);

    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(false);
    await expect(client.status()).resolves.toMatchObject({ availability: "absent" });
    await client.close();
  });

  it("rejects status without Job fields after job/start was negotiated", async () => {
    const dispose = vi.fn();
    const status = createConnectionStatus() as Record<string, unknown>;
    delete status.currentIndexJob;
    delete status.lastIndexJob;
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => status),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("maps malformed JSON-RPC errors to protocol incompatibility", async () => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => {
        throw new ResponseError(ErrorCodes.InvalidRequest, "malformed", {
          unexpected: true,
        });
      }),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects oversized JSON-RPC frames before buffering their body", async () => {
    const socket = new net.Socket();
    const input = createBoundedJsonRpcInput(socket);
    const inputError = once(input, "error");

    socket.emit("data", Buffer.from("Content-Length: 1048577\r\n\r\n", "ascii"));

    await inputError;
    expect(socket.destroyed).toBe(true);
  });

  it("rejects a response stream that ends with an incomplete frame", async () => {
    const socket = new net.Socket();
    const rejected = vi.fn();
    const input = createBoundedJsonRpcInput(socket, rejected);
    const inputError = vi.fn();
    input.on("error", inputError);

    socket.emit("data", Buffer.from("Content-Length: 64\r\n\r\n{}", "ascii"));
    socket.emit("end");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(inputError).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });
});

/** 创建可定制 capability 的最小服务连接夹具。 */
function createConnection(
  connection: ConstructorParameters<typeof GraphServiceConnection>[0],
  socket: net.Socket,
  capabilities: readonly string[],
): GraphServiceConnection {
  return new GraphServiceConnection(
    connection,
    socket,
    {
      capabilities: capabilities as typeof SERVICE_CAPABILITIES,
      cliSchemaVersion: CLI_SCHEMA_VERSION,
      graphSchemaVersion: GRAPH_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      rulesSchemaVersion: RULES_SCHEMA_VERSION,
      serviceStatus: {
        availability: "absent",
        committed: null,
        completeness: "empty",
        configRevision: 1,
        currentIndexJob: null,
        freshness: null,
        graphRevision: null,
        lastIndexJob: null,
        lifecycle: "running",
        serviceInstanceId: "instance",
        serviceStatusRevision: 1,
        statusEpoch: "epoch",
        statusRevision: 1,
        telemetry: { effective: "off", pending: false, requested: "off" },
        version: 1,
        viewConfigRevision: 1,
      },
      serviceVersion: "0.0.0-test",
    },
    {
      identity: { kind: "local", uri: "file:///workspace", version: 1 },
      indexingRoot: "/workspace",
      physicalRootKey: "9".repeat(64),
      workspaceKey: "9".repeat(64),
    },
    {
      createdAt: new Date(0).toISOString(),
      endpoint: "/tmp/service.sock",
      endpointKind: "unix-socket",
      integrity: `sha256:${"a".repeat(64)}`,
      pid: 1,
      serviceInstanceId: "instance",
      statusEpoch: "epoch",
      version: 1,
      workspaceKey: "9".repeat(64),
    },
    10,
  );
}

/** 创建旧服务仍能返回的合法空状态。 */
function createConnectionStatus() {
  return {
    availability: "absent" as const,
    committed: null,
    completeness: "empty" as const,
    configRevision: 1,
    currentIndexJob: null,
    freshness: null,
    graphRevision: null,
    lastIndexJob: null,
    lifecycle: "running" as const,
    serviceInstanceId: "instance",
    serviceStatusRevision: 1,
    statusEpoch: "epoch",
    statusRevision: 1,
    telemetry: { effective: "off" as const, pending: false, requested: "off" as const },
    version: 1 as const,
    viewConfigRevision: 1,
  };
}
