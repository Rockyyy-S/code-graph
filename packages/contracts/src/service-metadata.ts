/** graph-service 使用的本机 IPC endpoint 类型。 */
export type ServiceEndpointKind = "named-pipe" | "unix-socket";

/**
 * 公开服务发现 metadata。
 *
 * session token 必须独立存储，不能进入此对象、日志或命令行。
 */
export interface ServiceMetadataV1 {
  createdAt: string;
  endpoint: string;
  endpointKind: ServiceEndpointKind;
  integrity: string;
  pid: number;
  serviceInstanceId: string;
  statusEpoch: string;
  version: 1;
  workspaceKey: string;
}

/** 发布 metadata 前的字段集合；完整性摘要由发布者计算。 */
export type ServiceMetadataPayloadV1 = Omit<ServiceMetadataV1, "integrity">;
