import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWorkspaceOwnership,
  createSessionToken,
  prepareWorkspaceCache,
  publishServiceMetadata,
  readServiceDiscovery,
} from "../../packages/service-client/src/discovery.js";
import { createWorkspacePaths } from "../../packages/service-client/src/endpoint.js";

const roots: string[] = [];
const workspaceKey = "e".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 创建隔离的发现目录。 */
async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-discovery-"));
  roots.push(root);
  const paths = createWorkspacePaths(workspaceKey, {
    cacheRoot: root,
    platform: process.platform,
  });
  await prepareWorkspaceCache(paths, process.platform);
  return { paths, root };
}

describe("service discovery metadata", () => {
  it("grants exclusive ownership to only one contender", async () => {
    const { paths } = await createFixture();
    const first = await acquireWorkspaceOwnership(paths);

    await expect(acquireWorkspaceOwnership(paths)).rejects.toMatchObject({
      code: "SERVICE_INSTANCE_CONFLICT",
    });

    await first.release();
  });

  it("stores a random 32-byte token separately and validates metadata integrity", async () => {
    const { paths } = await createFixture();
    const ownership = await acquireWorkspaceOwnership(paths);
    const sessionToken = await createSessionToken(paths);
    const metadata = await publishServiceMetadata(paths, {
      createdAt: new Date().toISOString(),
      endpoint: paths.endpoint,
      endpointKind: paths.endpointKind,
      pid: process.pid,
      serviceInstanceId: "instance-metadata-test",
      statusEpoch: "epoch-metadata-test",
      version: 1,
      workspaceKey,
    });

    const discovery = await readServiceDiscovery(paths, workspaceKey, process.platform);
    const storedToken = await readFile(paths.tokenPath);

    expect(storedToken).toHaveLength(32);
    expect(discovery.sessionToken).toBe(sessionToken);
    expect(discovery.metadata).toEqual(metadata);
    expect(JSON.stringify(metadata)).not.toContain(sessionToken);

    await ownership.release();
  });

  it.each([
    ["unknown version", { version: 2 }],
    ["workspace mismatch", { workspaceKey: "f".repeat(64) }],
    ["invalid integrity", { integrity: "sha256:invalid" }],
  ])("rejects %s metadata", async (_label, override) => {
    const { paths } = await createFixture();
    const ownership = await acquireWorkspaceOwnership(paths);
    await createSessionToken(paths);
    const metadata = await publishServiceMetadata(paths, {
      createdAt: new Date().toISOString(),
      endpoint: paths.endpoint,
      endpointKind: paths.endpointKind,
      pid: process.pid,
      serviceInstanceId: "instance-invalid-test",
      statusEpoch: "epoch-invalid-test",
      version: 1,
      workspaceKey,
    });
    await writeFile(paths.metadataPath, JSON.stringify({ ...metadata, ...override }), "utf8");

    await expect(
      readServiceDiscovery(paths, workspaceKey, process.platform),
    ).rejects.toBeDefined();

    await ownership.release();
  });

  it("applies the current platform cache security policy", async () => {
    const { paths, root } = await createFixture();
    const ownership = await acquireWorkspaceOwnership(paths);
    await createSessionToken(paths);
    await publishServiceMetadata(paths, {
      createdAt: new Date().toISOString(),
      endpoint: paths.endpoint,
      endpointKind: paths.endpointKind,
      pid: process.pid,
      serviceInstanceId: "instance-mode-test",
      statusEpoch: "epoch-mode-test",
      version: 1,
      workspaceKey,
    });

    if (process.platform === "win32") {
      expect((await stat(paths.tokenPath)).isFile()).toBe(true);
      expect((await stat(paths.metadataPath)).isFile()).toBe(true);
      const cacheRelativePath = path.relative(root, paths.workspaceDirectory);
      expect(cacheRelativePath.startsWith("..")).toBe(false);
      expect(path.isAbsolute(cacheRelativePath)).toBe(false);
    } else {
      expect((await stat(paths.workspaceDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.tokenPath)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.metadataPath)).mode & 0o777).toBe(0o600);
    }

    await ownership.release();
  });
});
