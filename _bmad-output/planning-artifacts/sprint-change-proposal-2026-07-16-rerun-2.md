---
title: Sprint Change Proposal — Implementation Readiness rerun-2 纠偏
status: implemented
mode: Batch
created: 2026-07-16
primaryEvidence: implementation-readiness-report-2026-07-16-rerun-2.md
recommendedApproach: Direct Adjustment
scopeClassification: Moderate
approvalBasis: 用户明确要求依据最新报告执行修正，并在执行期间连续确认继续
originalPlanningArtifactsModified: true
modifiedArtifacts:
  - epics.md
  - ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
  - ux-designs/ux-bmad-2026-07-13/reconcile-implementation-readiness-2026-07-16-rerun-2.md
sprintStatusUpdate: not-applicable-file-not-found
---

# Sprint Change Proposal：Implementation Readiness rerun-2 纠偏

## 1. Issue Summary

### 1.1 变更触发

最新 `implementation-readiness-report-2026-07-16-rerun-2.md` 将整体实施就绪状态评为 `NEEDS WORK`。PRD、Architecture、UX 主干、FR 覆盖和 Epic 用户价值均已通过；剩余问题集中在 Story 依赖合同、Story 1.1/1.2 的验收归属，以及两项低严重度措辞/范围状态。

### 1.2 证据与问题分类

| ID | 严重度 | 证据 | 核心问题 |
| --- | --- | --- | --- |
| EQ-M1 | Major | 61 个 Story 中仅 16 个含自然语言依赖字段 | 实现代理无法可靠区分可并行 Story 与遗漏依赖；文档顺序承担了隐式语义。 |
| EQ-M2 | Major | Story 1.1 最后一组 AC 要求 Story 1.2 开始或提交 | Story 1.1 无法在 Story 1.2 尚未发生时独立完成验收。 |
| EQ-L1 | Minor | Story 5.11 使用“5.6–5.10 可提供”，矩阵使用“必须依赖” | 依赖强度不一致。 |
| UX-A1 | Low | `EXPERIENCE.md` 将 Finding 忽略/豁免/趋势标为开放假设 | 与 PRD“当前无未确认假设”的现行状态不完全一致。 |

问题类型为规划制品一致性与执行调度合同缺口，不是技术可行性失败、产品战略变化或 MVP 范围失控。

## 2. Impact Analysis

### 2.1 Epic 与 Story 影响

- 5 个 Epic 的用户价值、顺序和范围保持不变。
- 不新增、删除或重编号 Story；总数保持 61。
- `epics.md` 新增覆盖全部 61 个 Story 的 `StoryDependencyDagV1`，文档顺序降级为纯展示语义。
- Story 1.1 只验收最小 `architecture-required` 已配置、always-run、可真实失败并阻断，且完成证据不依赖 Story 1.2。
- Story 1.2 增加“实际通过同一最小门禁”的合并证据。
- Story 4.8 明确可与 Story 4.5/4.6 在 Story 4.4 后并行，不再用“建议后验证”制造隐式依赖。
- Story 5.11 明确必须等待 Story 5.6–5.10 全部完成。

### 2.2 制品冲突与影响

| 制品 | 影响 | 处置 |
| --- | --- | --- |
| PRD / Addendum | 无冲突 | 不修改；FR-1 至 FR-23、NFR-1 至 NFR-27、SM 与 MVP 范围保持不变。 |
| Architecture / Implementation Guide | 无冲突 | 不修改；AD-28 已提供 Story 1.1/1.2 的时序边界，AD-30 已提供发布验证合同。 |
| Epics / Stories | Major | 新增权威 DAG，修正 CI 验收归属和依赖强度。 |
| UX Experience | Low | 将开放假设改为明确的 MVP Out-of-Scope 决定，并给出负责人和重评触发条件。 |
| Sprint status | N/A | 未发现 `sprint-status.yaml` 或等价文件；没有 Epic/Story 增删、重编号或状态变化可同步。 |

### 2.3 技术与交付影响

- 不修改产品代码、基础设施、CI 配置或部署产物。
- 不回滚已完成工作。
- 主要收益是实现代理可安全并行调度，并能独立关闭 Story 1.1。
- 时间影响为低：仅需重新运行 Implementation Readiness；无需重做 PRD、Architecture 或 UX 主流程。

## 3. Change Analysis Checklist

