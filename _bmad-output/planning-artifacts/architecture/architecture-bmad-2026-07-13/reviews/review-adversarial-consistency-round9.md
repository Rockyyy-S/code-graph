---
title: Reviewer Gate — 第九轮对抗性一致性复核
date: 2026-07-14
review_type: adversarial-consistency-round9
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第九轮对抗性一致性复核

## Verdict

**FAIL：机械 lint 为 0 finding，但仍有 5 个 high、3 个 medium 语义孔洞。** 本轮只审查 `ARCHITECTURE-SPINE.md`；以下每项都能构造两个下一级单元，它们逐字遵守现有 AD，却会在共享 DTO、状态快照或视图结果上不兼容。问题集中在本次 PRD/UX 更新新增的 V1 读模型，不涉及六边形架构、技术栈或既有 GraphPatch 存储原子性。

## 审查方法

对 `graph-service`、`contracts`、`service-client`、`extension`、`webview`、CLI/export 之间的共享接缝逐一做“双实现攻击”：如果生产者与消费者各自只读当前脊柱，能否作出不同但都合规的解释。只把会改变跨单元语义、状态转换或快照身份的分叉列为 finding；字段命名、TypeScript 文件布局和文案不计入。

## High Findings

### H1 — `GraphViewModel` 无法唯一表示 `node-builtin`，与导出判别联合冲突

**独立单元 A：`application/querying`**

遇到 `file → node:fs` 的规范 `imports` 边时，为严格满足 AD-7 的四种 `nodeKind`，从图形 surface 中省略 `node-builtin` 节点及其 incident edge；结构导出仍按 AD-18 输出 `nodeType=node-builtin`。

**独立单元 B：`webview/query projection`**

把 `node-builtin` 投影成允许的 `external-package` nodeKind，保留 `node:fs` 身份与边；结构导出再恢复为 AD-18 的 `node-builtin`。

两者都能逐字满足 AD-4 的 `node:<module>` 身份、AD-7 的四种图节点以及 AD-18 的导出联合，但 Overview、列表与入/出边计数不同。A 丢失合法依赖，B 则把 Node built-in 伪装成 npm 外部包；客户端无法仅凭合同判断哪个结果正确。

**缺口位置：** AD-7 只允许 `file/directory/workspace-package/external-package`，AD-18 又把 `external-package/node-builtin` 定义为两个不同的联合分支。

**处理：必须收紧 AD-7/AD-18，不可 Deferred。** 二选一固定：

- GraphViewModel 增加 `node-builtin`，并明确它与 `external-package` 共享 externalId/displayName 但保持独立 discriminant；或
- 明确 Node built-in 在图形 surface 的固定投影/隐藏规则、incident edge 与 truncation/count 语义，禁止实现自行选择。

### H2 — `GraphViewModel patch` 没有固定为“物化视图差量”，同一 revision pair 可得到不同视图

**独立单元 A：`application/querying`**

把 patch 计算为两个预算内、已排序 GraphViewModel 之间的完整差量：除新增事实外，也显式删除因 ranking/budget 被挤出的节点和边，并更新聚合、顺序、截断及 WorkspaceDiscoverySummary。

**独立单元 B：`graph-service patch publisher`**

把规范 GraphPatch 中与旧视图相交的实体变化直接投递给 Webview；不发送“仍存在但已跌出 top-N”的删除，也不把排序、聚合与截断变化视为 patch 内容。

双方都携带相同 `viewId/queryFingerprint/base+next graph/findings revision`，因此完全通过 AD-7 的身份检查；但 B 的客户端会长期保留已不属于新预算视图的节点。revision 连续只证明 patch 顺序正确，不能证明它是正确的 materialized-view delta。

此外，AD-3 只保证 SQLite GraphPatch 原子；当前没有要求客户端把一个 View patch 作为单一状态转换原子应用。合法客户端可在“删边、删节点、加节点、加边、更新 Finding”中间向图和列表发布不一致状态。

**处理：必须收紧 AD-7，不可 Deferred。** 固定 patch 是 `old GraphViewModel → new GraphViewModel` 的精确差量，而不是底层 GraphPatch 摘要；必须覆盖节点、边、排序、聚合、截断、Finding 和共享 summary。客户端先校验完整 base identity，再在内存中一次性应用并发布 next identity；操作集合应定义为无序集合或给出唯一应用顺序。无法生成精确差量时只能发 invalidation/full-refetch，不能发送“尽力而为”的 patch。

### H3 — `FindingSummaryV1.comparison` 缺少比较上下文，且 edge/SCC subject 不是闭合判别联合

**独立单元 A：`extension Problems/Findings`**

对普通 Problems 列表，以最近一次图谱变更 Job 的 `baseFindingsRevision` 为基线填充 `comparison=new|existing`；stale Finding 保留它最后一次有效 comparison。

**独立单元 B：`CLI/export`**

在没有显式 impact Git base 时，以 `firstSeenFindingsRevision == 当前 findingsRevision` 判断 new；stale Finding 重新相对当前 revision 计算 comparison。

