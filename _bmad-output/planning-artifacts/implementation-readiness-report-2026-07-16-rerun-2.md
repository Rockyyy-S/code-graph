---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
filesIncluded:
  prd:
    - prds/prd-bmad-2026-07-09/prd.md
    - prds/prd-bmad-2026-07-09/addendum.md
    - prds/prd-bmad-2026-07-09/reconcile-implementation-readiness-2026-07-15.md
    - prds/prd-bmad-2026-07-09/reconcile-sprint-change-2026-07-16.md
  architecture:
    - architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
    - architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md
    - architecture/architecture-bmad-2026-07-13/reviews/reconcile-sprint-change-2026-07-16.md
  epics:
    - epics.md
  ux:
    - ux-designs/ux-bmad-2026-07-13/DESIGN.md
    - ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
    - ux-designs/ux-bmad-2026-07-13/reconcile-prd.md
    - ux-designs/ux-bmad-2026-07-13/reconcile-sprint-change-2026-07-16.md
    - ux-designs/ux-bmad-2026-07-13/reconcile-sprint-change-proposal.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-16
**Project:** bmad

## 文档发现

### 纳入评估的文档

- PRD：主文档、补充文档、实施就绪协调记录及最新 Sprint 变更协调记录。
- Architecture：架构脊柱、实施指南及最新 Sprint 变更协调记录。
- Epics & Stories：`epics.md`。
- UX：设计、体验及三份需求/Sprint 变更协调记录。

### 发现结果

- 四类必需规划制品均已找到。
- 未发现整篇文档与 `index.md` 分片版本并存的重复冲突。
- PRD、Architecture、UX 使用目录化文档集，但均未提供 `index.md`；本次依据已确认的主文档与协调记录执行评估。
- Architecture 的历史评审轮次、PRD 的编辑与评分记录以及内部 `.memlog.md` 不作为规范性输入。

## PRD 分析

### 功能需求

#### FR-1：初始化工作区图谱

用户可以通过 VS Code 命令或 CLI 对当前工作区执行首次图谱构建。实现 UJ-1。

- 当用户在受支持工作区执行初始化时，系统生成可查询的项目代码图谱。
- 系统识别常见 npm、Yarn 与 pnpm workspace package 边界；无法识别时仍可退化为普通单工作区索引。
- 当工作区缺少受支持语言文件时，系统给出空状态和可操作提示，而不是报错退出。
- 初始化结果包含图谱生成时间、索引文件数、节点数、边数和排除路径摘要。

#### FR-2：提取 TypeScript/JavaScript 依赖关系

系统必须提取 TypeScript/JavaScript 文件之间的 import/export 关系和外部包依赖。实现 UJ-1、UJ-2。

- 系统能识别 ES module import/export、常见 TypeScript path alias、package import。
- 在 monorepo 中，系统能识别跨 workspace package 的 TS/JS import，并将文件级证据聚合为 package 依赖边。
- 每条依赖边记录来源、置信度、语言、文件范围和最后检测时间。
- 对无法确定的动态依赖，系统不得伪装成精确依赖；必须标记为低置信或暂不纳入。
- `BasicSymbolV1` 只提取 TypeScript/JavaScript 源文件顶层且具有稳定名称与可导航范围的 `function`、`class`、`interface`、`type-alias`、`enum`、`variable`、`namespace`。
- MVP 不提取成员、参数、局部变量、import alias、匿名声明、调用图或 references；这些对象不得进入符号导航、结构导出或成功指标。

#### FR-3：保存后增量更新

用户保存受支持文件后，系统在本地增量更新相关图谱数据。实现 UJ-2、UJ-3。

- 系统对保存事件进行 debounce 或 settle 处理，避免 git pull、分支切换或批量生成文件时频繁重建。
- 内容 hash 未变化时，系统不得重复解析同一文件。
- 增量更新完成后，当前视图显示最新状态或明确标记仍为 stale。

#### FR-4：路径排除与噪声控制

用户可以通过内置安全默认项和工作区根目录的 `.codegraphignore` 排除依赖目录、构建产物、生成代码和自定义路径，防止图谱污染。实现 UJ-1、UJ-2。

- 系统从首次 rebuild 和首次 Analyzer 运行前即应用内置安全默认排除；即使 `.codegraphignore` 不存在，也必须提供包含内置规则的有效 generation 0 排除快照。
- 用户通过 `.codegraphignore` 声明额外排除或显式重新纳入路径；配置的有效快照、无效诊断和 last-valid 回退由本地图谱服务统一管理。
- 命中有效索引排除规则的路径不产生节点、边或 Evidence，不参与 workspace package 聚合、规则检查或成功指标统计。
- `.codegraphignore` 重新纳入路径后，系统沿用原确定性 ID，不把同一实体误识别为新对象。

