---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md
  - _bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md
  - _bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
workflowType: implementation-readiness
date: 2026-07-16
project: bmad
overallReadinessStatus: READY
issuesRequiringAttention: 5
criticalIssues: 0
majorIssues: 0
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-16
**Project:** bmad

## 文档发现

### PRD 文档

- `prds/prd-bmad-2026-07-09/prd.md`（42,919 字节，修改于 2026-07-16 12:46:37）
- `prds/prd-bmad-2026-07-09/addendum.md`（18,741 字节，修改于 2026-07-16 12:43:45）

### 架构文档

- `architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`（70,736 字节，修改于 2026-07-16 12:27:58）
- `architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md`（72,105 字节，修改于 2026-07-16 12:27:58）

### Epics 与 Stories 文档

- `epics.md`（158,162 字节，修改于 2026-07-16 15:59:22）

### UX 文档

- `ux-designs/ux-bmad-2026-07-13/DESIGN.md`（15,663 字节，修改于 2026-07-16 14:09:22）
- `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`（28,924 字节，修改于 2026-07-16 15:59:22）

### 发现结论

- 四类必需文档均已找到。
- 未发现整篇版与 `index.md` 分片版并存的重复冲突。
- PRD、架构和 UX 采用无 `index.md` 的嵌套文档集；经用户确认，将上述互补文件共同作为评估输入。
- 评审记录、对账记录、变更提案及历史实施就绪报告不作为本轮核心输入。

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

**功能需求总数：23。编号 FR-1 至 FR-23 连续，无缺号。**

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

**非功能需求总数：27。编号 NFR-1 至 NFR-27 连续，无缺号。**

### 附加需求与约束

#### 产品范围与发布切片

- MVP 聚焦 VS Code、CLI、TypeScript/JavaScript、常见 npm/Yarn/pnpm monorepo、本地图谱、局部视图、规则、git diff 影响摘要、Markdown PR 摘要与本地结构上下文导出。
- 全语言、运行时调用图、数据流/CPG、安全分析、云端协作、账号/SSO、hosted PR app、AI 自动重构、MCP server、可视化规则编辑器、独立 Web dashboard、历史趋势、跨仓库图谱和重型图数据库均明确排除在 MVP 外。
- Beta 只代表首个可用版本；Beta+ 才覆盖完整 MVP。v1.1/MCP 只有在完整 MVP 门禁和 UJ-5 价值门禁通过后才能启动。

#### 技术与架构合同

- 入口固定为 VS Code Extension 与 CLI；实现语言/工具链为 TypeScript 6.0.3。
- CLI 使用 Node 24 LTS；平台 VSIX 携带经验证的 Node 24 LTS 运行时及对应 ABI 的 SQLite 模块，不依赖用户 Node 或 VS Code/Electron ABI。
- TypeScript 6.0.3 稳定 Compiler API 是 TS/JS 权威分析源；TypeScript 7 unstable API、Tree-sitter、LSP、SCIP/CPG 不进入首个实现。
- SQLite/`better-sqlite3` 是首个存储实现，必须通过 `GraphStorePort` 访问；分析器通过 `AnalyzerPort`，持久模型不得绑定 Cytoscape.js。
- Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket，应用协议为 JSON-RPC 2.0，禁止监听 TCP。
- MVP 规范边只包括 `contains`、`imports`、`exports` 与派生 `depends_on`；`references` 不得进入生成、导航、导出、指标或发布声明。
- 内部实体采用确定性、工作区作用域稳定 ID；路径使用 Unicode NFC 与相对 POSIX 形式。
- graph-service 是唯一组合根；插件保持薄客户端，查询投影、规则评估和影响计算在 application/service 侧统一完成。

#### 配置、规则与数据治理

