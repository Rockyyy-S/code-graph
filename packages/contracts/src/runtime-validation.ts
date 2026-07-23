import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { SERVICE_ERROR_REGISTRY, type ErrorV1 } from "./protocol-error.js";
import type {
  CompatibleInitializeResult,
  InitializeRequest,
  InitializeResult,
  ServiceControlRequest,
  ShutdownResult,
} from "./service-control.js";
import {
  errorV1Schema,
  initializeRequestSchema,
  initializeResultCompatibleSchema,
  initializeResultSchema,
  serviceMetadataV1Schema,
  serviceControlRequestSchema,
  serviceStatusV1CompatibleSchema,
  serviceStatusV1Schema,
  shutdownResultCompatibleSchema,
  shutdownResultSchema,
} from "./service-control-schema.js";
import type { ServiceMetadataV1 } from "./service-metadata.js";
import type { ServiceStatusV1 } from "./service-status.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });

const initializeRequestValidator: ValidateFunction<unknown> =
  ajv.compile(initializeRequestSchema);
const initializeResultValidator: ValidateFunction<unknown> =
  ajv.compile(initializeResultSchema);
const initializeResultCompatibleValidator: ValidateFunction<unknown> =
  ajv.compile(initializeResultCompatibleSchema);
const serviceStatusValidator: ValidateFunction<unknown> =
  ajv.compile(serviceStatusV1Schema);
const serviceStatusCompatibleValidator: ValidateFunction<unknown> =
  ajv.compile(serviceStatusV1CompatibleSchema);
const serviceMetadataValidator: ValidateFunction<unknown> =
  ajv.compile(serviceMetadataV1Schema);
const errorValidator: ValidateFunction<unknown> = ajv.compile(errorV1Schema);
const serviceControlRequestValidator: ValidateFunction<unknown> =
  ajv.compile(serviceControlRequestSchema);
const shutdownResultValidator: ValidateFunction<unknown> =
  ajv.compile(shutdownResultSchema);
const shutdownResultCompatibleValidator: ValidateFunction<unknown> =
  ajv.compile(shutdownResultCompatibleSchema);

/** 严格校验服务端收到的 initialize 请求。 */
export function validateInitializeRequest(value: unknown): value is InitializeRequest {
  return initializeRequestValidator(value);
}

/** 严格校验服务端生成的 canonical initialize 结果。 */
export function validateInitializeResult(value: unknown): value is InitializeResult {
  return initializeResultValidator(value);
}

/**
 * 兼容校验同一协议主版本的 initialize 结果。
 *
 * 已知必填字段必须合法，但服务端新增的可选响应字段不会导致旧客户端拒绝实例。
 */
export function validateInitializeResultCompatible(
  value: unknown,
): value is CompatibleInitializeResult {
  return initializeResultCompatibleValidator(value) && hasSortedCapabilities(value);
}

/** 严格校验无参数控制请求，拒绝所有未知字段。 */
export function validateServiceControlRequest(
  value: unknown,
): value is ServiceControlRequest {
  return serviceControlRequestValidator(value);
}

/** 严格校验 canonical shutdown 成功响应。 */
export function validateShutdownResult(value: unknown): value is ShutdownResult {
  return shutdownResultValidator(value);
}

/** 兼容校验 shutdown 响应，允许同主版本新增可选字段。 */
export function validateShutdownResultCompatible(value: unknown): value is ShutdownResult {
  return shutdownResultCompatibleValidator(value);
}

/**
 * 校验 JSON-RPC 2.0 请求、通知或响应的顶层信封。
 *
 * 这个边界在消息进入 vscode-jsonrpc 的宽松分派逻辑前使用，因此接收
 * `unknown` 并对 `null`/数组显式 fail-closed。
 */
export function validateJsonRpcV2Envelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") {
    return false;
  }
  const hasId = Object.hasOwn(record, "id");
  const hasMethod = Object.hasOwn(record, "method");
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");
  if (hasMethod) {
    const validRequestId =
      !hasId ||
      typeof record.id === "string" ||
      (typeof record.id === "number" && Number.isFinite(record.id));
    return typeof record.method === "string" && validRequestId && !hasResult && !hasError;
  }
  const validResponseId =
    hasId &&
    (record.id === null ||
      typeof record.id === "string" ||
      (typeof record.id === "number" && Number.isFinite(record.id)));
  const validError =
    !hasError ||
    (typeof record.error === "object" && record.error !== null && !Array.isArray(record.error));
  return validResponseId && hasResult !== hasError && validError;
}

/** 严格校验权威 ServiceStatusV1 快照。 */
export function validateServiceStatusV1(value: unknown): value is ServiceStatusV1 {
  return serviceStatusValidator(value);
}

/** 兼容校验同一协议主版本的状态响应，忽略新增可选字段。 */
export function validateServiceStatusV1Compatible(
  value: unknown,
): value is ServiceStatusV1 {
  return serviceStatusCompatibleValidator(value);
}

/** 严格校验服务发现 metadata，未知版本和字段均会被拒绝。 */
export function validateServiceMetadataV1(value: unknown): value is ServiceMetadataV1 {
  return serviceMetadataValidator(value);
}

/** 严格校验 JSON-RPC error.data 使用的 ErrorV1。 */
export function validateErrorV1(value: unknown): value is ErrorV1 {
  if (!errorValidator(value)) {
    return false;
  }
  const error = value as ErrorV1;
  const definition = SERVICE_ERROR_REGISTRY[error.code];
  return (
    error.category === definition.category &&
    error.retryable === definition.retryable &&
    error.suggestedAction === definition.suggestedAction
  );
}

/** capability 必须保持字面量升序，确保跨进程协商结果确定。 */
function hasSortedCapabilities(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("capabilities" in value)) {
    return false;
  }
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === "string")) {
    return false;
  }
  return capabilities.every(
    (capability, index) => index === 0 || capabilities[index - 1]! < capability,
  );
}
