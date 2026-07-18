---
title: Reviewer Gate — 第十九轮最终 Adversarial Consistency
date: 2026-07-14
review_type: adversarial-consistency-round19
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十九轮最终 Adversarial Consistency

## Verdict

**PASS：机械 lint 为 0 finding；未发现剩余 critical/high/medium。** EffectiveIgnoreSnapshot 的跨重启 identity、语义等价改动、非法 UTF-8、last-valid fallback、rules+ignore 联合 CAS、Findings resolved 门槛，以及 watcher/bootstrap/epoch 接缝均已形成唯一合规结果。

## Round18 后关键闭环

| 检查项 | 结果 | 结论 |
| --- | --- | --- |
| ignore 跨重启 | PASS | generation 只在 statusEpoch 内单调且不进语义 configDigest；跨实例以 version+effectiveDigest 对比，重启不会因计数重置改变有效语义。 |
| 注释/等价内容改动 | PASS | 原始 contentHash/generation 变化，完整 snapshot CAS 使在途结果失效；normalizedRules/effectiveDigest 不变，因此语义 configDigest 不变。 |
| invalid UTF-8 | PASS | 严格解码失败使整份 generation invalid，不允许部分解析；发布诊断并继续使用 last-valid scope。 |
| ignore last-valid | PASS | invalid generation 不阻塞 GraphPatch，但只能用上一有效 normalizedRules/effectiveDigest，并保持 workspace/Finding stale，禁止 resolved。 |
| rules + ignore CAS | PASS | 任一推进 findingsRevision 的事务同时 CAS baseGraphRevision、完整 RulesSnapshotRef 与完整 EffectiveIgnoreSnapshotV1。 |
| watcher 静默丢失 | PASS | watcher 非强一致；periodic/explicit reconciliation、bootstrap read-set rehash 与 generation CAS 提供恢复。 |

## 最终对抗场景

### 1. 同一 ignore 文件跨服务重启

**实现 A** 持久化 generation；**实现 B** 新 epoch 从既有文件 generation=1 重新开始。两者的计数可不同，但 generation 明确只作 epoch-local concurrency fence，不参与 configDigest；相同 normalizedRules 必须得到相同 effectiveDigest，因此图谱语义与缓存判定一致。

**结论：不存在共享语义分叉。**

### 2. 只增加或删除注释

contentHash/generation 必须变化，旧 Job 的完整 snapshot CAS 必须失败；effectiveDigest 不变，重排 Job可复用相同语义分析配置。直接忽略原始变化会违反 snapshot CAS；把注释纳入语义 digest 会违反“只有 effectiveDigest 进入 configDigest”。

**结论：唯一。**

### 3. 文件包含非法 UTF-8，且部分前缀看似合法 pattern

实现不能“尽量解析合法前缀”：AD-14 要求严格 UTF-8、整份 invalid、不做部分解析。首次 invalid 使用空 scope digest；后续 invalid 使用 last-valid scope，均记录当前原始 contentHash 与稳定诊断。

**结论：唯一。**

### 4. invalid ignore 期间 source 与 rules 同时变化

GraphPatch 可以继续，但只能在 last-valid ignore scope 下提交；RulesSnapshotRef、IgnoreSnapshot 和 baseGraphRevision 三者任一变化都会使事务 CAS 失败。rules 或 ignore 任一 invalid 时不得产生权威新 Findings 或 resolved，只能保留旧 Findings stale。

**结论：唯一。**

### 5. invalid ignore 修复为 valid，但 effectiveDigest 与 last-valid 相同

原始 generation 改变，因此在途 Job 仍失效；语义 configDigest 可保持不变。workspace 只有在 valid generation 完成 reconciliation、rules 与 ignore 均 valid、完整 scope 成功评估后才能恢复 current并产生权威 Finding 状态；仅清除诊断而保留未验证 stale 状态，或未经评估直接 resolved，均不合规。

**结论：唯一。**

### 6. valid ignore 改变 scope，旧 Finding 的 subject 被排除

新 ignore generation/effectiveDigest 进入 configDigest 与 CAS；只有新 scope 完整评估后，缺失 Finding 才能 resolved。使用旧 scope 继续 active、在 partial evaluation 中 resolved，或 analyzer 自行解析 ignore 得到另一 scope，均违反 AD-3/AD-14/AD-17。

**结论：唯一。**

### 7. watcher 丢失 ignore 修改且没有 overflow

短暂未观测已被明确允许，但不能无限保持 current：有客户端时下一次有界 reconciliation 至多 5 分钟启动，显式 rebuild/check/impact/export 前也必须先对账。发现差异后 generation/snapshot 变化并立即 stale，旧 GraphPatch 不能越过 CAS。

**结论：唯一且有界恢复。**

### 8. bootstrap 扫描与 ignore/rules 连续写入

watcher-first；观察事件合并重读；Manifest、AnalyzerConfig、Ignore、Rules 在同一 bootstrapGeneration 原子发布；首个 Job/commit 再 hash 完整 read-set。任何 generation 或 hash 差异都会重排，不能带混合快照进入 running。

**结论：唯一。**

### 9. service restart 与旧 epoch patch/status

ServiceStatus、GraphViewModel、delta、invalidate 均绑定 serviceInstanceId/statusEpoch；epoch 改变旋转 viewId、清空队列、全量重取。ignore/rules generation 的数值重置不能绕过 epoch 或 digest 身份。

**结论：唯一。**

### 10. 双重 owner 尝试

raw ignore 只由 graph-service 解释；scanner/analyzer/doctor/CLI/UI 只能消费 EffectiveIgnoreSnapshot、过滤后的集合或摘要。rules/ignore/graph/findings/config/status 均有唯一 owner，客户端或适配器二次解释与旁路 mutation 明确违规。

**结论：无双重 owner。**

## 可留给实现的细节

以下内容不改变共享结果，可由 contracts/测试固定：

- generation 的整数类型与进程内存储结构；
- normalizedRules 的内部 AST 字段名；
- 非法 UTF-8 诊断的具体文案；
- comment-only 变化后的重排优化策略，只要完整 CAS 与语义 digest 规则不变；
- reconciliation 的具体调度抖动，只要满足有界上限。

## Gate 结论

Round19 Adversarial Consistency lens **PASS**。目标脊柱已封闭 EffectiveIgnoreSnapshot、rules/ignore CAS、Findings validity、watcher/bootstrap、epoch/patch 及 shared owner 分叉，无需新增 AD。

