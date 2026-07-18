---
title: Architecture Spine Good-spine Rubric Review — Round 18
date: 2026-07-14
reviewer: rubric-walker-round18
verdict: changes-required
scope: ../ARCHITECTURE-SPINE.md
supersedes: review-rubric-round17.md
---

# Good-spine Rubric Review — Round 18

## Verdict

**CHANGES REQUIRED — 0 Critical、0 High、2 Medium。** watcher eventual reconciliation、首 commit read-set rehash 与 freshness 语义均可执行；EffectiveIgnoreSnapshotV1 的 grammar、唯一 owner 和 mutation CAS 主干正确。剩余问题是把并发 generation 混入语义 configDigest，以及无效 UTF-8 没有确定性状态转换。机械 lint 通过。

## Mechanical Gate

执行：

```text
uv run E:/bmad/.agents/skills/bmad-architecture/scripts/lint_spine.py \
  --workspace E:/bmad/_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13
```

结果：`ok: true`，`total_findings: 0`。

## Findings

### M1 — EffectiveIgnoreSnapshot generation 被同时当作并发栅栏和语义配置身份

- **Evidence:** AD-3 的 AnalyzerConfigSnapshot/configDigest 包含 `effectiveIgnore:{version,generation,digest}`，同时提交又对完整 EffectiveIgnoreSnapshotV1 做 CAS。AD-14 规定已有文件从 generation=1 开始、任意内容变化递增，但没有规定跨服务实例恢复 generation。
- **Why this matters:** generation 是变化顺序/并发 token，不是生效 ignore 语义。相同 normalizedRules 在注释改动、内容改回或服务重启后可能具有不同 generation，从而产生不同 configDigest/inputDigest，导致不必要的全量分析与缓存失效；如果实现分别选择持久化或重置 generation，重启后的 freshness 行为也会不兼容。完整 snapshot CAS 已经承担防止旧批次提交的职责，generation 再进入语义 digest 是职责重叠。
- **Required fix:** AnalyzerConfigSnapshot/configDigest 的 effectiveIgnore 只绑定 `{version,digest}`；EffectiveIgnoreSnapshotV1 的 `generation/contentHash/digest` 继续整体参与 bootstrapGeneration 与 GraphPatch CAS。明确 generation 只是在当前 service epoch 内单调的并发 token（无需跨实例持久化）；服务启动时以 normalizedRules digest 与已提交 snapshot 判断语义是否变化。
- **Disposition:** autofix。

### M2 — EffectiveIgnoreSnapshotV1 没有定义无效 UTF-8 的 deterministic failure contract

- **Evidence:** AD-14 规定 `.codegraphignore v1` 使用 UTF-8 按行解析，但未说明非法 UTF-8 字节是严格拒绝、replacement decode 还是按平台容错；snapshot 没有 validity，亦未规定失败时使用空规则还是保留上一有效规则。
- **Why this matters:** 首次或运行中出现非法编码时，不同实现可索引完全不同的文件集合。把无效文件静默当空配置还可能突然纳入原本排除的大目录；保留旧规则、替换字符解析和拒绝启动会产生不同 graph/config digest、freshness 与诊断行为。
- **Required fix:** 固定严格 UTF-8 解码；解码失败时整份文件为 invalid，不做部分解析，返回稳定 ConfigDiagnostic。给 EffectiveIgnoreSnapshotV1 增加 `validity=valid|invalid`；invalid generation 记录当前 contentHash 但继续使用上一有效 normalizedRules/digest，首次 invalid 使用合法空规则 digest，并标记整体 stale，待有效 generation 完成 reconciliation 后恢复。
- **Disposition:** autofix。

## Focused Review

| Focus area | Result | Evidence |
| --- | --- | --- |
| Watcher loss model | **Pass** | watcher 明确只是可能丢失、重复、乱序的候选源，服务始终重读并以 content hash 为真相。 |
| Eventual reconciliation | **Pass** | overflow/恢复/配置变化触发对账；客户端连接期间相邻对账最多 5 分钟，显式 rebuild/check/impact/export 前也必须完成或复用对账。 |
| Bootstrap convergence | **Pass** | Manifest、AnalyzerConfig、EffectiveIgnore、RulesSnapshot 在同一 bootstrapGeneration 收敛并原子发布。 |
| First-commit read-set fence | **Pass** | 首个 mutation Job 绑定 bootstrapGeneration，提交前 rehash 完整 bootstrap read-set；事件或 hash 差异均失效重排。 |
| Freshness semantics | **Pass** | current 明确定义为匹配最近完成的内容对账；已观察 manifest/ignore/input 变化立即 stale，静默丢失由有界对账恢复。 |
| Ignore grammar | **Pass except M2** | comment/negation/last-match/root and directory anchoring/escaping/glob/case rules均封闭；只缺非法 UTF-8 状态。 |
| Ignore owner and consumers | **Pass** | graph-service 唯一解析原文件；scanner、AnalyzerConfig、doctor、CLI、UI 只能消费 snapshot、过滤集或排除摘要。 |
| Ignore digest and CAS | **Pass except M1** | contentHash、normalizedRules digest、bootstrap 与 mutation CAS 完整；需把 generation 从语义 configDigest 分离。 |

## Good-spine Checklist

| Checklist item | Result |
| --- | --- |
| 固定 initiative 下一级真实分叉点且无遗漏 | **Needs fix — M1/M2** |
| 每个 AD Rule 可执行并实现其 Prevents | **Needs fix — M2 malformed input** |
| Deferred 不允许当前 MVP 单元作出不兼容选择 | **Pass** |
| 数据所有权、原子 mutation 与并发恢复 | **Pass after M1** |
| 状态、freshness、epoch 与客户端同步 | **Pass after M2 invalid-state mapping** |
| 配置、规则、ignore 与 Findings 一致性 | **Pass after M1/M2** |
| 安全、隐私、部署、运营与可访问性 | **Pass** |
| 技术版本与 schema/version 演进 | **Pass for rubric lens** |
| initiative altitude 与精简度 | **Pass** |

## Regression Sweep

除 M1/M2 外，Round 17 后的修订未削弱 AD-2/3/7/8/9/14/23：单服务与单 mutation channel、RulesSnapshotRef CAS、ServiceStatus/GraphView epoch、Job/取消、无效 rules stale 语义、启动屏障和升级交接仍一致。Deferred 与发布门禁无新增缺口。

## Gate Recommendation

分离 ignore semantic digest 与 generation，并补齐严格 UTF-8 invalid snapshot 后重跑 delta review；其他 ARCHITECTURE-SPINE.md 内容无需修改。
