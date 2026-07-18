---
title: Architecture Spine Good-spine Rubric Review — Round 9
date: 2026-07-14
reviewer: rubric-walker-round9
verdict: changes-required
scope: ../ARCHITECTURE-SPINE.md
---

# Good-spine Rubric Review — Round 9

## Verdict

**CHANGES REQUIRED — 0 Critical、2 High、3 Medium。** 机械 lint 通过；本轮新增合同总体处于正确的 initiative altitude，且 ConfigDiagnosticV1、telemetry immediate opt-out 与结构导出判别联合足够而未膨胀。剩余问题不是技术栈或范式问题，而是两个共享读模型仍允许下一级实现对同一状态作出不兼容解释。

## Mechanical Gate

执行：

```text
uv run E:/bmad/.agents/skills/bmad-architecture/scripts/lint_spine.py \
  --workspace E:/bmad/_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13
```

结果：`ok: true`，`total_findings: 0`。

## Findings

### H1 — FindingSummaryV1 的 comparison 没有携带比较基线，无法兑现“新增只相对于基线”

- **Evidence:** AD-17 先规定保存后相对于 Job base findings revision、impact 相对于所选 Git base 的派生基线；随后又要求 Problems、Findings、NodeDetails、ChangeSummary、CLI 与导出共用 FindingSummaryV1，并强制 `comparison=new|existing`，但模型中没有 comparison basis、base revision 或 Git base identity。
- **Why this breaks the spine:** 同一个 FindingSummaryV1 在无显式基线的 Problems/Findings/NodeDetails 与有基线的 impact/PR/export 中都必须给出 `new|existing`。服务、扩展和导出器只能依赖调用上下文自行猜测“相对于谁”，因此 AD-17 的 Rule 没有真正防止其 Prevents 所述的 IDE/PR 新旧定义漂移；离开原 RPC envelope 后该 summary 也不可自描述。
- **Required fix:** 将 comparison 改成可判别、可自描述的比较结果，例如 `{value, basisKind, baseFindingsRevision?, gitBaseId?}`，并规定无比较上下文的 surface 返回 `comparison=null/absent`；或者把 comparison 从共享 FindingSummaryV1 移到明确携带 comparison basis 的 Change/Impact wrapper。两种方式任选其一，但必须让 baseline identity 与 comparison 同生同灭。
- **Disposition:** autofix。

### H2 — IndexStatusSummaryV1 尚未被固定为所有状态 surface 的唯一来源

- **Evidence:** AD-7 只明确要求 GraphViewModel 携带 IndexStatusSummaryV1，并禁止 Webview 从节点/通知反推状态；AD-10 的 TreeView、Problems、Status Bar，AD-13 的 `codegraph status`，以及 AD-23 的 `service/status` 没有被要求消费或投影同一 summary。
- **Why this breaks the spine:** VS Code 非 Webview surface、CLI 和控制协议仍可各自定义 stopped/idle/cancelled/failed、旧缓存可用性与 Job 进度。该缺口正是 AD-7 新 Prevents 中要消除的“服务与 Webview 各自解释”，只是目前只封住了 Webview 一条路径。与此同时 `progress`/`completedScope` 的单位或判别形态未固定，`freshness=refreshing` 又与 current Job 同时表达活动状态，进一步允许各 surface 产生不同映射。
- **Required fix:** 明确 `service/status` 返回 canonical IndexStatusSummaryV1，GraphViewModel、TreeView/Status Bar、CLI status/doctor 只能直接消费或无损投影它；规定 currentJob/lastJob 的 nullability、progress 的确定/不确定判别与单位，并明确 `refreshing` 是缓存 freshness 的规范值还是由 currentJob 派生的展示值，不能两种解释并存。
- **Disposition:** autofix。

### M1 — AD-5 新增的 workspace degradation Rule 超出了其 Prevents

- **Evidence:** AD-5 的 Prevents 仅描述 Tree-sitter、TypeScript 与语言服务并行解释同一事实；Rule 后半新增 WorkspaceDiscoverySummary、degraded fallback、禁止 package 聚合结论和恢复诊断。
- **Why this matters:** WorkspaceDiscoverySummary 本身是必要且精炼的 initiative invariant，但其主要防止的是“workspace 识别失败阻断全部索引”与“降级状态仍宣称 package 完整”，不是分析器权威源冲突。Binds/Prevents/Rule 的可追溯性因此不完整。
- **Required fix:** 扩充 AD-5 Prevents 以覆盖上述两类 divergence；无需拆出新 AD，也无需增加字段。
- **Disposition:** autofix。

### M2 — NavigationTargetV1 的判别联合只封闭了 symbol 分支

