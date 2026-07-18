---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
assessmentStatus: "NEEDS WORK"
assessmentDate: 2026-07-16
assessedBy: "Winston / BMad Implementation Readiness"
filesIncluded:
  prd:
    - prds/prd-bmad-2026-07-09/prd.md
    - prds/prd-bmad-2026-07-09/addendum.md
  architecture:
    - architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
    - architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md
  epicsStories:
    - epics.md
  ux:
    - ux-designs/ux-bmad-2026-07-13/DESIGN.md
    - ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-16
**Project:** bmad

## 文档发现

### PRD 文档

- `prds/prd-bmad-2026-07-09/prd.md`（36,866 字节，修改于 2026-07-15 17:48:59）
- `prds/prd-bmad-2026-07-09/addendum.md`（14,579 字节，修改于 2026-07-15 17:50:17）

### 架构文档

- `architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`（58,425 字节，修改于 2026-07-15 16:52:05）
- `architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md`（60,940 字节，修改于 2026-07-15 16:52:25）

### Epic 与 Story 文档

- `epics.md`（109,756 字节，修改于 2026-07-16 07:45:21）

### UX 文档

- `ux-designs/ux-bmad-2026-07-13/DESIGN.md`（13,405 字节，修改于 2026-07-15 18:40:37）
- `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`（22,922 字节，修改于 2026-07-15 18:40:37）

### 文档发现结论

四类必需文档均已找到。项目采用嵌套文档集合而非 `index.md` 分片结构，未发现整篇版与分片版重复冲突。评估使用上述七个已确认文件；评审、对账和历史就绪报告不作为本轮主输入。


## PRD Analysis

### Functional Requirements

共提取 **23** 条编号功能需求。以下保留 PRD 原文及其可测试后果：

#### 4.1 本地图谱索引与存储

**Description:** 用户可以在本地为 VS Code 工作区生成代码结构图谱。系统优先支持 TypeScript/JavaScript 单包项目与常见 monorepo，提取目录、文件、workspace package、import/export、包依赖和基础符号信息。图谱默认只存储在本地，不上传源码或图谱数据。当前实现合同以 `addendum.md` 第 3 节及已采用的 Architecture Spine 为准；PRD 主体只定义产品能力、边界和可测试结果。

##### FR-1：初始化工作区图谱

用户可以通过 VS Code 命令或 CLI 对当前工作区执行首次图谱构建。实现 UJ-1。

**Consequences（可测试）:**
- 当用户在受支持工作区执行初始化时，系统生成可查询的项目代码图谱。
- 系统识别常见 npm、Yarn 与 pnpm workspace package 边界；无法识别时仍可退化为普通单工作区索引。
- 当工作区缺少受支持语言文件时，系统给出空状态和可操作提示，而不是报错退出。
- 初始化结果包含图谱生成时间、索引文件数、节点数、边数和排除路径摘要。

##### FR-2：提取 TypeScript/JavaScript 依赖关系

系统必须提取 TypeScript/JavaScript 文件之间的 import/export 关系和外部包依赖。实现 UJ-1、UJ-2。

**Consequences（可测试）:**
- 系统能识别 ES module import/export、常见 TypeScript path alias、package import。
- 在 monorepo 中，系统能识别跨 workspace package 的 TS/JS import，并将文件级证据聚合为 package 依赖边。
- 每条依赖边记录来源、置信度、语言、文件范围和最后检测时间。
- 对无法确定的动态依赖，系统不得伪装成精确依赖；必须标记为低置信或暂不纳入。
- `BasicSymbolV1` 只提取 TypeScript/JavaScript 源文件顶层且具有稳定名称与可导航范围的 `function`、`class`、`interface`、`type-alias`、`enum`、`variable`、`namespace`。
- MVP 不提取成员、参数、局部变量、import alias、匿名声明、调用图或 references；这些对象不得进入符号导航、结构导出或成功指标。

##### FR-3：保存后增量更新

用户保存受支持文件后，系统在本地增量更新相关图谱数据。实现 UJ-2、UJ-3。

**Consequences（可测试）:**
- 系统对保存事件进行 debounce 或 settle 处理，避免 git pull、分支切换或批量生成文件时频繁重建。
- 内容 hash 未变化时，系统不得重复解析同一文件。
- 增量更新完成后，当前视图显示最新状态或明确标记仍为 stale。

##### FR-4：路径排除与噪声控制

用户可以通过内置安全默认项和工作区根目录的 `.codegraphignore` 排除依赖目录、构建产物、生成代码和自定义路径，防止图谱污染。实现 UJ-1、UJ-2。

**Consequences（可测试）:**
- 系统从首次 rebuild 和首次 Analyzer 运行前即应用内置安全默认排除；即使 `.codegraphignore` 不存在，也必须提供包含内置规则的有效 generation 0 排除快照。
- 用户通过 `.codegraphignore` 声明额外排除或显式重新纳入路径；配置的有效快照、无效诊断和 last-valid 回退由本地图谱服务统一管理。
- 命中有效索引排除规则的路径不产生节点、边或 Evidence，不参与 workspace package 聚合、规则检查或成功指标统计。
- `.codegraphignore` 重新纳入路径后，系统沿用原确定性 ID，不把同一实体误识别为新对象。

##### FR-5：图谱版本、稳定 ID 与过期状态

系统必须为图谱 schema、节点、边和索引状态提供稳定标识与版本信息。

**Consequences（可测试）:**
- 节点和边 ID 不依赖数据库自增主键。
- 图谱数据包含 schema version，旧版本数据可触发迁移或重建提示。
- 当源文件变化但索引未完成时，系统显示 stale 状态。

#### 4.2 IDE 内结构视图

**Description:** VS Code 插件在开发者实际阅读和修改代码的位置展示结构信息。MVP 不默认渲染全量大图，而是按用户当前聚焦层级展示项目概览、目录聚合或当前文件邻域图。

##### FR-6：项目结构概览

