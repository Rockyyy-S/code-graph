---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
assessmentStatus: NOT_READY
assessor: Winston / Implementation Readiness
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
    - ux-designs/ux-bmad-2026-07-13/DESIGN.md
    - ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-14
**Project:** bmad

## 文档发现

### 纳入评估

- PRD：`prds/prd-bmad-2026-07-09/prd.md`、`prds/prd-bmad-2026-07-09/addendum.md`
- Architecture：`architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`、`architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md`
- Epics & Stories：`epics.md`
- UX：`ux-designs/ux-bmad-2026-07-13/DESIGN.md`、`ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`

### 辅助或排除资料

- Architecture 的 `reviews/` 目录及 UX 的 `reconcile-prd.md` 作为辅助材料，不作为主文档。
- 各文档集中的 `.memlog.md` 不纳入评估。
- 未发现整篇文档与分片文档并存的重复冲突；目录型文档集虽无 `index.md`，但评估文件范围已由用户确认。

## PRD 分析

### 功能需求

#### FR-1：初始化工作区图谱

用户可以通过 VS Code 命令或 CLI 对当前工作区执行首次图谱构建。实现 UJ-1。

- 在受支持工作区执行初始化时，系统生成可查询的项目代码图谱。
- 系统识别常见 npm、Yarn 与 pnpm workspace/package 边界；无法识别时仍可退化为普通单工作区索引。
- 工作区缺少受支持语言文件时，系统给出空状态和可操作提示，而不是报错退出。
- 初始化结果包含图谱生成时间、索引文件数、节点数、边数和排除路径摘要。

#### FR-2：提取 TypeScript/JavaScript 依赖关系

系统必须提取 TypeScript/JavaScript 文件之间的 import/export 关系和外部包依赖。实现 UJ-1、UJ-2。

- 识别 ES module import/export、常见 TypeScript path alias、package import。
- 在 monorepo 中识别跨 workspace package 的 TS/JS import，并将文件级证据聚合为 package 依赖边。
- 每条依赖边记录来源、置信度、语言、文件范围和最后检测时间。
- 无法确定的动态依赖不得伪装成精确依赖，必须标记为低置信或暂不纳入。

#### FR-3：保存后增量更新

用户保存受支持文件后，系统在本地增量更新相关图谱数据。实现 UJ-2、UJ-3。

- 对保存事件进行 debounce 或 settle 处理，避免 git pull、分支切换或批量生成文件时频繁重建。
- 内容 hash 未变化时不得重复解析同一文件。
- 增量更新完成后，当前视图显示最新状态或明确标记仍为 stale。

#### FR-4：路径排除与噪声控制

用户可以排除 node_modules、构建产物、生成代码和自定义路径，防止图谱污染。实现 UJ-1、UJ-2。

- 默认排除常见依赖目录和构建产物。
- 用户可通过配置文件声明额外排除路径。
- 被排除路径不参与节点、边、规则检查和成功指标统计。

#### FR-5：图谱版本、稳定 ID 与过期状态

系统必须为图谱 schema、节点、边和索引状态提供稳定标识与版本信息。

- 节点和边 ID 不依赖数据库自增主键。
- 图谱数据包含 schema version，旧版本数据可触发迁移或重建提示。
- 源文件变化但索引未完成时显示 stale 状态。

#### FR-6：项目结构概览

用户打开工作区后，可以查看目录/模块之间的真实依赖概览。实现 UJ-1。

- 概览以目录或模块为主要节点，而不是展示所有文件。
- 展示依赖方向、依赖强度、循环风险和图谱更新时间。
- 用户可以从目录/模块节点下钻到相关文件或局部邻域。

#### FR-7：当前文件邻域图

用户打开代码文件时，系统自动展示当前文件的依赖邻域。实现 UJ-2。

- 至少区分当前文件、直接依赖、反向依赖和外部包。
- 默认展示 1 跳关系，单次查询和渲染预算上限为 100 个节点、200 条边。
- 超过预算时，按相关性将远端内容折叠为目录或 workspace package 聚合节点。
- 用户可主动展开聚合节点；每次展开仍返回受预算限制的局部子图，不允许无上限追加全局图。

#### FR-8：聚焦追踪与视图固定

系统可以跟随用户当前文件切换更新图谱，也允许用户固定当前视图。实现 UJ-2。

- 用户切换文件时，默认聚焦新文件。
- 用户启用固定后，切换文件不会替换当前图谱。
- 固定状态在当前 VS Code 会话中可见且可解除。

#### FR-9：节点导航与上下文操作

用户可以从图谱节点跳转到文件、目录或符号位置。实现 UJ-1、UJ-2。

- 点击文件节点可在 VS Code 中打开对应文件。
- 节点详情展示路径、类型、入边、出边、更新时间和 findings。
- 节点对应文件不存在或已移动时提示重新索引。

