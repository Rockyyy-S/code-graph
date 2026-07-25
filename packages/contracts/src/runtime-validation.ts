import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { SERVICE_ERROR_REGISTRY, type ErrorV1 } from "./protocol-error.js";
import type {
  CompatibleInitializeResult,
  InitializeRequest,
  InitializeResult,
  JobStartRequest,
  JobStartResult,
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
import {
  jobStartRequestV1Schema,
  jobStartResultV1CompatibleSchema,
  jobStartResultV1Schema,
} from "./index-job-schema.js";
import type { ServiceMetadataV1 } from "./service-metadata.js";
import type {
  CompatibleServiceStatusV1,
  ServiceStatusV1,
} from "./service-status.js";
import {
  gateDefinitionV1Schema,
  gateEvaluationContextV1Schema,
  gateEvidenceV1Schema,
  gateOutputV1Schema,
  gateRegistryV1Schema,
} from "./quality-gate-schema.js";
import {
  computeEvaluationContextDigest,
  computeGateDefinitionDigest,
  computeGateEvidenceDigest,
  type GateDefinitionV1,
  type GateEvaluationContextV1,
  type GateEvidenceV1,
  type GateOutputV1,
  type GateRegistryV1,
} from "./quality-gate.js";

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
const jobStartRequestValidator: ValidateFunction<unknown> =
  ajv.compile(jobStartRequestV1Schema);
const jobStartResultValidator: ValidateFunction<unknown> =
  ajv.compile(jobStartResultV1Schema);
const jobStartResultCompatibleValidator: ValidateFunction<unknown> =
  ajv.compile(jobStartResultV1CompatibleSchema);
const gateDefinitionValidator: ValidateFunction<unknown> =
  ajv.compile(gateDefinitionV1Schema);
const gateRegistryValidator: ValidateFunction<unknown> =
  ajv.compile(gateRegistryV1Schema);
const gateEvaluationContextValidator: ValidateFunction<unknown> =
  ajv.compile(gateEvaluationContextV1Schema);
const gateEvidenceValidator: ValidateFunction<unknown> =
  ajv.compile(gateEvidenceV1Schema);
const gateOutputValidator: ValidateFunction<unknown> =
  ajv.compile(gateOutputV1Schema);

/** 严格校验服务端收到的 initialize 请求。 */
export function validateInitializeRequest(value: unknown): value is InitializeRequest {
  return initializeRequestValidator(value);
}

/** 严格校验服务端生成的 canonical initialize 结果。 */
export function validateInitializeResult(value: unknown): value is InitializeResult {
  return initializeResultValidator(value) && hasValidInitializeServiceStatus(value, false);
}

/**
 * 兼容校验同一协议主版本的 initialize 结果。
 *
 * 已知必填字段必须合法，但服务端新增的可选响应字段不会导致旧客户端拒绝实例。
 */
export function validateInitializeResultCompatible(
  value: unknown,
): value is CompatibleInitializeResult {
  return (
    initializeResultCompatibleValidator(value) &&
    hasSortedCapabilities(value) &&
    hasValidInitializeServiceStatus(value, true)
  );
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

/** 严格校验服务端收到的 job/start 请求。 */
export function validateJobStartRequest(value: unknown): value is JobStartRequest {
  return jobStartRequestValidator(value);
}

/** 严格校验服务端生成的 canonical job/start 响应。 */
export function validateJobStartResult(value: unknown): value is JobStartResult {
  return jobStartResultValidator(value) && hasValidJobStartTimestamp(value);
}

/** 兼容校验 job/start 响应，允许同主版本新增可选字段。 */
export function validateJobStartResultCompatible(value: unknown): value is JobStartResult {
  return jobStartResultCompatibleValidator(value) && hasValidJobStartTimestamp(value);
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
  return (
    serviceStatusValidator(value) &&
    hasLegalServiceStatusCombination(value) &&
    hasValidNestedJobError(value) &&
    hasValidServiceStatusTimestamps(value)
  );
}

/** 兼容校验同一协议主版本的状态响应，忽略新增可选字段。 */
export function validateServiceStatusV1Compatible(
  value: unknown,
): value is CompatibleServiceStatusV1 {
  return (
    serviceStatusCompatibleValidator(value) &&
    hasLegalServiceStatusCombination(value) &&
    hasValidNestedJobError(value, true) &&
    hasValidServiceStatusTimestamps(value)
  );
}

/** 将旧 v1 缺失的 Job 字段补为 null，向客户端暴露完整的当前 ServiceStatusV1。 */
export function normalizeServiceStatusV1Compatible(
  value: unknown,
): ServiceStatusV1 | null {
  if (!validateServiceStatusV1Compatible(value)) {
    return null;
  }
  return {
    ...value,
    currentIndexJob: value.currentIndexJob ?? null,
    lastIndexJob: value.lastIndexJob ?? null,
  };
}

/** initialize 结果必须复用完整的嵌套 ServiceStatus 语义校验。 */
function hasValidInitializeServiceStatus(value: unknown, compatible: boolean): boolean {
  if (typeof value !== "object" || value === null || !("serviceStatus" in value)) {
    return false;
  }
  const valid = compatible
    ? validateServiceStatusV1Compatible(value.serviceStatus)
    : validateServiceStatusV1(value.serviceStatus);
  if (!valid || !compatible || !("capabilities" in value) || !Array.isArray(value.capabilities)) {
    return valid;
  }
  return !value.capabilities.includes("job/start") || hasExplicitJobStatusFields(value.serviceStatus);
}

/** 失败 Job 的 ErrorV1 不只满足形状，还必须与稳定注册表语义一致。 */
function hasValidNestedJobError(value: unknown, allowMissing = false): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("lastIndexJob" in value)) {
    return allowMissing;
  }
  const lastJob = value.lastIndexJob;
  if (
    typeof lastJob !== "object" ||
    lastJob === null ||
    !("state" in lastJob) ||
    lastJob.state !== "failed"
  ) {
    return true;
  }
  return "error" in lastJob && validateErrorV1(lastJob.error);
}

