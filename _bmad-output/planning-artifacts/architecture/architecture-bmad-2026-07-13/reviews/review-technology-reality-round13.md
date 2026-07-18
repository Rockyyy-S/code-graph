---
type: architecture-review
lens: technology-reality-round13
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十三轮：最终技术现实性复核

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** 当前 spine 的 rules generation CAS、snapshot mutation、`ServiceStatusV1.serviceStatusRevision`、配置应用边界、Git full OID、export/telemetry 合同均可由既定 Node 24、TypeScript、better-sqlite3/SQLite、JSON-RPC/Ajv、Git adapter 与 VS Code 1.125 技术栈实现；版本和 Windows IPC 边界仍成立。

## 本轮新增/收紧合同复核

| 检查项 | 技术现实 | 结果 |
| --- | --- | --- |
| `rulesConfigGeneration` + `effectiveRulesDigest` CAS | SQLite 事务内可比较 baseGraphRevision、digest 与 generation，再条件写入并推进 findingsRevision；better-sqlite3 同步事务足够，无需分布式 CAS 服务 | 通过 |
| rules 变化使旧结果失效 | graph-service 可在 watcher/reconfigure 事件中先推进 desired generation、标记 status stale；Worker 返回结果提交时发现 generation 不匹配即丢弃重排 | 通过 |
| `serviceStatusRevision` 总排序 | 单一服务可维护每 indexing root 单调计数；任何 index/telemetry/config/viewConfig 变化后生成完整不可变快照，通过 JSON-RPC notification 发布 | 通过 |
| 客户端只接受更高 revision | TypeScript 客户端可直接比较 revision；断档或重连调用 `service/status` 全量读取，不依赖消息历史、broker 或可靠 notification 扩展 | 通过 |
| 配置应用边界 | 一个 `currentIndexJob` 与服务持有队列足以实现“空闲立即应用；否则 terminal 后、下一 dequeue 前应用”；requested/applied revision 分离是自有状态机 | 通过 |
| graph+Findings 状态逐轴合成 | freshness 与 completeness 是纯函数投影，不依赖第三方状态 API；stale 与 partial 独立表达可直接由 DTO/Ajv 校验 | 通过 |

## 全栈现实性回归

### 数据与事务

- 每 indexing root 单 snapshot mutation channel 与 SQLite 单写事务相容。
- GraphPatch 和 findings-only evaluation 都可在同一事务内完成 CAS、写入与 revision 推进；CAS 失败回滚并重排可由现有 Job 队列实现。
- 无效 rules 配置保留旧 Findings、推进 findingsRevision 并标记 stale，是常规版本化 snapshot 写入，不需要 temporal database 或事件溯源框架。

### ServiceStatus 与协议

- JSON-RPC 2.0 原生支持 request/response 和 notification；`service/status` + `service/statusChanged` 不要求 LSP 或额外消息协议。
- `ServiceStatusV1`、`TelemetryStatusV1`、`IndexStatusSummaryV1` 都是 `packages/contracts` 自有 DTO，可由 TypeScript 封闭联合和 Ajv 运行时 schema 校验实现。
- notification 不保证持久投递不是问题：revision 检测与 full status refetch 已明确作为恢复路径。

### 配置与遥测

- latest-wins、pending-on、immediate-off 和明确 Job boundary 均可由单服务串行协调器实现。
- Noop port 切换、停止新事件和清空未发送缓冲仍不依赖特定 telemetry SDK。
- `viewConfigRevision` 与总 `configRevision` 分离，不要求查询引擎或渲染器提供版本功能。

### Git、导出与平台

- Git canonical baseRef 继续使用 object-format 与解析后的完整 commit OID；Git `rev-parse`/object database 能力足够。
- ExportArtifact/policy、clipboard 与同目录临时文件+rename 仍由 VS Code/Node 现有 API 实现。
- Node 24.18.0、better-sqlite3 Node ABI 137、平台 VSIX 目标矩阵未变化。
- AD-11 仍明确使用 Node/libuv 默认 Windows pipe DACL，并明确不承诺 current-SID-only pipe DACL；随机 endpoint、用户缓存 token 与 token-first 握手保持应用层补偿边界。

## Critical / High / Medium Findings

无。

## Research 判断与证据来源

当前精确版本及平台能力已在 Round9–12 同日通过官方发布源/npm Registry 核验；Round13 没有新增第三方技术或版本，不需要重做宽泛 web research。本轮定点确认：

- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- SQLite conditional update：`https://www.sqlite.org/lang_update.html`
- better-sqlite3 12.11.1 API：`https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/api.md`
- JSON-RPC 2.0：`https://www.jsonrpc.org/specification`
- Git rev-parse：`https://git-scm.com/docs/git-rev-parse`
- Node.js v24 APIs：`https://nodejs.org/docs/latest-v24.x/api/`
- Windows Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- 前序技术核验：`review-technology-reality-round9.md` 至 `review-technology-reality-round12.md`
