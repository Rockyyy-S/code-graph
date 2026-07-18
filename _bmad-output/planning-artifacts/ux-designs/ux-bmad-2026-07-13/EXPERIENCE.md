---
name: BMad Project Code Graph
status: final
sources:
  - "{planning_artifacts}/briefs/brief-bmad-2026-07-09/brief.md"
  - "{planning_artifacts}/prds/prd-bmad-2026-07-09/prd.md"
  - "{planning_artifacts}/prds/prd-bmad-2026-07-09/addendum.md"
  - "{planning_artifacts}/research/project-code-graph-mvp-stack-upgrade-analysis-2026-07-09.md"
  - "{planning_artifacts}/research/project-code-graph-three-way-research-2026-07-08.md"
  - "{planning_artifacts}/sprint-change-proposal-2026-07-15.md"
  - "{planning_artifacts}/sprint-change-proposal-2026-07-16.md"
updated: 2026-07-16
---

# BMad Project Code Graph — Experience Spine

> PRD 与 2026-07-16 纠偏对齐定稿。当前没有 mockup、wireframe 或导入视觉素材；任何后续视觉参考与本文件或 `DESIGN.md` 冲突时，以两份 spine 为准。视觉身份与组件外观见 `DESIGN.md`。

## Foundation

首发形态是 VS Code 桌面扩展与本地 CLI，首批试用对象是维护中大型 TypeScript/JavaScript 项目的 5–15 人技术团队中的一线开发者与 Tech Lead。产品以个人本地安装切入，并在同一真实团队代码库中同时验证日常结构理解与 Tech Lead 的规则治理、审查价值。产品本地优先，默认不上传源码、diff 或图谱。扩展是薄客户端；索引、查询、规则计算和复杂布局不得阻塞 extension host。

VS Code 原生 UI 是 MVP 基础系统：Activity Bar/TreeView 提供状态和入口，编辑器 Webview 承载项目概览与局部图，Problems/结构列表承载 Findings，Command Palette 承载 rebuild、导出和 PR 摘要。CLI 与插件共享术语和结果结构。首个真实 Webview 切片负责验证主题、用户字号、窄宽度与高对比表现，不重新分配这些 surface 职责。

权威聚合只有 `directory` 与 recognized `workspace-package` 两种投影；“模块”只是其中一种投影叶的用户可见称谓，不是持久实体。MVP 关系只包含 `contains`、`imports`、`exports` 和派生 `depends_on`，Finding 可引用 `violates`；`references` 不进入 MVP 导航、导出、成功指标或发布声明。

`DESIGN.md` 是视觉身份与 token 的唯一来源。本文件只规定信息架构、行为、状态、交互和可访问性。

## Information Architecture

| Surface | Reached from | Purpose |
|---|---|---|
| Getting Started / Index Status | 首次打开、Activity Bar、命令执行结果 | 初始化、查看索引进度、覆盖范围、过期与失败恢复 |
| Project Overview | Activity Bar “Overview”、命令面板 | 在 `directory` 或 `workspace-package` 二选一投影上展示 `dependencyStrength`、`internalDependencyStrength`、`cycleMemberCount` 与热点；显示 `groupBy`、规范 ID、workspace discovery、freshness 与 completeness，只有 `current + complete` 结果给出正式排名 |
| Current Context | 打开文件自动跟随、节点“聚焦邻域” | 回答当前文件依赖谁、谁依赖它、改动可能影响哪里 |
| Findings | Problems、Activity Bar “Findings”、保存后提示 | 解释循环、跨层、禁止目录引用及新增依赖风险 |
| Changes / PR Summary | Git diff 命令、Activity Bar “Changes” | Beta+ 能力；区分新增与既有风险，生成本地 Markdown 审查摘要，不阻塞首个可用版本 |
| Entity Details | 选择 `GraphNode`、列表行或 Finding | 查看路径、关系、来源、置信度、时间和源码跳转 |
| Export Preview | “导出结构上下文”或“复制 PR 摘要” | 仅预览和操作完整不可变 artifact；显示 `artifactId`、revision、`requestedPolicy`、`effectivePolicy`、`containsSource`、`contentDigest` 与敏感内容说明，默认不含源码 |
| Settings & Rules | VS Code Settings、打开规则文件 | 管理索引范围、排除项、预算、workspace 与 monorepo 识别、`.codegraph/rules.yaml`，以及默认关闭、显式 opt-in、可随时关闭的遥测状态 |

