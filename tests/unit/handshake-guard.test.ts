import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  validateErrorV1,
} from "../../packages/contracts/src/index.js";
import { HandshakeGuard } from "../../apps/graph-service/src/handshake.js";

const workspaceKey = "b".repeat(64);

afterEach(() => {
  vi.useRealTimers();
});

/** 生成仅在测试进程内存在的握手输入。 */
function createFixture() {
  const sessionToken = randomBytes(32).toString("base64url");
  return {
    guard: new HandshakeGuard({
      createLogId: () => "log-handshake-test",
      sessionToken,
      workspaceKey,
    }),
    request: {
      clientVersion: "0.0.0-test",
      protocolVersion: PROTOCOL_VERSION,
      sessionToken,
      supportedSchemaVersions: {
        cli: [CLI_SCHEMA_VERSION],
        graph: [GRAPH_SCHEMA_VERSION],
        rules: [RULES_SCHEMA_VERSION],
      },
      workspaceKey,
    },
  };
}

describe("HandshakeGuard", () => {
  it("accepts a valid initialize as the first request", () => {
    const { guard, request } = createFixture();

    const decision = guard.evaluateFirstRequest("initialize", request);

    expect(decision).toEqual({ accepted: true, request });
    expect(guard.initialized).toBe(true);
  });

  it("rejects a non-initialize first request and requires connection closure", () => {
    const { guard } = createFixture();

    const decision = guard.evaluateFirstRequest("service/status", {});

    expect(decision.accepted).toBe(false);
    if (!decision.accepted) {
      expect(decision.closeConnection).toBe(true);
      expect(decision.error.code).toBe("SERVICE_INITIALIZE_REQUIRED");
      expect(validateErrorV1(decision.error)).toBe(true);
    }
  });

  it.each([
    ["token", { sessionToken: "wrong" }, "SERVICE_AUTH_FAILED"],
    ["workspace", { workspaceKey: "c".repeat(64) }, "SERVICE_WORKSPACE_MISMATCH"],
    ["protocol", { protocolVersion: 2 }, "SERVICE_PROTOCOL_INCOMPATIBLE"],
  ])("fails closed for an invalid %s", (_label, override, expectedCode) => {
    const { guard, request } = createFixture();

    const first = guard.evaluateFirstRequest("initialize", { ...request, ...override });
    const repeated = guard.evaluateFirstRequest("initialize", request);

    expect(first.accepted).toBe(false);
    expect(repeated.accepted).toBe(false);
    if (!first.accepted && !repeated.accepted) {
      expect(first.closeConnection).toBe(true);
      expect(first.error.code).toBe(expectedCode);
      expect(first.error.message).not.toContain(request.sessionToken);
      expect(repeated.closeConnection).toBe(true);
    }
  });

  it("closes an unauthenticated connection after the handshake timeout", async () => {
    vi.useFakeTimers();
    const sessionToken = randomBytes(32).toString("base64url");
    const guard = new HandshakeGuard({
      createLogId: () => "log-timeout-test",
      handshakeTimeoutMs: 25,
      sessionToken,
      workspaceKey,
    });
    const onTimeout = vi.fn();

    guard.armTimeout(onTimeout);
    await vi.advanceTimersByTimeAsync(25);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[0]).toMatchObject({
      closeConnection: true,
      error: { code: "SERVICE_AUTH_FAILED" },
    });
  });
});
