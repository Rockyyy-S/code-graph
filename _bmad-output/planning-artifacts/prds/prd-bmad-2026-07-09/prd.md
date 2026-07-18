---
title: 项目代码图谱 PRD
status: final
created: 2026-07-09
updated: 2026-07-16
---

# PRD：项目代码图谱

## 0. 文档目的

本文档面向产品、开发、UX、架构与后续 BMad 工作流所有者，定义“项目代码图谱”的产品边界、MVP 范围、核心用户旅程、功能需求、非功能需求、成功指标与开放问题。本文基于 `想法.md`、`_bmad-output/planning-artifacts/briefs/brief-bmad-2026-07-09/brief.md` 以及两份研究材料整理，不重复展开底层技术选型细节；技术约束与架构输入集中记录在 `addendum.md`。

本文采用稳定编号：用户旅程使用 `UJ-N`，功能需求使用 `FR-N`，非功能需求使用 `NFR-N`，成功指标使用 `SM-N`。未确认事项必须进入开放问题或审计日志，不能作为隐含前提进入后续设计与实现。

## 1. 愿景

项目代码图谱是一款面向开发者和技术团队的 IDE 内代码结构感知与影响分析工具。它不只是把代码“画成图”，而是在开发者打开文件、修改代码、审查 PR 或接手陌生模块时，持续回答一个实际问题：我正在看的代码位于什么结构中，它依赖谁，谁依赖它，本次改动是否会破坏模块边界。

项目的长期价值是把“结构理解”放回开发工作流现场。目录树只能说明文件放在哪里，搜索只能找到文本位置，静态文档经常滞后，PR diff 也难以展示结构变化。项目代码图谱要提供一个本地、可解释、可查询的代码结构事实层，让开发者、Tech Lead、架构师和 AI 编码工具都能围绕同一份结构事实协作。

第一阶段聚焦 VS Code + TypeScript/JavaScript 中大型项目，验证局部代码图谱是否能比目录树、搜索和过期文档更快帮助开发者判断结构影响。MVP 成功后，再扩展到团队级规则治理、CI/PR 集成、历史趋势和 MCP/AI 上下文服务。

MVP 阶段保留“项目代码图谱”作为产品工作名称，对外类别描述统一使用“IDE 原生的代码结构感知与影响分析工具”。产品介绍不得将其定位为单纯的代码图谱可视化工具。正式品牌命名不作为 MVP 的阻塞项；产品名称在首轮真实团队试用后再评估。

## 2. 目标用户

首批试用对象已确定为：使用 VS Code、维护中大型 TypeScript/JavaScript 项目的 5–15 人技术团队中的一线开发者和 Tech Lead。产品以个人本地安装切入，但必须在真实团队代码库中验证价值；同一试用团队应同时覆盖日常开发者和负责结构治理、PR 审查的 Tech Lead，以观察个人理解效率与团队架构治理价值。

首批试用不以企业采购、云端协作或组织级治理为前提。大型企业内部团队可作为后续验证对象，但其 SSO、审计、权限和私有部署需求不进入 MVP。

### 2.1 Jobs To Be Done

- 当我接手陌生代码库时，我想快速知道项目模块、入口和真实依赖关系，以便减少理解成本。
- 当我修改一个文件时，我想知道它依赖谁、谁依赖它、影响半径有多大，以便降低误改风险。
- 当我新增 import 或移动文件时，我想立即知道是否引入循环依赖、跨层依赖或目录边界违规，以便在问题扩散前修正。
- 当我审查 PR 时，我想看到结构变化摘要，而不只是文件 diff，以便更快判断改动是否破坏架构约束。
- 当团队使用 AI 编码时，我想给 AI 提供当前文件附近的结构边界和相关上下文，以便减少越界修改。

### 2.2 非目标用户（v1）

- 需要开箱即用支持多语言、多仓库、云端团队协作的大型企业治理团队。
- 主要寻找精准运行时调用图、数据流分析、安全审计或 CPG 深度分析的用户。
- 只需要一次性生成漂亮全局大图、但不会在 IDE 或 PR 流程中持续使用的用户。
- 不使用 VS Code、且第一阶段不愿通过 CLI 试用的开发者。

### 2.3 关键用户旅程

- **UJ-1. 新加入的开发者理解项目结构。**
  - **Persona + context:** 林，刚接手一个中大型 TypeScript 项目，需要在当天修一个模块缺陷。
  - **Entry state:** 林在 VS Code 中打开项目，尚不了解目录职责与模块边界。
  - **Path:** 插件检测到工作区；林执行首次 rebuild；系统生成项目结构概览；林看到目录之间的依赖强度、循环风险和热点模块；林点击目标目录查看聚合后的文件依赖。
  - **Climax:** 林能说清目标模块的上游、下游和主要边界风险。
  - **Resolution:** 林进入具体文件，继续用当前文件邻域图定位修改范围。

- **UJ-2. 日常开发者判断当前文件影响范围。**
  - **Persona + context:** May，正在修改一个前端状态管理文件，担心影响多个页面。
  - **Entry state:** May 已在 VS Code 中打开目标文件，图谱缓存存在但可能过期。
  - **Path:** 插件自动聚焦当前文件；系统先显示缓存邻域图并标记刷新状态；后台更新后展示直接依赖、反向依赖和同目录相关文件；May 展开一个上游模块并固定当前视图，避免切换文件时丢失上下文。
  - **Climax:** May 在 3 分钟内判断“改这个文件会影响哪里”。
  - **Resolution:** May 将修改范围限制在相关模块，并记录需要回归验证的页面。
  - **Edge case:** 如果邻域节点超过预算，系统折叠为 directory 或 recognized workspace-package 聚合节点，而不是渲染不可读的大图。