主路径为：首次索引 → Project Overview → Current Context → 保存后 Findings → Changes / PR Summary 或 Export Preview。每个 stated need 都有对应 surface；任何 surface 均从至少一条 Key Flow 到达。

## Voice and Tone

文案像可靠的静态分析同伴：准确、克制、解释局限，并提供下一步。品牌姿态见 `DESIGN.md`。

| Do | Don't |
|---|---|
| “显示缓存结果；正在后台刷新。” | “加载中……”后清空已有内容 |
| “新增依赖违反 `ui -> domain` 规则。” | “发现架构问题！” |
| “关系来自静态 import，置信度高。” | “确定会影响以下模块。” |
| “未找到受支持的 TS/JS 文件。检查排除设置。” | “暂无数据。” |
| “重新索引失败。查看日志或重试。” | 只显示 `failed` |
| “摘要已复制；未包含源码。” | “导出成功！” |
| “生成失败。未创建可复制内容。” | “已生成部分摘要，可继续复制。” |
| “目标写入失败。完整结果仍可用，可重试或切换目标。” | 把目标失败描述为生成失败 |
| “上一份有效结果 · 〈时间〉 · revision 〈值〉。” | 让旧结果与本次失败看起来属于同一次生成 |

状态名可保留技术标识，但必须附中文解释：`stale（可能过期）`、`indexing（正在索引）`。

### Localization Contract

- VS Code 中所有人类可读界面文案（命令、设置、状态、错误解释、动作、tooltip、图例和可访问名称）支持 zh-CN 与 en，并跟随 VS Code locale；未知 locale 回退 en。
- 本文中的中文示例是 zh-CN 文案基线，不代表机器合同使用中文。
- JSON 字段和值、稳定错误 code、状态枚举、Schema 名称与版本标识不得本地化；宿主根据稳定标识选择人类可读资源，不把本地化文案写回共享合同。

## Component Patterns

组件名与 `DESIGN.md.Components` 完全一致。

