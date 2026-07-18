---
title: Reviewer Gate — 第十八轮 Adversarial Consistency 最终审查
date: 2026-07-14
review_type: adversarial-consistency-round18
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十八轮 Adversarial Consistency 最终审查

## Verdict

**PASS：机械 lint 为 0 finding；未发现剩余 critical/high/medium。** Round17 的 `.codegraphignore` grammar/owner 缺口与 Technology Reality 的 watcher 静默丢事件缺口均已闭合；继续针对 shared data、状态 owner、mutation channel、epoch/patch、启动快照和恢复语义构造双实现，未得到两个严格遵守全部 AD 却结果不兼容的实现。

## Round17 闭环验证

| Round17 finding | 结果 | 验证结论 |
| --- | --- | --- |
| M1 `.codegraphignore` grammar / owner | CLOSED | AD-14 固定 UTF-8 行语法、注释、反选、last-match-wins、锚定、目录、转义、`* ? **`、大小写与不支持字符类；graph-service 唯一解释原文件并发布 EffectiveIgnoreSnapshotV1。scanner、analyzer、doctor、CLI、UI 不得二次解析。 |

## Technology Reality watcher 闭环验证

| 检查项 | 结果 | 验证结论 |
| --- | --- | --- |
| watcher 可能丢失/重复/乱序 | CLOSED | AD-8 明确 watcher 只提供候选、绝不作为强一致证明；文件内容 hash 才是真相。 |
| overflow / service recovery | CLOSED | 强制 manifest reconciliation scan，不能仅依赖后续 watcher 事件。 |
| 静默丢事件 | CLOSED | 有客户端时每次对账完成后至多 5 分钟启动下一次有界对账；显式 rebuild/check/impact/export 前必须完成或复用一次对账。 |
| bootstrap TOCTOU | CLOSED | watcher-first、扫描期间事件合并重读、四类快照在同一 bootstrapGeneration 原子发布、首个 Job/commit 重新 hash 完整 read-set 并 CAS generation。 |
| freshness 真实性 | CLOSED | current 只表示匹配最近完成的内容对账；静默变化可短暂未观测，但下一次有界对账必须发现并转 stale。 |

## 最终双实现攻击矩阵

### 1. `.codegraphignore` 反选与目录规则

输入：

~~~text
dist/**
!dist/keep.ts
generated/
~~~

gitignore-style 与普通 glob 不能再同时合规：AD-14 已唯一规定反选和 last-match-wins，`keep.ts` 必须重新纳入，`generated/` 必须匹配目录及后代。

**结论：唯一。**

### 2. 跨平台大小写与路径分隔符

Windows 原生大小写不敏感实现不再合规；匹配输入必须规范为 `/` 且区分大小写。scanner 与 analyzer 都只能消费同一 EffectiveIgnoreSnapshot/effective scope，不能按宿主平台重新解释。

**结论：唯一。**

### 3. ignore 文件缺失、创建、删除与内容回滚

- 缺失：generation=0、contentHash=null、normalizedRules=[]。
- 已有文件：从 generation=1 开始。
- 任意内容变化推进 generation；删除回到“文件不存在”的 effective 内容，但仍是一次新 generation，而不是伪装为从未存在。
- GraphPatch/configDigest CAS 绑定 EffectiveIgnoreSnapshotV1，旧 generation 结果不能提交。

**结论：语义唯一；generation 具体整数持久化属于实现细节，不改变 effective scope。**

### 4. bootstrap 扫描期间 rules/ignore/manifest/source 连续变化

watcher 已先注册；观察到的事件必须合并重读，快照未在同一 generation 收敛就不能进入 running。首个 Job 提交前再次 hash 全 read-set，任何遗漏的实际内容差异都会使提交失效。

**结论：唯一。**

### 5. watcher overflow 后没有逐路径事件

“等待下一次事件”不再合规；overflow 本身触发 reconciliation scan。扫描结果重建 Manifest/AnalyzerConfig/Ignore/Rules snapshot，并通过 mutation CAS 发布。

**结论：唯一。**

### 6. watcher 静默丢失且没有 overflow 信号

实现 A 仅依赖 watcher 将违反至多 5 分钟有界对账；实现 B 周期 reconciliation 是唯一合规路线。显式 check/impact/export 还必须先对账，因此机器结果不能基于已知未对账快照。

**结论：唯一，且“短暂未观测”边界已显式承认。**

### 7. ignore 变化与正在计算的 GraphPatch 交叉

ignore 内容变化推进 EffectiveIgnoreSnapshot generation，并进入 configDigest/bootstrap/snapshot mutation CAS。旧 scope 的 FactBatch/GraphPatch 必须丢弃并重排，不能按旧 complete coverage 删除新 scope 中应保留的事实。

**结论：唯一。**

### 8. invalid rules、ignore 变化与 source 变化同时发生

唯一 snapshot mutation channel 串行发布 graph/findings revision；RulesSnapshotRef 与 EffectiveIgnoreSnapshot 分别 CAS。invalid rules 不阻塞图谱，但只能保留 stale Findings；ignore/source 旧快照不能越过 CAS。

**结论：唯一。**

### 9. 服务重启与旧 status/view patch 延迟

ServiceStatus、GraphViewModel、delta、invalidate 均绑定 serviceInstanceId/statusEpoch。epoch 改变旋转 viewId并清空待处理 patch，旧实例消息直接丢弃；status/config/data revision 数值巧合不能越过 epoch。

**结论：唯一。**

### 10. graph/findings/config/telemetry 多 owner 尝试

- graph/findings/cache/Job/revision：graph-service 唯一 owner。
- raw `.codegraphignore` interpretation：graph-service 唯一 owner。
- rules/ignore repository policy：仓库文件 owner；生效快照由服务发布。
- telemetry requested/effective/config revision：服务权威，service/status/statusChanged 发布。
- session/view visual state：extension/Webview 按 AD-10 分工。

任何客户端、analyzer 或 doctor 自行解释/写入共享状态均直接违反 AD。

**结论：无双重 owner。**

## 可留给代码权威的细节

以下细节不会改变共享语义，可由 contracts/domain 实现与契约测试固定：

- EffectiveIgnoreSnapshotV1.normalizedRules 的内部 AST 属性名；
- watcher generation 与 bootstrapGeneration 的整数位宽；
- periodic reconciliation 的具体调度抖动，只要完成后至下一次启动不超过 5 分钟；
- 文件系统 watcher 库与平台事件合并实现；
- statusEpoch/serviceInstanceId 的编码格式。

## Gate 结论

Round18 Adversarial Consistency lens **PASS**。当前 ARCHITECTURE-SPINE.md 已封闭所审查的 shared-data、state、owner、mutation channel、epoch/patch、启动规则/ignore 快照和 watcher recovery 分叉，无需继续新增 AD。

