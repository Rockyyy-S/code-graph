import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { ErrorV1 } from "./protocol-error.js";
import type { InitializeRequest, InitializeResult } from "./service-control.js";
import {
  errorV1Schema,
  initializeRequestSchema,
  initializeResultCompatibleSchema,
  initializeResultSchema,
  serviceMetadataV1Schema,
  serviceStatusV1CompatibleSchema,
  serviceStatusV1Schema,
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
): value is InitializeResult {
  return initializeResultCompatibleValidator(value);
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
  return errorValidator(value);
}
