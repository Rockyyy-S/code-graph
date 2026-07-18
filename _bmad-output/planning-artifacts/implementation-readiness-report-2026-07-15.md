---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
assessmentStatus: NOT_READY
issueSummary:
  total: 24
  critical: 3
  high: 7
  medium: 10
  low: 4
inputDocuments:
  prd:
    - prds/prd-bmad-2026-07-09/prd.md
    - prds/prd-bmad-2026-07-09/addendum.md
  architecture:
    - architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
    - architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md
  epics:
    - epics.md
  ux:
    - ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
    - ux-designs/ux-bmad-2026-07-13/DESIGN.md
    - ux-designs/ux-bmad-2026-07-13/reconcile-prd.md
  supplemental:
    - sprint-change-proposal-2026-07-15.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-15
**Project:** bmad

## 文档发现

### 已确认的评估输入

| 文档类型 | 文件 | 大小 | 最后修改时间 |
| --- | --- | ---: | --- |
| PRD | `prds/prd-bmad-2026-07-09/prd.md` | 30,238 B | 2026-07-13 23:25:29 |
| PRD 补充 | `prds/prd-bmad-2026-07-09/addendum.md` | 5,420 B | 2026-07-13 23:25:29 |
| 架构 | `architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md` | 43,330 B | 2026-07-14 14:33:49 |
| 架构实施指南 | `architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md` | 46,033 B | 2026-07-14 11:48:26 |
| Epics & Stories | `epics.md` | 134,708 B | 2026-07-14 16:27:41 |
| UX 体验规范 | `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md` | 20,800 B | 2026-07-14 09:14:34 |
| UX 视觉设计 | `ux-designs/ux-bmad-2026-07-13/DESIGN.md` | 12,232 B | 2026-07-14 09:14:34 |
| UX/PRD 对齐说明 | `ux-designs/ux-bmad-2026-07-13/reconcile-prd.md` | 2,133 B | 2026-07-13 23:51:01 |
| 补充变更输入 | `sprint-change-proposal-2026-07-15.md` | 19,287 B | 2026-07-15 14:47:00 |

### 发现结果

- 未发现整篇版与分片版并存的重复冲突。
- PRD、架构和 UX 文档采用非标准目录结构，未提供分片入口 `index.md`；本次按用户确认的文档集合评估。
- `implementation-readiness-report-2026-07-14.md` 是历史评估报告，已排除，不作为本次输入。

## PRD 分析

### 功能需求

#### FR-1：初始化工作区图谱

用户可以通过 VS Code 命令或 CLI 对当前工作区执行首次图谱构建。实现 UJ-1。

- 当用户在受支持工作区执行初始化时，系统生成可查询的项目代码图谱。
- 系统识别常见 npm、Yarn 与 pnpm workspace/package 边界；无法识别时仍可退化为普通单工作区索引。
- 当工作区缺少受支持语言文件时，系统给出空状态和可操作提示，而不是报错退出。
- 初始化结果包含图谱生成时间、索引文件数、节点数、边数和排除路径摘要。

#### FR-2：提取 TypeScript/JavaScript 依赖关系

系统必须提取 TypeScript/JavaScript 文件之间的 import/export 关系和外部包依赖。实现 UJ-1、UJ-2。

- 系统能识别 ES module import/export、常见 TypeScript path alias、package import。
- 在 monorepo 中，系统能识别跨 workspace package 的 TS/JS import，并将文件级证据聚合为 package 依赖边。
- 每条依赖边记录来源、置信度、语言、文件范围和最后检测时间。
- 对无法确定的动态依赖，系统不得伪装成精确依赖；必须标记为低置信或暂不纳入。

#### FR-3：保存后增量更新

用户保存受支持文件后，系统在本地增量更新相关图谱数据。实现 UJ-2、UJ-3。

- 系统对保存事件进行 debounce 或 settle 处理，避免 git pull、分支切换或批量生成文件时频繁重建。
- 内容 hash 未变化时，系统不得重复解析同一文件。
- 增量更新完成后，当前视图显示最新状态或明确标记仍为 stale。

#### FR-4：路径排除与噪声控制

用户可以排除 node_modules、构建产物、生成代码和自定义路径，防止图谱污染。实现 UJ-1、UJ-2。

- 系统默认排除常见依赖目录和构建产物。
- 用户可通过配置文件声明额外排除路径。
- 被排除路径不参与节点、边、规则检查和成功指标统计。

#### FR-5：图谱版本、稳定 ID 与过期状态

系统必须为图谱 schema、节点、边和索引状态提供稳定标识与版本信息。

- 节点和边 ID 不依赖数据库自增主键。
- 图谱数据包含 schema version，旧版本数据可触发迁移或重建提示。
- 当源文件变化但索引未完成时，系统显示 stale 状态。

#### FR-6：项目结构概览

用户打开工作区后，可以查看目录/模块之间的真实依赖概览。实现 UJ-1。

- 概览视图以目录或模块为主要节点，而不是展示所有文件。
- 概览展示依赖方向、依赖强度、循环风险和图谱更新时间。
- 用户可以从目录/模块节点下钻到相关文件或局部邻域。

#### FR-7：当前文件邻域图

用户打开代码文件时，系统自动展示当前文件的依赖邻域。实现 UJ-2。

- 邻域图至少区分当前文件、直接依赖、反向依赖和外部包。
- 默认展示 1 跳关系，单次查询和渲染预算上限为 100 个节点、200 条边。
- 当节点或边超过预算时，系统按相关性将远端内容折叠为目录或 workspace package 聚合节点。
- 用户可以主动展开聚合节点；每次展开仍返回受预算限制的局部子图，不允许无上限追加全局图。

#### FR-8：聚焦追踪与视图固定

系统可以跟随用户当前文件切换更新图谱，也允许用户固定当前视图。实现 UJ-2。

- 用户切换文件时，默认图谱聚焦新文件。
- 用户启用固定后，切换文件不会替换当前图谱。
- 固定状态在当前 VS Code 会话中可见且可解除。

#### FR-9：节点导航与上下文操作

用户可以从图谱节点跳转到文件、目录或符号位置。实现 UJ-1、UJ-2。

