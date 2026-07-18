---
title: Sprint Change Proposal — Implementation Readiness NEEDS WORK 纠偏
status: approved
mode: Batch
created: 2026-07-16
approvedAt: 2026-07-16T11:09:00+08:00
approvedBy: Shiqw
approvalDecision: approve
primaryEvidence: implementation-readiness-report-2026-07-16-rerun.md
scopeClassification: Moderate
originalPlanningArtifactsModified: false
---

# Sprint Change Proposal：实施就绪 NEEDS WORK 纠偏

## 0. 审批边界与结论

本提案建议采用“直接调整现有规划制品与 Backlog”的路径。产品愿景、MVP 能力范围、FR-1 至 FR-23 的编号、5 个 Epic 的用户价值边界和 Epic 顺序全部保持不变；不回滚实施成果，不新增 MCP、云协作、跨仓库 federation 或新语言，也不修改代码。

变更范围评定为 Moderate：需要同步修订 PRD、UX、Architecture、Implementation Guide 和 Epics/Stories，并重组部分 Story，但不需要重新定义产品方向或削减 MVP。

审批前只新增本提案文件。以下原始规划制品均保持未修改：

- prds/prd-bmad-2026-07-09/prd.md
- prds/prd-bmad-2026-07-09/addendum.md
- architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
- architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md
- ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
- ux-designs/ux-bmad-2026-07-13/DESIGN.md
- epics.md

## 1. Issue Summary

### 1.1 变更触发

2026-07-16 的实施就绪复评报告 implementation-readiness-report-2026-07-16-rerun.md 给出 NEEDS WORK。报告确认：

- FR-1 至 FR-23 覆盖率仍为 100%。
- 5 个 Epic 均交付用户价值，依赖方向合理。
- 主要阻塞不是范围错误，而是少数合同彼此不同步、部分 Story 过大、最终产品验证缺少可重复 oracle。
- 如果直接实施，不同代理可能依据不同文档得到不同完成定义，或在 Go/No-Go 时依赖临场解释。

本次没有单一“触发 Story”；触发项为实施前的跨制品一致性审查，因此检查表 1.1 记为 N/A。

### 1.2 核心问题分类

问题类型为“原需求理解已基本正确，但规划制品同步和可测试性不足”，具体包括：

1. Architecture Spine AD-28 与 Story 1.1 / 1.3 的 CI 顺序冲突。
2. Implementation Guide 存在 5 处已确认的 Story 引用漂移。
3. Story 1.4、2.1、2.8、4.8 横跨多个失败域和测试层。
4. SM-1、SM-6、SM-7、SM-8、Beta/Beta+ 适用性及 UJ-5/v1.1 门禁没有版本化、机器可重复判定的合同。
5. UX 对导出生成失败与目标写出失败的处理混淆；PRD 缺少 AD-25 已确认语义；术语和真实 Webview 验证矩阵仍未闭合。

## 2. Impact Analysis

### 2.1 Epic 影响

| Epic | 用户价值边界 | 影响 | 处理 |
| --- | --- | --- | --- |
| Epic 1 | 构建、查询并恢复可信本地图谱 | CI 地基顺序冲突；Story 1.4 过大 | 保持边界；Story 1.1 建最小真实 CI，Story 1.3 完成强制门禁；拆分 Story 1.4 |
| Epic 2 | 在 VS Code 中理解项目与当前文件影响 | Story 2.1、2.8 过大；快捷键、断点和 Webview 矩阵不完整 | 保持边界；各拆为两个端到端 Story；补齐 UX 验收矩阵 |
| Epic 3 | 发现并解释架构风险 | 直接范围不变，但 SM-6 oracle 影响最终发布验证 | 不新增功能；由版本化验证计划固定 fixture 和阈值 |
| Epic 4 | 审查变更并导出结构上下文 | Story 4.8 同时承担 impact/export；复制失败语义不严谨 | 保持边界；拆分 CLI impact 与 CLI export；禁止部分摘要复制 |
| Epic 5 | 安装、升级、离线运行和发布 | Story 5.11 无法重复判定全部适用门禁 | 新增版本化产品验证合同 Story；原最终审计 Story 顺延并只消费固定合同 |

Epic 数量、顺序和用户价值边界均不变。

### 2.2 制品影响

| 制品 | 影响等级 | 必须修改的区域 |
| --- | --- | --- |
| PRD | 中 | 术语表、FR-6/FR-7 派生语义、SM-1/6/7/8、Go/No-Go、UJ-5/v1.1 门禁、发布适用性 |
| PRD Addendum | 中 | 分析范围术语、版本化验证与适用性合同、架构处置结果 |
| Architecture Spine | 中 | AD-28、AD-18、AD-25 双向追踪、新增 AD-30、Capability Map |
| Implementation Guide | 高 | 阶段 A、Story 映射、SQLite 建表引用、CI 表、验证矩阵、完成定义 |
| UX EXPERIENCE | 中 | Export 状态与 UJ-4 失败路径、可访问性标签、快捷键、断点和真实 Webview 矩阵 |
| UX DESIGN | 低 | ExportPreview 的完整 artifact 可操作条件 |
| epics.md | 高 | Story 1.1/1.3、四个 Story 拆分、新增产品验证 Story、依赖和追踪矩阵、总数 |
| 代码/基础设施 | 无直接修改 | 本提案不修改代码、CI 配置、provider ruleset 或 manifest |

### 2.3 跨文档引用漂移审计

当前规范制品中确认的直接 Story 映射漂移只有以下 5 处：

| 合同 | OLD | 当前权威 Story |
| --- | --- | --- |
| BuiltinIgnoreV1 / generation 0 | Story 1.2 | Story 1.4 |
| BasicSymbolV1 | Story 1.3 | Story 1.6 |
| BaseCycleProjectionV1 | Story 1.6 | Story 1.14 |
| ImpactVerdictV1 / ImpactRankV1 | Story 4.2 | Story 4.4 |
| 首次 rebuild 按需建表 | Story 1.2 | Story 1.4 |

未发现 PRD、UX、Architecture Spine 中其他当前有效的直接 Story 编号漂移。sprint-change-proposal-2026-07-15.md 和各 implementation-readiness-report 文件属于带日期的历史证据，保留原文，不回写其旧编号。

## 3. Recommended Approach

### 3.1 方案选择

选择 Option 1：Direct Adjustment。

- 可行性：高。
- 规划修改工作量：中，预计 3–5 人日完成多制品更新、交叉校验和一次 readiness 复评。
- 实施范围影响：不扩大 MVP；Story 总数从 56 增至 61，工作量主要由原 Story 重新显性分配。
- 时间影响：增加一个规划修订与复评周期；在 READY 前不启动大规模功能实施。
- 风险：中，主要是 Story ID、双向追踪、门禁阈值和历史证据混用。
- 缓解：保留现有 Story ID；新增 ID 使用 Epic 内下一个未用编号；使用显式依赖字段和机器可读追踪 gate；复评必须达到 READY。

### 3.2 不采用的方案

- Potential Rollback：不适用。没有已实施代码需要回滚。
- PRD MVP Review / 缩减范围：不适用。FR 覆盖完整，问题是合同同步与可执行性，不是 MVP 不可达。
- 新增 Epic：不需要。版本化验证属于 Epic 5 的发布用户价值。

## 4. Architecture 修改提案

### 4.1 AD-28：CI 顺序与完成定义

OLD：

> Story 1.1 必须建立自动 CI；ci/quality-gates.v1.yaml 是 blocking gate 唯一清单……基线至少包含 type、lint、unit、build、contract、dependency-boundary、basic-security 与规划引用/FR-AD-Story 一致性检查；在该基线通过前不得并行启动其他功能 Story。

NEW：

> Story 1.1 必须建立真实、可失败、可阻断的最小仓库 CI，并以稳定 check 名 architecture-required 运行 type、lint、unit、build、contract、dependency-boundary 和 basic-security；Story 1.2 只能通过该 CI 顺序合并。Story 1.3 必须把最小 CI 升级为完整架构门禁：ci/quality-gates.v1.yaml 成为适用 blocking gate 的唯一机器清单，加入规划引用与 FR/NFR/AR/UX-DR/Story 双向追踪检查，配置仓库外 provider ruleset 强制 architecture-required、禁用管理员 bypass，并建立独立 drift monitor。Story 1.3 完成前不得并行启动 Story 1.4 及其他功能 Story。能力首次由公共 CLI/RPC/extension 调用或公共 Schema 首次发布时，必须在同一 PR 将真实门禁加入 manifest；不得使用空测试、永久 skip、无断言或始终成功脚本。

理由：保留 AD-28“CI 从第一 Story 开始”的不变量，同时承认 provider 强制、manifest 与规划追踪需要在空服务握手后由 Story 1.3 完成。Story 1.1 和 1.3 的完成定义不再互相覆盖。

### 4.2 Implementation Guide 阶段 A

OLD：

> 从 Story 1.1 建立自动 CI：type、lint、unit、build、contract、dependency-boundary、basic-security 与规划引用/FR-AD-Story 一致性检查。  
> 完成标准：空服务可完成握手；extension 与 CLI 能连接同一工作区实例；不产生图谱；最小 CI 真实运行且失败会阻止合并。