- **UJ-3. 开发者保存代码后发现结构违规。**
  - **Persona + context:** Alex 在业务层新增一个 import，未意识到它跨过了约定的分层边界。
  - **Entry state:** 工作区已有 `.codegraph/rules.yaml`，开启保存后增量更新。
  - **Path:** Alex 保存文件；系统等待文件变化稳定后增量解析；图谱服务识别新增依赖边；规则引擎发现该边违反层级约束；插件在 findings 面板展示违规路径、规则名和相关文件。
  - **Climax:** Alex 明确知道是哪条新增依赖边触发了风险。
  - **Resolution:** Alex 修改依赖方向或将规则例外留待 Tech Lead 确认。

- **UJ-4. Tech Lead 审查 PR 结构影响。**
  - **Persona + context:** Chen 是团队 Tech Lead，需要审查一个涉及多个目录的 PR。
  - **Entry state:** 本地分支已拉取，CLI 可读取 git diff。
  - **Path:** Chen 运行 CLI 生成结构影响摘要；系统列出新增/删除依赖边、受影响目录、循环依赖变化和规则违规；系统输出 Markdown 摘要，可贴入 PR review。
  - **Climax:** Chen 在审查前就知道本次改动是否扩大了模块耦合。
  - **Resolution:** Chen 对结构风险提出 review 意见，或确认 PR 没有破坏边界。

- **UJ-5. AI 编码重度用户导出局部结构上下文。**
  - **Persona + context:** Wen 经常让 AI agent 修改代码，但担心 agent 改到不该碰的模块。
  - **Entry state:** Wen 已打开目标文件的局部图谱。
  - **Path:** Wen 导出当前文件邻域、模块边界和规则 findings 的结构上下文；将其作为 AI 修改任务的约束输入。
  - **Climax:** AI 任务有明确的相关文件、禁止跨越的边界和影响范围。
  - **Resolution:** Wen 后续仍通过图谱和规则检查验证 AI 修改是否越界。
  - **Scope note:** MCP server 不进入 MVP 主路径；MVP 提供可导出的本地上下文和 CLI 输出，MCP server 作为核心体验验证后的 v1.1 候选能力。
  - **Value gate:** UJ-5 使用版本化的 `UJ5ExportValueTaskV1`。至少 8 名有效的 AI 编码重度用户，覆盖至少 3 个真实 TS/JS 仓库和 2 个独立团队，必须完成固定的边界敏感任务：生成 `structure-only` 导出、指出允许修改范围和至少一条禁止跨越的边界、将 artifact 用作 AI 任务约束，并在候选修改后运行 check/impact 复核。至少 75% 的有效参与者必须正确识别目标范围与禁止边界，且对“该导出实质性澄清了 AI 任务的允许范围和结构约束”评分达到 4/5 或以上；任何源码、绝对路径或未授权内容泄露均使门禁失败。该门禁只决定是否允许启动 v1.1/MCP 候选，不扩大 MVP。

## 3. 术语表

- **项目代码图谱** — 从工作区源码中提取目录、文件、符号、包和依赖关系后形成的可查询结构模型。
- **工作区** — 用户在 VS Code 或 CLI 中打开的代码仓库或项目根目录。
- **图谱服务** — 本地运行的索引、存储、查询和规则检查服务；VS Code 插件是其客户端。
- **目录** — 由工作区相对路径形成的物理层级；在项目结构概览中按 `scopeRoot` 和 `aggregationDepth` 投影为叶子聚合。
- **workspace package** — 由有效 npm/Yarn workspace 或 `pnpm-workspace.yaml` 识别出的最深 package root；workspace discovery 为 degraded 时不得生成该类型或跨 package 结论。
- **模块** — 用户可见的逻辑聚合称谓，不是第三种持久实体。MVP 中模块必须明确映射为 directory 投影叶子或 recognized workspace package；界面和导出必须同时携带 `groupBy` 与规范 ID。
- **节点** — 图谱中的规范实体，包括目录、文件、基础符号、外部包、规则和 Finding 等；聚合节点是查询视图，不是新的持久实体类型。
- **边** — MVP 规范关系包括 `contains`、`imports`、`exports` 和派生 `depends_on`；Finding 可以引用 `violates` 语义。`references` 不在 MVP 生成，不得进入导航、导出、成功指标或发布声明。
- **邻域图** — 围绕当前文件、目录或变更集合按预算生成的局部子图。
- **项目结构概览** — 使用 `ProjectionMembershipV1` 在 directory 或 workspace-package 二选一投影上展示依赖、循环和热点；同一文件在单次查询中只属于一个叶子聚合，不等同于普通目录树。
- **结构影响摘要** — 根据当前文件、保存变更或 git diff 输出的新增依赖、受影响节点、循环依赖和规则违规摘要。
- **架构规则** — 用户配置的结构约束，例如禁止目录引用、层级依赖方向、循环依赖阈值。
- **Finding** — 图谱服务发现的结构风险或规则违规，包含严重级别、触发规则、相关边和可定位文件。
- **稳定 ID** — 可重建、不依赖数据库自增主键的节点或边标识。
- **来源与置信度** — 每条边的检测来源和可信程度，例如 Tree-sitter、LSP、启发式、未来 SCIP。
- **图谱预算** — 对查询和渲染返回的最大节点数、边数、深度或布局成本限制。