/** 阻止 absent/available、空摘要与完整度之间出现互相矛盾的组合。 */
function hasLegalServiceStatusCombination(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const status = value as ServiceStatusV1;
  if (status.availability === "absent") {
    return status.committed === null && status.freshness === null && status.completeness === "empty";
  }
  if (status.committed === null || status.freshness !== "fresh") {
    return false;
  }
  if (!hasLegalHierarchySummary(status.committed)) {
    return false;
  }
  return status.committed.indexedFileCount === 0
    ? status.completeness === "empty"
    : status.completeness === "complete";
}

/** hierarchy 是一棵含 workspace 根的树，摘要计数必须保持最小结构不变量。 */
function hasLegalHierarchySummary(summary: ServiceStatusV1["committed"]): boolean {
  return (
    summary !== null &&
    summary.nodeCount >= summary.indexedFileCount + 1 &&
    summary.edgeCount === summary.nodeCount - 1
  );
}

/** `job/start` 的 queued Job 必须携带真实存在的 UTC 日历时间。 */
function hasValidJobStartTimestamp(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("job" in value)) {
    return false;
  }
  return hasValidJobTimestamps(value.job);
}

/** 对服务状态中的提交摘要和可选 Job 执行 Schema 之外的真实日历校验。 */
function hasValidServiceStatusTimestamps(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const status = value as {
    committed?: { generatedAt?: unknown } | null;
    currentIndexJob?: unknown;
    lastIndexJob?: unknown;
  };
  const timestampsValid = (
    (status.committed === null ||
      (status.committed !== undefined &&
        typeof status.committed.generatedAt === "string" &&
        isCanonicalUtcTimestamp(status.committed.generatedAt))) &&
    (status.currentIndexJob === undefined ||
      status.currentIndexJob === null ||
      hasValidJobTimestamps(status.currentIndexJob)) &&
    (status.lastIndexJob === undefined ||
      status.lastIndexJob === null ||
      hasValidJobTimestamps(status.lastIndexJob))
  );
  if (!timestampsValid) {
    return false;
  }
  if (
    status.committed !== null &&
    status.committed !== undefined &&
    typeof status.lastIndexJob === "object" &&
    status.lastIndexJob !== null &&
    "state" in status.lastIndexJob &&
    status.lastIndexJob.state === "succeeded"
  ) {
    return (
      "completedAt" in status.lastIndexJob &&
      status.lastIndexJob.completedAt === status.committed.generatedAt
    );
  }
  return true;
}

/** 校验任意已通过 Job Schema 的时间字段，缺失字段由具体状态 Schema 决定是否合法。 */
function hasValidJobTimestamps(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const job = value as Record<string, unknown>;
  for (const field of ["requestedAt", "startedAt", "completedAt"] as const) {
    if (
      field in job &&
      (typeof job[field] !== "string" || !isCanonicalUtcTimestamp(job[field]))
    ) {
      return false;
    }
  }
  const requestedAt = typeof job.requestedAt === "string" ? Date.parse(job.requestedAt) : null;
  const startedAt = typeof job.startedAt === "string" ? Date.parse(job.startedAt) : null;
  const completedAt = typeof job.completedAt === "string" ? Date.parse(job.completedAt) : null;
  if (requestedAt !== null && startedAt !== null && requestedAt > startedAt) {
    return false;
  }
  if (startedAt !== null && completedAt !== null && startedAt > completedAt) {
    return false;
  }
  return true;
}

