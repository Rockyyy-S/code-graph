---
name: BMad Project Code Graph
description: VS Code 内代码结构感知与影响分析工具的视觉设计契约。
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
colors:
  surface-base: '#1E1E1E'
  surface-base-light: '#FFFFFF'
  surface-raised: '#252526'
  surface-raised-light: '#F3F3F3'
  surface-selected: '#04395E'
  surface-selected-light: '#E4F2FE'
  ink-primary: '#CCCCCC'
  ink-primary-light: '#1F1F1F'
  ink-secondary: '#9D9D9D'
  ink-secondary-light: '#616161'
  border-default: '#3C3C3C'
  border-default-light: '#CECECE'
  focus: '#007FD4'
  focus-light: '#0078D4'
  state-info: '#3794FF'
  state-success: '#89D185'
  state-warning: '#CCA700'
  state-error: '#F14C4C'
  relation-direct: '#4FC1FF'
  relation-reverse: '#C586C0'
  relation-external: '#DCDCAA'
  relation-inferred: '#9D9D9D'
  change-added: '#89D185'
  change-removed: '#F14C4C'
typography:
  ui:
    note: '继承 VS Code --vscode-font-family、--vscode-font-size 与用户缩放设置'
  label:
    note: '继承 VS Code UI 字体；使用 font-weight: 600，不使用全大写'
  code:
    note: '继承 VS Code --vscode-editor-font-family 与 --vscode-editor-font-size'
  meta:
    note: '继承 VS Code UI 字体；字号为宿主字号的 0.9 倍且不得低于 12px'
rounded:
  sm: 2px
  md: 4px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '5': 24px
  '6': 32px
components:
  GraphCanvas:
    background: '{colors.surface-base}'
    foreground: '{colors.ink-primary}'
    grid: 'none'
  GraphNode:
    background: '{colors.surface-raised}'
    foreground: '{colors.ink-primary}'
    border: '{colors.border-default}'
    selected-border: '{colors.focus}'
    workspace-package-border-style: 'solid'
    external-package-border-style: 'dashed'
    node-builtin-border-style: 'dotted'
    node-builtin-icon: 'symbol-module'
    radius: '{rounded.md}'
  GraphEdge:
    direct: '{colors.relation-direct}'
    reverse: '{colors.relation-reverse}'
    external: '{colors.relation-external}'
    inferred: '{colors.relation-inferred}'
  ViewModeSwitch:
    active-background: '{colors.surface-selected}'
    active-foreground: '{colors.ink-primary}'
    radius: '{rounded.sm}'
  ContextLock:
    active-border: '{colors.focus}'
    active-foreground: '{colors.focus}'
    radius: '{rounded.sm}'
  NodeDetails:
    background: '{colors.surface-raised}'
    border: '{colors.border-default}'
    radius: '{rounded.md}'
  FindingRow:
    background: '{colors.surface-base}'
    selected-background: '{colors.surface-selected}'
    error: '{colors.state-error}'
    warning: '{colors.state-warning}'
  StatusBanner:
    info: '{colors.state-info}'
    warning: '{colors.state-warning}'
    error: '{colors.state-error}'
    radius: '{rounded.sm}'
  IndexSummary:
    background: '{colors.surface-raised}'
    border: '{colors.border-default}'
    radius: '{rounded.md}'
  ChangeSummary:
    added: '{colors.change-added}'
    removed: '{colors.change-removed}'
    border: '{colors.border-default}'
  ExportPreview:
    background: '{colors.surface-raised}'
    foreground: '{colors.ink-primary}'
    border: '{colors.border-default}'
    radius: '{rounded.md}'
    actionable-artifact-status: 'complete'
    actionable-identity: 'artifactId + revision + requestedPolicy + effectivePolicy + containsSource + contentDigest'
---

# BMad Project Code Graph — Design Spine

> PRD 与 2026-07-16 纠偏对齐定稿。当前没有 mockup、wireframe 或用户品牌素材；任何后续视觉参考与本文件冲突时，以本文件为准。

