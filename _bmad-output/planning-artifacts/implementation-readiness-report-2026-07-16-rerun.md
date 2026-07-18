---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
overallReadiness: NEEDS_WORK
includedFiles:
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
supportingEvidence:
  - prds/prd-bmad-2026-07-09/reconcile-implementation-readiness-2026-07-15.md
  - prds/prd-bmad-2026-07-09/review-rubric.md
  - architecture/architecture-bmad-2026-07-13/reviews/
  - ux-designs/ux-bmad-2026-07-13/reconcile-prd.md
  - ux-designs/ux-bmad-2026-07-13/reconcile-sprint-change-proposal.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-16
**Project:** bmad

## 文档发现与输入清单

### PRD

- `prds/prd-bmad-2026-07-09/prd.md`（36,866 字节，修改于 2026-07-15 17:48:59）
- `prds/prd-bmad-2026-07-09/addendum.md`（14,579 字节，修改于 2026-07-15 17:50:17）
- 同目录校对与审查文档作为辅助证据，不作为主规范替代品。

### 架构

- `architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`（58,425 字节，修改于 2026-07-15 16:52:05）
- `architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md`（60,940 字节，修改于 2026-07-15 16:52:25）
- `reviews/` 下 75 份审查文档作为辅助证据，不作为架构主文档替代品。

### Epics 与 Stories

- `epics.md`（136,095 字节，修改于 2026-07-16 09:48:49）

### UX

- `ux-designs/ux-bmad-2026-07-13/DESIGN.md`（13,405 字节，修改于 2026-07-15 18:40:37）
- `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`（22,922 字节，修改于 2026-07-15 18:40:37）
- 同目录协调文档作为辅助证据，不作为 UX 主规范替代品。

### 发现结论

- 未发现同一文档同时存在整篇版与标准分片版的重复冲突。
- PRD、架构和 UX 使用文件夹化文档集，但未提供标准 `index.md`；本次依据用户确认的核心文件清单进行评估。
- 所需四类规划输入均已定位，无阻塞性缺失。

## PRD 分析

### 功能需求

#### FR-1：初始化工作区图谱

用户可以通过 VS Code 命令或 CLI 对当前工作区执行首次图谱构建，实现 UJ-1。

- 在受支持工作区初始化时生成可查询的项目代码图谱。
- 识别常见 npm、Yarn 与 pnpm workspace package 边界；无法识别时退化为普通单工作区索引。
- 工作区缺少受支持语言文件时显示空状态和可操作提示，不以错误退出。
- 初始化结果包含生成时间、索引文件数、节点数、边数和排除路径摘要。

#### FR-2：提取 TypeScript/JavaScript 依赖关系

系统必须提取 TypeScript/JavaScript 文件之间的 import/export 关系和外部包依赖，实现 UJ-1、UJ-2。

- 识别 ES module import/export、常见 TypeScript path alias 和 package import。
- 在 monorepo 中识别跨 workspace package 的 TS/JS import，并将文件级证据聚合为 package 依赖边。
- 每条依赖边记录来源、置信度、语言、文件范围和最后检测时间。
- 无法确定的动态依赖不得伪装为精确依赖，必须标记为低置信或暂不纳入。
- BasicSymbolV1 只提取 TypeScript/JavaScript 源文件顶层且具有稳定名称与可导航范围的 function、class、interface、type-alias、enum、variable、namespace。
- MVP 不提取成员、参数、局部变量、import alias、匿名声明、调用图或 references；这些对象不得进入符号导航、结构导出或成功指标。

#### FR-3：保存后增量更新

用户保存受支持文件后，系统在本地增量更新相关图谱数据，实现 UJ-2、UJ-3。

- 对保存事件进行 debounce 或 settle，避免 git pull、分支切换或批量生成文件导致频繁重建。
- 内容 hash 未变化时不得重复解析同一文件。
- 增量更新后显示最新状态，或明确标记仍为 stale。

#### FR-4：路径排除与噪声控制

用户可以通过内置安全默认项和工作区根目录的 .codegraphignore 排除依赖目录、构建产物、生成代码和自定义路径，防止图谱污染，实现 UJ-1、UJ-2。

- 首次 rebuild 和首次 Analyzer 运行前应用内置安全默认排除；即使 .codegraphignore 不存在，也提供包含内置规则的 generation 0 有效排除快照。
- 用户通过 .codegraphignore 声明额外排除或显式重新纳入路径；有效快照、无效诊断和 last-valid 回退由本地图谱服务统一管理。
- 命中有效索引排除的路径不产生节点、边或 Evidence，不参与 workspace package 聚合、规则检查或成功指标。
- 重新纳入路径后沿用原确定性 ID，不把同一实体误识别为新对象。

#### FR-5：图谱版本、稳定 ID 与过期状态

系统必须为图谱 schema、节点、边和索引状态提供稳定标识与版本信息。

- 节点和边 ID 不依赖数据库自增主键。
- 图谱数据包含 schema version；旧版本数据可触发迁移或重建提示。
- 源文件变化但索引未完成时显示 stale 状态。

#### FR-6：项目结构概览

用户打开工作区后，可以查看目录/模块之间的真实依赖概览，实现 UJ-1。

- 概览以目录或模块为主要节点，而不是展示所有文件。
- 展示依赖方向、依赖强度、循环风险和图谱更新时间。
- 可以从目录/模块节点下钻到相关文件或局部邻域。

#### FR-7：当前文件邻域图

用户打开代码文件时，系统自动展示当前文件的依赖邻域，实现 UJ-2。

- 至少区分当前文件、直接依赖、反向依赖和外部包。
- 默认展示 1 跳关系，单次查询和渲染预算上限为 100 个节点、200 条边。
- 超出预算时，按相关性将与焦点节点距离较远的节点和边折叠为目录或 workspace package 聚合节点。
- 用户可以主动展开聚合节点；每次展开仍返回受预算限制的局部子图，不允许无上限追加全局图。

