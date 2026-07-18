import { randomUUID } from "node:crypto";
import {
  createErrorV1,
  type ErrorCategory,
  type ErrorV1,
  type ServiceErrorCode,
} from "@codegraph/contracts";

/** service-client 对稳定 ErrorV1 的本地 Error 包装。 */
export class ServiceClientError extends Error implements ErrorV1 {
  public readonly category: ErrorCategory;
  public readonly code: ServiceErrorCode;
  public readonly logId: string;
  public readonly retryable: boolean;
  public readonly suggestedAction: string;

  public constructor(error: ErrorV1) {
    super(error.message);
    this.name = "ServiceClientError";
    this.category = error.category;
    this.code = error.code;
    this.logId = error.logId;
    this.retryable = error.retryable;
    this.suggestedAction = error.suggestedAction;
  }

  /** 返回可安全序列化的 ErrorV1，不暴露本地堆栈。 */
  public toProtocolError(): ErrorV1 {
    return {
      category: this.category,
      code: this.code,
      logId: this.logId,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
    };
  }
}

/** 从稳定注册表创建客户端错误。 */
export function createServiceClientError(
  code: ServiceErrorCode,
  message?: string,
): ServiceClientError {
  return new ServiceClientError(createErrorV1(code, randomUUID(), message));
}