## 4. 功能需求

### 4.1 本地图谱索引与存储

**Description:** 用户可以在本地为 VS Code 工作区生成代码结构图谱。系统优先支持 TypeScript/JavaScript 单包项目与常见 monorepo，提取目录、文件、workspace package、import/export、包依赖和基础符号信息。图谱默认只存储在本地，不上传源码或图谱数据。当前实现合同以 `addendum.md` 第 3 节及已采用的 Architecture Spine 为准；PRD 主体只定义产品能力、边界和可测试结果。

#### FR-1：初始化工作区图谱

用户可以通过 VS Code 命令或 CLI 对当前工作区执行首次图谱构建。实现 UJ-1。

**Consequences（可测试）:**
- 当用户在受支持工作区执行初始化时，系统生成可查询的项目代码图谱。
- 系统识别常见 npm、Yarn 与 pnpm workspace package 边界；无法识别时仍可退化为普通单工作区索引。
- 当工作区缺少受支持语言文件时，系统给出空状态和可操作提示，而不是报错退出。
- 初始化结果包含图谱生成时间、索引文件数、节点数、边数和排除路径摘要。

#### FR-2：提取 TypeScript/JavaScript 依赖关系

系统必须提取 TypeScript/JavaScript 文件之间的 import/export 关系和外部包依赖。实现 UJ-1、UJ-2。

**Consequences（可测试）:**
- 系统能识别 ES module import/export、常见 TypeScript path alias、package import。
- 在 monorepo 中，系统能识别跨 workspace package 的 TS/JS import，并将文件级证据聚合为 package 依赖边。
- 每条依赖边记录来源、置信度、语言、文件范围和最后检测时间。
- 对无法确定的动态依赖，系统不得伪装成精确依赖；必须标记为低置信或暂不纳入。
- `BasicSymbolV1` 只提取 TypeScript/JavaScript 源文件顶层且具有稳定名称与可导航范围的 `function`、`class`、`interface`、`type-alias`、`enum`、`variable`、`namespace`。
- MVP 不提取成员、参数、局部变量、import alias、匿名声明、调用图或 references；这些对象不得进入符号导航、结构导出或成功指标。

#### FR-3：保存后增量更新

用户保存受支持文件后，系统在本地增量更新相关图谱数据。实现 UJ-2、UJ-3。

**Consequences（可测试）:**
- 系统对保存事件进行 debounce 或 settle 处理，避免 git pull、分支切换或批量生成文件时频繁重建。
- 内容 hash 未变化时，系统不得重复解析同一文件。
- 增量更新完成后，当前视图显示最新状态或明确标记仍为 stale。

#### FR-4：路径排除与噪声控制

用户可以通过内置安全默认项和工作区根目录的 `.codegraphignore` 排除依赖目录、构建产物、生成代码和自定义路径，防止图谱污染。实现 UJ-1、UJ-2。

**Consequences（可测试）:**
- 系统从首次 rebuild 和首次 Analyzer 运行前即应用内置安全默认排除；即使 `.codegraphignore` 不存在，也必须提供包含内置规则的有效 generation 0 排除快照。
- 用户通过 `.codegraphignore` 声明额外排除或显式重新纳入路径；配置的有效快照、无效诊断和 last-valid 回退由本地图谱服务统一管理。
- 命中有效索引排除规则的路径不产生节点、边或 Evidence，不参与 workspace package 聚合、规则检查或成功指标统计。
- `.codegraphignore` 重新纳入路径后，系统沿用原确定性 ID，不把同一实体误识别为新对象。

#### FR-5：图谱版本、稳定 ID 与过期状态

系统必须为图谱 schema、节点、边和索引状态提供稳定标识与版本信息。

**Consequences（可测试）:**
- 节点和边 ID 不依赖数据库自增主键。
- 图谱数据包含 schema version，旧版本数据可触发迁移或重建提示。
- 当源文件变化但索引未完成时，系统显示 stale 状态。

### 4.2 IDE 内结构视图

**Description:** VS Code 插件在开发者实际阅读和修改代码的位置展示结构信息。MVP 不默认渲染全量大图，而是按用户当前聚焦层级展示项目概览、目录聚合或当前文件邻域图。

#### FR-6：项目结构概览

用户打开工作区后，可以查看 directory 或 recognized workspace-package 投影之间的真实依赖概览。实现 UJ-1。

**Consequences（可测试）:**
- 概览使用 `ProjectionMembershipV1` 在 `directory` 或 `workspace-package` 中选择一种 `groupBy`；同一文件在单次查询中只属于一个叶子聚合，禁止向祖先重复累计。
- 概览展示依赖方向、`dependencyStrength`、`cycleMemberCount`、热点排序、完整性和图谱更新时间。
- `dependencyStrength` 等于两个叶子聚合之间不同 high-confidence 文件级 `imports` 规范边数量，同一规范边的多条 Evidence 只计一次；`internalDependencyStrength` 等于与其他内部聚合的入向与出向强度总和。
- 热点按 active error、active warning、`cycleMemberCount`、`internalDependencyStrength` 降序，再按规范 node ID 升序；只有 `freshness=current` 且 `completeness=complete` 时显示正式排名，stale 或 partial 只能显示带限制说明的非正式结果。
- 基础循环由不读取 `rules.yaml` 的统一 `CycleProjectionKernelV1` 计算。
- 用户可以从聚合节点下钻到相关文件或预算内局部邻域。

#### FR-7：当前文件邻域图

用户打开代码文件时，系统自动展示当前文件的依赖邻域。实现 UJ-2。

