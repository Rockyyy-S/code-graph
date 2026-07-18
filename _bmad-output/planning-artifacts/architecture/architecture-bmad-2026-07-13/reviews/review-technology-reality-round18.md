---
type: architecture-review
lens: technology-reality-round18
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十八轮：Lossy Watcher 与 Reconciliation 技术复核

## Verdict

**PASS。Round17 的 Medium 已闭合，未发现剩余 critical/high/medium。** 当前 spine 明确把 Node/VS Code watcher 定义为可能丢失、重复或乱序的变更提示，不再把 generation 静止等同于文件系统强一致；5 分钟有界 reconciliation、显式命令前对账、首 commit 全 bootstrap read-set rehash 与 `EffectiveIgnoreSnapshotV1` 均可由现有 Node 24/TypeScript/SQLite 栈实现，且没有引入新的不现实保证。

## Round17 Finding 闭合

| Round17 问题 | 当前修订 | 结果 |
| --- | --- | --- |
| watcher generation 只能排序已送达事件 | AD-8 明确 watcher 可能丢失、重复、乱序，且绝不作为文件系统强一致证明 | 闭合 |
| 静默丢失无法由 overflow 触发恢复 | 有客户端时每次对账完成后最多 5 分钟启动下一次；rebuild/check/impact/export 前强制完成或复用对账 | 闭合 |
| 首个 bootstrap Job 可能基于漏事件旧快照提交 | 首个 mutation commit 绑定 bootstrapGeneration，并在提交前重新 hash 完整 bootstrap read-set；差异即失效重排 | 闭合 |
| `current` 容易被理解为实时线性一致 | 当前明确表示匹配最近一次完成的内容对账，并允许之后静默变化在下一次有界对账前短暂未观测 | 闭合 |

## 重点技术现实性复核

### 1. Lossy watcher 表述

- Node 24 官方明确 `fs.watch` 非跨平台 100% 一致；当前规则与该现实一致。
- watcher-first 仍有价值：消除“扫描结束后才开始监听”的确定性盲区，并为已送达事件提供 generation/order/coalescing。
- 扫描期事件只作为候选，服务重新读取文件并以内容 hash 为真相；该模式不依赖 watcher 提供事件正文或完整顺序。

### 2. 五分钟有界 reconciliation

- Node timers 可在一次 reconciliation 完成后安排下一次，避免 scan 重叠；有客户端连接时维持 cadence，无客户端时可按现有 5 分钟 idle shutdown 退出。
- Node fs/promises、目录遍历、stat/read 与 crypto SHA-256 足以实现 manifest/content reconciliation。
- 现有限制最多 20000 个候选源码文件，标准规模 5000 文件/500000 LOC；五分钟 cadence 是可实现的运营约束，不要求 OS journal 或常驻外部 daemon。
- 扫描时间若变长，规则是“完成后至多五分钟启动下一次”而非“每五分钟必须完成”，因此没有建立无法保证的硬完成时限。

### 3. 显式命令前对账

- rebuild/check/impact/export 都已是服务 Job；在 enqueue/执行前插入或复用 reconciliation barrier 是普通队列依赖。
- CLI/VS Code 客户端不需要自行扫描；graph-service 统一生成 ManifestSnapshot、AnalyzerConfigSnapshot、EffectiveIgnoreSnapshotV1 与 RulesSnapshotRef。
- 对账失败可沿用 Job failed/diagnostic 合同，不要求读取未提交或不一致 snapshot。

### 4. 首 commit full read-set rehash

- bootstrap scan 已保存 path/contentHash read-set；首 commit 前重新读取并 SHA-256 全集合，比较后推进或作废 bootstrapGeneration，可由 Node fs + crypto 实现。
- rehash 发生在 SQLite 写事务前的安全点，避免长文件 IO 持有数据库写锁；比较成功后 transaction 仍对 generation/snapshots 做 CAS。
- 文件可在 rehash 后再次变化，但架构不再声称获得原子文件系统快照：watcher 或下一次有界 reconciliation 负责最终发现，`current` 语义也已按最近完成对账限定。

### 5. `EffectiveIgnoreSnapshotV1`

- UTF-8 严格解码可使用 Node `TextDecoder(...,{fatal:true})`；逐行 parser 与规范 slash/case-sensitive path matcher 可用 TypeScript 实现。
- `*`/`?` 单段、`**` 跨段、前导 `/`、尾随 `/`、反选和 last-match-wins 是明确的自有有限语法，不要求 Git/minimatch 完全兼容。
- graph-service 是原文件唯一解释者，避免 scanner/analyzer/CLI/UI 依赖不同 glob 库。
- absent generation 0、existing generation 1+、contentHash、ordered normalizedRules 与 RFC 8785 digest 均可由 Node crypto/JSON contract 实现。
- generation/digest 进入 bootstrap、AnalyzerConfigSnapshot 与 SQLite mutation CAS，不需要新的数据库类型或事务能力。

## 版本与平台回归

- Round16 已重新在线核验全部 Stack pins、Node 24.18.0 ABI 137、better-sqlite3 12.11.1 平台资产、VS Code 1.125 与 TypeScript 6.0.3 API；本轮没有改动技术栈。
- Windows IPC 仍明确使用 Node/libuv 默认 pipe DACL，不承诺 current-SID-only pipe DACL。
- watcher/reconciliation 修订只使用已有 Node fs、crypto、timers、TypeScript DTO 与 SQLite transaction，没有新增 native dependency。

## Critical / High / Medium Findings

无。

## 证据来源

- Node.js v24 `fs.watch` caveats：`https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener`
- Node.js v24 fs/promises：`https://nodejs.org/docs/latest-v24.x/api/fs.html`
- Node.js v24 crypto：`https://nodejs.org/docs/latest-v24.x/api/crypto.html`
- Node.js v24 timers：`https://nodejs.org/docs/latest-v24.x/api/timers.html`
- Node.js v24 TextDecoder：`https://nodejs.org/docs/latest-v24.x/api/util.html`
- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- Round16 全版本/ABI/平台核验：`review-technology-reality-round16.md`
- Round17 watcher finding：`review-technology-reality-round17.md`