- `.codegraph/rules.yaml` 使用 `version: 1`，未知字段和未知类型必须拒绝；JSON Schema 2020-12 是公共合同，YAML 解析保留位置以生成可操作诊断。
- `.codegraphignore`/`BuiltinIgnoreV1` 控制索引范围，`rules.yaml` 的 `ignore` 只裁剪规则评估范围，两者语义不得混淆。
- 仓库只保存 `.codegraph/rules.yaml` 与 `.codegraphignore`；数据库、服务 metadata、锁、日志、临时文件和 last-valid 数据位于 OS 用户缓存，不写入工作区。
- 本地结构导出默认 `structure-only`。只有完整、不可变、带 artifactId、完整性、revision/policy、`containsSource`、contentDigest 和 generatedAt 的 `ExportArtifactV1` 才能复制或写出；失败不得泄露部分内容。

#### CLI、IDE 与输出合同

- CLI 公共命令固定为 `rebuild/query/check/impact/export/status/doctor/cache`；默认文本，`--format json` 使用 `schemaVersion: 1` envelope；stdout/stderr 职责分离，退出码固定为 0/1/2/3/4/130。
- VS Code TreeView 负责入口、状态与导航；Webview Editor 负责 Overview、Current Context、Changes 的图和等价列表；Problems 只承载可定位诊断；Status Bar 只显示单行状态；全部操作同时注册 Command Palette。
- `PrReviewSummaryV1` 固定包含 verdict、majorRisks、keyPaths、边/循环变化、建议复查文件和 revision/时间信息；`ImpactVerdictV1` 只能由 application/impact 计算，客户端不得重算。

#### 安全与资源硬限制

- 未授予 Workspace Trust 时不得启动服务、读取项目文件或运行 Git 分析；所有路径 `realpath` 后必须仍位于 indexing root，必须拒绝路径穿越和越界 symlink。
- Webview 使用严格 CSP、nonce、无网络访问和消息 Schema 校验，且不得直接连接 graph-service。
- 安全上限：单文件 10 MiB、最多 20,000 个候选源码文件、1,000 条规则、50 个 YAML alias；查询最多 3 跳、500 节点、1,000 边；最多 64 个待处理显式 Job。超限返回稳定诊断，不执行项目代码或静默截断规则。
- 服务只在 migration、watcher、配置/manifest 对账与 bootstrap barrier 完成后进入 running；无客户端且无活动 Job 5 分钟后优雅退出，禁止自动强杀活动事务。

#### 正确性、性能与产品验证合同

- `BenchmarkPlanV1` 固定 fixture/digest、参考环境、cold/warm cache、起止事件、2 次 warm-up、至少 20 次测量与 nearest-rank p95，输出机器可读 `BenchmarkResultV1`。
- FR-2 正确性门禁使用至少 500 条版本化人工标注声明，规范依赖边 micro-F1 ≥ 0.80、high-confidence precision ≥ 0.90，并保留分类结果与失败样本。
- 规则验证至少覆盖 30 个合同内案例；预期 error/warning Finding 的 recall 与 precision 均必须为 1.00，error 漏报与负对照误报均为 0。
- UJ-2 任务至少 10 个有效会话，至少 80% 在 180 秒内正确完成；同一任务包下至少 70% 用户对“比目录树和搜索更快理解结构影响”评分达到 4/5 以上。
- Tech Lead PR 摘要验证至少覆盖 5 名 Tech Lead、3 个独立团队，至少 80% 单次验证通过；失败样本必须保留并关联复测条件。
- UJ-5 价值门禁至少 8 名 AI 编码重度用户、3 个真实仓库、2 个独立团队；至少 75% 正确识别允许范围和禁止边界且评分 ≥ 4/5，任何源码、绝对路径或未授权内容泄露均使门禁失败。
- `ProductValidationPlanV1`、`ReadinessGatePolicyV1`、`ReadinessGateManifestV1`、`ProductValidationEvidenceV1`、`ProductValidationResultV1` 与 `CandidateRefV1` 构成唯一验证链；对象使用 JSON Schema 2020-12、`additionalProperties:false`、稳定 ID 和摘要绑定。版本、schema、digest、candidateRef 或引用链不匹配时结果必须为 invalid，不能人工放行。
- Beta+ release manifest 必须逐项展开 FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8 以及发布完整性和信任链 gate；任一 blocking gate 为 fail 或 invalid 即 No-Go。