用户打开工作区后，可以查看目录/模块之间的真实依赖概览。实现 UJ-1。

**Consequences（可测试）:**
- 概览视图以目录或模块为主要节点，而不是展示所有文件。
- 概览展示依赖方向、依赖强度、循环风险和图谱更新时间。
- 用户可以从目录/模块节点下钻到相关文件或局部邻域。

##### FR-7：当前文件邻域图

用户打开代码文件时，系统自动展示当前文件的依赖邻域。实现 UJ-2。

**Consequences（可测试）:**
- 邻域图至少区分当前文件、直接依赖、反向依赖和外部包。
- 默认展示 1 跳关系，单次查询和渲染预算上限为 100 个节点、200 条边。
- 当节点或边超过预算时，系统按相关性将与焦点节点距离较远的节点和边折叠为目录或 workspace package 聚合节点。
- 用户可以主动展开聚合节点；每次展开仍返回受预算限制的局部子图，不允许无上限追加全局图。

##### FR-8：聚焦追踪与视图固定

系统可以跟随用户当前文件切换更新图谱，也允许用户固定当前视图。实现 UJ-2。

**Consequences（可测试）:**
- 用户切换文件时，默认图谱聚焦新文件。
- 用户启用固定后，切换文件不会替换当前图谱。
- 固定状态在当前 VS Code 会话中可见且可解除。

##### FR-9：节点导航与上下文操作

用户可以从图谱节点跳转到文件、目录或符号位置。实现 UJ-1、UJ-2。

**Consequences（可测试）:**
- 点击文件节点可在 VS Code 中打开对应文件。
- 节点详情展示路径、类型、入边、出边、更新时间和 findings。
- 当节点对应文件不存在或已移动时，系统提示重新索引。

##### FR-10：多视图基础能力

MVP 至少提供局部关系图和结构列表两种呈现方式；大图场景不得只依赖力导向图。

**Consequences（可测试）:**
- 当前文件邻域可用图形方式探索。
- findings、循环依赖和 PR 摘要可用列表或表格方式阅读。
- 对键盘用户或无法理解图形的用户，核心信息有文本替代呈现。

#### 4.3 架构规则与结构风险

**Description:** 系统帮助用户发现循环依赖、跨层依赖和目录边界违规。MVP 的规则能力保持简单可配置，优先服务“保存后立即知道是否破坏结构边界”。

##### FR-11：循环依赖检测

系统必须检测受支持图谱范围内的文件级和目录/模块级循环依赖。实现 UJ-3、UJ-4。

**Consequences（可测试）:**
- 系统能列出循环链路中的节点和边。
- 系统能区分已有循环与本次变更新增循环。
- 循环 finding 包含严重级别、范围和可定位文件。

##### FR-12：目录与层级依赖规则

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

##### FR-13：保存后 findings 提示

当保存变更引入结构风险时，系统在 IDE 中展示 findings。实现 UJ-3。

**Consequences（可测试）:**
- Finding 展示规则名、严重级别、新增边、相关路径和检测时间。
- 用户可以从 finding 跳转到触发文件。
- 系统不得用模糊告警替代可定位的依赖边或规则。

##### FR-14：风险解释

系统必须解释结构风险为什么发生，而不只是给出错误码。

**Consequences（可测试）:**
- 循环依赖 finding 展示完整或折叠后的循环路径。
- 跨层违规 finding 展示实际依赖方向和期望规则。
- 对已知限制或低置信度结果，系统明确标注置信度或数据来源。

##### FR-15：CLI 规则检查

用户可以通过 CLI 在本地执行规则检查并获得机器可读和人可读输出。实现 UJ-4。

**Consequences（可测试）:**
- CLI check 在存在 `error` 级违规时返回非零退出码；只有 `warning` 时默认返回零。
- CLI 输出包含 summary、findings 列表和可选 JSON。
- CLI 不要求连接云服务。

#### 4.4 变更影响与 PR 摘要

**Description:** MVP 支持本地读取 git diff，生成结构变化摘要。该能力服务 PR 审查，但不在第一版实现完整 GitHub/GitLab hosted integration。

##### FR-16：读取本地变更集合

用户可以通过 CLI 或 VS Code 命令选择当前工作树、暂存区或指定 base 分支作为变更集合。实现 UJ-4。

**Consequences（可测试）:**
- 系统能识别新增、删除、修改和移动的受支持文件。
- 系统能在图谱中标记受变更影响的节点和边。
- 当 git 信息不可用时，系统给出可理解错误和替代命令建议。

##### FR-17：结构变化摘要

系统必须输出本次变更造成的结构变化。实现 UJ-4。

**Consequences（可测试）:**
- 摘要列出新增依赖边、删除依赖边、受影响目录/模块、循环变化和规则违规。
- 摘要区分“本次新增风险”和“历史既有风险”。
- 摘要避免渲染全量图，只展示与变更集合相关的预算内子图或列表。

##### FR-18：Markdown PR Review 输出

用户可以生成适合复制到 PR review 的 Markdown 摘要。实现 UJ-4。

**Consequences（可测试）:**
- Markdown 摘要包含总体 verdict、主要风险、关键路径和建议复查文件。
- 摘要中路径使用相对路径。
- 输出不包含源码内容，除非用户显式开启。

##### FR-19：本地隐私边界

结构影响分析默认不上传源码、diff 或图谱数据。实现 UJ-4、UJ-5。

**Consequences（可测试）:**
- 默认配置下，CLI 和插件不发起远程上传。
- MVP 默认关闭遥测，核心功能不得依赖遥测开启。
- 用户可显式 opt-in 匿名产品与性能遥测；遥测不得包含源码、diff、完整文件路径、符号名称、图谱内容或规则内容。
- 用户可随时关闭遥测并查看本地生效状态；首轮试用也可以通过访谈和用户主动导出的诊断报告收集反馈。
- 本地图谱数据位于 OS 用户缓存的 workspace-key 目录，用户可查看位置并安全清理；生成数据不写入工作区，也不依赖 `.gitignore` 防止误提交。