#### FR-5：图谱版本、稳定 ID 与过期状态

系统必须为图谱 schema、节点、边和索引状态提供稳定标识与版本信息。

- 节点和边 ID 不依赖数据库自增主键。
- 图谱数据包含 schema version，旧版本数据可触发迁移或重建提示。
- 当源文件变化但索引未完成时，系统显示 stale 状态。

#### FR-6：项目结构概览

用户打开工作区后，可以查看 directory 或 recognized workspace-package 投影之间的真实依赖概览。实现 UJ-1。

- 概览使用 `ProjectionMembershipV1` 在 `directory` 或 `workspace-package` 中选择一种 `groupBy`；同一文件在单次查询中只属于一个叶子聚合，禁止向祖先重复累计。
- 概览展示依赖方向、`dependencyStrength`、`cycleMemberCount`、热点排序、完整性和图谱更新时间。
- `dependencyStrength` 等于两个叶子聚合之间不同 high-confidence 文件级 `imports` 规范边数量，同一规范边的多条 Evidence 只计一次；`internalDependencyStrength` 等于与其他内部聚合的入向与出向强度总和。
- 热点按 active error、active warning、`cycleMemberCount`、`internalDependencyStrength` 降序，再按规范 node ID 升序；只有 `freshness=current` 且 `completeness=complete` 时显示正式排名，stale 或 partial 只能显示带限制说明的非正式结果。
- 基础循环由不读取 `rules.yaml` 的统一 `CycleProjectionKernelV1` 计算。
- 用户可以从聚合节点下钻到相关文件或预算内局部邻域。

#### FR-7：当前文件邻域图

用户打开代码文件时，系统自动展示当前文件的依赖邻域。实现 UJ-2。

- 邻域图至少区分当前文件、直接依赖、反向依赖和外部包。
- 默认展示 1 跳关系，单次查询和渲染预算上限为 100 个节点、200 条边。
- 当候选节点或边超过预算时，服务端先在完整候选范围内按焦点距离、关系角色、置信度和规范 node ID 的稳定 tie-break 排序，再截断或折叠为 directory 或 recognized workspace-package 聚合。
- `scopeRoot`、`groupBy`、`aggregationDepth` 与 `membershipDigest` 必须进入 query identity；同一输入、revision 和配置产生相同顺序。
- 用户展开聚合时创建新的预算内局部查询，不在客户端无上限追加全局图。

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

系统必须检测受支持图谱范围内的 file、directory 和 workspace-package 投影循环依赖。实现 UJ-3、UJ-4。

- 系统能列出循环链路中的节点和边。
- 系统能区分已有循环与本次变更新增循环。
- 循环 finding 包含严重级别、范围和可定位文件。

#### FR-12：目录与层级依赖规则

用户可以声明基础架构规则，例如禁止某目录引用某目录，或限制层级依赖方向。实现 UJ-3、UJ-4。

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

- Finding 展示规则名、严重级别、新增边、相关路径和检测时间。
- 用户可以从 finding 跳转到触发文件。
- 系统不得用模糊告警替代可定位的依赖边或规则。

#### FR-14：风险解释

系统必须解释结构风险为什么发生，而不只是给出错误码。

- 循环依赖 finding 展示完整或折叠后的循环路径。
- 跨层违规 finding 展示实际依赖方向和期望规则。
- 对已知限制或低置信度结果，系统明确标注置信度或数据来源。

#### FR-15：CLI 规则检查

用户可以通过 CLI 在本地执行规则检查并获得机器可读和人可读输出。实现 UJ-4。

- CLI check 在存在 `error` 级违规时返回非零退出码；只有 `warning` 时默认返回零。
- CLI 输出包含 summary、findings 列表和可选 JSON。
- CLI 不要求连接云服务。

#### FR-16：读取本地变更集合

用户可以通过 CLI 或 VS Code 命令选择当前工作树、暂存区或指定 base 分支作为变更集合。实现 UJ-4。

- 系统能识别新增、删除、修改和移动的受支持文件。
- 系统能在图谱中标记受变更影响的节点和边。
- 当 git 信息不可用时，系统给出可理解错误和替代命令建议。

#### FR-17：结构变化摘要

系统必须输出本次变更造成的结构变化。实现 UJ-4。

- 摘要列出新增依赖边、删除依赖边、受影响 directory 或 workspace package、循环变化和规则违规。
- 摘要区分“本次新增风险”和“历史既有风险”。
- 摘要避免渲染全量图，只展示与变更集合相关的预算内子图或列表。

#### FR-18：Markdown PR Review 输出