| 检查项 | 状态 | 结论 |
| --- | --- | --- |
| 1.1 触发 Story | [x] | 触发集中在 Story 1.1/1.2、2.3、2.5、3.2、4.2、4.5、4.6、5.11 及全局依赖合同。 |
| 1.2 核心问题 | [x] | 原要求理解与规划表达不完整；不是实现失败或战略转向。 |
| 1.3 支撑证据 | [x] | 最新 readiness 报告提供 2 Major、1 Minor、1 Low 的具体证据。 |
| 2.1 当前 Epic 可完成性 | [x] | 全部 Epic 仍可按原目标完成。 |
| 2.2 Epic 级变更 | [N/A] | 不修改 Epic 范围或验收标准。 |
| 2.3 未来 Epic 影响 | [x] | 仅澄清跨 Epic 前置与可并行关系。 |
| 2.4 新增/失效 Epic | [N/A] | 无。 |
| 2.5 Epic 优先级 | [N/A] | 不调整。 |
| 3.1 PRD 冲突 | [x] | 无；MVP 仍可实现。 |
| 3.2 Architecture 冲突 | [x] | 无；现有 AD-28/AD-30 支持本次修正。 |
| 3.3 UX 冲突 | [x] | 仅开放假设状态需要关闭。 |
| 3.4 其他制品 | [x] | 无代码、部署、监控或 CI 文件修改；sprint status 文件不存在。 |
| 4.1 直接调整 | [x] Viable | 工作量低至中，风险低，不改变产品范围。 |
| 4.2 回滚 | [x] Not viable | 没有已实施成果需要回滚，回滚不能修复规划语义。 |
| 4.3 MVP Review | [x] Not viable | PRD 与覆盖已通过，不需要缩减或重定义 MVP。 |
| 4.4 推荐路径 | [x] | 选择 Direct Adjustment。 |
| 5.1 问题摘要 | [x] | 已完成。 |
| 5.2 Epic/制品影响 | [x] | 已完成。 |
| 5.3 路径与理由 | [x] | 已完成。 |
| 5.4 MVP 与行动计划 | [x] | MVP 不变；修正规划工件后重跑 readiness。 |
| 5.5 Agent handoff | [x] | PO/Developer 负责使用 DAG 调度；Architect 负责重跑 readiness。 |
| 6.1 清单复核 | [x] | 所有适用项已处理。 |
| 6.2 提案准确性 | [x] | 与最新报告、PRD、Architecture、UX、Epics 交叉核对。 |
| 6.3 用户批准 | [x] | 用户明确要求执行修正并连续确认继续，Batch 变更已获执行授权。 |
| 6.4 sprint-status.yaml | [N/A] | 文件不存在，且本次无 Story 增删/重编号/状态变化。 |
| 6.5 下一步与交接 | [x] | 见第 6 节。 |

## 4. Recommended Approach

采用 **Direct Adjustment**：只修订受影响的规划合同，不改产品方向，不引入回滚，不缩减 MVP。

| 选项 | 工作量 | 风险 | 结论 |
| --- | --- | --- | --- |
| 直接调整 Story/UX 规划工件 | Low–Medium | Low | 推荐；能直接关闭全部 4 项发现。 |
| 回滚已完成工作 | Medium | Medium | 不适用；没有实现回滚目标。 |
| 重审或缩减 MVP | High | Medium–High | 不适用；PRD、架构和覆盖已通过。 |

变更范围评定为 **Moderate**：需要调整 Backlog 依赖合同和 UX 范围记录，但不需要 PM/Architect 重新定义产品或技术架构。

## 5. Detailed Change Proposals

### 5.1 Story 依赖权威

**Artifact:** `epics.md`  
**Section:** 概述、Story 编号与依赖、Story 依赖与追踪矩阵

**OLD:**

> 文档顺序和显式依赖字段共同定义执行顺序。

**NEW:**

> `StoryDependencyDagV1` 是唯一依赖权威；正文顺序为 `display-only`。DAG 覆盖 61/61 Story，只列直接完成前置，引用必须存在且整体无环。

**Rationale:** 机器调度不再依赖文档位置，也不会把全部 Story 不必要地串行化。

### 5.2 Story 1.1 / 1.2 验收归属

**Artifact:** `epics.md`  
**Section:** Story 1.1、Story 1.2 Acceptance Criteria

**OLD:**

> Story 1.1 的 AC 在 Story 1.2 开始或提交时，要求 Story 1.2 通过同一最小 CI。

**NEW:**

