/** Story 1.2 稳定错误码。 */
export const SERVICE_ERROR_CODES = [
  "SERVICE_AUTH_FAILED",
  "SERVICE_ENDPOINT_START_FAILED",
  "SERVICE_INITIALIZE_REQUIRED",
  "SERVICE_INVALID_REQUEST",
  "SERVICE_INSTANCE_CONFLICT",
  "SERVICE_METHOD_NOT_FOUND",
  "SERVICE_PROTOCOL_INCOMPATIBLE",
  "SERVICE_START_TIMEOUT",
  "SERVICE_WORKSPACE_MISMATCH",
  "SERVICE_WORKSPACE_UNTRUSTED",
] as const;

/** 稳定错误码联合。 */
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

/** 错误类别保持英文稳定值，供客户端自动处理。 */
export type ErrorCategory =
  | "compatibility"
  | "lifecycle"
  | "protocol"
  | "security"
  | "transport";

/** 可序列化、可操作且不包含秘密的协议错误。 */
export interface ErrorV1 {
  category: ErrorCategory;
  code: ServiceErrorCode;
  logId: string;
  message: string;
  retryable: boolean;
  suggestedAction: string;
}

interface ErrorDefinition {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  suggestedAction: string;
}

/** 错误码单点注册表，避免客户端和服务端发明同义错误。 */
export const SERVICE_ERROR_REGISTRY: Readonly<
  Record<ServiceErrorCode, ErrorDefinition>
> = {
  SERVICE_AUTH_FAILED: {
    category: "security",
    message: "服务认证失败。",
    retryable: true,
    suggestedAction: "重新发现服务后再试。",
  },
  SERVICE_ENDPOINT_START_FAILED: {
    category: "transport",
    message: "本地 IPC endpoint 启动失败。",
    retryable: true,
    suggestedAction: "检查当前用户缓存目录权限后重试。",
  },
  SERVICE_INITIALIZE_REQUIRED: {
    category: "protocol",
    message: "连接必须先完成 initialize。",
    retryable: false,
    suggestedAction: "关闭连接并按协议重新初始化。",
  },
  SERVICE_INVALID_REQUEST: {
    category: "protocol",
    message: "控制请求不符合协议定义。",
    retryable: false,
    suggestedAction: "移除未知字段并按当前控制面 Schema 重新发送请求。",
  },
  SERVICE_INSTANCE_CONFLICT: {
    category: "lifecycle",
    message: "无法确认当前工作区的唯一服务实例。",
    retryable: true,
    suggestedAction: "等待现有实例完成启动后重新发现。",
  },
  SERVICE_METHOD_NOT_FOUND: {
    category: "protocol",
    message: "请求的方法未由当前服务实现。",
    retryable: false,
    suggestedAction: "仅调用 initialize、service/status 或 service/shutdown。",
  },
  SERVICE_PROTOCOL_INCOMPATIBLE: {
    category: "compatibility",
    message: "客户端与服务端协议主版本不兼容。",
    retryable: false,
    suggestedAction: "升级或降级客户端，使协议主版本一致。",
  },
  SERVICE_START_TIMEOUT: {
    category: "lifecycle",
    message: "等待服务启动超时。",
    retryable: true,
    suggestedAction: "稍后重新发现服务；若持续失败请检查本地日志。",
  },
  SERVICE_WORKSPACE_MISMATCH: {
    category: "security",
    message: "连接的服务不属于请求的工作区。",
    retryable: false,
    suggestedAction: "关闭连接并重新计算工作区身份。",
  },
  SERVICE_WORKSPACE_UNTRUSTED: {
    category: "security",
    message: "宿主尚未授予工作区信任。",
    retryable: false,
    suggestedAction: "由宿主授予 Workspace Trust 后显式重试。",
  },
};

/**
 * 从稳定注册表构造 ErrorV1。
 *
 * 调用方只能补充已脱敏的人类可读消息，不能传入路径、token 或堆栈。
 */
export function createErrorV1(
  code: ServiceErrorCode,
  logId: string,
  message?: string,
): ErrorV1 {
  const definition = SERVICE_ERROR_REGISTRY[code];
  return {
    category: definition.category,
    code,
    logId,
    message: message ?? definition.message,
    retryable: definition.retryable,
    suggestedAction: definition.suggestedAction,
  };
}
