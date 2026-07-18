---
title: Sprint 变更提案：实施就绪纠偏
project: bmad
date: 2026-07-15
status: 已批准
changeScope: Moderate
trigger:
  document: implementation-readiness-report-2026-07-14.md
  assessmentStatus: NOT_READY
reviewMode:
  initial: incremental
  remaining: batch
---

# Sprint 变更提案：实施就绪纠偏

## 1. 问题摘要

### 1.1 触发背景

2026-07-14 的实施就绪评估结论为 NOT_READY。评估确认 PRD、UX、架构和需求覆盖基础成熟，23 条功能需求均有实施路径，产品愿景、MVP 范围和总体架构不需要推倒重来。

当前阻塞集中在执行合同和 Backlog 质量：

- Story 4.7 已达到发布 Epic 规模。
- Story 2.7 把可访问性和响应式设计集中为末尾硬化工作。
- Story 1.7、1.8、2.1、3.4 跨越多个独立失败域。
- Overview 的依赖强度、热点和 impact verdict 缺少确定性合同。
- 早期 CI 门禁没有明确实施归属。
- PRD、Architecture、UX 和 Epics 之间仍有若干术语、状态和编号漂移。

本次变更不是由单一实施 Story 失败触发，而是由实施就绪审查在进入全面 Story 执行前发现。因此，检查表中的“触发 Story”记为不适用，实施就绪报告作为主要证据。

### 1.2 核心问题

当前规划可以描述“要做什么”，但部分执行单元无法可靠估算、排序和独立验收；部分派生结论会因客户端或实现人员理解不同而产生不一致。若直接进入全面实施，主要风险是：

- 大型 Story 长时间无法完成，真实进度不可见。
- 可访问性、CI、跨平台和恢复能力被推迟到项目末期。
- VS Code、CLI 和 Markdown 对相同输入产生不同结论。
- PRD、UX、架构与 Story 验收标准继续分叉。

### 1.3 证据

- 实施就绪状态：NOT_READY。
- 评估记录 16 项问题或待关闭事项，其中 2 项为严重 Story 结构问题。
- 原 Epic 文档包含 4 个 Epic、28 个 Story；18 个 Story 含至少 10 个 Given 场景，14 个 Story 达到或超过 75 行。
- Story 4.7 同时覆盖 CLI、平台 VSIX、原生 ABI、升降级、兼容矩阵、产物审计和发布 CI。
- Story 2.7 同时承担实现补齐和系统级验收，违反“可访问性进入首批验收”的架构约束。

## 2. 影响分析

### 2.1 Epic 影响

| Epic | 影响 | 处理 |
| --- | --- | --- |
| Epic 1 | 状态恢复、缓存隐私、遥测和 CI 职责过载 | 拆分 Story 1.7、1.8；新增 1.9、1.10；Story 1.1 建立 CI |
| Epic 2 | Story 2.1 与 2.7 过载；Overview 指标不确定 | 新增 2.8；质量要求下沉；新增 OverviewMetricV1 |
| Epic 3 | Story 3.4 混合领域状态和增量并发 | 拆为生命周期与增量一致性 Story，并重排编号 |
| Epic 4 | 发布交付混入结构审查 Epic；impact 判定不确定 | 移除 4.7；新增 ImpactVerdictV1 |
| Epic 5 | 原规划不存在 | 新增“可安装、可升级、可离线交付”发布 Epic |

调整后自然依赖为 Epic 1 → Epic 2 → Epic 3 → Epic 4 → Epic 5。

### 2.2 Story 影响

原规划为 28 个 Story。调整后为 5 个 Epic、36 个 Story：

- Epic 1：10 个 Story。
- Epic 2：8 个 Story。
- Epic 3：7 个 Story。
- Epic 4：6 个 Story。
- Epic 5：5 个 Story。

Story 数增加不代表产品范围扩大，而是把原本隐藏在大型 Story 中的交付、恢复、安全和验证工作显式化。

### 2.3 PRD 影响

需要修改：

- FR-4：命名并定义 .codegraphignore 的索引排除职责。
- FR-12：明确 rules.yaml 的 ignore 只影响规则评估。
- SM-4：用版本化标注语料和 precision/recall/F1 定义验收口径。
- 基础符号范围：增加 BasicSymbolV1 边界。
- Addendum：把“待架构确认”更新为“架构处置结果”。

