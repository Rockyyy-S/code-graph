import { randomBytes } from "node:crypto";
import { Ajv2020 } from "../../packages/contracts/node_modules/ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  CLI_SCHEMA_VERSION,
  createErrorV1,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  jobStartResultV1Schema,
  serviceStatusV1Schema,
  validateErrorV1,
  validateInitializeRequest,
  validateInitializeResult,
  validateInitializeResultCompatible,
  validateJobStartResult,
  validateServiceControlRequest,
  validateServiceStatusV1,
  validateServiceStatusV1Compatible,
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
    currentIndexJob: null,
    freshness: null,
    graphRevision: null,
    lastIndexJob: null,
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
      "job/start",
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

  it("validates nested failed Job errors against the stable registry", () => {
    const status = {
      ...createAbsentStatus(),
      lastIndexJob: {
        baseGraphRevision: null,
        completedAt: "2026-07-25T00:00:02.000Z",
        error: createErrorV1("GRAPH_SCAN_FAILED", "log-nested-error"),
        id: "job-failed",
        kind: "initial-index" as const,
        requestedAt: "2026-07-25T00:00:00.000Z",
        resultGraphRevision: null,
        startedAt: "2026-07-25T00:00:01.000Z",
        state: "failed" as const,
      },
    };
    expect(validateServiceStatusV1(status)).toBe(true);
    expect(validateServiceStatusV1({
      ...status,
      lastIndexJob: {
        ...status.lastIndexJob,
        error: { ...status.lastIndexJob.error, category: "storage" },
      },
    })).toBe(false);
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
    expect(validateInitializeResultCompatible({
      ...result,
      serviceStatus: {
        ...result.serviceStatus,
        lastIndexJob: {
          completedAt: "2026-07-25T00:00:02.000Z",
          error: {
            ...createErrorV1("GRAPH_SCAN_FAILED", "log-initialize-error"),
            retryable: false,
          },
          id: "job-invalid-error",
          kind: "initial-index",
          requestedAt: "2026-07-25T00:00:00.000Z",
          startedAt: "2026-07-25T00:00:01.000Z",
          state: "failed",
        },
      },
    })).toBe(false);
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

    /** Story 1.2 的合法 v1 状态尚未包含索引 Job 字段，同版本兼容解析必须补默认值而非拒绝。 */
    const previousV1Status: Record<string, unknown> = { ...result.serviceStatus };
    delete previousV1Status.currentIndexJob;
    delete previousV1Status.graphRevision;
    delete previousV1Status.lastIndexJob;
    expect(validateInitializeResultCompatible({
      ...result,
      capabilities: SERVICE_CAPABILITIES.filter((capability) => capability !== "job/start"),
      serviceStatus: previousV1Status,
    })).toBe(true);
    expect(validateInitializeResultCompatible({
      ...result,
      serviceStatus: previousV1Status,
    })).toBe(false);
  });

  it("rejects impossible timestamps and hierarchy summaries", () => {
    const status = createAbsentStatus();
    expect(validateServiceStatusV1({
      ...status,
      lastIndexJob: {
        baseGraphRevision: null,
        completedAt: "2026-99-99T99:99:99Z",
        error: createErrorV1("GRAPH_SCAN_FAILED", "log-invalid-time"),
        id: "job-invalid-time",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:00.000Z",
        resultGraphRevision: null,
        startedAt: "2026-07-25T00:00:01.000Z",
        state: "failed",
      },
    })).toBe(false);
    const availableStatus = {
      ...status,
      availability: "available" as const,
      committed: {
        builtinRulesVersion: "builtin-ignore-v1" as const,
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:01.000Z",
        graphRevision: 1,
        indexedFileCount: 0,
        nodeCount: 1,
      },
      freshness: "current" as const,
      graphRevision: 1,
      lastIndexJob: {
        baseGraphRevision: 1,
        completedAt: "2026-07-25T00:00:03.000Z",
        error: createErrorV1("GRAPH_SCAN_FAILED", "log-null-result"),
        id: "job-null-result",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:01.000Z",
        resultGraphRevision: null,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "failed" as const,
      },
    };
    expect(validateServiceStatusV1(availableStatus)).toBe(false);
    expect(validateServiceStatusV1Compatible(availableStatus)).toBe(false);
    const cleanAvailableStatus = {
      ...availableStatus,
      lastIndexJob: null,
    };
    expect(validateServiceStatusV1({
      ...cleanAvailableStatus,
      completeness: "partial",
      freshness: "current",
    })).toBe(false);
    expect(validateServiceStatusV1Compatible({
      ...cleanAvailableStatus,
      completeness: "partial",
      freshness: "current",
    })).toBe(false);
    const partialWithoutTerminalEvidence = {
      ...cleanAvailableStatus,
      completeness: "partial" as const,
      freshness: "stale" as const,
    };
    expect(validateServiceStatusV1(partialWithoutTerminalEvidence)).toBe(false);
    expect(validateServiceStatusV1Compatible(partialWithoutTerminalEvidence)).toBe(false);
    const partialAfterSucceededJob = {
      ...partialWithoutTerminalEvidence,
      lastIndexJob: {
        baseGraphRevision: 1,
        completedAt: "2026-07-25T00:00:01.000Z",
        id: "job-succeeded-with-partial-status",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:00.000Z",
        resultGraphRevision: 1,
        startedAt: "2026-07-25T00:00:00.500Z",
        state: "succeeded" as const,
      },
    };
    expect(validateServiceStatusV1(partialAfterSucceededJob)).toBe(false);
    expect(validateServiceStatusV1Compatible(partialAfterSucceededJob)).toBe(false);
    const partialJobWithoutPartialCompleteness = {
      ...cleanAvailableStatus,
      lastIndexJob: {
        baseGraphRevision: 1,
        completedAt: "2026-07-25T00:00:03.000Z",
        id: "job-partial-with-complete-status",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:01.000Z",
        resultGraphRevision: 1,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "partial" as const,
      },
    };
    expect(validateServiceStatusV1(partialJobWithoutPartialCompleteness)).toBe(false);
    expect(validateServiceStatusV1Compatible(partialJobWithoutPartialCompleteness)).toBe(false);
    expect(validateServiceStatusV1({
      ...cleanAvailableStatus,
      currentIndexJob: {
        baseGraphRevision: null,
        id: "job-invalid-rebuild-base",
        kind: "rebuild",
        requestedAt: "2026-07-25T00:00:04.000Z",
        resultGraphRevision: null,
        state: "queued",
      },
    })).toBe(false);
    expect(validateServiceStatusV1({
      ...cleanAvailableStatus,
      currentIndexJob: {
        baseGraphRevision: 1,
        id: "job-invalid-initial-base",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:04.000Z",
        resultGraphRevision: null,
        state: "queued",
      },
    })).toBe(false);
    expect(validateServiceStatusV1({
      ...cleanAvailableStatus,
      currentIndexJob: {
        baseGraphRevision: 1,
        id: "job-valid-rebuild-base",
        kind: "rebuild",
        requestedAt: "2026-07-25T00:00:04.000Z",
        resultGraphRevision: null,
        state: "queued",
      },
    })).toBe(true);
    const previousFailedJob = {
      baseGraphRevision: 1,
      completedAt: "2026-07-25T00:00:03.000Z",
      error: createErrorV1("GRAPH_SCAN_FAILED", "log-previous-failed"),
      id: "job-previous-failed",
      kind: "rebuild" as const,
      requestedAt: "2026-07-25T00:00:01.000Z",
      resultGraphRevision: 1,
      startedAt: "2026-07-25T00:00:02.000Z",
      state: "failed" as const,
    };
    const invalidJobSequence = {
      ...cleanAvailableStatus,
      currentIndexJob: {
        baseGraphRevision: 1,
        id: "job-current-before-last",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:02.000Z",
        resultGraphRevision: null,
        state: "queued" as const,
      },
      lastIndexJob: previousFailedJob,
    };
    expect(validateServiceStatusV1(invalidJobSequence)).toBe(false);
    expect(validateServiceStatusV1Compatible(invalidJobSequence)).toBe(false);
    const reusedJobIdentity = {
      ...invalidJobSequence,
      currentIndexJob: {
        ...invalidJobSequence.currentIndexJob,
        id: previousFailedJob.id,
        requestedAt: "2026-07-25T00:00:04.000Z",
      },
    };
    expect(validateServiceStatusV1(reusedJobIdentity)).toBe(false);
    expect(validateServiceStatusV1Compatible(reusedJobIdentity)).toBe(false);
    for (const lastIndexJob of [
      {
        baseGraphRevision: 1,
        completedAt: "2026-07-25T00:00:03.000Z",
        id: "job-terminal-initial-with-base",
        kind: "initial-index" as const,
        requestedAt: "2026-07-25T00:00:01.000Z",
        resultGraphRevision: 1,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "succeeded" as const,
      },
      {
        baseGraphRevision: null,
        completedAt: "2026-07-25T00:00:03.000Z",
        id: "job-terminal-rebuild-without-base",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:01.000Z",
        resultGraphRevision: 1,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "succeeded" as const,
      },
      {
        baseGraphRevision: 2,
        completedAt: "2026-07-25T00:00:03.000Z",
        id: "job-terminal-base-after-result",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:01.000Z",
        resultGraphRevision: 1,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "succeeded" as const,
      },
      {
        baseGraphRevision: 2,
        completedAt: "2026-07-25T00:00:03.000Z",
        error: createErrorV1("GRAPH_SCAN_FAILED", "log-terminal-base-after-current"),
        id: "job-terminal-base-after-current",
        kind: "rebuild" as const,
        requestedAt: "2026-07-25T00:00:01.000Z",
        resultGraphRevision: 2,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "failed" as const,
      },
    ]) {
      const invalidTerminalStatus = { ...cleanAvailableStatus, lastIndexJob };
      expect(validateServiceStatusV1(invalidTerminalStatus)).toBe(false);
      expect(validateServiceStatusV1Compatible(invalidTerminalStatus)).toBe(false);
    }
    const impossibleInitialRevision = {
      ...cleanAvailableStatus,
      committed: {
        ...cleanAvailableStatus.committed,
        graphRevision: 2,
      },
      graphRevision: 2,
      lastIndexJob: {
        baseGraphRevision: null,
        completedAt: "2026-07-25T00:00:01.000Z",
        id: "job-initial-after-first-revision",
        kind: "initial-index" as const,
        requestedAt: "2026-07-25T00:00:00.000Z",
        resultGraphRevision: 2,
        startedAt: "2026-07-25T00:00:00.500Z",
        state: "succeeded" as const,
      },
    };
    expect(validateServiceStatusV1(impossibleInitialRevision)).toBe(false);
    expect(validateServiceStatusV1Compatible(impossibleInitialRevision)).toBe(false);
    for (const terminalState of [
      { state: "cancelled" as const },
      {
        error: createErrorV1("GRAPH_SCAN_FAILED", "log-initial-after-commit"),
        state: "failed" as const,
      },
      { state: "partial" as const },
    ]) {
      const impossibleInitialAfterCommit = {
        ...cleanAvailableStatus,
        lastIndexJob: {
          ...terminalState,
          baseGraphRevision: null,
          completedAt: "2026-07-25T00:00:03.000Z",
          id: `job-initial-${terminalState.state}-after-commit`,
          kind: "initial-index" as const,
          requestedAt: "2026-07-25T00:00:01.000Z",
          resultGraphRevision: null,
          startedAt: "2026-07-25T00:00:02.000Z",
        },
      };
      expect(validateServiceStatusV1(impossibleInitialAfterCommit)).toBe(false);
      expect(validateServiceStatusV1Compatible(impossibleInitialAfterCommit)).toBe(false);
    }
    expect(validateServiceStatusV1({
      ...status,
      availability: "available",
      committed: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 99,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:02.000Z",
        graphRevision: 1,
        indexedFileCount: 0,
        nodeCount: 0,
      },
      freshness: "current",
      graphRevision: 1,
    })).toBe(false);
    expect(validateJobStartResult({
      accepted: true,
      job: {
        baseGraphRevision: null,
        id: "job-invalid-time",
        kind: "initial-index",
        requestedAt: "2026-02-30T00:00:00.000Z",
        resultGraphRevision: null,
        state: "queued",
      },
    })).toBe(false);
    expect(validateServiceStatusV1({
      ...status,
      lastIndexJob: {
        baseGraphRevision: null,
        completedAt: "2026-07-25T00:00:01.000Z",
        error: createErrorV1("GRAPH_SCAN_FAILED", "log-reversed-time"),
        id: "job-reversed-time",
        kind: "initial-index",
        requestedAt: "2026-07-25T00:00:03.000Z",
        resultGraphRevision: null,
        startedAt: "2026-07-25T00:00:02.000Z",
        state: "failed",
      },
    })).toBe(false);
  });

  it("keeps exported public schemas compilable by strict standard Ajv", () => {
    const publicAjv = new Ajv2020({ strict: true });
    expect(() => publicAjv.compile(serviceStatusV1Schema)).not.toThrow();
    expect(() => publicAjv.compile(jobStartResultV1Schema)).not.toThrow();
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