## Brand & Style

产品应像 VS Code 中可信、安静的诊断工具，而不是独立品牌化的数据可视化站点。视觉优先级依次是：当前上下文、关系方向、变更风险、数据新鲜度、可执行动作。图谱是证据载体，不是装饰性主角。

首版完全继承 VS Code 的主题、字体、焦点、菜单和通知语言，仅为图谱关系与结构风险增加必要的视觉语义。避免大面积品牌色、渐变、玻璃效果、持续运动和仪表盘式装饰。

## Colors

YAML 中的颜色是暗色主题 fallback；运行时优先映射到 VS Code Theme Color/CSS variables。`*-light` 是亮色 fallback。高对比主题必须完全服从宿主，不得强制使用 fallback。

| 语义 | 运行时优先来源 | 规则 |
|---|---|---|
| 基础与抬升表面 | `editor.background`、`sideBar.background`、`editorWidget.background` | 依靠宿主表面层级，不用阴影制造层级 |
| 主次文字 | `foreground`、`descriptionForeground` | 路径、规则名和操作必须达到宿主可读标准 |
| 选择与焦点 | `list.activeSelectionBackground`、`focusBorder` | 焦点必须有轮廓，不得只靠填充色 |
| 错误与警告 | `errorForeground`、`editorWarning.foreground` | 必须同时配合图标、文字和严重级别标签 |
| 关系类型 | `{colors.relation-direct}` 等 | 颜色之外同时使用箭头、线型和文字图例 |
| 新增与删除 | `{colors.change-added}`、`{colors.change-removed}` | 同时使用 `+` / `−`、实线 / 删除线或标签 |

直接依赖、反向依赖、外部包和推断关系只在局部图、图例及详情中使用关系色；常规界面框架保持宿主中性。低置信度不得使用错误红色，以免把不确定性误报为违规。

所有人类可读界面的文字、状态、焦点和关系编码必须达到 WCAG 2.2 AA；这是强制视觉下限，不因仍需真实 Webview 验证而降级为假设。

## Typography

所有 UI 文本继承 VS Code 字体和用户缩放。代码路径、符号名、规则表达式、CLI 片段使用 `{typography.code}`；按钮、标签和说明使用 `{typography.ui}`。

- 节点主标签最多两行；完整路径必须在详情或 tooltip 中可读。
- 路径与符号名禁止使用全大写或装饰字体。
- 状态文案使用完整短句，如“图谱可能已过期。正在刷新。”，不只显示 `stale`。
- 数字摘要使用等宽数字或 `{typography.code}`，便于比较节点数、边数和变更数。

## Layout & Spacing

采用 4px 基础节奏。工具栏内部使用 `{spacing.1}`–`{spacing.2}`，组件内部使用 `{spacing.2}`–`{spacing.3}`，主要区域间使用 `{spacing.4}`–`{spacing.5}`。

MVP 主图在编辑器 Webview 中呈现：顶部为紧凑工具栏，中部为 `GraphCanvas`，右侧为可收起的 `NodeDetails`。宽度不足时详情转为底部区域；侧边栏只提供结构树、状态和列表入口，不承载完整图。首个真实 Webview 切片必须验证 VS Code 主题、用户字号、窄宽度和高对比表现，但该验证不重新分配已确定的 surface 职责。

所有人类可读标签必须容纳 zh-CN 与 en 文案，不用固定宽度截断关键状态、动作或实体类型；未知 locale 回退 en 后，布局仍须满足相同可读性要求。

图谱默认围绕当前节点形成稳定锚点。后台刷新、视图切换和增量 patch 应保留选中节点、缩放、展开层级与滚动位置。Overview 的一次查询只能选择 `directory` 或 `workspace-package` 作为 `groupBy`，同一文件只属于一个叶子聚合；用户可见的“模块”只是 directory 投影叶或 recognized workspace package 的称谓，不是独立持久实体。达到预算时优先聚合为 directory 投影叶或 workspace package 节点，并给出缩小范围、展开为新局部查询或切换列表的动作。

