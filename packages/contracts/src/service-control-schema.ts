import {
  CLI_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RULES_SCHEMA_VERSION,
  SERVICE_CAPABILITIES,
} from "./service-control.js";
import { SERVICE_ERROR_CODES } from "./protocol-error.js";

const positiveRevisionSchema = { minimum: 1, type: "integer" } as const;

/** TelemetryStatusV1 的 JSON Schema 2020-12 定义。 */
export const telemetryStatusV1Schema = {
  additionalProperties: false,
  properties: {
    effective: { const: "off" },
    pending: { const: false },
    requested: { const: "off" },
  },
  required: ["effective", "pending", "requested"],
  type: "object",
} as const;

/** ServiceStatusV1 的严格 canonical JSON Schema 2020-12 定义。 */
export const serviceStatusV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    availability: { const: "absent" },
    committed: { type: "null" },
    completeness: { const: "empty" },
    configRevision: positiveRevisionSchema,
    freshness: { type: "null" },
    lifecycle: { const: "running" },
    serviceInstanceId: { minLength: 1, type: "string" },
    serviceStatusRevision: positiveRevisionSchema,
    statusEpoch: { minLength: 1, type: "string" },
    statusRevision: positiveRevisionSchema,
    telemetry: telemetryStatusV1Schema,
    version: { const: 1 },
    viewConfigRevision: positiveRevisionSchema,
  },
  required: [
    "availability",
    "committed",
    "completeness",
    "configRevision",
    "freshness",
    "lifecycle",
    "serviceInstanceId",
    "serviceStatusRevision",
    "statusEpoch",
    "statusRevision",
    "telemetry",
    "version",
    "viewConfigRevision",
  ],
  type: "object",
} as const;

/** 客户端兼容解析使用的开放 ServiceStatusV1 Schema。 */
export const serviceStatusV1CompatibleSchema = {
  ...serviceStatusV1Schema,
  additionalProperties: true,
  properties: {
    ...serviceStatusV1Schema.properties,
    telemetry: { ...telemetryStatusV1Schema, additionalProperties: true },
  },
} as const;

const supportedVersionListSchema = {
  items: { minimum: 1, type: "integer" },
  minItems: 1,
  type: "array",
  uniqueItems: true,
} as const;

/** InitializeRequest 的严格 JSON Schema 2020-12 定义。 */
export const initializeRequestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    clientVersion: { minLength: 1, type: "string" },
    protocolVersion: { minimum: 1, type: "integer" },
    sessionToken: { minLength: 1, type: "string" },
    supportedSchemaVersions: {
      additionalProperties: false,
      properties: {
        cli: supportedVersionListSchema,
        graph: supportedVersionListSchema,
        rules: supportedVersionListSchema,
      },
      required: ["cli", "graph", "rules"],
      type: "object",
    },
    workspaceKey: { pattern: "^[a-f0-9]{64}$", type: "string" },
  },
  required: [
    "clientVersion",
    "protocolVersion",
    "sessionToken",
    "supportedSchemaVersions",
    "workspaceKey",
  ],
  type: "object",
} as const;

const capabilitiesSchema = {
  items: false,
  maxItems: SERVICE_CAPABILITIES.length,
  minItems: SERVICE_CAPABILITIES.length,
  prefixItems: SERVICE_CAPABILITIES.map((capability) => ({ const: capability })),
  type: "array",
} as const;

/** InitializeResult 的严格 canonical JSON Schema 2020-12 定义。 */
export const initializeResultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    capabilities: capabilitiesSchema,
    cliSchemaVersion: { const: CLI_SCHEMA_VERSION },
    graphSchemaVersion: { const: GRAPH_SCHEMA_VERSION },
    protocolVersion: { const: PROTOCOL_VERSION },
    rulesSchemaVersion: { const: RULES_SCHEMA_VERSION },
    serviceStatus: serviceStatusV1Schema,
    serviceVersion: { minLength: 1, type: "string" },
  },
  required: [
    "capabilities",
    "cliSchemaVersion",
    "graphSchemaVersion",
    "protocolVersion",
    "rulesSchemaVersion",
    "serviceStatus",
    "serviceVersion",
  ],
  type: "object",
} as const;

/** ErrorV1 的严格 JSON Schema 2020-12 定义。 */
export const errorV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    category: {
      enum: ["compatibility", "lifecycle", "protocol", "security", "transport"],
    },
    code: { enum: SERVICE_ERROR_CODES },
    logId: { minLength: 1, type: "string" },
    message: { minLength: 1, type: "string" },
    retryable: { type: "boolean" },
    suggestedAction: { minLength: 1, type: "string" },
  },
  required: [
    "category",
    "code",
    "logId",
    "message",
    "retryable",
    "suggestedAction",
  ],
  type: "object",
} as const;

/** ServiceMetadataV1 的封闭 JSON Schema 2020-12 定义。 */
export const serviceMetadataV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    createdAt: { minLength: 1, type: "string" },
    endpoint: { minLength: 1, type: "string" },
    endpointKind: { enum: ["named-pipe", "unix-socket"] },
    integrity: { pattern: "^sha256:[a-f0-9]{64}$", type: "string" },
    pid: { minimum: 1, type: "integer" },
    serviceInstanceId: { minLength: 1, type: "string" },
    statusEpoch: { minLength: 1, type: "string" },
    version: { const: 1 },
    workspaceKey: { pattern: "^[a-f0-9]{64}$", type: "string" },
  },
  required: [
    "createdAt",
    "endpoint",
    "endpointKind",
    "integrity",
    "pid",
    "serviceInstanceId",
    "statusEpoch",
    "version",
    "workspaceKey",
  ],
  type: "object",
} as const;

/** 客户端兼容解析使用的开放响应 Schema；已知必填字段仍全部校验。 */
export const initializeResultCompatibleSchema = {
  ...initializeResultSchema,
  additionalProperties: true,
  properties: {
    ...initializeResultSchema.properties,
    serviceStatus: {
      ...serviceStatusV1Schema,
      additionalProperties: true,
      properties: {
        ...serviceStatusV1Schema.properties,
        telemetry: { ...telemetryStatusV1Schema, additionalProperties: true },
      },
    },
  },
} as const;
