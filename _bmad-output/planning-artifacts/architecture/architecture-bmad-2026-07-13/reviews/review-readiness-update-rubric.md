---
review: good-spine-rubric-walker
target: ../ARCHITECTURE-SPINE.md
companions:
  - ../IMPLEMENTATION-GUIDE.md
driving_inputs:
  - ../../../implementation-readiness-report-2026-07-15.md
  - ../../../sprint-change-proposal-2026-07-15.md
date: 2026-07-15
verdict: changes-required
critical: 0
high: 4
medium: 2
low: 0
---

# Architecture Reviewer Gate — Good-Spine Rubric Walker

## Gate verdict

**CHANGES REQUIRED。** 机械结构合格，已批准变更的大部分主题也已经进入 AD-25～AD-28 与实施指南；但 3 个新增核心合同仍允许两个合规实现产生不同结果，且新发布 Epic 明确要求的“可复现候选产物”尚未成为可执行的部署合同。因此当前 spine 还不能作为无歧义的 Phase 4 build substrate。

## 审查范围与证据

- 审查目标：`../ARCHITECTURE-SPINE.md` 当前磁盘版本（2026-07-15 16:05:22）。
- 对照输入：实施就绪报告与状态为“已批准”的 Sprint Change Proposal。
- 伴随核对：`../IMPLEMENTATION-GUIDE.md`，只检查 spine 的可执行投影与漂移，不把 seed 细节升级为 AD。
- 机械检查：`lint_spine.py` 通过，0 项发现；无占位符、重复 AD、缺失 Binds/Prevents/Rule 或未锁定版本。
- 版本现实检查：Node.js 24.18.0 仍为 Krypton LTS；架构列出的 npm 包精确版本均可从 registry 解析。TypeScript 6.0.3 是有意锁定的稳定 Compiler API 版本，当前 latest 为 7.0.2；pnpm 11.12.0 可用，当前 latest 为 11.13.0。这两项是可解释的兼容锁定，不构成 outdated finding。

## 已批准变更落地矩阵

| 输入要求 | 落地证据 | 结论 |
| --- | --- | --- |
| OverviewMetricV1 | AD-25；指南第 2、3、9、13 节 | 已落入，但计数归属不闭合，见 H1 |
| ImpactVerdictV1 / ImpactRankV1 | AD-26；指南第 2、3、12、13 节 | 已落入，但循环比较与风险身份不闭合，见 H2 |
| BasicSymbolV1 | AD-27；指南第 3、8、13 节 | 已落入，但与 AD-4 的跨文件合并身份存在冲突，见 H3 |
| 能力首次落地的渐进式 CI | AD-28；指南阶段 A、验证矩阵和 CI 门禁 | 完整落入 |
| 基础循环投影先于 Overview | AD-25 的 CycleProjectionKernelV1/BaseCycleProjectionV1；指南阶段 B | 完整落入 |
| 首次 rebuild 前的 ignore 最小合同 | AD-14、AD-23；指南阶段 B 明确只验收“文件缺失”基线 | 已按最新收紧落入；存在文件时必须建立 generation=1+ 快照，不再把 generation=0 泄漏到运行时 |
| `.codegraphignore` 与 rules ignore 职责分离 | AD-9、AD-14 | 完整落入 |
| SM-4 版本化语料与 precision/recall/F1 | AD-19；指南验证矩阵 | 完整落入 |
| ContextLock 当前 extension-host 会话边界 | AD-10；指南第 11 节 | 完整落入 |
| zh-CN/en 与机器合同不本地化 | spine 无对应 AD/Convention | 未完整落入，见 M1 |
| 可复现候选产物与发布审计 | AD-12/AD-28 只规定打包矩阵与“产物审计”类别 | 未成为可执行合同，见 H4 |

## Rubric 结论