#### FR-8：聚焦追踪与视图固定

系统可以跟随用户当前文件切换更新图谱，也允许用户固定当前视图，实现 UJ-2。

- 切换文件时默认聚焦新文件。
- 用户启用固定后，切换文件不会替换当前图谱。
- 固定状态在当前 VS Code 会话中可见且可解除。

#### FR-9：节点导航与上下文操作

用户可以从图谱节点跳转到文件、目录或符号位置，实现 UJ-1、UJ-2。

- 点击文件节点可在 VS Code 中打开对应文件。
- 节点详情展示路径、类型、入边、出边、更新时间和 findings。
- 节点对应文件不存在或已移动时提示重新索引。

#### FR-10：多视图基础能力

MVP 至少提供局部关系图和结构列表两种呈现方式；大图场景不得只依赖力导向图。

- 当前文件邻域可用图形方式探索。
- findings、循环依赖和 PR 摘要可用列表或表格阅读。
- 键盘用户或无法理解图形的用户具有核心信息的文本替代呈现。

#### FR-11：循环依赖检测

系统必须检测受支持图谱范围内的文件级和目录/模块级循环依赖，实现 UJ-3、UJ-4。

- 列出循环链路中的节点和边。
- 区分已有循环与本次变更新增循环。
- 循环 finding 包含严重级别、范围和可定位文件。

#### FR-12：目录与层级依赖规则

用户可以声明基础架构规则，例如禁止某目录引用某目录，或限制层级依赖方向，实现 UJ-3、UJ-4。

- 通过 .codegraph/rules.yaml 配置规则，并声明 version: 1。
- v1 只支持 forbidden-dependency、layer-order、no-cycle 三种固定类型。
- 每条规则包含唯一稳定的 id、type 和 severity；severity 仅支持 warning 与 error。
- forbidden-dependency 使用 from/to 路径模式；layer-order 按声明顺序限制依赖方向；no-cycle 按 file、directory 或 package 范围检查循环。
- 路径相对于工作区根目录并统一使用 /；glob 的 * 匹配单路径段，** 可跨目录。
- rules.yaml 的全局 ignore 只裁剪规则评估范围；命中的实体仍保留在规范图谱、普通查询、workspace package 聚合和索引规模统计中。
- 索引范围只能由内置默认项和 .codegraphignore 改变；同一路径在 rules ignore 下不得产生 finding，在 .codegraphignore 下不得进入图谱。
- rebuild、保存后更新和 CLI check 均执行规则。
- 重复 ID、未知字段或类型、缺失必填字段、非法枚举值必须产生带文件位置和修复提示的诊断，不得静默忽略。
- v1 不支持任意布尔表达式、正则组合、符号级规则、规则继承或可视化规则编辑。

#### FR-13：保存后 Findings 提示

保存变更引入结构风险时，系统在 IDE 中展示 findings，实现 UJ-3。

- Finding 展示规则名、严重级别、新增边、相关路径和检测时间。
- 可以从 finding 跳转到触发文件。
- 不得用模糊告警替代可定位的依赖边或规则。

#### FR-14：风险解释

系统必须解释结构风险发生原因，而不只是给出错误码。

- 循环依赖 finding 展示完整或折叠后的循环路径。
- 跨层违规 finding 展示实际依赖方向和期望规则。
- 已知限制或低置信度结果明确标注置信度或数据来源。

#### FR-15：CLI 规则检查

用户可以通过 CLI 在本地执行规则检查并获得机器可读和人类可读输出，实现 UJ-4。

- 存在 error 级违规时返回非零退出码；只有 warning 时默认返回零。
- 输出包含 summary、findings 列表和可选 JSON。
- 不要求连接云服务。

#### FR-16：读取本地变更集合

用户可以通过 CLI 或 VS Code 命令选择当前工作树、暂存区或指定 base 分支作为变更集合，实现 UJ-4。

- 识别新增、删除、修改和移动的受支持文件。
- 在图谱中标记受变更影响的节点和边。
- git 信息不可用时给出可理解错误和替代命令建议。

#### FR-17：结构变化摘要

系统必须输出本次变更造成的结构变化，实现 UJ-4。

- 列出新增依赖边、删除依赖边、受影响目录/模块、循环变化和规则违规。
- 区分本次新增风险和历史既有风险。
- 不渲染全量图，只展示与变更集合相关的预算内子图或列表。

#### FR-18：Markdown PR Review 输出

用户可以生成适合复制到 PR review 的 Markdown 摘要，实现 UJ-4。

- 包含总体 verdict、主要风险、关键路径和建议复查文件。
- 路径使用相对路径。
- 除非用户显式开启，否则不包含源码内容。

#### FR-19：本地隐私边界

结构影响分析默认不上传源码、diff 或图谱数据，实现 UJ-4、UJ-5。

- 默认配置下 CLI 和插件不发起远程上传。
- MVP 默认关闭遥测，核心功能不得依赖遥测开启。
- 用户可显式 opt-in 匿名产品与性能遥测；不得包含源码、diff、完整文件路径、符号名称、图谱内容或规则内容。
- 用户可关闭遥测并查看本地生效状态；试用反馈也可通过访谈和用户主动导出的诊断报告获得。
- 图谱数据位于 OS 用户缓存的 workspace-key 目录，可查看并安全清理；生成数据不写入工作区，也不依赖 .gitignore 防止误提交。

#### FR-20：CLI 基础命令

用户可以通过 CLI 执行 rebuild、query、check、impact、export、status、doctor 和 cache，实现 UJ-1、UJ-4、UJ-5。

- rebuild 生成或刷新图谱。
- query 返回当前文件或指定路径的邻域结果。
- check 执行规则检查。
- impact 生成变更影响摘要。
- export 输出受预算限制的本地结构上下文。
- status 返回服务、图谱与 Finding 当前状态；doctor 输出可操作诊断；cache 支持查看位置和安全清理。