#### FR-10：多视图基础能力

MVP 至少提供局部关系图和结构列表两种呈现方式；大图场景不得只依赖力导向图。

- 当前文件邻域可用图形方式探索。
- findings、循环依赖和 PR 摘要可用列表或表格方式阅读。
- 对键盘用户或无法理解图形的用户，核心信息有文本替代呈现。

#### FR-11：循环依赖检测

系统必须检测受支持图谱范围内的文件级和目录/模块级循环依赖。实现 UJ-3、UJ-4。

- 列出循环链路中的节点和边。
- 区分已有循环与本次变更新增循环。
- 循环 finding 包含严重级别、范围和可定位文件。

#### FR-12：目录与层级依赖规则

用户可以声明基础架构规则，例如禁止某目录引用某目录，或限制层级依赖方向。实现 UJ-3、UJ-4。

- 通过 .codegraph/rules.yaml 配置架构规则，规则文件必须声明 version: 1。
- v1 只支持 forbidden-dependency、layer-order、no-cycle 三种固定规则类型。
- 每条规则必须包含唯一稳定的 id、type 和 severity；severity 只支持 warning 与 error。
- forbidden-dependency 使用 from 和 to 路径模式禁止指定依赖方向；layer-order 按声明顺序限制层级依赖方向；no-cycle 按 file、directory 或 package 范围检查循环。
- 路径相对于工作区根目录并统一使用 /；glob 中 * 匹配单个路径段，** 可跨目录匹配。
- 支持全局 ignore 路径列表，用于排除测试、生成代码等内容。
- 在 rebuild、保存后更新和 CLI check 时执行规则。
- 重复 ID、未知字段、未知规则类型、缺失必填字段或非法枚举值必须给出文件位置和修复提示，不得静默忽略。
- v1 不支持任意布尔表达式、正则组合、符号级规则、规则继承或可视化规则编辑。

#### FR-13：保存后 findings 提示

保存变更引入结构风险时，系统在 IDE 中展示 findings。实现 UJ-3。

- 展示规则名、严重级别、新增边、相关路径和检测时间。
- 用户可以从 finding 跳转到触发文件。
- 不得用模糊告警替代可定位的依赖边或规则。

#### FR-14：风险解释

系统必须解释结构风险为什么发生，而不只是给出错误码。

- 循环依赖 finding 展示完整或折叠后的循环路径。
- 跨层违规 finding 展示实际依赖方向和期望规则。
- 对已知限制或低置信结果明确标注置信度或数据来源。

#### FR-15：CLI 规则检查

用户可以通过 CLI 在本地执行规则检查并获得机器可读和人可读输出。实现 UJ-4。

- 存在 error 级违规时返回非零退出码；只有 warning 时默认返回零。
- 输出包含 summary、findings 列表和可选 JSON。
- 不要求连接云服务。

#### FR-16：读取本地变更集合

用户可以通过 CLI 或 VS Code 命令选择当前工作树、暂存区或指定 base 分支作为变更集合。实现 UJ-4。

- 识别新增、删除、修改和移动的受支持文件。
- 在图谱中标记受变更影响的节点和边。
- git 信息不可用时给出可理解错误和替代命令建议。

#### FR-17：结构变化摘要

系统必须输出本次变更造成的结构变化。实现 UJ-4。

- 列出新增依赖边、删除依赖边、受影响目录/模块、循环变化和规则违规。
- 区分本次新增风险与历史既有风险。
- 避免渲染全量图，只展示与变更集合相关的预算内子图或列表。

#### FR-18：Markdown PR Review 输出

用户可以生成适合复制到 PR review 的 Markdown 摘要。实现 UJ-4。

- 包含总体 verdict、主要风险、关键路径和建议复查文件。
- 路径使用相对路径。
- 不包含源码内容，除非用户显式开启。

#### FR-19：本地隐私边界

结构影响分析默认不上传源码、diff 或图谱数据。实现 UJ-4、UJ-5。

- 默认配置下，CLI 和插件不发起远程上传。
- MVP 默认关闭遥测，核心功能不得依赖遥测开启。
- 用户可显式 opt-in 匿名产品与性能遥测；遥测不得包含源码、diff、完整文件路径、符号名称、图谱内容或规则内容。
- 用户可随时关闭遥测并查看本地生效状态；首轮试用也可通过访谈和用户主动导出的诊断报告收集反馈。
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

- 插件可请求项目概览、当前文件邻域、findings 和 stale 状态。
- CLI 复用同一查询能力。
- 查询服务返回 view model 或结构化数据，不暴露渲染库内部格式。

#### FR-22：图谱状态与故障恢复

系统必须让用户知道图谱是否可用、是否过期、是否构建失败。

