import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  validateErrorV1,
  validateInitializeRequest,
  validateInitializeResult,
  validateInitializeResultCompatible,
  validateServiceControlRequest,
  validateServiceStatusV1,
  validateShutdownResult,
  validateShutdownResultCompatible,
} from "../../packages/contracts/src/index.js";

const workspaceKey = "a".repeat(64);

/** 创建不包含静态凭据的合法初始化请求。 */
function createInitializeRequest() {
  return {
    clientVersion: "0.0.0-test",
    protocolVersion: PROTOCOL_VERSION,
    sessionToken: randomBytes(32).toString("base64url"),
    supportedSchemaVersions: {
      cli: [CLI_SCHEMA_VERSION],
      graph: [GRAPH_SCHEMA_VERSION],
      rules: [RULES_SCHEMA_VERSION],
    },
    workspaceKey,
  };
}

/** 创建 Story 1.2 唯一允许的权威空状态。 */
function createAbsentStatus() {
  return {
    availability: "absent" as const,
    committed: null,
    completeness: "empty" as const,
    configRevision: 1,
    freshness: null,
    lifecycle: "running" as const,
    serviceInstanceId: "instance-test",
    serviceStatusRevision: 1,
    statusEpoch: "epoch-test",
    statusRevision: 1,
    telemetry: {
      effective: "off" as const,
      pending: false,
      requested: "off" as const,
    },
    version: 1 as const,
    viewConfigRevision: 1,
  };
}

describe("service control contract", () => {
  it("keeps protocol, graph, rules, and CLI schema versions independent", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(GRAPH_SCHEMA_VERSION).toBe(1);
    expect(RULES_SCHEMA_VERSION).toBe(1);
    expect(CLI_SCHEMA_VERSION).toBe(1);
    expect(SERVICE_CAPABILITIES).toEqual([
      "service/shutdown",
      "service/status",
    ]);
    expect(new Set(SERVICE_CAPABILITIES).size).toBe(SERVICE_CAPABILITIES.length);
  });

  it("validates the complete initialize request and rejects unknown input", () => {
    const request = createInitializeRequest();

    expect(validateInitializeRequest(request)).toBe(true);
    expect(validateInitializeRequest({ ...request, host: "127.0.0.1" })).toBe(false);
    expect(validateInitializeRequest({ ...request, protocolVersion: "1" })).toBe(false);
    expect(validateInitializeRequest({ ...request, sessionToken: "" })).toBe(false);
  });

  it("accepts only the legal absent status baseline", () => {
    const status = createAbsentStatus();

    expect(validateServiceStatusV1(status)).toBe(true);
    expect(validateServiceStatusV1({ ...status, graphRevision: 1 })).toBe(false);
    expect(validateServiceStatusV1({ ...status, committed: { revision: 1 } })).toBe(
      false,
    );
    expect(validateServiceStatusV1({ ...status, freshness: "fresh" })).toBe(false);
    expect(validateServiceStatusV1({ ...status, completeness: "complete" })).toBe(
      false,
    );
    expect(
      validateServiceStatusV1({
        ...status,
        statusRevision: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe(false);
  });

  it("uses strict canonical responses and compatible client parsing", () => {
    const result = {
      capabilities: SERVICE_CAPABILITIES,
      cliSchemaVersion: CLI_SCHEMA_VERSION,
      graphSchemaVersion: GRAPH_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      rulesSchemaVersion: RULES_SCHEMA_VERSION,
      serviceStatus: createAbsentStatus(),
      serviceVersion: "0.0.0-test",
    };

    expect(validateInitializeResult(result)).toBe(true);
    expect(validateInitializeResult({ ...result, futureField: true })).toBe(false);
    expect(
      validateInitializeResultCompatible({
        ...result,
        futureField: true,
        serviceStatus: { ...result.serviceStatus, futureNestedField: true },
      }),
    ).toBe(true);
    expect(validateInitializeResultCompatible({ ...result, serviceVersion: undefined })).toBe(
      false,
    );
    expect(
      validateInitializeResultCompatible({
        ...result,
        capabilities: ["future/capability", ...SERVICE_CAPABILITIES],
      }),
    ).toBe(true);
    expect(
      validateInitializeResultCompatible({
        ...result,
        capabilities: [SERVICE_CAPABILITIES[0]],
      }),
    ).toBe(true);
  });

  it("validates empty control requests and canonical shutdown results", () => {
    expect(validateServiceControlRequest({})).toBe(true);
    expect(validateServiceControlRequest({ futureField: true })).toBe(false);
    expect(validateShutdownResult({ accepted: true })).toBe(true);
    expect(validateShutdownResult({ accepted: true, futureField: true })).toBe(false);
    expect(validateShutdownResultCompatible({ accepted: true, futureField: true })).toBe(true);
  });

  it("validates JSON-RPC error data through the shared ErrorV1 schema", () => {
    const error = {
      category: "security",
      code: "SERVICE_AUTH_FAILED",
      logId: "log-test",
      message: "认证失败，请重新发现服务。",
      retryable: true,
      suggestedAction: "重新发现服务后再试。",
    };

    expect(validateErrorV1(error)).toBe(true);
    expect(validateErrorV1({ ...error, category: "unknown" })).toBe(false);
    expect(validateErrorV1({ ...error, retryable: "yes" })).toBe(false);
    expect(validateErrorV1({ ...error, details: "secret" })).toBe(false);
    expect(validateErrorV1({ ...error, logId: "" })).toBe(false);
    expect(
      validateErrorV1({
        ...error,
        category: "transport",
        retryable: false,
        suggestedAction: "忽略认证错误。",
      }),
    ).toBe(false);
  });
});