- **Evidence:** AD-7 固定 `targetKind=file/directory/symbol`，但只规定 symbol 必须携带 `symbolId/relativePath/range`；file/directory 分支没有规定目标身份，且“package 节点可携带”没有区分 workspace-package 与 external-package。
- **Why this matters:** 扩展与 Webview 可以分别选择 node 自身 path、relativePath、URI 或外部 package 元数据作为目标；虽然绝对路径被全局禁止，V1 合同仍未做到按 targetKind 可运行时校验。
- **Required fix:** 用最小判别联合封闭三个分支，例如 file/directory 均要求 workspace-relative path（可选稳定 entity id），symbol 保持现有三字段；明确 external-package 默认无本地 NavigationTarget，只有存在受信任的本地目标时才允许携带。
- **Disposition:** autofix。

### M3 — “Beta+（完整 MVP）”门禁没有显式声明累积性与全需求覆盖

- **Evidence:** release slice 表分别列 Alpha、Beta、Beta+ 的能力，正文称 Beta+ 是“完整 MVP 的完成门禁”，但未明确 Beta+ 必须累积 Alpha/Beta 且满足 frontmatter 绑定的全部 FR/SM/NFR；Beta+ 行本身只列 rules、Findings、check/impact、PR Markdown 与结构导出。
- **Why this matters:** 作为发布门禁，团队可将该行解释为增量能力清单，也可解释为完整验收清单；前一种解释可能在性能、安全、可访问性或基础索引门禁未同时通过时仍宣称 MVP 完成。
- **Required fix:** 增加一句“release slices 累积；Beta+ completion 同时要求 Alpha/Beta 能力及全部绑定 FR/SM/NFR 的适用门禁通过”。不需要把全部需求重新抄入表格。
- **Disposition:** autofix。

## Focused Assessment of Round-9 Additions

| Addition | Result | Initiative-level assessment |
| --- | --- | --- |
| WorkspaceDiscoverySummary | **Pass with M1** | `single/recognized/degraded` 与降级行为是跨分析、服务和 UI 的真实分叉点；字段数量克制。只需让 Prevents 对齐。 |
| IndexStatusSummaryV1 | **High finding H2** | 分离 Job 与 committed cache 是正确主干；但必须成为所有状态 surface 的 canonical contract，并封闭 progress/refreshing 语义。 |
| NavigationTargetV1 | **Medium finding M2** | “符号跳转不增加第五种图节点”是合适 invariant；三个判别分支尚未完全封闭。 |
| FindingSummaryV1 | **High finding H1** | 共享 Finding 读模型合适；把 context-dependent comparison 强塞进无 baseline identity 的共享模型不可执行。 |
| ConfigDiagnosticV1 | **Pass** | Problems、CLI、doctor 共享诊断合同是必要 seam；路径/range 已继承全局约定，字段足够且没有下沉到 Ajv 内部数据形状。 |
| Telemetry immediate opt-out | **Pass** | AD-16 与 AD-22 一致固定了确认前 Noop、拒绝新事件、丢弃未发送缓冲及 Job-boundary 例外，Rule 确实防止所述隐私 divergence。 |
| Export discriminated union | **Pass** | internal/external 的 relativePath/externalId 边界明确，防止外部实体伪造工作区路径；未把完整导出 schema 膨胀进 spine。 |
| Beta+ 完整 MVP | **Pass after M3** | Alpha/Beta/Beta+ 的切片方向合理；补一条累积/全需求门禁即可成为可执行发布 invariant。 |

## Good-spine Checklist

| Checklist item | Result |
| --- | --- |
| 固定 initiative 下一级真实分叉点 | **Needs fix — H1/H2** |
| 每个 AD Rule 可执行并实现 Prevents | **Needs fix — H1/M1** |
| Deferred 不允许兼容性分叉 | **Pass** |
| 覆盖已绑定 FR/NFR/能力 | **Pass with M3 clarification** |
| 部署、环境、运维、安全 | **Pass** |
| 数据、状态、版本、发布 | **Needs fix — H1/H2/M3** |
| 技术版本固定且无本轮新增未锁版本 | **Pass for rubric lens** |
| 不膨胀、保持 initiative altitude | **Pass** |

## Deferred and Operational Envelope

未发现新的 Critical/High 缺口。服务发现与升级交接、平台交付矩阵、缓存与数据库恢复、Workspace Trust、IPC/路径/CSP、日志轮转、Job 取消、协议/schema 演进和超规模行为均已决定；第二语言、WASM/SQLite 替换、额外平台、第二渲染器、multi-root federation、MCP/云/跨仓库能力均有明确 Deferred 边界与重访条件。上述 H1/H2 属于现有共享合同闭合问题，不应移入 Deferred。

## Gate Recommendation

完成 H1、H2 与三项小型 autofix 后重新运行 lint 和 rubric delta review；不需要改变六边形架构、模块边界、技术栈、GraphPatch 原子提交或发布平台策略。
