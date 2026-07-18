---
type: architecture-review
lens: technology-reality-round14
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十四轮：最终技术现实性复核

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** 本轮收紧的 `RulesSnapshotRef`、无效规则下的 GraphPatch 提交语义、`serviceInstanceId/statusEpoch` 与 epoch 内状态时钟，均可由现有 Node 24、better-sqlite3/SQLite、JSON-RPC/Ajv 技术栈实现；版本、ABI 与 Windows IPC 现实边界保持成立。

## 本轮变更复核

| 检查项 | 技术现实 | 结果 |
| --- | --- | --- |
| `RulesSnapshotRef` | generation、validity 与两个 digest 是普通不可变值对象，可作为 SQLite CAS 条件和 revision 元数据保存 | 通过 |
| 无效 rules 不阻塞 GraphPatch | 单事务可提交图谱差量并推进 graphRevision，同时复制/保留旧 Findings、标记 stale、推进 findingsRevision；不需要运行无效规则 | 通过 |
| 旧 generation 结果失效 | Worker 结果提交前比较完整 `RulesSnapshotRef`，generation 或 validity/digest 不匹配即回滚和重排 | 通过 |
| `serviceInstanceId/statusEpoch` | Node 24 `crypto.randomUUID`/`randomBytes` 可生成非秘密实例标识；状态计数器只需 epoch 内单调 | 通过 |
| epoch 切换恢复 | 客户端检测实例/epoch 变化后替换本地状态并全量查询；无需跨进程持久化计数器或事件回放 | 通过 |
| 原子 service metadata | Node `fs` 可在同目录写临时文件并 rename；现有 OS 排他锁继续负责实例互斥 | 通过 |

## 技术实现判断

### RulesSnapshotRef 与 snapshot mutation

- SQLite 事务可以先读取当前 baseGraphRevision 与完整 RulesSnapshotRef，比较后再执行 GraphPatch/Finding 写入和双 revision 推进。
- `validity=invalid` 时沿用最后有效 digest，不调用规则评估器；旧 Finding 只更新为 stale，禁止 resolved，是普通关系数据更新。
- generation 在 rules.yaml 任意变化时推进，使此前 Worker/Job 产出的结果即使 digest 偶然相同也无法错误提交。
- GraphPatch 在无效规则期间继续提交图谱，避免把 YAML 校验错误误变成索引/存储不可用；现有单 mutation channel 足以保持顺序。

### Service epoch 与状态时钟

- `serviceInstanceId`/`statusEpoch` 可在服务取得排他锁后由 Node crypto 生成，并随 metadata、initialize 和 ServiceStatusV1 发布。
- `serviceStatusRevision` 与 `indexStatus.statusRevision` 只要求在同一 epoch 内递增，因此可以使用服务内单写者计数，无需写 SQLite 每次 progress。
- 进程重启或升级产生新 epoch；客户端不比较旧计数并执行 full-refetch，消除了计数器重置造成的错误排序。
- JSON-RPC notification 仍只承担增量提醒；权威恢复来自 `service/status` 完整快照，不需要可靠消息中间件。

### 平台与版本回归

- Stack 精确 pin 未变化；Round9–13 已在同日从官方/npm 源完成版本与 ABI 核验。
- Node 24.18.0 提供 crypto、fs、worker、net IPC 所需能力；better-sqlite3 12.11.1 仍匹配 Node ABI 137 和既定平台矩阵。
- AD-11 仍明确承认 Node/libuv Windows pipe 默认 DACL，并明确不承诺 current-SID-only pipe DACL；随机 endpoint、用户缓存 token 与 token-first 握手仍是应用层补偿。

## Critical / High / Medium Findings

无。

## Research 判断与证据来源

本轮没有新增第三方技术或版本，无需重做宽泛 web research；仅对新增实现点做定点确认：

- Node.js v24 crypto：`https://nodejs.org/docs/latest-v24.x/api/crypto.html`
- Node.js v24 file system：`https://nodejs.org/docs/latest-v24.x/api/fs.html`
- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- SQLite conditional update：`https://www.sqlite.org/lang_update.html`
- better-sqlite3 12.11.1 API：`https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/api.md`
- JSON-RPC 2.0：`https://www.jsonrpc.org/specification`
- Windows Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- 前序技术核验：`review-technology-reality-round9.md` 至 `review-technology-reality-round13.md`