AD-17 只固定“保存后相对 Job base”和“impact 相对 Git base”，却要求 Problems、Findings、NodeDetails、ChangeSummary、CLI、导出共用一个始终含 `comparison=new|existing` 的读模型；普通查询、首次打开、rebuild 后以及 stale 状态没有指定 baseline。两个结果都合规，却会让同一 Finding 在 IDE、CLI 和导出中同时显示“新增”和“既有”。

同一段规则还只说 subject 是“edge 或 SCC”。生产者可输出 `{edgeId}` / `{nodeIds,evidencePathEdgeIds}`，消费者也可合法期待 `{kind, id, members, evidence}`；没有固定 discriminant 与每个分支的必填字段，运行时 Schema 无法独立收敛。

**处理：必须收紧 AD-17，不可 Deferred。** 至少固定：

- `subject` 为闭合联合，例如 `edge{edgeId}` 与 `scc{nodeIds,evidencePathEdgeIds}`；
- comparison 必须同时携带 `comparisonContext`（job + baseFindingsRevision、git + base ref/派生基线，或 none）；
- 无基线或 stale 时是 `not-applicable/unknown`，还是保留最后有效结果，必须唯一决定；若不希望扩枚举，则 comparison 在这些上下文应可空，而不能强造 new/existing。

### H4 — telemetry kill switch 与 `configRevision` 的提交时刻未绑定

初始 `configRevision=10, telemetry=on`，且有长时间 indexing Job 正在运行。

**独立单元 A：`graph-service config owner`**

收到 on→off 后立即切 Noop、清空缓冲，同时立即生成 `configRevision=11` 并广播。因为 queryFingerprint 必须包含 configRevision，全部活动 GraphViewModel 立即失配并全量重取。

**独立单元 B：`graph-service safety override`**

立即切 Noop 并返回 `effectiveTelemetry=off`，但把它视为独立安全覆盖；`EffectiveServiceConfig/configRevision` 仍为 10，等活动 Job 到边界时才提交 revision 11 并广播。

两者都遵守 AD-16 的“确认前关闭且不得再发送”和 AD-22 的“on→off 是 Job 边界的唯一例外”，因为当前没有说明隐私覆盖是否构成新的 EffectiveServiceConfig 快照、何时递增 revision、响应/广播携带哪个 revision。结果是相同 configRevision 可代表不同 effective telemetry 状态，或一次不影响查询结果的隐私开关使全部视图无条件失效；多客户端观察顺序也不同。

off→on 还有同类分叉：`service/reconfigure` 是返回“已接受”还是等待 Job 边界后返回“已生效”，`service/status` 在等待期间显示 off 还是 on，目前没有状态模型可表达。

**处理：必须收紧 AD-16/AD-22，不可 Deferred。** 明确 requested/effective telemetry、accepted/applied configRevision 与广播顺序。推荐 on→off 在切 Noop与清空缓冲的同一临界区立即提交并广播新 configRevision；off→on 在 Job 边界真正换成发送实现后才成为 effective/on。若 telemetry 不应改变查询形状，则不要让其 revision 进入 GraphViewModel queryFingerprint，或把影响视图的 config revision 与 privacy/runtime revision 分开。

### H5 — `cancelled/partial/stale` 缺少按 Job kind 与提交进度的转换表

当前缓存为 `current/complete`，随后发生取消。

**独立单元 A：`IndexStatusSummaryV1` 发布器**

对任何 cancelled Job（包括只读 check/impact/export）都把缓存标记为 stale；增量索引按 ownership slice 分批提交 GraphPatch，取消发生在部分提交后便标记 `partial/stale`，并把 `completedScope` 解释为已扫描路径集合。

**独立单元 B：`extension/status consumer`**

只读 Job 取消时保持缓存 `current/complete`；增量索引把本轮候选先计算为一个 job-wide GraphPatch，取消发生在提交前便继续暴露旧的完整快照并标记 `complete/stale`，只有未完成 full rebuild reconciliation 才按 AD-8 标记 `partial/stale`；`completedScope` 解释为 `{completed,total,unit}`。

AD-8 唯一固定的是“未完成 rebuild 必须 partial/stale”，没有固定增量 Job 是 per-slice commit 还是 job-wide commit，也没有固定 queued-before-start、read-only Job、增量 Job 零提交/部分提交、规则重评估取消各自如何改变 cache summary。AD-7 虽列出 current/last Job 与字段，却也没有固定：current 是否只允许 queued/running、last 是否只允许 terminal、字段空值条件、`lastJobError` 所属层级、`completedScope` 的单位与它和 committed counts 的关系。

**不兼容结果：** service/status、job/get、GraphViewModel 和 StatusBanner 会对同一次取消给出不同恢复动作；某些客户端会误把取消只读导出显示成“索引缓存过期”，另一些会把混合 revision 缓存宣称为 complete。

**处理：必须收紧 AD-7/AD-8，不可 Deferred。** 为每类 Job 定义其是否能改变 graph/findings snapshot，并给出取消矩阵：开始前、无提交、部分提交、完整提交后的 cache freshness/completeness 与 current/last Job 归属。`completedScope` 必须是版本化判别联合或固定 progress unit；read-only Job 取消不得改变 committed cache 状态。

