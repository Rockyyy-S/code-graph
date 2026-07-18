---
title: Architecture Spine Good-spine Rubric Review — Correction 2026-07-16
date: 2026-07-16
reviewer: rubric-walker
target: ../ARCHITECTURE-SPINE.md
driving_input: ../../../sprint-change-proposal-2026-07-16.md
verdict: changes-required
critical: 0
high: 3
medium: 1
---

# Good-spine Rubric Review — 2026-07-16 纠偏

## 结论

**CHANGES REQUIRED — 0 Critical、3 High、1 Medium。** 纠偏提案 §4.1、§4.5、§4.6、§4.8 的文字均已落入 Spine，机械 lint 也为 0；但新增的产品验证/发布适用性合同尚未形成可唯一复算的身份与单一所有权，Capability Map 与各 AD 的 `Binds` 不能完成其承诺的双向追踪。AD-18 的“完整 artifact 才可复制”已闭合状态机，但内容摘要仍缺规范字节定义。

本报告只审查 `ARCHITECTURE-SPINE.md`，未修改 Spine 或 `IMPLEMENTATION-GUIDE.md`。

## Mechanical Gate

执行 `lint_spine.py --workspace .../architecture-bmad-2026-07-13`，结果：`ok: true`、`total_findings: 0`。30 个 AD 均具备 `Binds / Prevents / Rule`，无占位符、重复 ID 或未固定 Stack 版本。

## 最高优先级发现

### H1 — AD-30 没有定义可唯一复算的整份 Plan/Manifest 身份

- **证据：** AD-30（235–239）要求任务、fixture、ground truth、阈值或剔除规则变化提升 `planVersion`，并以 `planVersion、digest、candidateRef` 判 invalid；但只笼统提到 `fixture/task digest`，没有覆盖完整 Plan 的 `planDigest`，也没有定义 `manifestDigest` 的规范化算法和排除自身的输入域。
- **可构造分叉：** 实现 A 修改 threshold/aggregation/exclusion 但 fixture/task digest 不变；实现 B 仍接受绑定旧语义的证据。或者两个 runner 分别对 YAML 原文与解析后的 JSON 计算 `manifestDigest`。两者都逐字满足当前 Rule，却对同一候选给出不同 valid/pass 结论。
- **影响：** `ProductValidationResultV1` 和 `ReadinessGateManifestV1` 不能成为“唯一、可重复判定”的发布 oracle，直接削弱 AD-30 的 `Prevents`。
- **处置：** **autofix / tighten AD-30。** 固定 `planDigest = SHA-256(RFC 8785 JCS(省略 planDigest 的完整 Plan body))`，`manifestDigest` 使用同类算法；Evidence/Result 必须同时绑定 `planId + planVersion + planDigest + candidateRef`，Manifest 消费方必须复算 digest 后再执行 gate。

### H2 — 新增产品验证合同与 gate runner 没有唯一架构所有者

- **证据：** Capability Map（361–368）把新能力写成 `product-validation task packs`、`UX task runner`、`evidence schemas`、`result gate`、`release gate runner` 等抽象位置；Structural Seed（285–342）没有对应模块，AD-30 也没有规定四个 V1 Schema、Plan/Manifest、Evidence 采集和 Result 判定分别由谁拥有和生成。
- **可构造分叉：** UX 团队在 extension 内定义一套 Evidence/Result，release 团队在 CI 脚本中定义另一套；二者都声称消费 AD-30 的 V1 合同，但字段默认、invalid 处理和 aggregation runner 不兼容。
- **影响：** 共享数据所有权这一架构维度仍是 open，却没有被标记为 Deferred/open question；不同 Story 可独立实现出互不兼容的“唯一合同”。
- **处置：** **discuss / add ownership invariant。** 在 Spine 固定 Schema 的唯一包/目录、Plan/Manifest 的权威存放处、Evidence producer 边界，以及唯一生成 `ProductValidationResultV1` 的 runner；Capability Map 使用可落到 Structural Seed 的路径。

### H3 — Capability Map 的 `Governed by` 与 AD `Binds` 不对称，双向追踪不可执行