## Elevation & Depth

继承 VS Code 的边框和表面层级。`NodeDetails`、popover 和 `ExportPreview` 可使用宿主 widget shadow；普通节点、摘要卡和列表行不得使用自定义投影。

选中、固定、警告和错误通过边框、图标与文字表达，不通过抬升表达。图谱边始终位于节点下层，选中路径可提高不透明度但不得遮挡标签。

## Shapes

形状保持工具感：输入、切换器和紧凑标签使用 `{rounded.sm}`；节点、详情区和预览区使用 `{rounded.md}`。仅计数徽标可使用 `{rounded.full}`。

外部 npm 包节点使用虚线轮廓；Node 内置模块使用点线轮廓和 `symbol-module` codicon（或画布中的等价模块图标），不得复用外部包图标；directory 投影叶可使用双层轮廓，显示名称可称“模块”，但必须同时显示 `groupBy=directory` 和规范 ID；workspace package 保持实线轮廓并显示 package 标识与 `groupBy=workspace-package`；低置信关系使用虚线边。形状差异必须有图例和文本名称，不允许依赖形状猜测语义。

## Components

### `GraphCanvas`

局部关系图的唯一主画布。背景使用宿主编辑器表面；无装饰网格。空白区域不放品牌插画。右下角提供缩放与“适应视图”，左上角提供当前范围、`groupBy`、freshness、completeness 和预算摘要。只有 `current + complete` 的 Overview 可显示正式排名；stale 或 partial 结果必须显式标注为非正式结果。

### `GraphNode`

统一呈现四类视觉节点类别：文件、directory 投影叶、workspace package、external-package。当前文件使用 2px `{colors.focus}` 轮廓和“当前”文本标识；directory 投影叶是查询聚合而非持久实体，显示双层轮廓、包含数量、`groupBy=directory` 和规范 ID，显示名称可以称“模块”，但不得暗示存在独立 module 实体；workspace package 仅在 workspace discovery 为 recognized 时出现，使用实线轮廓，显示 package 图标、package 名称、“工作区 package”标签、`groupBy=workspace-package` 和规范 ID，并可聚合显示跨 package 依赖；外部 npm 包使用虚线轮廓、包说明符和“外部包”标签。Node built-in 保持为 external-package 的 `node-builtin` 子类型，主标签使用规范 `node:` 前缀（如 `node:fs`），辅助标签固定为“Node 内置模块”，使用点线轮廓和独立模块图标。workspace package、外部 npm 包与 Node 内置模块必须同时通过轮廓、图标、标签和文本区分，并在图例与列表中使用同一名称。存在 Finding 时显示严重级别图标和数量。选中不得导致节点尺寸跳变。

### `GraphEdge`

箭头必须明确依赖方向。直接、反向、外部、推断关系分别使用 `{colors.relation-direct}`、`{colors.relation-reverse}`、`{colors.relation-external}`、`{colors.relation-inferred}`，并配合实线、反向箭头、外部标签、虚线。新增/删除边叠加 `+` / `−` 标识。

### `ViewModeSwitch`

“图 / 列表”分段切换。两种模式共享选中实体、筛选与范围；图不是默认的唯一真相。窄宽度或减少动态效果开启时可默认列表。

### `ContextLock`

显示“跟随编辑器”或“已固定：〈相对路径〉”。固定状态使用 `{colors.focus}` 轮廓和图钉图标，必须持续可见，避免用户误判图谱未更新。

### `NodeDetails`

展示相对路径、实体类型、入边、出边、更新时间、来源、置信度和 Findings。主要动作是“打开文件”“聚焦邻域”“复制路径”；文件不存在时以 `StatusBanner` 提供“重新索引”。

### `FindingRow`

