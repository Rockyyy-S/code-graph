---
title: Reviewer Gate — 第十五轮封版对抗一致性复核
date: 2026-07-14
review_type: adversarial-consistency-round15
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十五轮封版对抗一致性复核

## Verdict

**FAIL：机械 lint 为 0 finding；剩余 2 个 high，未发现 critical/medium。** Round14 已确认的核心状态、rules CAS、telemetry、Job 与导出语义仍然成立；本轮全量重跑在跨 epoch View patch 和服务启动时规则装载顺序上构造出两个新的合规分叉。

## 已保持闭合的范围

- RulesSnapshotRef 的 valid/invalid、effective/last-valid digest 与 generation CAS 唯一。
- invalid rules generation 不阻塞 GraphPatch，且只能保留 stale Findings、禁止 resolved。
- service/status 具有 serviceInstanceId/statusEpoch 与总排序 serviceStatusRevision。
- graph/Findings freshness 与 completeness 逐轴合成，stale 不推出 partial。
- Job terminal snapshot、telemetry latest-wins、Git baseline、include-source 授权和 GraphView materialized delta 均未被后续修订削弱。

## High Findings

### H1 — GraphViewModel/GraphViewPatch 未携带 statusEpoch，旧实例的 status-only patch 可碰撞通过

ServiceStatusV1 已有 serviceInstanceId/statusEpoch，但 GraphViewModel 和 GraphViewPatchV1 只携带 viewId/queryFingerprint 与 graph/findings/status revision。graph/findings revision 持久化，而 statusRevision 会在新 epoch 从低值重新开始。

场景：旧实例 E1 在 `graph=20,findings=31,status=1` 上生成一个尚未交付的 status-only delta，next status=2；随后实例崩溃。新实例 E2 读取同一数据库，statusRevision 从 1 开始，客户端按 AD-7 检测 epoch 改变并全量重取；若 viewId 是客户端会话 ID且 queryFingerprint 未变，新模型仍是 `20/31/1`。

**客户端 A：连接级清队列实现**

epoch 改变时丢弃所有旧 IPC/Webview 消息，因此旧 patch 不再出现。

**客户端 B：字段校验实现**

也完成了 epoch 变化后的全量重取，但旧 patch 已进入 extension→Webview 队列并在重取后到达。patch 本身没有 epoch，且 view/query、graph/findings/status base 全部巧合匹配，因此合法应用旧实例的 currentJob/progress/lastJob 状态。

两者都遵守“epoch 改变时全量重取”和“patch 校验全部所携带身份”；差异来自 patch 没有携带必须比较的 epoch。旧 status-only delta 不改变持久 graph/findings revision，因此不能依靠数据时钟排除。

**处理：必须收紧 AD-7/AD-23，不可 Deferred。** GraphViewModel、GraphViewPatchV1 的 delta/invalidate 均必须携带 serviceInstanceId/statusEpoch；客户端只允许当前 epoch 且 view/query/base clocks 全匹配的 patch。epoch 改变时还必须旋转 viewId、清空 extension→Webview 待处理 patch，并全量重取；任何旧 epoch 消息直接丢弃，不得触发应用或再次局部恢复。

### H2 — RulesSnapshotRef 的空策略初始化未绑定启动扫描顺序，首次索引可先按空规则完成

AD-3 现在把 RulesSnapshotRef 初始化为 generation=0 的合法空策略，并规定 rules.yaml 的任意变化推进 generation；但没有要求 graph-service 在接受首个 mutation Job 前完成仓库 rules.yaml 的存在性检查、读取与校验。

场景：仓库启动时已经存在合法非空 rules.yaml。

**服务 A：config-first bootstrap**

启动阶段先读取并校验 rules.yaml，建立 generation=1 的有效 RulesSnapshotRef，再进入 running 并启动首次 rebuild；首个 result snapshot 已包含规则 Findings。

**服务 B：empty-first bootstrap**

先以 generation=0 空策略启动 rebuild；文件发现/Watcher 随后把已有 rules.yaml 当作变化，推进 generation=1 并排队重评估。首次 rebuild 可以 succeeded 并返回一个没有规则 Findings 的 snapshot，之后才出现第二个 findingsRevision。

两者都遵守空策略初始化、规则变化 generation、单 mutation channel 与 CAS，最终状态也会收敛；但首次 CLI check/rebuild、Problems 和 Beta 首屏会对同一仓库返回不同结果。空策略应只表示“确认 rules.yaml 不存在”，不能表示“尚未完成启动扫描”。

**处理：必须收紧 AD-3/AD-8/AD-9/AD-23，不可 Deferred。** 服务在 lifecycle=starting 阶段必须先完成 rules.yaml、codegraphignore、workspace manifest 的启动快照与校验，建立初始 RulesSnapshotRef 后才能进入 running、接受查询或 dequeue 首个 mutation Job。确认 rules.yaml 不存在时使用 generation=0 空策略；启动时存在有效文件则首个可用 snapshot 为对应有效 generation，存在无效文件则先建立 invalid generation + EMPTY_RULES_DIGEST + ConfigDiagnostic，再允许 GraphPatch 继续。

## 最终结论

当前脊柱距离封版仅剩两个跨边界竞态：View patch 的 epoch 绑定和规则启动快照屏障。两项均会让两个逐字合规实现向用户暴露不同状态或结果，不能安全交给下一级代码自行选择；其余已审查接缝无需继续扩展。

