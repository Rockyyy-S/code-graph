---
type: architecture-review
lens: technology-reality-round10
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十轮：Windows IPC 修订技术复核

## Verdict

**PASS。未发现剩余 critical/high/medium 技术现实问题。** AD-11 已明确承认 Node 24/libuv 的 Windows 命名管道默认安全描述符，不再承诺当前技术栈无法兑现的 current-SID-only pipe DACL；随机 endpoint、用户缓存中的随机令牌、token-first 握手和失败握手限制均可由现有 Node 24 技术栈实现。

## Round9 High 闭合确认

| Round9 问题 | 当前规则 | 技术现实 | 结果 |
| --- | --- | --- | --- |
| Node/libuv 无法通过公共 API 将 Windows pipe DACL 收紧为仅当前 SID | AD-11 现在明确写明使用默认安全描述符，并明确“不承诺公共 API 无法兑现的 current-SID-only pipe DACL” | 与 Node 24.18.0 `net`/libuv 当前实现一致，不再存在不可实现的 OS ACL 验收承诺 | 闭合 |
| 端点认证边界 | Windows endpoint 使用随机不可猜后缀；任何业务请求前验证缓存中的随机 token、workspace-key、协议版本；限制失败握手 | Node 24 提供 `crypto.randomBytes`、`crypto.timingSafeEqual`、Windows named pipe path 与 stream server；验证和限流是 graph-service 自有状态机 | 通过 |
| token 与 metadata 保密边界 | 放入 OS 当前用户缓存并继承用户配置文件 ACL | Windows `FOLDERID_LocalAppData`/用户配置文件是每用户存储边界；Node 创建子目录和文件时可继承父目录 ACL，不要求 Node 操作 pipe DACL | 通过 |

## 技术实现可行性

### Windows endpoint 与 token

- Node 24 `net.Server.listen(path)` 支持 `\\.\pipe\...` Windows 命名管道；随机后缀只是合法 pipe path 的组成部分，不需要新依赖。
- `crypto.randomBytes()` 可生成 endpoint nonce 与认证 token；`crypto.timingSafeEqual()` 可用于固定长度 token 比较。
- graph-service 可在 `initialize`/握手完成前拒绝所有业务方法；`vscode-jsonrpc@9.0.1` 提供 stream 上的消息连接，不强制在认证前开放业务 handler。
- 失败握手的并发上限、超时、计数与断开均可由 Node server/connection 生命周期实现。
- Windows 默认 pipe DACL 的剩余风险已被架构明确接受并由 token-first 协议补偿；规则没有声称随机 endpoint 或 token 等价于 OS current-SID-only ACL。

### 用户缓存边界

- 缓存、令牌和服务元数据位于当前用户的 OS 缓存目录，与 AD-6 一致。
- 在 Windows 上依赖用户配置文件目录的 ACL 继承是可实现的系统行为；Node 无需为命名管道传入原生 `SECURITY_ATTRIBUTES`。
- 实施时仍应使用独占创建/原子替换、避免把 token 写入日志或线协议诊断；这些属于 AD-11/AD-23 的直接实现细节，不需要增加技术绑定。

## 其余本轮变更复核

| 检查项 | 结论 |
| --- | --- |
| `WorkspaceDiscoverySummary` 判别联合 | JSON Schema 2020-12/Ajv 可表达 `single/recognized/degraded`、`minimum: 1` 与可选 `detectedKind`；不依赖不存在的包管理器 API。 |
| `GraphViewPatchV1 = delta | invalidate` | 自有 contracts DTO；Node/TypeScript/Ajv 均可实现封闭联合、身份校验和客户端原子发布。 |
| `viewConfigRevision` | 服务自有单调 revision；从 `configRevision` 分离不依赖第三方能力，并避免遥测配置无意义地改变 query fingerprint。 |
| telemetry on/off 提交语义 | Noop port 原子切换、缓冲丢弃、revision 广播与 Job 边界启用均是服务内状态机；不存在 SDK 必须提供同名能力的假设。 |
| 精确版本绑定 | Stack 未改变；round9 已在同日从官方发布源/npm Registry 定点验证，本轮没有出现需要重新选型或扩大 web research 的新技术。 |

## Critical / High / Medium Findings

无。

## Research 判断与证据来源

本轮无需重复完整版本研究；仅对修订处做定点确认，未凭训练数据推断能力：

- Node.js v24 crypto API：`https://nodejs.org/docs/latest-v24.x/api/crypto.html`
- Node.js v24 net/IPC API：`https://nodejs.org/docs/latest-v24.x/api/net.html`
- Node.js v24.18.0 `net.js`：`https://github.com/nodejs/node/blob/v24.18.0/lib/net.js`
- Node.js v24.18.0 bundled libuv pipe implementation：`https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/pipe.c`
- Microsoft Known Folder IDs：`https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid`
- Microsoft Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- 前一轮完整版本核验：`review-technology-reality-round9.md`