| Component | Use | Behavioral rules |
|---|---|---|
| `GraphCanvas` | Project Overview、Current Context、Changes | 只消费预算内 `GraphViewModel`；保持选中项与视口；刷新采用增量 patch，不直接查询数据库 |
| `GraphNode` | 所有图形 surface | Enter/单击选中；再次 Enter 打开 `NodeDetails`；明确区分文件、directory 投影叶、workspace package、外部 npm 包与 external-package 下的 Node built-in；“模块”只能是 directory 投影叶或 recognized workspace package 的用户可见称谓，不是持久实体；聚合节点显示 `groupBy` 与规范 ID；workspace package 展示 package 标识与跨 package 聚合边，外部 npm 包展示外部说明符，Node built-in 展示 `node:` 前缀和“Node 内置模块”；图、列表、图例和屏幕阅读器使用一致名称；文件节点可打开源码；聚合节点展开前说明新增数量 |
| `GraphEdge` | 所有图形 surface | 箭头表达方向；选择后说明来源、置信度、规则和变更状态；可沿边跳到两端实体 |
| `ViewModeSwitch` | 图形 surface | 在图/列表间切换并保持选中、筛选、范围和固定状态；列表具有核心任务等价能力 |
| `ContextLock` | Current Context | 默认跟随编辑器；固定后不随文件切换；固定状态只保存在当前 extension-host 会话内，Webview reload 可由扩展内存恢复，窗口 reload、VS Code 重启或重新打开工作区后清除；解除固定时立即聚焦当前编辑器文件 |
| `NodeDetails` | Entity Details | 提供打开文件、聚焦邻域、复制相对路径；不存在或移动时引导 rebuild；外部 npm 包与 Node built-in 显示 external kind、规范 ID、显示名和关联边，不伪造本地文件跳转 |
| `FindingRow` | Findings、NodeDetails、ChangeSummary、Settings & Rules | 展示稳定 rule ID、规则名、`warning` / `error`、实际边、期望方向、路径、时间、新增/既有状态；规则配置错误显示规则文件位置、范围和修复提示，并支持源码或规则文件跳转 |
| `StatusBanner` | 全局与每个 surface | 非阻塞显示 indexing、refreshing、stale、failed、cancelled、部分结果；大仓库索引显示阶段、进度和取消动作，取消或失败后提供 rebuild；最多一个主动作 |
| `IndexSummary` | Getting Started / Index Status、Project Overview | 显示生成时间、索引文件数、节点数、边数、workspace discovery、workspace package 数、`groupBy`、freshness、completeness、排除摘要和超出标准验收规模状态；仅 `current + complete` 显示正式排名；索引中显示进度，取消后保留缓存摘要并提供重建 |
| `ChangeSummary` | Changes / PR Summary | 仅在 git comparison 与分析完整有效时显示总体 verdict；先显示新增风险，再显示删除边、影响目录、循环变化与既有风险；比较不可用、基线无效或分析不完整时显示不可用状态，不伪造空 verdict |
| `ExportPreview` | Export Preview | 仅 `artifactStatus=complete` 且具有 `artifactId`、revision、`requestedPolicy`、`effectivePolicy`、`containsSource` 与 `contentDigest` 的不可变 artifact 可复制/写出；生成中或生成失败不暴露部分正文；目标失败保留同一完整 artifact 供重试或切换目标；上一份有效 artifact 必须与本次失败状态分离 |

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| Workspace untrusted | Activity Bar、Getting Started / Index Status、图谱命令结果 | 不启动 graph-service、不读取项目文件、不执行 Git 分析；解释 Workspace Trust 限制，唯一主动作是“管理 Workspace Trust”。授予信任后重新进入正常初始化流程，不展示伪造的空图谱或失败缓存 |
| Cold open, no index | Getting Started | `StatusBanner` 解释本地索引，主动作“构建图谱”；辅助入口“查看将被索引的范围” |
| Indexing | Getting Started / Overview | 保留已完成的部分结果，`IndexSummary` 标记完整性、当前阶段与进度；大仓库或超出标准验收规模时提供“取消索引”，不得阻塞编辑器或把部分结果呈现为全貌 |
| Index cancelled | Getting Started / Overview | `StatusBanner` 显示 `cancelled（已取消）`、取消时间和已完成范围；保留上次可用缓存与已完成摘要，提供“重建”，不得清空可查看结果 |
| Ready / idle | 全局 | 状态低调显示“最新 · 〈时间〉”；不持续占据主视觉 |
| Refreshing | Current Context | 300ms 内显示缓存邻域；`StatusBanner` 标记后台刷新，保持视口与选中项 |
| Stale | 所有数据 surface | 缓存仍可操作；显示“可能过期”、原因与“刷新”动作，使用 `{colors.state-warning}` 且配文字/图标 |
| Failed | Index Status | 显示错误摘要、日志位置和 rebuild；失败不得隐藏仍可读取的缓存 |
| No supported files | Getting Started | 说明支持 TS/JS，展示排除摘要，并提供“打开设置” |
| Monorepo recognized | Getting Started / Overview | 显示识别到的 npm、Yarn 或 pnpm workspace 类型、workspace package 数与跨 package 聚合关系；允许下钻到 package 内文件 |
| Single workspace | Getting Started / Overview | 显示 `single（单工作区）`；这是正常状态，不使用 warning/error 视觉；Project Overview 使用 `groupBy=directory`，不生成 workspace package 或跨 package 结论 |
| Monorepo degraded | Getting Started / Overview | 无法识别 workspace 边界时退化为普通单工作区索引；明确说明 package 聚合与跨 package 关系可能不可用，并提供检查 workspace 配置或重建的提示，不阻断其余索引 |
| Overview current + complete | Project Overview | 允许显示正式依赖强度、循环数量和热点排名；显示稳定排序规则、`groupBy`、规范 ID 与查询范围 |
| Overview stale / partial | Project Overview | 保留可浏览结果，但标记为非正式结果并解释 freshness/completeness 限制；不得显示正式排名徽标或把缺失范围解读为零风险 |
| Empty neighborhood | Current Context | 说明没有识别到依赖；允许打开文件、查看索引范围和关系来源说明 |
| Node budget reached | GraphCanvas | 聚合剩余节点，显示“已达范围上限”；提供缩小范围、展开选定聚合或切列表 |
| No findings | Findings | “当前范围没有结构违规。”同时显示范围与更新时间，避免被理解为全仓库永久无风险 |
| New finding | Findings / Current Context | 保存后非模态提示；聚焦具体新增边和规则，不重排整个图 |
| Existing finding | Findings / Changes | 默认折叠在“既有风险”，不得与本次新增风险混为一谈 |
| Rules config invalid | Findings / Settings & Rules | 对重复 ID、未知字段、未知规则类型、缺失必填字段、非法 `severity` / `scope` 等枚举值，显示 `.codegraph/rules.yaml` 的精确行列或范围、问题值和针对性修复提示；不得静默忽略无效规则 |
| Low confidence | Entity Details | 标记来源与置信度，解释限制；不得套用错误视觉 |
| Missing/moved file | NodeDetails | 保留旧路径证据，提供“重新索引”，不执行静默跳转 |
| Export generating | Export Preview | 仅显示进度和“取消/返回”；不呈现部分正文，不启用复制/写出 |
| Export generation cancelled | Export Preview | 不创建或暴露部分 artifact；若存在上一份完整 artifact，继续以“上一份有效结果”分区显示；主动作是“重新生成” |
| Export ready | Export Preview | 仅完整不可变 artifact 进入此状态；显示 `artifactId`、revision、`requestedPolicy`、`effectivePolicy`、`containsSource`、`contentDigest`、范围和文件数，并启用复制/写出动作 |
| Export generation failed | Export Preview | 不创建或暴露部分 artifact；无历史结果时显示空失败状态和“重新生成”；有上一份完整 artifact 时，明确分区显示其时间、revision 与 policy，只允许复制该旧结果或重新生成 |
| Export target failed | Export Preview | 剪贴板或原子文件写入失败时保留本次完整 artifact、预览和身份；允许重试同一目标或切换目标，不重新生成或改变内容 |
| PR comparison unavailable | Changes / PR Summary、Export Preview | git diff 不可用、基线无效或分析不完整时说明所需条件，不显示伪造预览、空 verdict 或可复制 artifact |
| Telemetry off | Settings & Rules | 默认状态为“关闭”；说明核心能力不受影响、当前不发送遥测，并提供显式 opt-in 入口；用户关闭后立即回到此状态并显示本地已生效 |
| Telemetry opt-in | Settings & Rules | 显示“已开启”及允许采集的匿名功能事件、耗时、计数和错误分类；明确排除源码、完整路径、符号、diff、图谱和规则内容，并持续提供“关闭”动作 |