#### FR-21：本地图谱查询服务

插件和 CLI 通过本地图谱查询服务访问图谱，而不是各自重复实现索引和查询。

- 插件可请求项目概览、当前文件邻域、findings 和 stale 状态。
- CLI 复用同一查询能力。
- 服务返回 view model 或结构化数据，不暴露渲染库内部格式。

#### FR-22：图谱状态与故障恢复

系统必须让用户知道图谱是否可用、是否过期、是否构建失败。

- 插件显示 idle、indexing、stale、failed 等状态。
- 构建失败时展示错误摘要和日志位置。
- 用户可以执行重建恢复损坏或过期图谱。

#### FR-23：结构上下文导出

用户可以导出当前文件邻域、相关规则和 findings 的结构上下文，用于 AI 工具或人工沟通，实现 UJ-5。

- 包含路径、节点类型、依赖边、规则 findings 和图谱更新时间。
- 默认不包含源码正文。
- 受图谱预算限制，避免一次性输出全仓库上下文。

**功能需求总数：23。**

### 非功能需求

#### 性能

- **NFR-1：标准验收规模。** 标准验收项目不超过 5,000 个受支持源码文件、500,000 行源码和 50 个 workspace package；node_modules、构建产物、生成代码和索引排除路径不计入规模。
- **NFR-2：标准参考环境。** 标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD 的本地开发机器。
- **NFR-3：首次概览性能。** 在标准验收项目和参考环境下，clean cache 首次概览 p95 不超过 60 秒。
- **NFR-4：缓存邻域性能。** 打开文件后，已提交 warm cache 的邻域图显示 p95 不超过 300ms，后台刷新可异步完成。
- **NFR-5：保存后刷新性能。** 从宿主保存动作到对应 graph/Findings revision 可见的 p95 不超过 2 秒。
- **NFR-6：默认图谱预算。** 默认邻域图单次查询和渲染预算上限为 100 个节点、200 条边。
- **NFR-7：超规模退化。** 超出标准验收规模时不承诺相同 SLA，但不得阻塞编辑器，必须显示索引进度并允许取消或重建。

#### 可靠性

- **NFR-8：宿主隔离。** 索引、查询和布局不得阻塞 VS Code extension host。
- **NFR-9：事件风暴收敛。** git pull、分支切换、依赖安装和批量生成文件不应造成无限重建。
- **NFR-10：失败可读。** 图谱构建失败时，已有缓存仍可作为 stale 数据查看，并清楚标注状态。
- **NFR-11：缓存可恢复。** 系统必须能从损坏缓存中重建；迁移失败时保留故障副本并给出可恢复错误。

#### 安全与隐私

- **NFR-12：本地优先。** 源码、图谱、diff 和结构摘要默认仅保存在本地。
- **NFR-13：本机访问。** 本地图谱服务只能通过当前用户可访问的本机 IPC 端点通信，不监听 TCP 或网络接口。
- **NFR-14：数据可清理。** 用户必须能定位并安全清理本地图谱数据、日志和服务元数据。
- **NFR-15：遥测最小化。** 遥测默认关闭；用户 opt-in 后也只收集匿名功能使用事件、耗时、计数和错误分类，不收集项目内容或可反推出项目结构的标识。
- **NFR-16：云能力隔离。** 云端同步与团队共享必须作为独立能力另行设计和授权，不进入 MVP 主路径。

#### 可用性与可访问性

- **NFR-17：任务等价文本。** 核心 findings、循环依赖、结构关系和 PR 摘要必须有与图形任务等价的文本呈现；屏幕阅读器可获得节点类型、入/出边数、Finding 数、边方向、来源和置信度。
- **NFR-18：视觉可辨识。** 节点、边、严重级别和 stale 状态具有一致视觉语义，不能只依赖颜色；人类可读界面达到 WCAG 2.2 AA，并在 VS Code 高对比主题下保持可辨识。
- **NFR-19：键盘与焦点。** 用户可以固定当前视图；所有核心任务无需鼠标即可完成，焦点顺序可预测且可见，交互目标不小于 24×24 CSS px。
- **NFR-20：缩放与动态效果。** 空状态、错误状态和规则语法错误提供下一步操作；200% 字号下核心信息不丢失或重叠，并服从系统/VS Code 的减少动态效果设置。

#### 可演进性

- **NFR-21：渲染解耦。** 图谱持久模型不得绑定具体渲染库格式。
- **NFR-22：可追溯模型。** 节点和边必须使用稳定 ID，并记录来源、置信度、版本和更新时间。
- **NFR-23：可替换边界。** 分析器、存储、查询和渲染层保留可替换边界，支持后续接入更多语言、SCIP、矩阵视图或 MCP server。

#### 兼容性、资源与本地服务边界