- 点击文件节点可在 VS Code 中打开对应文件。
- 节点详情展示路径、类型、入边、出边、更新时间和 findings。
- 当节点对应文件不存在或已移动时，系统提示重新索引。

#### FR-10：多视图基础能力

MVP 至少提供局部关系图和结构列表两种呈现方式；大图场景不得只依赖力导向图。

- 当前文件邻域可用图形方式探索。
- findings、循环依赖和 PR 摘要可用列表或表格方式阅读。
- 对键盘用户或无法理解图形的用户，核心信息有文本替代呈现。

#### FR-11：循环依赖检测

系统必须检测受支持图谱范围内的文件级和目录/模块级循环依赖。实现 UJ-3、UJ-4。

- 系统能列出循环链路中的节点和边。
- 系统能区分已有循环与本次变更新增循环。
- 循环 finding 包含严重级别、范围和可定位文件。

#### FR-12：目录与层级依赖规则

用户可以声明基础架构规则，例如禁止某目录引用某目录，或限制层级依赖方向。实现 UJ-3、UJ-4。

- 用户通过 .codegraph/rules.yaml 配置架构规则，规则文件必须声明 version: 1。
- v1 只支持三种固定规则类型：forbidden-dependency、layer-order、no-cycle。
- 每条规则必须包含唯一稳定的 id、type 和 severity；severity 只支持 warning 与 error。
- forbidden-dependency 使用 from 和 to 路径模式禁止指定依赖方向；layer-order 按声明顺序限制层级依赖方向；no-cycle 按 file、directory 或 package 范围检查循环。
- 路径相对于工作区根目录，统一使用 /；glob 中 * 匹配单个路径段，** 可跨目录匹配。
- 规则文件支持全局 ignore 路径列表，用于排除测试、生成代码等内容。
- 系统在 rebuild、保存后更新和 CLI check 时执行规则。
- 规则文件存在重复 ID、未知字段、未知规则类型、缺失必填字段或非法枚举值时，系统必须给出文件位置和修复提示，不得静默忽略。
- v1 不支持任意布尔表达式、正则组合、符号级规则、规则继承或可视化规则编辑。

#### FR-13：保存后 findings 提示

当保存变更引入结构风险时，系统在 IDE 中展示 findings。实现 UJ-3。

- Finding 展示规则名、严重级别、新增边、相关路径和检测时间。
- 用户可以从 finding 跳转到触发文件。
- 系统不得用模糊告警替代可定位的依赖边或规则。

#### FR-14：风险解释

系统必须解释结构风险为什么发生，而不只是给出错误码。

- 循环依赖 finding 展示完整或折叠后的循环路径。
- 跨层违规 finding 展示实际依赖方向和期望规则。
- 对已知限制或低置信结果，系统明确标注置信度或数据来源。

#### FR-15：CLI 规则检查

用户可以通过 CLI 在本地执行规则检查并获得机器可读和人可读输出。实现 UJ-4。

- CLI check 在存在 error 级违规时返回非零退出码；只有 warning 时默认返回零。
- CLI 输出包含 summary、findings 列表和可选 JSON。
- CLI 不要求连接云服务。

#### FR-16：读取本地变更集合

用户可以通过 CLI 或 VS Code 命令选择当前工作树、暂存区或指定 base 分支作为变更集合。实现 UJ-4。

- 系统能识别新增、删除、修改和移动的受支持文件。
- 系统能在图谱中标记受变更影响的节点和边。
- 当 git 信息不可用时，系统给出可理解错误和替代命令建议。

#### FR-17：结构变化摘要

系统必须输出本次变更造成的结构变化。实现 UJ-4。

- 摘要列出新增依赖边、删除依赖边、受影响目录/模块、循环变化和规则违规。
- 摘要区分“本次新增风险”和“历史既有风险”。
- 摘要避免渲染全量图，只展示与变更集合相关的预算内子图或列表。

#### FR-18：Markdown PR Review 输出

用户可以生成适合复制到 PR review 的 Markdown 摘要。实现 UJ-4。

- Markdown 摘要包含总体 verdict、主要风险、关键路径和建议复查文件。
- 摘要中路径使用相对路径。
- 输出不包含源码内容，除非用户显式开启。

#### FR-19：本地隐私边界

结构影响分析默认不上传源码、diff 或图谱数据。实现 UJ-4、UJ-5。

- 默认配置下，CLI 和插件不发起远程上传。
- MVP 默认关闭遥测，核心功能不得依赖遥测开启。
- 用户可显式 opt-in 匿名产品与性能遥测；遥测不得包含源码、diff、完整文件路径、符号名称、图谱内容或规则内容。
- 用户可随时关闭遥测并查看本地生效状态；首轮试用也可以通过访谈和用户主动导出的诊断报告收集反馈。
- 本地图谱数据可被用户删除或加入 .gitignore。

#### FR-20：CLI 基础命令

用户可以通过 CLI 执行 rebuild、query、check、impact 和 export。实现 UJ-1、UJ-4、UJ-5。

- rebuild 生成或刷新图谱。
- query 返回当前文件或指定路径的邻域结果。
- check 执行规则检查。
- impact 生成变更影响摘要。
- export 输出受预算限制的本地结构上下文。

#### FR-21：本地图谱查询服务

插件和 CLI 通过本地图谱查询服务访问图谱，而不是各自重复实现索引和查询。

- 插件可以请求项目概览、当前文件邻域、findings 和 stale 状态。
- CLI 可以复用同一查询能力。
- 图谱查询服务返回 view model 或结构化数据，不暴露渲染库内部格式。

#### FR-22：图谱状态与故障恢复

系统必须让用户知道图谱是否可用、是否过期、是否构建失败。

- 插件显示 idle、indexing、stale、failed 等状态。
- 构建失败时展示错误摘要和日志位置。
- 用户可以执行重建以恢复损坏或过期图谱。

#### FR-23：结构上下文导出

用户可以导出当前文件邻域、相关规则和 findings 的结构上下文，用于 AI 工具或人工沟通。实现 UJ-5。