### PRD 完整性初评

- **完整性强：** PRD 状态为 final，FR 与 NFR 编号连续，全部核心能力均提供可测试后果；用户旅程、MVP 边界、成功指标、风险、阶段门禁和技术附录齐全。
- **可追溯性强：** FR 明确关联 UJ，成功指标明确关联 FR，Addendum 将技术与发布合同绑定到架构决策。
- **当前无声明的阻塞项：** 开放问题和假设索引均明确为空。
- **实施复杂度风险：** 需求虽然清晰，但完整 MVP 同时包含严格的稳定 ID、版本化 schema、摘要信任链、跨平台运行时、资源长测、产品研究门禁和无障碍要求；史诗与故事必须逐项覆盖，不能只覆盖用户可见功能。
- **权威来源约束：** PRD 主体定义产品能力与结果，Addendum 和已采用的架构文档定义技术实现合同；后续若存在冲突，必须显式对账，不能隐式选择。

## Epic 覆盖验证

### FR 覆盖矩阵

| FR | PRD 需求 | Epic / Story 追踪 | 状态 |
| --- | --- | --- | --- |
| FR-1 | 初始化工作区图谱 | Epic 1：1.4、1.19、1.9；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-2 | 提取 TS/JS 依赖与基础符号 | Epic 1：1.5～1.9；Epic 5：5.12 | ✓ 已覆盖 |
| FR-3 | 保存后增量更新 | Epic 2：2.8、2.11；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-4 | 路径排除与噪声控制 | Epic 1：1.4、1.10～1.13；Epic 5：5.12 | ✓ 已覆盖 |
| FR-5 | 图谱版本、稳定 ID 与过期状态 | Epic 1：1.4、1.19、1.5～1.7、1.12、1.15、1.17；Epic 5：5.3、5.7、5.12 | ✓ 已覆盖 |
| FR-6 | 项目结构概览 | Epic 2：2.2、2.3；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-7 | 当前文件邻域图 | Epic 2：2.4、2.5；Epic 5：5.6、5.12 | ✓ 已覆盖 |
| FR-8 | 聚焦追踪与视图固定 | Epic 2：2.6；Epic 5：5.12 | ✓ 已覆盖 |
| FR-9 | 节点导航与上下文操作 | Epic 1：1.6；Epic 2：2.7；Epic 3：3.9；Epic 5：5.12 | ✓ 已覆盖 |
| FR-10 | 图与任务等价文本视图 | Epic 2：2.2～2.5；Epic 3：3.9；Epic 4：4.5；Epic 5：5.12 | ✓ 已覆盖 |
| FR-11 | 多层级循环依赖检测 | Epic 1：1.14；Epic 3：3.6；Epic 4：4.3；Epic 5：5.12 | ✓ 已覆盖 |
| FR-12 | 目录、层级与循环规则 | Epic 3：3.1～3.6；Epic 5：5.12 | ✓ 已覆盖 |
| FR-13 | 保存后 Findings 提示 | Epic 3：3.7～3.9；Epic 5：5.12 | ✓ 已覆盖 |
| FR-14 | 风险解释 | Epic 3：3.2、3.4～3.9；Epic 4：4.3；Epic 5：5.12 | ✓ 已覆盖 |
| FR-15 | CLI 规则检查 | Epic 3：3.10；Epic 5：5.12 | ✓ 已覆盖 |
| FR-16 | 读取本地变更集合 | Epic 4：4.1、4.8；Epic 5：5.12 | ✓ 已覆盖 |
| FR-17 | 结构变化摘要 | Epic 4：4.2～4.5、4.8；Epic 5：5.12 | ✓ 已覆盖 |
| FR-18 | Markdown PR Review 输出 | Epic 4：4.6；Epic 5：5.12 | ✓ 已覆盖 |
| FR-19 | 本地隐私边界 | Epic 1：1.16、1.18；Epic 2：2.9；Epic 5：5.1、5.2、5.5、5.8、5.10、5.12 | ✓ 已覆盖 |
| FR-20 | CLI 公共命令面 | Epic 1：1.14、1.16；Epic 3：3.10；Epic 4：4.8、4.9；Epic 5：5.1、5.4、5.7～5.9、5.12 | ✓ 已覆盖 |
| FR-21 | 统一本地图谱服务 | Epic 1：1.1～1.3、1.14；Epic 2：2.1、2.10；Epic 5：5.2、5.4、5.5、5.7、5.9、5.10、5.12 | ✓ 已覆盖 |
| FR-22 | 图谱状态与故障恢复 | Epic 1、Epic 2、Epic 3 的状态/恢复切片；Epic 5：5.2～5.7、5.9、5.12 | ✓ 已覆盖 |
| FR-23 | 结构上下文导出 | Epic 4：4.7、4.9；Epic 5：5.12 | ✓ 已覆盖 |