- **NFR-24：支持平台与版本。** MVP 支持 Windows x64、macOS x64、macOS arm64 和 Linux x64；Windows arm64、Linux arm64 暂不支持。VS Code 扩展最低版本为 1.125.0，发布时验证最低版、最新稳定版和前一稳定版；CLI 要求 Node 24 LTS，平台 VSIX 自带经验证的 Node 24 LTS 运行时。
- **NFR-25：安装、升级与迁移。** 每个受支持组合通过新安装、离线启动、升级、降级、卸载以及缓存保留/清理验收。协议 major 或 schema 不兼容时安全拒绝并提示更新；图谱迁移仅由新服务事务化执行，失败时保留故障副本并允许重建，旧服务不得向新 schema 降级写入。
- **NFR-26：资源基线。** 在标准验收项目与参考环境中，首次 rebuild 的 graph-service 进程树峰值 RSS 不超过 4 GiB；按 1 秒采样的整段运行平均 CPU 不超过整机 75%。连续 5 分钟无活动 Job 的空闲窗口内，CPU p95 不超过整机 1%，窗口结束时 RSS 不超过 1.5 GiB。单工作区缓存、服务元数据和日志总量不超过 2 GiB，其中轮转日志不超过 100 MiB。版本化资源基准 manifest 固定 8 小时会话的 fixture、操作序列、采样间隔和空闲窗口；会话结束后的同条件空闲 RSS 不得比首小时基线增长超过 20%，Job 队列、句柄和临时文件不得持续单调增长。
- **NFR-27：服务生命周期与威胁边界。** 每个 indexing root 最多运行一个按需启动的图谱服务；Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket。业务请求前校验随机令牌、workspace-key 和协议版本；端点冲突、伪造客户端或版本不兼容必须安全失败且不得误连第二实例。未授予 Workspace Trust 时不得启动服务、读取项目文件或运行 Git 分析；所有路径经 realpath 解析后必须位于 indexing root 内。服务在无客户端且无活动 Job 5 分钟后优雅退出，并在崩溃、重连、升级和 stale metadata 场景下可恢复。

**非功能需求总数：27。**

### 其他需求、约束与规范合同

#### 产品与业务边界

- 首批用户限定为使用 VS Code、维护中大型 TypeScript/JavaScript 项目的 5–15 人技术团队中的一线开发者和 Tech Lead；以个人本地安装切入，但必须在真实团队代码库验证。
- 企业 SSO、审计、权限、私有部署、云端协作和组织级治理不进入 MVP。
- MVP 优先验证当前文件影响判断与结构边界破坏检测，不追求全语言、全调用图或不可读的全局大图。
- PR 工作流从本地 CLI/Markdown 摘要开始，不建设首版 hosted PR app。
- AI 方向只提供本地结构上下文导出；MCP server 延后到 v1.1。
- Beta 仅是首个可用版本，不得被表述为完整 MVP；Beta+ 必须同时通过 SM-1 至 SM-8，任一失败即 No-Go，并记录失败样本、负责人和复测条件。
- v1.1/MCP 仅在完整 MVP 门禁通过且 UJ-5 导出价值获得真实用户验证后启动。

#### 技术架构约束

- VS Code Extension 与 CLI 是入口；插件保持薄客户端，重索引、图查询和规则引擎位于独立本地图谱服务。
- 实现语言和工具链为 TypeScript 6.0.3；CLI 使用 Node 24 LTS，当前锁定验证版本 24.18.0；平台 VSIX 携带精简 Node 运行时、服务 bundle 和匹配 Node ABI 的 SQLite 模块。
- TypeScript 6.0.3 稳定 Compiler API 是 TS/JS 权威分析器；TypeScript 7 unstable API、Tree-sitter、LSP 和 SCIP 不进入首个实现。
- SQLite/better-sqlite3 是第一存储实现，但只能通过 GraphStorePort 访问，不能成为领域模型。
- Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket，应用协议为 JSON-RPC 2.0，禁止监听 TCP。
- Cytoscape.js 只消费 GraphViewModel；持久模型不得绑定 Cytoscape JSON。第二个真实渲染器出现前不抽取 renderer 包。
- 文件监听必须采用 debounce、settle、hash check 和 batch queue。
- protocol、graph schema、rules schema 和 CLI schema 独立版本化；protocol major 不同直接拒绝，同 major 的 minor 通过 capabilities 协商。

#### Monorepo、分析和规则合同

- Beta 必须识别常见 npm/Yarn package.json workspaces 与 pnpm-workspace.yaml；TypeScript project references 可作为补充来源。
- 支持单仓库 workspace package、跨 package import 和 package 聚合依赖边；不支持跨仓库 federation、跨语言精确符号解析或组织级全局图谱。
- rules.yaml v1 使用 JSON Schema 2020-12 作为唯一公共合同，yaml 保留 CST/range，Ajv 严格校验并输出 ConfigDiagnosticV1。
- layer-order 自上而下声明，每层可以依赖自身和后续层，不得反向依赖前层。
- 规则 ID 在 IDE findings、CLI JSON 与 CI 输出中保持稳定。
- BuiltinIgnoreV1 与 .codegraphignore 控制索引范围；rules.yaml ignore 只裁剪规则评估范围；首次 rebuild 前 Analyzer 必须读取 EffectiveIgnoreSnapshotV1。

#### 基准测量和正确性合同

- BenchmarkPlanV1 固定 fixture/digest、参考环境、cold/warm cache、SLA 起止事件、2 次 warm-up、至少 20 次测量和 nearest-rank p95，并输出机器可读 BenchmarkResultV1。
- 资源报告记录 fixture/toolchain digest、进程树 RSS/CPU、缓存与日志体积、Job/句柄/临时文件计数；不满足环境或采样合同的结果标记为 invalid。
- SM-4 使用至少 500 条版本化人工标注依赖声明，覆盖 ESM、CJS、re-export、type-only、literal require、literal dynamic import、path alias、跨 package、Node built-in 和负样本；micro-F1 ≥ 0.80，高置信度边 precision ≥ 0.90，并保留分类结果、失败样本和争议复核记录。

#### 安装、迁移和安全硬限制

- CLI 作为 npm 包发布，扩展使用平台特定 VSIX；安装后不得下载运行时或原生模块，不使用全局 daemon。
- 图谱 schema 仅由新服务事务化迁移；迁移失败保留故障副本并重建缓存。升级关闭等待当前事务完成、取消排队 Job、关闭数据库和 endpoint、删除服务 metadata 并释放锁，禁止自动强杀活动事务。
- POSIX 缓存目录权限为 0700、文件与 socket 为 0600；Windows 使用当前用户缓存 ACL 和随机不可猜 endpoint 后缀。
- Webview 使用严格 CSP、nonce、无网络访问和消息 Schema 校验，且不得直连 graph-service。
- 启动必须在迁移、watcher 注册、配置/manifest 对账和 bootstrap barrier 完成后才进入 running。
- 安全硬限制：单文件 10 MiB、最多 20,000 个候选源码文件、1,000 条规则、50 个 YAML alias；查询最多跨 3 跳、返回 500 个节点和 1,000 条边；最多 64 个待处理显式 Job。超限返回稳定诊断，不执行项目代码或静默截断规则。