#### 4.5 CLI、本地图谱服务与可导出上下文

**Description:** VS Code 插件、CLI 和未来 AI/MCP 能力共用本地图谱服务。MVP 需要形成稳定的查询与导出能力，避免把图谱能力锁死在 Webview 内。

##### FR-20：CLI 基础命令

用户可以通过 CLI 执行 rebuild、query、check、impact、export、status、doctor 和 cache。实现 UJ-1、UJ-4、UJ-5。

**Consequences（可测试）:**
- `rebuild` 生成或刷新图谱。
- `query` 返回当前文件或指定路径的邻域结果。
- `check` 执行规则检查。
- `impact` 生成变更影响摘要。
- `export` 输出受预算限制的本地结构上下文。
- `status` 返回服务、图谱与 Finding 的当前状态；`doctor` 输出可操作诊断；`cache` 支持查看位置和安全清理。

##### FR-21：本地图谱查询服务

插件和 CLI 通过本地图谱查询服务访问图谱，而不是各自重复实现索引和查询。

**Consequences（可测试）:**
- 插件可以请求项目概览、当前文件邻域、findings 和 stale 状态。
- CLI 可以复用同一查询能力。
- 图谱查询服务返回 view model 或结构化数据，不暴露渲染库内部格式。

##### FR-22：图谱状态与故障恢复

系统必须让用户知道图谱是否可用、是否过期、是否构建失败。

**Consequences（可测试）:**
- 插件显示 idle、indexing、stale、failed 等状态。
- 构建失败时展示错误摘要和日志位置。
- 用户可以执行重建以恢复损坏或过期图谱。

##### FR-23：结构上下文导出

用户可以导出当前文件邻域、相关规则和 findings 的结构上下文，用于 AI 工具或人工沟通。实现 UJ-5。

**Consequences（可测试）:**
- 导出内容包含路径、节点类型、依赖边、规则 findings 和图谱更新时间。
- 导出内容默认不包含源码正文。
- 导出内容受图谱预算限制，避免把全仓库上下文一次性输出。

### Non-Functional Requirements

共提取 **27** 条编号非功能需求。以下保留 PRD 原文：

#### 5.1 性能

- **NFR-1：标准验收规模。** 标准验收项目不超过 5,000 个受支持源码文件、500,000 行源码和 50 个 workspace package；`node_modules`、构建产物、生成代码和索引排除路径不计入规模。
- **NFR-2：标准参考环境。** 标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD 的本地开发机器。
- **NFR-3：首次概览性能。** 在标准验收项目和参考环境下，clean cache 首次概览的 p95 不超过 60 秒。
- **NFR-4：缓存邻域性能。** 打开文件后，已提交 warm cache 的邻域图显示 p95 不超过 300ms，后台刷新可异步完成。
- **NFR-5：保存后刷新性能。** 从宿主保存动作到对应 graph/Findings revision 可见的 p95 不超过 2 秒。
- **NFR-6：默认图谱预算。** 默认邻域图的单次查询和渲染预算上限为 100 个节点、200 条边。
- **NFR-7：超规模退化。** 超出标准验收规模时暂不承诺相同 SLA，但系统不得阻塞编辑器，必须显示索引进度并允许取消或重建。

#### 5.2 可靠性

- **NFR-8：宿主隔离。** 索引、查询和布局不得阻塞 VS Code extension host。
- **NFR-9：事件风暴收敛。** git pull、分支切换、依赖安装和批量生成文件不应造成无限重建。
- **NFR-10：失败可读。** 图谱构建失败时，已有缓存仍可作为 stale 数据查看，并清楚标注状态。
- **NFR-11：缓存可恢复。** 系统必须能从损坏缓存中重建；迁移失败时保留故障副本并给出可恢复错误。

#### 5.3 安全与隐私

- **NFR-12：本地优先。** 源码、图谱、diff 和结构摘要默认仅保存在本地。
- **NFR-13：本机访问。** 本地图谱服务只能通过当前用户可访问的本机 IPC 端点通信，不监听 TCP 或网络接口。
- **NFR-14：数据可清理。** 用户必须能定位并安全清理本地图谱数据、日志和服务元数据。
- **NFR-15：遥测最小化。** 遥测默认关闭；即使用户 opt-in，也只收集匿名功能使用事件、耗时、计数和错误分类，不收集项目内容或可反推出项目结构的标识。
- **NFR-16：云能力隔离。** 云端同步与团队共享必须作为独立能力另行设计和授权，不进入 MVP 主路径。

#### 5.4 可用性与可访问性

- **NFR-17：任务等价文本。** 核心 findings、循环依赖、结构关系和 PR 摘要必须有与图形任务等价的文本呈现；屏幕阅读器可获得节点类型、入/出边数、Finding 数、边方向、来源和置信度。
- **NFR-18：视觉可辨识。** 图谱节点、边、严重级别和 stale 状态必须具备一致视觉语义，不能只依赖颜色；人类可读界面达到 WCAG 2.2 AA，并在 VS Code 高对比主题下保持可辨识。
- **NFR-19：键盘与焦点。** 用户可以固定当前视图；所有核心任务无需鼠标即可完成，焦点顺序可预测且可见，交互目标不小于 24×24 CSS px。
- **NFR-20：缩放与动态效果。** 空状态、错误状态和规则语法错误必须提供下一步操作；200% 字号下核心信息不丢失或重叠，并服从系统/VS Code 的减少动态效果设置。

#### 5.5 可演进性

- **NFR-21：渲染解耦。** 图谱持久模型不得绑定具体渲染库格式。
- **NFR-22：可追溯模型。** 节点和边必须使用稳定 ID，并记录来源、置信度、版本和更新时间。
- **NFR-23：可替换边界。** 分析器、存储、查询和渲染层应保留可替换边界，支持后续接入更多语言、SCIP、矩阵视图或 MCP server。

#### 5.6 兼容性、资源与本地服务边界