- 插件显示 idle、indexing、stale、failed 等状态。
- 构建失败时展示错误摘要和日志位置。
- 用户可以执行重建以恢复损坏或过期图谱。

#### FR-23：结构上下文导出

用户可以导出当前文件邻域、相关规则和 findings 的结构上下文，用于 AI 工具或人工沟通。实现 UJ-5。

- 包含路径、节点类型、依赖边、规则 findings 和图谱更新时间。
- 默认不包含源码正文。
- 受图谱预算限制，避免一次性输出全仓库上下文。

功能需求总数：23。

### 非功能需求

#### 性能

- NFR-1：标准验收项目不超过 5,000 个受支持源码文件、500,000 行源码和 50 个 workspace package；node_modules、构建产物、生成代码和排除路径不计入规模。
- NFR-2：标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD 的本地开发机器。
- NFR-3：在标准验收项目和参考环境下，系统应在 60 秒内生成第一版项目结构概览。
- NFR-4：打开文件后，缓存邻域图应在 300ms 内显示，后台刷新可异步完成。
- NFR-5：保存文件后，局部依赖更新和 findings 刷新应在 2 秒内完成。
- NFR-6：默认邻域图的单次查询和渲染预算上限为 100 个节点、200 条边。
- NFR-7：超出标准验收规模时暂不承诺相同 SLA，但系统不得阻塞编辑器，必须显示索引进度并允许取消或重建。

#### 可靠性

- NFR-8：索引、查询和布局不得阻塞 VS Code extension host。
- NFR-9：git pull、分支切换、依赖安装和批量生成文件不应造成无限重建。
- NFR-10：图谱构建失败时，已有缓存仍可作为 stale 数据查看，并清楚标注状态。
- NFR-11：系统必须能从损坏缓存中重建。

#### 安全与隐私

- NFR-12：源码、图谱、diff 和结构摘要默认仅保存在本地。
- NFR-13：本地图谱服务默认只监听本机访问范围。
- NFR-14：用户应能清理本地图谱数据。
- NFR-15：遥测默认关闭；即使用户 opt-in，也只收集匿名功能使用事件、耗时、计数和错误分类，不收集项目内容或可反推出项目结构的标识。
- NFR-16：云端同步与团队共享必须作为独立能力另行设计和授权，不进入 MVP 主路径。

#### 可用性与可访问性

- NFR-17：核心 findings、循环依赖和 PR 摘要必须有文本化呈现，不能只依赖图形理解。
- NFR-18：图谱节点、边、严重级别和 stale 状态应具备一致的视觉语义。
- NFR-19：用户可以固定当前视图，避免因切换文件导致上下文丢失。
- NFR-20：空状态、错误状态和规则语法错误必须提供下一步操作。

#### 可演进性

- NFR-21：图谱持久模型不得绑定具体渲染库格式。
- NFR-22：节点和边必须使用稳定 ID，并记录来源、置信度、版本和更新时间。
- NFR-23：分析器、存储、查询和渲染层应保留可替换边界，支持后续接入更多语言、SCIP、矩阵视图或 MCP server。

非功能需求总数：23。

### 附加需求与约束

#### 产品与交付边界

- MVP 优先验证“当前文件影响哪里”和“是否破坏结构边界”，不追求全语言、全调用图或全局大图。
- MVP 分段交付：首个可用版本优先完成 IDE 项目结构概览、当前文件邻域图和保存后增量更新；Beta+ 加入基础架构规则与本地 PR 结构影响摘要。
- PR 工作流从本地 CLI 与 Markdown 摘要开始，首版不实现 hosted PR app。
- AI 方向仅提供本地结构上下文导出；MCP server 延后到 v1.1，且只有 SM-1 至 SM-4 达标并验证导出价值后才启动。
- MVP 不包含全语言、精准运行时调用图、数据流/CPG 安全分析、云端协作、账号/SSO/权限、hosted PR app、AI 自动重构、MCP server、可视化规则编辑器、独立 Web dashboard、历史趋势、跨仓库图谱和必需的重型图数据库。

#### 数据治理与复杂度护栏

- 本地图谱数据默认写入工作区内可识别位置或用户级缓存目录；具体位置由架构确认。
- 图谱文件、缓存和日志默认不应被误提交，项目模板应建议加入 .gitignore。
- 导出默认只包含结构信息，不包含源码正文。
- MVP 不引入必须运行的云服务，不要求重型图数据库、跨语言全量索引或 CPG 数据流分析。
- VS Code 插件为薄客户端，重索引和图查询由本地图谱服务承担。

#### Addendum 技术边界