- 导出内容包含路径、节点类型、依赖边、规则 findings 和图谱更新时间。
- 导出内容默认不包含源码正文。
- 导出内容受图谱预算限制，避免把全仓库上下文一次性输出。

**功能需求总数：23**

### 非功能需求

原 PRD 的跨功能非功能需求没有稳定编号。为后续追踪，本报告按原文顺序分配 NFR-1 至 NFR-23。

#### 性能

- **NFR-1：验收规模。** 标准验收项目定义为：不超过 5,000 个受支持源码文件、500,000 行源码和 50 个 workspace package；node_modules、构建产物、生成代码和排除路径不计入规模。
- **NFR-2：参考环境。** 标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD 的本地开发机器。
- **NFR-3：首次概览。** 在标准验收项目和参考环境下，系统应在 60 秒内生成第一版项目结构概览。
- **NFR-4：缓存邻域响应。** 打开文件后，缓存邻域图应在 300ms 内显示，后台刷新可异步完成。
- **NFR-5：保存后更新。** 保存文件后，局部依赖更新和 findings 刷新应在 2 秒内完成。
- **NFR-6：查询与渲染预算。** 默认邻域图的单次查询和渲染预算上限为 100 个节点、200 条边。
- **NFR-7：超规模退化。** 超出标准验收规模时暂不承诺相同 SLA，但系统不得阻塞编辑器，必须显示索引进度并允许取消或重建。

#### 可靠性

- **NFR-8：扩展宿主隔离。** 索引、查询和布局不得阻塞 VS Code extension host。
- **NFR-9：事件风暴控制。** git pull、分支切换、依赖安装和批量生成文件不应造成无限重建。
- **NFR-10：失败降级。** 图谱构建失败时，已有缓存仍可作为 stale 数据查看，并清楚标注状态。
- **NFR-11：缓存恢复。** 系统必须能从损坏缓存中重建。

#### 安全与隐私

- **NFR-12：本地存储。** 源码、图谱、diff 和结构摘要默认仅保存在本地。
- **NFR-13：本机监听。** 本地图谱服务默认只监听本机访问范围。
- **NFR-14：数据清理。** 用户应能清理本地图谱数据。
- **NFR-15：遥测最小化。** 遥测默认关闭；即使用户 opt-in，也只收集匿名功能使用事件、耗时、计数和错误分类，不收集项目内容或可反推出项目结构的标识。
- **NFR-16：云能力隔离。** 云端同步与团队共享必须作为独立能力另行设计和授权，不进入 MVP 主路径。

#### 可用性与可访问性

- **NFR-17：文本替代。** 核心 findings、循环依赖和 PR 摘要必须有文本化呈现，不能只依赖图形理解。
- **NFR-18：视觉语义一致。** 图谱节点、边、严重级别和 stale 状态应具备一致的视觉语义。
- **NFR-19：上下文保持。** 用户可以固定当前视图，避免因切换文件导致上下文丢失。
- **NFR-20：可操作反馈。** 空状态、错误状态和规则语法错误必须提供下一步操作。

#### 可演进性

- **NFR-21：渲染解耦。** 图谱持久模型不得绑定具体渲染库格式。
- **NFR-22：可追溯模型。** 节点和边必须使用稳定 ID，并记录来源、置信度、版本和更新时间。
- **NFR-23：可替换边界。** 分析器、存储、查询和渲染层应保留可替换边界，支持后续接入更多语言、SCIP、矩阵视图或 MCP server。

**非功能需求总数：23**

### 附加需求与约束

#### 产品与范围护栏

- MVP 优先验证“当前文件影响哪里”和“是否破坏结构边界”，不追求全语言、全调用图或全局大图。
- PR 工作流以本地 CLI/Markdown 摘要开始，不做第一版 hosted PR app。
- AI 方向以本地结构上下文导出保留入口，MCP server 延后。
- 首个可用版本优先验证 IDE 内项目结构概览、当前文件邻域图和保存后增量更新；Beta+ 再加入基础架构规则与本地 PR 结构影响摘要。
- PR 摘要属于完整 MVP 范围，但不阻塞首个可用版本交付。
- MVP 不包含全语言、精准运行时调用图、数据流/CPG 安全分析、云端团队协作、账号/SSO/权限、hosted PR app、AI 自动重构、MCP server、可视化规则编辑器、独立 Web dashboard、历史趋势、跨仓库全局图谱和重型图数据库必需依赖。

#### 数据治理与复杂度

- 本地图谱数据应默认写入工作区内可识别位置或用户级缓存目录，具体位置由架构确认。
- 图谱文件、缓存和日志默认不应被误提交；项目模板应建议加入 .gitignore。
- 导出内容默认只包含结构信息，不包含源码正文。
- MVP 不引入必须运行的云服务。
- MVP 不要求重型图数据库、跨语言全量索引或 CPG 数据流分析。
- VS Code 插件应是薄客户端，重索引和图查询由本地图谱服务承担。

#### Addendum 技术边界

- 索引器、图查询、规则引擎应放在独立本地图谱服务中。
- 存储层应通过 GraphStore 接口访问，避免业务逻辑散落 SQL。
- 分析能力应通过 AnalyzerAdapter 接入 Tree-sitter、LSP，未来可接 SCIP/CPG。
- 可视化层应消费 GraphViewModel，不把 Cytoscape.js JSON 当作持久图谱模型。
- 文件监听需要 debounce、settle、hash check 和 batch queue，避免 git pull 或批量生成文件导致事件风暴。
- 第一实现候选栈为 VS Code Extension + CLI、TypeScript/Node.js、Tree-sitter + TypeScript/LSP 有限能力、SQLite、本地 rules engine、本地 git diff 和局部图可视化；这些是架构输入，不应被误读为未经权衡的产品实现指令。
- layer-order 中的层按从上到下声明：每层可依赖自身及后续层，不得反向依赖前面的层。
- 规则 ID 在 IDE findings、CLI JSON 和 CI 输出中保持稳定；v1 配置解析拒绝未知字段和未知规则类型。

#### Monorepo、AI 与遥测边界

