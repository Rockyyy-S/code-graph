---
title: Architecture Spine Good-spine Rubric Review — Round 10
date: 2026-07-14
reviewer: rubric-walker-round10
verdict: changes-required
scope: ../ARCHITECTURE-SPINE.md
supersedes: review-rubric-round9.md
---

# Good-spine Rubric Review — Round 10

## Verdict

**CHANGES REQUIRED — 0 Critical、2 High、1 Medium。** Round 9 的 2 High/3 Medium 中三项已完全闭合，两项仍为部分闭合；此外 AD-18 的重写删除了源码导出的显式授权语义，形成一个新的 High。机械 lint 继续通过。

## Mechanical Gate

执行：

```text
uv run E:/bmad/.agents/skills/bmad-architecture/scripts/lint_spine.py \
  --workspace E:/bmad/_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13
```

结果：`ok: true`，`total_findings: 0`。

## Round-9 Closure Matrix

| Round-9 finding | Round-10 result | Evidence |
| --- | --- | --- |
| H1 FindingSummaryV1 缺少比较基线 | **Closed** | AD-17 现有 `comparisonContext=job|git|none`，job 携带 baseFindingsRevision，git 携带 baseRef 与双 base revision；无基线或 stale 固定 `not-applicable`，所有 surface 禁止自行推导。 |
| H2 IndexStatusSummaryV1 未成为唯一来源 | **Partially closed — remains High** | `service/status` 已成为权威，GraphViewModel/TreeView/Status Bar/CLI 已绑定同一合同，progress 与 refreshing 也已分离；但状态枚举/合法组合在重写时丢失，且 status-only 更新没有可排序的 revision。 |
| M1 AD-5 Prevents 未覆盖 workspace 降级 | **Closed** | Prevents 已覆盖“识别失败阻断普通索引”和“降级后仍宣称 package 完整”，Rule 又用判别联合封闭 single/recognized/degraded。 |
| M2 NavigationTargetV1 未封闭 file/directory | **Partially closed — remains Medium** | 三个分支字段已封闭，但 workspace-package 被描述为提供未在联合中声明的 `package-root` 目标。 |
| M3 Beta+ 未声明累积与全需求门禁 | **Closed** | release slice 后已明确 Beta/Beta+ 累积，并要求全部适用 FR、SM、NFR 同时通过。 |

## Remaining and New Findings

### H1 — IndexStatusSummaryV1 仍不是封闭、可排序的 canonical 状态合同

- **Evidence:** AD-7 只保留 `freshness=current|stale|null`，但不再声明 lifecycle、availability、completeness 的合法值，也删除了 availability/freshness/completeness 的合法组合。`currentJob`/`lastJob` 和 GraphViewPatchV1 可在 graphRevision/findingsRevision 不变化时更新，但合同没有单调 `statusRevision`；多个 status-only delta 具有相同 view/query 与 base/next 双数据 revision，客户端无法检测乱序或重复应用。
- **Why this remains High:** canonical source 已解决“谁拥有状态”，却没有解决“状态是什么”和“哪个状态更新更新”。TreeView、Status Bar、CLI 与 Webview 仍能对空缓存、失败服务、partial/stale 作出不同枚举映射；GraphViewPatch 将 IndexStatusSummaryV1 带入另一更新通道后，单靠图/规则 revision 无法维持原子发布语义。
- **Required fix:** 在 AD-7 恢复封闭枚举与合法矩阵：`lifecycle=stopped|starting|running|stopping|failed`、`availability=absent|available`、`freshness=null|current|stale`、`completeness=empty|partial|complete`；absent 必须对应 null/empty，available 必须对应 current|stale 与 partial|complete，并明确 currentJob/lastJob 可空。给 IndexStatusSummaryV1 增加单调 `statusRevision`，GraphViewPatchV1 增加 `baseStatusRevision/nextStatusRevision` 并与双数据 revision 一起校验；若不愿新增 revision，则必须禁止 GraphViewPatch 改写状态，只允许 canonical status 通知更新。
- **Disposition:** autofix。

