---
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - prds/prd-bmad-2026-07-09/prd.md
  - prds/prd-bmad-2026-07-09/addendum.md
  - architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
  - architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md
  - ux-designs/ux-bmad-2026-07-13/DESIGN.md
  - ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
  - sprint-change-proposal-2026-07-15.md
  - implementation-readiness-report-2026-07-16.md
  - sprint-change-proposal-2026-07-16.md
  - implementation-readiness-report-2026-07-16-rerun.md
  - implementation-readiness-report-2026-07-16-rerun-2.md
  - sprint-change-proposal-2026-07-16-rerun-2.md
---

# bmad - Epic 与 Story 拆分

## 概述

本文档汇总 bmad 的完整需求清单，并将 PRD、UX 设计契约、架构约束、已批准 Sprint 变更提案和实施就绪纠偏要求拆分为可实施、可验收的 Epic 与 Story。本次获批修订保持 5 个 Epic 和 FR-1 至 FR-23 不变，将 4 个过大 Story 拆为 8 个端到端 Story，并新增 1 个版本化产品验证 Story；总数为 61。现有 Story ID 保持稳定，Story 依赖只由文末 `StoryDependencyDagV1` 定义；正文顺序和各 Story 的自然语言依赖说明仅用于阅读与解释，不产生隐式依赖。

## 需求清单

### 功能需求

FR-1: 用户可以通过 VS Code 命令或 CLI 初始化当前工作区图谱；系统生成可查询图谱，识别常见 npm、Yarn、pnpm workspace package 边界，并在无受支持文件或 workspace 识别降级时给出可操作状态和索引摘要。

FR-2: 系统必须提取 TypeScript/JavaScript 的 import/export、外部包、Node 内置模块和跨 workspace package 关系，为每条关系记录来源、置信度、语言、范围和检测时间；BasicSymbolV1 仅包含顶层可寻址声明，不确定关系不得伪装为精确依赖。

FR-3: 用户保存受支持文件后，系统必须通过 debounce/settle、内容 hash 去重和批处理完成本地增量更新，并明确展示 current、refreshing、stale、partial、failed 或 cancelled 状态。

FR-4: 系统必须在首次 Analyzer/rebuild 前应用 BuiltinIgnoreV1 和有效 EffectiveIgnoreSnapshotV1；用户通过 .codegraphignore 配置额外排除或重新纳入路径，命中内容不进入图谱、规则检查、workspace package 聚合或成功指标。

FR-5: 系统必须为图谱 schema、节点、边、Evidence、图谱状态和 Findings 提供稳定 ID、独立版本、revision 与过期状态；旧数据可以事务化迁移或提示保留故障副本后重建。

FR-6: 用户可以查看以目录、模块或 workspace package 聚合的项目结构概览，包括依赖方向、确定性依赖强度、循环风险、热点、完整性和图谱更新时间，并能下钻到文件或局部邻域。

FR-7: 用户打开代码文件时，系统自动展示当前文件的一跳依赖邻域，区分直接依赖、反向依赖、workspace package、外部 npm 包和 Node 内置模块；默认预算为 100 个节点、200 条边，超限时按服务端投影聚合并支持受预算限制的展开。

FR-8: 系统默认跟随当前编辑器文件更新图谱，并允许用户在当前 extension-host 会话中固定和解除固定视图；Webview reload 可恢复，窗口 reload、VS Code 重启或重新打开工作区后清除。

FR-9: 用户可以从节点或关系打开文件、目录或 BasicSymbolV1 位置，并查看路径、实体类型、入边、出边、来源、置信度、更新时间和 Findings；目标缺失、移动或越界时保留证据并提示重新索引。

FR-10: MVP 至少提供局部关系图和任务等价的结构列表；Findings、循环依赖、变更影响和 PR 摘要必须可文本阅读，核心任务不能只依赖画布、颜色、形状或动画。

FR-11: 系统必须使用统一 CycleProjectionKernelV1 检测文件级、目录级和 workspace package 级循环依赖，列出确定性代表路径，区分新增、既有、已解决或不可比较循环，并提供可定位证据。

FR-12: 用户可以通过版本化 .codegraph/rules.yaml 声明 forbidden-dependency、layer-order 和 no-cycle 三类规则；系统严格校验 ID、类型、severity、scope、路径 glob、ignore 和未知字段，其中 rules ignore 只裁剪规则评估范围，不改变规范图谱或索引统计。

FR-13: 保存变更引入结构风险时，IDE 必须显示包含稳定规则 ID、规则名、严重级别、实际依赖边、期望约束、相关路径、检测时间和新增/既有状态的 Finding，并允许跳转到源码或规则配置。

FR-14: 系统必须解释风险的实际依赖方向、期望规则、循环路径、证据来源、置信度、比较基线和数据完整性，不得只返回错误码、模糊告警或未经支持的确定性结论。

FR-15: 用户可以通过本地 CLI 执行规则检查，获得人类可读与 schemaVersion: 1 JSON 输出；存在 error 级 active Finding 时返回退出码 1，只有 warning 时默认成功，配置无效、内部失败、协议不兼容和取消使用稳定退出码。

FR-16: 用户可以通过 CLI 或 VS Code 命令选择 working tree、staged 或指定 base ref 作为变更集合；系统规范化完整 Git 基线、识别新增、删除、修改和移动文件，并在 Git 不可用或输入越界时提供可操作诊断。

FR-17: 系统必须通过唯一的 application/impact 能力输出新增/删除依赖边、受影响目录或 package、循环变化、规则风险及其比较状态，并使用 ImpactVerdictV1 和 ImpactRankV1 区分本次新增、历史既有、已解决与不可比较风险。

FR-18: 用户可以生成适合复制到 PR review 的 Markdown 摘要，包含统一 verdict、主要风险、关键路径、边与循环变化和建议复查文件；路径使用相对 POSIX 格式，默认 structure-only 且不含源码。

FR-19: CLI、插件和结构影响分析默认不上传源码、diff、图谱、规则或导出内容；遥测默认关闭，只能显式 opt-in 匿名允许列表事件，用户可立即关闭并查看或安全清理 OS 用户缓存中的本地数据。

FR-20: CLI 必须提供 rebuild、query、check、impact、export、status、doctor 和 cache 公共命令，并复用统一的本地图谱、规则、影响分析和导出合同。

FR-21: 插件和 CLI 必须通过同一 graph-service 获取 Overview、邻域、Findings、状态和导出结果；服务返回渲染器无关、预算内、带 graph/findings/status revision 的结构化模型，不暴露数据库或渲染库内部格式。

FR-22: 系统必须显示服务生命周期、图谱可用性、新鲜度、完整性、Job 阶段和进度；失败、取消、断线、epoch 变化或缓存损坏时保留可用结果，提供错误摘要、日志位置、重连或重建恢复动作。

FR-23: 用户可以导出受预算限制的当前文件邻域、实体、依赖边、规则、Findings、来源、置信度、revision 和更新时间，用于 AI 工具或人工沟通；默认不含源码，显式源码授权仅对当前请求有效。

### 非功能需求

NFR-1: 标准验收项目不超过 5,000 个受支持源码文件、500,000 LOC 和 50 个 workspace package；内置及用户索引排除路径不计入规模。

NFR-2: 标准参考环境为 8 个逻辑 CPU、16 GB 内存和 SSD。

NFR-3: 在标准验收项目和参考环境下，clean cache 首次概览 p95 不超过 60 秒。

NFR-4: 打开文件后，已提交 warm cache 的邻域结果显示 p95 不超过 300ms。

NFR-5: 从宿主保存动作到对应 graph/Findings revision 可见的 p95 不超过 2 秒。

NFR-6: 默认邻域单次查询和渲染预算上限为 100 个节点、200 条边。

NFR-7: 超出标准规模时可以不承诺相同 SLA，但索引、查询和布局不得阻塞编辑器，必须持续显示范围和进度并允许取消或重建。

NFR-8: 索引、查询、规则计算和复杂布局不得阻塞 VS Code extension host；布局必须在 Web Worker 等非主线程环境执行。

NFR-9: git pull、分支切换、依赖安装、批量生成文件和 watcher 丢事件不得造成无限重建或无界 Job 堆积；系统必须通过 settle、hash 去重和有界 reconciliation 收敛。

NFR-10: 构建失败、刷新、取消或部分完成期间必须保留可用缓存，并用 stale、partial、failed 或 cancelled 准确标记，不得回滚已提交 revision。

NFR-11: 系统必须能够从损坏缓存或迁移失败中恢复，保留故障副本、可追踪诊断和安全重建路径。

NFR-12: 源码、图谱、diff、结构摘要、导出产物和日志默认仅在本地处理与保存。

NFR-13: 本地图谱服务只能通过当前用户可访问的命名管道或 Unix Domain Socket 通信，不监听 TCP，并在业务请求前校验 token、workspace-key 和协议版本。

NFR-14: 用户必须能够查看并安全清理本地图谱、缓存、日志、锁和服务元数据，清理操作不得触碰源码或仓库策略文件。

NFR-15: 遥测默认关闭；即使显式 opt-in，也只能收集匿名功能事件、耗时、计数和错误分类，不得包含源码、完整路径、符号、diff、图谱或规则内容。

NFR-16: 云端同步、团队共享、远程服务和 MCP server 必须作为独立能力另行设计和授权，不进入 MVP 主路径。

NFR-17: Findings、循环依赖、结构关系、变更影响和 PR 摘要必须具有与图形任务等价的文本呈现；屏幕阅读器必须可获得节点、边、来源和置信度语义。

NFR-18: 节点、边、严重级别、置信度、变更状态和 stale 状态必须使用一致且非颜色唯一的视觉语义；人类可读界面以 WCAG 2.2 AA 为目标并适配高对比主题。

NFR-19: 所有核心任务无需鼠标即可完成，焦点顺序可预测且可见；ContextLock 与空间记忆语义一致，交互目标不小于 24×24 CSS px。

NFR-20: 空状态、失败、取消、超预算、无效配置和 200% 字号场景必须保留核心信息、提供下一步，并服从 VS Code 的减少动态效果设置。

NFR-21: 图谱持久模型、查询合同和导出合同不得绑定 Cytoscape.js 或其他具体渲染库格式。

NFR-22: 节点和边必须使用稳定 ID，并记录来源、置信度、schema/version、revision 和更新时间。

NFR-23: 分析器、存储、查询、规则、宿主和渲染层必须保持可替换边界，以支持后续语言、SCIP、矩阵视图或 MCP 扩展。

NFR-24: MVP 支持 Windows x64、macOS x64、macOS arm64 和 Linux x64；CLI 要求 Node 24 LTS，平台 VSIX 携带经验证的 Node 24 LTS 运行时，VS Code 最低版本为 1.125.0，并验证最低、最新稳定和前一稳定版本。

NFR-25: 每个受支持组合必须通过新安装、离线启动、升级、降级、卸载和缓存保留/清理验收；协议或 schema 不兼容必须安全拒绝，图谱迁移失败时保留故障副本并允许重建。

NFR-26: 标准规模首次 rebuild 的 graph-service 进程树峰值 RSS 不超过 4 GiB，整段平均 CPU 不超过整机 75%；连续 5 分钟空闲窗口 CPU p95 不超过 1%、结束 RSS 不超过 1.5 GiB；单工作区缓存与日志总量不超过 2 GiB，轮转日志不超过 100 MiB，8 小时会话不得出现持续资源增长。

NFR-27: 每个 indexing root 最多运行一个按需 graph-service；未授予 Workspace Trust 时不得启动服务、读取项目或执行 Git；所有路径 realpath 后必须位于 indexing root；服务在无客户端且无活动 Job 5 分钟后优雅退出，并能从崩溃、重连、升级和 stale metadata 中恢复。

### 产品验证与发布门禁要求

SM-1: 使用 ProductValidationPlanV1 中版本化的 UJ-2 task pack，固定 fixture commit/digest、目标文件、requiredEntities、affectedAggregates、acceptableAliases、criticalDistractors 和 groundTruthDigest；至少 10 个有效会话中，至少 80% 必须在 180 秒内识别全部 requiredEntities、至少 80% affectedAggregates 且不选择 criticalDistractor。产品崩溃、查询失败或超时计为失败，不得作为剔除理由。

SM-6: 使用至少 30 个案例的版本化 RulesValidationFixtureV1，覆盖 file/directory/package no-cycle、forbidden-dependency、layer-order、warning/error、rules ignore、索引排除差异和负对照；所有预期 error/warning Finding 的 recall=1.00、precision=1.00，error 级漏报为 0，负对照误报为 0，且 IDE/CLI 的稳定 Finding ID、严重级别和位置一致。

SM-7: 复用 SM-1 的 UJ-2 task pack 和 taskStarted/taskSubmitted 事件；有效样本至少 10 名未参与产品实现的一线开发者或 Tech Lead、3 个真实 TS/JS 仓库、2 个独立团队。以有效会话为分母，至少 70% 对固定价值陈述评分达到 4/5 或以上；产品失败、超时、错误答案、低评分和负面反馈不得剔除。

SM-8: 每次 review 生成封闭的 TechLeadReviewEvidenceV1；至少 5 名 Tech Lead、3 个独立团队中，至少 80% 只需 none、wording-only 或 format-only 编辑，且 criticalOmissions 与 falseCriticalStatements 均为空。所有失败样本必须保留并关联复测条件。

UJ-5: 使用版本化 UJ5ExportValueTaskV1；至少 8 名 AI 编码重度用户、3 个真实 TS/JS 仓库和 2 个独立团队完成边界敏感的 structure-only 导出任务。至少 75% 必须正确识别目标范围与禁止边界，并对导出澄清任务边界的价值评分达到 4/5 或以上；任何源码、绝对路径或未授权内容泄露均使门禁失败。该门禁只决定 v1.1/MCP 候选是否启动，不扩大 MVP。

### 架构与实施附加要求