> Story 1.1 独立证明 required check 已配置、always-run、可由真实失败阻断，且证据不依赖 Story 1.2。Story 1.2 自己记录实际通过相同最小 CI 的合并证据。

**Rationale:** 恢复 Story 1.1 的独立完成性，同时保留 AD-28 的顺序门禁。

### 5.3 Story 4.8 并行关系

**Artifact:** `epics.md`  
**Section:** Story 4.8 依赖

**OLD:**

> 依赖 Story 4.4；建议在 Story 4.5、Story 4.6 后验证呈现一致性。

**NEW:**

> 直接依赖 Story 4.4；Story 4.5、4.6 与 4.8 可在 4.4 后并行消费同一结论合同。

**Rationale:** 去除“建议”造成的隐式完成前置，保留可并行性。

### 5.4 Story 5.11 依赖强度

**Artifact:** `epics.md`  
**Section:** Story 5.11 依赖、关键依赖摘要

**OLD:**

> Story 5.6 至 Story 5.10 可提供技术与候选输入。

**NEW:**

> Story 5.6 至 Story 5.10 必须全部完成；Story 5.11 冻结这些输入后再解锁 Story 5.12。

**Rationale:** 与候选绑定、证据冻结和最终 Go/No-Go 时序一致。

### 5.5 UX 范围决定

**Artifact:** `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`  
**Section:** MVP Scope Decisions

**OLD:**

> `[ASSUMPTION]` Finding 首版不提供 UI 内忽略、豁免审批或历史趋势。

**NEW:**

> `[DECISION][MVP-OUT-OF-SCOPE]` 明确排除上述能力；仅在 Beta+ 门禁完成且真实团队证据显示该缺失阻断核心任务时，由产品负责人和 UX 负责人重新评估。

**Rationale:** 与 PRD“无未确认假设”一致，同时保留可审计的后续触发条件。

## 6. Implementation Handoff

### 6.1 范围与接收角色

- **范围：Moderate。** Backlog 依赖合同已重组，产品与架构主干未改变。
- **Product Owner / Developer：** 后续调度只读取 `StoryDependencyDagV1`；不得使用文档顺序补全缺失依赖。
- **Developer：** Story 1.1 与 Story 1.2 分别收集各自门禁证据；Story 4.5/4.6/4.8 在 Story 4.4 后可并行。
- **Architect / Readiness Owner：** 重新运行 Implementation Readiness，重点复核 DAG 完整性、Story 1.1/1.2 验收归属、Story 5.11 依赖强度和 UX 决定状态。

### 6.2 成功标准

1. `StoryDependencyDagV1` 节点数为 61，覆盖全部 Story 标题，无未知引用、重复节点或环。
2. 唯一 DAG 起点为 Story 1.1；文档顺序明确为 `display-only`。
3. Story 1.1 的完成不再依赖 Story 1.2 的未来事件；Story 1.2 自带实际 CI 通过证据。
4. Story 5.11 明确依赖 Story 5.6–5.10 全部完成。
5. UX 不再保留 Finding UI 忽略/豁免/趋势的开放假设。
6. 重跑 Implementation Readiness 后，EQ-M1、EQ-M2、EQ-L1、UX-A1 均关闭，预期状态为 `READY`。

## 7. Workflow Execution Log

| 时间 | 动作 | 结果 |
| --- | --- | --- |
| 2026-07-16 | 加载 Correct Course 技能、配置、检查清单与最新 readiness 报告 | 完成；Batch 模式。 |
| 2026-07-16 | 加载 PRD、Architecture、UX、Epics 规范上下文 | 完成；PRD/Architecture 无需修改。 |
| 2026-07-16 | 执行影响分析与路径选择 | 选择 Direct Adjustment，范围 Moderate。 |
| 2026-07-16 | 修改 `epics.md` 与 `EXPERIENCE.md` | 完成。 |
| 2026-07-16 | 生成 UX 对账记录与本提案 | 完成。 |
| 2026-07-16 | 检查 sprint status | 未发现文件，标记 N/A。 |

## 8. Completion

- Issue addressed：Story DAG、CI 验收归属、Story 5.11 依赖强度、UX 假设状态。
- Change scope：Moderate。
- Artifacts modified：`epics.md`、`EXPERIENCE.md`。
- Artifacts added：本提案、UX 最新对账记录。
- Routed to：Product Owner / Developer；随后由 Architect / Readiness Owner 重跑实施就绪评估。