用户可以生成适合复制到 PR review 的 Markdown 摘要。实现 UJ-4。

- Markdown 摘要包含总体 verdict、主要风险、关键路径和建议复查文件。
- 摘要中路径使用相对路径。
- 输出不包含源码内容，除非用户显式开启。
- 只有完整生成且不可变的 artifact 才能复制或写出；生成失败不得暴露或复制部分摘要。剪贴板或目标文件写入失败时，可以重试同一完整 artifact 或改用另一目标。

#### FR-19：本地隐私边界

结构影响分析默认不上传源码、diff 或图谱数据。实现 UJ-4、UJ-5。

- 默认配置下，CLI 和插件不发起远程上传。
- MVP 默认关闭遥测，核心功能不得依赖遥测开启。
- 用户可显式 opt-in 匿名产品与性能遥测；遥测不得包含源码、diff、完整文件路径、符号名称、图谱内容或规则内容。
- 用户可随时关闭遥测并查看本地生效状态；首轮试用也可以通过访谈和用户主动导出的诊断报告收集反馈。
- 本地图谱数据位于 OS 用户缓存的 workspace-key 目录，用户可查看位置并安全清理；生成数据不写入工作区，也不依赖 `.gitignore` 防止误提交。

#### FR-20：CLI 基础命令

用户可以通过 CLI 执行 rebuild、query、check、impact、export、status、doctor 和 cache。实现 UJ-1、UJ-4、UJ-5。

- `rebuild` 生成或刷新图谱。
- `query` 返回当前文件或指定路径的邻域结果。
- `check` 执行规则检查。
- `impact` 生成变更影响摘要。
- `export` 输出受预算限制的本地结构上下文。
- `status` 返回服务、图谱与 Finding 的当前状态；`doctor` 输出可操作诊断；`cache` 支持查看位置和安全清理。

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
- 只有完整生成且不可变的 artifact 才能复制或写出；生成失败不得暴露部分内容，目标操作失败只能重试同一完整 artifact 或改用另一目标。

功能需求总数：**23**。FR-1 至 FR-23 连续、唯一，无缺号或重号。

### 非功能需求

