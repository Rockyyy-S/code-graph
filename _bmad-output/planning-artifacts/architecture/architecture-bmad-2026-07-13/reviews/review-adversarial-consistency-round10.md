---
title: Reviewer Gate — 第十轮对抗性一致性复核
date: 2026-07-14
review_type: adversarial-consistency-round10
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十轮对抗性一致性复核

## Verdict

**FAIL：机械 lint 为 0 finding；round9 的主要结构修订已落地，但仍有 5 个 high、1 个 medium。** `node-builtin` 投影、物化视图 delta、Finding subject、WorkspaceDiscoverySummary、NavigationTargetV1 和 Export artifact/target 所有权已收敛；剩余问题集中在独立状态时钟、Job 范围、遥测待生效竞态、Finding 有效性边界和 Git baseline 身份。

## Round9 闭环矩阵

| Round9 finding | 结果 | 第十轮结论 |
| --- | --- | --- |
| H1 `node-builtin` / GraphView external union | CLOSED | AD-7 固定四类 surface + `externalKind=npm-package|node-builtin`，AD-18 唯一映射导出类型，并禁止静默丢弃 built-in endpoint。 |
| H2 GraphView patch 语义 | PARTIAL | 已固定为物化视图精确 delta、原子应用或 invalidate；但 IndexStatus 可在双数据 revision 不变时变化，patch 仍无独立状态时钟，见 H1。 |
| H3 Finding subject/comparison | PARTIAL | subject 与无基线/stale 规则已闭合；Git baseline 的 `baseGraphRevision/baseFindingsRevision` 命名空间仍未定义，见 H5。 |
| H4 telemetry / configRevision | PARTIAL | on→off 原子提交与 viewConfigRevision 已闭合；待生效 off→on 被后续 off 取消的规则缺失，见 H3。 |
| H5 cancelled/partial/stale | PARTIAL | 首次提交前/后与只读 Job 的基本转换已固定；`currentJob` 范围、并发读 Job、状态枚举和 freshness 起点仍可分叉，见 H2。 |
| M1 WorkspaceDiscoverySummary | CLOSED | single/recognized/degraded 分支、packageCount 与 diagnosticRef 条件已闭合。 |
| M2 NavigationTargetV1 | CLOSED | 三分支及 nodeKind 附件规则已闭合。 |
| M3 ExportPreview ownership/policy fields | PARTIAL | service artifact 与 client targetState 所有权已闭合；源码策略的授权来源仍可分叉，见 M1。 |

## High Findings

### H1 — GraphViewPatch 缺少独立状态 revision，同一双数据 revision 的状态 patch 可乱序回滚

`IndexStatusSummaryV1` 的 progress、currentJob/lastJob、lifecycle 和 telemetry 可在 `graphRevision/findingsRevision` 均不变化时更新。

**独立单元 A：graph-service**

对 progress 10%→20% 发送两个 GraphViewPatch delta；两者都有相同 viewId/queryFingerprint，且 `baseGraphRevision=nextGraphRevision=42`、`baseFindingsRevision=nextFindingsRevision=61`。

**独立单元 B：extension/webview**

网络或事件队列先交付 20% 再交付 10%；两个 patch 都通过 AD-7 的全部身份检查，因此客户端合法地把进度回滚到 10%。另一套客户端可自行比较 completed 数并拒绝回退，但 indeterminate progress、Job 切换和 lifecycle 没有可比较的统一规则。

`service/status` 的独立通知有同一问题：它被声明为唯一权威，却没有 `statusRevision`，因此客户端无法区分旧响应、重连快照和新通知。`invalidate` 分支也未明确携带可路由的 view/query/base 状态身份。

**处理：必须收紧 AD-7，不可 Deferred。** `IndexStatusSummaryV1` 增加每 indexing root 单调递增的 `statusRevision`；GraphViewModel 携带该值，delta 携带 `baseStatusRevision/nextStatusRevision`，invalidate 至少携带 viewId/queryFingerprint/baseStatusRevision/reason。任何 Job、progress、lifecycle、cache summary 或 effective service status 变化都推进 statusRevision，客户端仅原子接受连续三元基线；重连或断档全量获取 service/status 与 GraphViewModel。