#### 已关闭的架构处置

- 图谱缓存位置、命名、清理与 .gitignore 职责已关闭。
- 核心端口、适配器和唯一组合根已关闭。
- cg:// 稳定 ID、路径规范化和 Node built-in 标识已关闭。
- rules.yaml 解析、诊断和 schema 已关闭。
- CLI 命令、I/O、JSON envelope 和退出码已关闭。
- VS Code TreeView、Webview Editor、Problems、Status Bar 与 Command Palette surface 边界已关闭。
- PrReviewSummaryV1 与 ImpactVerdictV1 已关闭。
- StructureContextExportV1 与 ExportArtifactV1 已关闭。

### PRD 完整性初步评估

PRD 与 Addendum 的结构完整：UJ-1 至 UJ-5、FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8 均连续且唯一；当前没有声明中的阻塞性开放问题或未确认假设。核心范围、技术边界、性能、安全、兼容性、资源和可访问性已经具备较强的可测试合同。

仍有以下非阻塞但需要在实施前追踪的语义缺口：

1. **中等：v1.1 的 UJ-5 价值门禁不可重复判定。** 缺少有效用户定义、导出任务、样本下限、价值评分和通过阈值。
2. **中等：核心概览与预算退化的派生语义未闭合。** 依赖强度、循环风险分档、热点模块、模块边界来源、超预算相关性排序和稳定 tie-break 没有统一的用户可见合同。
3. **中等：Go/No-Go 用户任务指标缺少统一判分协议。** SM-1 的计时起止和正确性标准、SM-6 的 fixture/漏报误报门槛、SM-7 的固定任务与样本剔除规则仍不完整。
4. **低：术语表仍存在范围漂移。** “边”包含 MVP 不提取的 references；目录、模块与 workspace package 的规范映射未定义。

这些问题目前不否定 PRD 可进入下游验证，但必须检查架构、UX 和 Epics/Stories 是否已经提供一致、可验收的补充合同。

## Epic 覆盖验证

### FR 覆盖矩阵

| FR | PRD 需求 | Epic / Story 覆盖 | 状态 |
| --- | --- | --- | --- |
| FR-1 | 初始化工作区图谱 | Epic 1：Story 1.4、1.9；Epic 5：Story 5.6、5.11 | ✓ 已覆盖 |
| FR-2 | 提取 TS/JS 依赖和 BasicSymbolV1 | Epic 1：Story 1.5、1.6、1.7、1.8、1.9；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-3 | 保存后增量更新 | Epic 2：Story 2.8；Epic 5：Story 5.6、5.11 | ✓ 已覆盖 |
| FR-4 | 路径排除与噪声控制 | Epic 1：Story 1.4、1.10、1.11、1.12、1.13；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-5 | 图谱版本、稳定 ID 与过期状态 | Epic 1：Story 1.4、1.5、1.6、1.7、1.12、1.15、1.17；Epic 5：Story 5.3、5.7、5.11 | ✓ 已覆盖 |
| FR-6 | 项目结构概览 | Epic 2：Story 2.2、2.3；Epic 5：Story 5.6、5.11 | ✓ 已覆盖 |
| FR-7 | 当前文件邻域图 | Epic 2：Story 2.4、2.5；Epic 5：Story 5.6、5.11 | ✓ 已覆盖 |
| FR-8 | 聚焦追踪与视图固定 | Epic 2：Story 2.6；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-9 | 节点导航与上下文操作 | Epic 1：Story 1.6；Epic 2：Story 2.7；Epic 3：Story 3.9；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-10 | 图与任务等价文本视图 | Epic 2：Story 2.2–2.5；Epic 3：Story 3.9；Epic 4：Story 4.5；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-11 | 循环依赖检测 | Epic 1：Story 1.14；Epic 3：Story 3.6；Epic 4：Story 4.3；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-12 | 目录与层级依赖规则 | Epic 3：Story 3.1–3.6；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-13 | 保存后 Findings 提示 | Epic 3：Story 3.7、3.8、3.9；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-14 | 风险解释 | Epic 3：Story 3.2、3.4–3.9；Epic 4：Story 4.3；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-15 | CLI 规则检查 | Epic 3：Story 3.10；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-16 | 读取本地变更集合 | Epic 4：Story 4.1；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-17 | 结构变化摘要 | Epic 4：Story 4.2、4.3、4.4、4.5；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-18 | Markdown PR Review 输出 | Epic 4：Story 4.6；Epic 5：Story 5.11 | ✓ 已覆盖 |
| FR-19 | 本地隐私边界 | Epic 1：Story 1.16、1.18；Epic 2：Story 2.9；Epic 5：Story 5.1、5.2、5.5、5.8、5.10、5.11 | ✓ 已覆盖 |
| FR-20 | CLI 基础命令 | Epic 1：Story 1.14、1.16；Epic 3：Story 3.10；Epic 4：Story 4.8；Epic 5：Story 5.1、5.4、5.7、5.8、5.9、5.11 | ✓ 已覆盖 |
| FR-21 | 统一 graph-service 查询服务 | Epic 1：Story 1.1、1.2、1.3、1.14；Epic 2：Story 2.1；Epic 5：Story 5.2、5.4、5.5、5.7、5.9、5.10、5.11 | ✓ 已覆盖 |
| FR-22 | 图谱状态与故障恢复 | Epic 1：Story 1.2–1.4、1.11–1.15、1.17；Epic 2：Story 2.1、2.8；Epic 3：Story 3.2、3.3；Epic 5：Story 5.2–5.7、5.9、5.11 | ✓ 已覆盖 |
| FR-23 | 结构上下文导出 | Epic 4：Story 4.7、4.8；Epic 5：Story 5.11 | ✓ 已覆盖 |