| Good-spine 检查项 | 结果 | 说明 |
| --- | --- | --- |
| 固定下一层真实分歧点且无重大遗漏 | 不通过 | AD-25、AD-26、AD-27 各有一个能产生不同输出/身份的未决点 |
| 每个 AD 的 Rule 可执行并实际阻止其 Prevents | 不通过 | 新增 3 个版本化合同尚不能仅凭 Rule 写出唯一 golden fixture |
| Deferred 不允许 MVP 内部继续分叉 | 通过 | Deferred 均是第二语言、替代运行时/渲染器、arm64 扩展、跨根/跨仓库/云能力等 MVP 外触发项；未发现把当前必须决定的事项藏入 Deferred |
| 命名技术已核验当前存在且适配 | 通过 | 精确版本可解析；Node LTS 与主要包版本现实检查通过 |
| 与现有项目现实一致 | 通过 | 这是绿地 build substrate；未发现声称 ratify 但与代码现实冲突的情况 |
| 覆盖驱动输入能力与约束 | 部分通过 | 架构专项变更基本落入，但 i18n 机器/人类合同边界和可复现发布要求遗漏 |
| initiative 所有结构维度均决定、Deferred 或开放 | 部分通过 | 部署、平台、进程生命周期、安全、日志、迁移、CI 均有决定，并非整维沉默；但发布可复现性/产物身份仍是部署维度中的实质空洞 |

## Critical / High findings

### H1 — AD-25 未定义 Finding 对 Overview 聚合节点的计数归属

- **证据：** AD-25 将热点排序固定为 `active error 数 → active warning 数 → cycleMemberCount → internalDependencyStrength`，但没有定义一个 Finding 应计入哪个聚合节点、是否同时计入 source/target、SCC Finding 是否对每个成员计数，以及聚合后如何按 `findingId` 去重。指南第 9 节重复了排序，没有补充归属 kernel。
- **可构造分叉：** 实现 A 只把单边 Finding 计入 source 聚合节点；实现 B 同时计入 source 与 target。两者逐字遵守“按 active error 数排序”，却会生成不同热点排名和 Overview UI。
- **影响：** OverviewMetricV1 不能形成唯一 contract fixture，直接破坏其“CLI 与 VS Code 不得各自解释”的 Prevents。
- **处置：** **discuss / tighten AD-25。** 定义版本化 `FindingAttributionKernelV1` 或等价规则：单边与 SCC subject 到 file/directory/workspace-package 的归属、去重键、跨聚合节点计数和 rules-ignore/freshness 语义；然后让 active error/warning count 显式引用该 kernel。

### H2 — AD-26 的“新增基础循环”与 canonical risk ID 没有确定性比较合同

- **证据：** AD-26 规定新增基础循环会得到 `review`，并要求 majorRisks 按 `canonical risk ID` 排序；但没有定义当前/基线 SCC 的匹配规则、SCC 合并/拆分时何谓 new/existing，也没有定义循环风险的 canonical risk ID。指南使用未定义的 `RankedRiskV1`，只重复排序原则。
- **可构造分叉：** 当前 SCC `{A,B,C}` 相比基线 `{A,B}` 时，实现 A 因 projectionId 改变判为“新增循环”，实现 B 因 A/B 已在循环中而只把 C 判为受影响上下文。两者都会遵守现有 AD，却可能分别返回 `review` 与 `pass`，majorRisks 顺序也不同。
- **影响：** 同一输入在 IDE、CLI、Markdown 中可以复用同一服务结果，但服务结果本身仍不唯一，AD-26 的 Prevents 未真正闭合。
- **处置：** **discuss / tighten AD-26。** 固定 `CycleComparisonV1` 的 baseline/current 匹配、merge/split/new/existing 规则；为 edge Finding、cycle projection 和 stale/not-applicable 风险定义封闭 `canonicalRiskId` 公式及 `RankedRiskV1` 判别联合。

### H3 — AD-27 的跨声明合并与 AD-4 的 file-scoped symbol ID 不兼容

- **证据：** AD-4 规定 symbol ID 由 `file ID + language + kind + qualified name + signature digest` 确定；AD-27 又要求 TypeScript 多声明绑定合并为一个 symbolId。TypeScript 的 interface/namespace/global declaration merging 可以跨文件出现，此时一个合并 symbol 对应多个 file ID。AD-27 只定义导航范围优先级，没有定义身份所用 canonical file，也没有把合并限制在同一 SourceFile。
- **可构造分叉：** 实现 A 每个文件生成一个 symbol；实现 B 合并为一个 symbol 并选择 Program source order 的首个文件作为 ID。两者分别服从 AD-4 或 AD-27 的直读语义，但会导致不同 ID、导航、导出和重建稳定性。
- **影响：** BasicSymbolV1 正是为防止 ID/导航/导出分叉而新增，当前 Rule 内部仍存在直接冲突。
- **处置：** **discuss / amend AD-4 + AD-27。** 二选一并写死：只合并同一 SourceFile 的声明；或使用排序后的 declaration identities 构造跨文件 symbol ID，并用独立 deterministic navigation-declaration 规则选择 `relativePath/range`。不得依赖不稳定的 Program source order。