- **NFR-24：支持平台与版本。** MVP 支持 Windows x64、macOS x64、macOS arm64 和 Linux x64；Windows arm64、Linux arm64 暂不支持。VS Code 扩展的最低版本为 1.125.0，发布时同时验证最低版本、最新稳定版和前一稳定版；CLI 要求 Node 24 LTS，平台 VSIX 自带经验证的 Node 24 LTS 运行时。
- **NFR-25：安装、升级与迁移。** 每个受支持组合必须通过新安装、离线启动、升级、降级、卸载以及缓存保留/清理验收。协议 major 或 schema 不兼容时必须安全拒绝并提示更新；图谱迁移只能由新服务事务化执行，失败时保留故障副本并允许重建，旧服务不得向新 schema 降级写入。
- **NFR-26：资源基线。** 在标准验收项目与参考环境中，首次 `rebuild` 的 graph-service 进程树峰值 RSS 不超过 4 GiB；按 1 秒间隔采样的整段运行平均 CPU 不超过整机 75%。在连续 5 分钟无活动任务（Job）的空闲窗口内，CPU p95 不超过整机 1%，窗口结束时 RSS 不超过 1.5 GiB。单工作区缓存、服务元数据与日志总量不超过 2 GiB，其中轮转日志不超过 100 MiB。版本化资源基准 manifest 必须固定 8 小时会话的 fixture、操作序列、采样间隔和空闲窗口；会话结束后的同条件空闲 RSS 不得比首小时基线增长超过 20%，Job 队列、句柄和临时文件不得持续单调增长。
- **NFR-27：服务生命周期与威胁边界。** 每个索引根目录（indexing root）最多运行一个按需启动的图谱服务；Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket。业务请求前必须校验随机令牌、workspace-key 和协议版本；端点冲突、伪造客户端或版本不兼容必须安全失败且不得误连第二实例。未授予 Workspace Trust 时不得启动服务、读取项目文件或运行 Git 分析；对所有路径执行 `realpath` 解析后，结果必须位于 indexing root 内。服务应在无客户端且无活动 Job 5 分钟后优雅退出，并在崩溃、重连、升级和 stale metadata 场景下可恢复。

### Additional Requirements

#### 用户旅程与业务目标

- **UJ-1：新加入的开发者理解项目结构。** 首次 rebuild 后获得项目结构概览、目录依赖强度、循环风险和热点模块，并能下钻到文件依赖。
- **UJ-2：日常开发者判断当前文件影响范围。** 在 3 分钟内通过缓存邻域、后台刷新、反向依赖和聚合节点判断修改影响；视图可固定。
- **UJ-3：开发者保存代码后发现结构违规。** 保存后增量解析，定位新增依赖边及其触发的层级、目录或循环规则风险。
- **UJ-4：Tech Lead 审查 PR 结构影响。** 基于本地 git diff 生成新增/删除依赖边、受影响目录、循环变化和规则违规的 Markdown 摘要。
- **UJ-5：AI 编码用户导出局部结构上下文。** 导出邻域、模块边界和 findings 作为 AI 修改约束；MCP server 延后到 v1.1 候选。

#### 产品范围与业务约束

- 首阶段只面向 VS Code 中的 TypeScript/JavaScript 中大型项目，覆盖一线开发者和 Tech Lead。
- MVP 由 Alpha、Beta、Beta+ 分段验证；Beta 不是完整 MVP，Beta+ 必须通过 SM-1 至 SM-8 才可 Go。
- MVP 不包含全语言、运行时调用图、数据流/CPG、云协作、账号与 SSO、Hosted PR App、AI 自动重构、MCP server、Web Dashboard、跨仓库全局图谱。
- 项目默认本地运行、默认不上传、默认关闭遥测；云能力和 MCP 均需独立重新授权或满足后续门禁。
- 当前无阻塞性开放问题，也无未确认假设；新增推断必须记录并确认后才能进入实现。

#### Addendum 规范性技术约束

- VS Code 插件必须是薄客户端；索引、查询和规则检查位于独立本地图谱服务，业务逻辑通过 `GraphStorePort`、`AnalyzerPort` 等端口与适配器隔离。
- 实现锁定 TypeScript 6.0.3、Node 24 LTS、SQLite/`better-sqlite3`、JSON-RPC 2.0、本机命名管道或 Unix Domain Socket；不监听 TCP。
- TypeScript Compiler API 是 TS/JS 权威分析源；Tree-sitter、LSP、SCIP/CPG 和 TypeScript 7 unstable API 不进入首个实现。
- `.codegraph/rules.yaml` v1 只支持 `forbidden-dependency`、`layer-order`、`no-cycle`，拒绝未知字段和未知类型；规则排除与 `.codegraphignore` 索引排除语义必须严格区分。
- `BasicSymbolV1` 只覆盖顶层、稳定命名且可导航的 function、class、interface、type-alias、enum、variable、namespace；成员、参数、局部变量、import alias、匿名声明、调用图和 references 不进入 MVP。
- 支持 Windows x64、macOS x64/arm64、Linux x64；VS Code 最低 1.125.0；平台 VSIX 自带 Node 24 LTS 与对应原生 SQLite 模块。
- 未授予 Workspace Trust 时不得启动服务或读取项目/Git；路径必须经 `realpath` 验证仍处于 indexing root 内；Webview 使用严格 CSP、nonce、无网络访问和消息 Schema 校验。
- 单文件、候选文件、规则数、YAML alias、查询跳数、返回节点/边数和待处理 Job 均有硬限制；超限必须返回稳定诊断，不能执行项目代码或静默截断规则。
- 架构处置项已关闭，具体稳定 ID、缓存位置、CLI schema/退出码、VS Code surface、PR 摘要和结构上下文格式以 Architecture Spine 与 Implementation Guide 为规范来源。

### PRD Completeness Assessment