- Alpha 可先把 monorepo 作为普通工作区索引，但 Beta 必须识别常见 npm/Yarn package.json workspaces 与 pnpm-workspace.yaml。
- TypeScript project references 可作为 package 边界和依赖关系的补充来源。
- MVP 支持单仓库内 workspace package、跨 package import 和 package 聚合依赖边。
- MVP 不支持跨仓库 federation、跨语言精确符号解析或组织级全局图谱。
- MVP 提供 CLI/本地结构上下文导出；MCP server 延后到 v1.1，并以核心体验指标达标为启动条件。
- 无论遥测是否开启，插件、CLI、规则检查和导出能力都必须完整可用。

#### 成功与验证约束

- SM-1：用户能在 3 分钟内回答“改这个文件会影响哪里”。
- SM-2：打开文件后 300ms 内显示缓存邻域图，并在后台刷新。
- SM-3：保存文件后 2 秒内完成局部依赖更新和 findings 刷新。
- SM-4：MVP 对 import/export 依赖识别准确率达到 80% 以上。
- SM-5：首次 rebuild 在标准验收项目和参考环境下 60 秒内生成第一版概览。
- SM-6：规则检查能发现循环依赖和配置的跨层规则违反。
- SM-7：完成 UJ-2 后，至少 70% 的有效试用者对结构影响理解提速的评分达到 4/5 或以上。
- SM-8：PR Markdown 摘要能被 Tech Lead 直接用于 review 讨论。
- 不以全局大图节点数、findings 数量、支持语言数量、AI 自动修改成功率或单纯图形美观度替代核心价值指标。

#### 架构必须闭合的待确认项

- 本地图谱文件的默认位置、命名、清理策略和 .gitignore 建议。
- GraphStore、AnalyzerAdapter、GraphQueryService、RulesEngine、RendererAdapter 的边界。
- workspace/file/symbol/package 的稳定 ID 规范。
- .codegraph/rules.yaml 的解析库、诊断位置格式与 schema 校验实现。
- CLI 命令命名、输入输出格式和退出码语义。
- VS Code 插件 UI 使用 Webview、TreeView 或混合方案的边界。
- PR Markdown 摘要模板。
- 导出给 AI 工具的结构上下文格式。

#### 升级触发条件

- 局部图返回超过 500ms 时，优化索引、缓存或 materialized projection。
- 保存后增量更新超过 2–3 秒时，引入 worker 池、增量解析优化或 LSP 队列。
- Webview 渲染明显卡顿时，限制节点预算、预布局、引入 Sigma.js 或矩阵视图。
- 大量文件变更重复重建时，引入 Watchman 或更严格的 settle/batch 机制。
- 团队需要共享图谱时，评估 Postgres/Apache AGE、Neo4j 或服务端图存储。
- 需要精确引用/实现关系时，增强 LSP 或引入 SCIP。
- 需要安全/数据流分析时，另行评估 CPG/Joern 管线，不压入 MVP 主路径。

### PRD 完整性初评

PRD 的范围、用户旅程、23 条 FR、可测试后果、23 条跨功能 NFR、MVP 分期和成功指标总体完整，需求编号稳定，且没有声明中的阻塞性开放问题。其主要就绪风险如下：

- 原始 NFR 缺少稳定编号，本报告已临时编号；后续应把编号回写 PRD，避免 Epic、测试和实现引用漂移。
- SM-4 的 80% 依赖识别准确率尚未定义基准语料、ground truth、采样与计算方法。
- SM-7 与 SM-8 的“有效试用者”“直接用于 review”缺少明确样本量和通过判定标准。
- 可访问性只有文本替代与视觉一致性要求，缺少键盘操作、焦点管理、对比度或 WCAG 等可量化验收标准。
- 未定义支持的操作系统、VS Code/Node.js 版本范围、安装升级与数据迁移兼容矩阵。
- 未给出 CPU、内存、磁盘占用上限，也未定义长时间运行和大型仓库下的资源基线。
- 本地图谱服务的进程生命周期、传输协议、端口冲突、本机访问控制与威胁模型留待架构闭合。
- Addendum 仍列出 8 个待架构确认项；是否已被现有架构完整决策，需要在后续架构与 Epic 对齐步骤中验证。

## Epic 覆盖验证

### Epic FR 覆盖提取

- **Epic 1：构建并查询可信的本地代码图谱** — FR-1、FR-2、FR-4、FR-5、FR-19、FR-21、FR-22。
- **Epic 2：在 VS Code 中快速理解项目与当前文件影响** — FR-3、FR-6、FR-7、FR-8、FR-9、FR-10。
- **Epic 3：在编码时发现并解释架构风险** — FR-11、FR-12、FR-13、FR-14、FR-15。
- **Epic 4：审查变更并导出可共享的结构上下文** — FR-16、FR-17、FR-18、FR-20、FR-23。

### 覆盖矩阵