NEW：

> Story 1.1 建立真实最小 CI：architecture-required 稳定 check 运行 type、lint、unit、build、contract、dependency-boundary 与 basic-security；Story 1.2 通过该 CI 顺序合并。  
> Story 1.3 建立 ci/quality-gates.v1.yaml、规划双向追踪、provider required check、禁用 bypass 与外部 drift monitor，并将最小 CI 升级为完整地基门禁。  
> 阶段 A 完成标准：空服务握手通过；extension 与 CLI 可连接同一工作区实例；不产生伪造图谱；Story 1.1 最小 CI 已持续阻断失败；Story 1.3 完整基线和 provider 强制已通过。阶段 A 完成前不得并行开放功能 Story。

### 4.3 Implementation Guide Story 映射

OLD → NEW：

1. BuiltinIgnoreV1 + generation 0

- OLD：首次 rebuild Story 的前置 AC（当前 Story 1.2）。
- NEW：首次 rebuild Story 的前置 AC（Story 1.4）；完整用户 .codegraphignore 语法仍由 Story 1.10–1.13 承担。

2. BasicSymbolV1

- OLD：TS/JS Analyzer 首次事实切片（当前 Story 1.3）。
- NEW：BasicSymbolV1 专属事实切片（Story 1.6）。

3. BaseCycleProjectionV1

- OLD：Alpha 图谱查询切片（当前 Story 1.6，或拆出的更早 Story）。
- NEW：Alpha CLI 查询与基础循环切片（Story 1.14），不可晚于 Story 2.2。

4. ImpactVerdictV1 / ImpactRankV1

- OLD：结构影响计算（当前 Story 4.2）。
- NEW：结构影响 verdict 与排序切片（Story 4.4），不可晚于 Story 4.5、4.6、4.8。

5. 首次 rebuild 建表

- OLD：该列表不是 Story 1.2 的一次性建表清单。
- NEW：该列表不是 Story 1.4 的一次性建表清单；Story 1.4 只创建首次 rebuild 当前读写路径需要的表。

### 4.4 CI 门禁表与完成定义

OLD：

| 首次落地切片 | 同步接入的门禁 |
| --- | --- |
| Story 1.1 架构地基 | type、lint、unit、build、contract、dependency-boundary、basic-security、规划引用与 FR-AD-Story 一致性 |

NEW：

| 首次落地切片 | 同步接入的门禁 |
| --- | --- |
| Story 1.1 最小仓库 CI | architecture-required 稳定 check；type、lint、unit、build、contract、dependency-boundary、basic-security |
| Story 1.3 完整地基门禁 | ci/quality-gates.v1.yaml、规划引用与 FR/NFR/AR/UX-DR/Story 双向追踪、provider required check、禁用 bypass、外部 drift monitor |
| Story 1.4 首次 rebuild / SQLite | 迁移、按需建表、事务、BuiltinIgnoreV1、generation 0 有效快照 |
| Story 1.19 确定性提交 | GraphPatch 幂等、完整 CAS、过期重排、半提交不可见 |

Implementation Guide“开发完成定义”新增一条：

- OLD：没有明确要求 Story 对应 gate 已登记。
- NEW：功能首次公开落地时，相关真实 gate 已在 ci/quality-gates.v1.yaml 登记并由 architecture-required 执行；Story 交付说明同时引用 checkId、能力 owner 和验证证据。

### 4.5 AD-18：完整 artifact 才可复制

OLD：

> 服务线协议只返回不可变 ExportArtifactV1……目标重试不得改变或销毁 artifact。

NEW：

> 服务只有在生成完整结束后才返回不可变 ExportArtifactV1。可复制或写出的 artifact 必须具有 artifactId、artifactStatus=complete、graphRevision、findingsRevision、requestedPolicy、effectivePolicy、containsSource、contentDigest 和 generatedAt；partial 或 generating 状态不得表示为 ExportArtifactV1。生成阶段失败时，不得暴露或复制部分内容；界面可以保留上一份完整 artifact，但必须标记其生成时间、revision/policy 和“上一份有效结果”。只有剪贴板、文件写入等目标操作失败时，才允许对本次完整 artifact 重试或改用另一目标。目标重试不得改变 artifact 内容或身份。

### 4.6 新增 AD-30：版本化产品验证与发布适用性唯一

OLD：

> 当前没有覆盖 SM-1、SM-6、SM-7、SM-8、Beta/Beta+ 适用性和 UJ-5/v1.1 的统一版本化 oracle。

NEW：

> AD-30 — 产品验证与发布适用性必须版本化且可重复判定。ProductValidationPlanV1 是 SM-1、SM-6、SM-7、SM-8 与 UJ-5 价值门禁的唯一任务、fixture、计时、ground truth、样本、剔除、评分和阈值来源；ReadinessGateManifestV1 是 Alpha/Beta/Beta+/v1.1 每个 release slice 的唯一适用性清单；ProductValidationEvidenceV1 和 ProductValidationResultV1 是唯一证据与判定格式。上述对象均使用 JSON Schema 2020-12、additionalProperties:false、稳定 ID、planVersion、fixture/task digest 和候选引用。任务、fixture、ground truth、阈值或剔除规则变化必须提升 planVersion；不匹配 planVersion、digest、candidateRef 或 evidence schema 的结果为 invalid，不能被人工解释为通过。Beta+ release 必须消费固定 manifest 并通过所有列出的 blocking gate；UJ-5 只控制 v1.1 候选启动，不扩大 MVP。

Binds：SM-1、SM-6、SM-7、SM-8、UJ-5、FR-6、FR-7、FR-11、FR-12、FR-17、FR-18、FR-23、release readiness。

### 4.7 Implementation Guide 验证合同

在“验证与门禁”新增：

ProductValidationPlanV1 至少固定：

- planId、planVersion、candidateRef 绑定规则。
- fixture/task manifest 及 digest。
- 每个任务的 startEvent、stopEvent、timeout。
- groundTruthRef、acceptableAliases、requiredEntities、criticalDistractors。
- eligibleParticipant、minimumSample、repository/team coverage。
- predeclaredExclusionRules。
- score instrument、threshold、aggregation rule。
- evidenceSchemaRef、resultSchemaRef、owner 和复测条件。

ReadinessGateManifestV1 至少固定：

- releaseSlice：alpha、beta、beta-plus 或 v1.1。
- gatePhase：entry、exit 或 release。
- requirementRefs：展开后的单个 FR/NFR/SM/AR/UX-DR ID，不允许范围字符串或人工选择“全部适用”。
- gateId、blocking、planRef、command、evidenceRefs、owner。
- manifestDigest 和 candidateRef。

机器可读适用性基线：

| Slice / Phase | 必须列入 |
| --- | --- |
| Beta entry | FR-1 至 FR-10、FR-19 至 FR-22 的逐项 ID；适用 NFR；SM-2、SM-3、SM-4、SM-5；安装、隐私、安全、兼容和基础可访问性 gate |
| Beta exit | SM-1、SM-7 及对应 ProductValidationPlanV1 |
| Beta+ release | FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8、发布完整性和信任链 gate，全部逐项展开 |
| v1.1 entry | 完整 MVP 已通过，且 UJ-5 价值门禁通过；MCP 本身不进入当前 manifest 的 MVP requirementRefs |

### 4.8 Architecture Capability Map

OLD：

> Capability Map 只有“SM-1..SM-6 性能与正确性”行，没有 SM-7、SM-8、UJ-5 和版本化产品验证的架构归属。

NEW：

| Capability / Area | Lives in | Governed by |
| --- | --- | --- |
| SM-1 用户影响判断 | product-validation task packs、query evidence、UX task runner | AD-19、AD-25、AD-30 |
| SM-6 规则正确性 | rules validation fixtures、Finding evidence | AD-9、AD-17、AD-25、AD-30 |
| SM-7 / SM-8 真实团队验证 | product-validation plans、evidence schemas、result gate | AD-18、AD-26、AD-30 |
| UJ-5 v1.1 价值门禁 | structure export task pack、ProductValidationResultV1 | AD-18、AD-30 |
| Release slice 适用性 | ReadinessGateManifestV1、release gate runner | AD-29、AD-30 |

AD-25 的 Capability Map 行继续绑定 FR-6、FR-7、FR-11、FR-14、FR-21、SM-1、SM-2；PRD §3、FR-6 和 FR-7 必须包含同一 directory/workspace-package、dependencyStrength、cycleMemberCount、热点与稳定排序语义，形成双向追踪。

## 5. PRD 修改提案

### 5.1 权威术语

OLD：

> 边包括 contains、imports、exports、references、depends_on、violates 等。  
> 项目结构概览以目录/模块聚合形式展示。

NEW：