### 缺失需求

- 未发现缺失的 PRD 功能需求。
- 未发现 Epics/Stories 引用了 PRD 中不存在的额外 FR 编号。
- 本步骤只确认“存在可追踪实施路径”，不对故事规模、依赖顺序或验收标准质量作结论。

### 覆盖统计

- PRD 功能需求总数：23
- Epics 声明覆盖的功能需求：23
- 具有明确 Story 关联的功能需求：23
- 缺失功能需求：0
- 覆盖率：100%

## UX 对齐评估

### UX 文档状态

已找到并完整核验以下 UX 主文档：

- ux-designs/ux-bmad-2026-07-13/DESIGN.md
- ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md

同时核验了 reconcile-prd.md、reconcile-sprint-change-proposal.md 和 .memlog.md 的对账与决策记录。当前 UX 采用 spine-only 交付，没有独立 mockup 或 wireframe。

### UX ↔ PRD 对齐

总体结论：**高度对齐。**

- UJ-1 至 UJ-5 在 UX Key Flows 中全部保留，角色、入口状态、主路径、高潮和失败路径均与 PRD 一致。
- Project Overview、Current Context、Findings、Changes/PR Summary、Export Preview 与 Settings & Rules 覆盖 FR-6 至 FR-23 的用户可见部分。
- UX 正确保持 Beta 与 Beta+ 边界：PR Markdown 和本地结构导出属于完整 MVP，但不阻塞首个可用 Beta。
- 图与列表任务等价、WCAG 2.2 AA、高对比、键盘、屏幕阅读器、200% 字号、减少动态效果和 24×24 CSS px 目标均可追溯到 NFR-17 至 NFR-20。
- 60 秒首次 Overview、300ms warm-cache 邻域、2 秒保存更新、100 节点/200 边默认预算与 PRD 性能合同一致。
- Workspace Trust、monorepo recognized/degraded、Node built-in、规则配置诊断、默认关闭遥测和默认无源码导出均已同步。

### UX ↔ 架构对齐

总体结论：**架构已承载主要 UX 合同。**

- AD-7 与 AD-25 为 Overview、Current Context、聚合、预算、依赖强度、热点、循环风险和稳定排序提供服务端权威模型。
- AD-10 固定 Activity Bar/TreeView、Webview Editor、Problems、Status Bar 与 Command Palette 的职责，与 UX Information Architecture 一致。
- AD-15 保证图与列表任务等价、键盘语义、屏幕阅读器语义、主题、高对比和空间记忆。
- AD-7、AD-8、AD-23 支撑 stale、partial、failed、cancelled、refreshing、revision、重连和缓存保留状态。
- AD-11 支撑 Workspace Trust、路径越界、Webview CSP/nonce/Schema、IPC token 和安全预算。
- AD-16 支撑遥测默认关闭、服务确认状态与立即关闭。
- AD-18 与 AD-26 支撑 ExportPreview、PR Markdown、默认 structure-only、不可变 artifact、统一 verdict 和风险排序。
- AD-19 与 Implementation Guide 的基准矩阵支撑 60s/300ms/2s 性能目标及真实 VS Code 验收。

### 对齐问题

1. **中等：UX 将“生成失败”和“目标写出失败”混为同一可复制状态。**
   - EXPERIENCE.md 的 UJ-4 failure path 与 Export failed 状态允许在“生成失败”时复制已生成部分。
   - 架构 AD-18 和 Story 4.6 要求复制/重试基于已完成、不可变、带 revision 和 policy 的 ExportArtifactV1；只有剪贴板或文件目标失败时才能安全复用该 artifact。
   - 风险：用户可能复制不完整、未绑定完整影响结果或未完成隐私判定的 PR 摘要。
   - 建议：将 UX 合同改为“仅当存在上一份或本次已完整生成的有效 immutable artifact 时允许复制；生成阶段失败则保留上一份有效 artifact，并提供重新生成，禁止复制部分生成内容”。

2. **低：UX 仍把已成为强制 NFR 的可访问性目标标记为 ASSUMPTION。**
   - EXPERIENCE.md 将 WCAG 2.2 AA 和图节点 24×24 CSS px 最小可选区域标为假设。
   - PRD NFR-18、NFR-19 与架构 AD-15 已把它们定义为正式要求；Epics 也已放入 blocking gate。
   - 风险：文档阅读者可能误以为这些标准可以在实现中降级或跳过。
   - 建议：去掉要求本身的 ASSUMPTION 标签，只保留“真实 Webview 验证方法和断点校准仍待实施证据”的说明。

### 警告

- **无独立 mockup/wireframe。** 当前不构成实施阻塞，因为 DESIGN/EXPERIENCE spine 已明确组件、状态、交互和响应式合同，Epics 也要求首个真实 Webview 切片提交暗色、亮色、高对比、字号和窄宽度证据；但首个 Webview Story 的视觉与可访问性验收不可推迟。
- **用户任务判分仍未闭合。** UX Key Flows 描述了 UJ-2 三分钟任务和规则/PR 审查路径，但没有补齐 SM-1、SM-6、SM-7 的计时边界、ground truth、正确性评分、样本剔除和通过协议。该问题仍需由版本化产品验证计划关闭。
- **候选快捷键与响应断点属于合理的实现校准项。** Ctrl+Alt+G、Ctrl+Alt+P 和 900/600/360px 断点尚需真实 VS Code 冲突及内容溢出测试，不应在证据完成前固化为不可变产品合同。

## Epic 与 Story 质量审查

### 总体结论

5 个 Epic 均以用户可获得的结果命名，没有发现纯粹的“建立数据库”“开发 API”或“基础设施搭建”式技术 Epic：