## Medium Findings

### M1 — `WorkspaceDiscoverySummary` 的 status 条件字段与计数口径未定义

**独立单元 A：workspace discovery** 在 `single` 时令 `packageCount=1`（根 package），在 `degraded` 时保留已部分发现的数量和 kind，并把诊断放在 summary 外的公共 diagnostics。

**独立单元 B：Overview/IndexSummary** 期待 `single.packageCount=0`（workspace-package 节点数），`degraded.packageCount=0`（不可宣称任何可靠 package 数），且 degraded summary 内必须有 diagnosticRef。

AD-5 的“kind 可为、携带 packageCount 与可选诊断引用”允许两者；但 UI 数字、恢复入口与 AnalyzerConfigSnapshot 中 workspacePackages 的解释不同。

**处理：收紧 AD-5。** 把 summary 固定为 status 判别联合，定义每个分支的 kind/packageCount/diagnosticRef 必填与禁止条件；明确 packageCount 是否包含普通根 package、degraded 是否只允许可靠计数或必须为 null/0，以及诊断引用是在 summary 内还是通过稳定 ID 关联公共 diagnostics。

### M2 — `NavigationTargetV1` 只规定 symbol 分支，未固定附件规则与 file/directory 分支

**独立单元 A：query service** 在 Current Context 以 symbol 为中心时，让对应 file node 携带 `targetKind=symbol`；普通 file/directory/workspace-package 分别导航到源码、目录和 package root。

**独立单元 B：webview/extension** 始终把 file node 导航到文件，只在 NodeDetails 中提供 symbol 跳转；workspace-package 导航到 package.json；external-package 不附 target。

双方都满足“节点可携带 target”和“symbol target 若存在必须有 symbolId/path/range”。因为“可携带”没有说明哪些场景必须提供 symbol target，FR-9 可以在一个完全合规实现中从图 surface 消失；file/directory 分支的必填字段、range 允许性和 package 附件规则也可不同。

**处理：收紧 AD-7。** 固定 `NavigationTargetV1` 的三分支必填/禁止字段，并给出 nodeKind × targetKind 附件矩阵；明确 symbol-centered file node、NodeDetails symbol row 和 workspace-package 的权威跳转目标，external-package/node-builtin 在 V1 是无 target 还是使用另一种外部动作。

### M3 — `ExportPreviewModelV1` 没有封闭 artifact/targetState 的线协议边界与隐私状态组合

**独立单元 A：export service + extension** 只在线协议返回不可变 `artifact`；extension 本地组装 `targetState`、保存绝对目标、执行 copy/write，并向 Webview 发送脱敏状态。

**独立单元 B：export service** 在线协议返回完整 ExportPreviewModelV1，其中包含脱敏 target label、write status 和 diagnostics；客户端另存绝对路径并回传写入结果。两者都满足“targetState 由客户端持有”和“绝对路径不进服务线协议”，但 service-client 合同完全不同。

同时 `containsSource` 与 `contentPolicy` 的关系未定义：一个实现可把 contentPolicy 当“用户请求”，即策略为 include-source 但实际 artifact 因权限/截断仍 `containsSource=false`；另一个把它当“实际生效策略”，要求两者严格一致。隐私提示与是否允许写入会因此分叉。

**处理：收紧 AD-18。** 明确 service wire 只返回 `ExportArtifactV1`，还是也返回 preview metadata；明确 targetState 只存在于 extension/client-local 模型、谁负责原子文件替换、哪些脱敏字段可发往 Webview。固定 requestedPolicy/effectivePolicy/containsSource 的合法组合以及失败重试时 artifact identity 不变的规则。

## 已闭合的重点

- `WorkspaceDiscoverySummary.status` 枚举与 degraded 不阻断 TS/JS 索引已固定；本轮只质疑分支字段口径。
- `lifecycle/availability/freshness/completeness` 已拆为正交维度，服务级 fatal 与 Job failure 已分开；本轮只质疑取消转换和 DTO 嵌套/空值语义。
- telemetry on→off 的“先停止发送再确认”已经足以防止关闭后的新泄露；本轮不否定 kill switch，只质疑它与共享配置快照的 revision 关系。
- GraphViewModel patch 已有 view/query 身份与双 revision，可检测乱序/跨查询 patch；本轮只质疑 patch 的内容定义与客户端原子应用。
- StructureContextExportV1 的内部/外部 relativePath 判别已闭合；剩余冲突只发生在 `node-builtin` 如何进入四类 GraphViewModel。

## 建议收敛顺序

1. 先统一 GraphViewModel 的 external entity taxonomy，并把 patch 固定为原子 materialized-view delta。
2. 再固定 FindingSummary 的 subject/comparison context 与 IndexStatus 的取消转换矩阵。
3. 绑定 telemetry effective state 与 configRevision 的原子提交/广播顺序。
4. 最后把 WorkspaceDiscoverySummary、NavigationTargetV1、ExportPreviewModelV1 改成条件闭合的判别联合；具体 TypeScript 字段名可继续由 contracts 包成为代码权威。