MVP 目标、用户旅程、功能范围和发布切片不变。

### 2.4 Architecture 影响

新增或补充以下架构合同：

- AD-25：OverviewMetricV1。
- AD-26：ImpactVerdictV1。
- AD-27：BasicSymbolV1。
- AD-27 交付门禁条款补充能力首次落地时的 CI 归属；若与现有编号冲突，实施编辑时使用下一个可用 AD 编号。
- Implementation Guide 同步查询指标、impact 判定、准确率语料和门禁扩展时点。

注：当前 Architecture Spine 的最后正式决策为 AD-24；最终编辑时应使用连续编号，并避免与 Epics 中的 AR-27 混淆。

### 2.5 UX 影响

需要关闭四项源契约歧义：

- 产品语言与国际化范围。
- ContextLock 的当前会话边界。
- 未信任工作区状态。
- Node built-in 的视觉和文本语义。

首个 Webview 切片还必须提供真实 VS Code 主题、字号、窄宽度和高对比视觉证据。无需把独立 mockup 设为实施前置条件。

### 2.6 技术与交付影响

- CI 从 Story 1.1 起建立，并随能力出现增量扩展。
- 平台打包、兼容、升降级和产物审计移入 Epic 5。
- 实施前增加一次规划修订和 Implementation Readiness 复评。
- 当前没有 sprint-status.yaml，因此本次不修改 Sprint 状态文件。

## 3. 推荐路径

### 3.1 选项评估

| 选项 | 可行性 | 工作量 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| 直接调整现有规划 | 可行 | 中 | 中 | 推荐 |
| 回滚已完成工作 | 不适用 | 高 | 中 | 当前尚无需要回滚的实施成果 |
| 缩减或重定义 MVP | 可行但无必要 | 中 | 高 | 产品方向和范围没有被否定 |

### 3.2 推荐方案

采用“直接调整 + 新增发布 Epic”：

1. 不改变产品愿景和 MVP 功能范围。
2. 拆分超载 Story，新增 Epic 5。
3. 补齐确定性指标、判定和基础符号合同。
4. 关闭 PRD、UX、架构和 Epics 的文档漂移。
5. 建立早期 CI。
6. 修订完成后重新运行 Implementation Readiness。

### 3.3 时间与风险

- 规划影响：增加一个完整的文档修订与复评周期。
- 实施影响：总产品工作量原则上不增加，但原先隐藏的打包、恢复、兼容和验证工作会获得独立估算。
- 主要风险：文档交叉引用遗漏、Story 重编号漂移、合同只写入架构但未进入 AC。
- 缓解：使用统一编号检查、逐制品变更清单和 READY 复评门禁。

## 4. 详细变更提案

### 4.1 Epic 4 与新 Epic 5

旧：

Story 4.7“安装并离线运行跨平台 MVP”同时负责 CLI 发布、平台 VSIX、运行时与 SQLite ABI、升降级、兼容、隐私验证、产物审计和发布 CI。

新：

- 从 Epic 4 删除 Story 4.7。
- 新增 Epic 5“可安装、可升级、可离线交付项目代码图谱”。
- Story 5.1：安装并离线运行 CLI。
- Story 5.2：安装平台特定的 VS Code 扩展。
- Story 5.3：安全升级、降级并恢复本地图谱缓存。
- Story 5.4：验证平台与 VS Code 兼容矩阵。
- Story 5.5：审计并发布可复现的候选产物。

理由：每个 Story 对应独立所有者、失败域和验收环境；Epic 4 恢复为结构审查与导出的单一用户价值。

### 4.2 Story 2.7 可访问性与响应式重构

旧：

Story 2.7 同时负责图/列表等价、键盘、屏幕阅读器、主题、WCAG、减少动态效果、目标尺寸、响应式实现和多版本验收。

新：

- 可访问性、主题和响应式 AC 分别下沉到 Story 2.1–2.6。
- Story 2.7 改名为“验证端到端可访问性与响应式体验”。
- Story 2.7 只负责系统级键盘、屏幕阅读器、高对比、减少动态效果、200% 字号、多宽度和多 VS Code 版本回归。
- Story 2.7 不负责补做前序 Story 遗漏的实现。

理由：横切质量成为每个功能切片的完成条件。

### 4.3 OverviewMetricV1

旧：