| Epic | 用户价值 | 独立性与依赖 | 结论 |
| --- | --- | --- | --- |
| Epic 1：构建、查询并恢复可信的本地代码图谱 | 用户可通过本地 CLI 创建、查询、诊断和恢复图谱 | 可作为 Alpha 独立交付；后续 Epic 只消费其已提交合同 | 通过，有 Story 规模问题 |
| Epic 2：在 VS Code 中快速理解项目与当前文件影响 | 用户可在编码位置理解项目结构和影响范围 | 只依赖 Epic 1；基础循环不依赖未来 Epic 3 | 通过，有 Story 规模问题 |
| Epic 3：在编码时发现并解释架构风险 | 用户可声明规则并获得可定位、可解释 Finding | 依赖 Epic 1 图谱与 Epic 2 宿主 surface，不依赖未来 Epic | 通过 |
| Epic 4：审查变更并导出结构上下文 | Tech Lead 可审查结构变化，开发者可导出本地上下文 | 按 ChangeSet → 差异 → 比较 → verdict → 展示/导出顺序推进 | 通过，有 Story 规模问题 |
| Epic 5：可安装、可升级、可离线使用 | 用户获得可安装、离线、安全升级和可验证的产品 | 合理依赖此前完整能力；没有反向要求早期 Epic 依赖发布能力 | 通过，最终门禁验收合同不完整 |

### 自动结构核验

- Story 总数：56。
- Epic 1/2/3/4/5 分别包含 18/9/10/8/11 个 Story。
- 56 个 Story 均存在 As a / I want / So that 用户故事结构。
- 所有 Story 的 Given、When、Then 组数相等，未发现缺失 When 或 Then 的 BDD 块。
- 未发现任何 Story 显式引用同 Epic 的后续 Story 或未来 Epic 的 Story。
- Starter template 要求已由 Story 1.1 覆盖：pnpm workspace、官方 VS Code TypeScript + esbuild 模板、仓库边界和根级命令。
- 数据库建表遵循按需原则：Story 1.4 只创建首次 rebuild 所需表，Findings 等未来表在能力首次落地时增量迁移。

### 🔴 严重违规

未发现技术 Epic、循环依赖、明确前向依赖或一次性预建全部数据库表等严重违规。

### 🟠 主要问题

#### 1. 架构 CI 门禁与 Story 计划存在直接合同冲突

- Architecture Spine AD-28 和 Implementation Guide 要求 Story 1.1 建立自动 CI。
- 当前 epics.md 的 Story 1.1 只建立仓库模板、依赖边界与根级命令；真实阻断式 CI、provider ruleset 和规划追踪门禁在 Story 1.3 才建立。
- Epics 虽规定 Story 1.3 通过前不得并行启动功能 Story，因此风险被部分控制，但实现计划仍未满足 AD-28 的字面不变量。

**影响：** 实现代理按架构执行会要求 Story 1.1 完成 CI；按 Epics 执行则推迟到 Story 1.3，导致 Story 完成定义和合并门禁不一致。

**建议：** 二选一并统一所有文档：

- 将最小真实 CI 基线并入 Story 1.1，Story 1.3 只扩展 provider ruleset、漂移监控和规划追踪；或
- 修改 AD-28/Guide，明确 Story 1.1–1.3 是不可并行的地基序列，且 Story 1.3 完成前不得合并任何公共能力。

#### 2. Implementation Guide 的“当前 Story”引用已落后于最新拆分

Guide 中仍存在以下错误映射：

- BuiltinIgnore/generation 0：写为 Story 1.2，实际为 Story 1.4。
- BasicSymbolV1：写为 Story 1.3，实际为 Story 1.6。
- BaseCycleProjectionV1：写为 Story 1.6，实际为 Story 1.14。
- ImpactVerdictV1/ImpactRankV1：写为 Story 4.2，实际为 Story 4.4。
- 首次 rebuild 按需建表说明仍引用 Story 1.2，实际为 Story 1.4。

**影响：** 开发代理可能把关键前置合同落到错误 Story，破坏“不可晚于”顺序和规划追踪检查。

**建议：** 更新 Guide 映射并让 Story 1.3 的规划追踪 gate 自动检查 Architecture/Guide 中的 Story 引用。

#### 3. 部分 Story 超出单一开发代理的合理切片

高风险 Story：

- **Story 1.4（10 组 BDD、68 行）：** 同时承担 generation 0 排除基线、Job、层级图谱、确定性 ID、SQLite schema、GraphPatch 事务、CAS、空工作区、失败和 CI 门禁。
- **Story 2.1（8 组 BDD、57 行）：** 同时承担 extension 壳层、Workspace Trust、Getting Started、Index Status、monorepo 状态、Webview 安全、双语本地化和 Electron gate。
- **Story 2.8（7 组 BDD、51 行）：** 同时贯穿 watcher、settle/hash、增量 Analyzer、GraphPatch/Findings 原子提交、GraphViewPatch、UI 空间记忆、2 秒 SLA 与事件风暴恢复。
- **Story 4.8（7 组 BDD、55 行）：** 同时实现 impact 与 export 两个 CLI 命令、三种格式、文件写入、退出码、完整 help 面和 CI 合同。

**影响：** 这些 Story 横跨多个包、失败域和测试层，难以在一次顺序开发中稳定完成、验证和回滚。

**建议：**

- Story 1.4 至少拆为“存储与层级图谱初始化”和“确定性 rebuild/GraphPatch/CAS”。
- Story 2.1 拆为“可信扩展壳层与 Workspace Trust”和“Getting Started/Index Status + locale”。
- Story 2.8 拆为“服务端增量 mutation”和“客户端原子 patch/状态保持”，性能 gate 绑定两者完成后的集成切片。
- Story 4.8 拆为 CLI impact 与 CLI export；公共 envelope/退出码由共享合同测试覆盖。