### H2 — `IndexStatusSummaryV1.currentJob` 未限定为索引 Job，且 WorkspaceStatus 枚举/合法组合被移除

AD-8 只规定“一条图谱变更通道”，并未禁止 check、impact、export 等只读 Job 与 indexing/rebuild 并发；AD-7 却只有单个 `currentJob`，并把 `refreshing` 从它直接投影。

**独立单元 A：Job scheduler**

串行执行所有 Job，因此 currentJob 可以依次是 rebuild、impact、export；UI 在只读 export 期间也投影 refreshing。

**独立单元 B：service/status publisher**

允许只读 Job 与 rebuild 并行，只把图谱变更 Job 放入 currentJob，其余由 job/get 查询；lastJob 同样只记录最后一次变更 Job。两者都遵守现有 AD，但 service/status、Status Bar 与 cancelled banner 的含义不同。

此外，当前文本只保留四个字段名，上一版固定的 lifecycle、availability、completeness 枚举与合法组合已不存在。变更候选出现后、首次 GraphPatch 提交前，发布器 A 立即把 freshness 设为 stale；发布器 B 依照 AD-8 的“首次提交前取消保留旧 freshness”，让旧缓存继续显示 current。取消后两者分别为 stale/complete 与 current/complete，均有逐字依据。

**处理：必须收紧 AD-7/AD-8，不可 Deferred。** 把字段改名为 `currentIndexJob/lastIndexJob` 并固定允许的 mutation kinds；只读 Job 只进入 job/get，不驱动 workspace refreshing/cancelled。恢复枚举与合法组合：lifecycle=stopped|starting|running|stopping|failed，availability=absent|available，freshness=null|current|stale，completeness=empty|partial|complete；检测到当前 manifest/input digest 与 committed snapshot 不一致时立即 stale，取消前无提交只保留 completeness，不得把 freshness 恢复为 current。failed 继续只表示服务 fatal。

### H3 — 待生效 telemetry opt-in 不会被后续 opt-out 确定性取消

初始 effective telemetry=off。客户端 A 请求 off→on，服务按 AD-22 等待当前 Job 边界；在边界前，用户或客户端 B 再请求 off。

**独立单元 A：latest-intent config owner**

把第二次 off 视为新的隐私意图，取消 pending enable；Job 边界后仍为 off。

**独立单元 B：effective-state config owner**

因为 effective state 仍是 off，把 off→off 当作幂等 no-op；先前 pending enable 在 Job 边界按计划生效并开始发送允许列表事件。

AD-16 只固定 effective on→off，AD-22 只固定 off→on 的实际启用边界；没有 requested/pending state、请求 revision 或 latest-wins 规则，因此两者都能声称合规。B 会在用户最后一次明确关闭后重新开启遥测，是实际隐私回归。

**处理：必须收紧 AD-16/AD-22，不可 Deferred。** service/reconfigure 持有 `requestedTelemetryState`、`effectiveTelemetryState` 与请求 configRevision；任何 off 请求都立即取消更早的 pending enable、推进 configRevision 并返回 off。Job 边界只允许当 pending on 的 request revision 仍是最新时启用，否则丢弃；多客户端按服务接收顺序 latest-wins 并广播 requested/effective/applied revision。

### H4 — 配置无效或图谱不完整时，Finding 的 stale/resolved 转换再次未定义

当前 AD-17 定义了 stale 的 comparison 必须 not-applicable，却没有定义何时进入 stale；AD-9 也不再规定无效 rules.yaml 如何处理上一有效 revision 的 Findings。

**独立单元 A：rules engine**

把无效 rules.yaml 视为“当前没有有效规则”，将旧 active Findings 全部标记 resolved；取消 rebuild 后，对当前残缺图中未再观察到的 Finding 也标记 resolved。

**独立单元 B：rules engine**

保留上一有效规则结果并标记 stale；只有有效配置在完整适用 scope 上成功评估后才允许 resolved。

两者都符合现有 AD-9 的严格诊断、AD-17 的三个状态和 AD-8 的 partial/stale cache，但会让同一违规在 Problems、CLI check 与 PR 摘要中分别成为“已解决”或“结果未知”。

