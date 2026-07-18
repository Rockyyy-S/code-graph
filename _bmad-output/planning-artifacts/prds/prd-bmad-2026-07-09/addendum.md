---
title: 项目代码图谱 PRD Addendum
status: final
created: 2026-07-09
updated: 2026-07-16
---

# Addendum：项目代码图谱

本 Addendum 中“已采用”“已确认”和“架构处置结果”属于当前 MVP 的规范合同；配置示例中的具体 ID、路径和值仅用于说明合法形态；“后续升级触发条件”仅描述未来重新评估入口，不属于当前实现要求。

## 1. 来源材料

- `想法.md`
- `_bmad-output/planning-artifacts/briefs/brief-bmad-2026-07-09/brief.md`
- `_bmad-output/planning-artifacts/research/project-code-graph-three-way-research-2026-07-08.md`
- `_bmad-output/planning-artifacts/research/project-code-graph-mvp-stack-upgrade-analysis-2026-07-09.md`
- `../../implementation-readiness-report-2026-07-15.md`
- `../../sprint-change-proposal-2026-07-15.md`
- `../../implementation-readiness-report-2026-07-16-rerun.md`
- `../../sprint-change-proposal-2026-07-16.md`
- `../../architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`
- `../../architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md`

## 2. 技术边界输入

本节不属于 PRD 主体中的产品需求，而是架构边界输入；已完成的架构处置见第 7 节。

- VS Code 插件应保持薄客户端，不承担重索引和复杂布局。
- 索引器、图查询、规则引擎应放在独立本地图谱服务中。
- 存储层应通过 `GraphStorePort` 接口访问，避免业务逻辑散落 SQL。
- TS/JS 分析由 `AnalyzerPort` 的 TypeScript Compiler API 适配器负责；Tree-sitter、LSP、SCIP / CPG 仅在触发条件成立后作为可替换适配器评估。
- 可视化层应消费 `GraphViewModel`，不要把 Cytoscape.js JSON 当作持久图谱模型。
- 节点和边需要稳定 ID、来源、置信度、版本和更新时间。
- 文件监听需要 debounce、settle、hash check 和 batch queue，避免 git pull 或批量生成文件导致事件风暴。

## 3. 已采用技术栈与保留替换边界

- 入口：VS Code Extension + CLI。
- 实现语言与工具链：TypeScript 6.0.3；CLI 要求 Node 24 LTS，平台 VSIX 携带经验证的 Node 24 LTS 运行时。
- 解析：TypeScript 6.0.3 稳定 Compiler API 是 TS/JS 权威源；TypeScript 7 unstable API、Tree-sitter、LSP 和 SCIP 不进入首个实现。
- 存储：SQLite / `better-sqlite3` 作为第一实现，通过 `GraphStorePort` 访问，不作为领域模型。
- 通信：Windows 命名管道或 macOS/Linux Unix Domain Socket，使用 JSON-RPC 2.0，不监听 TCP。
- 可视化：Cytoscape.js 用于局部图；后续可引入 ELK/Dagre、Sigma.js 或依赖矩阵。
- 规则：本地 rules engine，第一版支持循环依赖、目录引用、层级依赖方向。
- 变更影响：本地 git diff + 图谱边变化摘要。

## 4. `.codegraph/rules.yaml` v1 契约示例

下列 YAML 仅演示合法配置形态；字段集合、解析行为、校验规则和 `ignore` 语义属于规范合同，示例中的规则 ID、路径与消息文本不具有规范性。

```yaml
version: 1

ignore:
  - "**/*.test.ts"
  - "src/generated/**"

rules:
  - id: ui-cannot-import-infra
    type: forbidden-dependency
    from: "src/ui/**"
    to: "src/infra/**"
    severity: error
    message: "UI 层不能直接依赖基础设施层"

  - id: enforce-layer-order
    type: layer-order
    layers:
      - name: presentation
        paths:
          - "src/presentation/**"
      - name: application
        paths:
          - "src/application/**"
      - name: domain
        paths:
          - "src/domain/**"
    severity: error

  - id: no-package-cycles
    type: no-cycle
    scope: package
    severity: error
```