**Consequences（可测试）:**
- 邻域图至少区分当前文件、直接依赖、反向依赖和外部包。
- 默认展示 1 跳关系，单次查询和渲染预算上限为 100 个节点、200 条边。
- 当候选节点或边超过预算时，服务端先在完整候选范围内按焦点距离、关系角色、置信度和规范 node ID 的稳定 tie-break 排序，再截断或折叠为 directory 或 recognized workspace-package 聚合。
- `scopeRoot`、`groupBy`、`aggregationDepth` 与 `membershipDigest` 必须进入 query identity；同一输入、revision 和配置产生相同顺序。
- 用户展开聚合时创建新的预算内局部查询，不在客户端无上限追加全局图。

#### FR-8：聚焦追踪与视图固定

系统可以跟随用户当前文件切换更新图谱，也允许用户固定当前视图。实现 UJ-2。

**Consequences（可测试）:**
- 用户切换文件时，默认图谱聚焦新文件。
- 用户启用固定后，切换文件不会替换当前图谱。
- 固定状态在当前 VS Code 会话中可见且可解除。

#### FR-9：节点导航与上下文操作

用户可以从图谱节点跳转到文件、目录或符号位置。实现 UJ-1、UJ-2。

**Consequences（可测试）:**
- 点击文件节点可在 VS Code 中打开对应文件。
- 节点详情展示路径、类型、入边、出边、更新时间和 findings。
- 当节点对应文件不存在或已移动时，系统提示重新索引。

#### FR-10：多视图基础能力

MVP 至少提供局部关系图和结构列表两种呈现方式；大图场景不得只依赖力导向图。

**Consequences（可测试）:**
- 当前文件邻域可用图形方式探索。
- findings、循环依赖和 PR 摘要可用列表或表格方式阅读。
- 对键盘用户或无法理解图形的用户，核心信息有文本替代呈现。

### 4.3 架构规则与结构风险

**Description:** 系统帮助用户发现循环依赖、跨层依赖和目录边界违规。MVP 的规则能力保持简单可配置，优先服务“保存后立即知道是否破坏结构边界”。

#### FR-11：循环依赖检测

系统必须检测受支持图谱范围内的 file、directory 和 workspace-package 投影循环依赖。实现 UJ-3、UJ-4。

**Consequences（可测试）:**
- 系统能列出循环链路中的节点和边。
- 系统能区分已有循环与本次变更新增循环。
- 循环 finding 包含严重级别、范围和可定位文件。

#### FR-12：目录与层级依赖规则

用户可以声明基础架构规则，例如禁止某目录引用某目录，或限制层级依赖方向。实现 UJ-3、UJ-4。

**Consequences（可测试）:**
- 用户通过 `.codegraph/rules.yaml` 配置架构规则，规则文件必须声明 `version: 1`。
- v1 只支持三种固定规则类型：`forbidden-dependency`、`layer-order`、`no-cycle`。
- 每条规则必须包含唯一稳定的 `id`、`type` 和 `severity`；`severity` 只支持 `warning` 与 `error`。
- `forbidden-dependency` 使用 `from` 和 `to` 路径模式禁止指定依赖方向；`layer-order` 按声明顺序限制层级依赖方向；`no-cycle` 按 `file`、`directory` 或 `package` 范围检查循环。
- 路径相对于工作区根目录，统一使用 `/`；glob 中 `*` 匹配单个路径段，`**` 可跨目录匹配。
- 规则文件支持全局 `ignore` 路径列表，但该列表只裁剪规则评估范围；命中的实体仍保留在规范图谱、普通查询、workspace package 聚合和索引规模统计中。
- 索引范围只能由内置默认项和 `.codegraphignore` 改变；同一路径在 `rules.yaml` ignore 下不得产生规则 finding，在 `.codegraphignore` 下则不得进入图谱。
- 系统在 rebuild、保存后更新和 CLI check 时执行规则。
- 规则文件存在重复 ID、未知字段、未知规则类型、缺失必填字段或非法枚举值时，系统必须给出文件位置和修复提示，不得静默忽略。
- v1 不支持任意布尔表达式、正则组合、符号级规则、规则继承或可视化规则编辑。

#### FR-13：保存后 findings 提示

当保存变更引入结构风险时，系统在 IDE 中展示 findings。实现 UJ-3。

**Consequences（可测试）:**
- Finding 展示规则名、严重级别、新增边、相关路径和检测时间。
- 用户可以从 finding 跳转到触发文件。
- 系统不得用模糊告警替代可定位的依赖边或规则。

#### FR-14：风险解释

系统必须解释结构风险为什么发生，而不只是给出错误码。

**Consequences（可测试）:**
- 循环依赖 finding 展示完整或折叠后的循环路径。
- 跨层违规 finding 展示实际依赖方向和期望规则。
- 对已知限制或低置信度结果，系统明确标注置信度或数据来源。

#### FR-15：CLI 规则检查

用户可以通过 CLI 在本地执行规则检查并获得机器可读和人可读输出。实现 UJ-4。

**Consequences（可测试）:**
- CLI check 在存在 `error` 级违规时返回非零退出码；只有 `warning` 时默认返回零。
- CLI 输出包含 summary、findings 列表和可选 JSON。
- CLI 不要求连接云服务。

### 4.4 变更影响与 PR 摘要

**Description:** MVP 支持本地读取 git diff，生成结构变化摘要。该能力服务 PR 审查，但不在第一版实现完整 GitHub/GitLab hosted integration。