**处理：必须收紧 AD-9/AD-17，不可 Deferred。** 配置无效时保留上一有效 Findings，推进 findingsRevision 并统一标记 stale，禁止产生 resolved；图谱 partial/stale 时，未被本次 complete evaluation 覆盖的既有 Finding 也只能 stale。只有有效规则配置针对完整 scope 成功评估后，缺失 Finding 才可转 resolved；新观察到的确定违规仍可 active，但必须绑定实际 graph/findings revision。

### H5 — Git comparisonContext 引用了没有命名空间的 `baseGraphRevision/baseFindingsRevision`

Job comparison 的 baseFindingsRevision 属于当前 indexing root 的已提交 revision；Git impact baseline 通常是对所选 base ref 的临时派生图/Findings，并不天然属于同一 revision 序列。

**独立单元 A：impact adapter**

在隔离临时库中分析 Git base，并使用临时库自己的 `graphRevision=1/findingsRevision=1` 填入 FindingSummaryV1。

**独立单元 B：impact adapter**

不创建临时 revision，把当前工作区开始 impact 时的 revision pair 填入 comparisonContext，并用 baseRef 单独识别派生基线。

两者都携带 AD-17 要求的三个字段，但相同数字属于不同快照，缓存、CLI 和导出无法证明 comparison 来自哪个 baseline。若实现为了获得“真实”全局 revision 而把 Git base 写入主图，又会违反查询只读已提交当前工作区 revision 的状态模型。

**处理：必须收紧 AD-17，不可 Deferred。** Git 分支改为 `git{baseRef,baselineId,derivedFromGraphRevision,derivedFromFindingsRevision}`；baselineId 是对规范 baseRef、规则/config digest 与派生输入的稳定摘要，不能复用主图 revision 命名空间。若要暴露临时快照 revision，必须同时携带独立 namespace/store identity，且不得推进主图 revision。

## Medium Finding

### M1 — Export requestedPolicy 的授权来源未固定，可被持久偏好静默升级为含源码

AD-18 固定 structure-only 时 `containsSource=false`，但没有固定 requestedPolicy 的允许值、默认值和谁可提出 include-source。

**独立单元 A：extension settings adapter**

允许 workspace/user setting 持久保存 include-source；以后每次 export 都把它作为 requestedPolicy，服务仍可声称“用户曾显式选择”。

**独立单元 B：CLI/extension command handler**

每次命令默认 structure-only，只有当前命令的显式 flag/确认才请求 include-source；不读取持久偏好。

两者都符合“默认只含结构”与 requested/effectivePolicy 字段，但共享仓库设置或历史偏好可能让后续导出在没有当次确认时包含源码。

**处理：收紧 AD-14/AD-18。** requestedPolicy 只允许 structure-only|include-source，默认且不可被持久设置覆盖为 structure-only；include-source 只能来自当前 CLI invocation 或当前交互命令的显式授权。effectivePolicy 不得比 requestedPolicy 更宽，若降级必须返回稳定诊断；`containsSource=true` 只允许 effectivePolicy=include-source 且 artifact 实际包含源码。

## 已通过的新增攻击

- `externalKind=node-builtin` 不能再被合法实现静默省略或改成 npm package；AD-7/AD-18 映射已唯一。
- NavigationTargetV1 的 file/directory/symbol 必填字段和 symbol-centered attachment 已足够阻止 producer/consumer 分叉。
- WorkspaceDiscoverySummary 的三个分支不能再对 packageCount 和 degraded diagnosticRef 作不同解释。
- GraphViewPatch 已明确是物化视图 delta 而非底层 GraphPatch 摘要；本轮 finding 只针对它缺少状态时钟，不否定 delta 内容语义。
- ExportArtifactV1 与 client-local targetState 的所有权已闭合；绝对路径不需要也不得进入服务线协议。

## 建议收敛顺序

1. 先给 service/status 与 GraphViewPatch 增加 statusRevision，并把 currentJob 收窄为 currentIndexJob。
2. 同时恢复四维状态枚举/合法组合，固定 input digest 变化即 stale。
3. 为 telemetry 引入 requested/pending revision，保证最后一次 off 永远取消待启用 on。
4. 恢复 Finding 的 invalid/partial → stale、complete evaluation → resolved 转换边界。
5. 用独立 baselineId 替换 Git comparison 的伪全局 revisions，并封闭 include-source 的当次授权来源。

