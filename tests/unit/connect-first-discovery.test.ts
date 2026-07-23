import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapServiceInstance,
  type OwnedServiceInstance,
} from "../../apps/graph-service/src/instance-owner.js";
import {
  connectFirstOrStart,
  type ServiceDiscoveryRecord,
} from "../../packages/service-client/src/discovery.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";
import { createServiceClientError } from "../../packages/service-client/src/errors.js";

const roots: string[] = [];
const workspaceKey = "2".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建隔离的发现路径。 */
async function createPaths() {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-connect-first-"));
  roots.push(root);
  return createWorkspacePaths(workspaceKey, {
    cacheRoot: root,
    platform: process.platform,
  });
}

/** 启动不接受网络连接的所有权夹具，仅用于验证发现顺序。 */
async function startOwner(
  paths: ReturnType<typeof createWorkspacePaths>,
): Promise<OwnedServiceInstance> {
  return bootstrapServiceInstance({
    bindEndpoint: async () => ({
      close: async () => undefined,
      openHandshake: async () => undefined,
    }),
    paths,
  });
}

describe("connect-first discovery", () => {
  it("connects to an existing winner without invoking the launcher", async () => {
    const paths = await createPaths();
    const owner = await startOwner(paths);
    const start = vi.fn();

    const result = await connectFirstOrStart({
      connect: async (record: ServiceDiscoveryRecord) =>
        record.metadata.serviceInstanceId,
      paths,
      start,
      timeoutMs: 500,
    });

    expect(result).toBe(owner.serviceInstanceId);
    expect(start).not.toHaveBeenCalled();
    await owner.close();
  });

  it("starts only when discovery is absent, then connects to the winner", async () => {
    const paths = await createPaths();
    const owners: OwnedServiceInstance[] = [];
    const start = vi.fn(async () => {
      owners.push(await startOwner(paths));
    });

    const result = await connectFirstOrStart({
      connect: async (record) => record.metadata.statusEpoch,
      paths,
      pollIntervalMs: 5,
      start,
      /** 本用例验证启动顺序；并行 CI 的目录同步预算不属于 deadline 性能断言。 */
      timeoutMs: 2_000,
    });

    expect(result).toBe(owners[0]?.statusEpoch);
    expect(start).toHaveBeenCalledTimes(1);
    await owners[0]?.close();
  });

  it("fails closed for stale evidence instead of launching a second instance", async () => {
    const paths = await createPaths();
    await mkdir(paths.workspaceDirectory, { recursive: true });
    await writeFile(paths.tokenPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    const start = vi.fn();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        start,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_INSTANCE_CONFLICT" });
    expect(start).not.toHaveBeenCalled();
  });

  it("enforces the deadline when connect never settles", async () => {
    const paths = await createPaths();
    const owner = await startOwner(paths);

    await expect(
      connectFirstOrStart({
        connect: async () => new Promise<never>(() => undefined),
        paths,
        start: async () => undefined,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });

    await owner.close();
  });

  it("enforces the deadline when launcher start never settles", async () => {
    const paths = await createPaths();
    const startedAt = Date.now();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        start: async () => new Promise<never>(() => undefined),
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it("does not sleep past the remaining discovery deadline", async () => {
    const paths = await createPaths();
    await mkdir(paths.workspaceDirectory, { recursive: true });
    await writeFile(paths.lockPath, "starting", { mode: 0o600 });
    const startedAt = Date.now();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        pollIntervalMs: 500,
        start: async () => undefined,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });

    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it.each([
    ["timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["poll interval", { pollIntervalMs: 0 }],
  ])("rejects an invalid %s before entering discovery", async (_label, override) => {
    const paths = await createPaths();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        start: async () => undefined,
        ...override,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("aborts an in-flight connection when the absolute deadline expires", async () => {
    const paths = await createPaths();
    const owner = await startOwner(paths);
    let aborted = false;

    await expect(
      connectFirstOrStart({
        connect: async (_record, _remainingMs, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            }, { once: true });
          }),
        paths,
        probeDiscoveryState: async () => "ready",
        readServiceDiscovery: async () => ({
          metadata: owner.metadata,
          sessionToken: owner.sessionToken,
        }),
        start: async () => undefined,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });

    expect(aborted).toBe(true);
    await owner.close();
  });

  it("returns at the deadline while aborted launcher cleanup settles in background", async () => {
    const paths = await createPaths();
    let cleanupFinished = false;
    const startedAt = Date.now();
    const retryStart = vi.fn();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        probeDiscoveryState: async () => "absent",
        start: async (_remainingMs, signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              setTimeout(() => {
                cleanupFinished = true;
                reject(createServiceClientError("SERVICE_ENDPOINT_START_FAILED"));
              }, 25);
            }, { once: true });
          }),
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });

    expect(Date.now() - startedAt).toBeLessThan(200);
    await vi.waitFor(() => expect(cleanupFinished).toBe(true));
    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        probeDiscoveryState: async () => "absent",
        start: retryStart,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_ENDPOINT_START_FAILED" });
    expect(retryStart).not.toHaveBeenCalled();

    /** 失败 tombstone 必须持续阻止后续启动，不能只被第一次重试消费。 */
    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        probeDiscoveryState: async () => "absent",
        start: retryStart,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_ENDPOINT_START_FAILED" });
    expect(retryStart).not.toHaveBeenCalled();
  });

  it("retains every concurrent timed-out launcher cleanup for the same workspace", async () => {
    const paths = await createPaths();
    let rejectFirst: ((error: unknown) => void) | undefined;
    let rejectSecond: ((error: unknown) => void) | undefined;
    const firstStart = vi.fn(async (_remainingMs: number, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        rejectFirst = reject;
        signal.addEventListener("abort", () => undefined, { once: true });
      }));
    const secondStart = vi.fn(async (_remainingMs: number, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        rejectSecond = reject;
        signal.addEventListener("abort", () => undefined, { once: true });
      }));

    await Promise.all([
      expect(connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        probeDiscoveryState: async () => "absent",
        start: firstStart,
        timeoutMs: 25,
      })).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" }),
      expect(connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        probeDiscoveryState: async () => "absent",
        start: secondStart,
        timeoutMs: 25,
      })).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" }),
    ]);

    rejectFirst?.(createServiceClientError("SERVICE_ENDPOINT_START_FAILED"));
    rejectSecond?.(createServiceClientError("SERVICE_START_TIMEOUT"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const retryStart = vi.fn();

    await expect(connectFirstOrStart({
      connect: async () => "unreachable",
      paths,
      probeDiscoveryState: async () => "absent",
      start: retryStart,
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: "SERVICE_ENDPOINT_START_FAILED" });
    expect(retryStart).not.toHaveBeenCalled();
  });

  it("applies the absolute deadline to discovery probing", async () => {
    const paths = await createPaths();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        probeDiscoveryState: async () => new Promise<never>(() => undefined),
        start: async () => undefined,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_START_TIMEOUT" });
  });

  it("rejects timeout values beyond the Node timer range", async () => {
    const paths = await createPaths();

    await expect(
      connectFirstOrStart({
        connect: async () => "unreachable",
        paths,
        start: async () => undefined,
        timeoutMs: 2_147_483_648,
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
