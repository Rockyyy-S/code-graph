---
title: Architecture Spine Good-spine Rubric Review — Round 14
date: 2026-07-14
reviewer: rubric-walker-round14
verdict: changes-required
scope: ../ARCHITECTURE-SPINE.md
supersedes: review-rubric-round13.md
---

# Good-spine Rubric Review — Round 14

## Verdict

**CHANGES REQUIRED — 0 Critical、0 High、1 Medium。** Round 13 后的 service epoch 修订完全闭合；新 RulesSnapshotRef 的并发规则方向正确，但冷启动无有效历史规则时合同不完备，且 rules digest 缺少唯一规范算法。机械 lint 通过。

## Mechanical Gate

执行：

```text
uv run E:/bmad/.agents/skills/bmad-architecture/scripts/lint_spine.py \
  --workspace E:/bmad/_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13
```

结果：`ok: true`，`total_findings: 0`。

## Finding

### M1 — RulesSnapshotRef 在首次有效规则出现前没有可执行的 last-valid 基线与规范 digest

- **Evidence:** AD-3 将 RulesSnapshotRef 固定为 `{generation, validity, effectiveRulesDigest, lastValidRulesDigest}`，并规定 invalid generation 的两个 digest 保持“最后有效值”。但首次启动即遇到无效 rules.yaml 时不存在最后有效值，四个字段又不是可空；同时 spine 没有规定 effectiveRulesDigest/lastValidRulesDigest 对何种规范对象、使用何种算法计算。
- **Why this matters:** 两个下一级实现可以分别选择 `null`、空字符串、原始 YAML hash 或解析对象 hash；这会使首个无效配置下的 GraphPatch 提交行为、Finding revision 审计和 AD-17 baselineId 不兼容，甚至让某实现因无法构造完整 CAS ref 而阻塞本应继续的图谱提交。
- **Required fix:** 在 AD-3 定义 bootstrap `generation=0, validity=valid` 的空规则快照，并将 `effectiveRulesDigest=lastValidRulesDigest=EMPTY_RULES_DIGEST`；`EMPTY_RULES_DIGEST` 及后续 digest 均由 schema-valid 的规范 RulesV1 对象按 RFC 8785 JCS → UTF-8 → SHA-256 计算。首次 rules.yaml 无效时只推进 generation、设 validity=invalid，并继续保留该空规则 digest；无需新增 AD。
- **Disposition:** autofix。

## Round-13 Delta Review

| New or tightened area | Result | Good-spine assessment |
| --- | --- | --- |
| AD-3 RulesSnapshotRef and invalid generation | **Pass after M1** | generation/validity 与 effective/last-valid digest 的分离、完整 ref CAS、无效配置不阻塞 GraphPatch 的规则都正确；只缺 bootstrap 与规范 digest。 |
| AD-7 serviceInstanceId/statusEpoch | **Pass** | 服务实例或 epoch 改变时无条件替换本地状态并全量重取；同 epoch 才比较 revisions，消除了跨服务重启计数器回绕。 |
| AD-23 status epoch lifecycle | **Pass** | serviceInstanceId/statusEpoch 在取得排他锁后生成、进入 metadata/initialize/status，且明确计数器无需跨实例持久化，与 AD-7 一致。 |

## All-AD Regression Check

除 M1 外未发现新的 Critical/High/Medium：

- 范式、依赖方向、单服务/单 mutation channel 与 GraphPatch 原子提交保持一致。
- Workspace discovery、GraphView/Navigation、Service/Index/Telemetry status、Finding comparison 和 export policy 合同仍封闭。
- Job result/cancellation、rules invalid/stale、config latest-wins/application boundary 与 telemetry off kill switch 无冲突。
- Trust、IPC、路径/CSP/预算、缓存迁移/恢复、服务交接、部署矩阵和 schema/version 演进完整。
- Release slices 继续累积并绑定全部适用 FR/SM/NFR；Deferred 没有藏入当前 MVP 的兼容性分叉。

## Good-spine Checklist

| Checklist item | Result |
| --- | --- |
| 固定 initiative 下一级真实分叉点且无遗漏 | **Needs fix — M1** |
| 每个 AD Rule 可执行并实现其 Prevents | **Needs fix — M1 cold-start case** |
| Deferred 不允许当前 MVP 单元作出不兼容选择 | **Pass** |
| 覆盖绑定的 FR/NFR/用户旅程与发布门禁 | **Pass** |
| 部署、环境、运维、安全与隐私 envelope | **Pass** |
| 数据所有权、状态、并发、版本与恢复 | **Pass after M1** |
| 技术版本固定且本轮无新增未锁技术 | **Pass for rubric lens** |
| 保持 initiative altitude，足够且不膨胀 | **Pass** |

## Gate Recommendation

补齐 AD-3 的 empty-rules bootstrap 与 rules digest 规范后重跑 delta review；其余 ARCHITECTURE-SPINE.md 无需修改。