依赖强度、热点、排序、并列和 partial/stale 语义未定义。

新：

- dependencyStrength 等于源聚合节点与目标聚合节点之间不同 high-confidence 文件级 imports 规范边数量。
- 同一规范边的多条 Evidence 只计一次。
- 热点排序依次使用 active error 数、active warning 数、循环成员数、内部依赖强度总和、规范节点 ID。
- current + complete 才显示正式排名。
- stale 显示“可能过期”，partial 显示“基于部分结果”，均不显示正式排名徽标。
- 完整范围内先排名，再执行展示截断。
- rankingVersion 固定为 overview-metric-v1，并进入 queryFingerprint。

理由：Overview 可解释、可测试，并在 CLI 与 VS Code 中保持一致。

### 4.4 ImpactVerdictV1

旧：

verdict、majorRisks、keyPaths 和建议复查文件只有字段要求，没有统一判定与排序。

新：

判定枚举：

- pass：完整分析中没有新增 error、warning 或循环。
- review：存在新增 warning 或新增循环。
- block：存在权威的 new + active + error Finding。
- unknown：不存在明确 error，但受影响范围 partial/stale、配置无效、比较 not-applicable 或影响计算不完整。

附加规则：

- 已有风险默认不改变 verdict。
- resolved 不导致失败。
- 展示截断不改变 verdict；计算范围不完整才产生 unknown。
- 已确认新增 error 时仍返回 block，同时标记覆盖不完整。
- majorRisks 和 keyPaths 使用统一稳定排序。
- Story 4.2 生成合同；4.3、4.4、4.6 只消费和呈现。

理由：相同输入在 IDE、CLI 和 Markdown 中产生相同结论。

### 4.5 Story 1.1 的 CI 基线

旧：

Story 1.1 只要求本地根命令成功，自动化 CI 到发布阶段才有明确归属。

新：

- Story 1.1 建立类型、lint、单元、构建、契约、依赖边界和基础安全 CI。
- Story 1.2 增加 SQLite 与确定性重建门禁。
- Story 1.6 增加 CLI JSON、stdout/stderr 和退出码门禁。
- Story 2.1 增加 VS Code、Workspace Trust 和 CSP 冒烟。
- Story 3.1、3.6 增加 Rules 和 check 门禁。
- Story 4.6 增加 impact/export 合同和隐私门禁。
- Story 5.5 只负责跨平台、性能、兼容、升降级和产物审计。
- 尚未实现的能力不得使用空测试占位；能力首次落地的 Story 必须同时接入门禁。

### 4.6 Story 1.7 与恢复职责

旧：

Story 1.7 混合状态代数、Job、取消、Watcher、SQLite、服务重连、空闲退出、升级和安全限制。

新：

- Story 1.7 改为“查看图谱状态并安全取消索引”，只负责状态、进度、取消和缓存保留。
- 新增 Story 1.9“从损坏缓存和服务中断中恢复”，负责 SQLite 故障副本、重建、重连、旧 metadata 和 epoch 恢复。
- Watcher 对账归 Story 2.6。
- 空闲退出、升级交接归 Story 5.3。
- 安全硬限制归 Story 1.1、1.6 和架构全局门禁。

### 4.7 Story 1.8 与遥测职责

旧：

Story 1.8 混合磁盘权限、缓存清理、日志、遥测状态机、多客户端竞争和离线验证。

新：

- Story 1.8 改为“管理本地图谱缓存与诊断数据”。
- 新增 Story 1.10“控制遥测并验证默认离线隐私”。
- Story 1.8 负责缓存位置、权限、日志脱敏、轮转、cache path 和安全 clear。
- Story 1.10 负责 Noop 默认、显式 opt-in、立即关闭、latest-wins、字段白名单和断网测试。

### 4.8 Story 2.1 与遥测设置界面

旧：

Story 2.1 同时负责启动、Trust、索引状态、monorepo、遥测 UI、状态时钟、surface 分工、CSP 和主题。

新：

- Story 2.1 保留可信启动、Workspace Trust、Getting Started、Index Status、monorepo、ServiceStatusV1、surface 职责和 Webview 安全。
- 新增 Story 2.8“在 VS Code 中查看并控制遥测状态”，依赖 Story 1.10。
- 全局主题和可访问性要求按功能 Story 下沉。
- 语言与国际化由 UX 主合同统一决定。

