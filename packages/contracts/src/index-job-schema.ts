import { errorV1Schema } from "./protocol-error-schema.js";

const nonNegativeCountSchema = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 0,
  type: "integer",
} as const;

const positiveGraphRevisionSchema = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: 1,
  type: "integer",
} as const;

const nullableGraphRevisionSchema = {
  anyOf: [{ type: "null" }, positiveGraphRevisionSchema],
} as const;

const timestampSchema = {
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
  type: "string",
} as const;

const jobIdentityProperties = {
  baseGraphRevision: nullableGraphRevisionSchema,
  id: { minLength: 1, type: "string" },
  kind: { enum: ["initial-index", "rebuild"] },
  requestedAt: timestampSchema,
} as const;

/** 确定性层级提交摘要的严格 Schema。 */
export const indexCommitSummaryV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    builtinRulesVersion: { const: "builtin-ignore-v1" },
    edgeCount: nonNegativeCountSchema,
    excludedPathCount: nonNegativeCountSchema,
    generatedAt: timestampSchema,
    graphRevision: positiveGraphRevisionSchema,
    indexedFileCount: nonNegativeCountSchema,
    nodeCount: nonNegativeCountSchema,
  },
  required: [
    "builtinRulesVersion",
    "edgeCount",
    "excludedPathCount",
    "generatedAt",
    "graphRevision",
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
    resultGraphRevision: { type: "null" },
    state: { const: "queued" },
  },
  required: [
    "baseGraphRevision",
    "id",
    "kind",
    "requestedAt",
    "resultGraphRevision",
    "state",
  ],
  type: "object",
} as const;

/** running Job 的严格 Schema。 */
export const runningIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    resultGraphRevision: { type: "null" },
    startedAt: timestampSchema,
    state: { const: "running" },
  },
  required: [
    "baseGraphRevision",
    "id",
    "kind",
    "requestedAt",
    "resultGraphRevision",
    "startedAt",
    "state",
  ],
  type: "object",
} as const;

/** succeeded Job 的严格 Schema。 */
export const succeededIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    completedAt: timestampSchema,
    resultGraphRevision: positiveGraphRevisionSchema,
    startedAt: timestampSchema,
    state: { const: "succeeded" },
  },
  required: [
    "baseGraphRevision",
    "completedAt",
    "id",
    "kind",
    "requestedAt",
    "resultGraphRevision",
    "startedAt",
    "state",
  ],
  type: "object",
} as const;

/** failed Job 的严格 Schema。 */
export const failedIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    completedAt: timestampSchema,
    error: errorV1Schema,
    resultGraphRevision: nullableGraphRevisionSchema,
    startedAt: timestampSchema,
    state: { const: "failed" },
  },
  required: [
    "baseGraphRevision",
    "completedAt",
    "error",
    "id",
    "kind",
    "requestedAt",
    "resultGraphRevision",
    "startedAt",
    "state",
  ],
  type: "object",
} as const;

/** partial Job 的严格 Schema。 */
export const partialIndexJobV1Schema = {
  additionalProperties: false,
  properties: {
    ...jobIdentityProperties,
    completedAt: timestampSchema,
    resultGraphRevision: nullableGraphRevisionSchema,
    startedAt: timestampSchema,
    state: { const: "partial" },
  },
  required: [
    "baseGraphRevision",
    "completedAt",
    "id",
    "kind",
    "requestedAt",
    "resultGraphRevision",
    "startedAt",
    "state",
  ],
  type: "object",
} as const;

/** cancelled Job 的严格 Schema。 */
export const cancelledIndexJobV1Schema = {
  ...partialIndexJobV1Schema,
  properties: {
    ...partialIndexJobV1Schema.properties,
    state: { const: "cancelled" },
  },
} as const;

/** 任意当前切片 Job 状态的严格联合 Schema。 */
export const indexJobStatusV1Schema = {
  oneOf: [
    queuedIndexJobV1Schema,
    runningIndexJobV1Schema,
    succeededIndexJobV1Schema,
    failedIndexJobV1Schema,
    partialIndexJobV1Schema,
    cancelledIndexJobV1Schema,
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

/** 兼容客户端允许旧 Job 缺少 revision 字段并忽略新增字段。 */
export const jobStartResultV1CompatibleSchema = {
  ...jobStartResultV1Schema,
  additionalProperties: true,
  properties: {
    ...jobStartResultV1Schema.properties,
    job: {
      ...queuedIndexJobV1Schema,
      additionalProperties: true,
      required: ["id", "kind", "requestedAt", "state"],
    },
  },
} as const;
