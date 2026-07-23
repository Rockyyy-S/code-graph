import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  deriveWorkspaceIdentity,
  normalizeGitRemoteIdentity,
} from "../../packages/service-client/src/workspace-identity.js";

describe("workspace identity", () => {
  it.each([
    ["https://User:Pass@GitHub.COM:443/Org/Repo.git/", "github.com/Org/Repo"],
    ["ssh://git@GitHub.COM:22/Org/Repo.git", "github.com/Org/Repo"],
    ["git@GitHub.COM:Org/Repo.git", "github.com/Org/Repo"],
    ["https://example.com:8443/Org/Repo/", "example.com:8443/Org/Repo"],
  ])("normalizes a trusted Git remote without credentials", (remote, expected) => {
    expect(normalizeGitRemoteIdentity(remote)).toBe(expected);
  });

  it("derives a stable Git workspace key from normalized identity input", async () => {
    const repositoryRoot = path.resolve("repo/Café");
    const indexingRoot = path.join(repositoryRoot, "packages", "app");
    const result = await deriveWorkspaceIdentity(indexingRoot, {
      gitIdentity: {
        remoteUrl: "https://account:credential@GitHub.COM/Org/Repo.git/",
        repositoryRoot,
      },
      realpath: async (input) => path.resolve(input).normalize("NFC"),
    });
    const expectedIdentity = {
      kind: "git",
      remoteIdentity: "github.com/Org/Repo",
      subroot: "packages/app",
      version: 1,
    };
    const expectedKey = createHash("sha256")
      .update(canonicalizeJson(expectedIdentity), "utf8")
      .digest("hex");

    expect(result.identity).toEqual(expectedIdentity);
    expect(result.workspaceKey).toBe(expectedKey);
    expect(result.workspaceKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back to a normalized local file URI without a stable Git identity", async () => {
    const result = await deriveWorkspaceIdentity("c:/Work/My Project", {
      platform: "win32",
      realpath: async () => "c:\\Work\\My Project",
    });

    expect(result.identity).toEqual({
      kind: "local",
      uri: "file:///C:/Work/My%20Project",
      version: 1,
    });
  });

  it("normalizes a Windows UNC root as a file URI with an authority", async () => {
    const result = await deriveWorkspaceIdentity("ignored", {
      platform: "win32",
      realpath: async () => "\\\\server\\share\\Folder Name",
    });

    expect(result.identity).toEqual({
      kind: "local",
      uri: "file://server/share/Folder%20Name",
      version: 1,
    });
  });

  it("rejects a Git identity whose indexing root escapes the repository root", async () => {
    await expect(
      deriveWorkspaceIdentity("C:/other", {
        gitIdentity: {
          remoteUrl: "https://github.com/Org/Repo.git",
          repositoryRoot: "C:/repo",
        },
        realpath: async (input) => path.resolve(input),
      }),
    ).rejects.toThrow(/仓库根目录/);
  });

  it("accepts an in-repository subroot whose name begins with two dots", async () => {
    const repositoryRoot = path.resolve("repo");
    const indexingRoot = path.join(repositoryRoot, "..generated");

    const result = await deriveWorkspaceIdentity(indexingRoot, {
      gitIdentity: {
        remoteUrl: "https://github.com/Org/Repo.git",
        repositoryRoot,
      },
      realpath: async (input) => path.resolve(input),
    });

    expect(result.identity).toMatchObject({ kind: "git", subroot: "..generated" });
  });
});