`layer-order` 中的层按从上到下声明：每层可依赖自身及后续层，不得反向依赖前面的层。规则 ID 在 IDE findings、CLI JSON 和 CI 输出中保持稳定。v1 配置解析应拒绝未知字段和未知规则类型，以便尽早发现拼写错误；未来通过顶层 `version` 演进语法。

索引排除与规则排除承担不同职责：

- `.codegraphignore` 与 `BuiltinIgnoreV1` 控制索引范围。命中路径不进入节点、边、Evidence、workspace package 聚合、规则检查或成功指标；用户排除模式在内置排除模式后应用，可使用显式 `!` 重新纳入。
- `.codegraph/rules.yaml` 的 `ignore` 只裁剪规则评估范围。命中的实体仍保留在规范图谱、普通查询、workspace package 聚合和索引规模统计中。
- 首次执行 `rebuild` 前，Analyzer 必须能够读取 `EffectiveIgnoreSnapshotV1`。若 `.codegraphignore` 不存在，使用 generation 0 的空用户排除快照，但快照仍包含 `BuiltinIgnoreV1`；已存在文件的语法、last-valid 回退、诊断和重新纳入行为由完整排除功能切片定义。

## 5. 已确认的 MVP 技术边界

### 5.1 Monorepo 支持

- Alpha 可先把 monorepo 作为普通工作区索引，但 Beta 必须识别常见 npm/Yarn `package.json` workspaces 与 `pnpm-workspace.yaml`。
- TypeScript project references 可作为 package 边界和依赖关系的补充来源。
- MVP 支持单仓库内的 workspace package、跨 package import 和 package 聚合依赖边。
- MVP 不支持跨仓库 federation、跨语言精确符号解析或组织级全局图谱。

### 5.2 性能验收基准

- 标准项目：最多 5,000 个受支持源码文件、500,000 LOC、50 个 workspace package。
- 排除项：`node_modules`、构建产物、生成代码和 `.codegraphignore` 命中的路径。
- 参考机器：8 个逻辑 CPU、16 GB 内存、SSD。
- 硬指标上限：首次概览不超过 60 秒、缓存邻域显示不超过 300 ms、保存后局部更新不超过 2 秒。
- 邻域图单次查询和渲染预算：最多 100 个节点、200 条边；手动展开按新的局部预算加载，不无限累积全局节点。
- `BenchmarkPlanV1` 固定 fixture/digest、参考环境、cold/warm cache、每项 SLA 的起止事件、2 次 warm-up、至少 20 次测量和 nearest-rank p95；结果输出机器可读 `BenchmarkResultV1`。
- 首次发布资源门禁：首次 `rebuild` 的 graph-service 进程树峰值 RSS 不超过 4 GiB；按 1 秒间隔采样的整段运行平均 CPU 不超过整机 75%。在连续 5 分钟无活动 Job 的空闲窗口内，CPU p95 不超过整机 1%，窗口结束时 RSS 不超过 1.5 GiB。
- 单工作区缓存、服务元数据和日志总量不超过 2 GiB，轮转日志不超过 100 MiB。版本化资源基准 manifest 固定 8 小时会话的 fixture、操作序列、采样间隔和空闲窗口；会话结束后的同条件空闲 RSS 相对首小时基线增长不超过 20%，Job 队列、句柄和临时文件不得持续单调增长。
- 资源报告必须记录 fixture/toolchain digest、进程树 RSS/CPU、缓存与日志体积、Job/句柄/临时文件计数；不满足参考环境或采样合同的结果标记为 invalid。

### 5.3 AI 与遥测边界

- MVP 提供 CLI/本地结构上下文导出；MCP server 延后到 v1.1，并以 Beta+ release manifest 全部通过且版本化 UJ-5 导出价值门禁通过为启动条件。UJ-5 门禁只控制 v1.1 候选启动，不扩大 MVP。
- 遥测默认关闭。opt-in 遥测只允许匿名功能事件、耗时、计数和错误分类，不得包含源码、完整路径、符号、diff、图谱或规则内容。
- 无论遥测是否开启，插件、CLI、规则检查和导出能力都必须完整可用。

