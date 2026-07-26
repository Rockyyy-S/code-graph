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
import {
  DEFAULT_SERVICE_START_TIMEOUT_MS as DEFAULT_LAUNCHER_START_TIMEOUT_MS,
} from "../../packages/service-client/src/launcher.js";

describe("GraphServiceConnection request deadlines", () => {
  it("keeps default request and startup deadlines above the SQLite busy timeout", () => {
    expect(DEFAULT_SERVICE_REQUEST_TIMEOUT_MS).toBeGreaterThan(SQLITE_BUSY_TIMEOUT_MS);
    expect(DEFAULT_SERVICE_START_TIMEOUT_MS).toBeGreaterThan(SQLITE_BUSY_TIMEOUT_MS);
    expect(DEFAULT_SERVICE_START_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(DEFAULT_LAUNCHER_START_TIMEOUT_MS).toBe(DEFAULT_SERVICE_START_TIMEOUT_MS);
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

  it("normalizes a legacy job/start response without revision fields", async () => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => ({
        accepted: true,
        job: {
          id: "legacy-job",
          kind: "initial-index",
          requestedAt: "2026-07-26T00:00:00.000Z",
          state: "queued",
        },
      })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.startRebuild()).resolves.toEqual({
      accepted: true,
      job: {
        baseGraphRevision: null,
        id: "legacy-job",
        kind: "initial-index",
        requestedAt: "2026-07-26T00:00:00.000Z",
        resultGraphRevision: null,
        state: "queued",
      },
    });
    expect(dispose).not.toHaveBeenCalled();
    await client.close();
  });

  it("maps a revisionless legacy rebuild to the fixed v1 revision", async () => {
    const connection = {
      dispose: vi.fn(),
      sendRequest: vi.fn(async () => ({
        accepted: true,
        job: {
          id: "legacy-rebuild",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:01.000Z",
          state: "queued",
        },
      })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const client = createConnection(
      connection,
      new net.Socket(),
      SERVICE_CAPABILITIES,
      createAvailableConnectionStatus(),
    );

    await expect(client.startRebuild()).resolves.toMatchObject({
      job: { baseGraphRevision: 1, resultGraphRevision: null },
    });
    await client.close();
  });

  it("uses the fixed legacy revision without a post-accept status request", async () => {
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          id: "concurrent-legacy-rebuild",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:01.000Z",
          state: "queued",
        },
      })
      .mockRejectedValueOnce(new Error("不得发送第二个 RPC"));
    const connection = {
      dispose: vi.fn(),
      sendRequest,
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const client = createConnection(connection, new net.Socket(), SERVICE_CAPABILITIES);

    await expect(client.startRebuild()).resolves.toMatchObject({
      job: { baseGraphRevision: 1, resultGraphRevision: null },
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("rejects replaying the pre-job IndexStatus after a queued Job was accepted", async () => {
    const initialStatus = createAvailableConnectionStatus();
    const dispose = vi.fn();
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          baseGraphRevision: 1,
          id: "queued-before-stale-status",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:01.000Z",
          resultGraphRevision: null,
          state: "queued",
        },
      })
      /** 即使 revision 自报前进，未体现 queued/terminal Job 的原快照仍然陈旧。 */
      .mockResolvedValueOnce({
        ...initialStatus,
        serviceStatusRevision: 2,
        statusRevision: 2,
      });
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES, initialStatus);

    await expect(client.startRebuild()).resolves.toMatchObject({
      job: { id: "queued-before-stale-status" },
    });
    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("accepts an advanced IndexStatus that exposes the accepted Job", async () => {
    const initialStatus = createAvailableConnectionStatus();
    const acceptedJob = {
      baseGraphRevision: 1,
      id: "visible-queued-job",
      kind: "rebuild" as const,
      requestedAt: "2026-07-26T00:00:01.000Z",
      resultGraphRevision: null,
      state: "queued" as const,
    };
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ accepted: true, job: acceptedJob })
      .mockResolvedValueOnce({
        ...initialStatus,
        currentIndexJob: acceptedJob,
        freshness: "stale" as const,
        serviceStatusRevision: 2,
        statusRevision: 2,
      });
    const connection = {
      dispose: vi.fn(),
      sendRequest,
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const client = createConnection(
      connection,
      new net.Socket(),
      SERVICE_CAPABILITIES,
      initialStatus,
    );

    await expect(client.startRebuild()).resolves.toMatchObject({
      job: { id: acceptedJob.id },
    });
    await expect(client.status()).resolves.toMatchObject({
      currentIndexJob: { id: acceptedJob.id },
      statusRevision: 2,
    });
    await client.close();
  });

  it("accepts a later healthy status after another client rotated the accepted Job out", async () => {
    const initialStatus = createAvailableConnectionStatus();
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          baseGraphRevision: 1,
          id: "completed-before-next-poll",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:01.000Z",
          resultGraphRevision: null,
          state: "queued",
        },
      })
      .mockResolvedValueOnce({
        ...initialStatus,
        freshness: "stale" as const,
        lastIndexJob: {
          baseGraphRevision: 1,
          completedAt: "2026-07-26T00:00:04.000Z",
          id: "later-job-from-another-client",
          kind: "rebuild" as const,
          requestedAt: "2026-07-26T00:00:02.000Z",
          resultGraphRevision: 1,
          startedAt: "2026-07-26T00:00:03.000Z",
          state: "cancelled" as const,
        },
        serviceStatusRevision: 3,
        statusRevision: 3,
      });
    const connection = {
      dispose: vi.fn(),
      sendRequest,
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const client = createConnection(
      connection,
      new net.Socket(),
      SERVICE_CAPABILITIES,
      initialStatus,
    );

    await expect(client.startRebuild()).resolves.toMatchObject({
      job: { id: "completed-before-next-poll" },
    });
    await expect(client.status()).resolves.toMatchObject({
      lastIndexJob: { id: "later-job-from-another-client" },
      statusRevision: 3,
    });
    await client.close();
  });

  it("rejects an explicit null rebuild base without trying to repair it", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          baseGraphRevision: null,
          id: "invalid-null-rebuild",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:01.000Z",
          resultGraphRevision: null,
          state: "queued",
        },
      })
      .mockResolvedValueOnce(createAvailableConnectionStatus());
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects a rebuild base older than the initialize snapshot", async () => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => ({
        accepted: true,
        job: {
          baseGraphRevision: 1,
          id: "stale-explicit-rebuild",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:01.000Z",
          resultGraphRevision: null,
          state: "queued",
        },
      })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(
      connection,
      socket,
      SERVICE_CAPABILITIES,
      createAvailableConnectionStatus(2),
    );

    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects a rebuild base older than a later observed status", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn()
      .mockResolvedValueOnce(createAvailableConnectionStatus(3))
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          baseGraphRevision: 2,
          id: "stale-after-status",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:02.000Z",
          resultGraphRevision: null,
          state: "queued",
        },
      });
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(
      connection,
      socket,
      SERVICE_CAPABILITIES,
      createAvailableConnectionStatus(),
    );

    await expect(client.status()).resolves.toMatchObject({ graphRevision: 3 });
    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects initial-index after a later status observed the first commit", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({
        ...createAvailableConnectionStatus(),
        serviceStatusRevision: 2,
        statusRevision: 2,
      })
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          id: "late-initial-after-status",
          kind: "initial-index",
          requestedAt: "2026-07-26T00:00:02.000Z",
          state: "queued",
        },
      });
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.status()).resolves.toMatchObject({ graphRevision: 1 });
    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("serializes revision-observing RPCs so an older status cannot arrive late", async () => {
    let resolveStatus!: (value: ReturnType<typeof createAvailableConnectionStatus>) => void;
    const pendingStatus = new Promise<ReturnType<typeof createAvailableConnectionStatus>>(
      (resolve) => {
        resolveStatus = resolve;
      },
    );
    const sendRequest = vi.fn()
      .mockReturnValueOnce(pendingStatus)
      .mockResolvedValueOnce({
        accepted: true,
        job: {
          baseGraphRevision: 2,
          id: "ordered-rebuild",
          kind: "rebuild",
          requestedAt: "2026-07-26T00:00:03.000Z",
          resultGraphRevision: null,
          state: "queued",
        },
      });
    const connection = {
      dispose: vi.fn(),
      sendRequest,
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const client = createConnection(
      connection,
      new net.Socket(),
      SERVICE_CAPABILITIES,
      createAvailableConnectionStatus(),
    );

    const statusPromise = client.status();
    const rebuildPromise = client.startRebuild();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendRequest).toHaveBeenCalledTimes(1);
    resolveStatus(createAvailableConnectionStatus());
    await expect(statusPromise).resolves.toMatchObject({ graphRevision: 1 });
    await expect(rebuildPromise).resolves.toMatchObject({
      job: { baseGraphRevision: 2 },
    });
    expect(sendRequest).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it.each([
    ["smaller revision", createAvailableConnectionStatus(1)],
    ["absent graph", createConnectionStatus()],
  ])("rejects a status regression to %s and closes the connection", async (_label, status) => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => status),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(
      connection,
      socket,
      SERVICE_CAPABILITIES,
      createAvailableConnectionStatus(2),
    );

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it.each([
    "serviceStatusRevision",
    "statusRevision",
    "configRevision",
    "viewConfigRevision",
  ] as const)("rejects a %s regression even when graphRevision is unchanged", async (field) => {
    const initialStatus = {
      ...createAvailableConnectionStatus(2),
      configRevision: 2,
      serviceStatusRevision: 2,
      statusRevision: 2,
      viewConfigRevision: 2,
    };
    const regressedStatus = { ...initialStatus, [field]: 1 };
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => regressedStatus),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(
      connection,
      socket,
      SERVICE_CAPABILITIES,
      initialStatus,
    );

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects different snapshots that reuse the same service status revision", async () => {
    const initialStatus = {
      ...createAvailableConnectionStatus(2),
      serviceStatusRevision: 2,
      statusRevision: 2,
    };
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => ({ ...initialStatus, freshness: "stale" as const })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES, initialStatus);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects a changed index status that reuses the same status revision", async () => {
    const initialStatus = {
      ...createAvailableConnectionStatus(2),
      serviceStatusRevision: 2,
      statusRevision: 2,
    };
    const dispose = vi.fn();
    const connection = {
      dispose,
      /** envelope revision 前进不能掩盖 IndexStatus 子快照复用旧 revision。 */
      sendRequest: vi.fn(async () => ({
        ...initialStatus,
        freshness: "stale" as const,
        serviceStatusRevision: 3,
      })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES, initialStatus);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("requires the envelope revision to advance with a child revision", async () => {
    const initialStatus = createAvailableConnectionStatus();
    const advancedGraph = {
      ...createAvailableConnectionStatus(2),
      serviceStatusRevision: initialStatus.serviceStatusRevision,
      statusRevision: 2,
    };
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => advancedGraph),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES, initialStatus);

    await expect(client.status()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("propagates a protocol failure to revision calls already waiting in the queue", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn(async () => ({ future: "invalid" }));
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    const first = client.status();
    const second = client.startRebuild();
    await expect(first).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_INCOMPATIBLE" });
    await expect(second).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_INCOMPATIBLE" });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("propagates the first concurrent status failure to a later valid response", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn()
      .mockResolvedValueOnce({ future: "invalid" })
      .mockResolvedValueOnce(createConnectionStatus());
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    const first = client.status();
    const second = client.status();
    await expect(first).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_INCOMPATIBLE" });
    await expect(second).rejects.toMatchObject({ code: "SERVICE_PROTOCOL_INCOMPATIBLE" });
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("queues shutdown behind an in-flight revision observation", async () => {
    let resolveStatus!: (value: ReturnType<typeof createConnectionStatus>) => void;
    const pendingStatus = new Promise<ReturnType<typeof createConnectionStatus>>((resolve) => {
      resolveStatus = resolve;
    });
    const sendRequest = vi.fn()
      .mockReturnValueOnce(pendingStatus)
      .mockResolvedValueOnce({ accepted: true });
    const connection = {
      dispose: vi.fn(),
      sendRequest,
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const client = createConnection(connection, new net.Socket(), SERVICE_CAPABILITIES);

    const statusPromise = client.status();
    const shutdownPromise = client.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendRequest).toHaveBeenCalledTimes(1);
    resolveStatus(createConnectionStatus());
    await expect(statusPromise).resolves.toMatchObject({ availability: "absent" });
    await expect(shutdownPromise).resolves.toBeUndefined();
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent shutdown requests", async () => {
    const dispose = vi.fn();
    const sendRequest = vi.fn(async () => ({ accepted: true }));
    const connection = { dispose, sendRequest } as unknown as ConstructorParameters<
      typeof GraphServiceConnection
    >[0];
    const client = createConnection(connection, new net.Socket(), SERVICE_CAPABILITIES);

    await expect(Promise.all([client.shutdown(), client.shutdown()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects initial-index after initialize already observed a committed graph", async () => {
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => ({
        accepted: true,
        job: {
          id: "invalid-late-initial",
          kind: "initial-index",
          requestedAt: "2026-07-26T00:00:02.000Z",
          state: "queued",
        },
      })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(
      connection,
      socket,
      SERVICE_CAPABILITIES,
      createAvailableConnectionStatus(),
    );

    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects a legacy initial-index response with a non-null base", async () => {
    const job = {
      baseGraphRevision: 1,
      id: "invalid-initial",
      kind: "initial-index",
      requestedAt: "2026-07-26T00:00:02.000Z",
      resultGraphRevision: null,
      state: "queued",
    };
    const dispose = vi.fn();
    const connection = {
      dispose,
      sendRequest: vi.fn(async () => ({ accepted: true, job })),
    } as unknown as ConstructorParameters<typeof GraphServiceConnection>[0];
    const socket = new net.Socket();
    const client = createConnection(connection, socket, SERVICE_CAPABILITIES);

    await expect(client.startRebuild()).rejects.toMatchObject({
      code: "SERVICE_PROTOCOL_INCOMPATIBLE",
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
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
  serviceStatus: ConstructorParameters<typeof GraphServiceConnection>[2]["serviceStatus"] =
    createConnectionStatus(),
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
      serviceStatus,
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
    telemetry: { effective: "off" as const, pending: false as const, requested: "off" as const },
    version: 1 as const,
    viewConfigRevision: 1,
  };
}

/** 创建旧服务已有一次空图提交时的规范化 revision 1 状态。 */
function createAvailableConnectionStatus(graphRevision = 1) {
  return {
    ...createConnectionStatus(),
    availability: "available" as const,
    committed: {
      builtinRulesVersion: "builtin-ignore-v1" as const,
      edgeCount: 0,
      excludedPathCount: 0,
      generatedAt: "2026-07-26T00:00:00.000Z",
      graphRevision,
      indexedFileCount: 0,
      nodeCount: 1,
    },
    freshness: "current" as const,
    graphRevision,
    serviceStatusRevision: graphRevision,
    statusRevision: graphRevision,
  };
}