PRD 状态为 final，FR/NFR 使用稳定编号，全部主要用户旅程、MVP 范围、性能、安全、可靠性、可访问性、兼容性和资源门禁均有可测试描述。Addendum 明确了规范性技术合同并关闭了原架构开放项。初步判断 PRD 完整度高、可进入覆盖验证。

需要在后续追踪中重点防范两点：第一，规范合同分散在 PRD、Addendum 与两份架构文档中，Epic/Story 必须引用正确的最终来源；第二，部分 Addendum 技术约束没有独立 FR/NFR 编号，必须确认已被 Story 验收标准完整承接。

## Epic Coverage Validation

### Epic FR Coverage Extracted

Epic 文档包含显式的 `FR 覆盖图`，覆盖 PRD 的 FR-1 至 FR-23。五个 Epic 的职责为：

- **Epic 1：** 本地图谱构建、查询、稳定身份、排除、基础循环、隐私、状态与恢复。
- **Epic 2：** VS Code 项目概览、当前上下文、导航、图/列表等价体验和增量刷新。
- **Epic 3：** 规则配置、循环与边界违规、Finding 生命周期、解释及 CLI check。
- **Epic 4：** Git 变更集、结构影响、PR Markdown 和结构上下文导出。
- **Epic 5：** CLI/VSIX 安装、离线运行、升级降级、兼容矩阵和发布候选。

### Coverage Matrix

| FR | PRD 要求 | Epic / Story 覆盖 | 状态 |
|---|---|---|---|
| FR-1 | 初始化工作区图谱 | Epic 1；Story 1.2、1.4 | ✓ Covered |
| FR-2 | 提取 TS/JS 依赖关系 | Epic 1；Story 1.3、1.4 | ✓ Covered |
| FR-3 | 保存后增量更新 | Epic 2；Story 2.6 | ✓ Covered |
| FR-4 | 路径排除与噪声控制 | Epic 1；Story 1.2、1.5 | ✓ Covered |
| FR-5 | 图谱版本、稳定 ID 与过期状态 | Epic 1；Story 1.2、1.3、1.7、1.9；Epic 5 Story 5.3 加固升级路径 | ✓ Covered |
| FR-6 | 项目结构概览 | Epic 2；Story 2.2 | ✓ Covered |
| FR-7 | 当前文件邻域图 | Epic 2；Story 2.3 | ✓ Covered |
| FR-8 | 聚焦追踪与视图固定 | Epic 2；Story 2.4 | ✓ Covered |
| FR-9 | 节点导航与上下文操作 | Epic 2 Story 2.5；Epic 3 Story 3.6 补充 Finding 导航 | ✓ Covered |
| FR-10 | 图形与任务等价文本多视图 | Epic 2 Story 2.2、2.3、2.7；Epic 3 Story 3.6；Epic 4 Story 4.3 | ✓ Covered |
| FR-11 | 循环依赖检测 | Epic 1 Story 1.6 提供基础循环；Epic 3 Story 3.3 提供规则与 Finding | ✓ Covered |
| FR-12 | 目录与层级依赖规则 | Epic 3；Story 3.1、3.2、3.3 | ✓ Covered |
| FR-13 | 保存后 Findings 提示 | Epic 3；Story 3.4、3.5、3.6 | ✓ Covered |
| FR-14 | 风险解释 | Epic 3；Story 3.2、3.3、3.4、3.5、3.6 | ✓ Covered |
| FR-15 | CLI 规则检查 | Epic 3；Story 3.7 | ✓ Covered |
| FR-16 | 读取本地变更集合 | Epic 4；Story 4.1 | ✓ Covered |
| FR-17 | 结构变化摘要 | Epic 4；Story 4.2、4.3 | ✓ Covered |
| FR-18 | Markdown PR Review 输出 | Epic 4；Story 4.4 | ✓ Covered |
| FR-19 | 本地隐私边界 | Epic 1 Story 1.8、1.10；Epic 2 Story 2.8；Epic 5 Story 5.1、5.2、5.5 | ✓ Covered |
| FR-20 | CLI 基础命令 | Epic 1 Story 1.6、1.8；Epic 3 Story 3.7；Epic 4 Story 4.6；Epic 5 Story 5.1、5.4、5.5 | ✓ Covered |
| FR-21 | 本地图谱查询服务 | Epic 1 Story 1.1、1.6；Epic 2 Story 2.1；Epic 4 Story 4.3；Epic 5 Story 5.2、5.4、5.5 | ✓ Covered |
| FR-22 | 图谱状态与故障恢复 | Epic 1 Story 1.1、1.2、1.7、1.9；Epic 2 Story 2.1、2.6；Epic 5 Story 5.2、5.3、5.4、5.5 | ✓ Covered |
| FR-23 | 结构上下文导出 | Epic 4；Story 4.5、4.6 | ✓ Covered |

### Missing Requirements

未发现缺失的功能需求。Epic 文档中的 FR 编号集合与 PRD 完全一致；AR、UX-DR 和 NFR 属于补充约束，不构成未经 PRD 授权的新 FR。

### Coverage Statistics

- Total PRD FRs: **23**
- FRs covered in epics: **23**
- Missing FRs: **0**
- Extra FRs not present in PRD: **0**
- Coverage percentage: **100%**

### Coverage Assessment

功能覆盖达到实施就绪要求。多项跨切面需求被有意拆分到不同 Epic，例如 FR-10、FR-19 至 FR-22；其 Story 均使用 `关联需求` 显式追踪，拆分路径合理。后续 Story 质量检查仍需验证这些跨 Epic 合同是否避免重复实现、顺序倒置或遗漏集成验收。

## UX Alignment Assessment

### UX Document Status

已找到并完整审阅两份状态为 `final` 的 UX 契约：

- `ux-designs/ux-bmad-2026-07-13/DESIGN.md`：视觉设计、主题、组件和图形语义契约。
- `ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`：信息架构、状态、交互、可访问性、响应式和五条关键流程。

两份 UX 文档均明确引用当前 PRD、Addendum 和 Sprint 变更提案，并声明冲突时以 UX spine 为准。当前没有 mockup 或 wireframe，但 UX 文档明确将真实 VS Code Webview 验证作为实施证据，而非把静态稿设为实施前置条件。

