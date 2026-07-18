import type { ServiceStatusV1 } from "./service-status.js";

/** JSON-RPC 线协议主版本；同一主版本通过能力协商保持向后兼容。 */
export const PROTOCOL_VERSION = 1 as const;

/** 图谱持久化 Schema 版本，独立于线协议演进。 */
export const GRAPH_SCHEMA_VERSION = 1 as const;

/** 规则配置 Schema 版本，独立于线协议演进。 */
export const RULES_SCHEMA_VERSION = 1 as const;

/** CLI 输出 Schema 版本，独立于线协议演进。 */
export const CLI_SCHEMA_VERSION = 1 as const;

/** 本 Story 唯一允许声明的可选服务能力，按字面量稳定排序并去重。 */
export const SERVICE_CAPABILITIES = [
  "service/shutdown",
  "service/status",
] as const;

/** 服务端可选控制能力。initialize 是必需方法，因此不在此列表中。 */
export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];

/** 客户端支持的独立 Schema 版本集合。 */
export interface SupportedSchemaVersions {
  cli: number[];
  graph: number[];
  rules: number[];
}

/** initialize 必填参数；认证信息只允许通过已建立的 IPC 连接传递。 */
export interface InitializeRequest {
  clientVersion: string;
  protocolVersion: number;
  sessionToken: string;
  supportedSchemaVersions: SupportedSchemaVersions;
  workspaceKey: string;
}

/** initialize 成功结果，保留四套独立版本并返回权威服务状态。 */
export interface InitializeResult {
  capabilities: readonly ServiceCapability[];
  cliSchemaVersion: number;
  graphSchemaVersion: number;
  protocolVersion: number;
  rulesSchemaVersion: number;
  serviceStatus: ServiceStatusV1;
  serviceVersion: string;
}

/** JSON-RPC 控制方法名。 */
export const SERVICE_METHODS = {
  initialize: "initialize",
  shutdown: "service/shutdown",
  status: "service/status",
} as const;

/** 判断客户端与服务是否属于同一协议主版本。 */
export function isProtocolCompatible(protocolVersion: number): boolean {
  return Number.isInteger(protocolVersion) && protocolVersion === PROTOCOL_VERSION;
}