- 索引器、图查询、规则引擎位于独立本地图谱服务。
- 存储层通过 GraphStore 接口访问，避免业务逻辑散落 SQL。
- 分析能力通过 AnalyzerAdapter 接入 Tree-sitter、LSP，未来可接 SCIP/CPG。
- 可视化层消费 GraphViewModel，不把 Cytoscape.js JSON 作为持久模型。
- 节点和边需要稳定 ID、来源、置信度、版本和更新时间。
- 文件监听需要 debounce、settle、hash check 和 batch queue。
- 候选栈为 VS Code Extension + CLI、TypeScript/Node.js、Tree-sitter + 有限 TypeScript/LSP、SQLite、Cytoscape.js、本地规则引擎及本地 git diff。
- Alpha 可将 monorepo 退化为普通工作区索引；Beta 必须识别 npm/Yarn workspaces、pnpm-workspace.yaml，并可将 TypeScript project references 作为边界和依赖补充来源。
- layer-order 按从上到下声明，每层可依赖自身及后续层，不得反向依赖前层；规则 ID 在 IDE findings、CLI JSON 和 CI 输出中保持稳定。

#### 成功指标与反向指标

- SM-1：用户在 3 分钟内回答“改这个文件会影响哪里”。
- SM-2：打开文件后 300ms 内显示缓存邻域图并后台刷新。
- SM-3：保存文件后 2 秒内完成局部依赖更新和 findings 刷新。
- SM-4：import/export 依赖识别准确率达到 80% 以上。
- SM-5：标准项目与参考环境下首次 rebuild 在 60 秒内生成第一版概览。
- SM-6：规则检查发现循环依赖和配置的跨层规则违反。
- SM-7：完成 UJ-2 后，至少 70% 有效试用者对理解速度提升评分达到 4/5 或以上。
- SM-8：PR Markdown 摘要可被 Tech Lead 直接用于 review 讨论。
- 不以全局大图节点数、findings 数量、支持语言数量、AI 自动修改成功率或单纯图形美观度替代核心成功指标。

#### 待架构确认

- 本地图谱文件的默认位置、命名、清理策略和 .gitignore 建议。
- GraphStore、AnalyzerAdapter、GraphQueryService、RulesEngine、RendererAdapter 的边界。
- workspace/file/symbol/package 稳定 ID 的 URI 规范。
- rules.yaml 的解析库、诊断位置格式与 schema 校验实现。
- CLI 命令命名、输入输出格式和退出码语义。
- VS Code 插件使用 Webview、TreeView 或混合方案的边界。
- PR Markdown 摘要模板。
- AI 工具结构上下文导出格式。

### PRD 完整性初评

PRD 的主体完整度较高：产品定位、目标用户、五条关键旅程、23 条稳定编号功能需求、可测试后果、23 条跨功能非功能需求、MVP 边界、阶段发布计划、成功指标与反向指标均已明确，且 addendum 将技术输入与产品需求分离。

需要在后续覆盖与架构一致性检查中重点关注：

- FR-4 的“额外排除路径配置文件”未在主体中命名，而 addendum 的性能边界出现 .codegraphignore，FR-12 又定义 rules.yaml 的全局 ignore；三者职责需要保持一致。
- SM-4 的“依赖识别准确率达到 80%”尚未定义标注样本、准确率口径及测量流程。
- “常见 workspace”“基础符号”“可理解错误”等措辞仍需通过架构契约或验收测试进一步具象化。
- 主 PRD 声明“无阻塞性开放问题”和“无未确认假设”，但 addendum 仍列出 8 项待架构确认事项；这些不一定阻塞产品定义，但必须在实现前由架构文档关闭或显式延期。

## Epic 覆盖验证

### Epic FR 覆盖提取

- Epic 1：FR1、FR2、FR4、FR5、FR19、FR21、FR22。
- Epic 2：FR3、FR6、FR7、FR8、FR9、FR10。
- Epic 3：FR11、FR12、FR13、FR14、FR15。
- Epic 4：FR16、FR17、FR18、FR20、FR23。

### 覆盖矩阵