## Interaction Primitives

### 跟随与固定

- 打开受支持文件后，Current Context 默认跟随当前编辑器文件。
- `ContextLock` 状态始终可见；固定只持续当前 extension-host 会话。
- Webview reload 后由扩展内存恢复固定目标；窗口 reload、VS Code 重启或重新打开工作区后恢复“跟随编辑器”。`workspaceState` 与 `globalState` 均不得保存固定标记。
- 切换文件时先切换中心节点，再后台刷新；不得用空画布过渡。

### 渐进披露

- 默认显示预算内一跳关系；用户可从选中节点扩展下一跳。
- Overview 的一次查询只使用 `groupBy=directory` 或 `groupBy=workspace-package`，同一文件只属于一个叶子聚合；“模块”不是第三种持久实体。
- 服务端对完整候选范围稳定排序后再按预算截断，并以规范 ID 作为最终 tie-break；query identity 至少包含 `scopeRoot`、`groupBy`、`aggregationDepth` 与 `membershipDigest`。展开聚合创建新的局部查询，不在旧视图上无限累积。
- 超预算时聚合为 directory 投影叶或 workspace package，不硬编码“最多两跳”。
- 图、列表和详情共享同一选中、范围与筛选状态。

### 键盘

- `Tab` 在工具栏、画布、详情间移动；画布内部使用方向键遍历邻接节点。
- `Enter` 选择/打开，`Space` 展开聚合，`Esc` 返回上一级或关闭详情。
- Windows/Linux 候选：`Ctrl+Alt+G` 打开 Current Context，`Ctrl+Alt+P` 固定/解除固定；macOS 候选：`Cmd+Option+G` 与 `Cmd+Option+P`。
- 候选绑定必须在 VS Code 1.125.0、最新稳定版和前一稳定版检查宿主默认键位、Accessibility Help、产品自身命令与常用系统保留组合，并记录 `hostVersion`、OS、`keyboardLayout`、candidate、`conflictTarget` 与 disposition。
- 若候选覆盖 VS Code 默认或可访问性关键命令，该平台不注册默认绑定；第三方扩展冲突只记录为可重映射兼容信息，不维护无界清单。
- 所有命令同时暴露于 Command Palette，不依赖记忆快捷键。