| FR | PRD 核心要求 | Epic / Story 覆盖 | 状态 |
| --- | --- | --- | --- |
| FR-1 | 通过 VS Code 或 CLI 初始化工作区图谱 | Epic 1；Story 1.2、1.4 | ✓ 已覆盖 |
| FR-2 | 提取 TS/JS import/export、外部包与跨 workspace package 依赖 | Epic 1；Story 1.3、1.4 | ✓ 已覆盖 |
| FR-3 | 保存后通过防抖、内容去重和批处理增量更新 | Epic 2；Story 2.6 | ✓ 已覆盖 |
| FR-4 | 默认及自定义排除路径，避免噪声进入图谱与规则计算 | Epic 1；Story 1.5 | ✓ 已覆盖 |
| FR-5 | 提供稳定 ID、schema 版本和 stale/迁移/重建状态 | Epic 1；Story 1.2、1.3、1.7 | ✓ 已覆盖 |
| FR-6 | 查看目录、模块或 package 聚合的项目结构概览 | Epic 2；Story 2.2 | ✓ 已覆盖 |
| FR-7 | 查看预算内的一跳当前文件邻域并支持聚合展开 | Epic 2；Story 2.3 | ✓ 已覆盖 |
| FR-8 | 在跟随编辑器与固定当前上下文之间切换 | Epic 2；Story 2.4 | ✓ 已覆盖 |
| FR-9 | 查看实体详情并导航到文件、目录或符号位置 | Epic 2；Story 2.5 | ✓ 已覆盖 |
| FR-10 | 提供局部图和任务等价的结构列表 | Epic 2；Story 2.2、2.3、2.7 | ✓ 已覆盖 |
| FR-11 | 检测文件级和目录/模块级循环并提供可定位证据 | Epic 3；Story 3.3 | ✓ 已覆盖 |
| FR-12 | 严格配置和执行三种 rules.yaml v1 架构规则 | Epic 3；Story 3.1、3.2、3.3 | ✓ 已覆盖 |
| FR-13 | 保存后在 IDE 展示可定位 Finding | Epic 3；Story 3.4、3.5 | ✓ 已覆盖 |
| FR-14 | 解释实际依赖、期望规则、循环路径、来源与置信度 | Epic 3；Story 3.2、3.3、3.4、3.5 | ✓ 已覆盖 |
| FR-15 | CLI check 提供文本、JSON 和稳定退出码 | Epic 3；Story 3.6 | ✓ 已覆盖 |
| FR-16 | 选择 working tree、staged 或 base ref 变更集合 | Epic 4；Story 4.1 | ✓ 已覆盖 |
| FR-17 | 输出新增/删除边、影响范围、循环和规则风险变化 | Epic 4；Story 4.2、4.3 | ✓ 已覆盖 |
| FR-18 | 生成默认不含源码的 PR Markdown 摘要 | Epic 4；Story 4.4 | ✓ 已覆盖 |
| FR-19 | 默认本地、不上传、遥测 opt-in，并可清理数据 | Epic 1、4；Story 1.1、1.8、4.7 | ✓ 已覆盖 |
| FR-20 | 提供 rebuild、query、check、impact、export CLI 命令面 | Epic 4；Story 4.6、4.7；具体命令能力还分布在 Story 1.2、1.6、3.6 | ✓ 已覆盖 |
| FR-21 | 插件与 CLI 复用统一、本地、渲染器无关的查询服务 | Epic 1、4；Story 1.1、1.6、4.7 | ✓ 已覆盖 |
| FR-22 | 展示状态、诊断失败并重建恢复图谱 | Epic 1、2、4；Story 1.1、1.2、1.6、1.7、2.1、2.6、4.7 | ✓ 已覆盖 |
| FR-23 | 导出预算内、默认不含源码的结构上下文 | Epic 4；Story 4.5 | ✓ 已覆盖 |

### 缺失需求

- 未发现缺失的 PRD 功能需求。
- 未发现 Epic 文档中存在但 PRD 未定义的额外 FR 编号。
- FR-20 的实现横跨多个 Epic：Epic 4 负责完整命令面与 impact/export，rebuild/query/check 的具体能力分别在 Epic 1 和 Epic 3 中落地。该分布仍具备可追踪路径，不构成覆盖缺口。

### 覆盖统计

- PRD 功能需求总数：23
- Epic 覆盖的功能需求：23
- 有具体 Story 路径的功能需求：23
- 缺失功能需求：0
- 覆盖率：100%

## UX 对齐评估

### UX 文档状态

**已找到并完整审阅：**

- `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md` — 信息架构、状态、交互、可访问性和 UJ-1 至 UJ-5。
- `ux-designs/ux-bmad-2026-07-13/DESIGN.md` — 视觉 token、11 个组件和 VS Code 宿主适配规则。
- `ux-designs/ux-bmad-2026-07-13/reconcile-prd.md` — PRD 定稿后的 UX 修订记录。

三份 UX 文档均为 final 状态，但明确说明尚无 mockup、wireframe 或导入视觉素材。

### UX ↔ PRD 对齐

| 对齐领域 | 结果 | 证据 |
| --- | --- | --- |
| 目标用户与本地优先 | 对齐 | UX Foundation 与 PRD 的 5–15 人 TS/JS 团队、一线开发者和 Tech Lead 一致 |
| UJ-1 项目结构理解 | 对齐 | Getting Started、Project Overview、IndexSummary、下钻与失败降级完整覆盖 |
| UJ-2 当前文件影响 | 对齐 | Current Context、300ms 缓存、固定视图、预算聚合和列表核对完整覆盖 |
| UJ-3 保存后结构违规 | 对齐 | 非模态 Finding、实际边、规则证据、修复后生命周期完整覆盖 |
| UJ-4 PR 结构审查 | 对齐 | Changes、ChangeSummary、PR Markdown 和新增/既有风险分类完整覆盖 |
| UJ-5 AI 结构上下文 | 对齐 | ExportPreview、结构优先、相对路径、预算和默认无源码完整覆盖 |
| 性能与规模 | 对齐 | 5,000 文件、500,000 LOC、50 packages、60s/300ms/2s、100 节点/200 边全部一致 |
| 隐私与遥测 | 对齐 | 本地生成、默认不上传、遥测默认关闭和显式 opt-in 一致 |
| 可访问性 | UX 更具体 | PRD 要求文本替代和一致视觉；UX 进一步规定 WCAG 2.2 AA、键盘语义、屏幕阅读器、减少动态效果和 24×24 px 目标 |

UX 增加的细化要求已被 `epics.md` 中的 UX-DR1 至 UX-DR36 和相应 Story 验收标准吸收，没有形成未进入交付计划的“孤立 UX 需求”。

### UX ↔ 架构对齐

| UX 需求 | 架构支持 | 状态 |
| --- | --- | --- |
| 薄 VS Code 插件，本地服务承担索引与查询 | AD-1、AD-2、AD-10 | ✓ 支持 |
| Webview 只消费预算内、渲染器无关模型 | AD-7；GraphViewModel / GraphViewPatchV1 | ✓ 支持 |
| 图与列表完成等价任务 | AD-15；Implementation Guide 第 11 节 | ✓ 支持 |
| 后台更新保留中心、选择、展开、缩放和列表位置 | AD-7、AD-15；原子 delta/invalidate | ✓ 支持 |
| 复杂布局不阻塞宿主 | AD-15；布局进入 Web Worker | ✓ 支持 |
| stale、partial、failed、cancelled 与缓存保留 | AD-7、AD-8；四维 WorkspaceStatus 与 Job 模型 | ✓ 支持 |
| Finding 可定位、可解释且身份稳定 | AD-9、AD-17 | ✓ 支持 |
| PR 摘要与 AI 导出默认只含结构 | AD-18 | ✓ 支持 |
| 60s/300ms/2s 性能线 | AD-19 与发布门禁 | ✓ 支持 |
| VS Code 主题、高对比、键盘和屏幕阅读器 | AD-15；实施指南验证矩阵 | ✓ 支持 |
| Webview CSP、Workspace Trust 和本地 IPC 安全 | AD-10、AD-11 | ✓ 支持 |