| FR | PRD 需求 | Epic / Story 覆盖 | 状态 |
| --- | --- | --- | --- |
| FR1 | 初始化工作区图谱 | Epic 1；Story 1.2、1.4 | ✓ 已覆盖 |
| FR2 | 提取 TS/JS 依赖关系与证据 | Epic 1；Story 1.3、1.4 | ✓ 已覆盖 |
| FR3 | 保存后增量更新 | Epic 2；Story 2.6 | ✓ 已覆盖 |
| FR4 | 路径排除与噪声控制 | Epic 1；Story 1.5 | ✓ 已覆盖 |
| FR5 | 图谱版本、稳定 ID 与过期状态 | Epic 1；Story 1.2、1.3、1.7 | ✓ 已覆盖 |
| FR6 | 项目结构概览 | Epic 2；Story 2.2 | ✓ 已覆盖 |
| FR7 | 当前文件邻域图 | Epic 2；Story 2.3 | ✓ 已覆盖 |
| FR8 | 聚焦追踪与视图固定 | Epic 2；Story 2.4 | ✓ 已覆盖 |
| FR9 | 节点导航与上下文操作 | Epic 2；Story 2.5 | ✓ 已覆盖 |
| FR10 | 图与结构列表两种呈现 | Epic 2；Story 2.2、2.3、2.7 | ✓ 已覆盖 |
| FR11 | 循环依赖检测 | Epic 3；Story 3.3 | ✓ 已覆盖 |
| FR12 | 目录与层级依赖规则 | Epic 3；Story 3.1、3.2、3.3 | ✓ 已覆盖 |
| FR13 | 保存后 Findings 提示 | Epic 3；Story 3.4、3.5 | ✓ 已覆盖 |
| FR14 | 风险解释 | Epic 3；Story 3.2、3.3、3.4、3.5 | ✓ 已覆盖 |
| FR15 | CLI 规则检查 | Epic 3；Story 3.6 | ✓ 已覆盖 |
| FR16 | 读取本地变更集合 | Epic 4；Story 4.1 | ✓ 已覆盖 |
| FR17 | 结构变化摘要 | Epic 4；Story 4.2、4.3 | ✓ 已覆盖 |
| FR18 | Markdown PR Review 输出 | Epic 4；Story 4.4 | ✓ 已覆盖 |
| FR19 | 本地隐私边界 | Epic 1；Story 1.1、1.8、4.7 | ✓ 已覆盖 |
| FR20 | CLI rebuild/query/check/impact/export | Epic 4；Story 4.6、4.7 | ✓ 已覆盖 |
| FR21 | 统一本地图谱查询服务 | Epic 1；Story 1.1、1.6、4.7 | ✓ 已覆盖 |
| FR22 | 图谱状态与故障恢复 | Epic 1；Story 1.1、1.2、1.6、1.7、2.1、2.6、4.7 | ✓ 已覆盖 |
| FR23 | 结构上下文导出 | Epic 4；Story 4.5 | ✓ 已覆盖 |

### 缺失需求

- 未发现 PRD 功能需求缺失覆盖。
- 未发现 Epic 文档声明了 PRD 中不存在的额外 FR 编号。
- 本步骤只验证需求是否有可追踪实施路径，不评价 Story 拆分质量或验收标准质量。

### 覆盖统计

- PRD 功能需求总数：23。
- Epic 中覆盖的 PRD 功能需求：23。
- 缺失覆盖：0。
- 声明覆盖率：100%。

## UX 对齐评估

### UX 文档状态

已找到并完整读取两份 final 状态的 UX 主文档：

- ux-designs/ux-bmad-2026-07-13/DESIGN.md
- ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md

两份文档分别定义视觉设计契约与信息架构、交互、状态、性能和可访问性契约。当前没有 mockup、wireframe 或导入视觉素材，UX 文档明确要求后续视觉参考不得覆盖两份 spine。

### UX ↔ PRD 对齐

- PRD 的 UJ-1 至 UJ-5 均在 EXPERIENCE.md 中形成同编号 Key Flow，包含正常路径、高潮点和失败路径。
- FR6–FR10 的 Overview、Current Context、导航、ContextLock、图/列表等价能力均有明确 surface、组件和状态设计。
- FR13–FR14 的 Findings、规则证据、风险解释与精确跳转已由 FindingRow、Problems、NodeDetails 和 StatusBanner 覆盖。
- FR17–FR18 的 Changes / PR Summary、总体 verdict、新增/既有风险和 Markdown 预览已形成完整交互路径。
- FR22 的 idle/indexing/stale/failed/cancelled/partial、缓存保留和重建路径均被 UX 状态模型覆盖。
- FR23 的结构上下文导出、范围预览、默认不含源码和失败重试均被 ExportPreview 覆盖。
- 60 秒首次概览、300ms 缓存邻域、2 秒保存更新、100 节点/200 边预算与超规模降级规则与 PRD 一致。
- 默认本地、遥测关闭、相对路径和不上传源码/diff/图谱的隐私边界一致。

UX 对 PRD 的主要新增细化包括 WCAG 2.2 AA 目标、键盘语义、24×24 CSS px 图节点目标、响应式断点、减少动态效果、VS Code surface 分工及候选快捷键。这些属于对既有可访问性和宿主体验要求的具体化，没有扩大产品功能边界。

### UX ↔ Architecture 对齐

