---
title: Reviewer Gate — 第十七轮 Adversarial Consistency 审查
date: 2026-07-14
review_type: adversarial-consistency-round17
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十七轮 Adversarial Consistency 审查

## Verdict

**FAIL：机械 lint 为 0 finding；Round16 High 已闭合，剩余 1 个 medium，未发现 critical/high。** watcher-first、bootstrapGeneration、RulesSnapshotRef、epoch/patch 与唯一 mutation channel 已无法再构造严格合规分叉；唯一剩余点是 `.codegraphignore` 的公共语义与 effective-scope owner 未固定。

## Round16 闭环验证

| Round16 finding | 结果 | 验证结论 |
| --- | --- | --- |
| H1 watcher-first reconciliation barrier | CLOSED | AD-8/AD-23 已固定 watcher-first、扫描期间事件按路径合并重读、三类快照在同一 bootstrapGeneration 原子发布、首个 Job/commit CAS generation；扫描窗口内变更不能再静默丢失。 |

## Bootstrap / mutation / epoch 最终攻击

以下场景均已得到唯一结果：

- watcher overflow 或扫描期间连续写入：必须继续 reconciliation，直到 watcher generation 与三类快照收敛；不能带旧 generation 进入 running。
- 原子发布后、首个 Job dequeue 前发生新事件：bootstrapGeneration 改变，首个 Job 或提交 CAS 失败并重排。
- rules.yaml 在扫描中从 valid→invalid→valid：最终 RulesSnapshotRef 必须对应收敛 generation，旧 digest 结果无法提交。
- 服务重启后旧 ServiceStatus/GraphViewPatch 延迟到达：epoch 不同直接丢弃；viewId 已旋转，不能碰撞应用。
- graph/findings-only mutation、规则变化与 GraphPatch 同时发生：唯一 snapshot mutation channel + baseGraphRevision/RulesSnapshotRef CAS 阻止交叉提交。

## Medium Finding

### M1 — `.codegraphignore` 没有固定 grammar、匹配顺序与唯一 effective-scope owner

AD-6/AD-14 只规定 `.codegraphignore` 属于仓库策略；AD-3 把 `ignorePatterns` 放入 AnalyzerConfigSnapshot；AD-23 在启动屏障中读取它。没有 AD 定义其语法是否复用 Git ignore、AD-9 的规则 glob，或另一种普通 glob，也没有规定 scanner、analyzer、doctor 中谁唯一解释原始文件。

示例：

~~~text
dist/**
!dist/keep.ts
generated/
~~~

**独立单元 A：gitignore implementation**

支持 `!` 反选、last-match-wins、目录后缀与 root-relative 规则，因此 `dist/keep.ts` 被重新纳入。

**独立单元 B：rules-glob implementation**

复用 AD-9 的 `*`/`**` 语义，不支持反选；`!dist/keep.ts` 被当作普通不可匹配 pattern，整个 dist 仍被排除。

两者都严格遵守当前全部 AD。它们会产生不同 ManifestSnapshot、AnalyzerConfigSnapshot/configDigest、FactBatch coverage、workspace package 计数和最终图谱；若 scanner 与 analyzer 在同一实现内各自选择，还可能让 complete FactBatch 对另一方认为在 scope 内的文件执行遗漏删除。Windows/macOS/Linux 的大小写、leading slash、trailing slash、转义与未跟踪文件路径也有同类分叉。

**处理：应收紧 AD-3/AD-9/AD-14，不可留给多个适配器自行选择。** 固定 `.codegraphignore` v1 grammar、顺序/反选/锚定/目录/转义/大小写语义；graph-service 是唯一 raw-file interpreter，生成版本化 `EffectiveIgnoreSnapshotV1={generation,contentHash,digest,normalizedRules/effectiveScope}`。scanner、AnalyzerConfigSnapshot、doctor、CLI 与 UI 只消费该 snapshot 或服务返回的排除摘要，不得再次解析原文件；ignore 变化进入 bootstrap/snapshot mutation generation 与 CAS。

## 其他接缝结论

未发现新的 critical/high/medium：

- WorkspaceDiscoverySummary 与 monorepo degraded；
- IndexStatus、ServiceStatus、telemetry 与多 revision 总排序；
- NavigationTarget、FindingSummary、Git baseline 与 ConfigDiagnostic；
- external-package/node-builtin 判别联合；
- ExportArtifact/Preview 与 include-source 授权；
- GraphViewModel materialized delta、epoch、budget 与 full-refetch；
- Job cancellation/result snapshot 和升级交接。

## Gate 结论

Round17 确认 Round16 High 已关闭。当前只剩 `.codegraphignore` 的语义/owner 这一项 medium；修订后本 lens 可 PASS。