- 目录：由工作区相对路径形成的物理层级；在 Overview 中按 scopeRoot 和 aggregationDepth 投影为叶子聚合。
- workspace package：由有效 npm/Yarn workspace 或 pnpm-workspace.yaml 识别出的最深 package root；workspace discovery 为 degraded 时不得生成该类型或跨 package 结论。
- 模块：用户可见的逻辑聚合称谓，不是第三种持久实体。MVP 中模块必须明确映射为 directory 投影叶子或 recognized workspace package；界面和导出必须同时携带 groupBy 与规范 ID。
- 边：MVP 规范关系包括 contains、imports、exports 和派生 depends_on；Finding 可以引用 violates 语义。references 不在 MVP 生成，不得进入术语示例、导航、导出、成功指标或发布声明。
- 项目结构概览：使用 ProjectionMembershipV1 在 directory 或 workspace-package 二选一投影上展示依赖、循环和热点；同一文件在单次查询中只属于一个叶子聚合。

### 5.2 FR-6：回写 AD-25 派生语义

OLD：

> 概览展示依赖方向、依赖强度、循环风险和图谱更新时间。

NEW：

> 概览必须展示依赖方向、dependencyStrength、cycleMemberCount、热点排序、完整性和图谱更新时间。dependencyStrength 等于两个叶子聚合之间不同 high-confidence 文件级 imports 规范边数量，同一边的多条 Evidence 只计一次。internalDependencyStrength 等于与其他内部聚合的入向与出向强度总和。热点按 active error、active warning、cycleMemberCount、internalDependencyStrength 降序，再按规范 node ID 升序；只有 freshness=current 且 completeness=complete 时显示正式排名，stale 或 partial 只能显示带限制说明的非正式结果。基础循环由不读取 rules.yaml 的统一 CycleProjectionKernelV1 计算。

### 5.3 FR-7：聚合与稳定排序

OLD：

> 超预算时，按相关性将距离较远的节点和边折叠为目录或 workspace package 聚合节点。

NEW：

> 超预算时，服务端先在完整候选范围内按焦点距离、关系角色、置信度和规范 node ID 的稳定 tie-break 排序，再截断或折叠为 directory 或 recognized workspace-package 聚合。scopeRoot、groupBy、aggregationDepth 与 membershipDigest 必须进入 query identity；同一输入、revision 和配置产生相同顺序。用户展开聚合时创建新的预算内局部查询，不在客户端无上限追加全局图。

### 5.4 SM-1：任务、计时、真值与正确性

OLD：

> 用户能在 3 分钟内回答“改这个文件会影响哪里”。

NEW：

> SM-1 使用 ProductValidationPlanV1 中版本化的 UJ-2 task pack。每个 task 固定 fixture commit/digest、targetFile、requiredEntities、affectedAggregates、acceptableAliases、criticalDistractors 和 groundTruthDigest。计时在 warm cache 已提交、目标文件和任务提示同时可见时触发 taskStarted；在参与者提交最终答案时触发 taskSubmitted，安装、首次索引和说明时间不计入，产品崩溃、查询失败或超时计为失败而不是剔除。单次答案正确需识别全部 requiredEntities、至少 80% affectedAggregates，且不选择 criticalDistractor。至少 10 个有效会话中，至少 80% 必须在 180 秒内正确完成。验证 FR-6、FR-7、FR-9；FR-17 由结构变更任务单独验证。

### 5.5 SM-6：规则 fixture 与阈值

OLD：

> 规则检查能发现循环依赖和配置的跨层规则违反。

NEW：

> SM-6 使用版本化 RulesValidationFixtureV1，至少包含 30 个受支持合同内案例，并同时覆盖 file/directory/package no-cycle、forbidden-dependency、layer-order、warning/error、rules ignore、索引排除差异和负对照。每个案例固定 fixture digest、rules digest、expectedFindingIds、expectedSeverity、expectedLocations 和 forbiddenUnexpectedFindings。发布门禁要求所有预期 error/warning Finding 的 recall=1.00、precision=1.00，error 级漏报为 0，负对照误报为 0，且 IDE/CLI 的稳定 Finding ID、严重级别和位置一致。环境、fixture 或 digest 不匹配时结果为 invalid，不得降低阈值重跑。

### 5.6 SM-7：固定任务、有效样本和评分

OLD：

> 至少 10 名有效试用者……完成固定的 UJ-2 影响判断任务；至少 70% 的评分达到 4/5。

NEW：

> SM-7 复用 SM-1 的版本化 UJ-2 task pack 和统一 taskStarted/taskSubmitted 事件。有效试用者必须是当前真实仓库的一线开发者或 Tech Lead、未参与产品实现、完成标准化说明且未接受任务答案提示；至少 10 人、3 个真实 TS/JS 仓库、2 个独立团队。允许剔除的原因只限于资格不符、撤回同意、与产品无关的记录损坏或预检环境不满足计划；产品崩溃、超时、错误答案、低评分和负面反馈不得剔除。参与者提交任务后立即、仅一次对固定陈述“相比目录树和搜索，我能更快理解结构影响”按 1–5 分评分；缺失评分使会话无效但必须记录原因，不得补填或平均多次评分。以有效会话为分母，至少 70% 评分达到 4/5 或以上；同时保留完成时间、正确性和原始评分证据。

### 5.7 SM-8：证据格式

OLD：

> 至少 5 名 Tech Lead……至少 80% 能直接用 PR Markdown 摘要启动风险讨论。

NEW：

> SM-8 每次 review 生成 TechLeadReviewEvidenceV1，至少包含 planVersion、participantPseudonym、teamId、repositoryId、candidateRef、changeSet/baseRef digest、artifactId、graphRevision、findingsRevision、requested/effectivePolicy、containsSource、verdict、majorRiskIds、keyPaths、suggestedReviewFiles、editClassification、criticalOmissions、falseCriticalStatements、decision 和 timestamp。editClassification 只允许 none、wording-only、format-only、structural-reanalysis；只有前三种且 criticalOmissions 与 falseCriticalStatements 均为空时单次验证通过。至少 5 名 Tech Lead、3 个独立团队中，至少 80% 单次验证通过；所有失败样本必须保留并关联复测条件。

### 5.8 Go/No-Go 与机器适用性

OLD：

> Beta+ 必须同时通过 SM-1 至 SM-8；全部适用 FR/NFR/SM 由最终审计判断。

NEW：

> ReadinessGateManifestV1 是 release slice 适用性的唯一来源。Beta entry、Beta exit、Beta+ release 和 v1.1 entry 必须分别使用独立、版本化、逐项展开的 gate 列表；禁止在执行时人工解释“全部适用”。Beta 仍不是完整 MVP。Beta+ release manifest 必须逐项列出 FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8 和发布完整性 gate；任一 gate fail 或 invalid 均为 No-Go，并记录失败样本、owner 和复测条件。

### 5.9 UJ-5 / v1.1 价值门禁

OLD：

> 用户确认本地结构上下文导出有价值后再启动 v1.1。

NEW：

> UJ-5 价值门禁使用版本化 UJ5ExportValueTaskV1。至少 8 名有效的 AI 编码重度用户，覆盖至少 3 个真实 TS/JS 仓库和 2 个独立团队，完成固定的边界敏感任务：为指定目标生成 structure-only ExportArtifactV1，指出允许修改范围和至少一条禁止跨越的边界，将 artifact 作为 AI 任务约束输入，并在候选修改后运行 check/impact 复核。至少 75% 的有效参与者必须正确识别目标范围与禁止边界，且对“该导出实质性澄清了 AI 任务的允许范围和结构约束”评分达到 4/5 或以上；任何源码、绝对路径或未授权内容泄露均使门禁失败。该门禁不以 AI 生成代码成功率衡量 MVP，只决定是否允许启动 v1.1/MCP 候选。

### 5.10 PRD Addendum

新增“5.7 产品验证与发布适用性合同”，回写 ProductValidationPlanV1、ReadinessGateManifestV1、ProductValidationEvidenceV1 和 ProductValidationResultV1，并在“架构处置结果”增加 AD-30 引用。

将“需要精确引用/实现关系时增强 LSP 或 SCIP”保留为后续触发条件，但明确 references 不属于 MVP 当前边或导出合同。

## 6. UX 修改提案

### 6.1 ExportPreview 与失败状态

OLD：

> Export failed：保留预览，说明目标不可写或生成失败，并允许重试/复制。  
> UJ-4 failure path：生成失败时允许复制已生成部分或重试。

NEW：

> Export generating：仅显示进度和取消/返回；复制与写出禁用，不显示部分内容。  
> Export ready：只有完整、不可变且带 artifactId、revision、requested/effectivePolicy、containsSource 和 contentDigest 的 artifact 才启用复制/写出。  
> Export target failed：剪贴板或原子文件写入失败时保留本次完整 artifact，允许重试同一目标或切换目标。  
> Export generation failed：不创建或暴露部分 artifact；若存在上一份完整 artifact，可保留并明确标记“上一份有效结果”、生成时间、revision 和 policy，用户只能复制该上一份完整结果或重新生成。  
> UJ-4 failure path：git diff 不可用时不给出伪造预览；生成失败时禁止复制部分摘要；目标写出失败时可以复用同一完整 artifact。

UX-DR18 OLD：

> 失败时保留不可变 artifact 并支持重试或复制。

