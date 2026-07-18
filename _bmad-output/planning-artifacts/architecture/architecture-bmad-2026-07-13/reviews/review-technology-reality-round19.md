---
type: architecture-review
lens: technology-reality-round19
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十九轮：Ignore Snapshot Technology Reality

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** 新增的 ignore invalid/fallback、epoch 内 generation 与 semantic digest 分离、完整 snapshot CAS，以及 watcher reconciliation 均可由当前 Node 24/TypeScript/SQLite 栈实现；所有精确技术 pins 与 Windows IPC 现实边界保持不变。

## 重点复核

| 检查项 | 技术现实 | 结果 |
| --- | --- | --- |
| strict UTF-8 invalid | Node 24 `TextDecoder('utf-8',{fatal:true})` 可检测非法字节；原始 bytes 可同时计算 SHA-256 contentHash | 通过 |
| invalid whole-file fallback | parser 可在 decode/parse 失败时完全丢弃当前 normalized result，继续引用上一 valid normalizedRules/effectiveDigest | 通过 |
| 首次 invalid fallback | 合法空规则 snapshot/digest 已定义，首次无效无需虚构部分解析结果 | 通过 |
| generation/digest separation | generation 作为 statusEpoch 内并发 token；effectiveDigest 作为跨实例语义 identity，符合 CAS 与缓存复用需求 | 通过 |
| 完整 ignore snapshot CAS | SQLite transaction 可比较 generation、validity、contentHash、digest 等完整值对象，失败后回滚重排 | 通过 |
| analyzer config binding | configDigest 只绑定 ignore version/effectiveDigest，避免注释或等价原文变化导致语义缓存失效；full CAS 仍阻止并发旧结果提交 | 通过 |
| invalid 时 graph/findings | Graph 可按最后有效 scope 提交，但 workspace/Findings 保持 stale 且禁止 resolved，是现有事务模型可表达的降级 | 通过 |
| watcher reconciliation | Round18 的 lossy watcher + 五分钟/命令前对账 + 首 commit read-set rehash 保持有效 | 通过 |

## Ignore invalid 与 fallback

- graph-service 读取原始 bytes，先计算 contentHash，再使用 fatal UTF-8 decoder；失败时可生成稳定 ConfigDiagnostic，不需要第三方编码探测库。
- whole-generation invalid 避免不同消费者各自容错；scanner/analyzer/doctor/CLI/UI 只消费服务发布的 EffectiveIgnoreSnapshotV1。
- `lastValidDigest` 与 `normalizedRules` 可以存入已提交 snapshot 元数据；服务重启时 generation 重置但有效语义状态可从缓存恢复，或在首次 invalid 时使用已定义空规则基线。
- invalid generation 仍保留当前 raw contentHash，后续原始内容变化会推进 generation；修复后 valid reconciliation 可替换 effective state 并恢复 current。

## Generation 与 digest 分离

- generation 解决“同一服务实例内，内容改了又改回原值”的并发 ABA 问题；即便 effectiveDigest 相同，旧 Worker/Job 结果也会因 full snapshot CAS 失败。
- generation 不进入 AnalyzerConfigSnapshot semantic configDigest，避免服务重启或注释变化制造无意义的分析缓存 miss。
- `statusEpoch` 包住 generation 的作用域，客户端和 Job 不会跨实例比较重置后的计数。
- effectiveDigest 使用 ordered normalizedRules → RFC 8785 JCS → UTF-8 → SHA-256，可跨进程、跨平台稳定比较。

## Findings 与 snapshot mutation

- 推进 findingsRevision 的事务同时 CAS RulesSnapshotRef 与 EffectiveIgnoreSnapshotV1，能防止规则/排除范围任一变化后提交旧 Finding evaluation。
- invalid ignore 下继续使用 last-valid scope 允许 graph indexing 继续，但整体 stale、禁止 authoritative new/resolved Findings，技术上不要求复制数据库或分叉 graphRevision namespace。
- valid ignore + valid rules + complete-scope evaluation 才能恢复 authoritative Findings，现有单 mutation channel 足以串行化该转换。

## Watcher 与 reconciliation 回归

- watcher 仍明确为可能丢失/重复/乱序的提示，不承担强一致证明。
- 五分钟有界 reconciliation、显式命令前 barrier 与首 mutation commit full read-set rehash 不依赖 watcher event 完整性。
- ignore 原始内容、generation、contentHash 和 effectiveDigest 都进入 bootstrap/full mutation CAS；静默变化最终由内容对账发现。

## 技术 pins 与平台回归

- Stack 块未变化。Round16 已重新在线核验所有 npm pins、Node 24.18.0 ABI 137、better-sqlite3 12.11.1 平台资产、VS Code 1.125 与 TypeScript 6.0.3 API。
- Round18 已确认 Node fs/crypto/timers/TextDecoder 与 SQLite transaction 足够实现有界 reconciliation 和 ignore snapshot。
- AD-11 仍明确使用 Node/libuv 默认 Windows pipe DACL，不承诺 current-SID-only pipe DACL。

## Critical / High / Medium Findings

无。

## 证据来源

- Node.js v24 TextDecoder：`https://nodejs.org/docs/latest-v24.x/api/util.html`
- Node.js v24 crypto：`https://nodejs.org/docs/latest-v24.x/api/crypto.html`
- Node.js v24 fs/watch caveats：`https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener`
- RFC 8785 JCS：`https://www.rfc-editor.org/rfc/rfc8785`
- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- Round16 全版本/ABI/平台核验：`review-technology-reality-round16.md`
- Round18 watcher/reconciliation 复核：`review-technology-reality-round18.md`