- **NFR-1：标准验收规模。** 标准验收项目不超过 5,000 个受支持源码文件、500,000 行源码和 50 个 workspace package；`node_modules`、构建产物、生成代码和索引排除路径不计入规模。
- **NFR-2：标准参考环境。** 标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD 的本地开发机器。
- **NFR-3：首次概览性能。** 在标准验收项目和参考环境下，clean cache 首次概览的 p95 不超过 60 秒。
- **NFR-4：缓存邻域性能。** 打开文件后，已提交 warm cache 的邻域图显示 p95 不超过 300ms，后台刷新可异步完成。
- **NFR-5：保存后刷新性能。** 从宿主保存动作到对应 graph/Findings revision 可见的 p95 不超过 2 秒。
- **NFR-6：默认图谱预算。** 默认邻域图的单次查询和渲染预算上限为 100 个节点、200 条边。
- **NFR-7：超规模退化。** 超出标准验收规模时暂不承诺相同 SLA，但系统不得阻塞编辑器，必须显示索引进度并允许取消或重建。
- **NFR-8：宿主隔离。** 索引、查询和布局不得阻塞 VS Code extension host。
- **NFR-9：事件风暴收敛。** git pull、分支切换、依赖安装和批量生成文件不应造成无限重建。
- **NFR-10：失败可读。** 图谱构建失败时，已有缓存仍可作为 stale 数据查看，并清楚标注状态。
- **NFR-11：缓存可恢复。** 系统必须能从损坏缓存中重建；迁移失败时保留故障副本并给出可恢复错误。
- **NFR-12：本地优先。** 源码、图谱、diff 和结构摘要默认仅保存在本地。
- **NFR-13：本机访问。** 本地图谱服务只能通过当前用户可访问的本机 IPC 端点通信，不监听 TCP 或网络接口。
- **NFR-14：数据可清理。** 用户必须能定位并安全清理本地图谱数据、日志和服务元数据。
- **NFR-15：遥测最小化。** 遥测默认关闭；即使用户 opt-in，也只收集匿名功能使用事件、耗时、计数和错误分类，不收集项目内容或可反推出项目结构的标识。
- **NFR-16：云能力隔离。** 云端同步与团队共享必须作为独立能力另行设计和授权，不进入 MVP 主路径。
- **NFR-17：任务等价文本。** 核心 findings、循环依赖、结构关系和 PR 摘要必须有与图形任务等价的文本呈现；屏幕阅读器可获得节点类型、入/出边数、Finding 数、边方向、来源和置信度。
- **NFR-18：视觉可辨识。** 图谱节点、边、严重级别和 stale 状态必须具备一致视觉语义，不能只依赖颜色；人类可读界面达到 WCAG 2.2 AA，并在 VS Code 高对比主题下保持可辨识。
- **NFR-19：键盘与焦点。** 用户可以固定当前视图；所有核心任务无需鼠标即可完成，焦点顺序可预测且可见，交互目标不小于 24×24 CSS px。
- **NFR-20：缩放与动态效果。** 空状态、错误状态和规则语法错误必须提供下一步操作；200% 字号下核心信息不丢失或重叠，并服从系统/VS Code 的减少动态效果设置。
- **NFR-21：渲染解耦。** 图谱持久模型不得绑定具体渲染库格式。
- **NFR-22：可追溯模型。** 节点和边必须使用稳定 ID，并记录来源、置信度、版本和更新时间。
- **NFR-23：可替换边界。** 分析器、存储、查询和渲染层应保留可替换边界，支持后续接入更多语言、SCIP、矩阵视图或 MCP server。
- **NFR-24：支持平台与版本。** MVP 支持 Windows x64、macOS x64、macOS arm64 和 Linux x64；Windows arm64、Linux arm64 暂不支持。VS Code 扩展的最低版本为 1.125.0，发布时同时验证最低版本、最新稳定版和前一稳定版；CLI 要求 Node 24 LTS，平台 VSIX 自带经验证的 Node 24 LTS 运行时。
- **NFR-25：安装、升级与迁移。** 每个受支持组合必须通过新安装、离线启动、升级、降级、卸载以及缓存保留/清理验收。协议 major 或 schema 不兼容时必须安全拒绝并提示更新；图谱迁移只能由新服务事务化执行，失败时保留故障副本并允许重建，旧服务不得向新 schema 降级写入。
- **NFR-26：资源基线。** 在标准验收项目与参考环境中，首次 `rebuild` 的 graph-service 进程树峰值 RSS 不超过 4 GiB；按 1 秒间隔采样的整段运行平均 CPU 不超过整机 75%。在连续 5 分钟无活动任务（Job）的空闲窗口内，CPU p95 不超过整机 1%，窗口结束时 RSS 不超过 1.5 GiB。单工作区缓存、服务元数据与日志总量不超过 2 GiB，其中轮转日志不超过 100 MiB。版本化资源基准 manifest 必须固定 8 小时会话的 fixture、操作序列、采样间隔和空闲窗口；会话结束后的同条件空闲 RSS 不得比首小时基线增长超过 20%，Job 队列、句柄和临时文件不得持续单调增长。
- **NFR-27：服务生命周期与威胁边界。** 每个索引根目录（indexing root）最多运行一个按需启动的图谱服务；Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket。业务请求前必须校验随机令牌、workspace-key 和协议版本；端点冲突、伪造客户端或版本不兼容必须安全失败且不得误连第二实例。未授予 Workspace Trust 时不得启动服务、读取项目文件或运行 Git 分析；对所有路径执行 `realpath` 解析后，结果必须位于 indexing root 内。服务应在无客户端且无活动 Job 5 分钟后优雅退出，并在崩溃、重连、升级和 stale metadata 场景下可恢复。

非功能需求总数：**27**。NFR-1 至 NFR-27 连续、唯一，无缺号或重号。

### 其他要求与约束

- 产品边界：MVP 聚焦 VS Code、TypeScript/JavaScript、中大型本地仓库、结构理解与影响分析；MCP、云协作、hosted PR app、全语言、CPG/数据流、跨仓库图谱和 AI 自动重构明确不进入 MVP。
- 技术边界：薄 VS Code 客户端、本地 graph-service、TypeScript 6.0.3 Compiler API、SQLite/`better-sqlite3`、`GraphStorePort`、`AnalyzerPort`、JSON-RPC 2.0 本机 IPC、Cytoscape.js 局部图。
- 数据治理：仓库只保存 `.codegraph/rules.yaml` 与 `.codegraphignore`；生成图谱、锁、日志、last-valid 和临时文件位于 OS 用户缓存的 workspace-key 目录。
- 规则合同：`rules.yaml` v1 仅支持 `forbidden-dependency`、`layer-order`、`no-cycle`；未知字段和未知类型必须拒绝；rules ignore 与索引排除职责严格分离。
- 安全硬限制：单文件 10 MiB、最多 20,000 个候选源码文件、1,000 条规则、50 个 YAML alias、查询最多 3 跳/500 节点/1,000 边、最多 64 个待处理显式 Job。
- 兼容性：支持 Windows x64、macOS x64/arm64、Linux x64；Node 24 LTS；VS Code 最低 1.125.0；协议、图谱 schema、规则 schema 和 CLI schema 独立版本化。
- 发布门禁：`ProductValidationPlanV1`、`ReadinessGatePolicyV1`、`ReadinessGateManifestV1`、`ProductValidationEvidenceV1`、`ProductValidationResultV1` 与 `CandidateRefV1` 构成版本化、摘要绑定且不可人工解释放行的验证链。
- 成功指标：SM-1 至 SM-8 均具有样本、fixture、计时、正确性、阈值或证据合同；Beta、Beta+、v1.1 分别有独立适用性清单。

