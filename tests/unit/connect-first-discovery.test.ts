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
      timeoutMs: 500,
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
});
