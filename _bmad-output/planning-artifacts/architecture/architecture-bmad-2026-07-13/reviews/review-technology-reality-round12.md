---
type: architecture-review
lens: technology-reality-round12
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十二轮：最终技术现实性复核

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** snapshot mutation channel、`ServiceStatusV1`、Git object-format + full commit OID 都可由当前 Node 24、better-sqlite3/SQLite、Git adapter、JSON-RPC/Ajv 技术栈实现；精确版本未变化，Windows IPC 仍明确使用默认 pipe DACL 并以 token-first 协议补偿，没有恢复不可实现的 current-SID-only 承诺。

## 重点复核

| 检查项 | 当前合同 | 技术现实 | 结果 |
| --- | --- | --- | --- |
| snapshot mutation channel | 每 indexing root 单通道串行所有推进 graphRevision 或 findingsRevision 的事务；findings-only evaluation 绑定 baseGraphRevision 与 config digest，并在提交前 CAS | 单 graph-service + SQLite 单写事务天然支持串行提交；better-sqlite3 同步事务与条件校验可在同一事务内完成 CAS，失败后丢弃重算 | 通过 |
| Job result snapshot | queued/running result 为 null；terminal 捕获结束时最新已提交 snapshot；只读 Job 记录实际读取/比较的 snapshot | 服务可以在 Job 状态转 terminal 的同一串行步骤读取当前双 revision；不需要未提交数据库快照或第三方事务协调器 | 通过 |
| `ServiceStatusV1` | `service/status` 与 `service/statusChanged` 共享 `{indexStatus,telemetryStatus,configRevision,viewConfigRevision}`，新连接先全量读取 | JSON-RPC 2.0 同时支持 request/response 与 notification；TypeScript/Ajv 可定义和运行时校验同一 DTO | 通过 |
| `TelemetryStatusV1` | requested/effective revision 与 pending 显式进入 ServiceStatus | graph-service 自有状态机即可维护；不要求 VS Code 或遥测 SDK 提供 pending 状态 | 通过 |
| Git canonical baseRef | workspace-key/subroot + object-format + 解析后的完整 commit OID；branch/tag/短 SHA 仅显示 | Git `rev-parse --verify <ref>^{commit}` 可解析到完整 commit OID，`--show-object-format` 可返回存储 object format；SHA-1/SHA-256 OID 均可作为不透明字符串传输和哈希 | 通过 |
| 版本与 ABI | Stack 精确 pin 未变 | Round9–11 已在同日从官方/npm 源验证；本轮无新第三方绑定，无需重新选型 | 通过 |
| Windows 边界 | 当前用户缓存继承 profile ACL；Node/libuv pipe 使用默认 DACL；随机 endpoint + token-first 握手 | 与 Node 24/libuv 能力一致；全文没有要求公共 API 设置 current-SID-only pipe DACL | 通过 |

## 技术实现判断

### 1. Snapshot mutation 与 CAS

- SQLite 同一时刻只有一个写事务；架构又把所有双 revision 变更收敛到一个 graph-service 和一个 mutation channel，因此不需要分布式锁或多写者协议。
- GraphPatch 与 findings-only evaluation 都可在 `BEGIN` 后读取当前 revision/digest、比较预期值、写入数据并推进 revision；任一条件不匹配即可回滚并重新排队。
- `better-sqlite3@12.11.1` 的同步事务模型不会阻止 Worker 执行分析：Worker 只产出 FactBatch/评估结果，数据库提交仍在服务写通道完成。
- Rules-only evaluation 不推进 graphRevision，但绑定 baseGraphRevision 和规则/config digest，现有 schema 与 Node SHA-256 能力足够，不引入新的存储技术。

### 2. `ServiceStatusV1`

- 初始 `service/status` 用 request/response 提供完整快照，后续 `service/statusChanged` 用 notification 发布变化，符合 JSON-RPC 2.0 的现有消息模型。
- `IndexStatusSummaryV1.statusRevision`、`configRevision` 与 `viewConfigRevision` 是独立项目时钟；它们不要求 JSON-RPC 库理解 revision 语义。
- reconnect 或通知断档时重新读取完整 `ServiceStatusV1`，不依赖消息代理、持久事件总线或服务端历史回放。

### 3. Git full OID

- Git ref、branch、tag 与短 SHA 可先经 `rev-parse --verify ...^{commit}` peel/解析为完整 commit OID，避免移动 ref 或缩写碰撞进入 canonical identity。
- `git rev-parse --show-object-format=storage` 可区分 SHA-1 与 SHA-256 仓库；对不支持该选项的旧 Git，adapter 也可由仓库配置与完整 OID 长度诊断/回退，不影响合同可实现性。
- OID 作为十六进制字符串进入 `baselineId` 输入，Node `crypto` 可与 workspace-key/subroot、rules/config digest 和派生输入一起生成稳定摘要。
- 临时 baseline 仍可保持 request/job-scoped，不需要写入主 SQLite snapshot 或推进主图 revision。

### 4. Windows 与版本回归

- AD-11 保持 Round10 修订：明确承认默认命名管道安全描述符，并明确不承诺 current-SID-only pipe DACL。
- Node 24 runtime、better-sqlite3 Node ABI 137 与 VSIX 目标矩阵没有变化；本轮新增合同不涉及新的 native module 或平台资产。

## Critical / High / Medium Findings

无。

## Research 判断与证据来源

本轮没有新增技术或版本，复用 Round9–11 的同日版本核验；仅对新增合同做官方能力定点确认：

- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- better-sqlite3 12.11.1 API：`https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/api.md`
- JSON-RPC 2.0：`https://www.jsonrpc.org/specification`
- Git rev-parse：`https://git-scm.com/docs/git-rev-parse`
- Git hash transition：`https://git-scm.com/docs/hash-function-transition`
- Windows Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- 前序技术核验：`review-technology-reality-round9.md`、`review-technology-reality-round10.md`、`review-technology-reality-round11.md`