### 覆盖差距

- 未发现缺失的 PRD 功能需求。
- 未发现 Epics 文档中存在但 PRD 不存在的额外 FR 编号。
- Epics 顶部 `FR 覆盖图` 与 Story 正文的 `关联需求` 交叉核对一致：FR-1～FR-23 均至少具有一个功能实现 Story，并由 Story 5.12 的完整候选审计再次覆盖。

### 覆盖统计

- PRD 功能需求总数：23
- Epics 已覆盖功能需求：23
- 缺失功能需求：0
- 额外/未知功能需求：0
- **FR 覆盖率：100%**

## UX 对齐评估

### UX 文档状态

- 已找到并完整读取两份状态为 `final` 的 UX 文档：`DESIGN.md` 与 `EXPERIENCE.md`。
- 两份 UX spine 均明确引用当前 PRD、Addendum 与 2026-07-16 纠偏材料，并被架构文档反向列为 sources。
- 当前没有 mockup、wireframe 或导入视觉素材；UX 文档明确规定 spine 为权威合同，独立 mockup 不是实施前置条件。

### UX ↔ PRD 对齐

| 对齐领域 | PRD | UX | 结论 |
| --- | --- | --- | --- |
| 用户旅程 | UJ-1～UJ-5 | Key Flows 逐条覆盖 UJ-1～UJ-5，并补充失败路径 | 对齐 |
| 项目概览与局部邻域 | FR-6～FR-10 | Project Overview、Current Context、图/列表任务等价、ContextLock、Entity Details | 对齐 |
| 保存后增量与风险提示 | FR-3、FR-11～FR-14 | 非模态更新、Findings、精确 actual/expected 证据、stale/failed 保留缓存 | 对齐 |
| 变更影响与导出 | FR-16～FR-18、FR-23 | Changes / PR Summary、Export Preview、完整不可变 artifact、失败不暴露部分内容 | 对齐 |
| 隐私与遥测 | FR-19、NFR-12～NFR-16 | 默认本地、默认关闭遥测、明确 opt-in/off 状态和敏感字段禁令 | 对齐 |
| 性能 | NFR-1～NFR-7 | 60 秒首次概览、300ms 缓存邻域、2 秒保存更新、500ms 慢查询反馈、预算与超规模退化 | 对齐 |
| 可访问性 | NFR-17～NFR-20 | WCAG 2.2 AA、图/列表等价、键盘、屏幕阅读器、高对比、200% 字号、减少动态效果 | 对齐 |
| 范围边界 | MVP In/Out of Scope | 禁止默认全仓库大图；Finding 首版不含 UI 豁免/审批/历史趋势；MCP 延后 | 对齐 |

### UX ↔ Architecture 对齐

