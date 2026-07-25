import { SERVICE_ERROR_CODES } from "./protocol-error.js";

/** ErrorV1 的严格 JSON Schema 2020-12 定义。 */
export const errorV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    category: {
      enum: [
        "compatibility",
        "configuration",
        "indexing",
        "lifecycle",
        "protocol",
        "security",
        "storage",
        "transport",
      ],
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