### UX ↔ PRD Alignment

| 对齐领域 | UX 表达 | PRD 对应 | 结论 |
|---|---|---|---|
| UJ-1 项目理解 | Getting Started、Index Status、Project Overview、下钻和降级路径 | FR-1、FR-6、FR-9、FR-22 | 对齐 |
| UJ-2 影响判断 | Current Context、缓存优先、ContextLock、预算内展开、3 分钟目标 | FR-7、FR-8、FR-10；SM-1、SM-2 | 对齐 |
| UJ-3 保存后风险 | 非模态 Finding、实际/期望方向、配置诊断、修复后生命周期 | FR-3、FR-11 至 FR-14；SM-3 | 对齐 |
| UJ-4 PR 审查 | Changes、权威 verdict、新增/既有风险、Markdown 预览 | FR-16 至 FR-18 | 对齐 |
| UJ-5 AI 上下文 | 预算内结构导出、默认无源码、来源/置信度与边界规则 | FR-19、FR-23 | 对齐 |
| 性能与规模 | 60 秒首次 Overview、300ms warm cache、2 秒保存更新、100/200 预算 | NFR-1 至 NFR-7 | 对齐 |
| 可访问性 | 图/列表任务等价、键盘、屏幕阅读器、高对比、减少动态效果 | FR-10；NFR-17 至 NFR-20 | 对齐 |
| 隐私与信任 | Workspace Trust、默认不上传、遥测默认关闭、本地导出 | FR-19；NFR-12 至 NFR-16、NFR-27 | 对齐 |

UX 引入但 PRD 未逐项编号的细化要求包括：zh-CN/en 本地化契约、具体响应式断点、候选快捷键、空间记忆保留规则、真实 Webview 主题验证。这些不是产品范围冲突，已作为 `UX-DR1..37` 在 Epic/Story 中显式追踪。

### UX ↔ Architecture Alignment

- **Surface 职责：** AD-10 固定 Activity Bar/TreeView、Webview Editor、Problems、Status Bar 和 Command Palette 的职责，与 UX 信息架构一致。
- **查询与呈现：** AD-7、AD-25 由服务端生成预算内、渲染器无关的 `GraphViewModel`、聚合、循环与 Overview 指标；UX 不需要直接读取数据库或重算业务结论。
- **状态与空间记忆：** AD-7、AD-8、AD-10 及 Implementation Guide §5、§9 支持 stale/partial/failed/cancelled、三 revision 时钟、ContextLock 会话边界和刷新后的选择/缩放/展开保留。
- **可访问性：** AD-15 明确图与列表任务等价、键盘语义、屏幕阅读器信息、VS Code 主题、高对比和减少动态效果；Implementation Guide §11 将布局放入 Web Worker。
- **安全：** AD-11 支持 Workspace Trust、严格 CSP、nonce、消息 Schema、路径 realpath 和本机 IPC 边界。
- **Findings 与变更：** AD-17、AD-26 提供稳定 Finding、new/existing/not-applicable、`ImpactVerdictV1` 和统一排序，支撑 UX 的风险解释与 PR Summary。
- **隐私导出：** AD-18 支持不可变 artifact、默认 `structure-only`、显式源码授权和 Webview 不接收绝对目标路径。
- **性能：** AD-19 和 BenchmarkPlanV1 将 UX 的 60 秒、300ms、2 秒目标设为发布门禁。

未发现 UX 所要求的核心组件或状态缺少架构承载，也未发现架构强迫 UX 违反 PRD 用户旅程。

### Alignment Issues

1. **低风险：UX 将部分已成为 NFR 的要求仍标为 `[ASSUMPTION]`。** WCAG 2.2 AA、24×24 CSS px、响应式断点验证等在 PRD/Epics 中已经是规范性要求或明确验收项。建议实现时将“是否需要”与“如何校准”区分：要求不可降级，具体断点/快捷键可通过真实 Webview 实测调整。
2. **低风险：UX 派生要求没有 PRD 编号。** 本地化、空间记忆和真实主题验证依赖 UX-DR 编号追踪；Story 文档已覆盖，但规划引用检查必须同时校验 UX-DR，不能只校验 FR/NFR。

### Warnings

- 当前没有 mockup/wireframe；这不构成阻塞，但首个真实 Webview 切片必须保留暗色、亮色、高对比、200% 字号和窄宽度证据，避免视觉契约直到 Story 2.7 才首次验证。
- 候选快捷键与 900/600/360px 断点仍需真实 VS Code 冲突和内容溢出测试；不得在实现中把候选值当成不可调整常量。
- UX 与架构高度依赖同一 `GraphViewModel`、Finding 和 Impact 合同。任何宿主侧重新计算排序、比较或 verdict 都会同时破坏架构一致性和 UX 一致性，需由合同测试阻断。

### UX Alignment Conclusion

**结论：对齐，可继续。** UX 文档完整且与 PRD/架构一致；没有阻塞实施的 UX 缺口。剩余事项属于已进入 Story 验收标准的真实环境验证风险。

## Epic Quality Review

### Review Scope and Structural Evidence

- Epic 数量：**5**
- Story 数量：**36**（Epic 1: 10，Epic 2: 8，Epic 3: 7，Epic 4: 6，Epic 5: 5）
- 具备 `As a / I want / So that`：**36/36**
- 具备 `关联需求`：**36/36**
- 具备 `Acceptance Criteria`：**36/36**
- BDD 场景：**250** 组 Given/When/Then

### Epic Structure Validation

