---
type: architecture-review
lens: technology-reality-round11
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十一轮：最终技术现实性复核

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** 本轮加入的 `statusRevision`、telemetry pending/latest-wins、Git comparison baseline 与 export policy 都是现有 Node 24、TypeScript、Git adapter、JSON-RPC/Ajv 和 VS Code 1.125 能实现的项目自有合同；AD-11 仍明确承认 Node/libuv 默认命名管道安全描述符，没有重新引入 current-SID-only pipe DACL 承诺。

## 重点复核

| 检查项 | 当前合同 | 技术现实 | 结果 |
| --- | --- | --- | --- |
| `statusRevision` | 任何 Job、progress、lifecycle 或 committed summary 可观察变化均推进；view patch 携带 base/next status revision | graph-service 可用单写者内存状态与事件发布维护独立单调时钟；JSON-RPC/Ajv 可传输和校验该字段，不依赖 VS Code 状态 API | 通过 |
| GraphView patch 三时钟 | delta 同时校验 graph/findings/status revision，断档时 invalidate 并全量重取 | 客户端一次性验证并替换不可变 ViewModel 是普通 TypeScript 状态管理；不要求渲染器支持事务 | 通过 |
| telemetry pending | requested/effective 分离，服务接收顺序 latest-wins；off 取消更早 pending-on，on 仅在仍为最新请求时于 Job 边界启用 | 单一 graph-service 可用 `configRevision`、pending record 和临界区实现；Noop port 切换、缓冲丢弃及延迟响应均不要求遥测 SDK 提供同名能力 | 通过 |
| Git baseline | comparison context 携带 baseRef、baselineId 与派生 revision；临时基线不推进主图 revision | `git-local` adapter 可用 Git 的 `rev-parse`、`diff`、`cat-file`/临时 worktree 读取基线；Node 24 `child_process`、缓存目录和现有 TS 分析器足够，基线结果可保持 request/job-scoped | 通过 |
| Export policy | requested/effective policy 只允许 structure-only/include-source，effective 只能相同或更严格；服务生成不可变 artifact，extension 执行 clipboard/原子文件写入 | 自有判别/枚举合同可由 TypeScript/Ajv 实现；VS Code 1.125 提供 `env.clipboard.writeText`，Node `fs` 可执行同目录临时文件加 rename；无需新增云端或权限 API | 通过 |
| Windows IPC | 默认 pipe DACL 被明确承认；安全边界为用户缓存 token、随机 endpoint、token-first 握手及失败握手限制 | 与 Node 24/libuv 当前能力一致；全文未出现仅当前 SID 的可验收承诺 | 通过 |

## 详细判断

### 1. `statusRevision`

- graph、Findings 与运行状态变化频率不同，单独增加 `statusRevision` 是可实现的服务时钟，不要求 SQLite 为每次 progress 更新提交事务。
- `statusRevision` 可以由服务单写者在内存中推进并随状态事件广播；需要恢复时，首次连接以完整 `service/status` 为权威，不依赖跨服务重启连续。
- `GraphViewPatchV1` 不能覆盖精确断档时退化为 `invalidate`，避免依赖不存在的历史事件回放能力。

### 2. telemetry pending/latest-wins

- Node 服务可按接收次序分配 `configRevision`，并在一个串行协调器中保存最新 telemetry 请求。
- `off` 在同一临界区撤销 pending-on、切换 Noop 与丢弃缓冲；后到请求通过 revision 比较决定是否仍有效，技术上不存在竞态无法表达的问题。
- JSON-RPC 请求可以异步完成；pending-on 等待 Job 边界后再返回 effective state 是协议允许的行为。

### 3. Git comparison baseline

- 稳定 `baselineId` 可由规范 commit/baseRef、规则/config digest 与实际派生输入哈希生成；Node `crypto` 已在现有栈中。
- 基线分析可以在 OS 用户缓存的临时目录或只读 blob 流上运行，结果属于 impact/check Job，不需要写入规范 SQLite 图谱或推进 graph/findings revision。
- Git 不可用、baseRef 无效或浅克隆缺对象时可通过现有稳定 diagnostic/Job failed 合同返回；这不要求架构增加新的图谱状态。

### 4. Export policy

- `effectivePolicy` 收紧为 structure-only、`containsSource` 从实际 artifact 生成路径推导，均可在 exporter 组合 artifact 时确定。
- 绝对目标只留在 extension，服务线协议和 Webview 均不需要文件系统写权限或绝对路径。
- 目标写入失败后保留不可变 artifact，重试 clipboard/文件目标不要求重新生成或重新索引。

### 5. Windows ACL 回归检查

- AD-11 唯一相关表述仍是“Windows 缓存继承用户配置文件 ACL；Node 24/libuv pipe 使用默认安全描述符；不承诺 current-SID-only pipe DACL”。
- 随机 endpoint 与 token 被描述为应用层补偿控制，没有被错误描述为 OS DACL 等价物。

## Critical / High / Medium Findings

无。

## Research 判断与证据来源

本轮技术栈与精确版本未变化，Round9/10 已在同日完成完整版本与 Windows IPC 官方源核验，因此不需要重新做宽泛 web research。本轮仅对新增能力做定点确认：

- Node.js v24 APIs：`https://nodejs.org/docs/latest-v24.x/api/`
- Node.js child process：`https://nodejs.org/docs/latest-v24.x/api/child_process.html`
- Node.js file system：`https://nodejs.org/docs/latest-v24.x/api/fs.html`
- Git rev-parse：`https://git-scm.com/docs/git-rev-parse`
- Git diff：`https://git-scm.com/docs/git-diff`
- Git cat-file：`https://git-scm.com/docs/git-cat-file`
- VS Code 1.125 API declarations：`https://unpkg.com/@types/vscode@1.125.0/index.d.ts`
- Windows Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- 前序技术核验：`review-technology-reality-round9.md`、`review-technology-reality-round10.md`
