import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
  type InitializeResult,
  type ServiceStatusV1,
} from "@codegraph/contracts";

/** 当前 graph-service 包版本。 */
export const GRAPH_SERVICE_VERSION = "0.0.0";

/** 初始状态所需的稳定实例身份。 */
export interface InitialServiceStateOptions {
  serviceInstanceId: string;
  statusEpoch: string;
}

/** 空 graph-service 的只读权威状态。 */
export interface EmptyServiceState {
  getStatus: () => ServiceStatusV1;
}

/** 创建合法 absent/null/empty/committed=null 初始状态。 */
export function createInitialServiceState(
  options: InitialServiceStateOptions,
): EmptyServiceState {
  const status: ServiceStatusV1 = Object.freeze({
    availability: "absent",
    committed: null,
    completeness: "empty",
    configRevision: 1,
    freshness: null,
    lifecycle: "running",
    serviceInstanceId: options.serviceInstanceId,
    serviceStatusRevision: 1,
    statusEpoch: options.statusEpoch,
    statusRevision: 1,
    telemetry: Object.freeze({
      effective: "off",
      pending: false,
      requested: "off",
    }),
    version: 1,
    viewConfigRevision: 1,
  });
  return { getStatus: () => status };
}

/** 从权威状态创建严格 canonical initialize 结果。 */
export function createInitializeResult(state: EmptyServiceState): InitializeResult {
  return {
    capabilities: SERVICE_CAPABILITIES,
    cliSchemaVersion: CLI_SCHEMA_VERSION,
    graphSchemaVersion: GRAPH_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    rulesSchemaVersion: RULES_SCHEMA_VERSION,
    serviceStatus: state.getStatus(),
    serviceVersion: GRAPH_SERVICE_VERSION,
  };
}