### 对齐问题

#### UX-A1 — 未验证的容器假设被架构提前固化（高）

- UX 仍把 Activity Bar + TreeView + 编辑器 Webview + Problems 的混合容器标为开放假设，需要真实实现验证。
- Architecture AD-10 已将同一职责分配标为 ADOPTED 不变量。
- Epic Story 2.7 又要求进入验收时给出验证结果和最终决定。
- **影响：** 如果验证改变容器职责，将直接触碰架构不变量和 Extension/Webview 边界，产生返工。
- **建议：** 在实施 UI Story 前先完成一次可运行壳层或交互原型验证；验证通过后将 UX 假设改为已确认，或同步修改 AD-10。

#### UX-A2 — ContextLock 持久化范围存在语义冲突（高）

- UX EXPERIENCE 明确把固定状态定义为“只持续当前 VS Code 会话”，且仍标为假设。
- Epic Story 2.4 同样写明默认只持续当前会话。
- Implementation Guide 第 11 节要求把当前实体、固定状态、筛选、范围和视图模式持久化到 `workspaceState`；该存储通常可跨窗口重启保留。
- **影响：** 实现者无法确定重启 VS Code 后是否应恢复固定状态，验收结果可能互相矛盾。
- **建议：** 明确 session 的技术边界；若只持续窗口会话，应使用窗口生命周期状态或在正常关闭时清理固定标记；若允许跨重启恢复，则更新 UX 和 Story。

#### UX-A3 — 缺少 mockup / wireframe 和真实 Webview 验证（中）

- 现有 spine 对行为、token 和组件职责定义充分，但复杂图谱画布、详情区、列表等价和多状态组合尚无视觉原型证据。
- **影响：** 信息密度、焦点顺序、窄宽度切换和高对比可读性只能在实现中首次发现。
- **建议：** 在 Story 2.2/2.3 大规模实现前，先用真实 VS Code Webview 做 Project Overview、Current Context、Finding 和 stale/partial 四态原型。

#### UX-A4 — 产品默认语言与国际化范围未决（中）

- UX 明确保留该开放假设；Epic 2.1/2.7 要求形成最终决定。
- 架构正确地没有把中文文案写入服务合同，但交付计划尚未给出决定时间点。
- **建议：** 在 UI 文案与可访问性测试 fixture 固化前决定默认语言、是否首版仅中文，以及 message key/文案资源边界。

#### UX-A5 — 快捷键和响应断点尚待验证（低）

- Ctrl+Alt+G、Ctrl+Alt+P 与 900/600/360px 断点均标为候选。
- Epic 2.4 和 2.7 已包含冲突检查、内容溢出和真实 Webview 校准，因此不是覆盖缺口。
- **建议：** 保持为 Story 验收前置，不应提前写死为稳定公共契约。

### 警告

- 没有发现核心 UX surface 缺少架构承载的阻塞项。
- 当前最需要在编码前闭合的是 UX-A1 和 UX-A2；其余问题可以作为 Epic 2 的早期验证门禁处理。

## Epic 与 Story 质量审查

### 总体结构

| Epic | Story 数 | 用户价值 | 可独立交付 | Story 粒度 | 结论 |
| --- | ---: | --- | --- | --- | --- |
| Epic 1：可信本地图谱 | 8 | 明确：本地初始化、查询、诊断和恢复 | 基本成立 | 多条过大 | 有条件通过 |
| Epic 2：VS Code 结构理解 | 7 | 明确：Overview 与 Current Context | **不成立**：部分验收依赖 Epic 3 | 多条过大 | 不通过 |
| Epic 3：架构风险 | 6 | 明确：规则、Finding、IDE 与 CLI check | 可基于 Epic 1/2 工作，不依赖 Epic 4 | 部分过大 | 有条件通过 |
| Epic 4：变更审查与导出 | 7 | 明确：impact、PR Markdown 和结构导出 | 可基于之前 Epic 工作 | Story 4.7 越界且过大 | 有条件通过 |

28 条 Story 均有 As a / I want / So that 结构、需求编号和 Given/When/Then 验收。共识别 270 个 Given 场景，平均每条 Story 约 9.6 个场景，且多数场景继续包含多个独立 And 断言；测试性较强，但也直接暴露出 Story 普遍过大的问题。

### 🔴 严重违规

#### EQ-C1 — Epic 2 隐式依赖未来 Epic 3，违反 Epic 独立性

具体冲突：

- Story 2.2 要求 Project Overview 展示“循环风险”，但 Epic 1 没有对应循环检测 Story；真正的确定性循环检测直到 Story 3.3 才实现。
- FR-9 要求 Node Details 展示 Findings；Story 2.5 声称覆盖 FR-9，但其验收没有交付 Findings，实际集成发生在未来 Story 3.5。
- FR-10 同时要求 Findings、循环依赖和 PR 摘要拥有文本化呈现；Epic 2 声称完整覆盖 FR-10，但 Findings 和 PR 摘要分别到 Epic 3、Epic 4 才存在。

**影响：**

- Epic 2 无法按自身 Story 验收完整交付所声明的 FR-6、FR-9、FR-10。
- 当前 100% FR 覆盖图在“编号存在”层面成立，但部分完整需求的真实实现路径被错误归属到较早 Epic。
- 团队要么在 Epic 2 偷跑 Epic 3 能力，要么交付无法满足验收的 Epic 2。

**修复建议：**

