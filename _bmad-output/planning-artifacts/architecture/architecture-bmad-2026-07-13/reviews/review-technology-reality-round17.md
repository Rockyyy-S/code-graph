---
type: architecture-review
lens: technology-reality-round17
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: changes-required
critical: 0
high: 0
medium: 1
---

# Reviewer Gate 第十七轮：Watcher-first Technology Reality

## Verdict

**CHANGES REQUIRED（1 Medium）。** watcher-first 注册、扫描期事件按路径合并、`bootstrapGeneration` 原子发布，以及首个 Job/commit CAS 都能由当前 Node/VS Code/SQLite 栈实现；但 Node `fs.watch` 明确不提供跨平台无丢失事件保证。当前规则若被实现为“只要 watcher generation 静止就证明文件系统与启动快照完全一致”，会把未送达事件误判为已收敛。

## Findings

### MEDIUM-1 — Watcher generation 只能排序已送达事件，不能证明无事件丢失

- **位置：** AD-8、AD-23 的 watcher-first bootstrap。
- **当前规则：** 先注册 source/config/manifest watchers，再扫描；扫描事件按路径合并并重读，直到 watcher generation 与三个 snapshot 在同一 `bootstrapGeneration` 收敛并原子发布；首 Job 与 commit CAS 绑定 generation。
- **技术现实：** Node 24 官方文档明确 `fs.watch` “not 100% consistent across platforms”，并说明在部分文件系统/虚拟化环境不可靠或不可用；Linux/macOS 的 inode replacement 也可能使原 watch 不再报告新 inode 的事件。VS Code watcher 同样建立在宿主文件监听设施上，不能作为独立的强一致事件日志。SQLite CAS 只能比较服务已经知道的 generation/snapshot，无法发现 watcher 从未送达的文件变化。
- **可能后果：** 文件在扫描读过后被修改，而该 watcher event 未送达时，bootstrap 可发布旧 ManifestSnapshot；若首 Job 读取与旧 manifest 一致后文件再次变化且事件仍丢失，基于内存 manifest/bootstrapGeneration 的 CAS 仍可能提交过时 snapshot。原子发布保证服务内一致，但不等价于文件系统原子快照或“lossless watcher”。
- **建议：** 明确 watcher 仍只是候选/提示，并增加一个不依赖事件完整性的恢复不变量：
  1. 把 bootstrap 保证表述为“在已观察事件上收敛，最终由内容重读/对账保证”；
  2. 首个 mutation commit 前对 bootstrap read-set/manifest 做一次文件系统内容或 metadata+contentHash 复核，发现差异即推进 generation 并重排；
  3. 运行期增加有界周期 reconciliation，或在 quiet/关键操作前执行 reconciliation，以覆盖静默丢失而不仅是可检测 overflow；
  4. 若坚持严格无丢失/线性化文件系统快照，则需绑定当前栈之外的 OS journal/snapshot 能力，并定义 overflow/replay 边界。

## 已通过的技术点

| 检查项 | 技术现实 | 结果 |
| --- | --- | --- |
| watcher-first 注册 | Node 24 `fs.watch`/VS Code FileSystemWatcher 可在扫描前启动，源/配置/manifest watcher 可并行注册 | 通过 |
| 扫描期事件合并 | 服务可用 generation counter + path map coalesce，并重新读取内容 hash；不依赖 watcher 提供事件正文 | 通过 |
| `bootstrapGeneration` | 单 graph-service 可在串行协调器/临界区内同时发布 ManifestSnapshot、AnalyzerConfigSnapshot、RulesSnapshotRef 和 generation | 通过 |
| 首 Job CAS | Job 携带 bootstrapGeneration，SQLite mutation transaction 比较 generation、manifest/rules snapshot 后提交或回滚重排 | 通过 |
| 启动 barrier | lifecycle=starting 时拒绝业务查询/Job dequeue，完成 watcher+scan 后进入 running，可由 JSON-RPC method guard 和服务队列实现 | 通过 |
| epoch/view invalidation | serviceInstanceId/statusEpoch/viewId 可隔离重启前后的 status 与 patch；Node crypto/TypeScript DTO 足够 | 通过 |
| 版本与平台 | Round16 在线核验的所有 Stack pins、Node ABI 137、better-sqlite3 平台资产、VS Code/TS API 均未变化 | 通过 |
| Windows IPC | AD-11 仍承认 Node/libuv 默认 pipe DACL，不包含 current-SID-only 的不可实现承诺 | 通过 |

## 现实边界说明

Watcher-first 是正确的缩小竞态窗口手段：它能避免“先扫描、后注册 watcher”之间必然存在的盲区。path coalescing、重读和 generation CAS 也能闭合所有**已观察**事件的乱序与重复问题。剩余缺口不在 SQLite 或 generation 设计，而在底层 watcher 并非可靠、持久、无丢失事件源。

当前技术栈无需更换即可实现推荐的 eventual reconciliation：Node fs/stat/read/hash、现有 manifest scan 与 Job 队列已经足够。需要修改的是架构保证和触发条件，而不是引入新数据库或消息系统。

## Critical / High Findings

无。

## Medium Findings

1 项：MEDIUM-1。

## 证据来源

- Node.js v24 `fs.watch` caveats：`https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener`
- Node.js v24 fs API JSON：`https://nodejs.org/dist/latest-v24.x/docs/api/fs.json`
- VS Code 1.125 API declarations：`https://unpkg.com/@types/vscode@1.125.0/index.d.ts`
- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- Round16 全版本/ABI/平台核验：`review-technology-reality-round16.md`
