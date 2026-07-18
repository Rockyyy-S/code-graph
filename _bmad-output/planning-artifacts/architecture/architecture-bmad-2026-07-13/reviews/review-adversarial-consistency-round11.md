---
title: Reviewer Gate — 第十一轮对抗性一致性最终复核
date: 2026-07-14
review_type: adversarial-consistency-round11
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十一轮对抗性一致性最终复核

## Verdict

**FAIL：机械 lint 为 0 finding；Round10 的 5 High/1 Medium 直接反例均已闭合，但交叉复测仍发现 4 个 high、1 个 medium。** 新问题不是 Round10 修订缺字段，而是双 revision、共享 mutation channel、service/status 与 Job terminal snapshot 之间仍有未绑定语义。

## Round10 闭环验证

| Round10 finding | 结果 | 验证结论 |
| --- | --- | --- |
| H1 独立 statusRevision | CLOSED | IndexStatusSummary、GraphViewModel、delta/invalidate 已携带 status 时钟，全部可观察状态变化推进 revision，断档全量重取。 |
| H2 currentIndexJob 与四维状态 | CLOSED | current/last 已收窄为图谱或 Findings 变更 Job；四维枚举、合法组合与 input digest 变化即 stale 已恢复。 |
| H3 pending telemetry latest-wins | CLOSED | requested/effective 分离；任何 off 取消旧 pending-on，pending-on 仅在 request revision 仍最新时启用。 |
| H4 Finding stale/resolved | CLOSED | 配置无效与未覆盖 scope 只允许 stale；仅有效配置在完整 scope 成功评估后允许 resolved。 |
| H5 Git baseline namespace | CLOSED | Git comparison 改用 baselineId，并明确临时基线不得复用或推进主图 revision。 |
| M1 include-source 当次授权 | CLOSED | 默认 structure-only 不可被持久设置覆盖，include-source 只能来自当前命令显式授权。 |

## High Findings

### H1 — “单一图谱变更通道”没有覆盖 findings-only transaction，可产生两个并发 currentIndexJob

AD-3 允许规则配置单独变化只推进 findingsRevision；AD-8 只规定“每 indexing root 一条图谱变更通道”；AD-7 的 currentIndexJob 又同时包含图谱或 Findings 变更 Job。

**独立单元 A：统一 snapshot mutation scheduler**

把 indexing GraphPatch 与 rules re-evaluation 放入同一队列，任意时刻只有一个 transaction stream 和一个 currentIndexJob。

**独立单元 B：双通道 scheduler**

只把推进 graphRevision 的 Job 串行化；rules re-evaluation 作为 findings-only Job 与 indexing 并行准备，在 SQLite 写入时再排队。它仍逐字满足“一条图谱变更通道”，但同时存在两个符合 AD-7 的 currentIndexJob，只能任意选择一个发布。

更严重的是，B 的 rules Job 可基于 `(graph=20, findings=30)` 计算，期间 graph Job 提交 `(21,31)`；随后 rules Job 仅推进 findings 到 32，却把基于 graph 20 的结果绑定到当前 graph 21。当前只有 FactBatch input CAS，没有为 findings-only evaluation 固定 baseGraphRevision CAS。

**处理：必须收紧 AD-3/AD-8，不可 Deferred。** 每 indexing root 只能有一条 **snapshot mutation channel**，覆盖任何会推进 graphRevision 或 findingsRevision 的 Job；currentIndexJob 即该通道唯一活动 Job。findings-only evaluation 必须绑定 baseGraphRevision、rules/config digest，并在提交前 CAS；任一变化则丢弃重算，禁止把旧图评估写入新图 revision。

### H2 — 单一 freshness/completeness 未固定 graph 与 Findings 的合成语义

系统已明确拥有 graphRevision 与 findingsRevision 两个时钟，但 IndexStatus committed cache 仍只有一组 freshness/completeness。

场景：图谱已与当前 manifest 完全一致，`graphRevision=42`；rules.yaml 无效，AD-9 将上一有效 Findings 标记 stale 并推进 `findingsRevision=63`。

**独立单元 A：graph-centric status publisher**

返回 `freshness=current, completeness=complete`，因为规范图谱完整且与源码一致；FindingSummary 自身已经携带 stale。

**独立单元 B：whole-snapshot status publisher**

返回 `freshness=stale, completeness=partial`，因为 graph + Findings 组合快照不能提供有效完整结论。

两者都满足 AD-7 的枚举/合法组合、AD-9 的 Finding stale 与 AD-17 的比较规则，但 Overview、Status Bar、CLI status 和恢复动作不同。相反场景也存在：图谱 partial，但旧 Findings revision 仍完整绑定旧 graph，单一字段无法说明哪一半过期。

**处理：必须收紧 AD-7，不可 Deferred。** 二选一：增加 `graphFreshness/graphCompleteness` 与 `findingsFreshness/findingsCompleteness`，再固定 workspace 展示为 worst-of；或明确现有 freshness/completeness 始终描述 graph+Findings 整体，只有两者均 current/complete 才能返回 current/complete，任一 stale/partial 即整体降级。不得让各 surface 自行选择 graph-centric 或 whole-snapshot。