| UX 关注点 | 架构支持 | 结论 |
| --- | --- | --- |
| Activity Bar/TreeView、Webview、Problems、Status Bar 分工 | AD-10 与实施指南模块职责 | 对齐 |
| 图与列表任务等价、键盘、屏幕阅读器、高对比、减少动态效果 | AD-15、webview 模块与验收门禁 | 对齐 |
| 预算内 GraphViewModel、聚合、expand token | AD-7 与查询合同 | 对齐 |
| 后台刷新保留中心、选择、展开、缩放和列表位置 | AD-7、AD-15、GraphViewPatchV1 | 对齐 |
| indexing/stale/partial/failed/cancelled 状态与缓存保留 | AD-7、AD-8、状态合同 | 对齐 |
| 60s/300ms/2s 性能线及不阻塞宿主 | AD-19 与发布门禁 | 对齐 |
| Findings 稳定身份、新增/既有/过期语义 | AD-9、AD-17 | 对齐 |
| PR 摘要和 AI 导出默认 structure-only | AD-18 | 对齐 |
| 本地隐私、遥测关闭、Workspace Trust 与 Webview CSP | AD-11、AD-16 | 对齐 |
| Cytoscape 仅为渲染器，持久模型与渲染器解耦 | AD-7、AD-20 | 对齐 |

### 对齐问题

1. **产品默认语言与国际化范围尚未关闭。** EXPERIENCE.md 将其标记为开放假设；架构只要求 CLI 与插件术语一致，尚未定义 locale、文案资源或首版语言决策。该项不阻塞领域实现，但应在开始 UI 文案和快照测试前明确。
2. **ContextLock 的“当前会话”边界存在实现歧义。** UX 要求固定状态只持续当前 VS Code 会话；实施指南要求把固定状态写入 workspaceState。需要明确何时清除，避免状态跨重启或重新打开工作区后意外保留。
3. **未信任工作区的呈现未进入 UX 主状态表。** 架构 AD-11 要求未授予 Workspace Trust 时不启动服务、不读取项目或执行 Git；Epic Story 2.1 已定义提示，但 DESIGN.md/EXPERIENCE.md 的主状态与 Key Flow 未明确该状态，存在源文档漂移风险。
4. **Node built-in 的视觉语义在 UX 主文档中不够明确。** 架构将其建模为 external-package 下独立 externalKind=node-builtin，Story 2.2 也要求文字区分；DESIGN.md 主要只规定外部 npm 包样式。实现前应补充 built-in 的标签和图例规则。

### 警告

- 当前没有 mockup 或 wireframe。两份 UX spine 已足以约束结构和行为，因此不构成实施阻塞，但首个 Webview 切片必须通过真实 VS Code 主题、字号、窄宽度和高对比视觉验证。
- UX 中仍有需验证的 ASSUMPTION：容器组合、候选快捷键、响应式断点、WCAG 目标、24×24 目标尺寸和 ContextLock 会话范围。Epics 已为多数假设设置验收项，但完成验证后应回写 UX 主文档。

### UX 对齐结论

PRD、UX 与架构在核心体验和系统约束上高度一致，未发现阻塞级 UX/架构冲突。实施前需关闭上述 4 项契约歧义，并把验证后的假设回写到 UX spine，避免 Story 与源设计文档分叉。

## Epic 与 Story 质量审查

### 总体结构结论

- 4 个 Epic 均以用户可完成的结果命名，不是数据库、API 或基础设施技术里程碑。
- Epic 1 独立交付本地 CLI 图谱价值；Epic 2 只依赖 Epic 1；Epic 3 只依赖前序图谱与 IDE 能力；Epic 4 只依赖 Epic 1–3。
- 未发现 Story 引用尚未实现的后续 Story；显式 Story 依赖均为同 Epic 的前序 Story 或前序 Epic。
- 28 个 Story 均使用 As a / I want / So that，并具有 Given/When/Then 验收结构。
- 功能需求追踪保持完整。

文档的验收覆盖非常充分，但 Story 包体整体偏大：28 个 Story 平均约 74 行、9.6 个 BDD 场景；18 个 Story 含至少 10 个 Given 场景，14 个 Story 达到或超过 75 行。场景数量本身不是缺陷，但多个 Story 同时跨越领域逻辑、基础设施、UI、恢复、兼容和发布门禁，已经超出单一可交付 Story 的合理边界。

### 🔴 严重违规

#### Q-C1：Story 4.7 是发布 Epic，而不是单一 Story

Story 4.7“安装并离线运行跨平台 MVP”同时包含：

- npm CLI 打包与 Node 版本合同；
- 平台特定 VSIX、Node runtime 与原生 SQLite ABI；
- Windows/macOS/Linux 四类目标产物；
- 三个 VS Code 版本兼容矩阵；
- 新安装、升级、降级和服务交接；
- 断网与隐私验证；
- 产物内容审计、许可证与签名；
- 完整发布候选 CI 门禁。