### PRD 完整性评估

**结论：完整，PRD 层面无阻塞缺口。**

- PRD 状态为 final，愿景、目标用户、UJ-1 至 UJ-5、FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8、范围和发布路径均已稳定编号。
- 关键性能、安全、隐私、可访问性、兼容性、资源、服务生命周期和发布验证要求均已量化或形成版本化合同。
- 当前无阻塞性开放问题，也无未确认假设。
- 2026-07-15 的历史协调记录仍描述“八项架构处置”，但 2026-07-16 的最新协调记录和 Addendum 已补入第九项产品验证/发布适用性处置；后者构成当前规范状态，不形成现行冲突。
- PRD 与 Addendum 的最新协调记录确认 FR、NFR、SM、UJ 数量与范围未发生未授权漂移。

## Epic 覆盖验证

### 覆盖矩阵

| FR | PRD 要求 | Epic / Story 覆盖 | 状态 |
| --- | --- | --- | --- |
| FR-1 | 初始化工作区图谱 | Epic 1：1.4、1.19、1.9；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-2 | 提取 TS/JS 依赖与 BasicSymbolV1 | Epic 1：1.5、1.6、1.7、1.8、1.9；Epic 5：5.12 | ✓ 已覆盖 |
| FR-3 | 保存后增量更新 | Epic 2：2.8、2.11；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-4 | 路径排除与噪声控制 | Epic 1：1.4、1.10、1.11、1.12、1.13；Epic 5：5.12 | ✓ 已覆盖 |
| FR-5 | 图谱版本、稳定 ID 与过期状态 | Epic 1：1.4、1.19、1.5、1.6、1.7、1.12、1.15、1.17；Epic 5：5.3、5.7、5.12 | ✓ 已覆盖 |
| FR-6 | 项目结构概览 | Epic 2：2.2、2.3；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-7 | 当前文件邻域图 | Epic 2：2.4、2.5；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-8 | 聚焦追踪与视图固定 | Epic 2：2.6；Epic 5：5.12 | ✓ 已覆盖 |
| FR-9 | 节点导航与上下文操作 | Epic 1：1.6；Epic 2：2.7；Epic 3：3.9；Epic 5：5.12 | ✓ 已覆盖 |
| FR-10 | 图形与任务等价文本视图 | Epic 2：2.2、2.3、2.4、2.5；Epic 3：3.9；Epic 4：4.5；Epic 5：5.12 | ✓ 已覆盖 |
| FR-11 | 循环依赖检测 | Epic 1：1.14；Epic 3：3.6；Epic 4：4.3；Epic 5：5.12 | ✓ 已覆盖 |
| FR-12 | 目录与层级依赖规则 | Epic 3：3.1–3.6；Epic 5：5.12 | ✓ 已覆盖 |
| FR-13 | 保存后 Findings 提示 | Epic 3：3.7、3.8、3.9；Epic 5：5.12 | ✓ 已覆盖 |
| FR-14 | 风险解释 | Epic 3：3.2、3.4–3.9；Epic 4：4.3；Epic 5：5.12 | ✓ 已覆盖 |
| FR-15 | CLI 规则检查 | Epic 3：3.10；Epic 5：5.12 | ✓ 已覆盖 |
| FR-16 | 读取本地变更集合 | Epic 4：4.1、4.8；Epic 5：5.12 | ✓ 已覆盖 |
| FR-17 | 结构变化摘要 | Epic 4：4.2、4.3、4.4、4.5、4.8；Epic 5：5.12 | ✓ 已覆盖 |
| FR-18 | Markdown PR Review 输出 | Epic 4：4.6；Epic 5：5.12 | ✓ 已覆盖 |
| FR-19 | 本地隐私边界 | Epic 1：1.16、1.18；Epic 2：2.9；Epic 5：5.1、5.2、5.5、5.8、5.10、5.12 | ✓ 已覆盖 |
| FR-20 | CLI 基础命令 | Epic 1：1.14、1.16；Epic 3：3.10；Epic 4：4.8、4.9；Epic 5：5.1、5.4、5.7、5.8、5.9、5.12 | ✓ 已覆盖 |
| FR-21 | 统一 graph-service 查询服务 | Epic 1：1.1、1.2、1.3、1.14；Epic 2：2.1、2.10；Epic 5：5.2、5.4、5.5、5.7、5.9、5.10、5.12 | ✓ 已覆盖 |
| FR-22 | 状态与故障恢复 | Epic 1：1.2–1.4、1.11–1.15、1.17、1.19；Epic 2：2.1、2.8、2.10、2.11；Epic 3：3.2、3.3；Epic 5：5.2–5.7、5.9、5.12 | ✓ 已覆盖 |
| FR-23 | 结构上下文导出 | Epic 4：4.7、4.9；Epic 5：5.12 | ✓ 已覆盖 |

