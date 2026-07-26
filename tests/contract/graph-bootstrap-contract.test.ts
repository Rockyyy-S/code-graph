import { describe, expect, it } from "vitest";
import {
  SERVICE_CAPABILITIES,
  SERVICE_ERROR_CODES,
  validateErrorV1,
  validateJobStartRequest,
  validateJobStartResult,
  validateServiceStatusV1,
} from "../../packages/contracts/src/index.js";

/** 创建公共首次 Job 的最小成功结果。 */
function createQueuedResult() {
  return {
    accepted: true as const,
    job: {
      baseGraphRevision: null,
      id: "job-contract",
      kind: "initial-index" as const,
      requestedAt: "2026-07-25T00:00:00.000Z",
      resultGraphRevision: null,
      state: "queued" as const,
    },
  };
}

describe("graph bootstrap public contract", () => {
  it("publishes job/start as a closed capability and validates its DTOs", () => {
    expect(SERVICE_CAPABILITIES).toEqual([
      "job/start",
      "service/shutdown",
      "service/status",
    ]);
    expect(validateJobStartRequest({ kind: "rebuild" })).toBe(true);
    expect(validateJobStartRequest({ kind: "initial-index" })).toBe(false);
    expect(validateJobStartRequest({ kind: "rebuild", root: "C:\\secret" })).toBe(false);
    expect(validateJobStartResult(createQueuedResult())).toBe(true);
    expect(validateJobStartResult({ ...createQueuedResult(), path: "/secret" })).toBe(false);
  });

  it("validates absent failure and committed empty statuses without fake revisions", () => {
    const base = {
      configRevision: 1,
      lifecycle: "running" as const,
      serviceInstanceId: "instance-contract",
      serviceStatusRevision: 4,
      statusEpoch: "epoch-contract",
      statusRevision: 4,
      telemetry: { effective: "off" as const, pending: false, requested: "off" as const },
      version: 1 as const,
      viewConfigRevision: 1,
    };
    expect(validateServiceStatusV1({
      ...base,
      availability: "absent",
      committed: null,
      completeness: "empty",
      currentIndexJob: null,
      freshness: null,
      graphRevision: null,
      lastIndexJob: null,
    })).toBe(true);
    expect(validateServiceStatusV1({
      ...base,
      availability: "available",
      committed: {
        builtinRulesVersion: "builtin-ignore-v1",
        edgeCount: 0,
        excludedPathCount: 0,
        generatedAt: "2026-07-25T00:00:00.000Z",
        graphRevision: 1,
        indexedFileCount: 0,
        nodeCount: 1,
      },
      completeness: "empty",
      currentIndexJob: null,
      freshness: "current",
      graphRevision: 1,
      lastIndexJob: {
        baseGraphRevision: null,
        completedAt: "2026-07-25T00:00:00.000Z",
        id: "job-contract",
        kind: "initial-index",
        requestedAt: "2026-07-24T23:59:58.000Z",
        resultGraphRevision: 1,
        startedAt: "2026-07-24T23:59:59.000Z",
        state: "succeeded",
      },
    })).toBe(true);
  });

  it("registers semantic configuration, storage, scan, and write failures", () => {
    expect(SERVICE_ERROR_CODES).toEqual(expect.arrayContaining([
      "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
      "GRAPH_INPUT_CHANGED_DURING_BUILD",
      "GRAPH_SCAN_FAILED",
      "GRAPH_SCAN_LIMIT_EXCEEDED",
      "GRAPH_STORE_OPEN_FAILED",
      "GRAPH_WRITE_FAILED",
      "INDEX_JOB_ALREADY_RUNNING",
      "SERVICE_LEGACY_CACHE_MIGRATION_REQUIRED",
    ]));
    expect(validateErrorV1({
      category: "configuration",
      code: "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
      logId: "log-ignore",
      message: "当前版本尚不能安全应用 .codegraphignore。",
      retryable: false,
      suggestedAction: "暂时移除 .codegraphignore 并重启服务，或升级到支持该配置的版本后重试。",
    })).toBe(true);
  });
});