### 5.4 分析范围与正确性合同

- directory 是由工作区相对路径形成的物理层级；workspace package 是由有效 npm/Yarn workspace 或 `pnpm-workspace.yaml` 识别出的最深 package root。workspace discovery 为 degraded 时不得生成 workspace-package 投影或跨 package 结论。
- “模块”只是用户可见的逻辑聚合称谓，必须映射为 directory 投影叶子或 recognized workspace package，不是第三种持久实体。
- MVP 规范边只包含 `contains`、`imports`、`exports` 和派生 `depends_on`；Finding 可以引用 `violates` 语义。`references` 不在 MVP 生成，也不得进入导航、导出、成功指标或发布声明。
- `BasicSymbolV1` 只包含 TypeScript/JavaScript SourceFile 顶层、具有稳定名称和可导航范围的 `function`、`class`、`interface`、`type-alias`、`enum`、`variable`、`namespace`，固定携带稳定 symbol ID、kind、name、相对路径、范围和 exported 状态。
- 成员、参数、局部变量、import alias、匿名声明、调用图和 references 不进入 MVP；跨文件 interface/namespace declaration merge 仍保持 file-scoped ownership。
- SM-4 使用至少 500 条版本化人工标注声明，覆盖 ESM、CJS、re-export、type-only、literal `require`、literal dynamic `import()`、path alias、跨 package、Node built-in 和负样本。
- 正确性门禁为规范依赖边 micro-F1 ≥ 0.80、high-confidence 边 precision ≥ 0.90，并输出 precision、recall、F1、分类结果和失败样本；标注争议必须人工复核并记录。

### 5.5 平台、运行时与交付兼容边界

| 维度 | MVP 合同 |
| --- | --- |
| OS / 架构 | Windows x64、macOS x64、macOS arm64、Linux x64 |
| 暂缓平台 | Windows arm64、Linux arm64；待原生依赖 CI 与真实设备验收后加入 |
| CLI 运行时 | Node 24 LTS；当前锁定验证版本 24.18.0 |
| VSIX 运行时 | 携带精简 Node 24 LTS、服务 bundle 和对应 Node ABI 的 SQLite 模块，不依赖用户 Node 或 VS Code/Electron ABI |
| VS Code | `engines.vscode` 最低 1.125.0；发布 CI 同时覆盖最低版本、最新稳定版和前一稳定版 |
| TypeScript 分析器 | TypeScript 6.0.3 稳定 Compiler API |

- CLI 作为 npm 包发布，扩展使用平台特定 VSIX；安装后不下载运行时或原生模块，不使用全局 daemon。
- protocol、graph schema、rules schema 和 CLI schema 独立版本化；protocol major 不同直接拒绝，同 major 的 minor 通过 capabilities 协商。
- 图谱 schema 仅由新服务事务化迁移；旧服务不得向新 schema 降级写入。迁移失败保留故障副本并重建缓存。
- 升级时，关闭流程应等待当前事务完成、取消排队 Job、关闭数据库与 endpoint、删除服务 metadata 并释放锁；禁止自动强杀活动事务。发布测试覆盖新安装、升级、降级、服务冲突和缓存保留/清理。

### 5.6 本地服务与安全边界

- 每个 indexing root 最多一个按需 graph-service；VS Code multi-root 为每个 root 使用独立服务，不合并图谱。
- Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket，应用协议为 JSON-RPC 2.0，不监听 TCP。
- POSIX 缓存目录权限为 0700、文件与 socket 为 0600；Windows 使用当前用户缓存 ACL、随机不可猜 endpoint 后缀，并在业务请求前校验随机 token、workspace-key 和协议版本。
- 未授予 Workspace Trust 时不启动服务、不读取项目文件、不运行 Git 分析。所有路径经 `realpath` 解析后仍必须位于 indexing root；系统必须拒绝路径穿越和指向 indexing root 外部的 symlink。Webview 使用严格 CSP、nonce、无网络访问和消息 Schema 校验，且不得直连 graph-service。
- 启动必须在迁移、watcher 注册、配置/manifest 对账和 bootstrap barrier 完成后才进入 running。stale metadata 仅在 PID 不存在且 token/endpoint 失效时回收；无客户端且无活动 Job 5 分钟后优雅退出。
- 安全硬限制：单文件 10 MiB、最多 20,000 个候选源码文件、1,000 条规则、50 个 YAML alias；查询最多跨 3 跳、返回 500 个节点和 1,000 条边；最多 64 个待处理显式 Job。超过限制时返回稳定诊断，不执行项目代码或静默截断规则。