UX-DR18 NEW：

> 仅 artifactStatus=complete 且包含 revision、policy 和 contentDigest 的不可变 artifact 可复制或写出。生成失败不产生可复制部分内容；目标操作失败才保留本次完整 artifact 并允许重试。上一份有效 artifact 必须与本次失败状态视觉分离。

DESIGN.md ExportPreview OLD：

> 预览即将复制或写出的 Markdown/AI 结构上下文。

DESIGN.md ExportPreview NEW：

> ExportPreview 只预览完整不可变 artifact；生成中和生成失败不呈现可复制的部分正文。复制/写出动作必须绑定 artifactId、revision、policy 和 contentDigest；目标失败保留完整预览，生成失败只可显示上一份有效 artifact 或空失败状态。

### 6.2 可访问性 ASSUMPTION

OLD：

> 目标为 WCAG 2.2 AA。[ASSUMPTION]  
> 图节点可选区域不得小于 24×24 CSS px。[ASSUMPTION]  
> Open UX Assumptions 将两项要求本身列为假设。

NEW：

> 人类可读界面必须达到 WCAG 2.2 AA；图节点可选区域不得小于 24×24 CSS px。两项均为 NFR-18、NFR-19 的强制要求，不带 ASSUMPTION 标签。  
> 保留的待验证项仅为“使用何种真实 Webview 证据证明已达到要求”，不得将要求本身降级。

### 6.3 候选快捷键

OLD：

> Ctrl+Alt+G、Ctrl+Alt+P 为候选，最终需经 VS Code 冲突检查；主流扩展范围未定义。

NEW：

- Windows/Linux 候选：Ctrl+Alt+G 打开 Current Context，Ctrl+Alt+P 固定/解除固定。
- macOS 候选：Cmd+Option+G 与 Cmd+Option+P。
- 阻断检查范围：VS Code 1.125.0、最新稳定版、前一稳定版的默认键位、Accessibility Help、产品自身命令和常用系统保留组合。
- 第三方扩展冲突不作为无限清单门禁；若检测到冲突，快捷键必须可重映射且 Command Palette 始终可完成任务。
- 若任一候选覆盖 VS Code 默认或可访问性关键命令，则该平台不提供默认绑定，只保留 Command Palette。
- 验证证据记录 hostVersion、OS、keyboardLayout、candidate、conflictTarget 和 disposition。

### 6.4 响应断点与真实 Webview 矩阵

OLD：

> 900px / 600px / 360px 为 ASSUMPTION，实现时以内容溢出测试校准；真实 Webview 证据未定义矩阵。

NEW：

> 900px、600px、360px 保留为候选响应阈值，不是不可变产品常数。实现必须在真实 VS Code Webview 中测试 1024、900、899、600、599、360、359 CSS px，并以无关键动作裁切、无水平溢出、200% 字号下信息不重叠、键盘焦点不丢失为通过条件。若校准后阈值变化，必须同步更新 EXPERIENCE、UX-DR36、Story AC 和视觉基线。

阻断矩阵：

| 维度 | 覆盖 |
| --- | --- |
| VS Code | 1.125.0、最新稳定版、前一稳定版 |
| Theme | 暗色、亮色、高对比 |
| Zoom / font | 100%、200% |
| Editor width | 1024、899、599 CSS px |
| Sidebar width | 359 CSS px |
| Input | 仅键盘完成核心流程 |
| Assistive tech spot check | Windows + NVDA、macOS + VoiceOver、Linux + Orca，至少在最新稳定版、高对比与 200% 字号验证 |
| Evidence | 截图/可访问性树、焦点顺序、溢出结果、宿主版本、主题、OS、断点和已知限制 |

该矩阵由首个真实 Webview 切片建立基础证据，并由 Story 5.5 在发布候选上复验。

## 7. Epics / Stories 修改提案

### 7.1 编号策略

OLD：

> 56 个 Story 按数值顺序排列，拆分会导致后续编号大面积漂移。

NEW：

> 现有 Story ID 视为稳定标识，不重编号。拆分出的新 Story 使用 Epic 内下一个未用编号，并插入权威依赖顺序位置。epics.md 的文档顺序和每个 Story 的“依赖”字段共同定义执行顺序，Story ID 的数值排序不定义依赖。新增 Story 为 1.19、2.10、2.11、4.9、5.11；原 5.11 顺延为 5.12。总数从 56 变为 61。

权威执行序列变化：

- Epic 1：1.1 → 1.2 → 1.3 → 1.4 → 1.19 → 1.5 → 1.6 … → 1.18
- Epic 2：2.1 → 2.10 → 2.2 … → 2.8 → 2.11 → 2.9
- Epic 4：4.1 … → 4.7 → 4.8 → 4.9
- Epic 5：5.1 … → 5.10 → 5.11 → 5.12

#### 7.1.1 epics.md 概述与附加要求目录

概述 OLD：

> 2026-07-16 修订将工作拆为 56 个 Story。

概述 NEW：

> 本次获批修订保持 5 个 Epic 和 FR-1 至 FR-23 不变，将 4 个过大 Story 拆为 8 个端到端 Story，并新增 1 个版本化产品验证 Story；总数为 61。现有 Story ID 保持稳定，文档顺序和显式依赖字段定义执行顺序。

AR-28 OLD：

> Epic 1 的前三个地基 Story 必须依次完成仓库边界、空服务握手和自动 CI/ci/quality-gates.v1.yaml；完整基线通过前不得并行启动其他功能 Story。

AR-28 NEW：

> Story 1.1 同时建立仓库边界与真实最小 CI，architecture-required 运行 type、lint、unit、build、contract、dependency-boundary 和 basic-security；Story 1.2 通过该 CI 顺序合并。Story 1.3 再建立 ci/quality-gates.v1.yaml、规划双向追踪、provider required check、禁用 bypass 和外部 drift monitor。Story 1.3 完成前不得并行启动 Story 1.4 及其他功能 Story；能力首次公开落地时必须在同一 PR 扩展真实 blocking gate。

AR-32 OLD：

> 不存在。

AR-32 NEW：

> ProductValidationPlanV1 固定 SM-1、SM-6、SM-7、SM-8 和 UJ-5 的任务、fixture、计时、ground truth、样本、剔除、评分、阈值和 evidence schema；ReadinessGateManifestV1 是 Beta/Beta+/v1.1 适用性唯一机器清单。planVersion、digest、candidateRef 或 schema 不匹配的证据为 invalid，不能人工解释为通过。对应 Architecture 决策为 AD-30。

UX-DR18、UX-DR28、UX-DR36、UX-DR37 必须同步采用本提案 §6 的完整 artifact、候选快捷键、断点校准和真实 Webview 矩阵文本；不得只修改 UX 主文档而保留 epics.md 中的旧要求。

### 7.2 Story 1.1 与 Story 1.3

Story 1.1 OLD：

> 只要求仓库结构、根级命令和依赖边界可执行。

Story 1.1 NEW 标题：

> Story 1.1：建立仓库模板、依赖边界与最小真实 CI

新增关联：AR-28。

新增 BDD：

**Given** 根级 type、lint、unit、build、contract、dependency-boundary 和 basic-security 命令已经可重复执行  
**When** Pull Request 或受保护分支触发 CI  
**Then** architecture-required 以稳定 check 名执行所有命令  
**And** 任一真实失败阻止 Story 1.1 合并  
**And** 不使用空测试、永久 skip、无断言或始终成功脚本。

**Given** Story 1.1 已合并  
**When** Story 1.2 开始或提交  
**Then** Story 1.2 只能通过同一最小 CI 顺序合并  
**And** Story 1.1 的门禁持续运行，不能等待 Story 1.3 才首次启用。

Story 1.3 OLD：

> 同时首次建立全部 CI、provider ruleset 和规划追踪。

Story 1.3 NEW 标题：

> Story 1.3：强化 provider 阻断与规划双向追踪门禁

Story 1.3 NEW 完成定义：

- 依赖 Story 1.1、1.2。
- 不重复创建最小 CI；把其转换为 manifest 驱动的完整架构门禁。
- ci/quality-gates.v1.yaml 是适用 gate 唯一清单。
- provider ruleset 强制 architecture-required，管理员 bypass 禁用。
- 外部 drift monitor 验证 required check 和 ruleset。
- 规划追踪覆盖 FR、NFR、SM、AR、UX-DR、AD、Story、相对文档链接和 ProductValidation plan/manifest 引用。
- Story 1.3 未完成前不得并行启动 Story 1.4 或其他功能 Story。

### 7.3 Story 1.4 拆分

OLD：

> Story 1.4：构建确定性的基础图谱。单一 Story 同时承担 generation 0、已有 ignore 失败、Job、层级实体、稳定 ID、SQLite、FactBatch/GraphPatch、幂等重建、CAS、空工作区、失败和 CI。

NEW Story 1.4：

### Story 1.4：安全初始化首次图谱与最小存储

As a 首次使用本地图谱的开发者，  
I want 在安全排除基线和最小持久存储上得到可识别的首次图谱结果，  
So that 我不会索引依赖目录、预建未来数据或看到伪造成功状态。