- **宿主与 surface：** AD-10 固定 Activity Bar/TreeView、Webview Editor、Problems、Status Bar 与 Command Palette 的职责，直接支撑 UX 信息架构。
- **预算与渐进披露：** AD-7、AD-25 由服务端生成预算内 `GraphViewModel`、`ProjectionMembershipV1`、稳定排序、聚合与 `expandToken`，支撑 Overview 和 Current Context。
- **刷新与空间记忆：** AD-7 的 `GraphViewPatchV1`、AD-22 的 `viewConfigRevision` 及实施指南的三时钟校验，支撑原子更新、保留中心/选择/缩放/展开/列表位置。
- **视图固定：** AD-10 明确 ContextLock 只持续当前 extension-host 会话，Webview reload 可恢复，窗口 reload/重启后清除，与 UX 完全一致。
- **状态与故障恢复：** AD-7、AD-8、AD-23 定义 lifecycle/availability/freshness/completeness、Job、取消、stale、partial、failed 与缓存保留，覆盖 UX 状态模式。
- **安全与信任：** AD-11 定义 Workspace Trust、路径 realpath、IPC token、CSP、nonce、消息 Schema 和安全预算，覆盖未信任工作区与 Webview 威胁边界。
- **可访问性：** AD-15 要求图/列表任务等价、固定键盘语义、屏幕阅读器字段、主题/高对比/减少动态效果，并要求布局在 Web Worker 中执行。
- **导出与 PR 摘要：** AD-18、AD-26 定义完整不可变 artifact、structure-only 默认策略、目标失败重试、唯一 verdict/排序生产者，覆盖 Export Preview 与 Changes 体验。
- **性能与验证：** AD-19、实施指南 §13 将 UX 响应指标、真实 Webview、辅助技术和发布候选验证转为阻断门禁。

### 对齐问题与警告

1. **非阻塞：部分 UX 约束不是 PRD 编号需求。** zh-CN/en 本地化、900/600/360 候选响应阈值、真实 Webview 宽度矩阵以及 NVDA/VoiceOver/Orca spot check 未作为独立 FR/NFR 编号出现。它们已由 UX-DR4、UX-DR36、UX-DR37、Epic 2 DoD、Story 2.10 与 Story 5.5 追踪，且架构要求 release manifest 展开 UX-DR，因此当前没有实施覆盖缺口；应保持 UX-DR 追踪门禁，防止后续只按 FR/NFR 清单裁剪。
2. **非阻塞：视觉证据尚未产生。** 当前无 mockup/wireframe，主题、响应式、焦点、200% 字号和辅助技术行为只能在真实 Webview 中验证。Epic 2 首个 surface 与 Story 5.5 已承担阻断证据；实施前无需补造静态稿，但首个真实切片不能延后该验证。
3. **未发现架构无法支撑的 UX 组件或流程。** UX 所有主要 surface 均具有明确的 application、contract、extension 或 webview 落点。

### UX 对齐结论

UX、PRD 与架构在产品旅程、状态语义、交互责任、性能、安全、隐私、可访问性和交付门禁方面一致。当前只有需持续追踪的证据风险，没有阻塞实施的对齐缺口。

## Epic 与 Story 质量审查

### 自动结构与依赖验证结果

- Epic 数量：5。
- Story 标题数量：61。
- `StoryDependencyDagV1` 节点数量：61。
- 缺失或多余 DAG 节点：0。
- 无效依赖引用：0。
- 依赖环：0。
- 依赖未来 Epic：0。
- 同一 Epic 内依赖展示顺序之后的 Story：0。
- DAG 合法起点：仅 Story 1.1。
- 61 个 Story 均包含 `As a / I want / So that`、`关联需求`、`Acceptance Criteria` 以及至少一组 Given/When/Then。

### Epic 结构评估