### 低打扰更新

- 保存后的增量解析不弹模态框；新增风险通过 Problems、状态栏或非阻塞提示进入。
- debounce/batch 完成后一次提交 UI patch；更新不得导致图谱持续漂移。
- 只有需要用户恢复的失败才显示持续 `StatusBanner`。

### 禁止模式

- 禁止默认全仓库大图、无限扩展、持续力导动画和强制自动缩放。
- 禁止把推断关系表现成确定事实。
- 禁止只在 hover 中提供关键动作。
- 禁止超过一层模态栈；首版优先编辑器面板与原生 quick pick。

## Trust, Provenance & Performance

- `GraphEdge` 与 `NodeDetails` 必须能显示关系来源、置信度、schema/version 或更新时间。
- 精确静态 import、语言服务结果与启发式推断使用不同文字标签；“低置信”不是“错误”。
- 已确认的标准验收项目不超过 5,000 个受支持源码文件、500,000 LOC 和 50 个 workspace package；参考环境为 8 个逻辑 CPU、16 GB 内存与 SSD。
- 在该基线下，首次项目结构概览应在 60 秒内可用；索引中持续显示范围和进度，不用空白等待替代反馈。
- 打开文件后 300ms 内优先返回缓存邻域；局部查询超过 500ms 时显示“正在查询”并保留旧结果。
- 保存后 2 秒内刷新局部关系和 Findings；超过阈值时继续显示“更新中”，不得宣布结果最新。
- Webview 只接收预算内 `GraphViewModel`；服务端对完整候选范围稳定排序后再截断，并以规范 ID 作为最终 tie-break；相同 `scopeRoot`、`groupBy`、`aggregationDepth`、`membershipDigest`、revision 和配置必须得到稳定顺序。单次查询和渲染预算已确认为最多 100 个节点、200 条边；手动展开创建新的局部 query identity 并按新预算加载，不无限累积。
- 超出标准验收规模时不承诺相同 SLA，但索引、查询与布局不得阻塞编辑器；必须显示进度，并允许取消或重建。
- 后台刷新必须保留空间记忆：中心节点、选中路径、缩放、展开状态和列表位置。

## Accessibility Floor

- 遵循 VS Code 可访问性设置与高对比主题；人类可读界面必须达到 WCAG 2.2 AA。
- 图形核心信息必须在 `ViewModeSwitch` 的列表模式中等价提供；屏幕阅读器不需要解析画布几何关系才能完成任务。
- `GraphNode` 宣读名称、类型、入边数、出边数、Finding 数和选中状态；`GraphEdge` 宣读起点、方向、终点、来源与置信度。
- Node built-in 宣读规范名称与类型，例如“`node:fs`，Node 内置模块”；相同语义必须出现在图例和等价列表中，不能只靠轮廓或图标区分。
- 风险、关系类型和新增/删除状态不得只靠颜色；必须同时有文字、图标、线型或符号。
- 焦点顺序与阅读顺序一致；焦点轮廓映射 `{colors.focus}`，任何主题下保持可见。
- “减少动态效果”开启时禁用布局补间和路径流动动画；刷新直接稳定到新位置。
- 所有操作可通过键盘完成；最小指针目标遵循 VS Code 原生控件尺寸，图节点可选区域不得小于 24×24 CSS px。

## Responsive & Platform

这是可变宽度的桌面 IDE 表面，不按手机网页处理。900px、600px、360px 是可校准的候选响应阈值，不是不可变产品常数。