依赖：Story 1.3。

关联需求：FR-1、FR-4、FR-5、FR-22；NFR-9、NFR-10、NFR-11；AR-6、AR-8、AR-9、AR-12、AR-28。

Acceptance Criteria:

**Given** 工作区不存在 .codegraphignore  
**When** graph-service 完成首次配置屏障  
**Then** 建立 generation 0、validity=valid、contentHash=null 的空用户排除快照  
**And** effectiveRules 已包含完整 BuiltinIgnoreV1  
**And** Analyzer 和 scanner 只消费 EffectiveIgnoreSnapshotV1。

**Given** 工作区存在尚未由完整排除切片支持的 .codegraphignore  
**When** 用户请求首次 rebuild  
**Then** 系统返回稳定、可操作的配置能力诊断  
**And** 不静默忽略文件、不绕过内容、不提交范围不可信的图谱。

**Given** 候选文件已应用有效排除快照  
**When** 用户执行首次 rebuild  
**Then** 创建 initial-index 或 rebuild Job  
**And** 生成 workspace、directory、file 节点与 contains 关系  
**And** node_modules、构建产物、缓存和生成代码不进入候选集。

**Given** 基础实体需要公共身份  
**When** 写入当前切片  
**Then** 使用工作区作用域确定性 cg:// ID  
**And** 路径使用 Unicode NFC 和相对 POSIX 格式  
**And** SQLite rowid、绝对路径和宿主分隔符不进入公共合同。

**Given** graph-service 首次创建存储  
**When** 初始化当前切片 schema  
**Then** 只创建 meta、workspace、nodes、edges、evidence、facts_ownership、jobs、schema_migrations  
**And** 不提前创建 Findings、impact、export 或发布表  
**And** 启用 WAL、foreign keys、synchronous=NORMAL 和有界 busy timeout。

**Given** 工作区没有受支持文件或首次构建失败  
**When** 用户查看状态  
**Then** 空工作区返回可识别的空摘要  
**And** 失败返回稳定 code、日志引用和重试动作  
**And** 不把未提交实体表示为成功图谱。

**Given** Story 1.4 首次进入公共 rebuild 路径  
**When** CI 运行  
**Then** SQLite 迁移、按需建表、BuiltinIgnoreV1、generation 0、路径与空/失败状态门禁通过  
**And** 任一失败阻止合并。

NEW Story 1.19：

### Story 1.19：完成确定性 rebuild 与原子提交

As a 依赖本地图谱做判断的开发者，  
I want 相同输入得到相同已提交图谱，并在输入变化时拒绝过期结果，  
So that 查询和后续分析永远基于完整、可重复、未被竞态污染的 revision。

依赖：Story 1.4。Story 1.5 不得早于本 Story。

关联需求：FR-1、FR-5、FR-22；NFR-9、NFR-10、NFR-11、NFR-22；AR-4、AR-5、AR-6、AR-9、AR-12、AR-28。

Acceptance Criteria:

**Given** hierarchy FactBatch 已生成  
**When** indexing application 提交结果  
**Then** FactBatch 使用 hierarchy:<indexingRootId> ownership slice  
**And** GraphPatch、graphRevision 和关联元数据在同一事务提交  
**And** 查询无法观察半更新状态。

**Given** 工作区内容和有效排除快照未变化  
**When** 连续执行两次完整 rebuild  
**Then** 实体 ID、contains 关系和稳定排序相同  
**And** 不产生重复节点、边或孤立 ownership  
**And** GraphPatch 重放幂等。

**Given** manifest、文件 hash、bootstrap generation 或排除快照在 Job 期间变化  
**When** GraphPatch 准备提交  
**Then** 服务对完整 read-set 执行 CAS  
**And** 过期结果不得提交  
**And** Job 被有界重排并保持旧 revision 可读。

**Given** Job 为 partial、failed 或 cancelled  
**When** 事务边界到达  
**Then** 最新已提交 revision 保持不变  
**And** 状态准确显示 partial、failed、cancelled 或 stale  
**And** 未完成事实不得覆盖完整 ownership slice。

**Given** Story 1.19 首次公开确定性 rebuild  
**When** CI 运行  
**Then** 事务原子性、幂等重建、ownership、完整 CAS、过期重排和半提交不可见均为 blocking gate  
**And** 任一失败阻止 Story 1.5 开始。

### 7.4 Story 2.1 拆分

OLD：

> Story 2.1 同时承担 extension 壳层、Workspace Trust、全部 surface、Getting Started、Index Status、monorepo 状态、Webview 安全、双语本地化和 Electron gate。

NEW Story 2.1：

### Story 2.1：进入可信的 VS Code 图谱壳层

As a VS Code 开发者，  
I want 在工作区信任和安全 Webview 边界内进入图谱功能，  
So that 我可以确认产品入口可用且不会在未授权状态读取项目或启动分析。

依赖：Epic 1 完成。

关联需求：FR-21、FR-22；NFR-8、NFR-13、NFR-27；UX-DR1、UX-DR19、UX-DR20、UX-DR37；AR-19、AR-21、AR-28。

Acceptance Criteria:

**Given** 工作区已授予 Workspace Trust  
**When** extension 激活  
**Then** 通过 service-client 发现或启动 Epic 1 graph-service  
**And** Activity Bar、TreeView、Status Bar、Command Palette 和 Webview Editor 壳层可用  
**And** extension host 不执行索引、SQL、规则计算或复杂布局。

**Given** 工作区未授予信任  
**When** extension 激活或执行图谱命令  
**Then** 不启动服务、不读取项目、不执行 Git  
**And** 唯一主动作是管理 Workspace Trust  
**And** 不展示伪造空图谱或失败缓存。

**Given** Webview 创建或 reload  
**When** extension 发送 shell model  
**Then** 使用严格 CSP、nonce、本地资源根和运行时消息 Schema  
**And** 禁止网络访问和直接文件读取  
**And** 无效、越界或过期消息安全拒绝。

**Given** Story 2.1 首次公开 VS Code surface  
**When** CI 运行  
**Then** Electron 激活、Workspace Trust、surface 职责、CSP、消息校验和基础键盘入口为 blocking gate  
**And** 留下真实 Webview shell 的宿主版本和安全证据。

NEW Story 2.10：

### Story 2.10：查看 Getting Started 与权威 Index Status

As a 刚进入图谱体验的开发者，  
I want 看到本地处理说明、索引范围、进度、完整性和恢复动作，  
So that 我知道图谱当前是否可用、受限或需要重建。

依赖：Story 2.1。Story 2.2 不得早于本 Story。

关联需求：FR-21、FR-22；NFR-10、NFR-17、NFR-18、NFR-20；UX-DR4、UX-DR15、UX-DR16、UX-DR21、UX-DR22、UX-DR24、UX-DR25、UX-DR34 至 UX-DR37；AR-19。

Acceptance Criteria:

**Given** 当前没有已提交图谱  
**When** 打开 Getting Started  
**Then** 解释本地处理和默认不上传  
**And** 主动作是构建图谱，辅助入口显示索引范围、排除摘要和 workspace discovery  
**And** 不使用空白画布或装饰插画代替状态。

**Given** Job 为 queued、running、cancelled、failed 或已有缓存  
**When** 打开 Index Status  
**Then** 呈现权威 ServiceStatusV1 和 IndexStatusSummaryV1  
**And** 显示阶段、进度、完成范围、生成时间、完整性、日志和恢复动作  
**And** stale、failed、cancelled 均保留可用缓存。

**Given** workspace discovery 为 recognized、single 或 degraded  
**When** 显示摘要  
**Then** recognized 显示类型与 package 数  
**And** single 不显示为错误  
**And** degraded 说明 package 能力限制并提供检查配置或 rebuild。

**Given** locale 为 zh-CN、en 或未知值  
**When** 渲染人类可读状态  
**Then** zh-CN 与 en 使用资源文件，未知值回退 en  
**And** JSON 字段、错误 code、枚举和 Schema 不本地化  
**And** 技术状态附可理解说明。

**Given** 暗色、亮色、高对比、100%/200% 字号和候选断点矩阵  
**When** 在真实 VS Code 打开 Getting Started 与 Index Status  
**Then** 关键状态、动作和焦点不裁切、不重叠、不只依赖颜色  
**And** 记录 hostVersion、theme、zoom、width、OS 和证据引用。

### 7.5 Story 2.8 拆分

OLD：

> Story 2.8 同时贯穿 watcher、settle/hash、增量 Analyzer、GraphPatch/Findings 原子提交、GraphViewPatch、客户端三时钟、空间记忆、2 秒 SLA 和事件风暴恢复。

NEW Story 2.8：

### Story 2.8：保存后增量提交权威图谱 revision

As a 持续修改代码的开发者，  
I want 保存后服务在后台收敛并提交最新图谱 revision，  
So that 即使发生重复事件、竞态或分析失败，我仍能继续使用上一份可信结果并最终得到最新事实。

依赖：Story 2.7 和 Epic 1 的增量分析基础。