1. 在 Epic 1 或 Epic 2 增加不依赖规则配置的基础循环投影 Story，使 Story 2.2 能独立显示循环风险；或从 Epic 2 验收移除循环风险并调整 FR-6 映射。
2. 将 Story 3.5 显式关联 FR-9，将 Story 3.5、4.3/4.4 显式关联 FR-10 的对应子能力。
3. 把 FR-9、FR-10 标记为跨 Epic 分段实现，避免宣称 Epic 2 单独完整覆盖。

#### EQ-C2 — 排除范围能力被安排在首次 rebuild 和 Analyzer 之后

具体冲突：

- Story 1.2 已执行首次确定性 rebuild，Story 1.3 已建立 Analyzer 配置摘要和输入事实。
- Story 1.5 才首次定义内置安全默认排除、EffectiveIgnoreSnapshotV1、last-valid 回退、配置 generation 和排除后事实删除。
- PRD FR-4 要求默认排除依赖目录、构建产物和生成代码；该要求应从第一次 rebuild 就生效。
- 架构又要求 AnalyzerConfigSnapshot 与 GraphPatch CAS 绑定 effective ignore snapshot，因此 Story 1.2/1.3 不能在没有最小 ignore 合同的情况下完整实现。

**影响：**

- 若严格按顺序实现，Story 1.2 可能首次索引 node_modules、构建产物和生成代码，产生错误规模、性能和结构结果。
- 若提前在 Story 1.2/1.3 私下实现 ignore，则 Story 1.5 的责任边界和验收被部分重复。

**修复建议：**

- 将 Story 1.5 移到 Story 1.2 之前；或拆成：
  - 1.x：内置安全默认排除 + generation 0 空快照，作为首次 rebuild 前置；
  - 后续 Story：用户 .codegraphignore 语法、last-valid、反选、诊断和重新纳入。

### 🟠 主要问题

#### EQ-M1 — 多条 Story 已达到小型 Epic 规模

优先拆分对象：

- **Story 1.1** 同时包含仓库脚手架、依赖边界、跨平台 IPC、单实例服务、协议握手、Workspace Trust 和初始隐私状态。
- **Story 1.2** 同时包含 Job、图谱基础模型、SQLite、GraphPatch 原子事务、CAS、确定性 rebuild、空工作区和失败恢复。
- **Story 1.3** 同时包含 Compiler API、配置摘要、语法映射、目标解析、Evidence、partial/failed 语义、冲突、删除和确定性测试。
- **Story 1.7** 同时包含四维状态、取消、watcher/reconciliation、失败降级、损坏缓存、服务重连、空闲退出和资源硬限制。
- **Story 1.8** 同时包含缓存权限、结构化日志、cache clear、遥测状态机、多客户端配置竞争和无网络验证。
- **Story 2.1、2.2、2.7、3.1、3.4、4.2、4.5、4.7** 也横跨多个模块或测试层。

这些 Story 往往包含 8–11 个 Given 场景，每个场景又有多个独立断言，难以在一个实现周期内完成、评审和回滚。

**建议：** 按“领域合同 → 适配器 → 宿主集成 → 恢复/安全 → 验证门禁”拆分，保证每条 Story 交付一个可演示的纵向切片。

#### EQ-M2 — Story 2.7 把跨切质量属性延后成收尾 Story

- 可访问性、键盘、主题、减少动态效果和响应式是每个 UI Story 的完成定义，不应在 Epic 尾部才统一补齐。
- Story 2.2–2.6 已包含部分同类验收，Story 2.7 又重复覆盖所有 surface，造成责任重叠。
- Story 2.7 只有在前面全部 surface 存在后才能完成，本质更像 Epic 级质量门禁或专项验证计划。

**建议：** 将强制可访问性/响应式条件下沉到每个 UI Story 的 DoD；保留一个较小的跨 surface 集成验收任务，而不是功能 Story。

#### EQ-M3 — Story 4.7 与 Epic 4 的目标不匹配

- Epic 4 的用户结果是审查变更和导出结构上下文。
- Story 4.7 覆盖 CLI/VSIX 打包、四种目标产物、原生 ABI、升级/降级、离线运行、产物审计和发布 CI。
- 该 Story 是全产品发布与部署工作，依赖 Epic 1–4 的全部产物，不属于“变更审查与导出”的内聚范围。

**建议：** 将其拆为独立的“安装、升级与离线交付”Epic，或将打包/兼容要求作为各 Epic 的持续发布门禁，并保留单独的发布验收项。

#### EQ-M4 — 绿地项目缺少早期 CI 管线 Story

- Story 1.1 只要求根级类型检查、lint、单元测试和构建命令成功。
- 架构要求“每次合并”执行类型、lint、单元、契约、SQLite、CLI、VS Code 冒烟、依赖边界和安全检查。
- 真正的发布 CI 直到 Story 4.7 才出现，太晚才发现跨平台、原生 ABI 或契约门禁问题。

**建议：** 在 Epic 1 早期建立最小 CI：类型/lint/unit/contract/依赖边界；随着 Story 增量加入 SQLite、CLI、VS Code 和安全门禁。

#### EQ-M5 — 关键 UX 决策缺少明确的决策型验收产物

- Story 2.7 要求对容器、默认语言、快捷键、断点和 ContextLock 会话范围给出验证结果与最终决定。
- 但未规定决策记录的文件、负责人、完成时点或架构/UX 同步机制。

**建议：** 增加明确产物，例如 UX decision record，并要求同步更新 EXPERIENCE、DESIGN、Architecture AD 与测试 fixture。

### 🟡 次要问题

#### EQ-m1 — 需求编号格式不一致

- PRD 使用 FR-1，Epic 文档使用 FR1。
- 人工阅读没有障碍，但自动 traceability、正则抽取和测试标签容易产生两套规范。
- **建议：** 统一为一种格式，并在所有规划文档和测试标签中使用。

#### EQ-m2 — 数据库增量建表责任未明确

- Epic Story 没有明确要求“一开始创建所有表”，因此尚未形成违规。
- 但 Implementation Guide 的首批表建议同时列出 findings、jobs 等后期能力表，可能诱导 Story 1.2 一次性建立未来模型。
- **建议：** 在 Story 1.2 明确只创建当前切片所需表；Findings、impact/export 等表随首次使用的 Story 增量迁移。

#### EQ-m3 — Story 1.1 使用内部开发者 Persona