| Available width | Behavior |
|---|---|
| `≥ 900px` editor area | `GraphCanvas` + 右侧 `NodeDetails`；工具栏单行 |
| `600–899px` | 详情折叠为可打开面板；工具栏允许两行 |
| `< 600px` | 默认列表模式；图仍可主动打开；详情在下方堆叠 |
| `< 360px` sidebar | 只显示状态、计数和入口，不渲染完整图 |

实现必须在真实 VS Code Webview 中测试 1024、900、899、600、599、360、359 CSS px，并以无关键动作裁切、无水平溢出、200% 字号下信息不重叠、键盘焦点不丢失为通过条件。若校准后阈值变化，必须同步更新本文件、UX-DR36、Story AC 和视觉基线。主题、字号、键位、缩放和焦点完全继承 VS Code；CLI 输出与插件保持相同状态名、规则名和相对路径格式。

| 验证维度 | 阻断覆盖 |
|---|---|
| Host version | VS Code 1.125.0、最新稳定版、前一稳定版 |
| Theme | 暗色、亮色、高对比 |
| Zoom / font | 100%、200% |
| Editor width | 1024、899、599 CSS px |
| Sidebar width | 359 CSS px |
| Input | 仅键盘完成 Overview、Current Context、Findings、PR Summary 与 Export Preview 核心任务 |
| Assistive technology spot check | Windows + NVDA、macOS + VoiceOver、Linux + Orca；至少覆盖最新稳定版、高对比与 200% 字号 |
| Evidence | 截图或可访问性树、焦点顺序、溢出结果、宿主版本、主题、OS、断点与已知限制 |

首个真实 Webview 实现切片建立基础证据，发布候选由 Story 5.5 复验；独立 mockup 或 wireframe 不是实施前置条件。WCAG 2.2 AA 和 24×24 CSS px 是强制要求，待闭合的是证据，不是要求本身。

## Inspiration & Anti-patterns

- 借鉴 Sourcegraph 的代码导航连续性，但不与全局搜索竞争；本产品承接“找到代码之后理解影响”。
- 借鉴 JetBrains/Understand 的依赖与循环分析，但保持 VS Code 插件级轻量和渐进披露。
- 借鉴 Lattix 的架构规则证据链，但不把复杂治理模型暴露为首屏负担。
- 借鉴 SonarQube 的规则一致性，但把反馈前移到保存后的本地工作流。
- 明确拒绝 CodeSee 式“漂亮地图即产品”、默认全量力导图、脱离 IDE 的独立 Dashboard、保存后模态告警和只有图没有文本替代的体验。

## Key Flows

### UJ-1 新加入的开发者理解项目结构（林，加入项目第一天，需要修复陌生模块缺陷）

1. 林打开 VS Code 工作区，Activity Bar 显示“尚未构建图谱”。
2. 他执行“构建图谱”；Getting Started 展示本地处理说明、索引范围、monorepo/workspace 识别状态与进度。
3. 部分结果可用后，他进入 Project Overview；`IndexSummary` 明确标注“索引中”。
4. 他在 `directory` 或 `workspace-package` 投影中查看依赖强度、循环风险和热点；只有 `current + complete` 时使用正式排名，再下钻到带规范 ID 的目标聚合。
5. 他切换到列表确认上游、下游和风险路径，并打开相关文件。
6. **Climax：** 索引完成后，林能依据 Overview 与 Current Context 说清目标模块的上下游、关键入口和边界风险，并开始修复，而不是继续盲目搜索。

Failure path：工作区未授予信任时不启动服务、不读取项目或执行 Git 分析，Getting Started 解释限制并提供“管理 Workspace Trust”；索引失败时保留已生成的部分结果，`StatusBanner` 提供错误摘要、日志位置和 rebuild；无法识别 monorepo 时退化为普通单工作区索引，提示检查 workspace 配置但不阻断继续探索；无受支持文件时引导检查排除设置。

### UJ-2 日常开发者判断当前文件影响范围（May，准备修改多个页面共享的状态管理文件）

1. May 打开目标文件，Current Context 在 300ms 内显示缓存的一跳邻域。
2. `StatusBanner` 显示“正在后台刷新”；中心节点稳定在当前文件。
3. 她查看直接依赖、反向依赖和外部包，并用列表模式核对路径。
4. 她固定视图，打开两个反向依赖文件比较调用位置；图谱不再随编辑器切换。
5. 她从一个聚合模块主动扩展下一跳；达到预算时选择缩小范围而非加载全图。
6. **Climax：** May 在 3 分钟内识别 task pack 要求的实体与受影响聚合，排除关键干扰项，得到明确的受影响页面清单与相关路径，并据此确定修改和测试范围。

