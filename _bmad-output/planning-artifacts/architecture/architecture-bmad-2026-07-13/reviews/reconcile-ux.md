---
title: UX 输入与架构脊柱对账报告
date: 2026-07-13
review_type: input-reconciliation
status: complete
reviewed:
  - ../../ux-designs/ux-bmad-2026-07-13/DESIGN.md
  - ../../ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
  - ../ARCHITECTURE-SPINE.md
---

# UX 输入与架构脊柱对账报告

## 结论

**有条件通过，建议在架构脊柱定稿前补强共享 UX 契约。** 当前脊柱已经承接了大部分真正需要上升为架构不变量的 UX 决策：VS Code 混合宿主表面、薄客户端、预算内 `GraphViewModel`、图/列表任务等价、主题与高对比继承、缓存结果在失败后继续可用、Findings 原子更新、CLI/导出基础能力和本地优先隐私边界。

未发现 UX 与已采用 AD 之间的直接硬冲突。主要风险是若干跨 `extension`、`webview`、`graph-service` 的共享语义仍只存在于 UX 文档，没有被脊柱固定。两支实现团队可以完全遵守当前 AD，却分别实现出不兼容的状态机、空间记忆、Finding“新增”口径、键盘/屏幕阅读器语义和导出隐私默认值。

本报告不建议把颜色值、4px 间距、具体圆角或暂定断点机械复制进架构脊柱；应补的是会造成跨单元分歧的行为、状态、所有权和线协议不变量。

## 总体覆盖矩阵

| 检查维度 | 结果 | 架构承接情况 |
| --- | --- | --- |
| 信息架构 | 部分承接 | `AD-10` 固定了 Activity Bar/TreeView、Webview、Problems、Status Bar、Command Palette，但未明确 Getting Started/Index Status、Entity Details、Export Preview、Settings & Rules 的宿主与所有者。 |
| 状态模型 | 部分承接 | `AD-3`、`AD-7`、`AD-8`、`AD-9` 覆盖 revision、stale、Job 和配置无效，但未形成 UI 可消费的完整状态分类、完整性和转换契约。 |
| 宿主表面 | 基本承接 | 核心表面职责清楚且与 UX 一致；辅助 surface 的归属仍有空白。 |
| 图/列表等价 | 已承接 | `AD-15` 明确核心任务等价，`AD-10` 将两者放在同一 Webview Editor，方向正确。 |
| 主题与视觉语义 | 已承接 | `AD-15` 固定 VS Code 主题、字体、焦点、高对比和减少动态效果，并禁止只靠颜色；具体 token 留给 UX/实现是合理的。 |
| 键盘 | 承接不足 | Command Palette 已绑定，但画布内部导航、聚合展开、详情开关、焦点回退和“所有核心操作可键盘完成”未成为不变量。 |
| 屏幕阅读器 | 承接不足 | 列表替代降低了风险，但节点/边可访问名称、关系朗读、焦点/阅读顺序和状态通知语义未绑定。 |
| 响应式 | 部分承接 | TreeView 不承载完整图已经固定；窄宽度默认列表、详情重排和工具栏降级未绑定。具体像素断点仍可留在实施层。 |
| 刷新空间记忆 | 承接不足 | `AD-10` 规定语义状态与视觉状态的所有权，但没有规定 patch/reload 后必须恢复哪些状态，也没有 revision 断档后的重取规则。 |
| Findings 体验 | 部分承接 | 原子更新、可定位 Problems、新增/既有分类已出现，但分类基线、证据字段和解决生命周期不明确。 |
| 导出体验 | 部分承接 | `AD-13` 固定格式、相对路径和自动化契约；默认不含源码、预览保留、失败重试/复制与范围裁剪没有成为架构约束。 |

## 关键发现

### 1. [高] UI 状态机与完整性契约没有被固定

UX 定义了 cold open、indexing、ready、refreshing、stale、failed、no supported files、empty neighborhood、node budget reached、no findings、missing/moved file、export ready/failed 等状态，并要求索引和刷新期间继续展示缓存或已完成的部分结果（`EXPERIENCE.md:73-92`）。还规定缓存邻域、慢查询提示和保存后刷新阈值（`EXPERIENCE.md:128-135`）。

当前架构只分散规定：失败后旧 revision 以 stale 提供（`ARCHITECTURE-SPINE.md:68-72`）、服务返回 freshness/截断（`ARCHITECTURE-SPINE.md:92-96`）、Job 生命周期（`ARCHITECTURE-SPINE.md:98-102`）以及无效规则配置的 stale 原因（`ARCHITECTURE-SPINE.md:104-108`）。它没有固定一个 extension/webview 共用的状态 envelope，也没有明确：

- `freshness`、`completeness`、`activeJob`、`staleReason`、`cachedRevision` 如何组合；
- 初次 rebuild 的部分提交是否可查询，何时从 partial 变为 ready；
- slow query、failed refresh、no supported files 与空结果如何区分；
- 哪些状态必须保留旧数据，哪些状态没有旧数据可展示；
- UX 的 300ms / 500ms / 2s 门槛由客户端、服务还是验收测试负责。