### 4.9 Story 3.4 与增量一致性

旧：

Story 3.4 混合 Finding 状态、比较、受影响范围、原子提交、无效配置、CAS、规则热更新和性能。

新：

- Story 3.4：“维护 Finding 身份与生命周期”。
- Story 3.5：“增量重评受影响规则并保证提交一致性”。
- 原 Story 3.5 顺延为 3.6“在 VS Code 中查看并修复 Findings”。
- 原 Story 3.6 顺延为 3.7“使用 CLI 执行规则检查”。
- Story 3.4 负责 active/resolved/stale、first/last seen、稳定 ID 和比较语义。
- Story 3.5 负责受影响范围、原子提交、CAS、无效配置、规则热更新和 2 秒门禁。

### 4.10 PRD 排除职责与 BasicSymbolV1

旧：

FR-4 未命名额外排除文件；rules.yaml ignore 与索引排除的职责可能混淆；基础符号范围未定义。

新：

- .codegraphignore 控制索引范围；命中路径不进入图谱、规则检查或成功指标。
- rules.yaml 的 ignore 只影响规则评估；图谱实体仍可查询并计入索引统计。
- BasicSymbolV1 只包含顶层且可寻址的 function、class、interface、type-alias、enum、variable、namespace。
- MVP 不提取局部变量、成员、调用图或 references。

### 4.11 SM-4 验收合同

旧：

“依赖识别准确率达到 80%”没有语料、口径和测量流程。

新：

- 使用版本化人工标注语料，至少 500 条声明。
- 覆盖 ESM、CJS、re-export、type-only、literal require、literal dynamic import、path alias、跨 package、Node built-in 和负样本。
- 规范依赖边 micro-F1 不低于 0.80。
- high-confidence 边 precision 不低于 0.90。
- 输出 precision、recall、F1、分类结果和失败样本。
- 标注争议必须人工复核并记录。

### 4.12 UX 契约

旧：

产品语言、ContextLock 会话、未信任工作区和 Node built-in 仍存在源文档歧义。

新：

- VS Code 人类可读界面支持 zh-CN 与 en，跟随 VS Code locale，未知 locale 回退 en。
- JSON、错误 code、状态枚举和 Schema 不本地化。
- ContextLock 只在当前 extension-host 会话保存；Webview reload 可恢复，窗口 reload、重启或重新打开工作区后清除。
- workspaceState 不保存固定状态。
- UX 主状态表增加未信任工作区状态与“管理 Workspace Trust”动作。
- Node built-in 使用“Node 内置模块”、node: 前缀、独立图标和不同轮廓，并提供图例、列表和屏幕阅读器语义。

### 4.13 文档一致性

旧：

PRD 使用 FR-1，Epics 使用 FR1；Addendum 保留已经由最终架构关闭的待确认项。

新：

- 全部规划文档统一为 FR-1…FR-23。
- CI 增加规划文档引用检查。
- Addendum 的“待架构确认”改为“架构处置结果”，逐项链接对应 AD 和实施指南。
- UX 假设标记为 ADOPTED 或 VALIDATION-PENDING，并记录负责 Story 与退出条件。
- 原实施就绪报告保持不变，作为本次变更触发证据。

## 5. 实施移交

### 5.1 范围分类

本次变更分类为 Moderate：

- 产品愿景和 MVP 不变。
- 需要重组 Backlog、增加一个 Epic、拆分 Story 并同步多份规划制品。
- 不需要基础方向重做或实施成果回滚。

### 5.2 接收角色与职责

| 角色 | 职责 |
| --- | --- |
| Product Owner / PM | 更新 PRD、Addendum、Epic、Story、覆盖矩阵和优先级 |
| Solution Architect | 增加 OverviewMetricV1、ImpactVerdictV1、BasicSymbolV1 和 CI 归属合同 |
| UX Designer | 更新 DESIGN、EXPERIENCE、状态表、语言、ContextLock 和 Node built-in |
| Developer | 在规划复评通过后从 Story 1.1 和最小 CI 开始实施 |
| Test Architect / QA | 建立 SM-4 标注语料、合同测试和重新执行 Implementation Readiness |

### 5.3 实施顺序

