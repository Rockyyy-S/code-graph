import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  createWorkspacePnpmInvocation,
  orderWorkspacesByDependencies,
} from "../../scripts/quality/run-workspace-script.mjs";

function workspace(relativePath: string, name: string, dependencies = {}) {
  return {
    absolutePath: relativePath,
    kind: "package",
    manifest: { dependencies, name },
    relativePath,
  };
}

describe("workspace dependency order", () => {
  it("places internal dependencies before their consumers", () => {
    const contracts = workspace("packages/contracts", "@codegraph/contracts");
    const client = workspace("packages/service-client", "@codegraph/service-client", {
      "@codegraph/contracts": "workspace:*",
    });
    const cli = workspace("apps/cli", "@codegraph/cli", {
      "@codegraph/service-client": "workspace:*",
    });

    const result = orderWorkspacesByDependencies([cli, client, contracts]);

    expect(result.errors).toEqual([]);
    expect(result.workspaces.map(({ relativePath }) => relativePath)).toEqual([
      "packages/contracts",
      "packages/service-client",
      "apps/cli",
    ]);
  });

  it("fails closed when workspace dependencies form a cycle", () => {
    const left = workspace("packages/left", "@codegraph/left", {
      "@codegraph/right": "workspace:*",
    });
    const right = workspace("packages/right", "@codegraph/right", {
      "@codegraph/left": "workspace:*",
    });

    const result = orderWorkspacesByDependencies([left, right]);

    expect(result.errors.join("\n")).toContain("workspace dependency cycle");
  });

  it("fails closed before ordering duplicate workspace package names", () => {
    const left = workspace("packages/left", "@codegraph/shared");
    const right = workspace("packages/right", "@codegraph/shared");

    const result = orderWorkspacesByDependencies([right, left]);

    expect(result.errors.join("\n")).toContain("工作区包名");
    expect(result.workspaces.map(({ relativePath }) => relativePath)).toEqual([
      "packages/left",
      "packages/right",
    ]);
  });
});

describe("workspace pnpm invocation", () => {
  it("uses controlled PATH for pnpm SEA relative npm_execpath", () => {
    expect(createWorkspacePnpmInvocation("pnpm", "/workspace/contracts", "build")).toEqual({
      args: ["--dir", "/workspace/contracts", "run", "build"],
      executable: "pnpm",
    });
  });

  it("distinguishes absolute JavaScript launchers from native pnpm executables", () => {
    const jsLauncher = path.resolve("tools/pnpm.cjs");
    const nativeLauncher = path.resolve("tools/pnpm");

    expect(createWorkspacePnpmInvocation(jsLauncher, "/workspace/contracts", "type")).toEqual({
      args: [jsLauncher, "--dir", "/workspace/contracts", "run", "type"],
      executable: process.execPath,
    });
    expect(createWorkspacePnpmInvocation(nativeLauncher, "/workspace/contracts", "type")).toEqual({
      args: ["--dir", "/workspace/contracts", "run", "type"],
      executable: nativeLauncher,
    });
  });

  it("runs an absolute Windows pnpm.cmd shim through bounded cmd.exe argv", () => {
    const launcher = "C:\\Program Files\\pnpm\\pnpm.cmd";

    expect(createWorkspacePnpmInvocation(launcher, "C:\\repo root\\contracts", "type"))
      .toEqual({
        args: [
          "/d",
          "/s",
          "/c",
          '""C:\\Program Files\\pnpm\\pnpm.cmd" "--dir" "C:\\repo root\\contracts" "run" "type""',
        ],
        executable: process.env.ComSpec ?? "cmd.exe",
        windowsVerbatimArguments: true,
      });
  });

  it("rejects untrusted Windows command shims and unsafe cmd expansion characters", () => {
    expect(() =>
      createWorkspacePnpmInvocation("C:\\tools\\other.cmd", "C:\\repo", "type"),
    ).toThrow(/受控 pnpm launcher/u);
    expect(() =>
      createWorkspacePnpmInvocation("C:\\tools\\pnpm.cmd", "C:\\repo!unsafe", "type"),
    ).toThrow(/不安全字符/u);
    expect(() =>
      createWorkspacePnpmInvocation("C:\\tools\\pnpm.cmd", "C:\\repo\\%TEMP%", "type"),
    ).toThrow(/不安全字符/u);
    expect(() =>
      createWorkspacePnpmInvocation("C:\\tools\\pnpm.cmd", "C:\\repo", "%PATH%"),
    ).toThrow(/不安全字符/u);
  });

  it("rejects untrusted relative npm_execpath values", () => {
    expect(() =>
      createWorkspacePnpmInvocation("tools/pnpm.cjs", "/workspace/contracts", "build"),
    ).toThrow(/npm_execpath/u);
  });
});