**分歧风险：** 服务可能只返回 `ready/stale`，Webview 自行推断其他状态；CLI、TreeView 和 Webview 会使用不同状态名、完整性口径和恢复动作。

**建议：** 在 `AD-7`/`AD-8` 或新增 AD 中固定跨客户端状态契约及所有者。精确文案和颜色留在 UX；状态枚举、完整性含义、revision 绑定、慢/失败回退规则必须共享。性能阈值至少应明确由 NFR 验收契约约束，而非由各 UI 自行选择。

### 2. [高] 刷新空间记忆与增量 ViewModel 协议未成为不变量

UX 要求后台刷新、图/列表切换和增量 patch 保留中心节点、选中路径、缩放、展开状态、列表位置、筛选、范围与固定状态（`DESIGN.md:144-150`；`EXPERIENCE.md:55-70`、`128-135`）。切换文件时先换中心节点再后台刷新，不能用空画布过渡（`EXPERIENCE.md:96-100`）。

`AD-10` 仅规定“扩展持有语义会话状态，Webview 只持有视觉状态”（`ARCHITECTURE-SPINE.md:110-114`），`AD-7` 只要求 ViewModel 携带 revision（`ARCHITECTURE-SPINE.md:92-96`）。当前脊柱没有固定：

- 语义状态至少包含哪些键：center entity、selected entity/path、scope、filters、view mode、context lock；
- 视觉状态至少包含哪些键：viewport、layout positions、expanded aggregates、list scroll；
- Webview reload 后由谁、以什么顺序恢复完整 ViewModel、语义状态和视觉状态；
- 增量 patch 的 `baseRevision/nextRevision`、幂等性和断档重取规则；
- 节点删除、移动或聚合变化时，选择与焦点如何降级。

**分歧风险：** extension 和 webview 都可能认为对方会保存 selection/filter；刷新后出现重新布局、焦点丢失、图/列表上下文漂移，且仍不违反现有 AD。

**建议：** 收紧 `AD-7` 与 `AD-10`，固定“语义会话状态由 extension 作为权威镜像，视觉状态由 webview 持有但可恢复”的握手与 patch 连续性规则。具体 Cytoscape 布局数据仍不应进入领域或服务协议。

### 3. [高] 可访问性只固定了替代视图，没有固定可操作语义

`AD-15` 已正确要求图/列表任务等价、非颜色单通道、服从 VS Code 主题/高对比/减少动态效果（`ARCHITECTURE-SPINE.md:140-144`），这覆盖了最重要的一半。

但 UX 的可访问性底线还包括：所有操作可键盘完成；方向键遍历邻接节点；Enter/Space/Esc 语义；焦点顺序与阅读顺序一致；节点朗读名称、类型、入/出边和 Finding 数；边朗读起点、方向、终点、来源与置信度；减少动态时禁用布局补间；最小可选目标（`EXPERIENCE.md:108-113`、`137-145`）。这些内容在当前 AD 中没有等价的不变量。

**分歧风险：** 团队可能把列表做成可访问替代，却让图画布无法键盘探索、节点/边只暴露无意义的 canvas 元素；另一团队可能实现不同的焦点模型，导致详情、图和列表无法连续操作。

**建议：** 收紧 `AD-15`：固定所有核心任务可键盘完成、图节点/边有稳定可访问名称与关系描述、焦点/选择由共享语义状态驱动、状态变化通过非模态可访问通道宣布。具体快捷键组合可继续留给 VS Code 冲突检查，暂定断点和 24×24 数值可留在实施指南。

### 4. [高] Finding 的“新增/既有”没有定义比较基线

UX 同时存在两种“新增”语境：保存后相对上一次有效图谱新增的 Finding（UJ-3），以及 PR/Changes 相对 Git base 新增的风险（UJ-4）。Finding 还需要规则、实际边、期望方向、两端路径、来源/置信度、检测时间、源码范围和解决验证（`DESIGN.md:190-192`；`EXPERIENCE.md:73-92`、`192-212`）。

`AD-3` 保证图谱与受影响 Findings 同事务更新，`AD-7` 让服务负责“新增/既有风险分类”，`AD-10` 将可定位诊断交给 Problems（`ARCHITECTURE-SPINE.md:68-72`、`92-96`、`110-114`）。但没有说明：

- “新增”是相对前一 revision、当前编辑会话、working tree、staged diff 还是指定 Git base；
- 同一 Finding 在 Current Context、Findings、Changes 中的稳定 ID 与生命周期；
- resolved 是删除、状态转换还是历史事件；
- 项目级循环等无单一源码范围的 Finding 如何与 Problems 中的局部证据关联。

**分歧风险：** Current Context 与 Changes 会对同一 Finding 给出不同但未标明作用域的“新增”标签；CLI `check`、`impact` 和插件计数也可能不一致。

**建议：** 将 Finding 分类定义为显式的 `comparisonScope/baselineRevision/baseRef` 结果，而不是一个无上下文布尔值；固定 Finding 稳定身份、证据与定位结构。UI 折叠顺序和具体文案仍留给 UX。