### 5.7 产品验证与发布适用性合同

- `ProductValidationPlanV1` 是 SM-1、SM-6、SM-7、SM-8 与 UJ-5 价值门禁的唯一任务、fixture、计时、ground truth、样本、剔除、评分和阈值来源。它至少固定 planId、planVersion、candidateRef 绑定规则、fixture/task manifest 与 digest、每个任务的 start/stop 事件和 timeout、groundTruthRef、acceptableAliases、requiredEntities、criticalDistractors、参与者资格、最小样本、仓库/团队覆盖、预声明剔除规则、评分工具、阈值、聚合规则、证据/结果 schema、owner 和复测条件。
- `CandidateRefV1` 是封闭联合：source 候选绑定 productVersion、完整 source commit OID 与 lockfile digest；release-set 候选绑定 AD-29 的 releaseSetId。`gatePhase=release` 只接受 release-set，candidateRefDigest 使用 RFC 8785 JCS UTF-8 SHA-256。
- `ReadinessGatePolicyV1` 是仓库版本化的 release-slice/phase 适用性基线；`ReadinessGateManifestV1` 由 policy、`ci/quality-gates.v1.yaml` gate registry 和 CandidateRefV1 确定性编译，是候选适用 gate 的唯一清单。manifest 必须逐项展开 requirementRefs，并固定 releaseSlice、gatePhase、gateId、blocking、policyDigest、planRef、command、gateDefinitionDigest、evidenceRefs、owner、manifestDigest 与 candidateRef；不得在候选中重定义 gate。
- `ProductValidationEvidenceV1` 与 `ProductValidationResultV1` 是唯一证据和判定格式。Evidence 必须绑定 planRef、policyDigest、manifestDigest、candidateRefDigest、taskDigest、fixtureDigest 与 evidenceDigest；Result 必须绑定同一引用链和按 evidenceId 排序的 evidenceDigest。
- 所有 plan、policy、manifest、evidence、result 对象均使用 JSON Schema 2020-12、`additionalProperties:false` 和稳定 ID。任务、fixture、ground truth、阈值或剔除规则变化必须提升 planVersion；任一 schema、版本、digest、candidateRef 或引用链不匹配均为 invalid，不得人工解释为通过。

| Slice / Phase | 必须列入 |
| --- | --- |
| Beta entry | FR-1 至 FR-10、FR-19 至 FR-22 的逐项 ID；适用 NFR；SM-2、SM-3、SM-4、SM-5；安装、隐私、安全、兼容和基础可访问性 gate |
| Beta exit | SM-1、SM-7 及对应 `ProductValidationPlanV1` |
| Beta+ release | FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8、发布完整性和信任链 gate，全部逐项展开 |
| v1.1 entry | 完整 MVP 已通过，且 UJ-5 价值门禁通过；MCP 不进入当前 manifest 的 MVP requirementRefs |

## 6. 后续升级触发条件

- 非缓存局部图查询或后台刷新 p95 超过 500 ms：优化索引、缓存或 materialized projection。
- 保存后局部更新 p95 超过 2 秒：引入 worker 池、增量解析优化或 LSP 队列。
- Webview 渲染明显卡顿：限制节点预算、预布局、引入 Sigma.js 或矩阵视图。
- 大量文件变更重复重建：引入 Watchman 或更严格的 settle/batch 机制。
- 团队要共享图谱：评估 Postgres/Apache AGE、Neo4j 或服务端图存储。
- 需要精确引用/实现关系：增强 LSP 或引入 SCIP；`references` 在触发条件成立并完成范围审批前不属于 MVP 当前边、导航或导出合同。
- 需要安全/数据流分析：另行评估 CPG/Joern 类管线，不应压入 MVP 主路径。