/** 声明公共 job/start 的服务必须显式提供两项 Job 状态，不能套用 Story 1.2 默认值。 */
function hasExplicitJobStatusFields(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "currentIndexJob") &&
    Object.hasOwn(value, "lastIndexJob")
  );
}

/** 接受秒或毫秒精度的真实 UTC 时间，并拒绝日期溢出与本地时区形式。 */
function isCanonicalUtcTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/u.exec(value);
  if (match === null) {
    return false;
  }
  const canonical = match[2] === undefined ? `${match[1]}.000Z` : value;
  const parsed = new Date(canonical);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === canonical;
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

/** 严格校验 GateDefinitionV1 的 Schema、producer 绑定与 trigger glob 规范。 */
export function validateGateDefinitionV1(value: unknown): value is GateDefinitionV1 {
  if (!gateDefinitionValidator(value)) {
    return false;
  }
  const definition = value as GateDefinitionV1;
  if (!definition.evidenceProducerId.endsWith(`#${definition.gateId}`)) {
    return false;
  }
  if (definition.command.some((argument) => argument.trim().length === 0 || argument.includes("\0"))) {
    return false;
  }
  if (isNoOpGateCommand(definition.command)) {
    return false;
  }
  return (
    definition.triggerPaths === undefined ||
    definition.triggerPaths.every(
      (triggerPath, index) =>
        isCanonicalTriggerGlob(triggerPath) &&
        (index === 0 || definition.triggerPaths![index - 1]! < triggerPath),
    )
  );
}

/** 严格校验 GateRegistryV1 的顺序、唯一性与 definition digest。 */
export function validateGateRegistryV1(value: unknown): value is GateRegistryV1 {
  if (!gateRegistryValidator(value)) {
    return false;
  }
  const registry = value as GateRegistryV1;
  const checkIds = new Set<string>();
  return registry.gates.every((entry, index) => {
    const previous = registry.gates[index - 1];
    const checkIdUnique = !checkIds.has(entry.gateDefinition.checkId);
    checkIds.add(entry.gateDefinition.checkId);
    return (
      validateGateDefinitionV1(entry.gateDefinition) &&
      entry.gateDefinitionDigest === computeGateDefinitionDigest(entry.gateDefinition) &&
      checkIdUnique &&
      (previous === undefined ||
        previous.gateDefinition.gateId < entry.gateDefinition.gateId)
    );
  });
}

/** 严格校验封闭 GateOutputV1。 */
export function validateGateOutputV1(value: unknown): value is GateOutputV1 {
  return gateOutputValidator(value);
}

/** 严格校验固定 Git OID 与 evaluationContextDigest。 */
export function validateGateEvaluationContextV1(
  value: unknown,
): value is GateEvaluationContextV1 {
  if (!gateEvaluationContextValidator(value)) {
    return false;
  }
  const context = value as GateEvaluationContextV1;
  const oidLength = context.objectFormat === "sha1" ? 40 : 64;
  if (
    [context.baseOid, context.comparisonBaseOid, context.headOid].some(
      (oid) => oid.length !== oidLength,
    )
  ) {
    return false;
  }
  const { evaluationContextDigest, ...digestInput } = context;
  return evaluationContextDigest === computeEvaluationContextDigest(digestInput);
}

/** 严格校验 GateEvidenceV1 的 producer/gate 绑定与证据摘要。 */
export function validateGateEvidenceV1(value: unknown): value is GateEvidenceV1 {
  if (!gateEvidenceValidator(value)) {
    return false;
  }
  const evidence = value as GateEvidenceV1;
  if (!evidence.evidenceProducerId.endsWith(`#${evidence.gateId}`)) {
    return false;
  }
  const { gateEvidenceDigest, ...digestInput } = evidence;
  return gateEvidenceDigest === computeGateEvidenceDigest(digestInput);
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

/** trigger glob 必须是仓库内、相对、POSIX 且无反选/逃逸的 canonical 形式。 */
function isCanonicalTriggerGlob(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("!") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("//") ||
    value.endsWith("/") ||
    /[\[\]{}]/u.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

/** 公共 GateDefinition validator 与运行时 registry loader 共享 no-op 语义。 */
function isNoOpGateCommand(command: readonly string[]): boolean {
  const executable = command[0]!
    .split(/[\\/]/u)
    .at(-1)!
    .toLowerCase()
    .replace(/\.exe$/u, "");
  if (["echo", "printf", "true"].includes(executable)) {
    return true;
  }
  return (
    executable === "node" &&
    command.slice(1).some(
      (argument) => /^(?:-e|-p).*/u.test(argument) || /^--(?:eval|print)(?:=|$)/u.test(argument),
    )
  );
}