#### 4. 完整 MVP 的产品验证缺少可执行 Story 与版本化验收 oracle

Story 5.11 要求 SM-1 至 SM-8 全部通过，但当前 Story 集合没有建立统一的产品验证计划来定义：

- SM-1 三分钟任务的计时起止、问题集、ground truth 和正确答案判定。
- SM-6 循环与跨层规则验证的 fixture、漏报/误报和通过阈值。
- SM-7 固定 UJ-2 任务、有效样本剔除规则和评分采集协议。
- UJ-5/v1.1 价值门禁的样本、任务和通过阈值。

**影响：** Story 5.11 的 Go/No-Go 无法被两个独立执行者重复判定，可能出现实现完成但发布门禁仍依赖临场解释。

**建议：** 在发布 Epic 前增加“建立版本化产品验证计划与证据 Schema”Story，并让 Story 5.11 只消费固定 manifest、结果和阈值。

### 🟡 次要问题

#### 1. 候选快捷键的冲突验收范围不明确

Story 2.6 要求检查 VS Code 默认键位、主流扩展和可访问性冲突，但没有定义“主流扩展”清单、版本或判定工具。应固定候选键位测试矩阵，或只保证不覆盖 VS Code 默认/产品自身已注册键位。

#### 2. Story 5.11 使用“全部适用”但缺少机器可读适用性清单

最终审计写明全部适用 FR/NFR/SM 必须通过，但未定义按 release slice 解析适用性的唯一 manifest。建议由 ReleaseSet 或独立 ReadinessGateManifest 明确 Beta/Beta+ 的必需门禁，避免人工选择。

### 最佳实践通过项

- 所有 Epic 都提供可识别的用户结果，而非技术里程碑。
- Epic 依赖方向单向，未发现后续 Epic 反向阻塞前序 Epic。
- Story 内没有显式前向引用。
- 错误、取消、stale、partial、重连、越界和隐私失败路径覆盖充分。
- BDD 格式一致且大部分 AC 可直接自动化。
- FR-1 至 FR-23 的 Story 追踪保持完整。
- 数据库和公共 Schema 按能力首次落地，不进行无使用路径的未来预建。

## 总结与建议

### 总体实施就绪状态

**NEEDS WORK（需要修正后再开始实施）**

规划制品已经具备坚实基础：

- PRD、UX、Architecture 与 Epics/Stories 四类输入齐全。
- FR-1 至 FR-23 覆盖率为 100%，每条 FR 均有明确 Story 路径。
- 五个 Epic 都交付用户价值，没有技术 Epic 或反向 Epic 依赖。
- 架构对性能、revision、一致性、恢复、安全、可访问性和发布可追溯性定义深入。
- 56 个 Story 均具有完整 BDD 结构和丰富失败路径。

但当前仍有 4 项主要问题会让实施代理获得不一致或不可重复执行的指令，因此不建议直接进入大规模开发。

### 需要立即处理的问题

1. **统一 AD-28、Implementation Guide 与 Story 1.1/1.3 的 CI 门禁合同。**
   - 当前架构要求 Story 1.1 建立 CI，Epics 则在 Story 1.3 建立。
   - 必须确定唯一顺序和完成定义，并同步所有引用。

2. **修复 Implementation Guide 的过期 Story 映射。**
   - 至少更新 BuiltinIgnore、BasicSymbolV1、BaseCycleProjectionV1、ImpactVerdictV1 和首次 rebuild 建表的 Story 编号。
   - 将这些引用纳入规划追踪 blocking gate。

3. **拆分明显过大的 Story。**
   - 优先处理 Story 1.4、2.1、2.8、4.8。
   - 拆分后必须保留端到端用户价值、错误路径和 FR/AR/UX-DR 追踪，不得退化为无用户结果的纯技术任务。

4. **建立版本化产品验证与发布适用性合同。**
   - 固定 SM-1、SM-6、SM-7 的任务、ground truth、计时、评分、样本剔除与阈值。
   - 固定 Beta/Beta+ 的 ReadinessGateManifest 或等价机器可读清单。
   - Story 5.11 应只消费已版本化的计划、结果和证据，而不是现场解释“全部适用”。

### 后续建议

1. 修订 Architecture Spine/Implementation Guide 与 epics.md，使 CI 地基顺序和所有 Story 引用一致。
2. 重新切分四个高风险大 Story，并重新执行 FR/AR/UX-DR 追踪检查。
3. 新增产品验证计划 Story，覆盖 SM-1、SM-6、SM-7、SM-8 及 UJ-5 后续价值门禁。
4. 修订 UX：禁止复制部分生成的 PR 摘要；仅允许复制完整 immutable artifact；去掉 WCAG 2.2 AA 与 24×24 目标上的 ASSUMPTION 标签。
5. 将 AD-25 已确定的依赖强度、热点、循环与稳定排序语义回写 PRD，统一“目录/模块/workspace package”术语并删除 MVP 不产出的 references 表述。
6. 为候选快捷键、响应断点和真实 Webview 可访问性建立明确测试矩阵。
7. 完成修订后重新运行 Implementation Readiness；只有主要问题关闭且追踪 gate 通过后，状态才应提升为 READY。

### 问题统计

- Critical：0
- Major：4
- Medium：3
- Low / Warning：3
- 合计：10 个独立问题组，分布于 PRD 完整性、UX 对齐、架构追踪和 Epic/Story 质量四类。

### 最终说明

当前方案不是方向错误，而是“合同已足够丰富，但少数合同彼此不同步”。如果直接实施，最可能出现的不是缺功能，而是开发代理按不同文档完成不同的门禁、把大 Story 做成半完成状态，或在最终 Go/No-Go 时发现指标不可重复判定。先关闭上述 4 项主要问题，代价明显低于在实现阶段返工。

**评估日期：** 2026-07-16  
**评估人：** Winston / BMad Implementation Readiness
