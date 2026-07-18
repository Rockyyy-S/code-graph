---
title: Architecture Spine Good-spine Rubric Review — Correction Round 3
date: 2026-07-16
reviewer: rubric-walker-round3
target: ../ARCHITECTURE-SPINE.md
prior_review: review-correction-2026-07-16-rubric-round2.md
verdict: pass-with-medium
critical: 0
high: 0
medium: 1
---

# Good-spine Rubric Review — 2026-07-16 纠偏 Round 3

## 结论

**PASS WITH 1 MEDIUM — 0 Critical、0 High、1 Medium。** 上一轮 2 High / 1 Medium 的阻塞机制均已关闭：ReadinessGatePolicyV1 先于候选存在，compiler 只能确定性生成 immutable Manifest，evaluator 只能消费 Manifest/Evidence；`evidenceRefs` 已限定为执行前 slot，不含 evidenceDigest；机器双向追踪明确只认展开后的 AD `Binds`。当前无残余发布或实施阻塞。

仅剩一处非阻塞一致性问题：Capability Map 声称由 `Binds` 生成，但 SM 行仍保留旧的治理 AD 集合，作为人类导航投影与权威 `Binds` 不一致。本轮未修改 Spine 或 `IMPLEMENTATION-GUIDE.md`。

## Mechanical Gate

`lint_spine.py`：`ok: true`、`total_findings: 0`。

## 上一轮关闭矩阵

| 上轮发现 | 判定 | 关闭证据 |
| --- | --- | --- |
| H1：Manifest 适用性选择与判定由同一 runner 完成 | **Closed** | AD-30 固定仓库版本化 ReadinessGatePolicyV1；readiness compiler 只读 policy、gate registry、CandidateRef 并独占 immutable Manifest 生成，禁止读取证据；release gate evaluator 只消费 finalized Manifest/Evidence，禁止改变 applicability。policyDigest 贯穿 Manifest、Evidence、Result。 |
| H2：Capability Map 与 `Binds` 的机器追踪语义不唯一 | **Closed for machine gate** | Spine 明确 `Binds` 是逐 ID 直接追踪的唯一规范来源，Capability Map 不参与机器追踪、不得覆盖或补写 `Binds`；Story 1.3 只校验展开后的 AD Binds、需求 ID 与 Story 引用。 |
| M1：`evidenceRefs` 与 `manifestDigest` 存在循环生成解释 | **Closed** | Manifest.evidenceRefs 只允许执行前已知的 `{evidenceId,schemaRef,taskDigest,fixtureDigest}` slot，不含 evidenceDigest；实际排序 `{evidenceId,evidenceDigest}` 只进入 Result，生成顺序唯一。 |

## 重点规则一致性

### Compiler / Evaluator 分权

**Pass。** Policy owner、compiler、evaluator 的输入和写权限互斥：compiler 无证据读取权，evaluator 无 applicability 修改权；CandidateRef、policyDigest、manifestDigest 与证据链形成单向 DAG，不存在“先看结果再删 gate”的路径。

### Evidence 引用链

**Pass。** `Policy/Plan + Registry + Candidate → Manifest → Evidence → Result` 的摘要顺序可唯一执行。每层 digest 都排除自身字段，无摘要自引用；release phase 只接受 AD-29 release-set CandidateRef，与发布候选身份一致。

### `Binds` 唯一追踪

**Pass for blocking gate。** 机器权威已唯一，Capability Map 只作人类投影，不能改变 gate 结果。AD-28 的双向追踪因此不再依赖实现者选择数据源。

## 残余发现

### M1 — Capability Map 并非其声明的 `Binds` 生成投影

- **证据：** Spine（364）声明表格是从 `Binds` 生成的并集；但 SM-6 行（375）列 AD-9、AD-17、AD-25、AD-30，而实际绑定 SM-6 的 AD 至少是 AD-16、AD-19、AD-25、AD-30；SM-7/SM-8 行（376）遗漏绑定 SM-1..SM-8 的 AD-19；SM-2..SM-5 行（374）加入未绑定这些 ID 的 AD-8/AD-26，并遗漏绑定 SM-4 的 AD-24。
- **影响：** 不影响机器 gate，因为新规则明确忽略该表；但会误导人工审阅者，并与“由 Binds 生成”的陈述自相矛盾。
- **处置：** **autofix。** 由展开后的 `Binds` 自动重生成 Capability Map，或把第三列改名为非规范的 `Related ADs` 并移除“由 Binds 生成”声明。

## Good-spine Checklist

| 检查项 | 结果 |
| --- | --- |
| AD-18 完整 artifact、canonical bytes 与候选绑定 | **Pass** |
| AD-28 registry、always-run controller、provider 外部强制与 fail-closed | **Pass** |
| AD-30 policy/compiler/evaluator 权限分离 | **Pass** |
| Plan/Policy/Manifest/Evidence/Result digest 与 CandidateRef 链 | **Pass** |
| `evidenceRefs` 无循环、Result 绑定实际 evidence digest | **Pass** |
| `Binds` 作为机器双向追踪唯一来源 | **Pass** |
| 所有结构维度 decided / Deferred / open | **Pass** |
| Capability Map 人类投影一致性 | **Medium finding** |

## Gate Recommendation

无 Critical/High 阻塞，可继续最终实施就绪复评。建议在最终交付前机械重生成 Capability Map，关闭唯一 Medium；该修正不需要重开 AD-18、AD-28 或 AD-30 的决定。
