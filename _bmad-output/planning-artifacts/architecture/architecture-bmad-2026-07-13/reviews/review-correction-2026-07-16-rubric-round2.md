---
title: Architecture Spine Good-spine Rubric Review — Correction Round 2
date: 2026-07-16
reviewer: rubric-walker-round2
target: ../ARCHITECTURE-SPINE.md
prior_review: review-correction-2026-07-16-rubric.md
verdict: changes-required
critical: 0
high: 2
medium: 1
---

# Good-spine Rubric Review — 2026-07-16 纠偏 Round 2

## 结论

**CHANGES REQUIRED — 0 Critical、2 High、1 Medium。** 上一轮 H1、H2、M1 已关闭；H3 仅部分关闭。AD-18 的 artifact 身份、AD-30 的完整 digest 链及产品验证资产所有权现在均可执行，但新的 ReadinessGateManifestV1 规则把“适用性清单生成”和“最终判定”同时交给 release CI runner，仍允许同一候选在运行时自选门禁；同时 `evidenceRefs ↔ manifestDigest` 的生成顺序没有封闭。

本轮只审查更新后的 `ARCHITECTURE-SPINE.md`，未修改 Spine 或 `IMPLEMENTATION-GUIDE.md`。

## Mechanical Gate

`lint_spine.py` 结果：`ok: true`、`total_findings: 0`。30 个 AD 的机械结构完整，无重复 ID、占位符或 Stack pin 缺失。

## 上一轮发现关闭矩阵

| 上轮发现 | 判定 | 关闭证据 / 残差 |
| --- | --- | --- |
| H1：Plan/Manifest 身份不可唯一复算 | **Closed** | AD-30 固定 `planDigest/manifestDigest/evidenceDigest/resultDigest` 的 RFC 8785 JCS UTF-8 SHA-256 输入域，并固定 fixture/task digest、CandidateRefV1 与完整引用链。 |
| H2：产品验证合同与 runner 无唯一 owner | **Closed** | `packages/contracts`、`validation/product`、`packages/application/validation`、release CI runner 的所有权已固定；Structural Seed 已加入 validation 与 CI 注册表。 |
| H3：Capability Map 与 AD Binds 不对称 | **Partially closed / High remains** | AD-18 已补 SM-7/SM-8，AD-25 已补 SM-6；但 SM-6 行仍把不绑定 SM-6 的 AD-9/AD-17 列为 `Governed by`，SM-2..SM-5 行仍列入只绑定 SM-8 的 AD-26。Spine 未定义 `Governed by` 是 requirement binding 还是仅技术支撑。 |
| M1：AD-18 contentDigest 无 canonical payload | **Closed** | JSON 固定 JCS UTF-8，Markdown/text 固定无 BOM、LF UTF-8；contentDigest 对最终字节 SHA-256，artifactId 公式也已固定且不含目标与 generatedAt。 |

## 残余与新增发现

### H1 — Readiness manifest 的适用性选择与判定由同一 runner 临场完成

- **证据：** AD-30（239）规定 release CI gate runner “独占候选 ReadinessGateManifestV1 的生成和判定”；Manifest 只有内容摘要，没有 `manifestVersion`、预批准 applicability template/policy digest 或候选生成前的外部 pinned authority。AD-30 的 `Prevents` 明确要防止团队临场选择适用门禁。
- **可构造分叉：** runner A 为 Beta+ 候选生成含全部门禁的 Manifest；runner B 在判定前生成省略某个 SM/NFR gate 的 Manifest。两份对象都可通过封闭 Schema、digest 和“全部列出的 blocking gate”规则，结果却相反。
- **影响：** `manifestDigest` 只能证明内容未被篡改，不能证明该内容是预先批准且完整的适用性基线；生成者同时作为判定者，与 AD-30 的 `Prevents` 自相矛盾。
- **处置：** **tighten AD-30。** 将版本化、候选无关的 `ReadinessGatePolicyV1`/template 作为受保护输入，由独立 owner 审批并固定 policyDigest；runner 只能把 candidateRef 和预声明 evidence slots 实例化为 candidate Manifest，不能增删 requirementRefs/gates，并必须在 Result 中绑定 policyDigest。

### H2 — Capability Map 与 `Binds` 的双向追踪语义仍未唯一

- **证据：** SM-6 行（371）仍声明 AD-9、AD-17、AD-25、AD-30 治理，但 AD-9/AD-17 的 `Binds` 不含 SM-6；SM-2..SM-5 行（370）列入 AD-26，而 AD-26 只绑定 SM-8。AD-28 又把规划双向追踪设为 blocking gate。
- **可构造分叉：** gate A 把 `Governed by` 当 requirement edge，gate B 只认 `Binds`；两者对同一 Spine 生成不同缺口列表。
- **影响：** 上轮 H3 尚未完全关闭，Story 1.3 的追踪 gate 仍需实现者自行解释。
- **处置：** **autofix。** 定义两类边：`Binds` 为机器追踪权威，`Supported by` 为非追踪技术依赖；Capability Map 按该语义拆列，或使所有 `Governed by` 边与 AD `Binds` 精确对称。

### M1 — `evidenceRefs` 与 `manifestDigest` 的生成顺序存在循环解释

- **证据：** Manifest 固定含 `evidenceRefs`，`manifestDigest` 覆盖除自身外的整个对象；Evidence 又必须引用该 `manifestDigest`。但 `evidenceRefs` 的封闭形状未说明是预声明 evidenceId/slot，还是包含实际 evidenceDigest 的引用。
- **可构造分叉：** 实现 A 预分配 evidenceId 后生成 Manifest，再采集 Evidence；实现 B 把 evidenceDigest 放入 evidenceRefs，导致必须先有 Evidence 才能算 Manifest、又必须先有 Manifest 才能算 Evidence。
- **影响：** Schema 均可封闭，但不同实现仍可能得到不可生成或不兼容的引用链。
- **处置：** **tighten AD-30。** 固定 Manifest.evidenceRefs 为排序的预声明 `{evidenceId, gateId, evidenceSchemaRef}` slots，不得含 evidenceDigest；实际 `{evidenceId,evidenceDigest}` 只进入 Result，并要求 Evidence 的 evidenceId 必须命中预声明 slot。

## 新规则一致性复核

| 区域 | 判定 | 说明 |
| --- | --- | --- |
| AD-18 artifact 完整性与身份 | **Pass** | complete-only、canonical bytes、contentDigest、artifactId、目标重试及 candidate 绑定无冲突。 |
| AD-28 gate registry 与 candidate manifest 分工 | **Pass with dependency** | gate 定义/适用性已分离、always-run aggregator 与 fail-closed 可执行；最终仍依赖 H1 的受保护 applicability policy。 |
| AD-30 digest 与 CandidateRef 链 | **Pass** | digest 无自引用；release phase 只接受 release-set candidate，与 AD-29 一致。 |
| AD-30 authority separation | **Fail** | Manifest 生成者兼判定者，缺预批准 applicability authority。 |
| AD-30 Evidence/Manifest/Result 顺序 | **Fail** | evidenceRefs 形状未固定，存在循环实现。 |
| Structural dimensions | **Pass with findings** | 新资产所有权、模块位置、provider 选择与重访条件已决定；H1/H2/M1 是剩余合同级分叉。 |

## Gate Recommendation

关闭 H1、H2 后再把 Spine 作为 Story 1.3 双向追踪和 Beta+/release 判定权威；M1 可随 AD-30 Schema 一次性收紧。无需重开 AD-18、数据 mutation、服务生命周期、发布信任链或既有技术栈决定。
