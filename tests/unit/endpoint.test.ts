import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorkspacePaths,
  MAX_UNIX_SOCKET_BYTES,
} from "../../packages/service-client/src/endpoint.js";

const workspaceKey = "d".repeat(64);

describe("workspace endpoint", () => {
  it("creates a random, non-TCP Windows named pipe", () => {
    const first = createWorkspacePaths(workspaceKey, {
      cacheRoot: "C:\\Users\\Example\\AppData\\Local",
      platform: "win32",
      randomBytes: () => Buffer.from("01".repeat(16), "hex"),
    });
    const second = createWorkspacePaths(workspaceKey, {
      cacheRoot: "C:\\Users\\Example\\AppData\\Local",
      platform: "win32",
      randomBytes: () => Buffer.from("02".repeat(16), "hex"),
    });

    expect(first.endpointKind).toBe("named-pipe");
    expect(first.endpoint).toMatch(
      /^\\\\\.\\pipe\\codegraph-[a-f0-9]{16}-[a-f0-9]{32}$/,
    );
    expect(first.endpoint).not.toBe(second.endpoint);
    expect(first).not.toHaveProperty("host");
    expect(first).not.toHaveProperty("port");
  });

  it("creates a length-controlled POSIX UDS under the user cache", () => {
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot: "/home/example/.cache",
      platform: "linux",
      randomBytes: () => Buffer.from("03".repeat(16), "hex"),
    });

    expect(paths.endpointKind).toBe("unix-socket");
    expect(paths.endpoint).toBe(
      path.posix.join(paths.workspaceDirectory, `s-${"03".repeat(8)}.sock`),
    );
    expect(Buffer.byteLength(paths.endpoint)).toBeLessThanOrEqual(
      MAX_UNIX_SOCKET_BYTES,
    );
  });

  it("fits the CI temporary cache shape within the POSIX UDS limit", () => {
    const paths = createWorkspacePaths(workspaceKey, {
      cacheRoot: "/tmp/codegraph-instance-123456",
      platform: "linux",
      randomBytes: () => Buffer.from("04".repeat(16), "hex"),
    });

    expect(Buffer.byteLength(paths.endpoint)).toBeLessThanOrEqual(
      MAX_UNIX_SOCKET_BYTES,
    );
  });

  it("fails closed when a configured cache root cannot fit a UDS", () => {
    expect(() =>
      createWorkspacePaths(workspaceKey, {
        cacheRoot: `/${"very-long-cache-segment/".repeat(10)}`,
        platform: "darwin",
      }),
    ).toThrow(/socket path/i);
  });
});