关联需求：FR-3、FR-22；NFR-5、NFR-9、NFR-10；AR-4、AR-5、AR-12、AR-13。

Acceptance Criteria:

**Given** 用户保存受支持文件  
**When** watcher 产生变化候选  
**Then** 按规范路径合并并经过 quiet window、最大等待和内容 hash 去重  
**And** hash 未变化时不启动重复分析  
**And** watcher 不被视为强一致证明。

**Given** 稳定内容与已提交 digest 不同  
**When** 创建 incremental Job  
**Then** freshness 立即 stale  
**And** Job 进入唯一 snapshot mutation channel  
**And** Analyzer 只处理受影响 ownership slice，旧缓存继续可读。

**Given** FactBatch 有效  
**When** 提交 GraphPatch 和受影响派生结果  
**Then** 节点、边、Evidence、revision 和当前切片要求的派生状态原子提交  
**And** 提交前 CAS manifest、input、ignore、rules 和 bootstrap generation  
**And** 过期结果丢弃并有界重排。

**Given** 分析失败、partial、cancelled、事件风暴或 watcher 丢事件  
**When** Job 结束或 reconciliation 触发  
**Then** 保留最新提交结果并准确显示 failed、partial、cancelled 或 stale  
**And** 显式 rebuild 吸收未执行增量任务  
**And** 队列有界并最终与完整 manifest 对账一致。

**Given** 服务提交新 revision  
**When** 发布状态事件  
**Then** 携带 serviceInstanceId、statusEpoch、graphRevision、findingsRevision 和 statusRevision  
**And** 不在服务提交前宣布 current。

NEW Story 2.11：

### Story 2.11：原子刷新当前视图并保持空间上下文

As a 正在阅读依赖关系的开发者，  
I want 新 revision 一次性更新当前视图并保留我的位置和选择，  
So that 保存后的最新结果不会通过跳动、半更新或错误 patch 打断我的判断。

依赖：Story 2.8。Story 2.9 可在本 Story后执行。

关联需求：FR-3、FR-22；NFR-5、NFR-8、NFR-10、NFR-17、NFR-20；UX-DR6、UX-DR15、UX-DR23、UX-DR27、UX-DR30、UX-DR32；AR-11、AR-20。

Acceptance Criteria:

**Given** 当前物化视图受新 revision 影响  
**When** 服务生成 GraphViewPatchV1  
**Then** delta 完整覆盖节点、边、Finding、排序、聚合、截断、workspace discovery 和状态  
**And** patch 绑定 viewId、queryFingerprint、serviceInstanceId、statusEpoch 和三组 revision  
**And** 无法精确差量时发送 invalidate。

**Given** 客户端收到 patch  
**When** 身份和基线时钟全部匹配  
**Then** 一次性应用完整 delta  
**And** 任一不匹配时丢弃 patch 并全量重取  
**And** 不显示混合 revision。

**Given** 稳定 ID 仍存在  
**When** 应用刷新结果  
**Then** 保留中心、选择、ContextLock、展开、缩放、筛选和列表位置  
**And** 不持续动画、强制适应视图、清空画布或弹模态框。

**Given** 标准项目和参考环境  
**When** 用户保存文件  
**Then** 从宿主 save 到对应 graph/Findings revision 在 UI 可见的 p95 不超过 2 秒  
**And** 超时继续显示更新中且不宣布 current  
**And** extension host 与 Webview 主线程不被阻塞。

**Given** 服务状态为 failed、partial、cancelled 或 stale  
**When** 当前视图无法更新  
**Then** 保留上一份完整视图并显示原因和恢复动作  
**And** 屏幕阅读器和列表获得与图一致的状态说明。

### 7.6 Story 4.8 拆分

OLD：

> Story 4.8 同时实现 CLI impact、CLI export、JSON/文本/Markdown、原子文件写入、退出码、完整 help 面和共享 CI。

NEW Story 4.8：

### Story 4.8：通过 CLI 自动化结构 impact

As a 需要脚本化结构审查的开发者或 CI 维护者，  
I want 使用稳定的 impact 命令生成统一结构结论，  
So that 本地和自动化流程复用与 VS Code、PR Markdown 相同的 verdict、风险和退出语义。

依赖：Story 4.4；建议在 Story 4.5、4.6 后验证呈现一致性。

关联需求：FR-16、FR-17、FR-20；NFR-12、NFR-21；UX-DR17；AR-18、AR-22、AR-28。

Acceptance Criteria:

**Given** 用户运行 codegraph impact  
**When** 指定 working tree、staged 或 base ref  
**Then** 复用 ChangeSet、CycleDeltaV1、ImpactVerdictV1 和 ImpactRankV1  
**And** 不在 CLI 重新计算 verdict 或排序。

**Given** 使用文本、JSON 或 PR Markdown  
**When** 命令完成  
**Then** JSON stdout 只含 schemaVersion 1 envelope  
**And** 进度写 stderr、机器模式无 ANSI、路径相对 POSIX  
**And** 三种格式使用相同 verdict、coverage、majorRisks、keyPaths 和 suggestedReviewFiles。

**Given** 成功、fail-on 命中、输入无效、内部失败、协议不兼容或取消  
**When** 命令结束  
**Then** 使用 0、1、2、3、4 或 130  
**And** warning 默认不失败，除非显式 fail-on  
**And** 不改变缓存或主图 revision。

**Given** Git 不可用、基线无效或比较不完整  
**When** impact 执行  
**Then** 返回稳定诊断或 unknown/not-applicable  
**And** 不伪造 pass 或静默选择另一基线。

**Given** impact 首次公开落地  
**When** CI 运行  
**Then** ChangeSet、CycleDelta、verdict、排序、格式、stdout/stderr、相对路径和退出码均为 blocking gate。

NEW Story 4.9：

### Story 4.9：通过 CLI 导出完整且可重试的结构 artifact

As a 需要把结构上下文交给工具或同事的开发者，  
I want 使用稳定的 export 命令生成完整、版本化且默认无源码的 artifact，  
So that 自动化可以安全复用同一内容，并在目标写入失败时重试而不复制部分结果。

依赖：Story 4.7、4.8。

关联需求：FR-20、FR-23；NFR-12、NFR-14、NFR-16、NFR-21；UX-DR18、UX-DR25；AR-22、AR-24、AR-28。

Acceptance Criteria:

**Given** 用户运行 codegraph export  
**When** 指定相对路径、范围、预算和格式  
**Then** 复用 StructureContextExportV1  
**And** 默认 requested/effectivePolicy=structure-only  
**And** include-source 只由当前 invocation 显式授权。

**Given** 服务成功完成生成  
**When** 返回 ExportArtifactV1  
**Then** artifactStatus=complete  
**And** 包含 artifactId、graph/findings revision、policy、containsSource、contentDigest、generatedAt 和 truncation  
**And** 相同输入稳定排序且不含绝对路径。

**Given** 生成过程失败或取消  
**When** CLI 处理结果  
**Then** 不输出可复制的部分 artifact  
**And** JSON/text/Markdown 明确返回失败或取消  
**And** 缓存和上一份完整 artifact 不被改写。

**Given** 用户请求文件输出  
**When** CLI 写出完整 artifact  
**Then** graph-service 不接收绝对目标路径  
**And** CLI 使用本地原子写入  
**And** 目标失败不产生半文件，并保留同一完整 artifact 供重试。

**Given** 使用 JSON、文本或 Markdown  
**When** 命令结束  
**Then** envelope、stdout/stderr、无 ANSI 和退出码遵循 AR-22  
**And** export 不因 warning 默认失败  
**And** help 说明范围、格式、隐私、policy、完整 artifact 条件和退出码。

**Given** Epic 1–4 公共命令全部完成  
**When** 运行 codegraph --help 和 CI  
**Then** 命令面包含 rebuild、query、check、impact、export、status、doctor、cache  
**And** 未实现的云端、MCP 或 hosted PR 能力不出现  
**And** export Schema、默认无源码、无绝对路径、生成失败和目标失败场景均为 blocking gate。

### 7.7 新增 Story 5.11，原 5.11 顺延

OLD：

> Story 5.11 直接审计“全部适用”FR/NFR/SM，但没有固定 plan、适用性 manifest 和证据 schema。

NEW Story 5.11：

### Story 5.11：建立版本化产品验证与发布适用性合同

As a 发布负责人和测试负责人，  
I want 使用固定任务、fixture、样本规则、阈值和机器适用性清单，  
So that 不同执行者可以对同一候选得到相同的 Beta、Beta+ 和 v1.1 门禁结论。

依赖：Story 5.6–5.10 可提供技术与候选输入；必须早于 Story 5.12。

关联需求：SM-1、SM-6、SM-7、SM-8、UJ-5；AR-29、AR-30、AR-32。

Acceptance Criteria:

**Given** SM-1、SM-6、SM-7、SM-8 和 UJ-5 需要执行  
**When** 发布 ProductValidationPlanV1  
**Then** 固定 task/fixture digest、计时边界、ground truth、样本、资格、剔除、评分、阈值和证据 schema  
**And** 所有对象具有 planId、planVersion、owner 和复测条件  
**And** 改变任务、fixture、阈值或剔除规则必须升版。