这些能力具有不同的实现所有者、失败模式和验收环境，不能作为一个独立、可估算、可完成的 Story。

**建议：** 将其提升为“可安装、可升级、可离线运行”的独立用户价值 Epic，或至少拆为 CLI 发布、平台 VSIX、升级/迁移、跨平台兼容与产物审计四个 Story。

#### Q-C2：Story 2.7 把可访问性与响应式设计放成末尾大型硬化 Story

Story 2.7 同时承担图/列表任务等价、键盘、屏幕阅读器、非颜色语义、三类主题、WCAG 2.2 AA、4px 布局、减少动态效果、指针目标、四档响应式布局、UX 假设签署和多版本 VS Code 验收。

它既是 Epic 2 全部 Story 的横切质量要求，又被安排在末尾，容易形成“先实现、后补无障碍”的前向返工模式，与架构要求“首批验收、不作为后补”冲突。

**建议：** 把相关验收标准分别下沉到 Story 2.1–2.6；保留一个较小的端到端可访问性与响应式回归 Story，只负责系统级验证，不负责补齐前序实现。

### 🟠 主要问题

#### Q-M1：多个 Story 跨越过多独立责任

高风险示例：

- Story 1.7 同时覆盖状态代数、Job 进度、取消语义、watcher 对账、失败恢复、SQLite 损坏、服务重连、空闲退出和安全硬限制。
- Story 1.8 同时覆盖缓存清理、ACL、结构化日志、遥测状态机、多客户端配置竞争和无网络验证。
- Story 2.1 同时覆盖扩展激活、Workspace Trust、首次引导、全部索引状态、monorepo 状态、遥测设置、状态事件时钟、surface 分工、Webview CSP 和主题。
- Story 3.4 同时覆盖 Finding 生命周期、增量受影响范围、resolved/stale 规则、无效配置、CAS 并发、规则热更新和 2 秒性能门禁。

**建议：** 按“领域状态与合同”“基础设施恢复”“宿主呈现”“性能/并发验证”拆分；每个 Story 保留一个主要用户结果和一个主要失败域。

#### Q-M2：结构概览中的“依赖强度”和“热点”缺少判定合同

Story 2.2 要求展示依赖强度、循环风险和热点，但 PRD、UX、架构及 AC 未定义：

- 依赖强度是边数、Evidence 数、文件数还是加权指标；
- 热点的计算输入、阈值、排序和并列规则；
- partial/stale 数据下是否展示及如何标记。

这使该 AC 无法稳定实现、测试或跨版本比较。

**建议：** 在查询合同中增加版本化 ranking/metric 定义，至少明确计算公式、排序、截断、数据完整性要求和显示名称。

#### Q-M3：总体 verdict、majorRisks、keyPaths 与复查候选缺少确定性规则

Story 4.2、4.3、4.4 和 4.6 多次要求生成和消费总体 verdict、主要风险、关键路径和建议复查文件，但只定义了字段存在，没有定义：

- verdict 的枚举值；
- error/warning、循环、新增/既有/stale 对 verdict 的影响；
- 截断或 not-applicable 时的保守行为；
- majorRisks、keyPaths、复查文件的排名与稳定排序规则。

这会导致服务、CLI、VS Code 和 Markdown 输出对同一输入产生不同结论。

**建议：** 在 Story 4.2 前建立版本化 ImpactVerdictV1 与 ranking contract，并用决策表覆盖无风险、warning、error、stale、partial、截断和失败场景。

#### Q-M4：Greenfield 的持续集成基线没有早期实施 Story

架构 AR27 要求每次合并通过类型、lint、单元、契约、SQLite、CLI、VS Code 冒烟、依赖边界和安全检查，但 Story 1.1 只要求本地根命令成功；自动化 CI 直到 Story 4.7 的发布候选门禁才出现。

这意味着 Epic 1–3 期间架构门禁可能只有规范要求，没有明确的自动执行归属。

**建议：** 在 Story 1.1 增加最小 CI 工作流，或紧随其后新增 CI 基线 Story；随着能力出现逐步扩展门禁，发布 Story 只负责跨平台和发布级检查。

### 🟡 次要关注

#### Q-m1：需求编号格式不统一

PRD 使用 FR-1…FR-23，Epic 文档使用 FR1…FR23。人工阅读可映射，但自动追踪、正则检查或后续工具可能把它们识别为不同 ID。

**建议：** 全部规划文档统一使用 PRD 的稳定编号格式。

#### Q-m2：Story 1.1 使用内部开发者 Persona

Story 1.1 主要是工程脚手架与服务握手，用户角色为“项目代码图谱开发者”。这是 Greenfield starter-template 的合理例外，且 AC 包含用户可观察的空图谱状态，因此不构成技术 Epic；但应避免后续 Story 继续以内部工程活动替代用户结果。