- AR-1: 绿地起点使用 pnpm workspace；apps/extension 只由官方 VS Code TypeScript + esbuild 模板生成后接入仓库边界，apps/* 放部署入口，packages/* 放核心与共享契约，packages/adapters/* 放基础设施适配器，禁止通用 utils 包。
- AR-2: 采用六边形架构的模块化单体，索引子系统采用“采集 → 分析 → 规范化 → GraphPatch → 原子提交 → 派生查询/Findings → revision”管道；domain/application 只向核心依赖，apps/graph-service 是唯一组合根。
- AR-3: 每个 indexing root 只有一个按需 graph-service；multi-root 管理多个独立实例；Windows 使用命名管道、macOS/Linux 使用 UDS，应用协议为 JSON-RPC 2.0，禁止 TCP 和全局 daemon。
- AR-4: 所有推进 graphRevision 或 findingsRevision 的事务必须进入唯一 snapshot mutation channel；GraphPatch、受影响 Findings 和 revision 原子提交，客户端只能读取已提交快照。
- AR-5: Analyzer 只能输出带 ownershipSliceId、inputDigest、analyzerVersion 和 complete/partial/failed coverage 的 FactBatch；提交前必须对 manifest、AnalyzerConfigSnapshot、EffectiveIgnoreSnapshotV1、RulesSnapshotRef 和 bootstrapGeneration 做 CAS，过期结果丢弃并重排。
- AR-6: 内部实体使用工作区作用域 cg:// 确定性 ID；外部 npm 包使用标准 purl，Node built-in 使用 node:；公共路径为工作区相对 POSIX、时间为 UTC ISO 8601、源码范围为 0-based UTF-16 半开区间。
- AR-7: TS/JS 权威源为 TypeScript 6.0.3 稳定 Compiler API；实现唯一的 import/export、re-export、type/value、literal require/import() 映射，MVP 不生成 references，并按 BasicSymbolV1 限定顶层符号范围。
- AR-8: 首次 Analyzer/rebuild Job 之前必须建立 BuiltinIgnoreV1 和可消费的 EffectiveIgnoreSnapshotV1；用户 .codegraphignore、last-valid、非法 UTF-8、反选和重新纳入由独立后续切片完善。
- AR-9: SQLite 位于 OS 用户缓存，仅服务可写；启用 WAL、foreign keys、synchronous=NORMAL 和有界 busy timeout；只按能力首次使用增量建表，迁移失败保留故障副本后重建。
- AR-10: 服务返回预算内、渲染器无关的 GraphViewModel；默认图形节点仅为 file、directory、workspace-package、external-package，聚合是带 membershipDigest/expandToken 的投影属性，NavigationTargetV1 使用封闭联合。
- AR-11: GraphViewPatchV1 只能是精确 delta 或 invalidate，并绑定 serviceInstanceId、statusEpoch、viewId、queryFingerprint 及 graph/findings/status 三组时钟；任一身份或基线不匹配必须全量重取。
- AR-12: 长操作使用 queued/running/succeeded/failed/cancelled Job；取消只在事务外安全点生效，保留最新已提交缓存，并以 partial/stale 和完成范围表达未完成重建。
- AR-13: Watcher 仅提供可能丢失、重复或乱序的变化候选；启动采用 watcher-first bootstrap，显式 rebuild/check/impact/export 前完成或复用 reconciliation，有客户端期间最长每 5 分钟再次有界对账。
- AR-14: .codegraph/rules.yaml v1 由 JSON Schema 2020-12 定义，yaml 保留 CST/range，Ajv 严格拒绝未知字段；ConfigDiagnosticV1 是 Problems、CLI 和 doctor 的唯一诊断合同。
- AR-15: Finding 使用稳定 ID、active/resolved/stale 生命周期和 job/git/none 比较上下文；无效配置或不完整范围只能使旧 Finding stale，只有有效策略在完整 scope 成功评估后才允许 resolved。
- AR-16: BaseCycleProjectionV1 必须在 Alpha 查询切片完成并早于 Project Overview；ProjectionMembershipV1、CycleProjectionKernelV1、FindingAttributionKernelV1 和 OverviewMetricV1 由服务端 application 层唯一计算。
- AR-17: OverviewMetricV1 的 dependencyStrength 统计不同 high-confidence 文件级 imports 边；热点按 active error、active warning、cycleMemberCount、internalDependencyStrength 和规范 node ID 稳定排序，仅 current+complete 发布正式排名。
- AR-18: CycleDeltaV1、ImpactVerdictV1 和 ImpactRankV1 只能由 application/impact 生成；verdict 优先级为 block > unknown > review > pass，VS Code、CLI 与 Markdown 只消费，不得重算或重排。
- AR-19: VS Code surface 职责固定为 Activity Bar/TreeView 提供入口和状态、Webview Editor 提供 Overview/Current Context/Changes 的图与等价列表、Problems 提供可定位诊断、Status Bar 提供单行状态，所有操作同时注册 Command Palette。
- AR-20: ContextLock 只保存在当前 extension-host 会话内；Webview reload 可由 extension 内存恢复，窗口 reload、VS Code 重启或重新打开工作区后清除，workspaceState/globalState 不得保存固定标记。
- AR-21: 未授予 Workspace Trust 时不运行分析；Webview 使用严格 CSP、nonce、本地资源根和消息 Schema 校验；路径穿越、外部 symlink、恶意 YAML、过大文件、伪造 IPC 和超预算请求必须安全失败。
- AR-22: CLI 公共合同固定命令、schemaVersion: 1 envelope、stdout/stderr 分工、无 ANSI、相对路径和退出码 0/1/2/3/4/130；插件与 CLI 复用同一服务合同。
- AR-23: TelemetryPort 默认 Noop；遥测关闭必须立即取消 pending-on、丢弃缓冲并广播生效状态；日志有界轮转、不记录源码，并以 requestId/jobId/revision 关联。
- AR-24: PrReviewSummaryV1、StructureContextExportV1 和 ExportArtifactV1 是不可变版本化合同；服务只有在生成完整结束后才返回 artifactStatus=complete 且带 artifactId、graphRevision、findingsRevision、requested/effectivePolicy、containsSource、contentDigest 和 generatedAt 的 ExportArtifactV1。生成失败不得暴露部分内容，只有剪贴板或原子文件写入等目标操作失败才允许复用同一完整 artifact。默认 structure-only，include-source 只能由当前交互或当前 CLI invocation 显式授权，Webview 不接收绝对目标路径。
- AR-25: protocol、graph schema、rules schema 和 CLI schema 独立版本化；graph-service 持有 EffectiveServiceConfig、configRevision 和 viewConfigRevision，共享配置 latest-wins 并在安全 Job 边界应用。
- AR-26: CLI 作为要求 Node 24 LTS 的 npm 包发布；平台特定 VSIX 携带同源服务、精简 Node 运行时、匹配 ABI 的 SQLite 模块和许可证，安装后不得下载运行时或原生模块。
- AR-27: 服务启动、单实例锁、metadata、bootstrap barrier、空闲退出、重连、升级交接和 stale metadata 回收必须可恢复；升级不得强杀活动事务或启动第二个不兼容实例。
- AR-28: Story 1.1 同时建立仓库边界与真实最小 CI，architecture-required 运行 type、lint、unit、build、contract、dependency-boundary 和 basic-security；Story 1.2 通过该 CI 顺序合并。Story 1.3 再建立 ci/quality-gates.v1.yaml、规划双向追踪、provider required check、禁用 bypass 和外部 drift monitor。Story 1.3 完成前不得并行启动 Story 1.4 及其他功能 Story；能力首次公开落地时必须在同一 PR 扩展真实 blocking gate。
- AR-29: BenchmarkPlanV1 固定 fixture/digest、参考环境、cold/warm cache、起止事件、2 次 warm-up、至少 20 次测量和 nearest-rank p95；SM-4 使用至少 500 条版本化人工标注声明，micro-F1 ≥ 0.80 且 high-confidence precision ≥ 0.90。
- AR-30: 发布按 Alpha、Beta、Beta+ 累积切片推进；Beta+ 才是完整 MVP，必须通过 ReadinessGateManifestV1 逐项展开的 FR、SM、NFR 和发布完整性 gate，任一 fail 或 invalid 均为 No-Go；Beta 不得被表述为完整 MVP。
- AR-31: 发布候选必须生成可复现的 ReleaseArtifactManifestV1、ReleaseSetManifestV1、ReleaseTrustBundleV1 和 ReleaseSignatureV1；两个隔离 clean checkout 的未签名 payloadRootDigest 必须一致，平台矩阵、ABI、协议、schema、许可证、SBOM、签名和 release set 任一不一致都阻止发布。
- AR-32: ProductValidationPlanV1 固定 SM-1、SM-6、SM-7、SM-8 和 UJ-5 的任务、fixture、计时、ground truth、样本、剔除、评分、阈值和 evidence schema；ReadinessGateManifestV1 是 Beta、Beta+、v1.1 适用性的唯一机器清单。planVersion、digest、candidateRef 或 schema 不匹配的证据为 invalid，不能人工解释为通过。对应 Architecture 决策为 AD-30。

### UX 设计要求

UX-DR1: 所有界面优先使用 VS Code Theme Color、字体、字号、缩放和焦点变量；暗色/亮色 fallback 仅作后备，高对比主题完全服从宿主。

UX-DR2: 关系、风险、置信度、新增/删除和状态必须同时使用文字、图标、箭头、线型、轮廓或符号表达，禁止只靠颜色、形状或动画。

UX-DR3: UI 文本继承 VS Code 字体，路径、符号和规则使用编辑器字体；节点主标签最多两行，完整路径必须在详情或 tooltip 中可读，状态使用完整短句。

UX-DR4: 所有人类可读 VS Code 文案支持 zh-CN 与 en，跟随 VS Code locale，未知 locale 回退 en；JSON 字段、错误 code、枚举和 Schema 不本地化。

UX-DR5: 主 Webview 使用紧凑工具栏、GraphCanvas 和可收起 NodeDetails；宽度不足时详情折叠或下置，侧栏只承担状态、计数和入口。

UX-DR6: 后台刷新、模式切换和增量 patch 必须保留中心节点、选中项、缩放、展开层级、筛选和滚动位置，禁止持续力导漂移或强制自动缩放。

UX-DR7: GraphCanvas 使用宿主编辑器表面、无装饰网格，并提供缩放、适应视图、当前范围和预算摘要；空状态不得以品牌插画代替说明。

UX-DR8: GraphNode 必须通过轮廓、图标、标签和文本区分文件、目录/模块、workspace package、外部 npm 包与 Node 内置模块；Node built-in 使用 node: 前缀、“Node 内置模块”、独立图标和点线轮廓。

UX-DR9: GraphEdge 必须用箭头表达方向并展示关系类型、来源、置信度、规则和变更状态；新增/删除叠加 +/−，低置信关系使用非错误视觉。

UX-DR10: ViewModeSwitch 提供图/列表切换，两种模式共享选择、筛选、范围、ContextLock 和展开状态，列表具备核心任务等价能力。

UX-DR11: ContextLock 持续显示“跟随编辑器”或“已固定：相对路径”；固定只持续当前 extension-host 会话，解除后立即聚焦当前活动文件。

UX-DR12: NodeDetails 展示相对路径、实体类型、入/出边、更新时间、来源、置信度和 Findings，并提供打开文件、聚焦邻域、复制路径和缺失目标重建动作。

UX-DR13: FindingRow 展示稳定 rule ID、规则名、warning/error、actual、expected、路径、时间、active/resolved/stale 和 new/existing/not-applicable，并支持跳转源码或规则文件。

UX-DR14: 规则配置错误必须显示 .codegraph/rules.yaml 的精确范围、问题值和针对重复 ID、未知字段/类型、缺失字段、非法 severity/scope 的修复提示，禁止静默忽略。

UX-DR15: StatusBanner 非阻塞表达 indexing、refreshing、stale、failed、cancelled、partial 和无支持文件，最多一个主动作；刷新保留缓存，失败提供日志和 rebuild。

UX-DR16: IndexSummary 展示生成时间、索引文件数、节点数、边数、workspace package 数、排除摘要和完整性；索引中展示阶段和进度，取消后保留缓存摘要和重建入口。

UX-DR17: ChangeSummary 先展示 ImpactVerdictV1 和本次新增风险，再展示边变化、受影响目录、循环变化、建议复查文件和折叠的既有风险。

UX-DR18: ExportPreview 展示范围、baseline/revision、本地生成状态、目标和敏感内容说明；默认不含源码。仅 artifactStatus=complete 且包含 revision、policy 和 contentDigest 的不可变 artifact 可复制或写出；生成失败不产生可复制部分内容，目标操作失败才保留本次完整 artifact 并允许重试，上一份有效 artifact 必须与本次失败状态视觉分离。

UX-DR19: 信息架构必须包含 Getting Started/Index Status、Project Overview、Current Context、Findings、Changes/PR Summary、Entity Details、Export Preview 和 Settings & Rules，所有主要 surface 至少从一条关键流程到达。

UX-DR20: 未信任工作区状态不得启动服务、读取项目或执行 Git；界面解释 Workspace Trust 限制，唯一主动作是“管理 Workspace Trust”，授权后重新进入正常初始化流程。

UX-DR21: Cold open 解释本地索引并提供“构建图谱”主动作和查看索引范围入口；无受支持文件时说明 TS/JS 支持范围、排除摘要和打开设置动作。

UX-DR22: Indexing 保留已完成部分结果并标明完整性、阶段和进度；大仓库允许取消，取消后显示时间、原因和完成范围，且不得清空缓存。

UX-DR23: Refreshing 和 stale 先显示缓存并解释刷新或过期原因；failed 显示错误摘要、日志和 rebuild，同时保留可读取缓存。

UX-DR24: Monorepo recognized 显示 npm/Yarn/pnpm 类型、package 数和跨 package 关系；degraded 说明 package 能力不可用但继续普通索引，并提供检查配置或 rebuild。

UX-DR25: 空邻域、达到预算、无 Findings、低置信关系、文件缺失和导出失败必须有范围说明与下一步；“无 Findings”不得暗示全仓库永久无风险。

UX-DR26: Settings & Rules 明确显示遥测默认关闭、核心功能不受影响和当前未发送遥测；opt-in 后列出允许与禁止数据，并持续提供立即关闭动作和生效反馈。

UX-DR27: Current Context 默认跟随编辑器；切换文件时先稳定切换中心再后台刷新，不得用空画布过渡；用户可按预算渐进展开下一跳。

UX-DR28: 所有命令同时暴露于 Command Palette。Windows/Linux 候选为 Ctrl+Alt+G 与 Ctrl+Alt+P，macOS 候选为 Cmd+Option+G 与 Cmd+Option+P；必须在 VS Code 1.125.0、最新稳定版和前一稳定版检查默认键位、Accessibility Help、产品命令与系统保留组合。覆盖宿主默认或可访问性关键命令的平台不注册默认绑定；第三方扩展冲突只记录为可重映射兼容信息，Command Palette 始终可完成同一任务。

UX-DR29: 键盘语义固定为 Tab 在区域间移动、方向键遍历邻接节点、Enter 选择/打开、Space 展开、Esc 返回/关闭；关键动作不得只存在于 hover。

UX-DR30: 保存后的增量更新不得弹模态框或随输入持续重排；debounce/batch 后一次提交 UI patch，新增风险通过 Problems、状态栏或非阻塞提示进入。

UX-DR31: 禁止默认全仓库大图、无限扩展、持续动画、强制自动缩放、推断关系冒充事实、超过一层模态栈和脱离 IDE 的独立 Dashboard 作为 MVP 主体验。

UX-DR32: 标准规模下首次 Overview 60 秒可用、warm cache 邻域 300ms 可见、保存更新 2 秒完成；查询超过 500ms 或更新超时时保留旧结果并显示进行中。

UX-DR33: GraphNode 向屏幕阅读器提供名称、类型、入/出边数、Finding 数和选择状态；GraphEdge 提供起点、方向、终点、来源和置信度，画布几何不能成为完成任务的前提。

UX-DR34: 遵循 VS Code 高对比、字体缩放和焦点设置，以 WCAG 2.2 AA 为目标；焦点顺序与阅读顺序一致，焦点轮廓在所有主题下可见。

UX-DR35: 开启减少动态效果时禁用布局补间和路径流动动画，刷新直接稳定到新位置；所有操作可键盘完成，图节点可选区域不小于 24×24 CSS px。

UX-DR36: 900px、600px、360px 是候选响应阈值。实现必须在真实 VS Code Webview 测试 1024、900、899、600、599、360、359 CSS px，并以无关键动作裁切、无水平溢出、200% 字号下信息不重叠、键盘焦点不丢失为通过条件；阈值校准变化必须同步 EXPERIENCE、UX-DR36、Story AC 和视觉基线。

UX-DR37: 首个真实 Webview 切片必须留下阻断矩阵证据：VS Code 1.125.0、最新稳定版和前一稳定版；暗色、亮色、高对比；100%/200% 字号；1024/899/599 CSS px 编辑区与 359 CSS px 侧栏；仅键盘核心流程。最新稳定版还需执行 Windows+NVDA、macOS+VoiceOver、Linux+Orca spot check，并记录截图或可访问性树、焦点顺序、溢出结果、宿主版本、主题、OS、宽度和已知限制；Story 5.5 在发布候选上复验。

### FR 覆盖图

FR-1: Epic 1 - 初始化本地工作区图谱，并在正常、空工作区或 workspace 识别降级时返回可操作结果。
FR-2: Epic 1 - 提取确定性的 TS/JS 模块依赖、外部实体、workspace package 关系和 BasicSymbolV1。
FR-3: Epic 2 - 保存文件后增量刷新图谱，并保留可用缓存与明确的新鲜度状态。
FR-4: Epic 1 - 在首次索引前建立排除基线，并支持完整 .codegraphignore 生命周期。
FR-5: Epic 1 - 建立稳定 ID、独立 schema/revision 和可恢复的图谱状态。
FR-6: Epic 2 - 提供目录、模块与 workspace package 聚合的 Project Overview。
FR-7: Epic 2 - 提供预算内的一跳 Current Context，并支持服务端聚合展开。
FR-8: Epic 2 - 支持跟随编辑器和仅当前 extension-host 会话有效的 ContextLock。
FR-9: Epic 2 提供实体详情与导航基础；Epic 3 补充 Findings 证据与规则配置导航。
FR-10: Epic 2 提供结构图与等价列表；Epic 3 提供 Findings/循环文本；Epic 4 提供变更影响与 PR 文本。
FR-11: Epic 1 提供独立于规则的基础循环投影；Epic 3 提供 no-cycle 规则、Finding 和比较语义。
FR-12: Epic 3 - 定义、校验并执行 rules.yaml v1 三类架构规则。
FR-13: Epic 3 - 保存后在 IDE 中显示稳定、可定位的 Finding。
FR-14: Epic 3 - 解释实际依赖、期望规则、循环路径、来源、置信度和比较限制。
FR-15: Epic 3 - 通过 CLI check 提供文本、JSON 和稳定退出码。
FR-16: Epic 4 - 选择并规范化 working tree、staged 或 base ref 变更集合。
FR-17: Epic 4 - 通过 ImpactVerdictV1/ImpactRankV1 计算并解释结构影响。
FR-18: Epic 4 - 生成默认 structure-only 的 PR Markdown 摘要。
FR-19: Epic 1 提供本地隐私、缓存和遥测控制；Epic 2 提供设置界面；Epic 5 验证离线交付边界。
FR-20: Epic 1 提供 rebuild/query/status/doctor/cache；Epic 3 提供 check；Epic 4 提供 impact/export；Epic 5 验证安装后的完整命令面。
FR-21: Epic 1 建立统一 graph-service 与查询合同；Epic 2–4 作为宿主和工作流消费者；Epic 5 验证交付兼容性。
FR-22: Epic 1 提供状态、取消和恢复；Epic 2 提供状态体验；Epic 5 提供升级与缓存恢复验证。
FR-23: Epic 4 - 导出预算内、带 revision、默认不含源码的结构上下文。

## Epic 列表

### Epic 1：构建、查询并恢复可信的本地代码图谱

用户可以在本地创建、查询、诊断、取消和恢复代码图谱，并获得确定性的 TS/JS 依赖事实、workspace package 关系、BasicSymbolV1 和基础循环投影。

**覆盖的 FR：** FR-1、FR-2、FR-4、FR-5、FR-11（基础循环）、FR-19、FR-20（rebuild/query/status/doctor/cache）、FR-21、FR-22。

**实施说明：** Story 1.1 同时建立仓库边界与真实最小 CI，Story 1.2 通过该 CI 顺序合并，Story 1.3 再完成 manifest、provider 强制、规划双向追踪和 drift monitor；Story 1.3 完成前不开放功能并行。Story 1.4 只负责安全初始化首次图谱与最小存储，Story 1.19 再完成确定性 rebuild、完整 CAS 与原子提交；BaseCycleProjectionV1 必须在 Epic 2 的 Overview 前交付。

### Epic 2：在 VS Code 中快速理解项目与当前文件影响

用户可以在实际编码位置通过 Project Overview、Current Context、图与任务等价列表理解项目结构和当前文件影响，并在后台增量刷新期间保持上下文与可用缓存。

**覆盖的 FR：** FR-3、FR-6、FR-7、FR-8、FR-9（实体详情基础）、FR-10（结构理解部分）、FR-19（遥测设置界面）、FR-21、FR-22。

**实施说明：** Epic 2 只依赖 Epic 1；Story 2.1 先建立可信 VS Code 壳层，Story 2.10 再交付 Getting Started 与权威 Index Status，之后才能进入 Overview。Story 2.8 只负责服务端增量提交，Story 2.11 再负责原子刷新视图与空间上下文。循环风险消费 Epic 1 的基础循环投影，不依赖未来 Epic 3；主题、键盘、屏幕阅读器、响应式和空间记忆要求必须下沉到各功能切片。

### Epic 3：在编码时发现并解释架构风险

用户可以声明架构规则，在保存代码或运行 CLI check 时发现循环、禁止依赖和层级违规，并获得稳定、可定位、可解释且具有正确生命周期的 Finding。

**覆盖的 FR：** FR-9（Findings 集成）、FR-10（Findings 与循环文本）、FR-11、FR-12、FR-13、FR-14、FR-15。

**实施说明：** Finding 身份与生命周期和增量重评一致性属于独立失败域；Rules Schema、配置诊断、Finding 生命周期和 CLI check 门禁在能力首次落地时逐步加入 CI。

### Epic 4：审查变更并导出可共享的结构上下文

Tech Lead 可以分析 Git 变更，获得统一的结构影响 verdict 和可直接用于 PR review 的 Markdown；开发者可以导出默认不含源码的结构上下文用于 AI 或人工协作。

**覆盖的 FR：** FR-10（变更影响与 PR 文本）、FR-16、FR-17、FR-18、FR-20（impact/export）、FR-23。

**实施说明：** application/impact 是 CycleDeltaV1、ImpactVerdictV1 和 ImpactRankV1 的唯一生产者；VS Code、CLI 与 Markdown 只消费。Story 4.8 只交付 CLI impact，Story 4.9 再交付 CLI export。导出默认 structure-only，显式源码授权只对当前请求有效；生成失败不得产生可复制的部分 artifact，只有目标操作失败才允许复用同一完整 artifact。

### Epic 5：可安装、可升级、可离线使用项目代码图谱

用户可以在受支持桌面平台安装 CLI 和平台特定 VSIX，在离线环境运行完整 MVP，并安全完成升级、降级、服务交接、缓存恢复和候选产物验证。

**交付强化的 FR：** FR-19、FR-20、FR-21、FR-22。

**实施说明：** 覆盖 CLI 包、平台 VSIX、升级/降级、兼容矩阵和可复现候选产物，并承担 NFR-24 至 NFR-27 的最终发布验证。Story 5.11 冻结 ProductValidationPlanV1 与 ReadinessGateManifestV1，Story 5.12 只消费固定合同审计完整 Beta+ 候选并执行 Go/No-Go。

### Story 编号、展示顺序与依赖权威

现有 Story ID 是稳定标识，不因拆分而重编号。新增 Story 为 1.19、2.10、2.11、4.9、5.11，原 5.11 顺延为 5.12；总数为 61。以下箭头只表示推荐阅读/展示顺序，不定义调度约束；实现代理必须读取文末覆盖全部 61 个 Story 的 `StoryDependencyDagV1.dependsOn`，不得从文档位置或 Story ID 数值推断依赖。

- Epic 1：1.1 → 1.2 → 1.3 → 1.4 → 1.19 → 1.5 → 1.6 … → 1.18
- Epic 2：2.1 → 2.10 → 2.2 … → 2.8 → 2.11 → 2.9
- Epic 4：4.1 … → 4.7 → 4.8 → 4.9
- Epic 5：5.1 … → 5.10 → 5.11 → 5.12

## Epic 1：构建、查询并恢复可信的本地代码图谱

用户可以在本地创建、查询、诊断、取消和恢复代码图谱，并获得确定性的 TS/JS 依赖事实、workspace package 关系、BasicSymbolV1 和基础循环投影。

### Story 1.1：建立仓库模板、依赖边界与最小真实 CI

As a 项目贡献者，
I want 获得结构清晰、命令可重复执行的项目仓库，
So that 后续切片可以在明确的模块责任和依赖方向上独立开发。

**依赖：** 无（Epic 起点）。

**关联需求：** FR-21、NFR-23、AR-1、AR-2、AR-28

**Acceptance Criteria:**

**Given** 一个新的项目检出
**When** 安装锁定版本的 Node.js、pnpm 和项目依赖
**Then** 仓库建立 apps/*、packages/* 和 packages/adapters/* 结构
**And** apps/extension 来源于官方 VS Code TypeScript + esbuild 模板
**And** 根级 type、lint、unit、build、contract、dependency-boundary 和 basic-security 命令可重复执行。

**Given** 核心、应用、契约和适配器包已经建立
**When** 执行依赖边界检查
**Then** domain 不依赖其他项目包
**And** application 只向 domain 和自身稳定接口依赖
**And** 适配器不能被核心反向导入
**And** graph-service 被保留为唯一组合根。

**Given** 贡献者需要放置共享代码
**When** 选择目标包
**Then** 代码按领域、应用、契约、客户端或适配器责任归位
**And** 仓库中不存在无责任边界的通用 utils 包
**And** 新包违反约定时依赖边界检查给出相对路径和修复建议。

**Given** 根级 type、lint、unit、build、contract、dependency-boundary 和 basic-security 命令已经可重复执行
**When** Pull Request 或受保护分支触发 CI
**Then** architecture-required 以稳定 check 名执行所有命令
**And** 任一真实失败阻止 Story 1.1 合并
**And** 不使用空测试、永久 skip、无断言或始终成功脚本。

**Given** `architecture-required` 的最小 CI 已配置
**When** 审查 Story 1.1 的独立完成证据
**Then** 该 required check 对当前及后续 Pull Request always-run，且不使用 path filter 跳过执行
**And** 受控失败证据证明任一真实失败能够阻止合并
**And** 完成证据不依赖 Story 1.2 已开始、提交或合并。

### Story 1.2：启动空 graph-service 并完成协议握手

As a CLI 或扩展开发者，
I want 连接每个工作区唯一的空图谱服务并读取权威状态，
So that 后续能力可以复用同一本地服务实例和版本化协议。

**依赖：** Story 1.1。

**关联需求：** FR-21、FR-22、NFR-13、NFR-27、AR-3、AR-22、AR-27、AR-28

**Acceptance Criteria:**

**Given** CLI 或 extension service-client 首次连接某个 indexing root
**When** 初始化本地 graph-service
**Then** 每个 indexing root 最多启动一个服务实例
**And** Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket
**And** 服务使用 JSON-RPC 2.0 且不监听 TCP。

**Given** 多个兼容客户端连接同一 indexing root
**When** 完成服务发现和 token、workspace-key、协议版本校验
**Then** 客户端复用同一实例而不是创建第二个 writer
**And** 不兼容或伪造连接安全失败并返回可操作诊断。

**Given** 当前尚未构建图谱
**When** 客户端完成 initialize 和 service/status 请求
**Then** 服务返回 protocol、graph、rules 和 CLI 独立版本及 capabilities
**And** 返回合法 ServiceStatusV1，其状态为 absent、freshness null、completeness empty
**And** 不伪造 graphRevision、节点、边或成功索引结果。

**Given** 服务或 endpoint 启动失败
**When** 客户端读取错误
**Then** 返回稳定 code、category、retryable、logId 和 suggestedAction
**And** 不启动 TCP 回退、全局 daemon 或第二个不兼容实例。

**Given** Story 1.2 的实现准备合并
**When** 同一 `architecture-required` 最小 CI 对该提交运行
**Then** type、lint、unit、build、contract、dependency-boundary 和 basic-security 全部通过
**And** 合并证据记录稳定 check 名、候选提交和最终结果
**And** 任一失败阻止 Story 1.2 合并，不得等待 Story 1.3 才补做实际门禁证据。

### Story 1.3：强化 provider 阻断与规划双向追踪门禁

As a 项目维护者，
I want 将最小 CI 强化为 manifest 驱动、provider 强制且可检测漂移的完整架构门禁，
So that 地基完成后才能并行开发功能，后续能力和规划引用也不会绕过架构合同。

**依赖：** Story 1.1、Story 1.2。

**关联需求：** FR-21、FR-22、NFR-23、AR-28

**Acceptance Criteria:**

**Given** Story 1.1 的最小 CI 和 Story 1.2 的空服务握手已经可执行
**When** ci/quality-gates.v1.yaml 被解析
**Then** type、lint、unit、build、contract、dependency-boundary、basic-security 和规划追踪均作为真实 blocking gate 执行
**And** 每个门禁具有稳定 checkId、触发路径、验收命令、capabilityOwner 和 blocking 标记
**And** ci/quality-gates.v1.yaml 是适用 gate 的唯一机器清单，不重复创建最小 CI。

**Given** Pull Request 触发 provider 侧规则
**When** always-run 聚合门禁执行
**Then** 使用稳定 check ID architecture-required
**And** 仓库内变更无法移除该必需检查或启用管理员 bypass
**And** 任一适用门禁失败都会阻止合并
**And** 仓库外 drift monitor 持续验证 required check 和 ruleset 未漂移。

**Given** 规划文档、Architecture AD、产品验证合同或 Story 引用发生漂移
**When** 执行规划追踪检查
**Then** FR、NFR、SM、AR、UX-DR、AD、Story 编号、相对文档链接和 ProductValidation plan/manifest 引用不一致会产生明确失败
**And** 诊断指出相对文件位置、缺失的双向引用和修复建议。

**Given** 某项能力首次由公共 CLI、RPC、extension 调用或公共 Schema 公开
**When** 对应变更提交
**Then** 同一 PR 必须把真实门禁加入 ci/quality-gates.v1.yaml 并由 architecture-required 执行
**And** Story 交付说明引用 checkId、能力 owner 和验证证据。

**Given** Story 1.3 的全部基线门禁尚未通过
**When** 尝试并行启动 Story 1.4 或其他功能 Story
**Then** 规划和 provider gate 明确阻止并行开放
**And** 只有基线通过后才允许后续功能切片并行实施。

### Story 1.4：安全初始化首次图谱与最小存储

As a 首次使用本地图谱的开发者，
I want 在安全排除基线和最小持久存储上得到可识别的首次图谱结果，
So that 我不会索引依赖目录、预建未来数据或看到伪造成功状态。

**依赖：** Story 1.3。

**关联需求：** FR-1、FR-4、FR-5、FR-22、NFR-9、NFR-10、NFR-11、AR-6、AR-8、AR-9、AR-12、AR-28

**Acceptance Criteria:**

**Given** 工作区不存在 .codegraphignore
**When** graph-service 完成首次配置屏障
**Then** 建立 generation 0、validity=valid、contentHash=null 的空用户排除快照
**And** effectiveRules 已包含完整 BuiltinIgnoreV1
**And** Analyzer 和 scanner 只消费 EffectiveIgnoreSnapshotV1。

**Given** 工作区存在尚未由完整排除切片支持的 .codegraphignore
**When** 用户请求首次 rebuild
**Then** 系统返回稳定、可操作的配置能力诊断
**And** 不静默忽略文件、不绕过内容、不提交范围不可信的图谱。

**Given** 候选文件已应用有效排除快照
**When** 用户执行首次 rebuild
**Then** 创建 initial-index 或 rebuild Job
**And** 生成 workspace、directory、file 节点与 contains 关系
**And** node_modules、构建产物、缓存和生成代码不进入候选集。

**Given** 基础实体需要公共身份
**When** 写入当前切片
**Then** 使用工作区作用域确定性 cg:// ID
**And** 路径使用 Unicode NFC 和相对 POSIX 格式
**And** SQLite rowid、绝对路径和宿主分隔符不进入公共合同。

**Given** graph-service 首次创建持久存储
**When** 初始化当前切片 schema
**Then** 只创建 meta、workspace、nodes、edges、evidence、facts_ownership、jobs 和 schema_migrations
**And** 不提前创建 Findings、impact、export 或发布表
**And** 启用 WAL、foreign keys、synchronous=NORMAL 和有界 busy timeout。

**Given** 工作区没有受支持文件或首次构建失败
**When** 用户查看状态
**Then** 空工作区返回可识别的空摘要
**And** 失败返回稳定 code、日志引用和重试动作
**And** 不把未提交实体表示为成功图谱。

**Given** Story 1.4 首次进入公共 rebuild 路径
**When** CI 运行
**Then** SQLite 迁移、按需建表、BuiltinIgnoreV1、generation 0、路径与空/失败状态门禁通过
**And** 任一失败阻止合并。

### Story 1.19：完成确定性 rebuild 与原子提交

As a 依赖本地图谱做判断的开发者，
I want 相同输入得到相同已提交图谱，并在输入变化时拒绝过期结果，
So that 查询和后续分析永远基于完整、可重复、未被竞态污染的 revision。

**依赖：** Story 1.4。Story 1.5 不得早于本 Story。

**关联需求：** FR-1、FR-5、FR-22、NFR-9、NFR-10、NFR-11、NFR-22、AR-4、AR-5、AR-6、AR-9、AR-12、AR-28

**Acceptance Criteria:**

**Given** hierarchy FactBatch 已生成
**When** indexing application 提交结果
**Then** FactBatch 使用 hierarchy:<indexingRootId> ownership slice
**And** GraphPatch、graphRevision 和关联元数据在同一事务提交
**And** 查询无法观察半更新状态。

**Given** 工作区内容和有效排除快照未变化
**When** 连续执行两次完整 rebuild
**Then** 实体 ID、contains 关系和稳定排序相同
**And** 不产生重复节点、边或孤立 ownership
**And** GraphPatch 重放幂等。

**Given** manifest、文件 hash、bootstrap generation 或排除快照在 Job 期间变化
**When** GraphPatch 准备提交
**Then** 服务对完整 read-set 执行 CAS
**And** 过期结果不得提交
**And** Job 被有界重排并保持旧 revision 可读。

**Given** Job 为 partial、failed 或 cancelled
**When** 事务边界到达
**Then** 最新已提交 revision 保持不变
**And** 状态准确显示 partial、failed、cancelled 或 stale
**And** 未完成事实不得覆盖完整 ownership slice。

**Given** Story 1.19 首次公开确定性 rebuild
**When** CI 运行
**Then** 事务原子性、幂等重建、ownership、完整 CAS、过期重排和半提交不可见均为 blocking gate
**And** 任一失败阻止 Story 1.5 开始。

### Story 1.5：提取模块依赖并解析目标

As a 开发者，
I want 图谱提取可解释的 TypeScript/JavaScript 模块依赖并解析目标，
So that 我可以查询可靠的内部、外部和 Node 内置模块关系。

**依赖：** Story 1.19。

**关联需求：** FR-2、FR-5、NFR-22、AR-5、AR-6、AR-7

**Acceptance Criteria:**

**Given** 工作区包含 TS、TSX、JS 或 JSX 文件
**When** Analyzer 处理源码
**Then** 在 Worker 中使用 TypeScript 6.0.3 稳定公开 Compiler API
**And** 不加载项目 plugin、transformer、scripts 或 VS Code TypeScript Server 私有状态
**And** 不使用 TypeScript 7 unstable API、Tree-sitter、LSP 或 SCIP。

**Given** Analyzer 构建配置快照
**When** 解析 tsconfig、jsconfig、extends 链、manifest 和模块解析元数据
**Then** consultedFiles 和 workspacePackages 按规范路径排序
**And** configDigest 与 inputDigest 使用 RFC 8785 JCS、UTF-8 和 SHA-256
**And** rules.yaml 不进入分析配置。

**Given** 源码包含静态 import/export、re-export、type-only、literal require 或 literal import()
**When** Analyzer 规范化语法
**Then** 按 AD-24 唯一映射为 imports 或 exports 关系和固定 qualifier
**And** 非 literal 动态导入不生成伪精确边
**And** MVP 不生成 references 或调用图。

**Given** 模块目标可能是 Node built-in、内部文件、外部 npm 包或未解析 bare specifier
**When** 解析目标
**Then** 按架构固定优先级选择目标
**And** Node built-in 使用 node: 标识，外部包使用 purl
**And** 未解析 bare specifier 降低置信度，未解析相对路径只产生诊断。

**Given** Analyzer 输出模块依赖事实
**When** indexing application 规范化结果
**Then** 每条关系保留方向、qualifier、来源、置信度、文件范围和语言
**And** 使用 source:<analyzerKind>:<fileId> ownership slice
**And** Analyzer 不直接访问 GraphStore。

**Given** 相同源码、配置和分析器版本
**When** 重复 rebuild
**Then** 模块节点、edge、目标 ID 和 qualifier 保持相同
**And** 不生成重复边或把静态依赖表述为运行时调用。

### Story 1.6：提取 BasicSymbolV1 并提供稳定导航范围

As a 需要理解文件入口的开发者，
I want 图谱提取顶层可寻址符号及稳定源码范围，
So that 后续查询、导航和结构导出可以精确指向受支持声明。

**关联需求：** FR-2、FR-5、FR-9、NFR-22、AR-6、AR-7

**Acceptance Criteria:**

**Given** 源文件包含顶层命名声明
**When** 生成 BasicSymbolV1
**Then** 只收录 function、class、interface、type-alias、enum、variable 和 namespace
**And** 携带稳定 symbolId、kind、name、relativePath、SourceRangeV1 和 exported
**And** SourceRangeV1 使用 0-based UTF-16 code-unit 与半开区间。

**Given** 同一文件存在多声明绑定
**When** 选择导航范围
**Then** 优先使用实现声明，否则按 range.start 选择第一项
**And** 输入枚举顺序不影响 symbolId 或导航位置。

**Given** interface 或 namespace 在多个文件声明
**When** 建立 ownership
**Then** 每个声明文件生成独立 BasicSymbolV1
**And** 不创建跨文件共享 owner
**And** 文件删除只影响对应 source slice。

**Given** 声明属于成员、参数、局部变量、import alias、匿名声明、调用或 references
**When** Analyzer 处理
**Then** 该对象不进入 BasicSymbolV1
**And** 不进入符号导航、结构导出或成功指标。

**Given** 相同源码和配置重复分析
**When** 比较 BasicSymbolV1
**Then** ID、kind、名称、路径、范围和 exported 状态保持确定
**And** NavigationTargetV1 可以直接消费该合同。

### Story 1.7：维护 Evidence、事实归属与删除语义

As a 依赖图谱结果进行判断的开发者，
I want 每条关系具有可追溯证据和安全的增删生命周期，
So that 刷新、删除或部分分析不会制造孤立事实或误删其他来源。

**关联需求：** FR-2、FR-5、NFR-22、AR-4、AR-5、AR-6、AR-7

**Acceptance Criteria:**

**Given** Analyzer 输出 Evidence
**When** FactBatch 被规范化
**Then** confidence 只允许 high、medium、low
**And** 每条 Evidence 包含来源、版本、文件、范围、语言和 UTC 检测时间
**And** Evidence 按 edgeId、provenance、analyzerVersion、sourceFileId、normalizedRange 和 evidenceKind 去重。

**Given** 同一证据位置出现冲突目标
**When** 权威来源无法确定唯一目标
**Then** 产生分析诊断并排除冲突证据
**And** 不静默选择任一边或生成高置信 Finding 输入。

**Given** source ownership slice 返回 complete、partial 或 failed
**When** 计算 GraphPatch
**Then** complete 可删除该 slice 已消失事实
**And** partial 只允许 upsert 与显式 tombstone
**And** failed 不生成 GraphPatch，其他 slice 不受影响。

**Given** 最后一条 active Evidence 消失
**When** 原子提交删除
**Then** 同事务清理规范 edge 和无引用外部节点
**And** 仍被其他 Evidence 或 ownership slice 引用的事实保持不变。

**Given** 相同 FactBatch 被重放或 slice 版本升级
**When** 计算 GraphPatch
**Then** 重放保持幂等，新 complete 快照替代同一 slice 的旧事实
**And** 不删除其他 slice 拥有的节点、边或 Evidence。

### Story 1.8：验证分析准确率并发布失败样本

As a 准备采用图谱进行结构判断的团队成员，
I want 查看可复现的依赖分析准确率和失败分类，
So that 我能确认结果达到 MVP 可信门槛并理解剩余限制。

**关联需求：** FR-2、NFR-22、AR-29

**Acceptance Criteria:**

**Given** 版本化人工标注语料
**When** 校验语料清单
**Then** 至少包含 500 条经复核声明
**And** 覆盖 ESM、CJS、re-export、type-only、literal require、literal import()、path alias、跨 package、Node built-in 和负样本
**And** fixture、toolchain 和标注版本具有稳定 digest。

**Given** Analyzer 在语料上运行
**When** 与人工真值比较
**Then** 输出 precision、recall、micro-F1、high-confidence precision、分类结果和失败样本
**And** 标注争议经人工复核并留痕
**And** 报告不包含开发机器绝对路径。

**Given** 结果达到 micro-F1 ≥ 0.80 且 high-confidence precision ≥ 0.90
**When** CI 判定准确率门禁
**Then** 门禁通过并保存机器可读报告
**And** 报告明确不把低置信推断计为高置信成功。

**Given** 任一阈值未达到、语料不完整或 digest 不匹配
**When** CI 执行准确性与合同门禁
**Then** 门禁失败并列出失败类别、样本标识和复测条件
**And** 不通过降低阈值或排除失败分类绕过门禁。

### Story 1.9：识别 workspace package 与跨包依赖

As a 维护 monorepo 的开发者，
I want 图谱识别 workspace package 边界和跨包依赖，
So that 我可以理解包级结构，并在识别失败时继续使用文件级图谱。

**关联需求：** FR-1、FR-2、AR-5、AR-6、AR-7

**Acceptance Criteria:**

**Given** 工作区声明 npm、Yarn workspaces 或 pnpm-workspace.yaml
**When** 执行 workspace discovery
**Then** 枚举单仓库 package 根目录与名称
**And** TypeScript project references 可作为补充来源
**And** 不执行 package manager scripts 或项目代码。

**Given** workspace 边界识别成功
**When** 提交 manifest FactBatch
**Then** WorkspaceDiscoverySummary 返回 recognized 和 packageCount ≥ 1
**And** package 使用基于根相对路径的稳定 cg:// ID
**And** 元数据归属 manifest:<manifestKind>:<relativePath> slice。

**Given** 两个 workspace package 之间存在 high-confidence 文件级 import
**When** 构建 package 投影
**Then** 保留原始文件 Evidence
**And** 派生同方向的跨 package 聚合关系
**And** 聚合结果可追溯且不把外部 npm 包误标为 workspace package。

**Given** 未检测到受支持的 workspace 意图
**When** discovery 完成
**Then** 返回 single 和 packageCount 0
**And** 按普通单根项目继续索引，不显示错误。

**Given** 检测到 workspace 意图但 manifest 无效、冲突或无法完整枚举
**When** discovery 完成
**Then** 返回 degraded、packageCount 0 和 diagnosticRef
**And** 继续文件、目录和源码关系索引
**And** 不生成 workspace-package 节点或 package 聚合结论。

**Given** manifest、lockfile、workspace 配置或 package metadata 变化
**When** 后续 Job 准备提交
**Then** 相关文件 hash 进入 AnalyzerConfigSnapshot
**And** 已提交快照标记 stale
**And** 使用旧 configDigest 的结果无法通过 CAS。

**Given** VS Code 使用 multi-root
**When** 多个 root 分别建立图谱
**Then** 每个 root 保持独立 service、workspace-key 和 revision
**And** MVP 不合并跨 root 图谱或提供跨仓库 federation。

### Story 1.10：解析并应用有效的索引排除配置

As a 开发者，
I want 使用确定性的 .codegraphignore 语法控制索引范围，
So that 依赖目录、构建产物和自定义噪声不会进入图谱。

**关联需求：** FR-4、AR-5、AR-8

**Acceptance Criteria:**

**Given** 工作区存在 .codegraphignore
**When** graph-service 加载原文件
**Then** graph-service 是唯一解释者
**And** 已存在文件从当前 statusEpoch 的 generation 1 开始
**And** scanner、Analyzer、CLI 和 UI 只消费 EffectiveIgnoreSnapshotV1。

**Given** 文件包含注释、排除、反选、锚定或目录规则
**When** 解析严格 UTF-8 内容
**Then** 实现架构定义的 gitignore-style 子集、最后匹配和跨平台确定性语义
**And** 字符类不支持并按字面量处理。

**Given** 新 generation 有效
**When** 规范化 effectiveRules
**Then** BuiltinIgnoreV1 先应用、用户规则后应用
**And** effectiveDigest 使用 RFC 8785 JCS、UTF-8 和 SHA-256
**And** 原子保存可校验的 LastValidIgnoreRecordV1。

**Given** 路径被有效排除
**When** 完整快照提交
**Then** 该路径不产生节点、边、Evidence，不参与 package 聚合、规则检查和成功指标
**And** 先前事实通过其 ownership slice 安全删除。

**Given** 用户运行 rebuild、status 或 doctor
**When** 读取有效排除快照
**Then** 输出配置来源、valid 状态、generation、effectiveDigest 和排除摘要
**And** scanner、Analyzer、CLI 和 UI 不重新解析原文件。

### Story 1.11：从无效排除配置恢复 last-valid

As a 开发者，
I want 无效 .codegraphignore 安全失败并恢复可信范围，
So that 配置错误不会被部分应用或悄悄扩大索引范围。

**关联需求：** FR-4、FR-22、NFR-10、NFR-11、AR-8

**Acceptance Criteria:**

**Given** 文件非法 UTF-8 或解析失败
**When** 建立新快照
**Then** 整个 generation 标记 invalid，不部分应用
**And** 记录原始 contentHash 和稳定诊断
**And** 工作区 freshness 保持 stale。

**Given** 当前 workspace-key 存在可校验 LastValidIgnoreRecordV1
**When** 新 generation 无效或服务跨重启恢复
**Then** 仅在 workspace、grammar、BuiltinIgnore 版本和 checksum 均匹配时恢复历史快照
**And** effectiveDigest 与 lastValidDigest 保持一致
**And** 无效原文件不被当作已生效配置。

**Given** 首次无效且不存在可信历史记录
**When** 建立回退快照
**Then** 使用空用户规则加完整 BuiltinIgnoreV1
**And** 不索引内置排除目录
**And** 明确提示修复配置后需要 reconciliation。

**Given** 后续配置修复为有效
**When** 新 generation 完成完整 reconciliation
**Then** 工作区可以恢复 current
**And** last-valid 记录被原子替换
**And** 旧 invalid generation 结果无法提交。

### Story 1.12：收敛排除配置变化与提交竞争

As a 持续调整索引范围的开发者，
I want 排除配置变化通过监听、对账和 CAS 收敛，
So that 并发索引不会提交基于旧范围的图谱。

**关联需求：** FR-4、FR-5、FR-22、NFR-9、NFR-10、AR-5、AR-13

**Acceptance Criteria:**

**Given** .codegraphignore 原始内容发生任意变化
**When** watcher 或 reconciliation 发现变化
**Then** generation 推进并进入 bootstrap read-set 与完整 snapshot mutation CAS
**And** 已提交快照立即标记 stale
**And** 旧 generation 结果不得提交。

**Given** 新快照与上一快照只有注释或等价表达差异
**When** 计算 digest
**Then** generation 仍推进以形成并发栅栏
**And** 只有 effectiveDigest 变化才改变语义 configDigest
**And** 不触发不必要的全量事实替换。

**Given** 后续反选重新纳入路径
**When** 有效 generation 完成 reconciliation
**Then** 路径重新进入候选集
**And** 沿用原确定性 ID，不产生重复或孤立事实。

**Given** watcher 丢事件、服务恢复或显式 rebuild
**When** 执行有界 reconciliation
**Then** scanner、AnalyzerConfigSnapshot、EffectiveIgnoreSnapshotV1 和 manifest 在同一 generation 收敛
**And** 不依赖 watcher 提供强一致保证
**And** 最终候选集与文件系统快照一致。

### Story 1.13：诊断排除配置并验证安全限制

As a 需要修复索引范围问题的开发者，
I want 获得精确且跨平台一致的排除诊断，
So that 我可以安全修复配置，而不是面对静默忽略或环境相关结果。

**关联需求：** FR-4、FR-22、NFR-9、NFR-27、AR-8、AR-21、AR-28

**Acceptance Criteria:**

**Given** 排除配置存在非法 UTF-8、非法转义或无法应用的模式
**When** graph-service 生成诊断
**Then** 返回稳定 code、severity、relativePath、可用范围、问题摘要和 suggestedAction
**And** 不记录原始敏感内容或绝对路径
**And** CLI、status 和 doctor 复用同一诊断来源。

**Given** 相同 .codegraphignore 在 Windows、macOS 和 Linux 解析
**When** 比较候选路径结果
**Then** 统一使用相对 POSIX、区分大小写和固定 glob 语义
**And** 不受宿主路径分隔符、Git ignore 设置或 locale 影响。

**Given** 路径穿越、外部 symlink、超大候选集或恶意输入试图扩大范围
**When** scanner 和服务验证路径
**Then** realpath 后越界内容被拒绝并返回稳定诊断
**And** 不执行项目代码、脚本或外部命令
**And** 已提交缓存保持可用。

**Given** 完整索引排除能力首次进入公共路径
**When** 用户执行 rebuild、status 或 doctor
**Then** 所有工作区无论是否存在 .codegraphignore 都经过完整排除屏障
**And** 输出来源、有效性、generation、摘要和诊断。

**Given** CI 运行排除配置门禁
**When** 执行合同、属性和跨平台测试
**Then** 覆盖 last-valid、反选、非法 UTF-8、跨平台匹配、重新纳入、路径越界和过期 CAS
**And** 任一失败都会阻止合并。

### Story 1.14：通过 CLI 查询、诊断与查看基础循环

As a 开发者，
I want 通过稳定 CLI 查询图谱、查看基础循环和诊断环境，
So that 我无需图形界面也能理解本地结构并排查问题。

**关联需求：** FR-11、FR-20、FR-21、FR-22、AR-10、AR-16、AR-22

**Acceptance Criteria:**

**Given** 工作区已有已提交图谱
**When** 运行 codegraph query
**Then** CLI 通过 service-client 查询 graph-service
**And** 默认返回一跳直接/反向依赖、来源和置信度
**And** 不直接读取 SQLite 或自行扩大查询范围。

**Given** 查询超过默认预算
**When** 服务生成响应
**Then** 限制为 100 节点、200 边并返回截断原因
**And** 安全硬限制为 3 跳、500 节点、1000 边。

**Given** 用户请求文件、目录或 workspace-package 基础循环
**When** application/cycles 执行 CycleProjectionKernelV1
**Then** 只读取 high-confidence 内部 imports
**And** 大小大于 1 的 SCC 或文件自环生成稳定 BaseCycleProjectionV1
**And** 不读取 rules.yaml 或产生规则 Finding。

**Given** CLI 以文本或 --format json 输出
**When** query、status 或 doctor 完成
**Then** 文本使用相对路径和可理解状态
**And** JSON stdout 只包含 schemaVersion 1 envelope，进度与警告写 stderr
**And** 机器模式无 ANSI。

**Given** 用户运行 status 或 doctor
**When** 获取服务状态与诊断
**Then** status 直接呈现权威 ServiceStatusV1
**And** doctor 检查环境、IPC、协议、缓存、SQLite、manifest、workspace discovery 和 ignore
**And** 每项配置报告来源，不输出源码。

**Given** 图谱缺失、路径无效、协议不兼容、内部失败或取消
**When** CLI 结束
**Then** 分别使用稳定诊断和退出码 2、4、3 或 130
**And** 成功使用 0，退出码 1 保留给规则失败条件。

**Given** 查询与基础循环首次公开落地
**When** CI 运行
**Then** 锁定 JSON Schema、stdout/stderr、相对路径、退出码、SCC 确定性和无 rules 依赖
**And** Story 2 的 Overview 可以直接消费该循环投影。

### Story 1.15：查看状态并安全取消索引

As a 开发者，
I want 准确查看索引进度并安全取消长操作，
So that 我可以继续使用已提交结果，而不会因取消导致缓存丢失或状态误报。

**关联需求：** FR-5、FR-22、AR-10、AR-11、AR-12

**Acceptance Criteria:**

**Given** 服务处于任意正常生命周期
**When** 查询 ServiceStatusV1
**Then** 使用 lifecycle、availability、freshness 和 completeness 四个正交字段
**And** absent/available 组合符合架构合法状态
**And** stale 不被等同为 partial。

**Given** snapshot mutation Job 正在执行
**When** 状态变化
**Then** current Job 只允许 queued/running，last Job 只允许 succeeded/failed/cancelled
**And** 进度声明 determinate 或 indeterminate 及单位
**And** 每次可观察变化推进 status revision。

**Given** 用户在首次事务提交前取消 rebuild
**When** Job 到达安全取消点
**Then** 记录取消原因和时间
**And** 不暴露未提交 GraphPatch
**And** 保留原缓存与 completeness，已检测差异时不得恢复 current。

**Given** 至少一次提交后取消或未完成完整 reconciliation
**When** Job 结束
**Then** 保留最新 graph/findings revision
**And** 标记 partial/stale 并显示已完成范围
**And** 不删除、回滚或清空缓存。

**Given** 图谱、Findings 和状态通知连续到达客户端
**When** 应用更新
**Then** 同一 epoch 只接受更高 revision
**And** 时钟断档或身份不匹配触发完整重取
**And** 不展示混合快照。

**Given** 输入超过文件数、文件大小、查询或显式 Job 安全限制
**When** 服务拒绝操作
**Then** 返回稳定诊断而不是静默截断规则、内存失控或阻塞宿主
**And** 已提交缓存保持可用。

### Story 1.16：管理本地缓存与诊断数据

As a 注重本地数据边界的开发者，
I want 查看、诊断并安全清理图谱缓存和日志，
So that 我能够控制磁盘数据而不误删源码或仓库策略。

**关联需求：** FR-19、FR-20、NFR-12、NFR-14、NFR-26

**Acceptance Criteria:**

**Given** graph-service 创建数据库、锁、token、metadata、last-valid 或日志
**When** 写入磁盘
**Then** 数据位于当前用户 OS 缓存的 workspace-key 目录
**And** POSIX 目录/文件权限为 0700/0600，Windows 继承当前用户配置文件 ACL
**And** 仓库只保存显式策略文件。

**Given** 服务写入结构化日志
**When** 记录请求、Job 或错误
**Then** 使用 requestId、jobId、workspaceKey、revision 和稳定 code 关联
**And** 不记录源码、diff、规则内容、token 或完整绝对路径
**And** 日志按大小和数量轮转，总量不超过 100 MiB。

**Given** 用户运行 codegraph cache path
**When** CLI 返回结果
**Then** 文本可向当前用户显示本机路径
**And** JSON、线协议、导出和遥测不混入绝对缓存路径
**And** doctor 可验证权限、归属和容量。

**Given** 用户运行 codegraph cache clear 且无活动写事务
**When** 确认当前 workspace-key
**Then** 只清理对应缓存、日志、锁和临时文件
**And** 不删除源码、rules.yaml 或 .codegraphignore
**And** 状态恢复为 absent/null/empty。

**Given** 存在活动事务或路径身份不匹配
**When** 请求清理
**Then** 拒绝破坏性操作并提供安全重试建议
**And** 不执行部分清理。

**Given** 资源与长期会话门禁运行
**When** 采样缓存、日志、句柄、Job 和临时文件
**Then** 单工作区总量不超过 2 GiB
**And** 不出现持续单调增长
**And** 报告不包含敏感内容。

### Story 1.17：从缓存损坏和服务中断中恢复

As a 开发者，
I want 从 SQLite 损坏、服务崩溃或连接中断中安全恢复，
So that 我可以重新获得可信图谱而不修改源码或误用旧服务状态。

**关联需求：** FR-5、FR-22、NFR-11、NFR-27、AR-9、AR-11、AR-27

**Acceptance Criteria:**

**Given** SQLite 缓存损坏或 schema 迁移失败
**When** 服务启动或执行恢复
**Then** 原子保留带诊断标识的故障副本
**And** 创建新缓存并重新构建
**And** 不修改源码、Git 状态或仓库策略。

**Given** graph-service 意外退出
**When** service-client 重新连接
**Then** 使用 PID liveness、token 和 endpoint 验证实例
**And** 只有确认旧进程不存在且 endpoint/token 失效时回收 stale metadata
**And** 不同时启动两个 writer。

**Given** serviceInstanceId 或 statusEpoch 改变
**When** 客户端接收新状态
**Then** 无条件替换旧 epoch 状态并全量重取
**And** 旋转 viewId、清空待处理 patch
**And** 不比较不同 epoch 的 revision。

**Given** 崩溃发生在事务提交前或后
**When** 服务恢复
**Then** 提交前的未完成变更不可见
**And** 提交后的 revision 保持原子可读
**And** reconciliation 重新核对 manifest、配置和 watcher 代际。

**Given** 恢复无法自动完成
**When** 用户运行 doctor 或 rebuild
**Then** 返回失败阶段、稳定 code、retryable、故障副本引用和 suggestedAction
**And** 旧缓存可读时继续标记 stale，不伪造 current。

**Given** 恢复集成测试
**When** 覆盖损坏数据库、迁移失败、进程崩溃、断线重连、stale metadata 和 epoch 变化
**Then** 单实例、revision、缓存保留和重建路径均确定性通过。

### Story 1.18：控制遥测并验证默认离线隐私

As a 注重代码隐私的开发者，
I want 明确控制可选遥测并在断网环境使用全部核心能力，
So that 项目结构信息不会被意外上传，关闭操作也能立即生效。

**关联需求：** FR-19、NFR-12、NFR-15、NFR-16、AR-23、AR-25

**Acceptance Criteria:**

**Given** 用户首次启动 CLI、extension 或 graph-service
**When** 未显式选择遥测
**Then** TelemetryPort 使用 Noop
**And** requestedState/effectiveState 均为 off
**And** 所有核心能力不依赖遥测开启。

**Given** 用户显式 opt-in
**When** 服务接收 telemetry-on
**Then** requested 与 applied config revision 分离
**And** 只在安全应用边界且请求仍为最新时启用
**And** 允许字段仅限匿名功能事件、耗时、计数和错误分类。

**Given** 用户在已开启或 pending-on 时关闭遥测
**When** 服务接收 telemetry-off
**Then** 同一临界区取消更早 pending-on、切回 Noop、拒绝新事件并丢弃缓冲
**And** 立即推进并广播已应用 configRevision
**And** 不等待活动 Job。

**Given** 多客户端同时修改共享遥测配置
**When** service/reconfigure 按顺序处理
**Then** graph-service 持有唯一 EffectiveServiceConfig
**And** 使用 latest-wins，后续连接不得隐式覆盖
**And** status 报告 requested/effective/pending 和来源。

**Given** 事件包含源码、diff、完整路径、符号、图谱、规则或未允许字段
**When** 遥测过滤器处理
**Then** 本地拒绝事件并产生不含敏感值的诊断
**And** 未允许数据不进入缓冲或网络。

**Given** 网络被完全阻断
**When** 分别在默认、opt-in 和关闭后执行 Epic 1 核心流程
**Then** 默认和关闭状态无遥测请求
**And** opt-in 只尝试允许列表事件
**And** rebuild、query、status、doctor 和 cache 完整可用。

## Epic 2：在 VS Code 中快速理解项目与当前文件影响

用户可以在实际编码位置通过 Project Overview、Current Context、图与任务等价列表理解项目结构和当前文件影响，并在后台增量刷新期间保持上下文与可用缓存。

**Epic 2 Definition of Done：** 每个 surface 在首次公开落地时即加入对应 Electron blocking gate；Epic 完成时，Getting Started、Overview、Current Context、ContextLock、NodeDetails 和遥测设置必须在 VS Code 1.125.0、最新稳定版和前一稳定版上通过仅键盘、屏幕阅读器、暗色、亮色、高对比、100%/200% 字号、减少动态效果、Webview reload 与真实响应式矩阵验证。自动矩阵至少覆盖 1024/899/599 CSS px 编辑区和 359 CSS px 侧栏；最新稳定版执行 Windows+NVDA、macOS+VoiceOver、Linux+Orca spot check。图与列表必须任务等价，所有关键动作可聚焦且不存在 hover-only 路径；900/600/360 候选阈值只由真实内容溢出证据校准，变化时同步 UX、UX-DR36、Story AC 和视觉基线。任何缺口回到对应功能 Story 修复，不以独立验证 Story 隐藏遗漏。

### Story 2.1：进入可信的 VS Code 图谱壳层

As a VS Code 开发者，
I want 在工作区信任和安全 Webview 边界内进入图谱功能，
So that 我可以确认产品入口可用且不会在未授权状态读取项目或启动分析。

**依赖：** Epic 1 完成。

**关联需求：** FR-21、FR-22、NFR-8、NFR-13、NFR-27、UX-DR1、UX-DR19、UX-DR20、UX-DR37、AR-19、AR-21、AR-28

**Acceptance Criteria:**

**Given** 工作区已授予 Workspace Trust
**When** extension 激活
**Then** 通过 service-client 发现或启动 Epic 1 graph-service
**And** Activity Bar、TreeView、Status Bar、Command Palette 和 Webview Editor 壳层可用
**And** extension host 不执行索引、SQL、规则计算或复杂布局。

**Given** 工作区未授予信任
**When** extension 激活或执行图谱命令
**Then** 不启动服务、不读取项目、不执行 Git
**And** 唯一主动作是管理 Workspace Trust
**And** 不展示伪造空图谱或失败缓存。

**Given** Webview 创建或 reload
**When** extension 发送 shell model
**Then** 使用严格 CSP、nonce、本地资源根和运行时消息 Schema
**And** 禁止网络访问和直接文件读取
**And** 无效、越界或过期消息安全拒绝。

**Given** Story 2.1 首次公开 VS Code surface
**When** CI 运行
**Then** Electron 激活、Workspace Trust、surface 职责、CSP、消息校验和基础键盘入口为 blocking gate
**And** 留下真实 Webview shell 的宿主版本和安全证据。

### Story 2.10：查看 Getting Started 与权威 Index Status

As a 刚进入图谱体验的开发者，
I want 看到本地处理说明、索引范围、进度、完整性和恢复动作，
So that 我知道图谱当前是否可用、受限或需要重建。

**依赖：** Story 2.1。Story 2.2 不得早于本 Story。

**关联需求：** FR-21、FR-22、NFR-10、NFR-17、NFR-18、NFR-20、UX-DR4、UX-DR15、UX-DR16、UX-DR21、UX-DR22、UX-DR24、UX-DR25、UX-DR34 至 UX-DR37、AR-19

**Acceptance Criteria:**

**Given** 当前没有已提交图谱
**When** 打开 Getting Started
**Then** 解释本地处理和默认不上传
**And** 主动作是构建图谱，辅助入口显示索引范围、排除摘要和 workspace discovery
**And** 不使用空白画布或装饰插画代替状态。

**Given** Job 为 queued、running、cancelled、failed 或已有缓存
**When** 打开 Index Status
**Then** 呈现权威 ServiceStatusV1 和 IndexStatusSummaryV1
**And** 显示阶段、进度、完成范围、生成时间、完整性、日志和恢复动作
**And** stale、failed、cancelled 均保留可用缓存。

**Given** workspace discovery 为 recognized、single 或 degraded
**When** 显示摘要
**Then** recognized 显示类型与 package 数
**And** single 不显示为错误
**And** degraded 说明 package 能力限制并提供检查配置或 rebuild。

**Given** locale 为 zh-CN、en 或未知值
**When** 渲染人类可读状态
**Then** zh-CN 与 en 使用资源文件，未知值回退 en
**And** JSON 字段、错误 code、枚举和 Schema 不本地化
**And** 技术状态附可理解说明。

**Given** 暗色、亮色、高对比、100%/200% 字号和候选断点矩阵
**When** 在真实 VS Code 打开 Getting Started 与 Index Status
**Then** 关键状态、动作和焦点不裁切、不重叠、不只依赖颜色
**And** 记录 hostVersion、theme、zoom、width、OS 和证据引用。

### Story 2.2：通过列表浏览权威项目结构概览

As a 刚接手项目的开发者，
I want 先通过可读列表查看目录、模块和 workspace package 的依赖概览，
So that 我可以快速识别上下游、循环风险和热点区域。

**依赖：** Story 2.10。

**关联需求：** FR-6、FR-10、NFR-2、NFR-3、NFR-8、NFR-17、NFR-21、UX-DR10、UX-DR15、UX-DR16、UX-DR19、UX-DR24、UX-DR25、UX-DR32、UX-DR33、AR-16、AR-17

**Acceptance Criteria:**

**Given** 工作区已有可用图谱
**When** 打开 Project Overview
**Then** extension 请求渲染器无关 GraphViewModel
**And** 模型绑定 serviceInstanceId、statusEpoch、viewId、queryFingerprint 和三组 revision
**And** Webview 不查询 SQLite 或重算指标。

**Given** Overview 生成目录或 workspace package 投影
**When** application/querying 建立 ProjectionMembershipV1
**Then** 每个文件只属于一个当前叶子聚合节点
**And** scopeRoot、groupBy、aggregationDepth 和 membershipDigest 进入查询身份
**And** 聚合通过 hiddenNodeCount 和 expandToken 表达，不伪装成领域实体。

**Given** 服务计算依赖强度、循环风险和热点
**When** 生成 OverviewMetricV1
**Then** dependencyStrength 统计不同 high-confidence 文件级 imports
**And** 热点按 error、warning、cycleMemberCount、internalDependencyStrength 和规范 node ID 稳定排序
**And** 复用 Epic 1 的 BaseCycleProjectionV1，不依赖未来 rules Story。

**Given** freshness=current 且 completeness=complete
**When** 展示排名
**Then** 可以显示正式排名徽标
**And** stale 标记“可能过期”、partial 标记“基于部分结果”
**And** 二者不得显示正式排名。

**Given** 列表显示 file、directory、workspace-package、external-package 和 node-builtin
**When** 用户浏览聚合节点和依赖行
**Then** 使用一致的文本类型、相对路径、方向、强度、循环和热点字段
**And** Node built-in 使用 node: 前缀和“Node 内置模块”名称
**And** 列表可独立完成识别上下游、循环和热点任务。

**Given** 图谱 indexing、stale、partial、degraded 或超规模
**When** 打开 Overview
**Then** 立即显示已提交结果和 IndexSummary
**And** 解释完整性、范围与恢复动作
**And** 不清空画布或阻塞 extension host/Webview 主线程。

**Given** 标准项目和参考环境
**When** clean cache 首次 rebuild 并打开 Overview
**Then** p95 在 60 秒内可用
**And** 首个可用结果包含权威范围、完整性和更新时间
**And** 超时保留进度并不宣称结果完整。

### Story 2.3：以图形探索 Overview 并展开聚合

As a 需要探索项目关系的开发者，
I want 在权威 Overview 列表之上使用图形视图和预算内展开，
So that 我可以直观看到依赖方向，同时保留可访问的文本退路和空间上下文。

**关联需求：** FR-6、FR-10、NFR-6、NFR-8、NFR-17 至 NFR-20、UX-DR1、UX-DR2、UX-DR3、UX-DR5 至 UX-DR10、UX-DR31、UX-DR33 至 UX-DR37

**Acceptance Criteria:**

**Given** Story 2.2 的 Overview 模型可用
**When** 用户切换到 GraphCanvas
**Then** 图只消费同一预算内 GraphViewModel
**And** Webview 不查询 SQLite、重算指标或改变排序
**And** 布局在 Web Worker 执行。

**Given** 图形视图渲染实体和关系
**When** 显示 file、directory、workspace-package、external-package 和 node-builtin
**Then** 使用文字、轮廓、图标、箭头、线型和图例共同表达语义
**And** Node built-in 使用 node: 前缀、“Node 内置模块”、独立图标和点线轮廓
**And** 风险、置信度和状态不只依赖颜色。

**Given** 用户在图和列表之间切换
**When** ViewModeSwitch 改变
**Then** 保留选择、筛选、范围、排序、缩放和滚动位置
**And** 两种模式使用同一实体与关系名称
**And** 不强制自动缩放或重新洗牌整个图谱。

**Given** 用户展开聚合节点
**When** 使用服务签发的 expandToken
**Then** 以新的局部预算查询并显示 hiddenNodeCount 变化
**And** 不无限追加全局节点
**And** 达到上限时提供缩小范围或切回列表。

**Given** 数据刷新且稳定 ID 仍存在
**When** 应用精确 patch 或完整模型
**Then** 保留中心节点、选择、展开层级、缩放和视口
**And** 减少动态效果开启时直接稳定到新位置。

**Given** 用户使用键盘、屏幕阅读器、暗色、亮色、高对比、200% 字号或窄宽度
**When** 完成 Overview 探索任务
**Then** Tab、方向键、Enter、Space、Esc 和等价列表均可完成任务
**And** 焦点、标签、详情和主要动作不丢失
**And** 真实 Webview 证据进入 Epic 2 blocking gate。

### Story 2.4：通过列表查看当前文件依赖邻域

As a 正在修改代码的开发者，
I want 打开文件时立即通过可读列表查看其直接依赖、反向依赖和外部关系，
So that 我可以快速判断改动可能影响的文件与模块。

**关联需求：** FR-7、FR-10、NFR-4、NFR-6、NFR-17、UX-DR10、UX-DR23、UX-DR25、UX-DR27、UX-DR32、UX-DR33

**Acceptance Criteria:**

**Given** 用户打开已索引源码文件
**When** Current Context 收到活动文件变化
**Then** 以工作区相对路径请求一跳邻域
**And** warm cache p95 在 300ms 内显示
**And** 后台刷新期间旧结果继续可操作。

**Given** 邻域包含内部文件、workspace package、外部 npm 包或 Node built-in
**When** 列表渲染
**Then** 明确区分直接、反向、外部和低置信关系
**And** 每条边显示方向、来源、置信度和 qualifier
**And** 不把低置信关系表现为确定风险。

**Given** 服务生成默认查询
**When** 建立 queryFingerprint
**Then** 深度为一跳，预算为 100 节点、200 边
**And** 身份覆盖中心、范围、方向、过滤、预算、聚合、排名版本、展开链和 viewConfigRevision
**And** 不包含数据 revision、遥测或日志配置。

**Given** 邻域超过预算
**When** 服务截断
**Then** 按目录或 workspace package 聚合远端内容
**And** 返回省略数量、原因和 expandToken
**And** 用户可缩小范围、展开选定聚合或切换列表。

**Given** 用户只使用列表或屏幕阅读器
**When** 浏览邻域
**Then** 可独立回答依赖谁、谁依赖它及关系可信度
**And** 节点名称、类型、入/出边数、Finding 数和关系方向可宣读
**And** 完成任务不依赖画布几何。

**Given** 邻域为空、文件被排除、不受支持、stale 或查询超过 500ms
**When** Current Context 渲染
**Then** 说明范围、原因、更新时间和下一步
**And** 慢查询保留旧结果并显示进行中
**And** 不静默切换中心或显示空白画布。

**Given** 查询身份、中心或 revision 变化
**When** 更新列表
**Then** 同一 epoch 仅接受身份与三组时钟连续的结果
**And** 断档或不匹配时全量重取
**And** 不显示混合快照。

### Story 2.5：以图形探索邻域并保持空间上下文

As a 需要沿依赖关系探索的开发者，
I want 在 Current Context 中使用图形视图并按预算展开，
So that 我可以保留当前文件锚点和空间记忆地检查影响路径。

**关联需求：** FR-7、FR-10、NFR-6、NFR-8、NFR-17 至 NFR-20、UX-DR1 至 UX-DR10、UX-DR27、UX-DR29、UX-DR31、UX-DR33 至 UX-DR37

**Acceptance Criteria:**

**Given** Story 2.4 的邻域模型可用
**When** 用户切换到 GraphCanvas
**Then** 当前文件成为稳定中心节点
**And** 直接、反向、外部和低置信关系通过箭头、文字、线型和图例区分
**And** 图与列表使用同一 GraphViewModel。

**Given** 用户展开聚合或聚焦相邻实体
**When** 服务处理 expandToken 或新中心查询
**Then** 每次返回受预算限制的局部子图
**And** 保留来源、置信度、qualifier 和截断原因
**And** 不允许无上限累积全局节点。

**Given** 用户切换图与列表或后台刷新完成
**When** 稳定 ID 仍存在
**Then** 保留中心、选择、筛选、范围、展开、缩放和列表位置
**And** 不使用空画布过渡、持续力导漂移或强制适应视图。

**Given** 查询超过 500ms、结果 stale、partial 或失败
**When** GraphCanvas 更新
**Then** 保留旧结果并显示权威状态、原因和下一步
**And** 不宣布结果 current
**And** 允许切回完整可用的列表。

**Given** 用户使用键盘、屏幕阅读器、高对比、200% 字号或减少动态效果
**When** 浏览 Current Context
**Then** Tab、方向键、Enter、Space、Esc 可完成选择、展开和返回
**And** 焦点与可访问名称完整
**And** 减少动态效果时直接稳定到新位置。

### Story 2.6：跟随编辑器并固定当前上下文

As a 同时查看多个相关文件的开发者，
I want 在自动跟随和固定图谱上下文之间切换，
So that 我可以比较代码而不丢失正在分析的范围。

**关联需求：** FR-8、UX-DR6、UX-DR11、UX-DR27、UX-DR28、UX-DR29、AR-20

**Acceptance Criteria:**

**Given** ContextLock 未固定
**When** 用户切换受支持文件
**Then** 中心立即切换并先显示缓存结果
**And** 后台刷新不使用空画布过渡
**And** 控件持续显示“跟随编辑器”。

**Given** 用户固定当前上下文
**When** 后续切换编辑器文件
**Then** 图谱中心保持固定路径
**And** ContextLock 使用图钉、文字和可见焦点语义
**And** 用户仍可浏览其他源码。

**Given** 用户解除固定
**When** 当前编辑器存在受支持文件
**Then** 立即聚焦该文件并恢复缓存优先刷新
**And** 不保留失效固定目标。

**Given** Webview reload
**When** extension-host 会话仍存在
**Then** 可从 extension 内存恢复固定目标
**And** workspaceState/globalState 不保存固定标记
**And** 窗口 reload、VS Code 重启或重新打开工作区后恢复跟随模式。

**Given** patch 或完整模型到达
**When** viewId、queryFingerprint、epoch 或 revision 不匹配
**Then** 丢弃旧消息并全量重取
**And** 不污染当前固定上下文
**And** 稳定 ID 存在时保留选择、展开、缩放和列表位置。

**Given** 固定目标移动、删除、被排除或越界
**When** 恢复或刷新
**Then** 保留旧相对路径作为证据
**And** 提供 rebuild、解除固定和检查排除动作
**And** 不跳转到同名但身份不同的文件。

**Given** 候选快捷键进入实现
**When** 在 VS Code 1.125.0、最新稳定版和前一稳定版上检查 Windows/Linux 的 Ctrl+Alt+G、Ctrl+Alt+P 或 macOS 的 Cmd+Option+G、Cmd+Option+P
**Then** 任一候选覆盖宿主默认、Accessibility Help、产品自身命令或可访问性关键命令时，该平台不注册默认绑定
**And** 第三方扩展冲突记录为可重映射兼容信息，不维护无界“主流扩展”清单
**And** Command Palette 和可聚焦 ContextLock 始终完成同一任务
**And** 证据记录 hostVersion、OS、keyboardLayout、candidate、conflictTarget 和 disposition。

### Story 2.7：查看实体详情并导航源码

As a 分析依赖关系的开发者，
I want 查看实体与关系证据并导航到源码，
So that 我可以从结构视图进入需要阅读或修改的位置。

**关联需求：** FR-9、UX-DR8、UX-DR9、UX-DR12、UX-DR13、UX-DR25、UX-DR29

**Acceptance Criteria:**

**Given** 用户选择任意实体
**When** 打开 NodeDetails
**Then** 显示相对路径或 externalId、实体类型、入/出边、更新时间、来源、置信度和 Finding 摘要
**And** Findings 为空时仍完整工作，不依赖未来规则能力
**And** 完整路径不被节点标签截断规则隐藏。

**Given** 目标为 file、directory、workspace-package 或 BasicSymbolV1
**When** 用户打开或聚焦
**Then** 使用封闭 NavigationTargetV1
**And** symbol 使用稳定 ID、相对路径和 0-based UTF-16 半开范围
**And** Webview 不接收绝对路径。

**Given** 目标为外部 npm 包或 Node built-in
**When** 打开详情
**Then** 显示 externalKind、externalId、displayName 和关联边
**And** 不伪造本地 NavigationTarget
**And** Node built-in 使用一致文本与屏幕阅读器语义。

**Given** 用户选择 GraphEdge
**When** 查看关系详情
**Then** 显示起点、方向、终点、relation type、qualifier、来源、置信度和检测时间
**And** 可分别聚焦本地端点
**And** 不把静态依赖表述为运行时调用。

**Given** 用户复制路径
**When** 目标为工作区内部实体
**Then** 复制相对 POSIX 路径
**And** 不复制绝对路径、数据库主键或内部实现细节
**And** 给出非阻塞反馈。

**Given** 目标缺失、移动、越界或指向外部 symlink
**When** 导航前验证
**Then** 拒绝不安全跳转
**And** 保留旧证据并提供 rebuild
**And** 不静默失败或打开错误文件。

**Given** 用户使用键盘、屏幕阅读器或窄宽度
**When** 操作 NodeDetails
**Then** 所有主要动作可聚焦并按阅读顺序导航
**And** 详情在宽屏右置、窄屏折叠或下置时不丢失内容和选择。

### Story 2.8：保存后增量提交权威图谱 revision

As a 持续修改代码的开发者，
I want 保存后服务在后台收敛并提交最新图谱 revision，
So that 即使发生重复事件、竞态或分析失败，我仍能继续使用上一份可信结果并最终得到最新事实。

**依赖：** Story 2.7 和 Epic 1 的增量分析基础。

**关联需求：** FR-3、FR-22、NFR-5、NFR-9、NFR-10、AR-4、AR-5、AR-12、AR-13

**Acceptance Criteria:**

**Given** 用户保存受支持文件
**When** watcher 产生变化候选
**Then** 按规范路径合并并经过 quiet window、最大等待和内容 hash 去重
**And** hash 未变化时不启动重复分析
**And** watcher 不被视为强一致证明。

**Given** 稳定内容与已提交 digest 不同
**When** 创建 incremental Job
**Then** freshness 立即 stale
**And** Job 进入唯一 snapshot mutation channel
**And** Analyzer 只处理受影响 ownership slice，旧缓存继续可读。

**Given** FactBatch 有效
**When** 提交 GraphPatch 和受影响派生结果
**Then** 节点、边、Evidence、revision 和当前切片要求的派生状态原子提交
**And** 提交前 CAS manifest、input、ignore、rules 和 bootstrap generation
**And** 过期结果丢弃并有界重排。

**Given** 分析失败、partial、cancelled、事件风暴或 watcher 丢事件
**When** Job 结束或 reconciliation 触发
**Then** 保留最新提交结果并准确显示 failed、partial、cancelled 或 stale
**And** 显式 rebuild 吸收未执行增量任务
**And** 队列有界并最终与完整 manifest 对账一致。

**Given** 服务提交新 revision
**When** 发布状态事件
**Then** 携带 serviceInstanceId、statusEpoch、graphRevision、findingsRevision 和 statusRevision
**And** 不在服务提交前宣布 current。

### Story 2.11：原子刷新当前视图并保持空间上下文

As a 正在阅读依赖关系的开发者，
I want 新 revision 一次性更新当前视图并保留我的位置和选择，
So that 保存后的最新结果不会通过跳动、半更新或错误 patch 打断我的判断。

**依赖：** Story 2.8。Story 2.9 可在本 Story 后执行。

**关联需求：** FR-3、FR-22、NFR-5、NFR-8、NFR-10、NFR-17、NFR-20、UX-DR6、UX-DR15、UX-DR23、UX-DR27、UX-DR30、UX-DR32、AR-11、AR-20

**Acceptance Criteria:**

**Given** 当前物化视图受新 revision 影响
**When** 服务生成 GraphViewPatchV1
**Then** delta 完整覆盖节点、边、Finding、排序、聚合、截断、workspace discovery 和状态
**And** patch 绑定 viewId、queryFingerprint、serviceInstanceId、statusEpoch 和三组 revision
**And** 无法精确差量时发送 invalidate。

**Given** 客户端收到 patch
**When** 身份和基线时钟全部匹配
**Then** 一次性应用完整 delta
**And** 任一不匹配时丢弃 patch 并全量重取
**And** 不显示混合 revision。

**Given** 稳定 ID 仍存在
**When** 应用刷新结果
**Then** 保留中心、选择、ContextLock、展开、缩放、筛选和列表位置
**And** 不持续动画、强制适应视图、清空画布或弹模态框。

**Given** 标准项目和参考环境
**When** 用户保存文件
**Then** 从宿主 save 到对应 graph/Findings revision 在 UI 可见的 p95 不超过 2 秒
**And** 超时继续显示更新中且不宣布 current
**And** extension host 与 Webview 主线程不被阻塞。

**Given** 服务状态为 failed、partial、cancelled 或 stale
**When** 当前视图无法更新
**Then** 保留上一份完整视图并显示原因和恢复动作
**And** 屏幕阅读器和列表获得与图一致的状态说明。

### Story 2.9：在 VS Code 中查看并控制遥测状态

As a 注重隐私的 VS Code 用户，
I want 在 Settings & Rules 中查看并控制服务确认的遥测状态，
So that 我能理解当前是否发送数据并立即关闭可选遥测。

**依赖：** Story 2.11。

**关联需求：** FR-19、UX-DR4、UX-DR19、UX-DR26、UX-DR34

**Acceptance Criteria:**

**Given** 用户打开 Settings & Rules
**When** extension 读取 ServiceStatusV1
**Then** 显示 TelemetryStatusV1 的 requested、effective、pending 和 revision
**And** UI 不从本地设置猜测生效状态
**And** 默认显示关闭且核心能力不受影响。

**Given** 用户选择 opt-in
**When** extension 提交 service/reconfigure
**Then** 明确列出允许的匿名事件、耗时、计数和错误分类
**And** 明确排除源码、完整路径、符号、diff、图谱和规则
**And** pending 状态持续可见直到服务确认。

**Given** 用户选择关闭
**When** 服务返回已应用 off revision
**Then** UI 立即显示 effective off 和本地生效
**And** 不等待索引 Job 或要求重启 VS Code
**And** 持续提供可理解的隐私说明。

**Given** CLI 或另一 VS Code 客户端同时修改遥测
**When** statusChanged 到达
**Then** UI 按 serviceStatusRevision 接受最新权威快照
**And** 不覆盖或合并旧 epoch 状态
**And** 显示最终来源和 latest-wins 结果。

**Given** locale、主题、键盘或屏幕阅读器变化
**When** 操作遥测设置
**Then** 文案支持 zh-CN/en，未知 locale 回退 en
**And** 所有状态和动作可聚焦、可宣读且不只依赖颜色
**And** Webview 不接收遥测 payload 或敏感项目数据。

## Epic 3：在编码时发现并解释架构风险

用户可以声明架构规则，在保存代码或运行 CLI check 时发现循环、禁止依赖和层级违规，并获得稳定、可定位、可解释且具有正确生命周期的 Finding。

### Story 3.1：解析并应用有效的架构规则配置

As a Tech Lead，
I want 使用严格版本化的 .codegraph/rules.yaml 声明有效架构约束，
So that 团队拥有确定、可共享且不会被不同入口重新解释的规则合同。

**关联需求：** FR-12、UX-DR13、AR-14

**Acceptance Criteria:**

**Given** 工作区不存在 rules.yaml
**When** 服务完成配置屏障
**Then** 建立 generation 0、validity valid 的合法 RulesV1 空策略
**And** effectiveRulesDigest 与 lastValidRulesDigest 均为 EMPTY_RULES_DIGEST
**And** 缺少文件不显示为错误。

**Given** 工作区存在 rules v1
**When** graph-service 加载
**Then** 使用 yaml 保留 CST 和范围
**And** 使用 JSON Schema 2020-12 与 Ajv 严格校验
**And** version 必须为 1，所有对象拒绝未知字段
**And** 其他模块不得再次解析原文件。

**Given** 配置包含规则
**When** Schema 验证
**Then** ID 全局唯一，type 只允许 forbidden-dependency、layer-order、no-cycle
**And** severity 只允许 warning/error
**And** 各类型必填字段和 no-cycle scope 被严格验证。

**Given** 配置包含路径 glob 和全局 ignore
**When** 编译内部模型
**Then** 路径使用工作区相对 POSIX 语义
**And** * 匹配一段、** 可跨目录
**And** rules ignore 只裁剪规则评估，不删除规范图谱或改变索引规模
**And** 不支持任意表达式、正则组合、规则继承或符号级规则。

**Given** RulesV1 有效
**When** 建立规则快照
**Then** 默认值显式化后使用 RFC 8785 JCS、UTF-8 和 SHA-256 生成 digest
**And** generation 标记 valid
**And** 编译模型不包含 YAML/Ajv 实现概念。

**Given** 用户运行 status、doctor 或配置预检
**When** 读取有效规则快照
**Then** 返回 version、generation、validity、effectiveRulesDigest 和规则摘要
**And** 不输出完整规则内容、绝对路径或解析器内部对象。

### Story 3.2：从无效规则配置恢复 last-valid 策略

As a Tech Lead，
I want 无效 rules.yaml 安全失败并保留最后有效策略，
So that 配置错误不会让既有 Finding 消失或阻塞图谱更新。

**关联需求：** FR-12、FR-14、FR-22、NFR-10、NFR-11、AR-14、AR-15

**Acceptance Criteria:**

**Given** 文件任意变化或新配置无效
**When** 建立新 generation
**Then** generation 推进且 Findings freshness 立即 stale
**And** 无效时保留最后有效 digest，首次无效保留 EMPTY_RULES_DIGEST
**And** GraphPatch 不被阻塞，旧 Findings 标记 stale 且禁止 resolved。

**Given** 当前服务已有有效规则快照
**When** 后续文件出现 YAML、Schema 或语义错误
**Then** effectiveRulesDigest 和 lastValidRulesDigest 保持最后有效值
**And** invalid generation 不产生新权威 Finding
**And** 已提交图谱仍可查询和增量更新。

**Given** 服务首次启动即遇到无效 rules.yaml
**When** 不存在可信历史有效策略
**Then** 使用 EMPTY_RULES_DIGEST 对应的合法空策略作为 effective policy
**And** 快照 validity 保持 invalid
**And** UI 与 CLI 不把空策略表述为配置有效。

**Given** 用户修复 rules.yaml
**When** 新 generation 通过完整校验
**Then** 建立新的 valid digest 并触发完整适用 scope 重评
**And** 只有重评成功后才允许 Finding active/resolved 状态变为权威
**And** 旧 invalid generation 结果无法覆盖新策略。

### Story 3.3：收敛规则配置变化与快照提交

As a 持续维护规则的 Tech Lead，
I want 文件监听、对账和版本栅栏可靠收敛到唯一规则快照，
So that 并发保存或丢失事件不会让旧规则结果覆盖新配置。

**关联需求：** FR-12、FR-22、NFR-9、NFR-10、AR-5、AR-13、AR-14、AR-15

**Acceptance Criteria:**

**Given** rules.yaml 原始内容发生任意变化
**When** watcher 或 reconciliation 发现候选
**Then** generation 推进并记录 content/read-set 变化
**And** Findings freshness 立即 stale
**And** watcher 不被视为文件系统强一致证明。

**Given** 服务启动、watcher overflow、配置快速连续保存或显式 check
**When** 完成或复用 reconciliation
**Then** RulesSnapshotRef、EffectiveIgnoreSnapshotV1、manifest 和 baseGraphRevision 在同一读取边界收敛
**And** 老 generation 的编译或评估结果被丢弃并重排。

**Given** 规则快照准备推进 findingsRevision
**When** 进入 snapshot mutation channel
**Then** CAS baseGraphRevision 和完整 RulesSnapshotRef
**And** CAS 失败不发布混合策略结果
**And** graphRevision 只在图谱实际变化时推进。

**Given** 只有等价默认化后的规则内容未变化
**When** 计算 effectiveRulesDigest
**Then** generation 仍可作为并发栅栏推进
**And** 相同 digest 不制造重复 Finding 身份
**And** status/doctor 报告当前 generation 与实际 effective digest。

### Story 3.4：定位规则配置错误并限制恶意输入

As a 需要修复规则文件的 Tech Lead，
I want 获得精确位置、问题值和安全失败诊断，
So that 拼写错误或恶意 YAML 不会被静默忽略或危及本地服务。

**关联需求：** FR-12、FR-14、UX-DR13、UX-DR14、AR-14、AR-21、AR-28

**Acceptance Criteria:**

**Given** YAML 或 Schema 错误
**When** 生成 ConfigDiagnosticV1
**Then** 包含 code、severity、message、relativePath、range、instancePath、invalidValue 和 suggestedAction
**And** JSON Pointer 映射回精确 YAML 范围
**And** Problems、CLI 和 doctor 复用同一合同。

**Given** 配置存在重复 ID、未知字段、未知类型、缺失字段或非法 severity/scope
**When** 生成修复提示
**Then** 诊断指出具体问题值和对应范围
**And** 提供针对性 suggestedAction
**And** 不使用“配置无效”一类无法定位的模糊消息。

**Given** 配置超过 1000 条规则、50 个 alias 或包含恶意构造
**When** 解析
**Then** 返回稳定诊断且不静默截断
**And** 不执行对象构造、项目脚本或记录规则内容
**And** 图谱与最后有效 Findings 保持可用。

**Given** 规则文件路径越界、指向 indexing root 外部 symlink 或包含超预算输入
**When** graph-service 验证
**Then** realpath 后越界内容被拒绝
**And** 不读取工作区外部规则或执行项目代码
**And** 返回不泄露绝对路径的稳定诊断。

**Given** Rules Schema 与诊断能力首次公开落地
**When** CI 运行
**Then** 覆盖合法配置、未知字段、重复 ID、范围映射、恶意 alias、超限和外部 symlink
**And** 任一失败阻止合并。

### Story 3.5：检测禁止依赖与层级方向违规

As a Tech Lead，
I want 检查禁止依赖和层级方向规则，
So that 团队能获得指向具体依赖边的可靠越界证据。

**关联需求：** FR-12、FR-14、AR-14、AR-15

**Acceptance Criteria:**

**Given** 有效快照包含 forbidden-dependency
**When** 编译 from/to 模式
**Then** 生成不依赖 YAML 的内部单边约束
**And** 保留稳定 ruleId、名称和 severity
**And** 使用索引排除后的图，再应用 rules ignore。

**Given** high-confidence 依赖边匹配 from 到 to
**When** 执行评估
**Then** 生成 active Finding
**And** 指向实际 edgeId、方向和相对源码位置
**And** expectedConstraint 解释禁止方向。

**Given** 有效快照包含 layer-order
**When** 评估有序层
**Then** 每层可依赖自身及后续层
**And** 反向依赖前序层时生成 Finding
**And** 同层和合法向下依赖不误报。

**Given** Evidence 为 medium 或 low
**When** 规则引擎评估
**Then** 该边不产生 v1 warning/error Finding
**And** 关系仍可显示和导出来源及置信度。

**Given** 同一 edge 违反多个规则
**When** 生成 Finding
**Then** 每个 ruleId 产生独立身份
**And** 同一 ruleId、scope、edgeId 不重复
**And** rebuild 后 findingId 稳定。

**Given** 构建 FindingSummaryV1
**When** 提交结果
**Then** subject 使用 edge{edgeId}
**And** 包含 actualRelation、expectedConstraint、relativeLocations 和 boundGraphRevision
**And** 不暴露绝对路径或数据库主键。

**Given** 完整 rebuild 或显式规则评估
**When** 提交图谱和 Findings
**Then** 通过唯一 mutation channel 原子推进适用 revision
**And** 绑定实际 rules/ignore digest
**And** CAS 失败时丢弃并重排。

### Story 3.6：检测并解释循环依赖

As a 开发者或 Tech Lead，
I want 检测文件、目录和 package 级循环并查看确定性路径，
So that 我可以理解形成耦合闭环的具体结构。

**关联需求：** FR-11、FR-12、FR-14、AR-16

**Acceptance Criteria:**

**Given** 有效规则包含 no-cycle
**When** 编译规则
**Then** scope 只允许 file、directory、package
**And** 在索引排除及 rules ignore 后的 high-confidence 有向图上运行
**And** 复用 Epic 1 CycleProjectionKernelV1。

**Given** 过滤图包含 SCC
**When** 执行循环检测
**Then** 大小大于 1 或文件自环产生一个 Finding
**And** 无自环单节点不产生 Finding
**And** 不按所有 simple cycle 制造重复告警。

**Given** scope 为 directory 或 package
**When** 构建投影
**Then** 复用 ProjectionMembershipV1 折叠、去重并移除聚合自边
**And** package 只在 workspace recognized 时权威计算
**And** 外部 package 不进入内部循环。

**Given** SCC 被识别
**When** 生成 canonical subject
**Then** 使用规范 node ID 排序数组
**And** findingId 由 ruleId、scope 和 subject 确定
**And** 输入枚举顺序不影响身份。

**Given** Finding 需要代表路径
**When** 选择证据
**Then** 从最小 node 开始，按 edge ID 升序 DFS
**And** 第一条闭合路径作为 evidencePathEdgeIds
**And** 相同输入始终返回相同路径。

**Given** 当前没有循环或缺少显式比较基线
**When** 查询结果
**Then** 返回带范围/revision 的权威空集或 active Finding
**And** comparison 可为 not-applicable
**And** 不把未评估范围表述为永久无风险。

### Story 3.7：维护 Finding 身份与生命周期

As a 持续修改代码的开发者，
I want Finding 保持稳定身份并准确表达 active、resolved 和 stale，
So that 同一风险不会重复出现或在不完整评估中错误消失。

**关联需求：** FR-13、FR-14、AR-15

**Acceptance Criteria:**

**Given** Finding 在有效完整评估中首次出现
**When** findingsRevision 提交
**Then** 状态为 active
**And** firstSeen 与 lastSeen 均为当前 revision
**And** 绑定实际 graphRevision 和策略 digest。

**Given** 同一 canonical Finding 后续仍存在
**When** 提交新 revision
**Then** 保留 findingId 和 firstSeen
**And** 更新 lastSeen 与 boundGraphRevision
**And** 不重复生成行或诊断。

**Given** Job 具有 baseFindingsRevision
**When** 对 active Finding 分类
**Then** 相对基线首次出现为 new，已存在为 existing
**And** comparisonContext 记录 job 基线
**And** 无基线时为 not-applicable。

**Given** 违规在有效策略和完整 scope 中消失
**When** 评估成功
**Then** 既有 Finding 转 resolved
**And** 保留身份、历史 revision 和证据摘要
**And** 不物理删除审计记录。

**Given** 图谱 partial/stale、scope 不完整或配置无效
**When** 新结果缺少既有 Finding
**Then** 只能转 stale，不能 resolved
**And** comparison 为 not-applicable
**And** 记录不完整原因。

**Given** 只有规则配置变化
**When** 有效策略重评
**Then** graphRevision 可不变
**And** findingsRevision 必须推进
**And** 生命周期绑定新 digest 和原 graphRevision。

### Story 3.8：增量重评规则并保证提交一致性

As a 正在保存代码的开发者，
I want 系统只重评受影响规则并原子提交结果，
So that Findings 能及时更新且不会混入旧图谱或旧配置结论。

**关联需求：** FR-13、FR-14、NFR-5、NFR-9、NFR-10、AR-4、AR-5、AR-13、AR-15

**Acceptance Criteria:**

**Given** 增量 GraphPatch 改变 high-confidence 依赖
**When** 计算规则影响范围
**Then** 只重评可能受影响的规则和 scope
**And** 未受影响 Finding 保持身份与状态
**And** 不执行无界全图扫描。

**Given** 图谱和规则结果准备提交
**When** 进入 mutation transaction
**Then** CAS baseGraphRevision、完整 RulesSnapshotRef 和 EffectiveIgnoreSnapshotV1
**And** GraphPatch 与 Findings 原子可见
**And** 任何 CAS 失败丢弃全部评估结果并重排。

**Given** rules 或 ignore generation 无效
**When** GraphPatch 仍可提交
**Then** graphRevision 可以推进
**And** findingsRevision 推进以发布 stale
**And** 禁止产生新权威 Finding 或 resolved。

**Given** rules.yaml 热更新且图谱不变
**When** 新策略有效
**Then** 在完整 scope 重评
**And** findingsRevision 单独推进
**And** 老 generation 结果不能覆盖新策略。

**Given** watcher 丢事件、配置变化或显式 check
**When** 开始评估
**Then** 完成或复用 reconciliation
**And** 使用最近 bootstrap/config read-set
**And** 最终结果与文件系统快照收敛。

**Given** 标准项目和参考环境
**When** 保存影响规则的文件
**Then** graph/Findings revision 可见 p95 不超过 2 秒
**And** 超时保留旧 Findings 并显示 updating/stale
**And** 不阻塞宿主线程。

**Given** 本 Story 首次落地增量规则能力
**When** CI 运行
**Then** 覆盖受影响范围、CAS 失败、无效配置、热更新、partial scope 和 2 秒门禁
**And** 不使用 skip 或无断言占位。

### Story 3.9：在 VS Code 中查看并修复 Findings

As a 正在修复结构问题的开发者，
I want 在 VS Code 中查看、定位并验证 Findings，
So that 我可以理解具体证据并确认修复是否生效。

**关联需求：** FR-9、FR-10、FR-13、FR-14、UX-DR2、UX-DR12、UX-DR13、UX-DR14、UX-DR23、UX-DR29、UX-DR34

**Acceptance Criteria:**

**Given** 服务发布 Finding 变化
**When** extension 更新 Problems、Findings、NodeDetails 和图节点
**Then** 所有 surface 复用同一 FindingSummaryV1
**And** 不重算身份、severity、生命周期或 comparison
**And** 更新非阻塞且不重排整个图谱。

**Given** 用户查看禁止依赖、层级或循环 Finding
**When** 渲染 FindingRow
**Then** 显示 rule ID、名称、severity、状态、actual、expected、路径、时间和 comparison
**And** 循环显示确定性代表路径
**And** 不使用模糊告警替代证据。

**Given** 结果包含 new、existing、resolved 或 stale
**When** 分组
**Then** new 优先、existing 可折叠、resolved 明确已修复
**And** stale 解释配置或完整性限制
**And** stale 不展示 new/existing 结论。

**Given** Finding 或 ConfigDiagnostic 有定位范围
**When** 用户打开证据
**Then** 使用相对路径和 SourceRangeV1 跳转源码或 rules.yaml
**And** 文件缺失时保留证据并提供 rebuild
**And** Webview 不接收绝对路径。

**Given** 用户修改源码或规则后保存
**When** 生命周期更新
**Then** 原行按稳定 findingId 更新
**And** 不闪现重复 Finding
**And** 当前选择、中心和空间记忆保持。

**Given** 当前没有 active Finding
**When** 打开 Findings
**Then** 显示范围、revision 和更新时间
**And** stale 或配置无效时不显示权威无风险结论
**And** 不暗示全仓库永久无风险。

**Given** 用户使用键盘、屏幕阅读器或高对比主题
**When** 浏览 FindingRow 和修复动作
**Then** actual、expected、severity、状态和位置可宣读
**And** 所有跳转可聚焦且不只依赖颜色或 hover。

### Story 3.10：使用 CLI 执行规则检查

As a 开发者或 CI 维护者，
I want 使用 codegraph check 获得稳定的文本和机器结果，
So that 本地开发与自动化可以一致判断架构规则是否通过。

**关联需求：** FR-15、FR-20、AR-22、AR-28

**Acceptance Criteria:**

**Given** 用户运行 codegraph check
**When** graph-service 接收请求
**Then** 先完成或复用 source、manifest、ignore 和 rules reconciliation
**And** 复用统一规则能力，不读取 SQLite 或重新解析配置
**And** 只读 Job 不改变 committed cache。

**Given** 当前图谱和策略有效
**When** 选择快照
**Then** 结果携带 graphRevision、findingsRevision、rules digest 和评估范围
**And** 只读取已提交快照
**And** Job 只通过 job/get 暴露。

**Given** 使用文本或 JSON 模式
**When** check 完成
**Then** 文本显示 summary、Finding、severity、actual、expected 和相对位置
**And** JSON stdout 只包含 schemaVersion 1 envelope 与 FindingSummaryV1
**And** 进度写 stderr，机器模式无 ANSI。

**Given** 无 active error 或只有 warning
**When** check 结束
**Then** 返回 0
**And** warning 仍完整输出
**And** resolved 不导致失败。

**Given** 存在 active error
**When** check 结束
**Then** 返回 1
**And** 相同 revision 重复 check 结果相同
**And** stale 不被当作权威通过或 error。

**Given** 配置/输入无效、内部失败、协议不兼容或取消
**When** check 结束
**Then** 分别返回 2、3、4、130
**And** 复用精确诊断并保留缓存
**And** 堆栈只进入本地日志。

**Given** CLI check 首次公开落地
**When** CI 运行
**Then** 锁定 Rules Schema、Finding 生命周期、配置诊断、JSON、stdout/stderr 和退出码
**And** 无网络环境下功能完整且不泄露规则、源码或绝对路径。

## Epic 4：审查变更并导出可共享的结构上下文

Tech Lead 可以分析 Git 变更，获得统一的结构影响 verdict 和可直接用于 PR review 的 Markdown；开发者可以导出默认不含源码的结构上下文用于 AI 或人工协作。

### Story 4.1：选择并规范化 Git 变更集合

As a 正在审查本地改动的 Tech Lead，
I want 选择 working tree、staged 或指定 base ref 作为分析范围，
So that 后续影响计算建立在明确、可重复的变更集合和基线上。

**关联需求：** FR-16、AR-13、AR-18

**Acceptance Criteria:**

**Given** 用户选择 working tree、staged 或 base ref
**When** git-local adapter 构建 ChangeSet
**Then** 识别受支持文件的新增、删除、修改和移动
**And** 所有路径规范化为工作区相对 POSIX
**And** ChangeSourcePort 不执行影响计算。

**Given** 用户提供 branch、tag、短 SHA 或其他 ref
**When** 规范化比较基线
**Then** 解析完整 commit OID、Git object-format、workspace-key 和 subroot
**And** 原 ref 只作为显示元数据
**And** 相同输入生成相同 canonical baseRef。

**Given** 服务生成 baselineId
**When** 绑定基线结构
**Then** 哈希 canonical baseRef、规则/config digest 和派生输入
**And** 临时 Git 基线不复用或推进主图 revision
**And** 记录实际 derivedFrom graph/findings revision。

**Given** impact 请求开始
**When** 调度只读 Job
**Then** 先完成或复用 manifest、source、config、ignore 和 rules reconciliation
**And** Job 只通过 job/get 暴露
**And** 取消或失败不改变 committed cache。

**Given** ChangeSet 包含 rename、大小写变化或无法可靠对应的移动
**When** 规范化
**Then** 尽可能保留新旧路径对应
**And** 不可靠时明确标记降级诊断
**And** 不静默把移动误报为无关删除和新增。

**Given** Git 不可用、base ref 无效、工作区非仓库或状态不完整
**When** 请求变更集合
**Then** 返回稳定 Git 诊断和替代命令建议
**And** 不生成空成功结果
**And** 不修改分支、暂存区或工作树。

**Given** 路径越界、指向外部 symlink 或已被索引排除
**When** 验证范围
**Then** 越界内容被拒绝，排除内容不进入影响计算
**And** 不执行项目 hook 或脚本
**And** 诊断不泄露绝对路径。

### Story 4.2：计算确定性的结构边变化与影响范围

As a 审查跨文件改动的 Tech Lead，
I want 获得确定性的依赖边变化和受影响范围，
So that 我可以先看清本次改动改变了哪些结构事实。

**关联需求：** FR-17、AR-18

**Acceptance Criteria:**

**Given** ChangeSet 与 canonical baseline 已生成
**When** application/impact 计算差异
**Then** 比较独立 Git 基线派生结构和目标快照
**And** 不修改主图 graph/findings revision
**And** 相同输入产生相同结果。

**Given** 变更增加、删除、修改或移动文件及依赖
**When** 构建结构变化
**Then** 输出新增/删除边、受影响目录或 package 和证据位置
**And** 保留方向、qualifier、来源和置信度
**And** 不把未解析动态关系当作确定变化。

**Given** 结构变化跨越目录或 workspace package
**When** 计算影响范围
**Then** 复用权威 ProjectionMembershipV1 聚合受影响实体
**And** 标记 changed-source、changed-target、affected 和 context 角色
**And** 不把展示聚合伪装成新的规范边。

**Given** 变更包含移动、删除、低置信或无法解析动态关系
**When** 构建结构变化结果
**Then** 移动尽可能保持新旧路径对应
**And** 低置信和未解析关系明确标记限制
**And** 不生成未经支持的确定性新增或删除边。

**Given** 影响范围 partial、stale 或计算期间工作树继续变化
**When** Job 结束
**Then** 结果绑定启动时 ChangeSet、baseline、revision 和 generatedAt
**And** coverage 明确标记不完整原因
**And** 不修改主图 graph/findings revision 或返回误导成功结论。

**Given** 相同 ChangeSet、baseline 和目标快照
**When** 重复计算
**Then** 边变化、影响范围、角色和证据顺序保持相同
**And** 服务返回可供 CLI 或 VS Code 直接阅读的结构变化摘要。

**Given** 结构边变化能力首次落地
**When** CI 运行
**Then** 覆盖新增、删除、修改、移动、聚合范围、低置信和确定性排序
**And** 任何宿主自行计算边变化的实现被合同测试阻止。

### Story 4.3：比较循环与 Finding 的 Git 基线状态

As a 审查结构风险的 Tech Lead，
I want 将循环和 Finding 与明确 Git 基线比较，
So that 我可以区分本次新增、历史既有、已解决和不可比较风险。

**关联需求：** FR-11、FR-14、FR-17、AR-15、AR-18

**Acceptance Criteria:**

**Given** 基线和目标包含循环投影
**When** application/impact 计算 CycleDeltaV1
**Then** 比较同 scope、同 kernelVersion、绑定显式 baselineId 的投影
**And** 分类 new、existing、resolved 或 not-applicable
**And** canonicalRiskId 使用 cycle:<scope>:<projectionId>。

**Given** SCC 在基线与目标之间 split 或 merge
**When** 比较 projectionId 集合
**Then** 旧 SCC 表现为 resolved、新 SCC 表现为 new
**And** 不通过节点数量相似度猜测为 existing
**And** 相同输入产生确定结果。

**Given** Finding 可与 Git 基线比较
**When** 建立 comparisonContext
**Then** new/existing 由服务端唯一计算
**And** canonicalRiskId 使用 finding:<findingId>
**And** 宿主不得猜测比较结果。

**Given** 缺少基线、规则无效、Finding stale 或任一范围不完整
**When** 执行比较
**Then** comparison 为 not-applicable
**And** 结果解释具体限制
**And** 不把未比较风险归类为新增或既有。

**Given** 比较完成、失败或取消
**When** Job 结束
**Then** 主图 graph/findings revision 保持不变
**And** 结果携带 baselineId、derivedFrom revisions 和生成时间
**And** 失败或取消不覆盖上一次完整比较 artifact。

**Given** 基线比较能力首次落地
**When** CI 运行
**Then** 覆盖 CycleDelta、SCC split/merge、Finding new/existing、not-applicable 和确定性
**And** 任一失败阻止合并。

### Story 4.4：生成 ImpactVerdictV1 与稳定风险排序

As a 需要做审查决策的 Tech Lead，
I want 获得统一总体 verdict、主要风险和建议复查顺序，
So that 所有入口都能一致判断本次变更是否需要阻止或复核。

**关联需求：** FR-17、AR-18

**Acceptance Criteria:**

**Given** 结构变化和基线比较结果可用
**When** application/impact 生成 ImpactVerdictV1
**Then** 优先级固定为 block > unknown > review > pass
**And** new active error 为 block，新增 warning 或循环为 review
**And** existing 默认不改变 verdict，resolved 不导致失败。

**Given** 存在 new active error 且覆盖同时不完整
**When** 判定总体结论
**Then** verdict 保持 block
**And** coverageIncomplete 为 true
**And** 不因 unknown 条件降低已确定 error 的严重性。

**Given** 无确定 error，但图谱 partial/stale、规则无效、比较 not-applicable 或计算不完整
**When** 判定总体结论
**Then** verdict 为 unknown
**And** 输出具体覆盖限制
**And** 不误报 pass。

**Given** 结果包含多个风险与路径
**When** 生成 ImpactRankV1
**Then** majorRisks 按固定 riskClass 和 canonicalRiskId 排序
**And** keyPaths 与 suggestedReviewFiles 按风险、changeRole、最短 hop 和相对路径排序
**And** resolved 不进入 majorRisks。

**Given** 展示层需要截断
**When** 生成最终影响合同
**Then** 展示截断不改变 verdict 或全量计算排序
**And** VS Code、CLI 与 Markdown 只能消费既有 verdict 和顺序
**And** 相同输入产生相同结果。

**Given** 本能力首次落地
**When** CI 运行
**Then** 覆盖 CycleDelta、SCC split/merge、verdict 优先级、风险排序、partial/stale 和确定性
**And** 任何宿主重算结论的实现被合同测试阻止。

### Story 4.5：在 VS Code 中审查结构变更

As a 在 VS Code 中审查本地改动的 Tech Lead，
I want 查看并导航统一的结构影响结论，
So that 我可以聚焦本次新增的耦合、循环和规则风险。

**关联需求：** FR-10、FR-17、UX-DR2、UX-DR10、UX-DR15、UX-DR17、UX-DR23、UX-DR29、UX-DR34

**Acceptance Criteria:**

**Given** 用户打开 Changes / PR Summary
**When** 选择 working tree、staged 或 base ref
**Then** extension 通过 service-client 启动 Story 4.1 至 4.4 的只读 Job
**And** 不直接运行 Git、读取 SQLite 或重算影响
**And** 生成期间保留上一次完整结果。

**Given** impact 结果可用
**When** ChangeSummary 呈现
**Then** 先显示权威 verdict、coverageIncomplete 和新增风险
**And** 显示边变化、受影响范围、循环变化和建议复查文件
**And** existing 默认折叠，not-applicable 解释限制。

**Given** 结果包含新增和删除边
**When** 图或列表显示
**Then** 使用 +/−、文字、线型和方向表达
**And** 保留来源与置信度
**And** 不只依赖红绿颜色或动画。

**Given** 用户选择边、Finding、循环或目录
**When** 打开证据
**Then** 复用 FindingSummaryV1、NavigationTargetV1 和相对范围
**And** 不重新推导 comparison、verdict 或排序
**And** 目标缺失时保留证据并提供刷新。

**Given** 用户切换图与列表或结果超预算
**When** 调整 ViewModeSwitch、筛选或范围
**Then** 保留选择、baseline、展开和排序
**And** 列表独立完成 verdict、变化和风险审查
**And** 提供聚合、缩小范围或仅看新增风险。

**Given** Git/配置无效、结果 stale、Job 失败或工作树继续变化
**When** surface 渲染
**Then** 显示前提、失败阶段、生成时间、baseline 和重新生成动作
**And** 保留上一 artifact
**And** 不显示误导 verdict。

**Given** 用户使用键盘、屏幕阅读器或高对比主题
**When** 浏览 ChangeSummary
**Then** verdict、变化类型、数量、风险和路径可宣读
**And** Tab/Enter/Esc 与 Epic 2 一致
**And** 刷新后焦点与选择保持。

### Story 4.6：生成可直接使用的 PR Markdown 摘要

As a Tech Lead，
I want 生成可直接复制到 PR review 的结构影响 Markdown，
So that 团队可以围绕一致结论、风险证据和复查文件展开讨论。

**关联需求：** FR-18、UX-DR17、UX-DR18、AR-24

**Acceptance Criteria:**

**Given** Story 4.4 已生成完整影响结果
**When** application/exporting 构建 PrReviewSummaryV1
**Then** 包含 verdict、coverage、majorRisks、keyPaths、边/循环变化、建议复查文件和 revision/时间
**And** 复用既有 comparison、排序和 baseline
**And** 不重新执行 Git、规则或影响分析。

**Given** 用户请求 Markdown 且未显式授权源码
**When** 生成 ExportArtifactV1
**Then** requested/effective policy 为 structure-only
**And** containsSource 为 false
**And** 内容不含源码、diff、绝对路径或规则原文。

**Given** 当前交互显式授权 include-source
**When** 用户确认范围
**Then** 授权只作用于当前请求
**And** effectivePolicy 只能相同或更严格
**And** 预览明确标记实际敏感内容。

**Given** 影响结果超过内容预算
**When** 渲染摘要
**Then** 优先保留 verdict、新增 error/warning、循环、关键路径和复查文件
**And** artifact 记录截断原因和省略数量
**And** 不扩展成全仓库报告。

**Given** 服务完整生成 PrReviewSummaryV1
**When** 返回 ExportArtifactV1
**Then** artifactStatus=complete，并包含 artifactId、graphRevision、findingsRevision、requestedPolicy、effectivePolicy、containsSource、contentDigest 和 generatedAt
**And** 只有该完整 artifact 可在 ExportPreview 启用复制或写出
**And** 服务不接收绝对目标路径。

**Given** 摘要生成失败或取消
**When** ExportPreview 接收失败
**Then** 不创建、不显示、不复制部分 Markdown
**And** 若存在上一份完整 artifact，只能以“上一份有效结果”显示其 revision、policy 和生成时间
**And** 提供重新生成，不把上一份内容伪装成本次结果。

**Given** 剪贴板或原子文件写入失败
**When** 用户重试或切换目标
**Then** 复用同一完整 artifact
**And** 绝对目标只在 extension 本地持有
**And** 不改变 contentDigest、policy、revision 或 artifactId。

**Given** 工作树或图谱已变化
**When** 查看旧 artifact
**Then** 内容保持不可变并显示生成时间、baseline 和 revision
**And** 提供重新生成动作
**And** 不静默改写。

### Story 4.7：导出可控的本地结构上下文

As a 使用 AI 工具或与他人协作的开发者，
I want 导出当前实体附近的结构关系、边界和 Findings，
So that 接收方可以在明确的架构约束和影响范围内工作。

**关联需求：** FR-23、UX-DR18、UX-DR23、AR-24

**Acceptance Criteria:**

**Given** 用户选择实体和范围
**When** 打开 ExportPreview
**Then** 显示将导出的实体、关系、规则、Finding、来源、置信度和 revision
**And** 可缩小范围或移除无关聚合
**And** 不默认选择全仓库。

**Given** 用户确认范围
**When** 构建 StructureContextExportV1
**Then** 包含 scope、revision、时间、entities、relations、rules、findings 和 truncation
**And** 复用预算内查询与统一 Finding 合同
**And** 相同输入稳定排序。

**Given** entity 为内部文件、目录、workspace package 或 symbol
**When** 序列化
**Then** 包含稳定 ID、nodeType 和 relativePath
**And** symbol 可含规范范围但默认无正文
**And** 不输出绝对路径或数据库主键。

**Given** entity 为外部 npm 包或 Node built-in
**When** 序列化
**Then** 唯一映射 external-package 或 node-builtin
**And** 包含 externalId、displayName 和结构关系
**And** 不伪造本地路径。

**Given** 导出包含规则和 Findings
**When** 生成结构上下文
**Then** 只包含理解边界所需的标识、类型、约束和摘要
**And** stale/低置信内容明确标记限制
**And** 不包含完整 rules.yaml。

**Given** 用户未显式授权源码或范围超预算
**When** 生成 artifact
**Then** 默认 structure-only
**And** 按相关性保留中心、直接/反向依赖、边界规则和 active Findings
**And** 记录聚合、截断和省略数量。

**Given** 复制、写入失败或后续用于 AI 修改
**When** 处理 artifact
**Then** extension 本地执行目标操作并保留不可变 artifact
**And** 修改后可用相同稳定路径、规则 ID 和 Finding 合同重新验证
**And** MVP 不要求 MCP server 或 AI 自动修改。

### Story 4.8：通过 CLI 自动化结构 impact

As a 需要脚本化结构审查的开发者或 CI 维护者，
I want 使用稳定的 impact 命令生成统一结构结论，
So that 本地和自动化流程复用与 VS Code、PR Markdown 相同的 verdict、风险和退出语义。

**依赖：** Story 4.4。Story 4.5、Story 4.6 与本 Story 共同消费同一 ImpactVerdictV1/ImpactRankV1 合同，可在 Story 4.4 后并行实施，不构成本 Story 的完成前置。

**关联需求：** FR-16、FR-17、FR-20、NFR-12、NFR-21、UX-DR17、AR-18、AR-22、AR-28

**Acceptance Criteria:**

**Given** 用户运行 codegraph impact
**When** 指定 working tree、staged 或 base ref
**Then** 复用 ChangeSet、CycleDeltaV1、ImpactVerdictV1 和 ImpactRankV1
**And** 不在 CLI 重新计算 verdict 或排序。

**Given** 使用文本、JSON 或 PR Markdown
**When** 命令完成
**Then** JSON stdout 只包含 schemaVersion 1 envelope
**And** 进度写 stderr、机器模式无 ANSI、路径使用相对 POSIX
**And** 三种格式使用相同 verdict、coverage、majorRisks、keyPaths 和 suggestedReviewFiles。

**Given** 成功、fail-on 命中、输入无效、内部失败、协议不兼容或取消
**When** 命令结束
**Then** 使用 0、1、2、3、4 或 130
**And** warning 默认不失败，除非显式 fail-on
**And** 不改变缓存或主图 revision。

**Given** Git 不可用、基线无效或比较不完整
**When** impact 执行
**Then** 返回稳定诊断或 unknown/not-applicable
**And** 不伪造 pass 或静默选择另一基线。

**Given** impact 首次公开落地
**When** CI 运行
**Then** ChangeSet、CycleDelta、verdict、排序、格式、stdout/stderr、相对路径和退出码均为 blocking gate。

### Story 4.9：通过 CLI 导出完整且可重试的结构 artifact

As a 需要把结构上下文交给工具或同事的开发者，
I want 使用稳定的 export 命令生成完整、版本化且默认无源码的 artifact，
So that 自动化可以安全复用同一内容，并在目标写入失败时重试而不复制部分结果。

**依赖：** Story 4.7、Story 4.8。

**关联需求：** FR-20、FR-23、NFR-12、NFR-14、NFR-16、NFR-21、UX-DR18、UX-DR25、AR-22、AR-24、AR-28

**Acceptance Criteria:**

**Given** 用户运行 codegraph export
**When** 指定相对路径、范围、预算和格式
**Then** 复用 StructureContextExportV1
**And** 默认 requested/effectivePolicy=structure-only
**And** include-source 只由当前 invocation 显式授权。

**Given** 服务成功完成生成
**When** 返回 ExportArtifactV1
**Then** artifactStatus=complete
**And** 包含 artifactId、graph/findings revision、policy、containsSource、contentDigest、generatedAt 和 truncation
**And** 相同输入稳定排序且不含绝对路径。

**Given** 生成过程失败或取消
**When** CLI 处理结果
**Then** 不输出可复制的部分 artifact
**And** JSON、text、Markdown 明确返回失败或取消
**And** 缓存和上一份完整 artifact 不被改写。

**Given** 用户请求文件输出
**When** CLI 写出完整 artifact
**Then** graph-service 不接收绝对目标路径
**And** CLI 使用本地原子写入
**And** 目标失败不产生半文件，并保留同一完整 artifact 供重试。

**Given** 使用 JSON、文本或 Markdown
**When** 命令结束
**Then** envelope、stdout/stderr、无 ANSI 和退出码遵循 AR-22
**And** export 不因 warning 默认失败
**And** help 说明范围、格式、隐私、policy、完整 artifact 条件和退出码。

**Given** Epic 1–4 公共命令全部完成
**When** 运行 codegraph --help 和 CI
**Then** 命令面包含 rebuild、query、check、impact、export、status、doctor、cache
**And** 未实现的云端、MCP 或 hosted PR 能力不出现
**And** export Schema、默认无源码、无绝对路径、生成失败和目标失败场景均为 blocking gate。

## Epic 5：可安装、可升级、可离线使用项目代码图谱

用户可以在受支持桌面平台安装 CLI 和平台特定 VSIX，在离线环境运行完整 MVP，并安全完成升级、降级、服务交接、缓存恢复和候选产物验证。

### Story 5.1：安装并离线运行 CLI

As a 使用受控或离线开发环境的开发者，
I want 安装 npm CLI 后无需下载运行时组件即可运行完整命令面，
So that 我可以在支持的平台可靠使用本地图谱自动化能力。

**关联需求：** FR-19、FR-20、NFR-24、NFR-25、AR-26

**Acceptance Criteria:**

**Given** 发布构建生成 CLI 包
**When** 检查 package metadata
**Then** 明确要求 Node 24 LTS、产品版本、CLI Schema 和许可证
**And** 锁定支持的 Node 范围
**And** 不声明未验证运行时。

**Given** 用户从本地 npm 包或离线 registry 安装 CLI
**When** 网络完全阻断
**Then** 安装后不下载 graph-service、SQLite 原生模块或其他可执行组件
**And** 不依赖全局 daemon
**And** codegraph --help、status 和 doctor 可启动。

**Given** 工作区位于任一受支持桌面平台
**When** 运行完整命令面
**Then** rebuild、query、check、impact、export、status、doctor 和 cache 可用
**And** 使用本机 IPC 和用户缓存
**And** 不上传源码、diff、图谱、规则或 artifact。

**Given** CLI 遇到不支持 Node、OS/arch、协议或 schema
**When** 启动或握手
**Then** 安全拒绝并返回稳定兼容性诊断和升级动作
**And** 不启动第二个服务或写入不兼容缓存。

**Given** 用户卸载或重新安装 CLI
**When** 选择保留或清理缓存
**Then** 默认不删除工作区源码和策略
**And** 缓存保留/清理行为明确且可验证
**And** 重装后可重新发现或安全重建。

**Given** CLI 安装验收
**When** 在网络阻断环境执行新安装、启动、完整命令冒烟和卸载
**Then** stdout/stderr、退出码、无 ANSI、相对路径和隐私合同保持不变
**And** 失败阻止该 CLI 候选进入发布集。

### Story 5.2：安装平台特定的 VS Code 扩展

As a VS Code 开发者，
I want 安装自包含的平台特定扩展，
So that 我无需本机 Node 或运行时下载即可使用图谱服务和 Webview 体验。

**关联需求：** FR-19、FR-21、FR-22、NFR-24、NFR-25、AR-26

**Acceptance Criteria:**

**Given** 构建平台 VSIX
**When** 打包 extension、service-client 和 graph-service
**Then** 携带精简 Node 24 LTS 运行时、服务 bundle、匹配 Node ABI 的 better-sqlite3 原生模块和许可证
**And** esbuild externalize better-sqlite3
**And** 服务不依赖 VS Code/Electron ABI。

**Given** 目标矩阵为 Windows x64、macOS x64/arm64 和 Linux x64
**When** 生成 VSIX
**Then** 每个 artifact 只包含对应平台/架构 payload
**And** engines.vscode 最低为 1.125.0
**And** Windows arm64、Linux arm64 不被误标为支持。

**Given** 用户从本地文件安装 VSIX
**When** 网络完全阻断
**Then** 安装、激活、服务启动和 Webview 打开不下载运行时或原生模块
**And** 不要求全局 daemon 或用户 Node
**And** Workspace Trust 和默认隐私边界仍生效。

**Given** graph-service 启动
**When** 加载原生 SQLite 和本机 IPC
**Then** Node runtime、ABI、平台和架构匹配
**And** 缓存权限与 endpoint 规则通过
**And** 不兼容时返回可操作诊断而非崩溃循环。

**Given** 扩展激活并连接已有 CLI 服务
**When** 版本兼容
**Then** 复用同一 indexing root 实例和 revision
**And** 版本不兼容时拒绝连接，不启动第二实例
**And** 提供更新或安全重建动作。

**Given** VSIX 安装验收
**When** 执行离线安装、激活、Workspace Trust、Overview、Current Context 和卸载
**Then** 核心体验可用且不访问未声明网络端点
**And** 原生模块、运行时和许可证缺失会阻止候选发布。

### Story 5.3：安全升级、降级并恢复本地图谱缓存

As a 已安装产品的开发者，
I want 在版本变更或服务交接时安全保留并恢复缓存，
So that 升级、降级或空闲退出不会破坏图谱或产生双实例写入。

**关联需求：** FR-5、FR-22、NFR-25、NFR-27、AR-25、AR-27

**Acceptance Criteria:**

**Given** 新版本需要接管 indexing root
**When** 旧服务执行 shutdown
**Then** 等待当前事务完成、取消排队 Job、关闭数据库和 endpoint、删除 metadata 后释放锁
**And** 不自动强杀活动事务
**And** 新版本只在锁释放后启动。

**Given** 新服务读取旧 graph schema
**When** schema 可迁移
**Then** 由新服务事务化迁移
**And** 迁移完成前不接受业务查询或 mutation Job
**And** 保留 revision 与缓存一致性。

**Given** 迁移失败或缓存损坏
**When** 升级恢复
**Then** 保留故障副本和诊断
**And** 安全重建缓存
**And** 不修改源码或策略文件。

**Given** 用户降级到不兼容服务
**When** 握手或打开缓存
**Then** 旧服务不得向新 schema 降级写入
**And** 安全拒绝并提示升级、使用兼容版本或清理重建
**And** 不启动第二 writer。

**Given** 客户端重连或 stale metadata 残留
**When** 完成服务发现
**Then** 使用 PID、token、endpoint 和版本验证
**And** 只有进程不存在时回收 metadata
**And** epoch 变化触发完整状态和视图重取。

**Given** 服务无客户端且无活动 Job 5 分钟
**When** 空闲退出
**Then** 优雅关闭数据库和 endpoint、删除 metadata、释放锁
**And** 下次连接按正常启动屏障恢复
**And** 不丢失已提交缓存。

**Given** 用户执行升级、降级、卸载或重装
**When** 选择缓存保留或清理
**Then** 行为可预测并限定当前 workspace-key
**And** 清理不触碰源码
**And** 新安装、升级、降级和缓存恢复测试全部进入 blocking gate。

### Story 5.4：验证平台与原生 ABI 矩阵

As a 使用受支持桌面平台的开发者，
I want CLI 和 VSIX 在声明的 OS/架构上加载正确运行时、SQLite 和 IPC，
So that 安装后不会因原生 ABI 或平台差异而无法启动。

**关联需求：** FR-20、FR-21、FR-22、NFR-24、NFR-27、AR-26

**Acceptance Criteria:**

**Given** 目标平台矩阵
**When** 运行原生安装与启动测试
**Then** 覆盖 Windows x64、macOS x64、macOS arm64、Linux x64
**And** Windows arm64、Linux arm64 不被声明支持
**And** 每个组合有独立 artifact 与测试证据。

**Given** CLI 或 VSIX 启动 graph-service
**When** 加载捆绑运行时和 better-sqlite3
**Then** Node 24 LTS、Node ABI、平台和架构精确匹配
**And** esbuild bundle 不吞入错误原生模块
**And** 不依赖 VS Code/Electron ABI 或用户 Node。

**Given** 服务建立本机通信和缓存
**When** 执行原生冒烟
**Then** Windows 命名管道或 POSIX UDS、权限、token、workspace-key 和缓存归属通过
**And** 不监听 TCP
**And** 不兼容或伪造连接安全失败。

**Given** 网络被完全阻断
**When** 在每个目标平台启动 CLI 与 VSIX
**Then** 不下载运行时、原生模块或其他可执行组件
**And** 默认遥测保持关闭
**And** 核心启动和 doctor 路径可用。

**Given** 运行于不支持平台、ABI 或损坏 payload
**When** 启动候选
**Then** 返回明确兼容性诊断和修复动作
**And** 不崩溃循环、写入不兼容缓存或启动第二服务。

### Story 5.5：验证 VS Code 宿主兼容性

As a VS Code 开发者，
I want 扩展在声明的 VS Code 版本上保持一致、安全且可访问，
So that 升级宿主不会破坏核心图谱工作流。

**关联需求：** FR-19、FR-21、FR-22、NFR-17 至 NFR-20、NFR-24、UX-DR20、UX-DR28、UX-DR34 至 UX-DR37

**Acceptance Criteria:**

**Given** VS Code 兼容矩阵
**When** 运行 Electron 集成测试
**Then** 覆盖 1.125.0、最新稳定版和前一稳定版
**And** engines.vscode 与测试矩阵一致
**And** 任一宿主回归阻止对应候选。

**Given** 每个宿主版本完成离线安装和激活
**When** 执行核心工作流
**Then** Workspace Trust、CSP、消息 Schema、Overview、Current Context、Findings、Changes 和 Command Palette 通过
**And** 不访问未声明网络端点
**And** extension host 不承担索引或复杂布局。

**Given** VS Code 1.125.0、最新稳定版和前一稳定版
**When** 运行真实 Webview 候选矩阵
**Then** 自动覆盖暗色、亮色、高对比，100%/200% 字号，1024/899/599 CSS px 编辑区和 359 CSS px 侧栏
**And** 核心任务无关键动作裁切、无水平溢出、无信息重叠、焦点不丢失
**And** 900/600/360 候选断点若校准变化，必须同步 UX、UX-DR36 和 Story AC。

**Given** 最新稳定版和真实辅助技术
**When** 执行 Windows+NVDA、macOS+VoiceOver、Linux+Orca spot check
**Then** 在高对比、200% 字号和仅键盘条件下可完成 Overview、Current Context、Findings、PR Summary 和 ExportPreview 核心任务
**And** 证据记录 hostVersion、OS、theme、zoom、width、assistiveTech、焦点顺序、可访问性树或等价审计结果。

**Given** CLI 服务已运行且协议兼容
**When** 扩展连接同一 indexing root
**Then** 复用同一服务实例和 revision
**And** 协议不兼容时安全拒绝并提示更新
**And** 不启动第二 writer。

### Story 5.6：验证性能与长期资源预算

As a 使用中大型项目的开发者，
I want 发布候选通过可复现的性能和资源门禁，
So that 索引、查询和长时间运行不会阻塞编辑器或持续耗尽机器资源。

**关联需求：** FR-1、FR-3、FR-6、FR-7、FR-22、NFR-1 至 NFR-8、NFR-26、AR-29

**Acceptance Criteria:**

**Given** 标准项目和参考环境
**When** 执行 BenchmarkPlanV1 preflight
**Then** 核对 8 逻辑 CPU、16 GB RAM、SSD、fixture digest 和 toolchain digest
**And** 任一不匹配产生 invalid 结果并使 gate 失败。

**Given** preflight 有效
**When** 执行性能测量
**Then** 每项包含 2 次 warm-up、至少 20 次测量和 nearest-rank p95
**And** 验证 clean cache Overview 60 秒、warm cache 邻域 300ms、保存更新 2 秒
**And** 使用同一 harness 的单调时钟记录起止事件。

**Given** 首次 rebuild 与连续 5 分钟空闲窗口
**When** 采样 graph-service 进程树
**Then** 峰值 RSS、整段平均 CPU、空闲 CPU p95 和结束 RSS 满足 NFR-26
**And** 报告记录采样间隔、进程树和机器信息。

**Given** 运行版本化 8 小时会话
**When** 采样 RSS、缓存、日志、Job、句柄和临时文件
**Then** 会话结束空闲 RSS 相对首小时基线增长不超过 20%
**And** 缓存与日志容量满足上限
**And** Job、句柄和临时文件不持续单调增长。

**Given** 任一 SLA、资源上限或报告合同未满足
**When** 汇总 BenchmarkResultV1
**Then** 门禁失败并记录失败阶段、指标、样本和复测条件
**And** 不通过缩小未声明 fixture 或省略失败运行绕过门禁。

### Story 5.7：验证安装、升级与缓存恢复矩阵

As a 已安装产品的开发者，
I want 每个支持组合通过安装、版本变更和恢复验收，
So that 生命周期操作不会破坏源码、缓存或单实例边界。

**关联需求：** FR-5、FR-20、FR-21、FR-22、NFR-25、NFR-27、AR-27

**Acceptance Criteria:**

**Given** CLI 和 VSIX 候选
**When** 执行新安装、离线启动、卸载和重装
**Then** 完整命令面与核心 UI 可启动
**And** 缓存保留/清理选择明确
**And** 源码和仓库策略不被删除。

**Given** 旧版本服务和缓存
**When** 执行升级与 schema 迁移
**Then** 等待活动事务、完成服务交接并由新服务事务化迁移
**And** 迁移失败保留故障副本并允许重建
**And** 不出现双 writer。

**Given** 用户执行不兼容降级
**When** 旧服务握手或打开新 schema
**Then** 安全拒绝降级写入
**And** 提供使用兼容版本、升级或清理重建动作
**And** 缓存保持可恢复。

**Given** 服务冲突、崩溃、stale metadata 或 epoch 变化
**When** 客户端重连
**Then** 单实例验证、metadata 回收、完整状态重取和缓存恢复通过
**And** 只有确认旧进程不存在时回收 metadata。

**Given** 汇总所有生命周期组合
**When** 生成矩阵结果
**Then** 每个组合有明确 pass/fail、artifact、平台、版本和失败证据
**And** 无法验证的恢复路径不得被声明支持。

### Story 5.8：生成可复现 payload 与 SBOM

As a 发布负责人，
I want 每个 CLI/VSIX artifact 具有确定 payload、许可证和 SBOM 清单，
So that 用户和审计者可以验证候选内容来自声明的源码与工具链。

**关联需求：** FR-19、FR-20、AR-31

**Acceptance Criteria:**

**Given** CLI 和各平台 VSIX 已构建
**When** 生成 ReleaseArtifactManifestV1
**Then** 固定 artifactId、kind、platform、arch、Node/ABI、协议/schema、source commit、lockfile/toolchain digest、许可证和 SBOM digest
**And** payloadEntries 按相对 POSIX 路径排序
**And** payloadRootDigest 使用 RFC 8785 JCS 和 SHA-256。

**Given** 生成 SBOM
**When** 序列化 SbomInventoryV1
**Then** 不包含 timestamp、serial、绝对路径或非确定字段
**And** SBOM 作为普通 payload entry 纳入 root
**And** 许可证和原生依赖完整可审计。

**Given** 两个隔离 clean checkout
**When** 使用相同 source、lockfile 和 toolchain 构建未签名 payload
**Then** 每个 artifact 的 payloadRootDigest 必须一致
**And** 不一致时输出差异文件并阻止发布。

**Given** 审计单个 npm 包或 VSIX payload
**When** 扫描候选内容
**Then** 不包含源码 fixture、密钥、token、绝对开发路径或未声明网络端点
**And** 包含所需运行时、原生模块、许可证、SBOM 和 artifact manifest。

### Story 5.9：组装一致且完整的 release set

As a 发布负责人，
I want 将 CLI 与全部目标 VSIX 组装为字段一致的完整发布集，
So that 用户不会获得缺失平台产物或协议版本不一致的候选。

**关联需求：** FR-20、FR-21、FR-22、NFR-24、AR-30、AR-31

**Acceptance Criteria:**

**Given** 所有 artifact manifest 已通过验证
**When** 生成 ReleaseSetManifestV1
**Then** 公共 productVersion、sourceCommit、lockfileDigest、protocol 和 schema 版本一致
**And** targetMatrix 与 artifacts 按 artifactKind、platform、arch 稳定排序。

**Given** release set 包含 CLI 与平台 VSIX
**When** 校验矩阵
**Then** artifactId 和 kind/platform/arch tuple 分别唯一
**And** targetMatrix 与 artifacts 一一对应
**And** 完整集合只包含一个 CLI 和每个声明目标的一个 VSIX。

**Given** 任一目标 artifact 缺失、重复或公共字段不一致
**When** 计算 releaseSetId
**Then** 校验失败并阻止候选发布
**And** 不生成可被误用的部分 release set。

**Given** 集合完整
**When** 对省略 releaseSetId 的规范对象执行 JCS SHA-256
**Then** 生成稳定 releaseSetId
**And** 相同 artifact manifests 产生相同结果
**And** 时间戳或 provenance 不进入该身份。

### Story 5.10：建立发布信任包并签署候选

As a 安装正式候选的用户，
I want artifact 与 release set 由可轮换、可撤销的信任链签署，
So that 我可以验证候选未被篡改且签名密钥仍然有效。

**关联需求：** FR-19、FR-21、AR-31

**Acceptance Criteria:**

**Given** repository-external ReleaseTrustAnchorV1
**When** 验证 ReleaseTrustBundleV1
**Then** bundle sequence 单调，previousBundleDigest 连续
**And** bundleDigest 对省略自身的规范 unsigned body 计算
**And** 仓库 PR 无法修改外部 root fingerprint。

**Given** trust bundle 包含 delegated keys 与 revocations
**When** 选择签名密钥
**Then** 只接受最新 bundle 中处于有效期且未 revoked 的 key
**And** revoked key 对后续候选一律拒绝。

**Given** offline root 需要轮换
**When** 更新 trust anchor
**Then** 新 bundle 同时具有旧 root 与新 root 的 detached signature
**And** sequence、previous digest 和新 fingerprint 通过验证。

**Given** artifact manifest 和 release set manifest 已冻结
**When** 生成 ReleaseSignatureV1
**Then** profile 为 ed25519-sha256-v1
**And** subjectDigest 是精确 JCS bytes 的 SHA-256
**And** keyId 是 Ed25519 public key SPKI DER 的 SHA-256。

**Given** 时间戳或 provenance 在签名后附加
**When** 审计候选
**Then** 只引用既有 subjectDigest、payloadRootDigest 或 releaseSetId
**And** 不改变已签名规范对象的身份。

### Story 5.11：建立版本化产品验证与发布适用性合同

As a 发布负责人和测试负责人，
I want 使用固定任务、fixture、样本规则、阈值和机器适用性清单，
So that 不同执行者可以对同一候选得到相同的 Beta、Beta+ 和 v1.1 门禁结论。

**依赖：** Story 5.6 至 Story 5.10 必须全部完成；本 Story 冻结其技术、候选与证据输入，并且必须早于 Story 5.12。

**关联需求：** SM-1、SM-6、SM-7、SM-8、UJ-5、AR-29、AR-30、AR-32

**Acceptance Criteria:**

**Given** SM-1、SM-6、SM-7、SM-8 和 UJ-5 需要执行
**When** 发布 ProductValidationPlanV1
**Then** 固定 task/fixture digest、计时边界、ground truth、样本、资格、剔除、评分、阈值和证据 schema
**And** 所有对象具有 planId、planVersion、owner 和复测条件
**And** 改变任务、fixture、阈值或剔除规则必须升版。

**Given** Beta、Beta+ 或 v1.1 候选
**When** 解析 ReadinessGateManifestV1
**Then** requirementRefs 逐项列出，不允许范围字符串或人工选择“全部适用”
**And** 每个 gate 具有 gateId、phase、blocking、planRef、command、evidenceRefs 和 owner
**And** manifest 绑定 candidateRef 和 digest。

**Given** 执行 SM-1
**When** 记录任务结果
**Then** 使用固定 taskStarted/taskSubmitted、180 秒、ground truth 和正确性规则
**And** 产品失败计为失败，不得作为预声明之外的剔除理由。

**Given** 执行 SM-6
**When** 运行规则 fixture
**Then** expected/forbidden Findings、位置、严重级别和 ID 可机器比较
**And** precision、recall、漏报和误报阈值按 PRD 固定。

**Given** 执行 SM-7 或 SM-8
**When** 收集真实用户证据
**Then** 资格、仓库/团队覆盖、评分、编辑分类、失败样本和剔除原因使用封闭 schema
**And** 负面结果不得被删除或以视觉评分替代。

**Given** 评估 UJ-5
**When** 执行结构导出价值任务
**Then** 只决定 v1.1 entry
**And** 不将 MCP、AI 自动修改成功率或新语言加入 MVP。

**Given** plan、manifest 或 evidence 不匹配候选
**When** gate runner 判定
**Then** 结果为 invalid/No-Go
**And** 输出不匹配字段、owner 和复测条件
**And** 不允许人工覆盖为 pass。

### Story 5.12：审计完整候选并执行 Go/No-Go

As a 发布负责人，
I want 对完整 Beta+ 候选执行内容、能力和产品门禁审计，
So that 只有可追溯、兼容且验证达标的完整 MVP 才会发布。

**依赖：** Story 5.11。

**关联需求：** FR-1 至 FR-23、SM-1 至 SM-8、NFR-1 至 NFR-27、AR-29、AR-30、AR-31、AR-32

**Acceptance Criteria:**

**Given** payload、SBOM、release set 和签名均已生成
**When** 执行最终候选审计
**Then** 校验 artifact root、许可证、SBOM、目标矩阵、ABI、协议/schema、trust bundle 和签名一致性
**And** 任一异常阻止发布。

**Given** Story 5.11 已冻结 ProductValidationPlanV1 和 ReadinessGateManifestV1
**When** 评估 Beta+ release manifest
**Then** 逐项执行 FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8 和发布完整性 gate
**And** 只接受 schema、planVersion、digest、candidateRef 均匹配的证据
**And** Beta 不被表述为完整 MVP。

**Given** 真实团队验证结果
**When** 检查 SM-7 与 SM-8
**Then** 试用者、仓库、团队、任务完成和评分样本满足 PRD 门槛
**And** Tech Lead 可直接使用 PR Markdown 启动风险讨论
**And** 失败样本不被仅以视觉评分替代。

**Given** 任一 Go/No-Go 指标失败、无效或缺少证据
**When** 形成发布决定
**Then** 结果为 No-Go
**And** 记录失败样本、负责人、修复范围和复测条件
**And** 不发布部分 release set 或绕过 blocking gate。

**Given** 所有门禁通过
**When** 候选被批准
**Then** 发布记录引用 releaseSetId、签名、基准报告、兼容矩阵、readinessGateManifestDigest、productValidationPlanVersion、ProductValidationResultV1 和 SM-8 evidence set
**And** 发布记录包含所有 invalid/fail 样本与复测条件
**And** Deferred 能力仍不被混入 MVP 声明。

## Story 依赖与追踪矩阵

### StoryDependencyDagV1（权威）

`dependsOn` 只列直接完成前置；空数组表示唯一 DAG 起点。所有 61 个 Story 必须且只能出现一次，引用必须指向现有 Story，图必须无环。正文顺序为 `display-only`，不得作为缺失依赖的回退规则。

```yaml
storyDependencyDagV1:
  version: 1
  dependencyKind: direct-completion-prerequisite
  documentOrder: display-only
  nodes:
    "1.1": { dependsOn: [] }
    "1.2": { dependsOn: ["1.1"] }
    "1.3": { dependsOn: ["1.1", "1.2"] }
    "1.4": { dependsOn: ["1.3"] }
    "1.19": { dependsOn: ["1.4"] }
    "1.5": { dependsOn: ["1.19"] }
    "1.6": { dependsOn: ["1.5"] }
    "1.7": { dependsOn: ["1.5"] }
    "1.8": { dependsOn: ["1.7"] }
    "1.9": { dependsOn: ["1.7"] }
    "1.10": { dependsOn: ["1.4"] }
    "1.11": { dependsOn: ["1.10"] }
    "1.12": { dependsOn: ["1.11", "1.19"] }
    "1.13": { dependsOn: ["1.12"] }
    "1.14": { dependsOn: ["1.7", "1.9"] }
    "1.15": { dependsOn: ["1.19"] }
    "1.16": { dependsOn: ["1.4"] }
    "1.17": { dependsOn: ["1.15", "1.16"] }
    "1.18": { dependsOn: ["1.2", "1.16"] }
    "2.1": { dependsOn: ["1.6", "1.8", "1.13", "1.14", "1.17", "1.18"] }
    "2.10": { dependsOn: ["2.1"] }
    "2.2": { dependsOn: ["2.10"] }
    "2.3": { dependsOn: ["2.2"] }
    "2.4": { dependsOn: ["2.10"] }
    "2.5": { dependsOn: ["2.4"] }
    "2.6": { dependsOn: ["2.5"] }
    "2.7": { dependsOn: ["2.3", "2.5"] }
    "2.8": { dependsOn: ["2.7"] }
    "2.11": { dependsOn: ["2.8"] }
    "2.9": { dependsOn: ["2.11"] }
    "3.1": { dependsOn: ["1.13", "1.15"] }
    "3.2": { dependsOn: ["3.1"] }
    "3.3": { dependsOn: ["3.2", "1.12"] }
    "3.4": { dependsOn: ["3.2"] }
    "3.5": { dependsOn: ["3.3", "3.4", "1.7"] }
    "3.6": { dependsOn: ["3.3", "1.14"] }
    "3.7": { dependsOn: ["3.5", "3.6"] }
    "3.8": { dependsOn: ["3.7", "2.8"] }
    "3.9": { dependsOn: ["3.4", "3.8", "2.11"] }
    "3.10": { dependsOn: ["3.4", "3.8", "1.14"] }
    "4.1": { dependsOn: ["3.10"] }
    "4.2": { dependsOn: ["4.1"] }
    "4.3": { dependsOn: ["4.1", "3.7"] }
    "4.4": { dependsOn: ["4.2", "4.3"] }
    "4.5": { dependsOn: ["4.4", "3.9", "2.11"] }
    "4.6": { dependsOn: ["4.4"] }
    "4.7": { dependsOn: ["2.7", "3.7"] }
    "4.8": { dependsOn: ["4.4"] }
    "4.9": { dependsOn: ["4.7", "4.8"] }
    "5.1": { dependsOn: ["3.10", "4.9"] }
    "5.2": { dependsOn: ["2.9", "3.9", "4.5", "4.6", "4.7"] }
    "5.3": { dependsOn: ["5.1", "5.2"] }
    "5.4": { dependsOn: ["5.1", "5.2"] }
    "5.5": { dependsOn: ["5.2"] }
    "5.6": { dependsOn: ["5.4", "5.5"] }
    "5.7": { dependsOn: ["5.3", "5.4", "5.5"] }
    "5.8": { dependsOn: ["5.4"] }
    "5.9": { dependsOn: ["5.8"] }
    "5.10": { dependsOn: ["5.9"] }
    "5.11": { dependsOn: ["5.6", "5.7", "5.8", "5.9", "5.10"] }
    "5.12": { dependsOn: ["5.11"] }
```

### 关键依赖摘要（由 StoryDependencyDagV1 派生）

| Story | 必须依赖 | 直接解锁 |
| --- | --- | --- |
| 1.4 | 1.3 | 1.19 |
| 1.19 | 1.4 | 1.5、后续 Analyzer |
| 2.1 | 1.6、1.8、1.13、1.14、1.17、1.18（Epic 1 终端节点） | 2.10 |
| 2.10 | 2.1 | 2.2 |
| 2.8 | 2.7（Epic 1 增量基础已由 2.1 传递闭合） | 2.11 |
| 2.11 | 2.8 | 2.9、Epic 2 完成 |
| 4.8 | 4.4；与 4.5、4.6 可并行消费同一结论合同 | 4.9 |
| 4.9 | 4.7、4.8 | Epic 4 完成 |
| 5.11 | 5.6–5.10 必须全部完成 | 5.12 |
| 5.12 | 5.11 | Beta+ Go/No-Go |

### 本次调整的需求追踪

| Story | FR / SM / UJ | NFR | AR | UX-DR |
| --- | --- | --- | --- | --- |
| 1.4 | FR-1、FR-4、FR-5、FR-22 | NFR-9、NFR-10、NFR-11 | AR-6、AR-8、AR-9、AR-12、AR-28 | N/A |
| 1.19 | FR-1、FR-5、FR-22 | NFR-9、NFR-10、NFR-11、NFR-22 | AR-4、AR-5、AR-6、AR-9、AR-12、AR-28 | N/A |
| 2.1 | FR-21、FR-22 | NFR-8、NFR-13、NFR-27 | AR-19、AR-21、AR-28 | UX-DR1、UX-DR19、UX-DR20、UX-DR37 |
| 2.10 | FR-21、FR-22 | NFR-10、NFR-17、NFR-18、NFR-20 | AR-19 | UX-DR4、UX-DR15、UX-DR16、UX-DR21、UX-DR22、UX-DR24、UX-DR25、UX-DR34 至 UX-DR37 |
| 2.8 | FR-3、FR-22 | NFR-5、NFR-9、NFR-10 | AR-4、AR-5、AR-12、AR-13 | N/A |
| 2.11 | FR-3、FR-22 | NFR-5、NFR-8、NFR-10、NFR-17、NFR-20 | AR-11、AR-20 | UX-DR6、UX-DR15、UX-DR23、UX-DR27、UX-DR30、UX-DR32 |
| 4.8 | FR-16、FR-17、FR-20 | NFR-12、NFR-21 | AR-18、AR-22、AR-28 | UX-DR17 |
| 4.9 | FR-20、FR-23 | NFR-12、NFR-14、NFR-16、NFR-21 | AR-22、AR-24、AR-28 | UX-DR18、UX-DR25 |
| 5.11 | SM-1、SM-6、SM-7、SM-8、UJ-5 | N/A | AR-29、AR-30、AR-32 | N/A |
| 5.12 | FR-1 至 FR-23、SM-1 至 SM-8 | NFR-1 至 NFR-27 | AR-29 至 AR-32 | N/A |

### 关键合同与 Story 双向映射

| 合同 | 最终 Story | Architecture / Guide | PRD / UX |
| --- | --- | --- | --- |
| 最小真实 CI | 1.1 | AD-28、Guide §3/§13 | epics AR-28 |
| provider + 规划追踪 | 1.3 | AD-28、Guide §13 | epics AR-28 |
| BuiltinIgnoreV1 / generation 0 | 1.4 | AD-14、AD-23、Guide §3/§4/§7 | FR-4、Addendum §4 |
| 确定性 rebuild / CAS | 1.19 | AD-3、AD-8、Guide §6/§7 | FR-1、FR-5 |
| BasicSymbolV1 | 1.6 | AD-27、Guide §8 | FR-2、Addendum §5.4 |
| BaseCycleProjectionV1 | 1.14 | AD-25、Guide §9 | FR-11 |
| Getting Started / Index Status | 2.10 | AD-10、AD-15 | UX-DR15/16/19/21/22/24 |
| 增量 mutation | 2.8 | AD-3、AD-8、AD-23 | FR-3、NFR-5/9/10 |
| 原子视图 patch | 2.11 | AD-7、AD-22 | UX-DR6/23/27/30/32 |
| ImpactVerdictV1 / ImpactRankV1 | 4.4 | AD-26、Guide §12 | FR-17、UX-DR17 |
| CLI impact | 4.8 | AD-13、AD-26 | FR-16/17/20 |
| CLI export | 4.9 | AD-13、AD-18 | FR-20/23、UX-DR18 |
| ProductValidationPlanV1 | 5.11 | AD-30、Guide §13 | SM-1/6/7/8、UJ-5 |
| Beta+ Go/No-Go | 5.12 | AD-29、AD-30 | PRD §8/§9、ReadinessGateManifestV1 |