| Epic | 用户价值 | 独立性与依赖方向 | 结论 |
| --- | --- | --- | --- |
| Epic 1：构建、查询并恢复可信的本地代码图谱 | 用户可通过 Alpha CLI 建立、查询、诊断和恢复本地图谱，具有独立可用价值 | 独立起点，不依赖后续 Epic | 合格 |
| Epic 2：在 VS Code 中快速理解项目与当前文件影响 | 用户在 IDE 中获得 Overview、Current Context、列表/图和增量体验 | 只依赖 Epic 1，不依赖规则 Epic 3；基础循环由 Epic 1 提供 | 合格 |
| Epic 3：在编码时发现并解释架构风险 | 用户可以配置规则、查看/修复 Findings 并运行 CLI check | 依赖 Epic 1/2 的图谱、增量和宿主能力，不依赖未来 Epic | 合格 |
| Epic 4：审查变更并导出结构上下文 | Tech Lead 可进行本地影响审查、PR 摘要和结构导出 | 只消费 Epic 1～3 的图谱、Finding 和 UI 基础 | 合格 |
| Epic 5：可安装、可升级、可离线使用 | 用户获得可安装、跨平台、可升级、可验证且离线可用的完整产品 | 累积验证 Epic 1～4，不被未来能力阻塞 | 合格 |

所有 Epic 标题和目标均描述用户或产品使用者可以获得的结果，没有以“建数据库”“开发 API”一类纯技术里程碑作为 Epic。

### Story 质量评估

- **用户价值：** 基础设施 Story 使用项目贡献者、CLI/扩展开发者、维护者或发布负责人作为合法内部用户，并明确说明它们如何使后续可用能力可靠交付；没有无目的的“创建模型/搭环境”Story。
- **独立可完成性：** 权威 DAG 只列直接完成前置，所有依赖均指向已完成的当前或前序 Epic Story；文档展示顺序已按依赖调整，非单调 Story ID 不形成前向依赖。
- **验收标准：** AC 普遍覆盖正常、失败、取消、stale/partial、越界、安全和门禁路径，结果具体且可机器或集成测试验证，没有仅写“功能可用”的模糊验收。
- **可追溯性：** 每个 Story 均有 FR/NFR/AR/UX-DR/SM 等关联需求；末尾另有需求追踪和关键合同双向映射。
- **数据库时机：** Story 1.4 明确只创建当前切片使用的表，`findings` 等未来表在能力首次落地时增量迁移，未提前创建全量模型。
- **Starter Template：** Story 1.1 明确使用官方 VS Code TypeScript + esbuild 模板，并同时建立 pnpm workspace、依赖边界和真实最小 CI，符合绿地项目要求。
- **CI 时机：** Story 1.1 建立真实最小门禁，Story 1.3 再强化 provider/manifest/追踪；能力首次公开时同步加入真实 gate，未把质量门禁推迟到发布尾声。

### 🔴 Critical Violations

无。

### 🟠 Major Issues

无。

### 🟡 Minor Concerns

1. **Story 4.6 位于合理规模上沿。** 该 Story 含 8 组 AC，同时覆盖 PR Markdown 生成、structure-only/include-source 策略、预算截断、artifact 身份、生成失败、目标失败重试和过期显示。它仍围绕“生成可直接使用的 PR Markdown”形成单一端到端价值，不构成 Epic-sized Story；实施时应保持 application/exporting 与 extension 本地目标操作的清晰提交边界。若一个迭代无法完成，可拆为“生成完整 artifact”与“预览/目标投递”，但不得拆散不可变 artifact 合同。
2. **Story ID 与展示顺序非单调。** 1.19 位于 1.5 之前，2.10/2.11 位于 2.2/2.9 之前。文档已明确 ID 稳定、展示顺序非权威、DAG 为唯一依赖来源，并且当前顺序不存在前向依赖。建议保留自动 DAG 校验，禁止实现代理按数字大小推断依赖。
3. **Story 5.12 的直接追踪行未显式列出 UX-DR。** 文末追踪表和架构要求已声明发布 manifest 逐项展开适用 UX-DR，因此没有实际覆盖缺口；为降低人工阅读歧义，建议在 Story 5.12 的 `关联需求` 中补充“适用 UX-DR 由 ReadinessGateManifestV1 逐项展开”。

