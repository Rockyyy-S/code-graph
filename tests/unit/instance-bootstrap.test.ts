import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapServiceInstance,
  GraphServiceFatalCleanupError,
} from "../../apps/graph-service/src/instance-owner.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const roots: string[] = [];
const workspaceKey = "1".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 为 graph-service 启动所有权测试创建隔离路径。 */
async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-instance-"));
  roots.push(root);
  return createWorkspacePaths(workspaceKey, {
    cacheRoot: root,
    platform: process.platform,
  });
}

describe("graph-service instance bootstrap", () => {
  it("enforces ownership, token, bind, identity, metadata, handshake order", async () => {
    const paths = await createFixture();
    const events: string[] = [];
    const instance = await bootstrapServiceInstance({
      bindEndpoint: async () => {
        await access(paths.lockPath);
        await access(paths.tokenPath);
        await expect(access(paths.metadataPath)).rejects.toBeDefined();
        events.push("bound");
        return {
          close: async () => {
            events.push("closed");
          },
          openHandshake: async (context) => {
            await access(paths.metadataPath);
            expect(context.serviceInstanceId).toBeTruthy();
            expect(context.statusEpoch).toBeTruthy();
            expect(context.sessionToken).toBeTruthy();
            events.push("handshake-open");
          },
        };
      },
      paths,
      platform: process.platform,
    });

    expect(events).toEqual(["bound", "handshake-open"]);
    expect(instance.metadata.serviceInstanceId).toBe(instance.serviceInstanceId);
    expect(instance.metadata.statusEpoch).toBe(instance.statusEpoch);
    expect(JSON.stringify(instance.metadata)).not.toContain(instance.sessionToken);

    await instance.close();
    expect(events).toEqual(["bound", "handshake-open", "closed"]);
  });

  it("never binds when another owner already holds the workspace", async () => {
    const paths = await createFixture();
    const first = await bootstrapServiceInstance({
      bindEndpoint: async () => ({
        close: async () => undefined,
        openHandshake: async () => undefined,
      }),
      paths,
    });
    const bindEndpoint = vi.fn();

    await expect(bootstrapServiceInstance({ bindEndpoint, paths })).rejects.toMatchObject({
      code: "SERVICE_INSTANCE_CONFLICT",
    });
    expect(bindEndpoint).not.toHaveBeenCalled();

    await first.close();
  });

  it("fails closed on suspected stale files and preserves evidence", async () => {
    const paths = await createFixture();
    await mkdir(paths.workspaceDirectory, { recursive: true });
    await writeFile(paths.tokenPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    const original = await readFile(paths.tokenPath);
    const bindEndpoint = vi.fn();

    await expect(bootstrapServiceInstance({ bindEndpoint, paths })).rejects.toMatchObject({
      code: "SERVICE_INSTANCE_CONFLICT",
    });
    expect(bindEndpoint).not.toHaveBeenCalled();
    expect(await readFile(paths.tokenPath)).toEqual(original);
  });

  it("cleans only resources created by a failed bind", async () => {
    const paths = await createFixture();

    await expect(
      bootstrapServiceInstance({
        bindEndpoint: async () => {
          const error = new Error("bind failed") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
        paths,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_ENDPOINT_START_FAILED" });

    await expect(access(paths.lockPath)).rejects.toBeDefined();
    await expect(access(paths.tokenPath)).rejects.toBeDefined();
    await expect(access(paths.metadataPath)).rejects.toBeDefined();
  });

  it("rolls back published metadata when the final permission step fails", async () => {
    const paths = await createFixture();

    await expect(
      bootstrapServiceInstance({
        bindEndpoint: async () => ({
          close: async () => undefined,
          openHandshake: async () => undefined,
        }),
        paths,
        platform: "linux",
        setMetadataPermissions: async () => {
          throw new Error("chmod failed");
        },
      }),
    ).rejects.toMatchObject({ code: "SERVICE_ENDPOINT_START_FAILED" });

    await expect(access(paths.lockPath)).rejects.toBeDefined();
    await expect(access(paths.tokenPath)).rejects.toBeDefined();
    await expect(access(paths.metadataPath)).rejects.toBeDefined();
  });

  it("continues cleanup after endpoint close fails and allows a later retry", async () => {
    const paths = await createFixture();
    const closeEndpoint = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);
    const instance = await bootstrapServiceInstance({
      bindEndpoint: async () => ({
        close: closeEndpoint,
        openHandshake: async () => undefined,
      }),
      paths,
    });

    await expect(instance.close()).rejects.toBeInstanceOf(AggregateError);
    await expect(access(paths.metadataPath)).rejects.toBeDefined();
    await expect(access(paths.tokenPath)).rejects.toBeDefined();
    await expect(access(paths.lockPath)).resolves.toBeUndefined();

    await expect(instance.close()).resolves.toBeUndefined();
    await expect(access(paths.lockPath)).rejects.toBeDefined();
    expect(closeEndpoint).toHaveBeenCalledTimes(2);
  });

  it("retries transient endpoint cleanup during failed startup rollback", async () => {
    const paths = await createFixture();
    const closeEndpoint = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("close failed once"))
      .mockResolvedValue(undefined);

    await expect(
      bootstrapServiceInstance({
        bindEndpoint: async () => ({
          close: closeEndpoint,
          openHandshake: async () => {
            throw new Error("handshake publication failed");
          },
        }),
        paths,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_ENDPOINT_START_FAILED" });

    expect(closeEndpoint).toHaveBeenCalledTimes(2);
    await expect(access(paths.lockPath)).rejects.toBeDefined();
    await expect(access(paths.tokenPath)).rejects.toBeDefined();
    await expect(access(paths.metadataPath)).rejects.toBeDefined();
  });

  it("marks startup as fatal when cleanup retries cannot release the endpoint", async () => {
    const paths = await createFixture();
    const closeEndpoint = vi.fn(async () => {
      throw new Error("persistent close failure");
    });

    await expect(
      bootstrapServiceInstance({
        bindEndpoint: async () => ({
          close: closeEndpoint,
          openHandshake: async () => {
            throw new Error("startup failed");
          },
        }),
        paths,
      }),
    ).rejects.toBeInstanceOf(GraphServiceFatalCleanupError);

    expect(closeEndpoint).toHaveBeenCalledTimes(3);
    await expect(access(paths.lockPath)).resolves.toBeUndefined();
  });
});
