---
workflowType: research
research_topic: 项目代码图谱项目
research_goals: 从领域、市场、技术三个方面评估项目价值、竞品格局、实现路径和 MVP 优先级
date: 2026-07-08
source_verification: true
skills:
  - bmad-domain-research
  - bmad-market-research
  - bmad-technical-research
---

# 项目代码图谱项目三维研究

## 执行摘要

结论：这个项目值得继续推进，但定位要从“代码可视化工具”上移到“IDE 内的结构感知与架构治理层”。单纯展示力导向图很容易变成视觉噪声；真正的机会在于让开发者在写代码、看 PR、重构、接手陌生模块时，持续知道“我在哪里、影响哪里、是否破坏了结构边界”。

最佳切入点不是全语言、全调用图、全量大图，而是 **TypeScript/JavaScript 项目的本地增量图谱 + VS Code 插件 + 当前文件聚焦视图 + 架构规则/变更影响分析**。这条路径能同时验证用户价值、技术可行性和市场差异化。

置信度：中高。代码理解、代码导航、依赖分析、架构管理已经被 Sourcegraph、GitHub、JetBrains、Lattix、SonarQube、CodeSee/GitKraken 等产品验证；但“聚焦编码上下文的动态图谱”仍有明显体验空位。市场规模公开数据分散且很多来自付费报告，本报告不把 TAM 数字作为核心判断依据。

## 1. 领域研究

### 1.1 领域边界

项目所在领域不是单一“图谱可视化”，而是四个领域的交叉：

- 代码智能：搜索、符号、定义、引用、调用关系、语义导航。
- 静态分析：依赖、循环、复杂度、违反规则、技术债。
- 架构治理：模块边界、分层约束、架构漂移、依赖规则。
- 开发者体验：接手代码、重构、PR 审查、AI 生成代码后的结构控制。