### 依赖与数据库时点检查

- 未发现前向依赖或循环依赖。
- Story 4.2→4.1、4.3→4.1/4.2、4.4→4.2、4.6→4.1/4.4/4.5 均为合法的前序依赖。
- Story 1.1 正确采用架构指定的官方 VS Code TypeScript + esbuild starter template。
- Story 1.1 不创建图谱；SQLite 与首次图谱 schema 在 Story 1.2 首次需要时建立，未发现“第一 Story 预建全部业务表”的明确违规。
- 实现时仍应按首次使用逐步迁移 Findings、impact/export 等表或投影，避免把实施指南中的建议表一次性全部固化。

### Epic 合规矩阵

| Epic | 用户价值 | 独立性 | 无前向依赖 | Story 尺寸 | AC 清晰度 | FR 追踪 |
| --- | --- | --- | --- | --- | --- | --- |
| Epic 1 | 通过 | 通过 | 通过 | 需拆分 1.7、1.8 等 | 总体通过 | 通过 |
| Epic 2 | 通过 | 通过 | 通过 | Story 2.7 严重超载 | “热点”合同缺失 | 通过 |
| Epic 3 | 通过 | 通过 | 通过 | 3.4 等偏大 | 总体较强 | 通过 |
| Epic 4 | 通过 | 通过 | 通过 | Story 4.7 为 Epic 级 | verdict/ranking 合同缺失 | 通过 |

### Epic 质量结论

Epic 结构、依赖方向、BDD 完整度和需求追踪良好；当前不应直接把全部 Story 视为可进入 Sprint 的执行单元。至少应先拆分 Story 2.7、4.7，收缩 1.7、1.8、2.1、3.4，并补齐 Overview 指标和 impact verdict 的确定性合同以及早期 CI 归属。

## 总结与建议

### 总体实施就绪状态

**NOT READY — 当前不适合直接进入 Phase 4 的全面 Story 执行。**

PRD、UX、架构和 Epic 的覆盖基础成熟：23 条 FR 全部有追踪路径，五条用户旅程一致，架构对性能、可靠性、隐私、状态与可访问性的支撑深入且具体。阻塞不在产品方向或总体架构，而在执行合同与工作拆分：两个 Story 已达到 Epic 规模，多个关键派生结果缺少确定性判定规则，早期 CI 门禁没有明确实施归属。

这不意味着必须停止所有工作。Story 1.1 的 starter-template 与空服务垂直切片可以作为准备性工作，但在完成下列关键修订前，不建议批准完整 Sprint 计划或并行启动多个 Epic。

### 必须立即处理的关键问题

1. **拆分 Story 4.7。** 将 CLI 发布、平台 VSIX、升级/迁移、兼容矩阵和产物审计拆成独立可估算单元，或提升为新的发布 Epic。
2. **重构 Story 2.7。** 把可访问性、主题、键盘、响应式和减少动态效果要求下沉到 Story 2.1–2.6；末尾只保留端到端回归验收。
3. **定义 Overview 指标合同。** 明确依赖强度、热点、排序、并列、partial/stale 和截断语义。
4. **定义 ImpactVerdictV1。** 固定 verdict 枚举和决策表，并定义 majorRisks、keyPaths、复查候选的稳定排序。
5. **建立早期 CI 基线。** 在 Story 1.1 或紧随其后的 Story 中落地自动化类型、lint、单元、契约、边界和基础安全检查。

### 推荐后续步骤

1. 修订 epics.md：优先拆分 Story 2.7、4.7，再收缩 Story 1.7、1.8、2.1、3.4。
2. 在架构合同与相应 Story AC 中补充 OverviewMetricV1 与 ImpactVerdictV1。
3. 把最小 CI 工作流纳入 Epic 1 的最前序实施路径，并注明后续门禁增量加入时点。
4. 关闭 UX 契约歧义：默认语言/i18n、ContextLock 会话边界、未信任工作区状态、Node built-in 视觉语义。
5. 统一 FR-1…FR-23 编号，并更新 PRD/addendum 中已由最终架构关闭或取代的待确认项。
6. 为 SM-4 定义标注样本、准确率口径、测试数据与验收流程。
7. 完成修订后重新运行 Implementation Readiness，确认关键项清零后再批准 Phase 4 Sprint。

### 最终说明

本次评估记录了 16 项问题或待关闭事项，覆盖 PRD 清晰度、UX 契约、Epic/Story 质量和交付治理四类，其中 2 项为严重 Story 结构问题。先解决严重问题和关键合同缺口，可在不改变产品愿景与总体架构的前提下，把现有高质量规划材料转化为真正可估算、可并行、可验收的实施计划。

**评估日期：** 2026-07-14  
**评估人：** Winston / Implementation Readiness