### 缺失要求

未发现缺失的功能需求。每条 FR 均由具体能力 Story 承接，而不是仅依赖 Story 5.12 的总体验收声明。

未发现 Epics/Stories 中引用但 PRD 不存在的额外 FR 编号。

### 覆盖统计

- PRD 功能需求总数：23
- Epics/Stories 已覆盖：23
- 缺失：0
- 覆盖率：**100%**
- Story 需求记录：61/61 个 Story 块均具有显式“关联需求”字段

## UX 对齐评估

### UX 文档状态

**已找到且状态为 final。** 本次评估使用：

- `ux-designs/ux-bmad-2026-07-13/DESIGN.md`
- `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`
- 三份 PRD/Sprint 变更协调记录

UX 文档没有独立 mockup 或 wireframe，但已提供视觉 token、组件合同、信息架构、状态模式、交互原语、响应式矩阵、无障碍门槛和五条关键用户旅程；独立视觉稿不是实施前置条件。

### UX ↔ PRD 对齐

- UJ-1 至 UJ-5 与 PRD 的角色、入口、主路径、高潮、失败路径及 MVP/v1.1 边界一致。
- Project Overview、Current Context、Findings、Changes/PR Summary、Export Preview 等 surface 完整承接 FR-6 至 FR-23。
- 60 秒首次概览、300ms warm-cache 邻域、2 秒保存更新及 100 节点/200 边预算与 NFR-3 至 NFR-6 一致。
- WCAG 2.2 AA、图/列表任务等价、全键盘、可见焦点、24×24 CSS px、200% 字号和减少动态效果与 NFR-17 至 NFR-20 一致。
- Workspace Trust、本地优先、默认关闭遥测、相对路径、默认不含源码和本机 IPC 与 FR-19、NFR-12 至 NFR-16、NFR-27 一致。
- directory、workspace package、“模块”称谓、Node built-in 与 `references` 排除语义与最新 PRD/Addendum 一致。
- zh-CN/en 本地化合同没有独立 PRD 编号，但已作为 UX-DR4 纳入 Epics/Stories 和规划追踪门禁，不构成漏实施。

### UX ↔ Architecture 对齐

| UX 关注点 | 架构支持 | 结论 |
| --- | --- | --- |
| VS Code surface 职责 | AD-10、Guide §2/§11 固定 TreeView、Webview、Problems、Status Bar、Command Palette 责任 | 已对齐 |
| 图/列表等价和键盘/屏幕阅读器 | AD-15、Guide §11 固定等价模型、键盘语义、主题、高对比、减少动态效果 | 已对齐 |
| 稳定刷新与空间记忆 | AD-7、AD-22、Guide §9 的 GraphViewModel/GraphViewPatchV1、三组 revision 与完整重取规则 | 已对齐 |
| Overview 聚合、指标和正式排名 | AD-25、Guide §9 固定 ProjectionMembershipV1、指标、排序和 current+complete 条件 | 已对齐 |
| 状态、取消和故障恢复 | AD-7、AD-8、AD-23 固定 lifecycle/freshness/completeness、Job 与缓存保留 | 已对齐 |
| Workspace Trust 与 Webview 安全 | AD-11、Guide §11 固定未信任不分析、CSP、nonce、消息校验和路径边界 | 已对齐 |
| 性能与 extension host 隔离 | AD-15、AD-19、Guide 阶段 C/§9 固定 Web Worker、60s/300ms/2s 和超规模退化 | 已对齐 |
| Findings 与配置诊断 | AD-9、AD-17、Guide §10 固定稳定 Finding、精确范围、stale/resolved 与统一诊断 | 已对齐 |
| PR/AI 完整 artifact | AD-18、Guide §12 固定完整后才可复制/写出、默认 structure-only 和旧结果隔离 | 已对齐 |
| 结构影响 verdict | AD-26、Guide §12 固定 application/impact 唯一计算与稳定排序 | 已对齐 |

### 对齐问题

#### UX-A1 — 非阻塞开放假设未转为明确范围决定