- 该 Story 是架构指定 starter template 的必要绿地例外，因此可以接受。
- 仍应把“终端用户得到什么可验证能力”保持为验收结尾，例如 CLI/Extension 连接同一空服务并给出可操作状态，避免退化为纯脚手架任务。

### 符合项

- 四个 Epic 标题和目标总体以用户结果表达，不是“数据库/API/基础设施”技术里程碑。
- 未发现显式文字引用未来 Story 的情况；问题主要是能力责任上的隐式前向依赖。
- Epic 依赖方向为 1 → 2 → 3 → 4，没有循环依赖。
- 所有 Story 都有需求追踪和 BDD 验收，错误、取消、stale、安全、性能场景覆盖丰富。
- Architecture 指定的官方 VS Code TypeScript + esbuild starter template 已在 Story 1.1 明确使用。
- 未发现 Epic 文档明确要求在首个 Story 一次性创建所有未来数据库表。

## 总结与建议

### 总体实施就绪状态

# NOT READY

PRD、UX、架构和 Epic 的基础质量较高，23 条 FR 均有编号级覆盖，核心技术架构也足够具体。但当前规划还不能安全进入 Phase 4 全面实施，原因是：

1. Epic 2 存在依赖未来 Epic 3 的实质性前向依赖。
2. 首次 rebuild/Analyzer 与后续排除配置 Story 的顺序不成立。
3. 多条 Story 仍达到小型 Epic 规模，无法可靠估算和独立验收。
4. 今日已批准的 Sprint Change Proposal 尚未同步回 PRD、Architecture、UX 和 epics.md。

在达到 READY 前，应遵循已批准变更提案的边界：只允许 Story 1.1 的准备性地基与最小 CI 工作，不应并行启动其他 Epic。

### 已批准变更提案的同步状态

`sprint-change-proposal-2026-07-15.md` 状态为“已批准”，但当前源制品仍显示提案尚未实施：

| 提案目标 | 当前制品状态 | 结果 |
| --- | --- | --- |
| 5 个 Epic、36 个 Story | epics.md 仍为 4 个 Epic、28 个 Story | ❌ 未同步 |
| 新增发布 Epic 5，移除原 Story 4.7 | Story 4.7 仍位于 Epic 4 | ❌ 未同步 |
| 拆分 1.7、1.8、2.1、3.4 等大型 Story | 原大型 Story 仍存在 | ❌ 未同步 |
| 新增 OverviewMetricV1、ImpactVerdictV1、BasicSymbolV1 | Architecture Spine 仍止于 AD-24 | ❌ 未同步 |
| FR-4、FR-12、SM-4、Addendum 更新 | PRD 与 Addendum 仍为 2026-07-13 版本内容 | ❌ 未同步 |
| 关闭语言、ContextLock、Workspace Trust、Node built-in UX 歧义 | UX 仍保留相应开放假设 | ❌ 未同步 |
| FR 编号统一为 FR-1…FR-23 | epics.md 仍使用 FR1…FR23 | ❌ 未同步 |
| Story 1.1 建立最小 CI | 当前 Story 1.1 仅要求本地命令通过 | ❌ 未同步 |

**结论：** 已批准变更提案是有效修复方向，但在源文档完成修改前，不能被视为已经关闭问题。

### 需要立即处理的严重问题

#### 1. 同步已批准的 Sprint Change Proposal

按提案正式更新 Architecture、PRD/Addendum、UX 和 epics.md，并完成交叉引用检查。当前“批准但未落盘”的状态本身就是实施阻塞项。

#### 2. 修复 Epic 2 的未来依赖

- 为 Overview 的循环风险提供 Epic 2 之前已完成的基础循环投影；或移除该验收并重新映射 FR-6。
- 将 NodeDetails 的 Findings 明确映射到 Story 3.5/重编号后的对应 Story，并把 FR-9 标为跨 Epic 实现。
- 将 FR-10 的结构列表、Findings 文本和 PR 摘要文本分别映射到 Epic 2、3、4，不再宣称 Epic 2 独立完成全部 FR-10。

#### 3. 把最小排除合同移到首次 rebuild 之前

第一次索引前必须已有内置安全默认排除、generation 0 空快照和 Analyzer 可消费的有效 ignore snapshot。用户 .codegraphignore 语法、last-valid 和诊断可以后续增量实现。

### 推荐执行顺序

1. **Architecture：** 增加 OverviewMetricV1、ImpactVerdictV1、BasicSymbolV1 与 CI 首次落地规则，同时补充基础循环投影和最小 ignore snapshot 的 Story 归属。
2. **PRD/Addendum：** 更新 FR-4、FR-12、SM-4；回写 NFR 稳定编号；补充支持平台/版本、资源基线、可访问性量化和本地服务威胁边界。
3. **UX：** 明确容器职责是否正式采用；确定 zh-CN/en 规则；明确 ContextLock 不写 workspaceState；补充未信任工作区和 Node built-in 语义。
4. **Epics：** 重构为 5 个 Epic、36 个可估算 Story；修复 EQ-C1/EQ-C2；将 Story 2.7 改为纯系统级验证；把发布能力移入 Epic 5。
5. **CI 与一致性：** 从 Story 1.1 建立最小 CI，并加入 FR 编号、文档链接、Architecture AD、Story 关联需求的静态一致性检查。
6. **复评：** 重新运行 Implementation Readiness；只有 Critical=0、前向依赖=0、批准提案全部同步后，才能将状态改为 READY。

### 问题统计

- 总计：24 项
- Critical：3 项
- High / Major：7 项
- Medium：10 项
- Low / Minor：4 项
- 涉及类别：PRD 完整性、UX 对齐、Epic/Story 质量、已批准变更同步

### 最终说明

本次评估不是否定产品方向或架构主干。产品愿景、MVP 范围、23 条 FR 的总体覆盖和核心架构均可保留。阻塞集中在执行顺序、Story 边界、跨 Epic 责任和已批准变更尚未落盘。完成上述修订后，项目具备较高概率在下一次复评达到 READY。

**评估日期：** 2026-07-15  
**评估者：** Winston（System Architect）/ Implementation Readiness Workflow