### H4 — 新发布 Epic 的“可复现候选产物”没有进入可执行部署合同

- **证据：** 已批准提案要求 Story 5.5“审计并发布可复现的候选产物”。AD-12 决定了运行时、原生 ABI、平台矩阵与许可证复制；AD-28 只说发布 Epic 负责“产物审计”。spine 与指南均未定义“可复现”是 byte-for-byte、内容清单等价还是仅可重复构建，也未固定候选产物 manifest/hash、构建输入锁定或允许的非确定字段。
- **可构造分叉：** 发布实现 A 只验证四平台可安装；实现 B 进行 clean-room rebuild 和 SHA-256 比对。两者都通过现有 AD-12/AD-28，但只有后者满足提案中的普通含义。
- **影响：** 运营/部署维度不沉默，但新 Epic 5 的成功标准仍可被弱实现“合规”绕过；发布审计无法形成门禁。
- **处置：** **tighten AD-12 或新增下一 AD。** 明确 reproducibility 等级、锁定输入、候选 artifact manifest（版本/平台/Node ABI/protocol/schema/license/SHA-256）、clean-room 重建验证及签名发生在可复现性校验之前或之后的顺序；对应门禁进入实施指南 Stage E/Packaging。

## Medium findings

### M1 — 已批准的语言/国际化边界未成为跨宿主一致性规则

- **证据：** 变更提案要求人类可读 VS Code 界面支持 zh-CN/en、未知 locale 回退 en，并明确 JSON、error code、状态枚举和 Schema 不本地化。spine 没有 locale/i18n AD 或 Consistency Convention。
- **影响：** extension、Webview、CLI 与服务可以分别选择本地化范围；尤其服务 `message`、CLI 文本和 Webview 文案可能形成多套键与 fallback。
- **处置：** **autofix candidate。** 在 Consistency Conventions 增加 localization 规则，至少固定“机器合同永不本地化；人类文案由宿主资源 key 本地化；zh-CN/en；未知 locale→en；服务返回稳定 code + 参数，不拥有宿主文案”。视觉文案细节仍留给 UX。

### M2 — Implementation Guide 仍保留“匿名符号低稳定性”，与 AD-27 排除匿名声明漂移

- **证据：** 指南第 7 节身份规范写“匿名符号标记低稳定性”，而 AD-27 及指南第 8 节明确“匿名声明不进入 BasicSymbolV1”。
- **影响：** 实现者可能把匿名符号存入 MVP nodes/export，形成第五类事实边界；虽然 spine 优先级更高，但 companion 不再是无歧义实施投影。
- **处置：** **autofix candidate。** 删除该句，或明确它只适用于未来非 BasicSymbol 模型并引用 Deferred；当前 MVP 不生成匿名 symbol。

## 无发现项

- 未发现 Deferred 泄漏：所有 Deferred 都带 MVP 外范围或明确复评触发，且不影响当前 AD 的唯一实现。
- 未发现整个运营/环境维度沉默：本地 IPC、用户缓存、权限、日志、遥测、进程生命周期、迁移、升级交接、平台矩阵、离线运行和 CI 都有合同；问题仅集中在可复现发布这一子维度。
- 最新收紧后的 AD-23 已明确：运行时首次 Job 必须绑定与 `.codegraphignore` 实际存在状态一致的 EffectiveIgnoreSnapshotV1；只有文件缺失才可使用 generation=0。该项不再是 finding。
- 已批准提案中的 Story 拆分、Epic 5 创建、PRD/UX/epics 文档回写不属于本 spine 单文件 Reviewer Gate 的可修复范围；但在下一轮 Implementation Readiness 前仍必须由各自制品完成。

## Gate close condition

关闭 H1～H4 后重新运行 lint 与 good-spine rubric。M1/M2 可随同一次更新直接修正。若 H1～H3 仍开放，不应把该 spine 作为允许独立团队并行实现 Overview、impact 或 symbol contract 的最终依据。