`EXPERIENCE.md` 的 `Open UX Assumptions` 仍保留：“Finding 首版只支持定位与修复验证，不提供 UI 内忽略、豁免审批或历史趋势。”最新协调记录也将其列为非阻塞验证项。

- 影响：当前 Stories 没有 UI 忽略、豁免审批或趋势能力，因此不会造成既有实施范围遗漏；但“假设”状态与 PRD 的“当前无未确认假设”表述不完全一致。
- 建议：实施开始前将其改为明确的 MVP Out-of-Scope 决定，或指定负责人和重新评估触发条件。
- 严重度：Low / 非阻塞。

### 警告

- 真实 Webview 的主题、断点、200% 字号、焦点、NVDA/VoiceOver/Orca 证据尚未产生；这是 Story 5.5 与发布门禁需要完成的实施证据，不是规划要求缺失。
- 候选快捷键仍需按 UX 规定在三个 VS Code 版本和各平台完成冲突矩阵；Command Palette 保证功能不依赖默认快捷键。

## Epic 与 Story 质量审查

### 总体结论

- Epic 数量：5
- Story 数量：61
- Story 用户叙述完整性：61/61 均包含 As a / I want / So that
- BDD 验收块：347 组 Given / 347 组 When / 347 组 Then，数量完全配对
- 单 Story 体量：32–58 行，4–8 个 BDD 场景；未发现明显 Epic-sized Story
- 需求追踪：61/61 均有“关联需求”字段

### Epic 结构检查

| Epic | 用户价值 | 独立性与依赖方向 | 结论 |
| --- | --- | --- | --- |
| Epic 1：构建、查询并恢复可信的本地代码图谱 | 用户可通过 CLI 创建、查询、诊断和恢复本地图谱 | 绿地起点，可独立交付 Alpha；不依赖后续 Epic | 通过 |
| Epic 2：在 VS Code 中快速理解项目与当前文件影响 | 用户在 IDE 内获得 Overview、Current Context 和增量状态 | 只消费 Epic 1；基础循环已前置到 Epic 1，不反向依赖 Epic 3 | 通过 |
| Epic 3：在编码时发现并解释架构风险 | 用户声明规则并获得稳定、可定位、可解释 Findings | 只消费 Epic 1/2 的图谱与宿主能力 | 通过 |
| Epic 4：审查变更并导出结构上下文 | Tech Lead 可审查变更、生成 PR 摘要，开发者可导出 AI 上下文 | 只消费前序图谱、Findings 与宿主能力 | 通过 |
| Epic 5：可安装、可升级、可离线使用 | 用户获得可安装、可恢复、可验证的完整产品 | 属于最终交付与发布验证，不依赖未来 Epic | 通过 |

Epic 1 的仓库模板、CI 和空服务 Story 属于绿地项目必要的 enabling slices；它们由“项目贡献者/维护者”价值叙述和真实阻断门禁约束，没有被错误提升为纯技术 Epic。

### 严重问题

无 Critical 级问题：未发现技术型 Epic、循环依赖、Story 依赖未来能力才能实现，或无法拆分的 Epic-sized Story。

### Major 问题

#### EQ-M1 — Story 依赖图未完整显式化

61 个 Story 中只有 16 个具有 `**依赖：**` 字段，45 个依赖全局“文档顺序与显式依赖共同定义执行顺序”。这可以形成无环总顺序，但无法区分真正独立、可并行 Story 与遗漏依赖。

具体例子：

- Story 2.3 的 AC 明确以 Story 2.2 的 Overview 模型为前提，但没有依赖字段。
- Story 2.5 的 AC 明确以 Story 2.4 的邻域模型为前提，但没有依赖字段。
- Story 3.2 的 last-valid 恢复语义依赖 Story 3.1 的规则解析与有效策略，但没有依赖字段。
- Story 4.2 的结构边变化计算依赖 Story 4.1 的 ChangeSet；Story 4.5/4.6 依赖 Story 4.4 的 ImpactVerdictV1，但均未完整写入依赖字段。

影响：实现代理若按 Story ID、显式依赖或可并行性调度，可能错误提前启动；若严格按全文顺序，又会把本可并行的 Story 不必要地串行化。

建议：为所有非起点 Story 增加规范 `dependsOn`，或增加覆盖全部 61 个 Story 的机器可读 DAG；文档顺序只作为展示顺序，不作为隐式依赖语义。

#### EQ-M2 — Story 1.1 含未来 Story 才能触发的验收条件

Story 1.1 的最后一组 AC 使用：

- Given Story 1.1 已合并
- When Story 1.2 开始或提交
- Then Story 1.2 只能通过同一最小 CI 顺序合并