### H3 — telemetry requested/effective 状态没有进入可查询的 service/status 合同

AD-16/AD-22 已固定 reconfigure 时序，但当前 service/status 的唯一公共合同仍只有 IndexStatusSummaryV1；其中没有 requestedTelemetryState、effectiveTelemetryState、pending request revision 或 appliedConfigRevision。

**独立单元 A：reconfigure-response owner**

只在 service/reconfigure 响应中返回遥测状态；新连接或重连客户端没有历史响应，按本地 setting 推测当前状态。

**独立单元 B：status-envelope owner**

自行扩展 service/status，返回 telemetry 子对象与 configRevision；UI 始终显示服务确认状态。

两者都遵守 AD-16/AD-22，因为规则只要求服务持有和广播，没有绑定 service/status DTO。结果是在 multi-client、pending-on 或重连场景中，客户端可显示 on、off、pending 三种不同结论；这直接违背“查看实际生效状态”的 UX 边界。

**处理：必须收紧 AD-7/AD-16/AD-22，不可 Deferred。** 定义 `ServiceStatusV1={indexStatus:IndexStatusSummaryV1, telemetryStatus:TelemetryStatusV1, configRevision, viewConfigRevision}`；TelemetryStatusV1 至少含 requestedState、effectiveState、requestedConfigRevision、appliedConfigRevision、pending。service/status 与 statusChanged 是唯一权威，新连接必须先读取；telemetry/config 状态变化按 configRevision 排序，不能靠客户端 setting 推断。

### H4 — Job 的 result revision 在 failed/cancelled/运行中没有唯一含义

AD-8 要求每个 Job 携带 baseGraphRevision、baseFindingsRevision、resultGraphRevision、resultFindingsRevision，却没有规定 queued/running 时 result 是否存在，也没有规定失败或取消后的 result 指向“最后已提交快照”还是“成功完成结果”。

场景：indexing Job 从 `(10,18)` 开始，提交一次 GraphPatch 到 `(11,19)` 后被取消。

**独立单元 A：committed-result implementation**

返回 cancelled，`result=(11,19)`，表示 Job 结束时仍可读取的最新已提交快照。

**独立单元 B：successful-result implementation**

返回 cancelled，`result=(10,18)` 或 null，表示取消的 Job 没有成功结果；客户端另从 service/status 获取 `(11,19)`。

两者都保留已提交 revision、都不暴露未提交 GraphPatch，也都“携带”或合理解释 result 字段，但 CLI、job/get 和重连恢复会选择不同目标 snapshot。

**处理：必须收紧 AD-8，不可 Deferred。** queued/running 的 result pair 必须为 null；terminal 的 result pair 必须表示 Job 结束时该 indexing root 的最新已提交 snapshot：succeeded 为最终目标，failed/cancelled 为最后成功提交，未发生提交时等于 base。只读 Job 的 terminal result 是它实际读取/比较的目标 snapshot；字段不得用来表示“是否成功”，成功性只看 state。

## Medium Finding

### M1 — Git baselineId 中“规范 baseRef”仍允许 branch 名与 commit object ID 两种合法输入

AD-17 已要求 baselineId 哈希规范 baseRef、rules/config digest 和派生输入，但没有定义规范 baseRef 是用户输入字符串、解析后的完整 commit object ID，还是两者组合。

**独立单元 A：CLI impact** 对 `--base main` 使用字符串 `main`；**独立单元 B：Git adapter** 使用当时解析出的完整 commit OID。即使派生输入相同，两者 baselineId 也不同；branch 移动、短 SHA 和 tag 别名会进一步造成 CLI、IDE 与导出缓存无法复用。

**处理：收紧 AD-17。** canonical baseRef 固定为仓库对象格式标识 + 解析后的完整 commit object ID，并包含 workspace-key/subroot；用户输入 ref 只作显示元数据，不进入 baseline identity。派生 inputs、rules/config digests 继续使用现有规范排序与哈希规则。

## 已通过的新增攻击

- statusRevision 已阻止同一 graph/findings revision 下的 progress 或 lifecycle 回滚；invalidate 也有可路由的 view/query/status 基线。
- manifest/input digest 差异出现后，取消前无提交不再能合法恢复 current。
- pending telemetry on 在后续 off 后不能再合法启用；多客户端请求顺序已有服务端唯一裁决。
- 无效配置或未完整覆盖 scope 不能再把既有 Finding 合法标记 resolved。
- include-source 无法再通过 workspace/user 持久偏好静默成为默认策略。

## 建议收敛顺序

1. 将 graph/findings 全部 mutation 合并到唯一 snapshot mutation channel，并为 findings-only 提交增加 graph/config CAS。
2. 决定 status 是双维 graph/findings，还是固定 whole-snapshot worst-of 语义。
3. 定义 ServiceStatusV1/TelemetryStatusV1，保证重连客户端读取服务实际状态。
4. 固定 Job terminal result snapshot 语义。
5. 将 Git baseline 的 canonical baseRef 锁定为完整 commit object ID。