#### FR-16：读取本地变更集合

用户可以通过 CLI 或 VS Code 命令选择当前工作树、暂存区或指定 base 分支作为变更集合。实现 UJ-4。

**Consequences（可测试）:**
- 系统能识别新增、删除、修改和移动的受支持文件。
- 系统能在图谱中标记受变更影响的节点和边。
- 当 git 信息不可用时，系统给出可理解错误和替代命令建议。

#### FR-17：结构变化摘要

系统必须输出本次变更造成的结构变化。实现 UJ-4。

**Consequences（可测试）:**
- 摘要列出新增依赖边、删除依赖边、受影响 directory 或 workspace package、循环变化和规则违规。
- 摘要区分“本次新增风险”和“历史既有风险”。
- 摘要避免渲染全量图，只展示与变更集合相关的预算内子图或列表。

#### FR-18：Markdown PR Review 输出

用户可以生成适合复制到 PR review 的 Markdown 摘要。实现 UJ-4。

**Consequences（可测试）:**
- Markdown 摘要包含总体 verdict、主要风险、关键路径和建议复查文件。
- 摘要中路径使用相对路径。
- 输出不包含源码内容，除非用户显式开启。
- 只有完整生成且不可变的 artifact 才能复制或写出；生成失败不得暴露或复制部分摘要。剪贴板或目标文件写入失败时，可以重试同一完整 artifact 或改用另一目标。

#### FR-19：本地隐私边界

结构影响分析默认不上传源码、diff 或图谱数据。实现 UJ-4、UJ-5。

**Consequences（可测试）:**
- 默认配置下，CLI 和插件不发起远程上传。
- MVP 默认关闭遥测，核心功能不得依赖遥测开启。
- 用户可显式 opt-in 匿名产品与性能遥测；遥测不得包含源码、diff、完整文件路径、符号名称、图谱内容或规则内容。
- 用户可随时关闭遥测并查看本地生效状态；首轮试用也可以通过访谈和用户主动导出的诊断报告收集反馈。
- 本地图谱数据位于 OS 用户缓存的 workspace-key 目录，用户可查看位置并安全清理；生成数据不写入工作区，也不依赖 `.gitignore` 防止误提交。

### 4.5 CLI、本地图谱服务与可导出上下文

**Description:** VS Code 插件、CLI 和未来 AI/MCP 能力共用本地图谱服务。MVP 需要形成稳定的查询与导出能力，避免把图谱能力锁死在 Webview 内。

#### FR-20：CLI 基础命令

用户可以通过 CLI 执行 rebuild、query、check、impact、export、status、doctor 和 cache。实现 UJ-1、UJ-4、UJ-5。

**Consequences（可测试）:**
- `rebuild` 生成或刷新图谱。
- `query` 返回当前文件或指定路径的邻域结果。
- `check` 执行规则检查。
- `impact` 生成变更影响摘要。
- `export` 输出受预算限制的本地结构上下文。
- `status` 返回服务、图谱与 Finding 的当前状态；`doctor` 输出可操作诊断；`cache` 支持查看位置和安全清理。

#### FR-21：本地图谱查询服务

插件和 CLI 通过本地图谱查询服务访问图谱，而不是各自重复实现索引和查询。

**Consequences（可测试）:**
- 插件可以请求项目概览、当前文件邻域、findings 和 stale 状态。
- CLI 可以复用同一查询能力。
- 图谱查询服务返回 view model 或结构化数据，不暴露渲染库内部格式。

#### FR-22：图谱状态与故障恢复

系统必须让用户知道图谱是否可用、是否过期、是否构建失败。

**Consequences（可测试）:**
- 插件显示 idle、indexing、stale、failed 等状态。
- 构建失败时展示错误摘要和日志位置。
- 用户可以执行重建以恢复损坏或过期图谱。

#### FR-23：结构上下文导出

用户可以导出当前文件邻域、相关规则和 findings 的结构上下文，用于 AI 工具或人工沟通。实现 UJ-5。

**Consequences（可测试）:**
- 导出内容包含路径、节点类型、依赖边、规则 findings 和图谱更新时间。
- 导出内容默认不包含源码正文。
- 导出内容受图谱预算限制，避免把全仓库上下文一次性输出。
- 只有完整生成且不可变的 artifact 才能复制或写出；生成失败不得暴露部分内容，目标操作失败只能重试同一完整 artifact 或改用另一目标。

## 5. 跨功能非功能需求

### 5.1 性能

- **NFR-1：标准验收规模。** 标准验收项目不超过 5,000 个受支持源码文件、500,000 行源码和 50 个 workspace package；`node_modules`、构建产物、生成代码和索引排除路径不计入规模。
- **NFR-2：标准参考环境。** 标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD 的本地开发机器。
- **NFR-3：首次概览性能。** 在标准验收项目和参考环境下，clean cache 首次概览的 p95 不超过 60 秒。
- **NFR-4：缓存邻域性能。** 打开文件后，已提交 warm cache 的邻域图显示 p95 不超过 300ms，后台刷新可异步完成。
- **NFR-5：保存后刷新性能。** 从宿主保存动作到对应 graph/Findings revision 可见的 p95 不超过 2 秒。
- **NFR-6：默认图谱预算。** 默认邻域图的单次查询和渲染预算上限为 100 个节点、200 条边。
- **NFR-7：超规模退化。** 超出标准验收规模时暂不承诺相同 SLA，但系统不得阻塞编辑器，必须显示索引进度并允许取消或重建。

### 5.2 可靠性

