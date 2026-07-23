/** @file 导出工作区身份、IPC 连接与受信任启动器公共边界。 */
export * from "./errors.js";
export {
  GraphServiceConnection,
  connectToGraphService,
  type ConnectToGraphServiceOptions,
  type WorkspaceTrustGate,
} from "./connection.js";
export * from "./launcher.js";
export * from "./workspace-identity.js";