### Epic 质量结论

Epic/Story 结构符合实施标准：用户价值明确、依赖有向无环、无未来依赖、Story 粒度总体可控、BDD 验收具体、数据库与门禁按能力首次使用落地。当前未发现阻塞实施的结构性缺陷。

## 总结与建议

### 总体实施就绪状态

**READY — 已具备开始实施的条件。**

判定依据：

- PRD、Addendum、Architecture、UX、Epics/Stories 均存在且状态完整。
- FR-1～FR-23 全部被 Epic 与 Story 覆盖，覆盖率 100%，无未知 FR。
- UX 的五条用户旅程与 PRD 一致，架构为所有主要 surface、状态、性能、安全和可访问性要求提供了明确落点。
- 5 个 Epic 均交付用户价值，61 个 Story 与权威 DAG 一致，无环、无未来依赖、无缺失节点。
- 未发现 Critical 或 Major 规划缺陷。

此 READY 结论表示“规划材料足以安全启动实施”，不表示产品门禁已经通过。Beta、Beta+ 与 v1.1 仍必须执行各自版本化 `ReadinessGateManifestV1`，不能用本报告替代实现、性能、产品验证、发布完整性或信任链证据。

### 需要立即处理的关键问题

无 Critical 或 Major 问题需要在启动实施前阻塞修复。

### 需要持续跟踪的非阻塞事项

共 5 项：

1. 保持 UX-DR4、UX-DR36、UX-DR37 等非 PRD 编号约束进入追踪与发布门禁。
2. 首个真实 Webview 切片必须产出主题、响应式、焦点、200% 字号、仅键盘和辅助技术证据；不得推迟到发布尾声。
3. Story 4.6 位于合理规模上沿；若单迭代无法完成，应沿完整 artifact 生成与本地目标投递边界拆分，同时保持不可变 artifact 合同完整。
4. Story ID 与展示顺序非单调；实现与调度只能读取 `StoryDependencyDagV1`，不得按数字大小推断顺序。
5. 建议在 Story 5.12 的直接 `关联需求` 中补充“适用 UX-DR 由 ReadinessGateManifestV1 逐项展开”，消除人工阅读歧义。

### 建议的下一步

1. **从 Story 1.1 开始，严格顺序完成 Story 1.1 → 1.2 → 1.3。** Story 1.3 的 provider 强制、`ci/quality-gates.v1.yaml`、双向追踪与 drift monitor 未完成前，不开放 Story 1.4 或其他功能 Story 并行实施。
2. **把权威 DAG 纳入自动验证。** 每次修改 `epics.md` 时检查 61 个稳定 Story ID、引用存在性、唯一根、无环和无未来 Epic 依赖。
3. **能力首次公开即启用真实 blocking gate。** 不允许空测试、永久 skip、无断言或始终成功脚本；CLI、RPC、Schema、Webview、rules、impact、export 分别在首次落地 PR 中加入相应门禁。
4. **首个 Webview 以证据驱动。** 同时验证 VS Code 1.125.0/最新/前一稳定版、暗色/亮色/高对比、100%/200%、1024/899/599/359 CSS px、键盘与辅助技术基础路径。
5. **按 release slice 累积交付。** Alpha 提供可信 CLI 图谱，Beta 提供 IDE 体验，Beta+ 才是完整 MVP；任何 fail 或 invalid 的 blocking gate 均保持 No-Go。

### 最终说明

本次评估发现 5 项需要跟踪的非阻塞事项，分布于 UX 证据/追踪与 Story 可维护性两类；Critical 0 项，Major 0 项。规划材料可以进入实施阶段，但执行团队必须遵循架构规定的渐进式门禁和 DAG，而不能把“文档就绪”误解为“候选已验证”。

**评估日期：** 2026-07-16  
**评估者：** Winston（System Architect）/ BMad Implementation Readiness Workflow
