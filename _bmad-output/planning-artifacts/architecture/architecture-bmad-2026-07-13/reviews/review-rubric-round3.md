---
title: Architecture Spine Good-spine Rubric Review — Round 3
date: 2026-07-13
reviewer: rubric-walker-round3
verdict: fail-one-high
scope: ../ARCHITECTURE-SPINE.md
---

# Good-spine Rubric Review — Round 3

## Verdict

**FAIL — 第二轮 3 项 High 的主体设计均已闭合，但双 revision 的共享状态变更约定仍有一处直接矛盾，保留 1 项 High；未发现 Critical。**

确定性 lint 第三次通过，0 个机械问题。本报告只列 Critical/High。

## 第二轮 Finding 闭合检查

| 第二轮 finding | 结果 | 第三轮证据 |
| --- | --- | --- |
| R2-H1 ownershipSliceId 无 canonical boundary | **Closed** | AD-3 已固定 source/manifest/hierarchy 三种 slice、各自拥有的事实、analyzerVersion 非身份、complete/partial/failed 删除语义，以及 inputDigest/manifest CAS。 |
| R2-H2 graphRevision/findingsRevision 未贯穿合同 | **Partially closed** | AD-7/8/13/17/18、Time and revisions、State 与 ERD 已同时携带两种 revision；但 Mutations 约定仍与 AD-3 冲突，见 R3-H1。 |
| R2-H3 external package 稳定 ID 未规范 | **Closed** | AD-4 已固定 workspace package、npm purl、`@unresolved`、Node built-in、关系端点/qualifier 与 edge tuple。 |

## Remaining High Finding

### R3-H1 — Mutations Convention 禁止了 AD-3 明确允许的配置-only findingsRevision 推进

**位置：** AD-3、AD-17、Consistency Conventions / Mutations、Time and revisions。

AD-3 明确规定：

- 图谱事务推进 `graphRevision`，并针对同一快照推进 `findingsRevision`；
- 规则配置单独变化时，`graphRevision` 不变，只推进 `findingsRevision`。

但 Mutations Convention 仍规定“只有 GraphPatch 事务可推进 revision”。在同一约定表已明确存在 `graphRevision` 与 `findingsRevision` 两种 revision 的前提下，这句话不再能安全解释为只约束 graphRevision。

因此两个下一级实现单元可以作出相反但均有文本依据的选择：

- rules/application 遵守 AD-3，在配置变化后无 GraphPatch 推进 findingsRevision；
- store-sqlite 遵守 Mutations Convention，拒绝任何无 GraphPatch 的 revision 推进。

结果是规则配置更新可能无法提交，或被迫制造虚假的 GraphPatch/graphRevision，破坏 AD-3、AD-17 和缓存键语义。这是共享状态唯一变更路径上的直接冲突，达到 High。

**处置：autofix。** 将约定拆成两个明确规则：

- `graphRevision` 只能由成功提交的 GraphPatch 事务推进；
- `findingsRevision` 可由 GraphPatch 后的同快照规则评估，或规则配置变化触发的独立规则评估事务推进。

同时把 AD-16/Logging 中未限定的单一 `revision` 改为按事件记录相关的 graphRevision/findingsRevision，避免配置-only Findings 日志无法关联。

## Good-spine Checklist — Final Scan

| Checklist item | Critical/High result |
| --- | --- |
| initiative 下一级真实分叉点 | **Pass** |
| AD Rule 可执行并实现 Prevents | **Fail：仅 R3-H1** |
| Deferred 不允许兼容性分叉 | **Pass** |
| FR/NFR/能力覆盖 | **Pass** |
| 部署、环境、运维、安全 | **Pass** |
| 数据、状态、版本、发布 | **Fail：仅 R3-H1** |
| 技术当前性与证据 | **Pass at Critical/High** |
| 过度设计 | **Pass at Critical/High** |