**Given** Beta、Beta+ 或 v1.1 候选  
**When** 解析 ReadinessGateManifestV1  
**Then** requirementRefs 逐项列出，不允许范围字符串或人工选择“全部适用”  
**And** 每个 gate 具有 gateId、phase、blocking、planRef、command、evidenceRefs 和 owner  
**And** manifest 绑定 candidateRef 和 digest。

**Given** 执行 SM-1  
**When** 记录任务结果  
**Then** 使用固定 taskStarted/taskSubmitted、180 秒、ground truth 和正确性规则  
**And** 产品失败计为失败，不得作为预声明之外的剔除理由。

**Given** 执行 SM-6  
**When** 运行规则 fixture  
**Then** expected/forbidden Findings、位置、严重级别和 ID 可机器比较  
**And** precision、recall、漏报和误报阈值按 PRD 固定。

**Given** 执行 SM-7 或 SM-8  
**When** 收集真实用户证据  
**Then** 资格、仓库/团队覆盖、评分、编辑分类、失败样本和剔除原因使用封闭 schema  
**And** 负面结果不得被删除或以视觉评分替代。

**Given** 评估 UJ-5  
**When** 执行结构导出价值任务  
**Then** 只决定 v1.1 entry  
**And** 不将 MCP、AI 自动修改成功率或新语言加入 MVP。

**Given** plan、manifest 或 evidence 不匹配候选  
**When** gate runner 判定  
**Then** 结果为 invalid/No-Go  
**And** 输出不匹配字段、owner 和复测条件  
**And** 不允许人工覆盖为 pass。

原 Story 5.11 NEW 编号与标题：

> Story 5.12：审计完整候选并执行 Go/No-Go

Story 5.12 的第二组 AC 替换为：

**Given** Story 5.11 已冻结 ProductValidationPlanV1 和 ReadinessGateManifestV1  
**When** 评估 Beta+ release manifest  
**Then** 逐项执行 FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8 和发布完整性 gate  
**And** 只接受 schema、planVersion、digest、candidateRef 均匹配的证据  
**And** Beta 不被表述为完整 MVP。

Story 5.12 发布记录新增引用：

- readinessGateManifestDigest
- productValidationPlanVersion
- ProductValidationResultV1
- SM-8 evidence set
- 所有 invalid/fail 样本与复测条件

### 7.8 受本次合同变化波及的既有 Story

#### Story 2.6 候选快捷键

OLD：

> 与 VS Code 默认键位、主流扩展和可访问性要求冲突时不设置默认绑定；“主流扩展”没有固定范围。

NEW：

**Given** Windows/Linux 的 Ctrl+Alt+G、Ctrl+Alt+P 或 macOS 的 Cmd+Option+G、Cmd+Option+P 进入候选矩阵  
**When** 在 VS Code 1.125.0、最新稳定版和前一稳定版上检查默认键位、Accessibility Help、产品自身命令与系统保留组合  
**Then** 任一候选覆盖宿主默认或可访问性关键命令时，该平台不注册默认绑定  
**And** 第三方扩展冲突记录为可重映射兼容信息，不维护无界“主流扩展”清单  
**And** Command Palette 和可聚焦 ContextLock 始终完成同一任务  
**And** 证据记录 hostVersion、OS、keyboardLayout、candidate、conflictTarget 和 disposition。

#### Story 4.6 完整 PR artifact

OLD：

> 服务完成渲染后返回不可变 artifact；复制或写出失败时保留预览并允许重试或复制。没有显式禁止生成阶段的部分摘要。

NEW：

**Given** 服务完整生成 PrReviewSummaryV1  
**When** 返回 ExportArtifactV1  
**Then** artifactStatus=complete，并包含 artifactId、graphRevision、findingsRevision、requestedPolicy、effectivePolicy、containsSource、contentDigest 和 generatedAt  
**And** 只有该完整 artifact 可在 ExportPreview 启用复制或写出。

**Given** 摘要生成失败或取消  
**When** ExportPreview 接收失败  
**Then** 不创建、不显示、不复制部分 Markdown  
**And** 若存在上一份完整 artifact，只能以“上一份有效结果”显示其 revision、policy 和生成时间  
**And** 提供重新生成，不把上一份内容伪装成本次结果。

**Given** 剪贴板或原子文件写入失败  
**When** 用户重试或切换目标  
**Then** 复用同一完整 artifact  
**And** 不改变 contentDigest、policy、revision 或 artifactId。

#### Story 5.5 真实 Webview 验证矩阵

OLD：

> 暗色、亮色、高对比、200% 字号、减少动态效果或窄宽度时，图/列表、焦点、屏幕阅读器和响应式通过；没有固定宽度、宿主版本与证据字段组合。

NEW：

**Given** VS Code 1.125.0、最新稳定版和前一稳定版  
**When** 运行真实 Webview 候选矩阵  
**Then** 自动覆盖暗色、亮色、高对比，100%/200% 字号，1024/899/599 CSS px 编辑区和 359 CSS px 侧栏  
**And** 核心任务无关键动作裁切、无水平溢出、无信息重叠、焦点不丢失  
**And** 900/600/360 候选断点若校准变化，必须同步 UX、UX-DR36 和 Story AC。

**Given** 最新稳定版和真实辅助技术  
**When** 执行 Windows+NVDA、macOS+VoiceOver、Linux+Orca spot check  
**Then** 在高对比、200% 字号和仅键盘条件下可完成 Overview、Current Context、Findings、PR Summary 和 ExportPreview 核心任务  
**And** 证据记录 hostVersion、OS、theme、zoom、width、assistiveTech、焦点顺序、可访问性树或等价审计结果。

## 8. Story 依赖与追踪矩阵

### 8.1 新 Story 依赖

| Story | 必须依赖 | 直接解锁 |
| --- | --- | --- |
| 1.4 | 1.3 | 1.19 |
| 1.19 | 1.4 | 1.5、后续 Analyzer |
| 2.1 | Epic 1 | 2.10 |
| 2.10 | 2.1 | 2.2 |
| 2.8 | 2.7、Epic 1 增量基础 | 2.11 |
| 2.11 | 2.8 | 2.9、Epic 2 完成 |
| 4.8 | 4.4；呈现一致性复用 4.5/4.6 | 4.9 |
| 4.9 | 4.7、4.8 | Epic 4 完成 |
| 5.11 | 5.6–5.10 的候选与证据合同 | 5.12 |
| 5.12 | 5.11 | Beta+ Go/No-Go |

### 8.2 FR/NFR/AR/UX-DR 追踪

| Story | FR / SM / UJ | NFR | AR | UX-DR |
| --- | --- | --- | --- | --- |
| 1.4 | FR-1、FR-4、FR-5、FR-22 | 9、10、11 | 6、8、9、12、28 | N/A，CLI/服务状态由后续宿主消费 |
| 1.19 | FR-1、FR-5、FR-22 | 9、10、11、22 | 4、5、6、9、12、28 | N/A |
| 2.1 | FR-21、FR-22 | 8、13、27 | 19、21、28 | 1、19、20、37 |
| 2.10 | FR-21、FR-22 | 10、17、18、20 | 19 | 4、15、16、21、22、24、25、34–37 |
| 2.8 | FR-3、FR-22 | 5、9、10 | 4、5、12、13 | 后台状态由 2.11 验收 |
| 2.11 | FR-3、FR-22 | 5、8、10、17、20 | 11、20 | 6、15、23、27、30、32 |
| 4.8 | FR-16、FR-17、FR-20 | 12、21 | 18、22、28 | 17 |
| 4.9 | FR-20、FR-23 | 12、14、16、21 | 22、24、28 | 18、25 |
| 5.11 | SM-1、SM-6、SM-7、SM-8、UJ-5 | 以 manifest 引用适用 NFR | 29、30、32 | 以任务和 evidence 引用适用 UX-DR |
| 5.12 | FR-1–23、SM-1–8 | NFR-1–27 | 29–32 | 发布 manifest 逐项展开适用 UX-DR |

### 8.3 关键合同 → Story 双向映射

| 合同 | 最终 Story | Architecture / Guide | PRD / UX |
| --- | --- | --- | --- |
| 最小真实 CI | 1.1 | AD-28、Guide §3/§13 | epics AR-28 |
| provider + 规划追踪 | 1.3 | AD-28、Guide §13 | epics AR-28 |
| BuiltinIgnoreV1 / generation 0 | 1.4 | AD-14、AD-23、Guide §3/§4/§7 | FR-4、Addendum §4 |
| 确定性 rebuild / CAS | 1.19 | AD-3、AD-8、Guide §6/§7 | FR-1、FR-5 |
| BasicSymbolV1 | 1.6 | AD-27、Guide §8 | FR-2、Addendum §5.4 |
| BaseCycleProjectionV1 | 1.14 | AD-25、Guide §9 | FR-11 |
| Getting Started / Index Status | 2.10 | AD-10、AD-15 | UX-DR15/16/19/21/22/24 |
| 增量 mutation | 2.8 | AD-3、AD-8、AD-23 | FR-3、NFR-5/9/10 |
| 原子视图 patch | 2.11 | AD-7、AD-22 | UX-DR6/23/27/30/32 |
| ImpactVerdictV1 / ImpactRankV1 | 4.4 | AD-26、Guide §12 | FR-17、UX-DR17 |
| CLI impact | 4.8 | AD-13、AD-26 | FR-16/17/20 |
| CLI export | 4.9 | AD-13、AD-18 | FR-20/23、UX-DR18 |
| ProductValidationPlanV1 | 5.11 | AD-30、Guide §13 | SM-1/6/7/8、UJ-5 |
| Beta+ Go/No-Go | 5.12 | AD-29、AD-30 | PRD §8/§9、ReadinessGateManifestV1 |