- **NFR-8：宿主隔离。** 索引、查询和布局不得阻塞 VS Code extension host。
- **NFR-9：事件风暴收敛。** git pull、分支切换、依赖安装和批量生成文件不应造成无限重建。
- **NFR-10：失败可读。** 图谱构建失败时，已有缓存仍可作为 stale 数据查看，并清楚标注状态。
- **NFR-11：缓存可恢复。** 系统必须能从损坏缓存中重建；迁移失败时保留故障副本并给出可恢复错误。

### 5.3 安全与隐私

- **NFR-12：本地优先。** 源码、图谱、diff 和结构摘要默认仅保存在本地。
- **NFR-13：本机访问。** 本地图谱服务只能通过当前用户可访问的本机 IPC 端点通信，不监听 TCP 或网络接口。
- **NFR-14：数据可清理。** 用户必须能定位并安全清理本地图谱数据、日志和服务元数据。
- **NFR-15：遥测最小化。** 遥测默认关闭；即使用户 opt-in，也只收集匿名功能使用事件、耗时、计数和错误分类，不收集项目内容或可反推出项目结构的标识。
- **NFR-16：云能力隔离。** 云端同步与团队共享必须作为独立能力另行设计和授权，不进入 MVP 主路径。

### 5.4 可用性与可访问性

- **NFR-17：任务等价文本。** 核心 findings、循环依赖、结构关系和 PR 摘要必须有与图形任务等价的文本呈现；屏幕阅读器可获得节点类型、入/出边数、Finding 数、边方向、来源和置信度。
- **NFR-18：视觉可辨识。** 图谱节点、边、严重级别和 stale 状态必须具备一致视觉语义，不能只依赖颜色；人类可读界面达到 WCAG 2.2 AA，并在 VS Code 高对比主题下保持可辨识。
- **NFR-19：键盘与焦点。** 用户可以固定当前视图；所有核心任务无需鼠标即可完成，焦点顺序可预测且可见，交互目标不小于 24×24 CSS px。
- **NFR-20：缩放与动态效果。** 空状态、错误状态和规则语法错误必须提供下一步操作；200% 字号下核心信息不丢失或重叠，并服从系统/VS Code 的减少动态效果设置。

### 5.5 可演进性

- **NFR-21：渲染解耦。** 图谱持久模型不得绑定具体渲染库格式。
- **NFR-22：可追溯模型。** 节点和边必须使用稳定 ID，并记录来源、置信度、版本和更新时间。
- **NFR-23：可替换边界。** 分析器、存储、查询和渲染层应保留可替换边界，支持后续接入更多语言、SCIP、矩阵视图或 MCP server。

### 5.6 兼容性、资源与本地服务边界

- **NFR-24：支持平台与版本。** MVP 支持 Windows x64、macOS x64、macOS arm64 和 Linux x64；Windows arm64、Linux arm64 暂不支持。VS Code 扩展的最低版本为 1.125.0，发布时同时验证最低版本、最新稳定版和前一稳定版；CLI 要求 Node 24 LTS，平台 VSIX 自带经验证的 Node 24 LTS 运行时。
- **NFR-25：安装、升级与迁移。** 每个受支持组合必须通过新安装、离线启动、升级、降级、卸载以及缓存保留/清理验收。协议 major 或 schema 不兼容时必须安全拒绝并提示更新；图谱迁移只能由新服务事务化执行，失败时保留故障副本并允许重建，旧服务不得向新 schema 降级写入。
- **NFR-26：资源基线。** 在标准验收项目与参考环境中，首次 `rebuild` 的 graph-service 进程树峰值 RSS 不超过 4 GiB；按 1 秒间隔采样的整段运行平均 CPU 不超过整机 75%。在连续 5 分钟无活动任务（Job）的空闲窗口内，CPU p95 不超过整机 1%，窗口结束时 RSS 不超过 1.5 GiB。单工作区缓存、服务元数据与日志总量不超过 2 GiB，其中轮转日志不超过 100 MiB。版本化资源基准 manifest 必须固定 8 小时会话的 fixture、操作序列、采样间隔和空闲窗口；会话结束后的同条件空闲 RSS 不得比首小时基线增长超过 20%，Job 队列、句柄和临时文件不得持续单调增长。
- **NFR-27：服务生命周期与威胁边界。** 每个索引根目录（indexing root）最多运行一个按需启动的图谱服务；Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket。业务请求前必须校验随机令牌、workspace-key 和协议版本；端点冲突、伪造客户端或版本不兼容必须安全失败且不得误连第二实例。未授予 Workspace Trust 时不得启动服务、读取项目文件或运行 Git 分析；对所有路径执行 `realpath` 解析后，结果必须位于 indexing root 内。服务应在无客户端且无活动 Job 5 分钟后优雅退出，并在崩溃、重连、升级和 stale metadata 场景下可恢复。

## 6. 约束与护栏

### 6.1 产品约束

- MVP 优先验证“当前文件影响哪里”和“是否破坏结构边界”，不追求全语言、全调用图或全局大图。
- PR 工作流以本地 CLI/Markdown 摘要开始，不做第一版 hosted PR app。
- AI 方向以本地结构上下文导出保留入口，MCP server 延后。

### 6.2 数据治理

- 仓库仅保存 `.codegraph/rules.yaml` 与 `.codegraphignore`；`graph.sqlite`、服务元数据、锁、日志、last-valid 记录和临时文件写入 OS 用户缓存下的 workspace-key 目录。
- 生成数据不写入工作区，因此不依赖 `.gitignore` 防止误提交；用户可通过 CLI 查看缓存位置并安全清理。
- 导出内容默认只包含结构信息，不包含源码正文。

