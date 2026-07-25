/** Story 1.2 稳定错误码。 */
export const SERVICE_ERROR_CODES = [
  "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
  "GRAPH_SCAN_FAILED",
  "GRAPH_SCAN_LIMIT_EXCEEDED",
  "GRAPH_STORE_OPEN_FAILED",
  "GRAPH_WRITE_FAILED",
  "INDEX_JOB_ALREADY_RUNNING",
  "SERVICE_AUTH_FAILED",
  "SERVICE_ENDPOINT_START_FAILED",
  "SERVICE_INITIALIZE_REQUIRED",
  "SERVICE_INVALID_REQUEST",
  "SERVICE_INSTANCE_CONFLICT",
  "SERVICE_LEGACY_CACHE_MIGRATION_REQUIRED",
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
  | "configuration"
  | "indexing"
  | "lifecycle"
  | "protocol"
  | "security"
  | "storage"
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

/** 单个稳定错误码对应的固定协议属性。 */
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
  GRAPH_IGNORE_CONFIG_UNSUPPORTED: {
    category: "configuration",
    message: "当前版本尚不能安全应用 .codegraphignore。",
    retryable: false,
    suggestedAction: "暂时移除 .codegraphignore 并重启服务，或升级到支持该配置的版本后重试。",
  },
  GRAPH_SCAN_FAILED: {
    category: "indexing",
    message: "工作区安全扫描失败。",
    retryable: true,
    suggestedAction: "检查工作区读取权限与安全限制后重试。",
  },
  GRAPH_SCAN_LIMIT_EXCEEDED: {
    category: "indexing",
    message: "工作区扫描超过安全预算。",
    retryable: false,
    suggestedAction: "缩小 indexing root 或排除生成目录后重试。",
  },
  GRAPH_STORE_OPEN_FAILED: {
    category: "storage",
    message: "本地图谱存储无法安全打开或迁移。",
    retryable: true,
    suggestedAction: "检查用户缓存目录空间与权限，并保留故障副本后重试。",
  },
  GRAPH_WRITE_FAILED: {
    category: "storage",
    message: "本地图谱事务写入失败。",
    retryable: true,
    suggestedAction: "检查磁盘空间、占用和权限后重试首次构建。",
  },
  INDEX_JOB_ALREADY_RUNNING: {
    category: "lifecycle",
    message: "当前 indexing root 已有索引 Job 正在执行。",
    retryable: true,
    suggestedAction: "等待当前 Job 结束后再次请求 rebuild。",
  },
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
  SERVICE_LEGACY_CACHE_MIGRATION_REQUIRED: {
    category: "lifecycle",
    message: "检测到无法安全归属到当前物理根的旧版服务缓存。",
    retryable: false,
    suggestedAction: "按 Service Control V1 的“旧版缓存恢复”步骤停止旧服务并备份旧缓存；当前版本不自动迁移旧图谱。",
  },
  SERVICE_METHOD_NOT_FOUND: {
    category: "protocol",
    message: "请求的方法未由当前服务实现。",
    retryable: false,
    suggestedAction: "仅调用 initialize、job/start、service/status 或 service/shutdown。",
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