1. 更新 Architecture Spine 与 Implementation Guide。
2. 更新 PRD 与 Addendum。
3. 更新 UX Design 与 Experience。
4. 更新 epics.md、编号、覆盖关系和依赖。
5. 执行文档一致性检查。
6. 重新运行 Implementation Readiness。
7. 达到 READY 后批准 Phase 4 全面实施。

在 READY 前，仅允许 Story 1.1 的准备性地基工作，不并行启动其他 Epic。

### 5.4 成功标准

- 规划中存在 5 个 Epic、36 个可独立估算的 Story。
- Story 4.7 和原 Story 2.7 的严重结构问题清零。
- Story 不存在前向依赖或职责重复。
- OverviewMetricV1、ImpactVerdictV1、BasicSymbolV1 进入架构和对应 AC。
- FR 编号全部统一。
- UX 四项歧义关闭。
- 最小 CI 在 Story 1.1 有明确归属。
- SM-4 有可执行的语料和指标。
- 新一轮 Implementation Readiness 结果为 READY。

## 6. 检查表状态

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 1.1 触发 Story | N/A | 由实施就绪评估触发 |
| 1.2 核心问题 | Done | 执行拆分与合同缺口 |
| 1.3 支持证据 | Done | NOT_READY 报告与源文档对照 |
| 2.1 当前 Epic | N/A | 非单一 Epic 触发 |
| 2.2 Epic 级变更 | Action-needed | 新增 Epic 5 |
| 2.3 剩余 Epic 影响 | Done | Epic 1–4 均有修订 |
| 2.4 新 Epic 或失效 Epic | Done | 新增 Epic 5，无 Epic 失效 |
| 2.5 顺序与优先级 | Done | Epic 1→2→3→4→5 |
| 3.1 PRD 冲突 | Action-needed | FR-4、SM-4、BasicSymbol、Addendum |
| 3.2 Architecture 冲突 | Action-needed | 三个版本化合同与 CI |
| 3.3 UX 冲突 | Action-needed | 四项契约歧义 |
| 3.4 其他制品 | Action-needed | Epics、CI、测试；无 sprint-status |
| 4.1 直接调整 | Viable | 中工作量、中风险 |
| 4.2 回滚 | Not viable | 无需回滚 |
| 4.3 MVP Review | Viable but unnecessary | MVP 不缩减 |
| 4.4 推荐路径 | Done | 直接调整 + 新 Epic |
| 5.1–5.5 提案组成 | Done | 本文已覆盖 |
| 6.1 检查表复核 | Done | 所有 Action-needed 已进入提案 |
| 6.2 提案准确性 | Done | 用户已完成整案复核 |
| 6.3 用户最终批准 | Done | 2026-07-15 明确批准 |
| 6.4 sprint-status.yaml | N/A | 当前文件不存在 |
| 6.5 下一步与移交 | Done | 已按 Moderate 范围路由规划修订 |

## 7. 审批记录

- 增量提案 1–9：用户逐项批准。
- 剩余提案 10–15：用户批量批准。
- 完整 Sprint Change Proposal：用户于 2026-07-15 完成整案复核并明确批准。

## 8. 工作流执行与移交日志

### 8.1 执行记录

- 触发问题：实施就绪评估为 NOT_READY，执行拆分和确定性合同不足。
- 评审模式：先增量评审，再按用户要求切换为批量评审。
- 变更范围：Moderate。
- 产出：完整 Sprint Change Proposal、逐制品旧 → 新修改、实施移交计划。
- 最终批准：2026-07-15，已批准。

### 8.2 正式移交

- Product Owner / PM：负责更新 PRD、Addendum、epics.md、Story 编号、覆盖矩阵和 Backlog 顺序。
- Solution Architect：负责更新 Architecture Spine 与 Implementation Guide，落地 OverviewMetricV1、ImpactVerdictV1、BasicSymbolV1 和 CI 归属。
- UX Designer：负责更新 DESIGN.md 与 EXPERIENCE.md，关闭语言、ContextLock、Workspace Trust 和 Node built-in 契约。
- Test Architect / QA：负责 SM-4 标注语料、合同门禁和 Implementation Readiness 复评。
- Developer：在复评达到 READY 后，从 Story 1.1 和最小 CI 基线开始实施。

### 8.3 移交完成标准

- 所有规划源文档按本提案同步更新。
- 文档交叉引用和 FR 编号检查通过。
- 重新运行 Implementation Readiness，结果达到 READY。
- READY 前不并行启动其他 Epic。