该目标正确，但 Story 1.1 在 Story 1.2 尚未开始时无法独立完成这项实际触发验证。

建议：Story 1.1 只验收 required check 已配置、对后续 PR always-run 且失败可阻断；把“Story 1.2 确实通过同一门禁合并”的证据移入 Story 1.2。这样保留架构时序要求，同时恢复 Story 1.1 的独立完成性。

### Minor 问题

#### EQ-L1 — Story 5.11 的依赖措辞不够确定

Story 5.11 写为“Story 5.6 至 Story 5.10 可提供技术与候选输入”，而文档末尾依赖矩阵将 5.6–5.10 列为必须依赖。虽然文档顺序仍把 5.11 放在其后，但 `可提供` 与 `必须依赖` 的强度不一致。

建议：明确选择“必须依赖 5.6–5.10”或“合同可提前建立、执行证据依赖 5.6–5.10”，并同步依赖矩阵。

### 通过项

- 没有 Epic N 依赖 Epic N+1。
- 所有未来 Story 引用均为顺序护栏或发布门禁说明，没有要求当前实现消费尚不存在的能力；Story 1.1 的验收归属例外已单独记录。
- Story 1.4 只创建当前能力所需最小 SQLite 表，并明确禁止预建 Findings、impact、export 或发布表，符合按需建模原则。
- Story 1.1 明确使用官方 VS Code TypeScript + esbuild 模板，满足架构 starter template 要求。
- Greenfield 项目的仓库初始化、开发命令、依赖边界和真实 CI 位于最早阶段。
- AC 普遍覆盖成功、失败、取消、stale、兼容、安全、预算和恢复路径；未发现“正确工作”“用户可使用”一类不可测的模糊验收。

## 总结与建议

### 总体实施就绪状态

## NEEDS WORK

产品范围、需求完整性、架构可实现性和 UX 主干已经成熟；FR 覆盖率为 100%，没有 Critical 级缺口。当前不建议直接启动功能 Story 的并行实施，原因是 Story 依赖合同仍存在两项 Major 质量问题，可能导致执行代理错误排序、过度串行化或无法独立验收 Story 1.1。

这些问题是规划制品修订，不需要重做 PRD、Architecture 或核心 UX。

### 立即阻塞项

无 Critical 级阻塞项。

### 实施前必须处理的 Major 问题

1. **补全 Story 依赖 DAG。** 将 45 个缺少显式依赖字段的 Story 区分为真正独立、同 Epic 前置和跨 Epic 前置；至少补齐 2.3→2.2、2.5→2.4、3.2→3.1、4.2→4.1、4.5/4.6→4.4 等已由 AC 或能力语义证明的依赖。
2. **恢复 Story 1.1 的独立验收。** Story 1.1 只验收最小 CI 已配置、always-run、可真实失败并阻断；将 Story 1.2 实际通过该门禁的证据移入 Story 1.2。

### 后续改进项

3. 明确 Story 5.11 与 5.6–5.10 的关系：是合同可提前建立，还是必须等待候选/证据输入；统一 Story 正文与依赖矩阵的约束强度。
4. 将 UX 的 Finding UI 忽略、豁免审批和历史趋势假设转为明确 MVP Out-of-Scope，或记录负责人、决策期限和重新评估条件。
5. 修订后重新运行 Implementation Readiness，重点复核 Story DAG、Story 1.1/1.2 验收归属和 UX 假设状态。

### 已通过的关键门禁

- PRD：23 条 FR、27 条 NFR、8 条 SM、5 条 UJ，编号连续且最新协调记录无剩余 gap。
- Epic 覆盖：23/23 FR，覆盖率 100%，没有额外未知 FR。
- Architecture：30 条已采用架构决定覆盖核心边界；UX surface、状态、性能、安全、可访问性和 artifact 语义均有实施落点。
- UX：设计与体验 spine 状态 final，五条用户旅程与 PRD 一致；无独立 mockup 不构成实施阻塞。
- Story 质量：61/61 用户叙述完整，61/61 有需求追踪，347 组 BDD 验收结构完整，未发现 Epic-sized Story。
- 依赖方向：未发现 Epic 依赖未来 Epic、循环依赖或真实的前向能力消费。

### 问题统计

- Major：2
- Minor / Low：2
- Critical：0
- 涉及类别：UX 对齐、Epic/Story 质量

### 最终说明

本评估共识别 4 项需要处理的问题。两项 Major 应在开始功能 Story 实施前修复；两项 Minor/Low 可以与修订同步关闭。修复完成后，预期无需再次修改 PRD 或架构即可达到 READY。

**评估日期：** 2026-07-16  
**评估人：** Winston（System Architect）/ Implementation Readiness Workflow