Failure path：缓存过期或查询超过阈值时继续显示旧结果并标记 stale；若关系置信度低，详情解释来源，May 可切换文本列表核查。

### UJ-3 开发者保存代码后发现结构违规（Alex，正在新增一个跨层 import）

1. Alex 编辑文件期间图谱保持稳定，不随每次输入重排。
2. 保存后，本地服务批量解析变更并增量更新邻域。
3. 非阻塞提示告知“新增 1 条结构风险”；Problems 与 Findings 出现对应 `FindingRow`。
4. Alex 打开 Finding，看到规则名、实际依赖方向、期望方向、两端文件、检测时间和“本次新增”标识。
5. 他从 `GraphEdge` 跳转到触发 import，修改代码并再次保存。
6. **Climax：** 该 Finding 消失或转为已解决，Current Context 保持原选中位置，Alex 清楚知道是哪条新增边触发规则，而不是只看到泛化告警。

Failure path：增量分析失败时保留上次图谱并显示“结果可能过期”；若 `.codegraph/rules.yaml` 存在重复 ID、未知字段或类型、缺失字段或非法枚举，`FindingRow` / `StatusBanner` 指向精确配置范围并给出修复提示，不静默忽略；两类失败都提供日志或 rebuild，且不阻断继续编辑。

### UJ-4 Tech Lead 审查 PR 结构影响（Chen，审查一个跨目录重构）

1. Chen 在本地分支执行“生成结构变更摘要”。
2. Changes / PR Summary 读取 git diff，显示总体 verdict、新增/删除边、影响目录和循环变化。
3. 他先查看“本 PR 新增风险”，再按需展开既有风险。
4. 他选择关键 `FindingRow`，跳转到变更文件并沿影响路径检查相关模块。
5. `ExportPreview` 展示将复制的 Markdown：总体 verdict、主要风险、关键路径和建议复查文件，路径均为相对路径且不含源码。
6. **Climax：** Chen 无需重新做结构分析即可使用该 Markdown 完成 PR review，最多调整措辞或格式，并能指出耦合是否扩大及需要复查的具体文件。

Failure path：git diff 不可用或分支状态异常时说明所需条件，不给出伪造预览；生成失败时不创建或暴露部分 artifact，也禁止复制部分摘要，只能重新生成或明确复制上一份完整结果；剪贴板或原子文件写入失败时保留同一完整 artifact，允许重试同一目标或切换目标。

### UJ-5 AI 编码重度用户导出局部结构上下文（Wen，准备让 AI 修改一个边界敏感模块）

1. Wen 在 Current Context 聚焦目标文件，确认允许修改的范围与禁止跨越的边界，并选择所需邻域。
2. 他打开 Export Preview，查看将导出的节点、依赖关系、边界和 Findings。
3. 预览明确显示这是完整的 structure-only artifact，默认不含源码、使用相对路径、完全本地生成。
4. Wen 移除一个不相关聚合，保留禁止跨越的边界规则。
5. 他把该 artifact 作为 AI 任务约束，修改完成后运行 check/impact，重新核对邻域与规则。
6. **Climax：** Wen 不只给 AI 一段孤立代码，而是给出可核查的结构边界；修改后同一工具证明没有新增跨层依赖。

Failure path：范围超过预算时导出先聚合并提示缩小范围；关系置信度不足时在上下文中保留来源与限制，不把推断写成确定约束；生成失败或取消时不暴露部分 artifact，目标操作失败时复用同一完整 artifact 重试或切换目标。

## MVP Scope Decisions

- `[DECISION][MVP-OUT-OF-SCOPE]` Finding 首版只支持定位与修复验证，不提供 UI 内忽略、豁免审批或历史趋势。该决定不是未确认假设；产品负责人和 UX 负责人只在 Beta+ 门禁完成后，且真实团队证据显示“无法在 UI 内忽略/豁免”阻断核心修复或治理任务时，才重新评估后续版本范围。