展示稳定 rule ID、规则名、`warning` / `error` 严重级别、新增边、实际方向、期望规则、相关路径、检测时间与状态。规则配置错误还要显示 `.codegraph/rules.yaml` 的文件位置与范围，并给出针对重复 ID、未知字段、未知类型、缺失字段或非法枚举值的修复提示。必须区分“本次新增”与“既有风险”，并提供源码或规则文件跳转。不得用模糊红色提示替代具体证据。

### `StatusBanner`

承载 `indexing`、`refreshing`、`stale`、`failed`、`cancelled`、部分结果和无支持文件状态。大仓库或超出标准验收规模时显示当前阶段、已处理范围和持续进度，并提供“取消索引”；取消后明确说明缓存仍可查看，并提供“重建”。使用图标、标题、解释和单一主动作；刷新中不遮挡缓存结果，失败状态提供日志位置与 rebuild。

### `IndexSummary`

显示生成时间、索引文件数、节点数、边数、workspace discovery、workspace package 数、`groupBy`、freshness、completeness 和排除路径摘要。数字对齐、标签简短；索引未完成时显示已完成范围、当前阶段与进度，超出标准验收规模时标记“不承诺标准 SLA”；取消后保留上次缓存摘要，并提供取消原因、取消时间和重建入口。只有 `current + complete` 的 Overview 可使用正式排名视觉；禁止把 stale、partial 或已取消结果表现为完整正式结果。

### `ChangeSummary`

显示新增/删除依赖边、受影响目录、循环变化、规则违规及总体 verdict。新增风险置前，既有风险折叠；颜色之外必须使用 `+` / `−` 和文字标签。

### `ExportPreview`

只预览完整不可变 artifact。仅当 `artifactStatus=complete` 且同时显示 `artifactId`、revision、`requestedPolicy`、`effectivePolicy`、`containsSource` 与 `contentDigest` 时，复制/写出动作才可用。生成中和生成失败不得呈现可复制的部分正文；若存在上一份完整 artifact，必须标记为“上一份有效结果”，显示生成时间、revision 和 policy，并在视觉上与本次失败状态分离。目标操作失败时保留本次完整预览与身份信息，允许重试同一目标或切换目标。默认内容只含相对路径、关系、边界和 Findings，不含源码，并明确标记本地生成与目标位置。

## Do's and Don'ts

| Do | Don't |
|---|---|
| 继承 VS Code 主题、焦点和字号 | 创建与宿主冲突的独立品牌壳层 |
| 从一跳局部邻域开始，按需展开 | 默认渲染全仓库大图 |
| 用箭头、线型、图标和文字共同编码 | 只靠颜色区分关系或风险 |
| 保留选中项、位置和固定状态 | 后台刷新后重新洗牌整个图谱 |
| 缓存结果可继续查看，并明确标记过期 | 刷新时清空画布或阻断编码 |
| Findings 指向具体规则、边和文件 | 使用“发现架构问题”一类模糊告警 |
| workspace package 使用实线轮廓和“工作区 package”标签 | 让 workspace package 与外部 npm 包只靠同一种包图标区分 |
| 把“模块”明确映射到 directory 投影叶或 recognized workspace package，并显示 `groupBy` 与规范 ID | 把 module 表现为第三种持久实体，或在一次查询中混用两种聚合投影 |
| Node 内置模块使用 `node:` 前缀、模块图标、点线轮廓和“Node 内置模块”标签 | 把 `node:fs` 伪装成本地文件或普通外部 npm 包 |
| 大仓库索引显示进度并允许取消；取消后保留缓存 | 取消索引后清空可用结果或阻塞编辑器 |
| 图与列表共享上下文并保持等价 | 把图形视图作为唯一可用入口 |
| 仅对完整且身份可核验的 artifact 启用复制或写出 | 在生成中或生成失败后暴露、预览或复制部分内容 |
| 明示来源、置信度和局限 | 把静态推断包装成确定事实 |
