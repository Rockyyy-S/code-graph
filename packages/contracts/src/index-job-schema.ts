import { errorV1Schema } from "./protocol-error-schema.js";

const nonNegativeCountSchema = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 0,
  type: "integer",
} as const;

const timestampSchema = {
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
  type: "string",
} as const;

const jobIdentityProperties = {
  id: { minLength: 1, type: "string" },
  kind: { enum: ["initial-index", "rebuild"] },
  requestedAt: timestampSchema,
} as const;

/** 首次层级提交摘要的严格 Schema。 */
export const indexCommitSummaryV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    builtinRulesVersion: { const: "builtin-ignore-v1" },
    edgeCount: nonNegativeCountSchema,
    excludedPathCount: nonNegativeCountSchema,
    generatedAt: timestampSchema,
    indexedFileCount: nonNegativeCountSchema,
    nodeCount: nonNegativeCountSchema,
  },
  required: [
    "builtinRulesVersion",
    "edgeCount",
    "excludedPathCount",
    "generatedAt",
    "indexedFileCount",
    "nodeCount",
  ],
  type: "object",
} as const;

/** queued Job 的严格 Schema。 */
export const queuedIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    state: { const: "queued" },
  },
  required: ["id", "kind", "requestedAt", "state"],
  type: "object",
} as const;

/** running Job 的严格 Schema。 */
export const runningIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    startedAt: timestampSchema,
    state: { const: "running" },
  },
  required: ["id", "kind", "requestedAt", "startedAt", "state"],
  type: "object",
} as const;

/** succeeded Job 的严格 Schema。 */
export const succeededIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    completedAt: timestampSchema,
    startedAt: timestampSchema,
    state: { const: "succeeded" },
  },
  required: ["completedAt", "id", "kind", "requestedAt", "startedAt", "state"],
  type: "object",
} as const;

/** failed Job 的严格 Schema。 */
export const failedIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    completedAt: timestampSchema,
    error: errorV1Schema,
    startedAt: timestampSchema,
    state: { const: "failed" },
  },
  required: [
    "completedAt",
    "error",
    "id",
    "kind",
    "requestedAt",
    "startedAt",
    "state",
  ],
  type: "object",
} as const;

/** 任意当前切片 Job 状态的严格联合 Schema。 */
export const indexJobStatusV1Schema = {
  oneOf: [
    queuedIndexJobV1Schema,
    runningIndexJobV1Schema,
    succeededIndexJobV1Schema,
    failedIndexJobV1Schema,
  ],
} as const;

/** `job/start` 封闭请求 Schema。 */
export const jobStartRequestV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    kind: { const: "rebuild" },
  },
  required: ["kind"],
  type: "object",
} as const;

/** `job/start` canonical 响应 Schema。 */
export const jobStartResultV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    accepted: { const: true },
    job: queuedIndexJobV1Schema,
  },
  required: ["accepted", "job"],
  type: "object",
} as const;

/** 兼容客户端允许响应及已知 Job 增加可选字段。 */
export const jobStartResultV1CompatibleSchema = {
  ...jobStartResultV1Schema,
  additionalProperties: true,
  properties: {
    ...jobStartResultV1Schema.properties,
    job: { ...queuedIndexJobV1Schema, additionalProperties: true },
  },
} as const;