| Epic | 用户价值 | 独立性与依赖 | 前向依赖 | 结论 |
|---|---|---|---|---|
| Epic 1：构建、查询并恢复可信的本地图谱 | 用户可获得可查询、可诊断、可恢复的本地图谱 | 可独立形成 Alpha；不依赖后续 Epic | 未发现 | 合格 |
| Epic 2：在 VS Code 中理解项目与当前文件影响 | 用户可在编码现场获得 Overview 与 Current Context | 只消费 Epic 1；明确不依赖 Epic 3 的规则能力 | 未发现 | 合格 |
| Epic 3：发现并解释架构风险 | 用户可配置规则并获得稳定、可解释 Finding | 使用 Epic 1 图谱与 Epic 2 surface；不依赖 Epic 4 | 未发现 | 合格 |
| Epic 4：审查变更并导出结构上下文 | Tech Lead 可获得影响 verdict、PR 摘要和 AI 上下文 | 只使用 Epic 1–3 已交付能力 | 未发现 | 合格 |
| Epic 5：安装、升级并离线使用 | 用户可在受支持平台安装、升级和离线运行完整产品 | 累积验证 Epic 1–4；不反向改变前序能力 | 未发现 | 合格，但 Story 粒度需调整 |

整体依赖顺序为 `Epic 1 → Epic 2 → Epic 3 → Epic 4 → Epic 5`。所有显式 Story 引用均指向当前或更早 Story/Epic；未发现循环依赖或等待未来能力才能完成的 Story。Epic 2 对未来规则能力采用权威空规则基线，NodeDetails 在无 Finding 时仍完整工作，避免了隐式前向依赖。

### Best-Practice Strengths

- 五个 Epic 标题和目标均以用户可以完成的任务为中心，没有“建数据库”“开发 API”一类技术里程碑 Epic。
- Story 1.1 符合绿地项目要求：从官方 VS Code TypeScript + esbuild 模板起步，建立 workspace、依赖边界、空服务握手和真实 CI。
- 数据库按能力首次使用增量建表：Story 1.2 明确不提前创建 Findings、impact、export 或发布能力的未来表。
- 每个 Story 都提供错误、取消、stale、partial、权限、超预算或恢复路径中的适用场景；AC 普遍具体且可测试。
- FR/NFR/AR/UX-DR 追踪密度高；跨 Epic 的 FR-10、FR-19 至 FR-22 有明确拆分说明。
- 能力首次公开落地时同步加入真实 blocking gate，未使用永久 skip、空测试或无断言占位。

### 🔴 Critical Violations

未发现以下 Critical 违规：

- 没有纯技术 Epic。
- 没有 Epic/Story 前向依赖或循环依赖。
- 没有功能需求失去实施路径。
- 没有一次性提前创建完整数据库模型。

### 🟠 Major Issues

#### Q-1：Story 1.1 同时承担过多地基职责

Story 1.1 同时包含仓库脚手架、包依赖边界、本地 IPC 单实例服务、协议/状态握手、完整 CI 门禁和规划漂移检查。这些具有独立失败域，且该 Story 被设为其他功能并行启动前的硬门禁，容易形成长时间单点阻塞。

**建议：** 保持同一 Epic 和顺序，但拆成三个可独立验收的地基 Story：仓库/模板与依赖边界；空 graph-service 与握手；CI/provider gate 与规划追踪。只有第三个完成后开放并行功能 Story。

#### Q-2：Story 1.3 是分析器子系统级工作包

Story 1.3 同时覆盖 Analyzer 配置快照、TS/JS 多语法映射、模块解析、外部实体、BasicSymbolV1、Evidence/ownership、GraphPatch 删除语义，以及 500 条语料的准确率门禁。单 Story 内包含多个可独立设计、实现和失败的合同。

**建议：** 至少拆成“模块依赖与目标解析”“BasicSymbolV1 与导航范围”“Evidence/ownership 与删除语义”“准确率语料及门禁”四个按顺序交付的用户价值切片。

#### Q-3：配置生命周期 Story 粒度过大

Story 1.5 同时承载 `.codegraphignore` 语法、反选、last-valid、非法 UTF-8、跨平台确定性、reconciliation/CAS 和 CI；Story 3.1 同时承载 YAML CST、JSON Schema、Ajv、路径 glob、规则快照、invalid fallback、精确诊断、安全限制和 CI。两者都接近独立子系统规模。

**建议：** 将“有效配置解析与生效”“无效配置/last-valid 恢复”“变更监听与 CAS 收敛”“诊断与安全限制”拆成连续 Story，并保证每个切片都安全失败、不静默忽略配置。

#### Q-4：Story 2.2 与 Story 2.3 混合服务合同、UI、性能和全量可访问性

两个 Story 都同时实现服务端投影/查询、图与列表 UI、聚合/预算、状态退化、性能 SLA、主题和辅助技术验收，单 Story 跨越 application、contracts、extension、webview 和 benchmark 多个团队边界。

**建议：** 仍按用户价值垂直拆分。例如先交付“列表优先的可用 Overview/Current Context + 权威状态”，再交付“图形视图、聚合展开和空间记忆”，最后由同一功能切片补齐性能与真实 Webview 门禁，避免拆成纯后端技术 Story。

#### Q-5：Story 2.7 是验证型 Story，而非独立产品增量

Story 2.7 明确声明只验证 Story 2.1–2.6，不补做功能，缺失时重开前序 Story。这是 Epic 完成定义/测试门禁，而不是可以独立交付的用户 Story。

**建议：** 将其 250% 字号、键盘、屏幕阅读器、主题和响应式矩阵移入 Epic 2 的 Definition of Done 与 blocking gate；若确有独立修复工作，则按具体可访问性缺口创建能够产生产品变化的 Story。

#### Q-6：Story 4.2 聚合了完整影响分析内核

Story 4.2 同时处理基线派生、边变化、循环 delta、Finding 比较、总体 verdict、风险排序、partial/stale 语义和确定性 CI。任何一项都可能独立失败或需要单独测试策略。

**建议：** 拆为“确定性结构边变化与范围”“循环/Finding 基线比较”“ImpactVerdictV1 与稳定排序”三个连续切片；每个切片仍通过 CLI/服务返回用户可理解结果。

#### Q-7：Story 5.4 与 5.5 属于发布程序级工作包