这个领域的根问题是：项目代码结构会随时间偏离设计意图，而传统目录树、搜索、文档和 review 都不足以实时呈现结构变化。Sonar 在架构管理相关材料中直接把这类问题描述为“真实依赖结构”和“预期架构”之间的偏离，并把发现、形式化、优先级和修复作为工作流的一部分。参考：[Sonar architecture management](https://www.sonarsource.com/solutions/architecture/)、[SonarQube architecture blog](https://www.sonarsource.com/blog/code-architecture-management-general-availability-in-sonarqube/)。

### 1.2 为什么现在值得做

有三个趋势正在推高需求：

1. AI 写代码让局部产出更快，但结构漂移风险更高。Stack Overflow 2025 调查相关分析显示，AI 使用/计划使用比例很高，但信任度下降，开发者担心准确性和理解成本。参考：[Stack Overflow AI trust gap](https://stackoverflow.blog/2026/02/18/closing-the-developer-ai-trust-gap/)、[2025 Developer Survey AI](https://survey.stackoverflow.co/2025/ai)。
2. 大代码库和多模块项目仍然让开发者损失大量时间。Atlassian/DX 报告把技术债、文档不足、上下文切换列为开发体验痛点。参考：[Atlassian DevEx 2024](https://www.atlassian.com/blog/development/developer-experience-report-2024)、[DX State of Developer Experience 2024](https://getdx.com/report/state-of-developer-experience-report/)。
3. AI agent 需要更可靠的代码上下文。GitHub 对 MCP 的文档强调通过开放协议把外部系统上下文接入 LLM 工具。代码图谱如果能作为 MCP/上下文服务暴露，会比普通 README 或全文检索更适合约束 AI 修改范围。参考：[GitHub MCP docs](https://docs.github.com/en/copilot/concepts/context/mcp)。

### 1.3 领域机会

已有工具大多解决其中一块：

- GitHub/Sourcegraph 强在搜索、导航、跨仓库代码理解。
- JetBrains/IDE 强在本 IDE 生态内的模块图、UML、调用导航。
- Lattix、Structure101、Sonar 强在架构治理和依赖规则。
- CodeSee/GitKraken Codemaps 强在代码可见性、重构沟通和 onboarding。
- Madge、dependency-cruiser、Doxygen/Graphviz 等开源工具强在局部依赖图生成。

你的项目机会在于把它们未充分合并的部分做成一个连续体验：

> 本地图谱索引 + 当前上下文自动聚焦 + 分层视图 + 变更影响分析 + 架构规则 + AI 上下文输出。

### 1.4 领域风险

- 如果只做“画图”，会被现有代码地图和 IDE 图功能压住。
- 如果一开始追求精确调用图，动态语言和框架魔法会拖慢项目。
- 如果图谱过大，用户会迅速放弃。
- 如果无法嵌入 IDE/PR 工作流，用户不会专门打开一个独立图谱工具。

领域侧建议：产品语言不要叫“代码图谱可视化工具”，而应叫“代码结构感知与影响分析工具”。

## 2. 市场研究

### 2.1 目标用户分层

优先用户不是所有开发者，而是下面几类高频痛点人群：

| 用户 | 主要场景 | 付费意愿 | 关键价值 |
| --- | --- | --- | --- |
| 中大型前端/全栈团队 | TypeScript 项目、模块边界、重构、PR | 中 | 减少改动风险和 onboarding 成本 |
| 架构师/Tech Lead | 分层约束、循环依赖、架构漂移 | 高 | 把架构规则落到代码和 CI |
| 维护遗留系统的团队 | 看不懂依赖、重构风险高 | 高 | 影响分析、热点识别、重构切片 |
| AI 编程重度团队 | AI 改动范围失控、上下文不足 | 中高 | 给 AI 提供结构化上下文和边界 |
| 安全/合规团队 | 供应链、依赖、敏感代码流动 | 中 | 可追溯、可审计、局部规则检查 |

第一阶段最适合选 **中大型 TypeScript/JavaScript 团队**，原因是生态大、依赖关系相对容易静态提取、VS Code 用户多、Node 工具链天然适合做本地 CLI/插件。

### 2.2 用户痛点

高优先级痛点：

- 接手陌生代码时不知道入口、模块职责和调用链。
- 做重构时不知道上游/下游影响范围。
- 新增代码时无意中打破分层或引入循环依赖。
- PR 审查只看到 diff，不知道结构变化。
- 文档过期，目录结构看起来清楚但真实依赖已经混乱。
- AI 生成代码可以运行，但可能破坏模块边界。

CodeSee 的产品材料明确把 codebase maps 定位为目录、文件依赖和代码变更的即时地图，用于理解、修改、重构和 onboarding。参考：[CodeSee codebase maps](https://www.codesee.io/codebase-maps)、[GitKraken Codemaps](https://www.gitkraken.com/features/code-dependency-mapping)。

### 2.3 竞品格局

#### Sourcegraph

Sourcegraph 的强项是跨仓库搜索、代码导航、符号/commit/diff 搜索和企业级部署。它能帮助“找代码、理解代码、跨仓库导航”，但不是以“局部结构图谱 + 架构边界治理”为主要体验。参考：[Sourcegraph Code Search](https://sourcegraph.com/docs/code-search)。

#### GitHub 与 Copilot

GitHub 已内置代码导航，支持定义、引用、符号等能力，并基于 tree-sitter 提取信息。Copilot code review 和 agent 方向会继续吞掉一部分“解释代码/审查代码”需求。参考：[GitHub code navigation](https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github)、[GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)。

差异化空间：GitHub 更偏平台级导航和 AI 辅助；你的项目应做“工作区本地、即时、可解释、可约束”的结构感知。

#### JetBrains

JetBrains 已提供模块依赖图、UML/依赖分析和循环依赖提示，尤其适合 Java/JVM 生态。参考：[IntelliJ IDEA module dependency diagrams](https://www.jetbrains.com/help/idea/project-module-dependencies-diagram.html)。

差异化空间：VS Code 跨语言生态、轻量本地索引、AI context 输出、PR/diff 结构变化。

#### Lattix

Lattix 是成熟架构治理工具，强调 DSM、复杂系统依赖、架构可视化和规则执行。参考：[Lattix products](https://www.lattix.com/products/)、[Lattix architecture discovery](https://docs.lattix.com/lattix/whyUseLattixArchitect/Architecture_Discovery.html)。

差异化空间：Lattix 更偏企业架构治理；你的项目可以从轻量、IDE 原生、开发者日常使用切入。

#### SonarQube

SonarQube 正在把架构管理能力纳入质量门禁和 CI/CD，强调真实依赖、组件结构、规则违反和架构漂移。参考：[SonarQube architecture overview](https://docs.sonarsource.com/sonarqube-server/2025.3/design-and-architecture/overview)、[Sonar architecture solution](https://www.sonarsource.com/solutions/architecture/)。

差异化空间：Sonar 强在质量平台和 CI；你的项目应强在 IDE 内即时反馈和交互探索。

#### Understand by SciTools

Understand 覆盖代码导航、交叉引用、调用树、依赖分析、图形、架构组织、度量和合规检查。参考：[SciTools Understand features](https://scitools.com/features)。

差异化空间：成熟但偏重桌面专业工具；你的项目可以做更现代的 IDE 插件体验和 AI 集成。

#### CodeSee/GitKraken

CodeSee 验证了“代码可见性/地图/onboarding/重构沟通”的需求，并于 2024 年被 GitKraken 收购。参考：[GitKraken acquires CodeSee](https://www.gitkraken.com/blog/gitkraken-launches-devex-platform-acquires-codesee)、[CodeSee maps for collaboration](https://www.codesee.io/collaboration)。

启示：需求真实，但单独的代码地图产品商业化并不轻松。要避免只停留在“漂亮地图”，必须绑定 IDE、PR、CI、AI agent 或团队治理工作流。

### 2.4 市场切入建议

MVP 目标用户：VS Code + TypeScript/JavaScript 中大型项目团队。

推荐产品包装：

- 免费层：本地 CLI + VS Code 当前文件依赖图 + 循环依赖检测。
- Pro 层：PR 影响分析、架构规则、历史趋势、团队共享图谱。
- Enterprise 层：私有部署、策略门禁、审计、SSO、合规报告、AI/MCP 上下文服务。

早期不要卖“全项目大图”，要卖这些结果：

- 打开一个文件，立即知道它属于哪个模块、依赖谁、谁依赖它。
- 保存一次改动，立即知道是否新增跨层依赖或循环依赖。
- 打开 PR，立即看到结构变化和风险路径。
- 问 AI 修改某功能时，能把相关模块边界作为上下文传进去。

## 3. 技术研究

### 3.1 推荐总体架构

建议采用本地优先架构：

```text
VS Code Extension
  -> Webview/TreeView UI
  -> Local Graph Service
      -> Indexer Workers
      -> Parser/LSP/SCIP Adapters
      -> Graph Store
      -> View Query API
      -> Rules Engine
      -> Optional MCP Server
```

关键原则：

- 图谱服务本地运行，源码默认不出机器。
- 索引与展示分离，UI 不直接处理全量图。
- 边必须带 provenance 和 confidence，区分 import、AST、LSP、SCIP、启发式推断。
- 所有视图按预算返回子图，例如最多 100 个节点、200 条边。

### 3.2 代码分析栈

#### Tree-sitter

Tree-sitter 适合作为基础语法层，因为它是增量解析库，能在文件编辑时高效更新语法树，并可嵌入编辑器。参考：[Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/)。

适用：

- 提取 import/export。
- 提取类、函数、方法、组件、路由等符号。
- 做编辑中快速预览。

限制：

- 只能提供语法层信息。
- 对类型解析、动态调用、跨文件精确引用不够。

#### LSP

LSP 能复用语言服务器已有能力，包括定义、引用、调用层级、类型层级、工作区符号等。参考：[LSP 3.18 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)。

适用：

- 当前文件附近的精确引用。
- 调用层级和类型层级。
- 多语言复用。

限制：

- 不同语言服务器能力不一致。
- 批量索引性能和稳定性需要封装。

#### SCIP

SCIP 是语言无关的代码智能索引协议，可用于 go to definition、find references、find implementations，并已有多语言 indexer。参考：[SCIP repository](https://github.com/sourcegraph/scip)。

适用：

- 中后期做跨语言离线索引。
- 将语义索引和图谱数据模型解耦。

建议：MVP 可以不直接实现 SCIP，但数据模型应预留 `source=scip`。

#### Code Property Graph

CPG 把 AST、控制流、数据流等统一成有向、带标签、带属性的多重图。Joern 文档明确说明 CPG 用于在大型代码库中挖掘代码模式。参考：[Joern Code Property Graph](https://docs.joern.io/code-property-graph/)。

适用：

- 后期做安全/数据流/复杂调用分析。
- 不适合 MVP 第一阶段直接全量引入，容易过重。

### 3.3 图谱数据模型

推荐核心实体：

```text
Workspace
Package / Directory
File
Symbol
ExternalPackage
Commit / ChangeSet
Rule
Finding
```

推荐核心边：

```text
contains
imports
exports
references
calls
extends
implements
depends_on
changed_by
violates
owns
```

每条边至少包含：

```text
source_id
target_id
edge_type
confidence
provenance
language
file_range
last_seen_at
```

这个设计能支撑你在 `想法.md` 中提到的“目录联系不是单纯目录结构，而是由目录内代码联系聚合得到”的要求。

### 3.4 存储建议

MVP 建议用 SQLite，而不是一开始上复杂图数据库：

- `nodes` 表存实体。
- `edges` 表存关系。
- `symbol_index` 使用 FTS5 做符号/路径检索。参考：[SQLite FTS5](https://www.sqlite.org/fts5.html)。
- 用递归 CTE 做有限深度邻域查询。参考：[SQLite recursive CTE](https://www.sqlite.org/lang_with.html)。

理由：

- 本地部署简单。
- 事务、索引、迁移、文件分发成熟。
- 图谱查询主要是有限深度邻域、聚合、过滤，不一定需要完整图数据库。

注意：Kuzu 曾是很适合嵌入式图数据库的候选，但其 GitHub 仓库显示已在 2025-10-10 归档，只适合谨慎评估，不建议作为 MVP 核心依赖。参考：[Kuzu GitHub](https://github.com/kuzudb/kuzu)。

### 3.5 可视化选型

推荐多视图，不推荐只用力导向图。

| 视图 | 适合场景 | 建议技术 |
| --- | --- | --- |
| 力导向图 | 当前文件邻域、探索关系 | Cytoscape.js 或 Sigma.js |
| 分层 DAG | 架构层级、依赖方向 | ELK / Dagre + 渲染层 |
| 依赖矩阵 DSM | 大型模块关系、循环依赖 | 自定义 Canvas/WebGL/表格 |
| Treemap/目录聚合 | 项目概览、热点分布 | D3 |
| PR 影响图 | 本次变更影响路径 | Cytoscape.js |

Cytoscape.js 是图论网络可视化与分析库，支持布局、选择器、图算法和 JSON 序列化，适合 MVP。参考：[Cytoscape.js](https://js.cytoscape.org/)。

Sigma.js 使用 WebGL，适合数千节点/边的大图浏览，但图算法由 Graphology 承担。参考：[Sigma.js](https://www.sigmajs.org/)。

D3 force 适合自定义力导向布局和特殊图形，但如果要做完整图交互，工程量更高。参考：[D3 force](https://d3js.org/d3-force)。

ELK 适合自动布局、层级节点和端口，但只负责计算布局，不负责渲染。参考：[Eclipse ELK](https://eclipse.dev/elk/)。

### 3.6 IDE 集成

VS Code 插件是最合理第一入口：

- Webview 可承载复杂图谱 UI，但 VS Code 官方也提醒 Webview 资源较重，应在确有必要时使用。参考：[VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)。
- 使用编辑器事件跟踪当前文件、光标、selection。
- 使用 FileSystemWatcher 或外部 watcher 监听变更。参考：[VS Code API](https://code.visualstudio.com/api/references/vscode-api)。
- 大项目可集成 Watchman。Watchman 会等待文件系统 settle 后再触发，适合避免 git pull 期间频繁重建。参考：[Watchman](https://facebook.github.io/watchman/)、[Watchman trigger](https://facebook.github.io/watchman/docs/cmd/trigger.html)。

### 3.7 自动更新策略

建议分四层：

1. 编辑中：只做内存预览，不落盘。
2. 保存后：增量解析当前文件，更新相关边。
3. 文件系统稳定后：批量处理变更队列。
4. Git 操作后：根据 changed files 触发局部重建，必要时全量重建。

关键机制：

- debounce：避免每次键入都更新。
- settle window：避免 git pull 中途更新。
- content hash：只有文件内容变化才重算。
- reverse index：快速找“谁依赖我”。
- stale marker：让 UI 知道图谱可能过期。

### 3.8 架构规则与指标

第一阶段值得做的规则：

- 循环依赖。
- 跨层依赖，例如 `ui -> data -> infra` 只能单向。
- 禁止某目录引用某目录。
- 扇入/扇出过高。
- PR 新增依赖边。
- 文件移动后残留旧依赖。

第一阶段值得做的指标：

- 模块依赖数量。
- 传入/传出依赖。
- 不稳定性：outgoing / (incoming + outgoing)。
- 变更热点：近期 commit 数。
- 影响半径：N 跳内受影响节点数。
- 循环簇大小。

这些指标比“代码行数/复杂度”更贴合你的原始目标：控制结构、高内聚、低耦合。

### 3.9 安全与合规

源码、依赖图和调用图都可能泄露业务结构，因此默认策略应是：

- 本地优先。
- 默认不上传源码和图谱。
- 可配置排除路径。
- 图谱文件可加密或放入 `.gitignore`。
- 企业版提供私有部署、审计日志和访问控制。

如果后续进入企业市场，需要对齐 SSDF、SLSA、DevSecOps 等框架的语言和证据链。参考：[NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)、[SLSA](https://slsa.dev/)、[OWASP DevSecOps Guideline](https://owasp.org/www-project-devsecops-guideline/latest/)。

## 4. 与原始想法的逐项判断

### 4.1 “使用力导向图”

部分合理。力导向图适合局部探索，不适合作为唯一视图。应采用“力导向图 + 分层图 + 依赖矩阵 + 目录聚合图”的组合。

### 4.2 “初始状态展示包/代码目录结构图谱”

合理，但命名建议改为“项目结构概览”。它不应该是普通目录树，而应显示目录之间的真实依赖强度、循环依赖、热点模块和过期状态。

### 4.3 “自动追踪用户聚焦层级”

方向正确，但必须提供“固定当前视图”能力。否则用户切文件时图不断变化，会丢失上下文。

### 4.4 “打开代码文件时自动展开相关图谱，只展示 2 层”

不建议硬编码 2 层。推荐使用“节点预算 + 相关性排序”：

- 默认 1 跳。
- 用户展开后显示 2 跳。
- 超过节点预算则折叠为目录/模块。
- 直接依赖、反向引用、同目录优先。

### 4.5 “分层存储图谱数据”

完全正确。但实现上不是多个互不相关的文件，而是统一图模型 + 多级 materialized view：

- 项目视图。
- 目录/包视图。
- 文件视图。
- 符号视图。
- PR/diff 视图。

## 5. 推荐 MVP

### MVP 目标

验证一个核心命题：

> 在开发者打开/修改文件时，局部代码图谱能否比搜索、目录树和静态文档更快帮助他判断结构影响。

### MVP 范围

- 语言：TypeScript / JavaScript。
- 入口：VS Code 插件 + CLI。
- 图谱：目录、文件、import/export、package dependency。
- 视图：项目概览、当前文件邻域、循环依赖、PR 变更影响。
- 更新：保存后增量更新，手动全量 rebuild。
- 规则：循环依赖、禁止目录引用、层级依赖规则。

### 不做

- 不做全语言。
- 不做精准运行时调用图。
- 不做全量超大图默认展示。
- 不做云端团队协作。
- 不做 AI 自动重构。

### 成功指标

- 打开项目后 60 秒内生成第一版结构概览。
- 打开文件后 300ms 内显示缓存图谱，后台刷新。
- 修改文件保存后 2 秒内更新局部依赖。
- 能准确识别 80% 以上 import/export 依赖。
- 能发现循环依赖和跨层规则违反。
- 用户能在 3 分钟内回答“改这个文件会影响哪里”。

## 6. 技术路线

### 阶段 0：研究原型

- CLI 扫描 TS/JS 项目。
- 生成 SQLite 图谱。
- 输出 JSON 子图。
- 用 Cytoscape.js 展示当前文件邻域。

### 阶段 1：VS Code 插件 MVP

- 监听当前打开文件。
- 展示文件邻域图。
- 支持点击节点跳转文件。
- 显示循环依赖列表。
- 支持手动 rebuild。

### 阶段 2：架构规则

- 添加 `.codegraph/rules.yaml`。
- 支持目录层依赖约束。
- 保存/PR 时提示新增违反。
- 输出 CI 命令。

### 阶段 3：PR 与 AI context

- 根据 git diff 生成变更影响图。
- 输出 Markdown review 摘要。
- 增加 MCP server，把相关子图提供给 AI 工具。

## 7. 最终建议

1. 把项目定位为“代码结构感知工具”，不要定位为“代码图谱展示工具”。
2. MVP 从 TS/JS + VS Code 开始，先做 import/export 文件依赖和目录聚合。
3. 采用 SQLite + Tree-sitter + LSP 的组合，SCIP 和 CPG 作为后续增强。
4. UI 必须多视图：力导向图只做局部探索，架构和大项目要用分层图/矩阵。
5. 自动更新必须做 debounce、settle、hash 和 stale 状态，否则大项目会卡。
6. 早期卖点聚焦四个场景：接手代码、重构、PR 影响、AI 结构边界。
7. 不要一开始做云服务；本地优先更容易获得开发者信任。

## 8. 关键来源

- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)
- [Language Server Protocol 3.18](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)
- [SCIP Code Intelligence Protocol](https://github.com/sourcegraph/scip)
- [Joern Code Property Graph](https://docs.joern.io/code-property-graph/)
- [Cytoscape.js](https://js.cytoscape.org/)
- [Sigma.js](https://www.sigmajs.org/)
- [D3 force](https://d3js.org/d3-force)
- [Eclipse ELK](https://eclipse.dev/elk/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [Watchman](https://facebook.github.io/watchman/)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [Sourcegraph Code Search](https://sourcegraph.com/docs/code-search)
- [GitHub code navigation](https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github)
- [JetBrains module dependency diagrams](https://www.jetbrains.com/help/idea/project-module-dependencies-diagram.html)
- [SciTools Understand features](https://scitools.com/features)
- [Lattix products](https://www.lattix.com/products/)
- [Sonar architecture solution](https://www.sonarsource.com/solutions/architecture/)
- [CodeSee codebase maps](https://www.codesee.io/codebase-maps)
- [GitKraken acquires CodeSee](https://www.gitkraken.com/blog/gitkraken-launches-devex-platform-acquires-codesee)
- [Stack Overflow 2025 Developer Survey](https://survey.stackoverflow.co/2025)
- [GitHub Octoverse 2025](https://octoverse.github.com/)
- [Atlassian State of Developer Experience 2025](https://www.atlassian.com/teams/software-development/state-of-developer-experience-2025)
- [NIST SSDF SP 800-218](https://csrc.nist.gov/pubs/sp/800/218/final)
- [SLSA](https://slsa.dev/)
- [OWASP DevSecOps Guideline](https://owasp.org/www-project-devsecops-guideline/latest/)