## 7. 架构处置结果

以下原待确认项均已由 [Architecture Spine](../../architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md) 与 [Implementation Guide](../../architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md) 处置，不再作为开放问题：

| 原待确认项 | 状态 | 处置结果与架构引用 |
| --- | --- | --- |
| 图谱位置、命名、清理与 `.gitignore` | 已关闭 | 仓库仅保存 `.codegraph/rules.yaml` 和 `.codegraphignore`；`graph.sqlite`、服务 metadata、锁、日志、临时文件及 last-valid 记录位于 OS 用户缓存的 workspace-key 目录，可通过 `codegraph cache path/clear` 查看或清理。生成数据不写入工作区。参见 AD-6、AD-14、AD-23。 |
| 核心端口与适配器边界 | 已关闭 | domain/application 定义端口；`store-sqlite`、`analyzer-typescript` 实现适配器；`application/querying` 和 `application/rules` 分别负责查询投影与规则评估；graph-service 是唯一组合根。Cytoscape 仅消费 `GraphViewModel`，第二个真实渲染器出现前不抽取 renderer 包。参见 AD-1、AD-7 与 Guide §2、§4。 |
| 稳定 ID 规范 | 已关闭 | 内部实体使用工作区作用域 `cg://` URI；路径使用 Unicode NFC 和相对 POSIX 形式；workspace、package、symbol 和 edge ID 均使用确定性输入生成，Node built-in 使用 `node:<module>`。参见 AD-4、AD-24、AD-27。 |
| `rules.yaml` 解析、诊断与 schema | 已关闭 | JSON Schema 2020-12 是唯一公共合同；`yaml` 保留 CST/range，Ajv 严格校验，统一输出 `ConfigDiagnosticV1`，未知字段与类型被拒绝。参见 AD-9、AD-14 与 Guide §10。 |
| CLI 命令、I/O 与退出码 | 已关闭 | 公共命令为 `rebuild/query/check/impact/export/status/doctor/cache`；默认文本，`--format json` 使用 `schemaVersion:1` envelope；结果写 stdout，进度/可恢复警告写 stderr；退出码固定为 0/1/2/3/4/130。参见 AD-13、AD-20 与 Guide §12。 |
| VS Code surface 边界 | 已关闭 | TreeView 负责入口、状态与导航；Webview Editor 负责 Overview、Current Context、Changes 的图和等价列表；Problems 只承载可定位诊断；Status Bar 只显示单行状态；全部操作同时注册 Command Palette。参见 AD-10、AD-15 与 Guide §11。 |
| PR Markdown 摘要模板 | 已关闭 | `PrReviewSummaryV1` 固定包含 verdict、majorRisks、keyPaths、边/循环变化、建议复查文件和 revision/时间信息；`ImpactVerdictV1` 由 application/impact 唯一计算，Markdown/CLI/VS Code 不得重算。参见 AD-18、AD-26 与 Guide §12。 |
| AI 结构上下文格式 | 已关闭 | `StructureContextExportV1` 固定包含 scope、revision、entities、relations、rules、findings 和 truncation；默认 `structure-only`，`include-source` 只能由当前交互显式授权。只有生成完整且带 artifactId、完整性状态、revision/policy、containsSource、contentDigest 与 generatedAt 的不可变 `ExportArtifactV1` 才能复制或写出；生成失败不得暴露部分内容，目标失败只能重试同一完整 artifact 或改用另一目标。参见 AD-18 与 Guide §12。 |
| 产品验证与发布适用性 | 已关闭 | `ProductValidationPlanV1`、`ReadinessGatePolicyV1`、`ReadinessGateManifestV1`、`ProductValidationEvidenceV1`、`ProductValidationResultV1` 与 `CandidateRefV1` 构成唯一版本化验证链；适用性由 policy、gate registry 和候选确定性编译，任一 schema、digest、版本或候选引用不匹配均为 invalid，不能人工放行。参见 AD-30 与 Guide §13。 |