Story 5.4 覆盖四平台原生矩阵、三版 VS Code、离线运行、性能 SLA、8 小时资源基准和安装/升级矩阵；Story 5.5 又覆盖 artifact manifest、SBOM、双 clean checkout 可复现性、release set、信任根轮换、签名、内容审计及最终 Go/No-Go。两者均明显超出普通 Story 粒度。

**建议：** 分别拆为平台/ABI 矩阵、VS Code 兼容、性能与资源、安装升级恢复、可复现 payload/SBOM、release set 一致性、信任与签名、最终候选审计。Epic 5 仍保持用户价值导向。

### 🟡 Minor Concerns

1. **验收标准密度很高。** 36 个 Story 包含 250 组 BDD 场景，平均接近 7 组；详尽度有利于质量，但也增加单 Story 评审、估算和完成判定成本。拆分后应保持每个 Story 的核心场景、失败场景和合同门禁，避免机械复制全部跨切面要求。
2. **跨切面合同重复引用较多。** FR-21、FR-22、状态 revision、安全与隐私 AC 出现在多个 Story。建议以版本化合同测试和 Epic DoD 作为唯一权威，Story 只保留本切片新增或必须验证的部分，降低文案漂移。
3. **内部贡献者 Story 应保持例外最小化。** Story 1.1、5.4、5.5 使用项目贡献者或发布负责人 persona 可以接受，但不能据此把后续纯技术任务包装成用户 Story。

### Compliance Checklist

| 检查项 | 结果 |
|---|---|
| Epic 提供用户价值 | 通过，5/5 |
| Epic 不依赖未来 Epic | 通过，5/5 |
| Story 无前向依赖 | 通过，36/36 |
| Story 具备用户叙事与需求追踪 | 通过，36/36 |
| Acceptance Criteria 使用 BDD 且可测试 | 通过，36/36；但部分 Story 过大 |
| 数据表按首次需要创建 | 通过 |
| 绿地模板、环境和 CI 提前建立 | 通过 |
| Story 粒度适合实施 | **部分通过；至少 10 个 Story 建议拆分或转为 Epic DoD** |

### Epic Quality Conclusion

Epic 层级设计、需求追踪和依赖方向质量高，没有结构性阻断；但 Story 粒度并未全部达到可安全执行标准。尤其 Story 1.1、1.3、1.5、2.2、2.3、2.7、3.1、4.2、5.4、5.5 应在进入对应实现前完成拆分或 DoD 重构。

## Summary and Recommendations

### Overall Readiness Status

**NEEDS WORK**

项目的 PRD、Addendum、UX、架构和 Epic 覆盖已达到高一致性：23/23 FR 覆盖，UX 与架构无阻塞冲突，5/5 Epic 具备用户价值，36/36 Story 无前向依赖且具有需求追踪与 BDD 验收。

但是，当前 Story 拆分尚未全部达到可安全进入 Phase 4 的粒度。至少 10 个 Story 将多个独立失败域、团队边界或发布程序压在一个工作项中；如果直接实施，最可能出现长时间未完成、验收边界模糊、并行受阻和部分完成难以回滚的问题。因此，本轮结论不是 `READY`。

### Critical Issues Requiring Immediate Action

没有发现 Critical 级需求缺失、覆盖断层、UX/架构冲突、前向依赖或循环依赖。

但有一个进入实施前的**强制准备动作**：必须先拆分或重构 Story 1.1、1.3、1.5、2.2、2.3、2.7、3.1、4.2、5.4、5.5。其中 Story 1.1 是全项目功能并行启动前的门禁，应该最先处理。

### Recommended Next Steps

1. **先拆 Story 1.1。** 分为仓库/模板与依赖边界、空服务与协议握手、CI/provider gate 与规划追踪三个连续 Story；保持第三个完成前不开放功能并行的约束。
2. **拆分高风险子系统 Story。** 将 Analyzer、ignore/rules 配置生命周期、Overview/Current Context、Impact 内核按可独立验收的用户价值切片拆分，同时保留稳定合同和安全失败路径。
3. **把 Story 2.7 转为 Epic 2 Definition of Done 与 blocking gate。** 可访问性或响应式缺口应回到具体功能 Story 修复，不用一个纯验证 Story 隐藏前序遗漏。
4. **重构 Epic 5 发布 Story。** 按平台/ABI、VS Code 兼容、性能资源、安装升级、可复现构建/SBOM、release set、信任签名和最终审计拆分。
5. **保持追踪完整。** 拆分后每个新 Story 必须继续引用 FR/NFR/AR/UX-DR，并由规划追踪门禁校验；不得丢失当前 100% FR 覆盖。
6. **重新执行实施就绪检查。** PRD、UX 与架构当前不需要重写；更新 `epics.md` 后重点复核 Story 粒度、依赖和 AC 分配即可。

### Decision Guidance

- **可以保留：** PRD、Addendum、Architecture Spine、Implementation Guide、UX Design/Experience、Epic 边界和总体依赖顺序。
- **需要修改：** `epics.md` 中上述 10 个 Story 的粒度和 Story 2.7 的定位。
- **当前不建议：** 直接开始 Story 1.1 或批量进入 Phase 4 实施。
- **达到 READY 的条件：** Major Story 粒度问题完成拆分，拆分后的每个 Story 仍具备用户价值、无前向依赖、可独立验收且保留全部追踪关系。

### Final Note

本评估记录了 **15 项需要关注的发现**，分布在三个类别：7 项 Major Story/发布粒度问题、5 项 UX 对齐与真实环境验证风险、3 项 Minor 规划维护问题；Critical 问题为 0。

结论直接但积极：产品与技术方向已经对齐，当前差距主要是把高质量的“大合同”重新切成可实施的小工作单元。完成该规划修正后，项目有望达到 `READY`，无需推翻现有 PRD、UX 或架构。

---

**Assessment Date:** 2026-07-16  
**Assessor:** Winston / System Architect，BMad Implementation Readiness Workflow
