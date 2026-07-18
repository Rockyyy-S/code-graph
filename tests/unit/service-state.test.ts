import { describe, expect, it } from "vitest";
import {
  createInitialServiceState,
  createInitializeResult,
} from "../../apps/graph-service/src/service-state.js";
import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  validateInitializeResult,
  validateServiceStatusV1,
} from "../../packages/contracts/src/index.js";

describe("empty graph-service state", () => {
  it("creates the only legal absent baseline without graph claims", () => {
    const state = createInitialServiceState({
      serviceInstanceId: "instance-state-test",
      statusEpoch: "epoch-state-test",
    });
    const status = state.getStatus();

    expect(validateServiceStatusV1(status)).toBe(true);
    expect(status).toMatchObject({
      availability: "absent",
      committed: null,
      completeness: "empty",
      freshness: null,
      lifecycle: "running",
      serviceStatusRevision: 1,
      statusRevision: 1,
      telemetry: { effective: "off", pending: false, requested: "off" },
    });
    expect(status).not.toHaveProperty("graphRevision");
    expect(status).not.toHaveProperty("findingsRevision");
    expect(status).not.toHaveProperty("currentIndexJob");
    expect(status).not.toHaveProperty("lastIndexJob");
  });

  it("returns independent versions and only implemented capabilities", () => {
    const state = createInitialServiceState({
      serviceInstanceId: "instance-result-test",
      statusEpoch: "epoch-result-test",
    });
    const result = createInitializeResult(state);

    expect(validateInitializeResult(result)).toBe(true);
    expect(result).toMatchObject({
      capabilities: SERVICE_CAPABILITIES,
      cliSchemaVersion: CLI_SCHEMA_VERSION,
      graphSchemaVersion: GRAPH_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      rulesSchemaVersion: RULES_SCHEMA_VERSION,
    });
  });
});
