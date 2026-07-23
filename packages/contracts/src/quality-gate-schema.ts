const stableIdPattern = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const digestPattern = "^[a-f0-9]{64}$";
const gitOidPattern = "^(?:[a-f0-9]{40}|[a-f0-9]{64})$";
const evidenceProducerPattern =
  "^gha-oidc://[1-9][0-9]*/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml@[a-f0-9]{40}#[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";

const gateDefinitionV1SchemaCore = {
  additionalProperties: false,
  properties: {
    blocking: { type: "boolean" },
    capabilityOwner: {
      enum: ["architecture", "architecture-po", "dev-enablement", "qa", "security"],
    },
    checkId: { pattern: stableIdPattern, type: "string" },
    command: {
      items: { minLength: 1, type: "string" },
      minItems: 1,
      type: "array",
    },
    evidenceProducerId: { pattern: evidenceProducerPattern, type: "string" },
    gateId: { pattern: stableIdPattern, type: "string" },
    triggerPaths: {
      items: { minLength: 1, type: "string" },
      minItems: 1,
      type: "array",
      uniqueItems: true,
    },
  },
  required: [
    "blocking",
    "capabilityOwner",
    "checkId",
    "command",
    "evidenceProducerId",
    "gateId",
  ],
  type: "object",
} as const;

/** GateDefinitionV1 的严格 JSON Schema 2020-12 定义。 */
export const gateDefinitionV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  ...gateDefinitionV1SchemaCore,
} as const;

/** GateRegistryV1 的严格 JSON Schema 2020-12 定义。 */
export const gateRegistryV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    gates: {
      items: {
        additionalProperties: false,
        properties: {
          gateDefinition: gateDefinitionV1SchemaCore,
          gateDefinitionDigest: { pattern: digestPattern, type: "string" },
        },
        required: ["gateDefinition", "gateDefinitionDigest"],
        type: "object",
      },
      minItems: 1,
      type: "array",
    },
    schemaVersion: { const: 1 },
  },
  required: ["gates", "schemaVersion"],
  type: "object",
} as const;

/** GateEvaluationContextV1 的严格 JSON Schema 2020-12 定义。 */
export const gateEvaluationContextV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    baseOid: { pattern: gitOidPattern, type: "string" },
    comparisonBaseOid: { pattern: gitOidPattern, type: "string" },
    evaluationContextDigest: { pattern: digestPattern, type: "string" },
    gateRegistryDigest: { pattern: digestPattern, type: "string" },
    headOid: { pattern: gitOidPattern, type: "string" },
    objectFormat: { enum: ["sha1", "sha256"] },
    providerRepositoryId: { pattern: "^[1-9][0-9]*$", type: "string" },
    schemaVersion: { const: 1 },
  },
  required: [
    "baseOid",
    "comparisonBaseOid",
    "evaluationContextDigest",
    "gateRegistryDigest",
    "headOid",
    "objectFormat",
    "providerRepositoryId",
    "schemaVersion",
  ],
  type: "object",
} as const;

const gateTerminationV1Schema = {
  oneOf: [
    {
      additionalProperties: false,
      properties: {
        code: { minimum: 0, type: "integer" },
        kind: { const: "exit" },
      },
      required: ["code", "kind"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        kind: { const: "signal" },
        signalName: { minLength: 1, type: "string" },
      },
      required: ["kind", "signalName"],
      type: "object",
    },
    {
      additionalProperties: false,
      properties: {
        kind: { const: "spawn-error" },
        stableCode: { minLength: 1, type: "string" },
      },
      required: ["kind", "stableCode"],
      type: "object",
    },
  ],
} as const;

/** GateOutputV1 的严格 JSON Schema 2020-12 定义。 */
export const gateOutputV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    gateId: { pattern: stableIdPattern, type: "string" },
    schemaVersion: { const: 1 },
    stderrBytes: { minimum: 0, type: "integer" },
    stderrDigest: { pattern: digestPattern, type: "string" },
    stderrTruncated: { type: "boolean" },
    stdoutBytes: { minimum: 0, type: "integer" },
    stdoutDigest: { pattern: digestPattern, type: "string" },
    stdoutTruncated: { type: "boolean" },
    termination: gateTerminationV1Schema,
  },
  required: [
    "gateId",
    "schemaVersion",
    "stderrBytes",
    "stderrDigest",
    "stderrTruncated",
    "stdoutBytes",
    "stdoutDigest",
    "stdoutTruncated",
    "termination",
  ],
  type: "object",
} as const;

/** GateEvidenceV1 的严格 JSON Schema 2020-12 定义。 */
export const gateEvidenceV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    evaluationContextDigest: { pattern: digestPattern, type: "string" },
    evidenceProducerId: { pattern: evidenceProducerPattern, type: "string" },
    gateDefinitionDigest: { pattern: digestPattern, type: "string" },
    gateEvidenceDigest: { pattern: digestPattern, type: "string" },
    gateId: { pattern: stableIdPattern, type: "string" },
    headOid: { pattern: gitOidPattern, type: "string" },
    outputDigest: { pattern: digestPattern, type: "string" },
    schemaVersion: { const: 1 },
    status: { enum: ["fail", "invalid", "pass"] },
  },
  required: [
    "evaluationContextDigest",
    "evidenceProducerId",
    "gateDefinitionDigest",
    "gateEvidenceDigest",
    "gateId",
    "headOid",
    "outputDigest",
    "schemaVersion",
    "status",
  ],
  type: "object",
} as const;
