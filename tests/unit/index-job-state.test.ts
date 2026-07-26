import { describe, expect, it } from "vitest";
import { createErrorV1 } from "../../packages/contracts/src/index.js";
import { createServiceState } from "../../apps/graph-service/src/service-state.js";

describe("index job service state", () => {
  it("distinguishes never built, successful empty, and failed-without-baseline", () => {
    const state = createServiceState({
      committed: null,
      lastJob: null,
      serviceInstanceId: "instance-state-test",
      statusEpoch: "epoch-state-test",
    });
    expect(state.getStatus()).toMatchObject({
      availability: "absent",
      committed: null,
      currentIndexJob: null,
      lastIndexJob: null,
    });

    state.publishQueuedJob({
      baseGraphRevision: null,
      id: "job-empty",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
      resultGraphRevision: null,
      state: "queued",
    });
    state.publishRunningJob("job-empty", "2026-07-25T00:00:01.000Z");
    state.publishSucceededJob("job-empty", {
      builtinRulesVersion: "builtin-ignore-v1",
      edgeCount: 0,
      excludedPathCount: 2,
      generatedAt: "2026-07-25T00:00:02.000Z",
      graphRevision: 1,
      indexedFileCount: 0,
      nodeCount: 1,
    });
    expect(state.getStatus()).toMatchObject({
      availability: "available",
      committed: { indexedFileCount: 0 },
      completeness: "empty",
      currentIndexJob: null,
      freshness: "current",
      graphRevision: 1,
      lastIndexJob: { id: "job-empty", state: "succeeded" },
    });

    const failed = createServiceState({
      committed: null,
      lastJob: null,
      serviceInstanceId: "instance-failed-test",
      statusEpoch: "epoch-failed-test",
    });
    failed.publishQueuedJob({
      baseGraphRevision: null,
      id: "job-failed",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
      resultGraphRevision: null,
      state: "queued",
    });
    failed.publishRunningJob("job-failed", "2026-07-25T00:00:01.000Z");
    failed.publishFailedJob(
      "job-failed",
      "2026-07-25T00:00:02.000Z",
      createErrorV1("GRAPH_SCAN_FAILED", "log-job-failed"),
    );
    expect(failed.getStatus()).toMatchObject({
      availability: "absent",
      committed: null,
      currentIndexJob: null,
      lastIndexJob: {
        error: {
          code: "GRAPH_SCAN_FAILED",
          logId: "log-job-failed",
          suggestedAction: "检查工作区读取权限与安全限制后重试。",
        },
        id: "job-failed",
        state: "failed",
      },
    });
  });

  it("increments both status revisions atomically for every published transition", () => {
    const state = createServiceState({
      committed: null,
      lastJob: null,
      serviceInstanceId: "instance-revision-test",
      statusEpoch: "epoch-revision-test",
    });
    const initial = state.getStatus();
    state.publishQueuedJob({
      baseGraphRevision: null,
      id: "job-revision",
      kind: "initial-index",
      requestedAt: "2026-07-25T00:00:00.000Z",
      resultGraphRevision: null,
      state: "queued",
    });
    const queued = state.getStatus();
    expect(queued.statusRevision).toBe(initial.statusRevision + 1);
    expect(queued.serviceStatusRevision).toBe(initial.serviceStatusRevision + 1);
    expect(queued.graphRevision).toBeNull();
  });
});