- **证据：** SM-6 行（363）声明由 AD-9、AD-17、AD-25、AD-30 治理，但前三者的 `Binds` 均不含 SM-6；SM-7/SM-8 行（364）声明 AD-18、AD-26、AD-30，其中 AD-18 不绑定任一 SM，AD-26 只绑定 SM-8；SM-2..SM-5 行（362）又列入只绑定 SM-8 的 AD-26。AD-28 同时要求 FR/NFR/AR/UX-DR/Story 双向追踪成为 blocking gate。
- **可构造分叉：** 追踪器 A 以 AD 的 `Binds` 为权威，追踪器 B 以 Capability Map 为权威；两者会生成不同覆盖矩阵和 gate 结果。
- **影响：** 当前 Spine 自身无法通过唯一语义的双向追踪，且会让 Story 1.3 的 blocking gate 只能依赖实现者的临场解释。
- **处置：** **autofix。** 逐行使 Capability Map 与 AD `Binds` 对称；若某 AD 只是技术支撑而非需求绑定，改列为 `Depends on/Supported by`，不要放入 `Governed by`。

### M1 — AD-18 的 `contentDigest` 没有固定 artifact 内容字节

- **证据：** AD-18（163–167）正确禁止 partial/generating artifact 并保持目标重试的 artifact 内容与身份，但未定义 `contentDigest` 对何种 canonical bytes、编码、换行或序列化结果计算，也未要求目标写出精确 payload bytes。
- **可构造分叉：** clipboard adapter 对 UTF-16 文本摘要，file adapter 对 UTF-8/CRLF 文本摘要；二者可保留同一 `artifactId`，却写出不同内容并都声称没有改变 artifact。
- **影响：** 完整性状态已闭合，但“目标重试不得改变内容”不能由独立实现或测试复算。
- **处置：** **tighten AD-18。** 固定 artifact payload 的 `mediaType/encoding/payloadBytes`（或结构化内容的 JCS 规则），`contentDigest` 对精确 payload bytes 计算；clipboard/file adapter 必须消费同一 payload，不得重新序列化。

## Good-spine Checklist

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| 下一级真实分叉点无遗漏 | **Fail** | 产品验证合同的 Schema/runner/asset ownership 未决定、未 Deferred、未列 open。 |
| 每个 AD 的 Rule 可执行且实现其 Prevents | **Fail** | AD-30 digest 身份不闭合；AD-18 内容字节不可复算。 |
| Deferred 不允许当前 MVP 分叉 | **Pass** | 现有 Deferred 均指向 MVP 外能力或明确重访触发，不授权当前实现自行选择。 |
| 命名技术已验证当前且适配 | **Pass（证据继承）** | Stack 记录 2026-07-13 官方/Registry 核对；2026-07-15 technology review 记录再次核对。本 rubric 未重新联网验证。 |
| 绿地/棕地一致性 | **Pass / N/A** | 当前仓库仍是规划制品，无实现代码可供 brownfield ratification。 |
| 驱动输入能力覆盖 | **Pass with findings** | 2026-07-16 纠偏 §4 的 AD-18/28/30 与 Capability Map 均已落文，但 H1–H3 表明合同强度尚未完全闭合。 |
| 所有结构维度 decided / Deferred / open | **Fail** | 产品验证共享合同与 runner 的所有权维度沉默。其余边界、数据 mutation、状态、部署、环境、运维、安全、可观测性、发布与 CI 均已决定或 Deferred。 |

## AD-18 / AD-28 / AD-30 定向判定

| AD | 判定 | 摘要 |
| --- | --- | --- |
| AD-18 | **部分通过** | 完整/失败/目标重试状态机已阻止部分摘要复制；`contentDigest` 与目标写出的 canonical payload 尚未闭合（M1）。 |
| AD-28 | **规则主体通过，追踪依赖失败** | Story 1.1/1.3 时序、provider ruleset、禁止 bypass、外部 drift monitor、同 PR gate 与禁止空测试均可执行；但其“双向追踪”输入因 H3 不唯一。 |
| AD-30 | **不通过** | 唯一合同与 invalid 语义方向正确，但整份 Plan/Manifest identity 和唯一 owner 缺失（H1、H2）。 |

## Gate Recommendation

在 H1–H3 关闭前，不建议把 Spine 作为 Story 1.3 双向追踪与最终 release gate 的最终权威。M1 可与 AD-18 合同测试一并收紧；无 Critical 阻塞，也无需重做既有架构范式、数据 mutation、服务生命周期或发布信任链。