### 6.3 成本与复杂度

- MVP 不引入必须运行的云服务。
- MVP 不要求重型图数据库、跨语言全量索引或 CPG 数据流分析。
- VS Code 插件应是薄客户端，重索引和图查询由本地图谱服务承担。

## 7. MVP 范围

MVP 分两段验证：首个可用版本优先验证 IDE 内的项目结构概览、当前文件邻域图和保存后增量更新；Beta+ 再加入基础架构规则与本地 PR 结构影响摘要。PR 摘要属于完整 MVP 范围，但不阻塞首个可用版本交付。

### 7.1 In Scope

- VS Code 插件。
- 本地 CLI。
- TypeScript/JavaScript 项目支持。
- 常见 npm、Yarn、pnpm monorepo 的 workspace package 边界和跨 package import 关系。
- 本地图谱索引：目录、文件、import/export、外部包依赖、基础符号。
- 项目结构概览。
- 当前文件邻域图。
- 循环依赖检测。
- `.codegraph/rules.yaml` v1 基础目录、层级和循环规则。
- 保存后增量更新与 stale 状态。
- 本地 git diff 结构影响摘要。
- Markdown PR review 摘要。
- 本地结构上下文导出。
- 默认本地存储、默认不上传。

### 7.2 Out of Scope for MVP

- 全语言支持。
- 精准运行时调用图、数据流分析、CPG 安全分析。
- 云端团队协作、账号体系、SSO、权限管理。
- GitHub/GitLab hosted app 或自动 PR comment。
- AI 自动重构。
- MCP server。
- 可视化规则编辑器。
- 独立 Web dashboard。
- 历史趋势分析、跨仓库全局图谱。
- 重型图数据库作为必需依赖。

## 8. 成功指标

首轮验证必须在上述目标团队的真实代码库中进行，并分别收集一线开发者与 Tech Lead 的反馈：前者重点验证结构理解和改动判断效率，后者重点验证规则 findings 与 PR 结构摘要是否有助于审查和治理。

性能和使用指标优先通过本地诊断、任务观察和访谈获得；只有用户明确 opt-in 时才使用匿名遥测补充数据。

**Primary**

- **SM-1:** 使用 `ProductValidationPlanV1` 中版本化的 UJ-2 task pack。每个 task 固定 fixture commit/digest、targetFile、requiredEntities、affectedAggregates、acceptableAliases、criticalDistractors 和 groundTruthDigest。计时在 warm cache 已提交、目标文件和任务提示同时可见时触发 `taskStarted`；参与者提交最终答案时触发 `taskSubmitted`，安装、首次索引和说明时间不计入。产品崩溃、查询失败或超时计为失败而不是剔除。单次答案正确需识别全部 requiredEntities、至少 80% affectedAggregates，且不选择 criticalDistractor；至少 10 个有效会话中，至少 80% 必须在 180 秒内正确完成。验证 FR-6、FR-7、FR-9；FR-17 由结构变更任务单独验证。
- **SM-2:** 打开文件后 300ms 内显示缓存邻域图，并在后台刷新。验证 FR-7、FR-22。
- **SM-3:** 保存文件后 2 秒内完成局部依赖更新和 findings 刷新。验证 FR-3、FR-13。
- **SM-4:** 使用版本化人工标注语料验收 FR-2：语料至少包含 500 条依赖声明，覆盖 ESM、CJS、re-export、type-only、literal `require`、literal dynamic `import()`、path alias、跨 package、Node built-in 和负样本；以人工标注的依赖边为真值，micro-F1 不低于 0.80，高置信度依赖边 precision 不低于 0.90。验收报告必须输出 precision、recall、F1、分类结果和失败样本，标注争议经人工复核并留痕。

**Secondary**

- **SM-5:** 首次 rebuild 在标准验收项目和参考环境下 60 秒内生成第一版概览。验证 FR-1、FR-6。
- **SM-6:** 使用版本化 `RulesValidationFixtureV1`，至少包含 30 个受支持合同内案例，并同时覆盖 file/directory/package no-cycle、forbidden-dependency、layer-order、warning/error、rules ignore、索引排除差异和负对照。每个案例固定 fixture digest、rules digest、expectedFindingIds、expectedSeverity、expectedLocations 和 forbiddenUnexpectedFindings。发布门禁要求所有预期 error/warning Finding 的 recall=1.00、precision=1.00，error 级漏报为 0，负对照误报为 0，且 IDE/CLI 的稳定 Finding ID、严重级别和位置一致。环境、fixture 或 digest 不匹配时结果为 invalid，不得降低阈值重跑。验证 FR-11、FR-12、FR-15。
- **SM-7:** 复用 SM-1 的版本化 UJ-2 task pack 和统一 `taskStarted`/`taskSubmitted` 事件。有效试用者必须是当前真实仓库的一线开发者或 Tech Lead、未参与产品实现、完成标准化说明且未接受任务答案提示；至少 10 人、3 个真实 TS/JS 仓库、2 个独立团队。允许剔除的原因只限于资格不符、撤回同意、与产品无关的记录损坏或预检环境不满足计划；产品崩溃、超时、错误答案、低评分和负面反馈不得剔除。参与者提交任务后立即、仅一次对固定陈述“相比目录树和搜索，我能更快理解结构影响”按 1–5 分评分；缺失评分使会话无效但必须记录原因，不得补填或平均多次评分。以有效会话为分母，至少 70% 评分达到 4/5 或以上；同时保留完成时间、正确性和原始评分证据。验证 FR-6、FR-7。
- **SM-8:** 每次 review 生成 `TechLeadReviewEvidenceV1`，至少包含 planVersion、participantPseudonym、teamId、repositoryId、candidateRef、changeSet/baseRef digest、artifactId、graphRevision、findingsRevision、requested/effectivePolicy、containsSource、verdict、majorRiskIds、keyPaths、suggestedReviewFiles、editClassification、criticalOmissions、falseCriticalStatements、decision 和 timestamp。`editClassification` 只允许 `none`、`wording-only`、`format-only`、`structural-reanalysis`；只有前三种且 criticalOmissions 与 falseCriticalStatements 均为空时单次验证通过。至少 5 名 Tech Lead、3 个独立团队中，至少 80% 单次验证通过；所有失败样本必须保留并关联复测条件。验证 FR-18。

