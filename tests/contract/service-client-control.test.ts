import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ServiceMetadataPayloadV1,
  ServiceMetadataV1,
} from "../../packages/contracts/src/index.js";
import {
  startGraphService,
  type OwnedServiceInstance,
  type ServiceInstancePaths,
} from "../../apps/graph-service/src/index.js";
import {
  connectToGraphServiceWithCacheRootForTests,
  type GraphServiceConnection,
} from "../../packages/service-client/src/connection.js";
import { calculateMetadataIntegrity } from "../../packages/service-client/src/discovery.js";

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