### H2 — AD-18 不再用 Rule 保证“默认只含结构、源码必须显式开启”

- **Evidence:** AD-18 的标题仍称默认只含结构，Prevents 仍包含导出泄露源码；但当前 Rule 只声明 ExportArtifactV1 携带 `requestedPolicy/effectivePolicy/containsSource`，以及 `structure-only` 时 `containsSource=false`，没有封闭 policy 枚举、默认值、授权动作或 effectivePolicy 的收紧方向。Round 9 版本中“源码只能由当前命令显式开启”的约束已被删除。
- **Why this is High:** 下一级实现可以合法地把 requestedPolicy 默认成 include-source，或由持久设置/客户端隐式开启；这直接违反 NFR-security-privacy 和 AD-18 的 Prevents。标题不是可运行时验证的合同，`containsSource` 也只是事后标签，不能代替授权规则。
- **Required fix:** 在 AD-18 固定 `requestedPolicy/effectivePolicy=structure-only|include-source`，默认必须是 structure-only；include-source 只能由当前 export 请求中的显式用户动作开启，不得从持久设置、历史请求或目标类型继承。effectivePolicy 只能等于或比 requestedPolicy 更严格，`containsSource` 必须由 artifact content 校验得出，structure-only 永远为 false。
- **Disposition:** autofix。

### M1 — NavigationTargetV1 的 workspace-package 映射仍引用联合外目标

- **Evidence:** AD-7 先将 NavigationTargetV1 封闭为 file/directory/symbol，随后写明 file/directory/workspace-package 分别提供 file/directory/package-root 目标；`package-root` 不是合法 targetKind。
- **Why this matters:** schema 实现可将 package-root 当成第四个分支，也可将其理解为 directory 的语义别名，破坏“封闭联合”的唯一解释。
- **Required fix:** 将该句收紧为“workspace-package 携带 `directory{relativePath:<package-root>}`；external-package 不携带本地目标”，不要引入 package-root targetKind。
- **Disposition:** autofix。

## New-Change Safety Check

除 H2 外，本轮对 WorkspaceDiscoverySummary、externalKind、GraphViewPatch delta/invalidate、Job 取消转换、Windows IPC 约束、telemetry configRevision、Finding comparisonContext、viewConfigRevision、ExportArtifact/Preview 分层和 cumulative release slices 的修订没有引入新的 Critical/High/Medium。GraphViewPatch 的 status sequencing 风险已并入 H1；其节点、边、Finding、排序、聚合和截断 delta 身份规则本身可执行。

## Good-spine Checklist

| Checklist item | Result |
| --- | --- |
| 固定 initiative 下一级真实分叉点 | **Needs fix — H1/H2** |
| 每个 AD Rule 可执行并实现 Prevents | **Needs fix — H2/M1** |
| Deferred 不允许兼容性分叉 | **Pass** |
| 覆盖已绑定 FR/NFR/能力 | **Pass after H2 privacy fix** |
| 部署、环境、运维、安全 | **Needs fix — H2** |
| 数据、状态、版本、发布 | **Needs fix — H1** |
| 技术版本固定且无新增未锁版本 | **Pass for rubric lens** |
| 不膨胀、保持 initiative altitude | **Pass** |

## Deferred and Operational Envelope

Deferred 仍完整且没有把当前 MVP 必须共享的合同推迟：第二语言/分析技术、WASM/SQLite 替换、额外平台、第二渲染器、multi-root federation、MCP/云/跨仓库能力都有边界与重访条件。部署矩阵、缓存恢复、服务交接、信任与 IPC、日志、取消、协议/schema、超规模和发布门禁均已覆盖；H1/H2 是当前状态一致性与隐私授权的主干问题，不应进入 Deferred。

## Gate Recommendation

应用 H1/H2/M1 三个最小收紧后重跑 lint 与 rubric delta；不需要更改架构范式、模块边界、技术栈、GraphPatch 事务、WorkspaceDiscoverySummary 或发布切片。