**Counter-metrics（不要优化错方向）**

- **SM-C1:** 不以全局大图节点数作为成功指标；更大的图不等于更好的理解。
- **SM-C2:** 不以 findings 数量最大化作为成功指标；过多低价值告警会降低信任。
- **SM-C3:** 不以支持语言数量作为 MVP 成功指标；第一阶段应优先验证 TS/JS 场景价值。
- **SM-C4:** 不以 AI 自动修改成功率衡量 MVP；MVP 只提供结构事实和边界。
- **SM-C5:** 图形美观度不能替代 SM-1 与 SM-7；即使视觉评分较高，结构影响任务未提速也不视为成功。

**Go / No-Go 门禁**

- `ReadinessGateManifestV1` 是 release slice 适用性的唯一来源。Beta entry、Beta exit、Beta+ release 和 v1.1 entry 必须分别使用独立、版本化、逐项展开的 gate 列表，禁止在执行时人工解释“全部适用”。
- Beta 可以按第 9.2 节作为首个可用版本验证，但不得被表述为完整 MVP；Beta exit 必须通过 SM-1、SM-7 及对应 `ProductValidationPlanV1`。
- Beta+ release manifest 必须逐项列出 FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8 和发布完整性、信任链 gate。任一 blocking gate 为 fail 或 invalid 均为 No-Go，并记录失败样本、负责人和复测条件。
- v1.1 / MCP 候选只有在完整 MVP 门禁通过、且 UJ-5 的版本化价值门禁通过后才能启动；MCP 本身不得进入当前 manifest 的 MVP requirementRefs。

## 9. 发布与验证路径

### 9.1 Alpha：本地 CLI 原型

- 支持 TS/JS 单包工作区 rebuild；monorepo 可先按普通工作区退化索引。
- 生成由 Architecture Spine AD-6 确认的 SQLite 本地图谱存储；生成数据位于 OS 用户缓存的 workspace-key 目录。
- 输出当前文件邻域 JSON/Markdown。
- 检测循环依赖。

### 9.2 Beta：VS Code 插件 MVP

- Beta entry manifest 逐项列出 FR-1 至 FR-10、FR-19 至 FR-22、适用 NFR、SM-2 至 SM-5，以及安装、隐私、安全、兼容和基础可访问性 gate。
- 展示项目结构概览和当前文件邻域图。
- 识别常见 npm、Yarn、pnpm monorepo 的 workspace package 边界。
- 支持点击节点跳转。
- 保存后增量更新。
- 显示 findings 与 stale 状态。
- Beta exit 必须通过 SM-1、SM-7 及其版本化验证计划。

### 9.3 Beta+：规则与 PR 摘要

- 支持 `.codegraph/rules.yaml`。
- 支持 CLI check 和 impact。
- 输出 Markdown PR review 摘要。
- 收集早期用户任务完成时间和主观理解成本反馈。
- Beta+ release 使用逐项展开的 `ReadinessGateManifestV1` 验证 FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8 及发布完整性与信任链。

### 9.4 v1.1 候选：MCP 上下文服务

- 只有在完整 MVP 的 Beta+ release manifest 全部通过、且 UJ-5 版本化价值门禁通过后再启动。
- MCP server 复用稳定的图谱查询服务，提供邻域、影响分析和规则 findings，不承担 AI 自动修改代码。
- MCP 能力不得改变默认本地、默认不上传的隐私边界。

## 10. 风险与缓解

- **风险：产品退化成“漂亮但没用的大图”。** 缓解：默认聚焦当前文件、目录聚合和变更影响，不把全局大图作为主体验。
- **风险：静态分析结果不够精确。** 缓解：记录来源与置信度，明确区分语法依赖、语义引用和启发式结果。
- **风险：大仓库索引和渲染卡顿。** 缓解：薄插件、本地图谱服务、增量更新、图谱预算、stale 状态和排除规则。
- **风险：规则告警过多导致用户关闭功能。** 缓解：区分新增风险与历史风险，支持严重级别和规则范围。
- **风险：本地源码结构数据被误上传或误提交。** 缓解：生成数据仅写入 OS 用户缓存、不写入工作区，默认不上传，导出默认不含源码正文。
- **风险：MVP 范围过大。** 缓解：把 MCP、云端协作、hosted PR app、全语言和 CPG 全部排出 MVP。

## 11. 开放问题

当前无阻塞性开放问题。MVP 实施中发现的新问题应追加到本节，并注明负责人和重新评估条件。

## 12. 假设索引

当前无未确认假设。后续新增推断必须先记录到本节或开放问题，并在进入实现前获得确认。
