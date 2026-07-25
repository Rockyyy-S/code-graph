/**
 * 公共 CLI 命令的源码权威注册表。
 *
 * 当前 Story 只建立 CLI 包边界，尚未公开命令；后续新增命令必须在此把稳定命令 ID
 * 绑定到真实 handler，并同步 package manifest 与公共能力门禁映射。
 */
export const PUBLIC_COMMANDS = Object.freeze({});