## 9. 风险、执行顺序与交接

### 9.1 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 新增 Story ID 与文档位置不按数值排序造成误读 | 中 | 明确“文档顺序 + 依赖字段”为权威；规划 gate 验证依赖 DAG |
| PRD、AD、AR、UX-DR 和 Story 双向追踪再次漂移 | 高 | Story 1.3 新增机器追踪 gate；最终 readiness 复评 |
| 用户研究阈值被实施时临场修改 | 高 | ProductValidationPlanV1 升版和 digest 绑定；旧证据自动 invalid |
| Beta 适用性与 Beta+ 全量门禁混用 | 中 | ReadinessGateManifestV1 区分 slice 与 phase |
| 生成失败仍可能复制部分内容 | 高 | AD-18、UX-DR18、Story 4.6/4.9 同时禁止 partial artifact |
| Webview 矩阵过大导致只做纸面验收 | 中 | 首切片建立基础证据，Story 5.5 在候选上复验，证据 schema 固定 |
| 历史报告中的旧编号被误当规范 | 低 | dated reports 标记为 evidence-only，不回写 |

### 9.2 获批后的执行顺序

1. Solution Architect 更新 Architecture Spine：AD-18、AD-28、新 AD-30、Capability Map。
2. Solution Architect 更新 Implementation Guide：阶段 A、映射、SQLite、验证、CI 和完成定义。
3. Product Manager / Product Owner 更新 PRD 与 Addendum：术语、AD-25 语义、SM 和发布适用性。
4. UX Designer 更新 EXPERIENCE 与 DESIGN：artifact、可访问性、快捷键、断点和 Webview 矩阵。
5. Product Owner 更新 epics.md：Story 1.1/1.3、四组拆分、Story 5.11/5.12、依赖和追踪。
6. Test Architect 审核 ProductValidationPlanV1、ReadinessGateManifestV1 和证据 schema 的可执行性。
7. 执行相对路径、Story 引用、FR/NFR/SM/AR/UX-DR/AD 双向追踪与依赖 DAG 检查。
8. 重新运行 Implementation Readiness。
9. 只有结果为 READY 后，才允许从 Story 1.1 开始实施；本次不修改代码。

### 9.3 交接对象

| 角色 | 责任 |
| --- | --- |
| Product Manager / Product Owner | PRD、Addendum、Epic/Story、ID、依赖、FR/SM 追踪和 Backlog |
| Solution Architect | AD-18、AD-28、AD-30、Guide 映射、CI 顺序和版本化合同 |
| UX Designer | ExportPreview、可访问性、快捷键、响应式与真实 Webview 验收 |
| Test Architect / QA | SM-1/6/7/8、UJ-5 task/fixture/evidence schema、剔除规则和阈值 |
| Release Owner | ReadinessGateManifestV1、candidateRef、证据集合与 Go/No-Go |
| Developer | READY 后按新依赖顺序实施；审批和规划复评前不改代码 |

## 10. 获批后应调用的 BMad 技能

建议按以下顺序调用，不并行修改同一制品：

1. bmad-architecture：以 update intent 修订 Architecture Spine 与 Implementation Guide。
2. bmad-prd：以 update intent 修订 PRD 与 Addendum，保持 FR-1 至 FR-23 稳定。
3. bmad-ux：修订 UX Experience / Design 合同和验证矩阵。
4. bmad-create-epics-and-stories：按本提案更新 epics.md、拆分 Story、依赖和追踪。
5. bmad-testarch-test-design：如需把 ProductValidationPlanV1 与 fixture/evidence schema 形成独立系统级验证计划，再调用该技能；不用于扩大 MVP。
6. bmad-check-implementation-readiness：所有规划制品更新后重新评估，目标状态为 READY。

如果已有 sprint-status.yaml，再在规划获批并完成 Story 更新后调用 bmad-sprint-planning 同步新增 Story；当前仓库未发现 sprint-status.yaml，因此本提案不修改 Sprint 状态文件。

## 11. 成功标准

本纠偏完成需要同时满足：

- AD-28、Guide、Story 1.1 和 Story 1.3 的 CI 顺序与完成定义完全一致。
- Guide 的 5 处 Story 映射修正，规划追踪 gate 可检测未来漂移。
- Story 1.4、2.1、2.8、4.8 拆为可独立验收的端到端用户价值 Story。
- Story 总数为 61，依赖 DAG 无循环、无前向能力依赖。
- FR-1 至 FR-23 编号和能力范围不变，覆盖仍为 100%。
- SM-1、SM-6、SM-7、SM-8 和 UJ-5 均有版本化 task/fixture/ground truth/evidence/threshold。
- Beta/Beta+ 适用性由机器可读 manifest 唯一决定。
- 生成失败不能复制部分 PR 摘要；只有完整 immutable artifact 可复制或写出。
- WCAG 2.2 AA 和 24×24 CSS px 不再带 ASSUMPTION。
- PRD 包含 AD-25 的依赖强度、热点、循环、聚合和稳定排序语义。
- 目录、模块、workspace package 定义唯一，references 明确不进入 MVP。
- 快捷键、断点和真实 Webview 验收矩阵可执行。
- 最终 Implementation Readiness 结果为 READY。

## 12. Correct Course 检查表状态

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 1.1 触发 Story | N/A | 由 readiness 复评触发 |
| 1.2 核心问题 | Done | 规划同步、Story 规模和验证 oracle |
| 1.3 支持证据 | Done | 以 2026-07-16 rerun 报告和当前源制品为证据 |
| 2.1 当前 Epic | N/A | 非单 Epic 触发 |
| 2.2 Epic 级变更 | Done | 保留 5 Epic，内部直接调整 |
| 2.3 未来 Epic 影响 | Done | Epic 1、2、4、5 直接；Epic 3 仅 SM-6 验证 |
| 2.4 新增/废弃 Epic | N/A | 无 |
| 2.5 Epic 顺序 | Done | 不变 |
| 3.1 PRD 冲突 | Action-needed | 本提案 §5，待审批实施 |
| 3.2 Architecture 冲突 | Action-needed | 本提案 §4，待审批实施 |
| 3.3 UX 冲突 | Action-needed | 本提案 §6，待审批实施 |
| 3.4 其他制品 | Action-needed | epics.md 与未来 gate manifest |
| 4.1 Direct Adjustment | Viable | 推荐 |
| 4.2 Rollback | Not viable / N/A | 无实施成果需回滚 |
| 4.3 MVP Review | Not required | MVP 可达且范围稳定 |
| 4.4 推荐路径 | Done | Direct Adjustment |
| 5.1 Issue Summary | Done | §1 |
| 5.2 Impact | Done | §2 |
| 5.3 Path Forward | Done | §3 |
| 5.4 MVP 与行动计划 | Done | §3、§9 |
| 5.5 Handoff | Done | §9、§10 |
| 6.1 Checklist Review | Done | 所有适用项已记录 |
| 6.2 Proposal Accuracy | Done | 已对照当前源制品 |
| 6.3 User Approval | Done | Shiqw 于 2026-07-16T11:09:00+08:00 明确 approve |
| 6.4 sprint-status.yaml | N/A | 当前未发现该文件，且审批前不修改 |
| 6.5 Next Steps | Done | §9、§10 |

## 13. 审批记录

- 审批结论：approve。
- 审批人：Shiqw。
- 审批时间：2026-07-16T11:09:00+08:00。
- 生效范围：批准按本提案更新 PRD、PRD Addendum、UX、Architecture、Implementation Guide 与 Epics/Stories。
- 不包含：代码修改、MCP、云协作、跨仓库 federation、新语言或生产环境操作。

## 14. Implementation Handoff Log

- Change trigger：implementation-readiness-report-2026-07-16-rerun.md 为 NEEDS WORK。
- Change scope：Moderate。
- Correct Course 产出：已批准 Sprint Change Proposal、逐制品 OLD → NEW、Story 拆分与追踪矩阵、执行与交接顺序。
- 本工作流实际修改：仅本提案文件状态与审批记录；原始规划制品和代码尚未修改。
- Routed to：Product Manager / Product Owner、Solution Architect、UX Designer、Test Architect / QA、Release Owner。
- 下一步：按 §10 的技能顺序更新规划制品，完成一致性检查后重新运行 Implementation Readiness；只有达到 READY 才进入代码实施。
