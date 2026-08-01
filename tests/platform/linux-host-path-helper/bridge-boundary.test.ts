import { describe, expect, it } from "vitest";
import {
  createLinuxHelperBridgeInvocationV1,
} from "../../../packages/adapters/host-path-posix-native/src/linux-helper.js";

describe("Linux helper bridge boundary", () => {
  it.each([
    ["relative executable", "usr/libexec/codegraph-host-path-bridge"],
    ["relative socket", "run/codegraph-host-path/helper.sock"],
    ["relative key", "etc/codegraph-host-path/client.key"],
    ["relative provenance", "usr/share/codegraph-host-path/provenance.json"],
    ["relative public key", "usr/share/codegraph-host-path/release.pub"],
  ])("fail closed: %s", (_label, invalidPath) => {
    expect(() => createLinuxHelperBridgeInvocationV1({
      bridgeExecutable: invalidPath.includes("bridge")
        ? invalidPath
        : "/usr/libexec/codegraph-host-path-bridge",
      deadlineMs: 30_000,
      keyPath: invalidPath.includes("client.key")
        ? invalidPath
        : "/etc/codegraph-host-path/client.key",
      provenancePath: invalidPath.includes("provenance")
        ? invalidPath
        : "/usr/share/codegraph-host-path/provenance.json",
      publicKeyPath: invalidPath.includes("release.pub")
        ? invalidPath
        : "/usr/share/codegraph-host-path/release.pub",
      rootFd: 7,
      socketPath: invalidPath.includes("helper.sock")
        ? invalidPath
        : "/run/codegraph-host-path/helper.sock",
    })).toThrow(/绝对路径/u);
  });

  it.each([0, -1, 2.5, 1_000_001])("拒绝非法 root FD 或 deadline: %s", (value) => {
    expect(() => createLinuxHelperBridgeInvocationV1({
      bridgeExecutable: "/usr/libexec/codegraph-host-path-bridge",
      deadlineMs: value === 1_000_001 ? value : 30_000,
      keyPath: "/etc/codegraph-host-path/client.key",
      provenancePath: "/usr/share/codegraph-host-path/provenance.json",
      publicKeyPath: "/usr/share/codegraph-host-path/release.pub",
      rootFd: value === 1_000_001 ? 7 : value,
      socketPath: "/run/codegraph-host-path/helper.sock",
    })).toThrow();
  });

  it("拒绝 canonical 但不属于固定安装布局的 executable", () => {
    expect(() => createLinuxHelperBridgeInvocationV1({
      bridgeExecutable: "/tmp/codegraph-host-path-bridge",
      deadlineMs: 30_000,
      keyPath: "/etc/codegraph-host-path/client.key",
      provenancePath: "/usr/share/codegraph-host-path/provenance.json",
      publicKeyPath: "/usr/share/codegraph-host-path/release.pub",
      rootFd: 7,
      socketPath: "/run/codegraph-host-path/helper.sock",
    })).toThrow(/固定安装布局/u);
  });
});