### 5. [高] 导出默认隐私和预览失败语义未被架构绑定

UX 明确要求 Export Preview 默认只含相对路径、关系、边界和 Findings，不含源码；显示本地生成、范围、文件数、目标位置与敏感内容说明；失败时保留预览并允许重试或复制；AI 上下文可移除无关聚合模块（`DESIGN.md:206-208`；`EXPERIENCE.md:25-38`、`73-92`、`203-223`）。

`AD-13` 已固定稳定 CLI envelope、JSON/Markdown、stdout/stderr 和相对路径，`AD-14` 固定默认不上传，`AD-16` 禁止日志/遥测包含源码（`ARCHITECTURE-SPINE.md:128-150`）。然而这些规则没有禁止**导出内容默认包含源码**；`AD-16` 的禁令只约束日志和遥测。也没有规定 preview 与 write/copy 的分离、失败后预览保留或用户显式扩大敏感范围。

**分歧风险：** 导出适配器可以在默认 Markdown/AI 上下文中包含源码而仍符合当前 AD，直接违背 UX 的信任承诺；CLI 与 Webview 也可能采用不同的默认内容。

**建议：** 在导出相关 AD 中固定单一 `ExportPlan/ExportArtifact` 契约：默认结构数据且无源码、相对路径、本地生成、携带 scope/revision/confidence；任何源码包含必须显式选择并在预览中标识。生成、预览、复制/写出应分阶段，使目标写入失败不销毁已生成 artifact。

## 其他对账结果

### 信息架构与宿主表面

核心宿主分工与 UX 一致：

- Activity Bar/TreeView 负责状态入口、导航与摘要；
- Webview Editor 负责 Overview、Current Context、Changes 的图和等价列表；
- Problems 只接收可定位诊断；
- Status Bar 只显示低干扰单行状态；
- 所有操作均注册 Command Palette。

但 `AD-10` 没有明确以下 surface 的归属：Getting Started/Index Status、Entity Details、Export Preview、Settings & Rules。这里不是要求新增更多包，而是避免 extension 团队和 webview 团队分别实现一套。建议在宿主责任表中明确：哪些是 Webview 内 route/panel，哪些调用 VS Code 原生 Settings、文本编辑器、Quick Pick 或 Output/Logs。

### 图/列表等价与主题

这是当前承接最完整的部分。`AD-7` 的渲染器无关 ViewModel 加 `AD-15` 的任务等价，能够阻止 Cytoscape JSON、像素坐标和颜色语义成为唯一真相。`AD-15` 对主题、字体、焦点、高对比和减少动态效果的要求也正确保持在架构不变量层；颜色 token、线型、阴影和间距继续由 `DESIGN.md` 管理即可。

仍建议在 ViewModel 契约测试中证明图与列表对相同 revision、scope、filter 产生相同节点/边/Finding/截断语义，而不是只做视觉快照。

### 响应式

UX 的断点本身标为假设，不必写入架构 AD。需要上升为不变量的是降级原则：窄宽度默认可访问列表，详情从并排降为可打开面板/下方区域，侧边栏不渲染完整图。当前只有最后一项被 `AD-10` 间接覆盖。建议将高层降级原则加入 `AD-15`，具体 `900/600/360px` 由实施时基于内容溢出测试校准。

## 冲突与漏项分类

### 直接冲突

无。

### 潜在解释冲突

1. `AD-10` 的“Webview 只持有视觉状态”如果没有状态镜像协议，容易与 UX 的“图/列表/详情共享选择、范围、筛选、固定状态”形成实现层冲突。正确解释应是 extension 持有语义状态权威，Webview 可交互地产生并镜像该状态。
2. `AD-7` 的“新增/既有风险分类”缺少 comparison scope；保存级新增和 PR 级新增不应共享一个无上下文布尔字段。

### 可留在实施层的 UX 细节

- 具体颜色 fallback、4px 间距、圆角、阴影和节点两行截断；
- 暂定 `Ctrl+Alt+G` / `Ctrl+Alt+P`，需先检查 VS Code 冲突；
- `900/600/360px` 暂定断点和 24×24 指针目标数值；
- 具体中文文案与视觉组件排版。

这些不应膨胀架构脊柱，但应由实施指南、组件契约和可访问性验收测试承接。

## 定稿前建议的最小补强顺序

1. 固定统一 UI 状态 envelope、完整性与慢/失败回退语义。
2. 固定 semantic/visual state 所有权、恢复顺序和 revision patch 连续性。
3. 补强 `AD-15` 的键盘、屏幕阅读器和窄宽度降级不变量。
4. 明确 Finding 的稳定身份、证据结构与 comparison scope。
5. 明确 ExportPlan/Artifact 的无源码默认、显式敏感内容选择和预览保留。

完成这五项后，UX 的主要跨模块承诺即可由架构约束；其余视觉与交互细节可以安全留给 `DESIGN.md`、`EXPERIENCE.md` 和实施说明。
