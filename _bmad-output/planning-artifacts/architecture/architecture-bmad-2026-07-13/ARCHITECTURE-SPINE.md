---
name: 项目代码图谱 MVP
type: architecture-spine
purpose: build-substrate
altitude: initiative
paradigm: 六边形架构的模块化单体；索引子系统采用管道与过滤器
scope: VS Code 扩展、本地 CLI、本地图谱服务及其共享图谱契约
status: final
created: 2026-07-13
updated: 2026-07-16
binds:
  - UJ-1
  - UJ-2
  - UJ-3
  - UJ-4
  - UJ-5
  - FR-1..FR-23
  - SM-1..SM-8
  - NFR-performance
  - NFR-reliability
  - NFR-security-privacy
  - NFR-accessibility
sources:
  - ../../prds/prd-bmad-2026-07-09/prd.md
  - ../../prds/prd-bmad-2026-07-09/addendum.md
  - ../../ux-designs/ux-bmad-2026-07-13/DESIGN.md
  - ../../ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
  - ../../research/project-code-graph-three-way-research-2026-07-08.md
  - ../../research/project-code-graph-mvp-stack-upgrade-analysis-2026-07-09.md
  - ../../implementation-readiness-report-2026-07-15.md
  - ../../sprint-change-proposal-2026-07-15.md
  - ../../implementation-readiness-report-2026-07-16-rerun.md
  - ../../sprint-change-proposal-2026-07-16.md
companions:
  - IMPLEMENTATION-GUIDE.md
---

# Architecture Spine — 项目代码图谱 MVP

## Design Paradigm

主范式是六边形架构的模块化单体：领域与应用核心定义端口，宿主、存储、分析器和 Git 作为适配器向内依赖；运行时保持一个本地图谱服务，不拆成微服务。索引内部固定为管道与过滤器：采集变更 → 分析 → 规范化 → 计算 GraphPatch → 原子提交 → 派生查询/Findings → 发布 revision。

~~~mermaid
flowchart TD
    DOMAIN["domain"]
    APP["application"] --> DOMAIN
    ADAPTERS["adapters"] --> APP
    ADAPTERS --> DOMAIN
    SERVICE["graph-service 组合根"] --> APP
    SERVICE --> ADAPTERS
    SERVICE --> CONTRACTS["contracts"]
    CLIENT["service-client"] --> CONTRACTS
    EXT["VS Code extension"] --> CLIENT
    CLI["CLI"] --> CLIENT
    WEB["Webview"] --> CONTRACTS
~~~

## Invariants & Rules

### AD-1 — [ADOPTED] 依赖只向核心收敛

- **Binds:** all
- **Prevents:** SQL、VS Code API、IPC DTO、分析器类型或渲染器格式渗入领域与应用核心。
- **Rule:** domain 不依赖其他项目包；application 只依赖 domain 并定义端口；适配器实现端口；graph-service 是唯一组合根；客户端只依赖 contracts 与 service-client。

### AD-2 — [ADOPTED] 每 indexing root 一个按需本地服务

- **Binds:** FR-1..FR-5, FR-20..FR-22, NFR-reliability
- **Prevents:** 多客户端重复索引、SQLite 并发写入和 freshness 状态漂移。
- **Rule:** 服务所有权单位是 indexing root：一个仓库根或 VS Code workspace folder。每个 indexing root 最多存在一个可发现的 graph-service；multi-root 窗口由 service-client 管理多个独立服务，不合并图谱。Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket，应用协议为 JSON-RPC 2.0，不监听 TCP。服务独占图谱、Job 队列、迁移和共享 revision；客户端只拥有 UI 会话状态。

### AD-3 — [ADOPTED] 图谱只通过原子 GraphPatch 变更

- **Binds:** FR-2, FR-3, FR-5, FR-11..FR-15, SM-2, SM-3
- **Prevents:** 分析器直接写库、半更新图谱、跨来源误删和客户端读取未完成状态。
- **Rule:** 分析器只输出带 ownershipSliceId、inputDigest、analyzerVersion 和 coverage 的 FactBatch；coverage 只允许 complete/partial/failed。v1 ownership slice 只有三类：source:<analyzerKind>:<fileId> 拥有该文件声明的 symbol 与 sourceFileId 相同的 Evidence；manifest:<manifestKind>:<relativePath> 拥有 package/workspace 元数据；hierarchy:<indexingRootId> 拥有文件/目录节点与 contains 关系。analyzerVersion 不是 slice 身份，新版本 complete 快照替代旧版本。complete 缺失即删除；partial 只允许 upsert 与显式 tombstone；failed 不生成 GraphPatch。每个 contentHash 是原始文件字节的 SHA-256 小写十六进制。configDigest 只能由 graph-service 从 AnalyzerConfigSnapshot v1 计算：{version, analyzerKind, analyzerVersion, effectiveCompilerOptions, consultedFiles:[{path,contentHash}], effectiveIgnore:{version,effectiveDigest}, workspacePackages:[{root,name}]}；consultedFiles 包含 tsconfig/jsconfig extends 链、package/workspace manifest、lockfile 与模块解析实际读取的非源码 package.json，数组按规范 path/root 升序，语义有序的 compiler option 数组保序，rules.yaml 不进入分析配置。EffectiveIgnoreSnapshotV1.generation 只在当前 statusEpoch 内单调并只作为并发栅栏，不进入语义 configDigest、无需跨实例持久化。configDigest 与 inputDigest 都使用 RFC 8785 JCS → UTF-8 → SHA-256；inputDigest 对象为 {version:1, analyzerKind, configDigest, inputs:[{path,contentHash}]}。提交前与当前 manifest、完整 EffectiveIgnoreSnapshotV1 做 CAS；不匹配则丢弃 batch 并重新排队。每 indexing root 只有一条 snapshot mutation channel，覆盖任何推进 graphRevision 或 findingsRevision 的事务。RulesSnapshotRef={generation,validity:valid|invalid,effectiveRulesDigest,lastValidRulesDigest}；初始化为 generation=0、validity=valid 的合法 RulesV1 空策略，effectiveRulesDigest=lastValidRulesDigest=EMPTY_RULES_DIGEST。所有有效 rules digest 都对 Schema 校验通过且默认值显式化的 RulesV1 对象执行 RFC 8785 JCS → UTF-8 → SHA-256 小写十六进制；EMPTY_RULES_DIGEST 以同一算法计算合法空策略对象。rules.yaml 任意变化推进 generation；首次或后续配置无效时保持最后有效 digest，首次无效即保持 EMPTY_RULES_DIGEST。任何推进 findingsRevision 的事务必须携带并 CAS baseGraphRevision、完整 RulesSnapshotRef 与完整 EffectiveIgnoreSnapshotV1；CAS 失败即丢弃并重排。无效 rules 或 ignore generation 不得阻塞 GraphPatch：事务可在最后有效策略和 scope 下提交 graphRevision，同时推进 findingsRevision、保留旧 Findings 为 stale 并禁止 resolved；只有 rules 与 ignore 均 valid 且完整 scope 成功评估时才可产生权威新 Findings 或 resolved，Finding revision 记录实际 effectiveRulesDigest 与 effectiveIgnoreDigest。

### AD-4 — [ADOPTED] 确定性实体 ID 与证据分层

- **Binds:** FR-2, FR-5, FR-14, FR-17, FR-23
- **Prevents:** 重建后 ID 漂移、数据库主键泄漏、同一语义边被不同分析器重复建模。
- **Rule:** 内部实体使用工作区作用域 cg:// URI。Git workspace-key 为规范化远程仓库身份与子根路径的 SHA-256；无稳定 Git 身份时为规范化本地 workspace URI 的 SHA-256。路径采用 Unicode NFC、相对 POSIX 形式，Git 文件使用索引大小写。内部 package ID 由 workspace package 根路径确定；外部 npm 包使用标准 purl pkg:npm/<name>@<resolvedVersion>，包管理器不进入身份，未解析版本使用 @unresolved 并降级置信度，Node built-in 使用 node:<module>。symbol ID 由 file ID、语言、kind、qualified name、签名摘要确定。关系端点与方向固定：contains 为 container→child；imports 为 importer file→target module entity；exports 为 exporting file→local symbol 或 target module entity；references 为 source symbol→target symbol。qualifier 必须使用 AD-24 的版本化枚举。depends_on 仅为同方向聚合投影，violates/changed_by 不入规范边。edge ID 为 workspace-key、relationType、fromId、toId、qualifier 的哈希。

### AD-5 — [ADOPTED] TypeScript Compiler API 是 TS/JS 权威分析源

- **Binds:** FR-1..FR-3, FR-11, SM-3, SM-4
- **Prevents:** Tree-sitter、TypeScript 与语言服务并行解释同一事实造成冲突和重复成本，或 workspace 识别失败阻断普通索引、降级后仍宣称 package 边界完整。
- **Rule:** MVP 在 Worker 中使用 TypeScript 6.0.3 的稳定公开 Compiler API 维护增量 Program/Language Service，权威负责 import/export、模块解析、tsconfig paths、project references、workspace 跨包引用和基础符号。不依赖 VS Code 内置 TypeScript Server 私有状态；TypeScript 7 unstable API、Tree-sitter、LSP、SCIP 不进入首个实现。WorkspaceDiscoverySummary 是判别联合：single={packageCount:0}；recognized={kind:npm|yarn|pnpm, packageCount>=1}；degraded={detectedKind?, packageCount:0, diagnosticRef}。检测到 workspace 意图但无法可靠枚举边界时必须进入 degraded，退化为普通单 indexing-root 的文件/目录/源码索引，不生成 workspace-package 节点或 package 聚合结论，不阻断其余 TS/JS 图谱；diagnosticRef 必须指向 workspace-discovery-degraded 诊断及恢复动作。

### AD-6 — [ADOPTED] 生成数据属于用户缓存，策略属于仓库

- **Binds:** FR-4, FR-5, FR-12, FR-19, FR-22, NFR-security-privacy
- **Prevents:** 图谱数据库误提交、文件监听自触发、团队规则无法共享。
- **Rule:** 仓库只保存 .codegraph/rules.yaml 与 .codegraphignore；graph.sqlite、服务元数据、锁、日志、LastValidIgnoreRecordV1 和临时文件位于 OS 用户缓存的 workspace-key 目录。仅服务打开 SQLite，启用 WAL、foreign keys、synchronous=NORMAL 和有界 busy timeout；迁移事务化，故障数据库先保留副本再重建。

### AD-7 — [ADOPTED] 查询返回渲染器无关的预算内 GraphViewModel

- **Binds:** FR-6..FR-10, FR-17, FR-21, FR-23, SM-1, SM-2
- **Prevents:** UI 直接查询数据库、Cytoscape 格式成为领域模型、客户端各自实现聚合与截断，或服务与 Webview 对 package、降级和取消状态各自解释。
- **Rule:** 服务返回渲染器无关的 GraphViewModel。MVP 图形 surface 的 nodeKind 只允许 file/directory/workspace-package/external-package；external-package 必须另带 externalKind=npm-package|node-builtin、externalId 与 displayName，Node built-in 不得被过滤且保留 incident edges。目录或 workspace package 的聚合是独立视图属性，携带 AD-25 ProjectionMembershipV1 对应的 scopeRoot、groupBy、aggregationDepth、membershipDigest、hiddenNodeCount 与 expandToken，不得伪装为新领域类型。NavigationTargetV1 是封闭联合：file={relativePath}、directory={relativePath}、symbol={symbolId,relativePath,range}；file/directory 节点分别使用对应分支，workspace-package 使用 directory{relativePath:<package-root>}，symbol-centered 查询中的对应 file 节点使用 symbol 分支，external-package 不携带 V1 本地目标。service/status 与 service/statusChanged 的唯一权威合同是 ServiceStatusV1={serviceInstanceId,statusEpoch,serviceStatusRevision,indexStatus,telemetryStatus,configRevision,viewConfigRevision}；serviceStatusRevision 与 indexStatus.statusRevision 只在同一 statusEpoch 内单调；任何 index/telemetry/config/viewConfig 可观察变化都推进 serviceStatusRevision。statusChanged 携带完整原子快照，客户端在同一 epoch 只接受更高 revision；serviceInstanceId/statusEpoch 改变时无条件替换本地状态并全量重取，不比较旧 epoch 计数。IndexStatusSummaryV1 含单调 statusRevision、currentIndexJob?、lastIndexJob? 与 committed cache；只包含 snapshot mutation Job，check/impact/export 只经 job/get 暴露。currentIndexJob 只允许 queued/running，lastIndexJob 只允许 succeeded/failed/cancelled；progress 是 determinate{unit,completed,total} 或 indeterminate{unit,completed}。WorkspaceStatus 固定为 lifecycle=stopped|starting|running|stopping|failed、availability=absent|available、freshness=null|current|stale、completeness=empty|partial|complete；absent 只能配 committed=null、null+empty，available 必须有 committed 且只能配 current|stale、partial|complete。graph 与 Findings 的 freshness/completeness 逐轴合成：两者均 current 时 overall freshness=current，否则 stale；两者覆盖均 complete 时 overall completeness=complete，否则 partial；stale 不推出 partial。refreshing 由 currentIndexJob 派生，cancelled 来自 lastIndexJob，idle 由无 currentIndexJob 派生。任何 Job、progress、lifecycle 或 committed summary 可观察变化都推进 statusRevision。模型携带 serviceInstanceId、statusEpoch、viewId、queryFingerprint、graphRevision、findingsRevision、statusRevision；queryFingerprint 覆盖 indexingRoot、center/scope、relation/direction/filter、depth、node/edge budget、scopeRoot/groupBy/aggregationDepth/membershipDigest、rankingVersion、expand lineage、viewConfigRevision，不包含数据 revision 或隐私/遥测配置。GraphViewPatchV1 是 delta|invalidate 判别联合：delta 是两个已物化 GraphViewModel 的精确差量，完整覆盖节点、边、Finding、排序、聚合、截断、WorkspaceDiscoverySummary 与 IndexStatusSummaryV1，并携带相同 serviceInstanceId/statusEpoch/viewId/queryFingerprint 及 base/next graph/findings/status revision；客户端只接受当前 epoch 且全部身份/基线匹配的消息，再一次性应用和发布。invalidate 携带 serviceInstanceId/statusEpoch/viewId/queryFingerprint/baseStatusRevision/reason；epoch 改变时旋转 viewId、清空 extension→Webview 待处理 patch 并全量重取，旧 epoch 消息直接丢弃；任一时钟断档或无法生成精确 delta 时同样全量重取。

### AD-8 — [ADOPTED] 所有长操作使用可恢复 Job

- **Binds:** FR-1, FR-3, FR-15..FR-18, FR-20..FR-22, NFR-reliability
- **Prevents:** 保存、rebuild、check 与 impact 乱序执行，断线后任务丢失或重复启动，或取消操作清空仍可读取的缓存。
- **Rule:** Job 状态固定为 queued/running/succeeded/failed/cancelled，并携带 baseGraphRevision、baseFindingsRevision、resultGraphRevision、resultFindingsRevision；queued/running 的 result pair 必须为 null，terminal 的 result pair 表示 Job 结束时最新已提交 snapshot，未提交时等于 base。只读 Job 的 terminal result 表示实际读取或比较的目标 snapshot，成功性只由 state 表达。每 indexing root 只有一条 snapshot mutation channel，任何时刻最多一个 currentIndexJob；查询只读已提交 revision。VS Code watcher、服务 watcher、显式 CLI/Git 操作只提供可能丢失、重复或乱序的变更候选，绝不作为文件系统强一致证明；服务重新读取文件并以内容 hash 为真相。候选按路径合并，经 quiet settle window 与最大等待上限后处理。watcher overflow、Git HEAD/配置变化或服务恢复触发 manifest reconciliation scan；有客户端连接时每次 reconciliation 完成后至多 5 分钟启动下一次有界对账，显式 rebuild/check/impact/export 开始前也必须先完成或复用一次对账。服务 bootstrap 固定为 watcher-first：取得锁并完成迁移后先注册 source/config/manifest watchers，再执行 reconciliation scan；扫描期间已观察事件按路径合并并重新读取，直到 watcher generation 与 ManifestSnapshot、AnalyzerConfigSnapshot、EffectiveIgnoreSnapshotV1、RulesSnapshotRef 在同一 bootstrapGeneration 上收敛并原子发布。首个 snapshot mutation Job 及其提交 CAS 必须绑定 bootstrapGeneration，并在提交前重新 hash 完整 bootstrap read-set；任何较新事件或 hash 差异使其失效并重排。current 只表示已提交快照匹配最近一次完成的内容对账；对账后发生且 watcher 静默丢失的变化允许短暂未观测，但必须由下一次有界对账发现并转 stale。手动 rebuild 吸收未执行增量任务。Job 由服务持有，使用 clientRequestId 去重，取消仅在事务外安全点生效。manifest、EffectiveIgnoreSnapshotV1 或 inputDigest 一旦不同于已提交快照，freshness 立即变 stale。取消转换固定为：check/impact/export 等只读 Job 不改变 committed cache；变更 Job 在首次提交前取消保留旧 completeness，但不得把已检测到差异的快照恢复为 current；首次提交后取消，或 rebuild 未完成完整 reconciliation，必须保留最新已提交 revision 并标记 partial/stale，直到后续 rebuild 成功。completedScope 使用 determinate/indeterminate progress 同一单位；lastJobError 只属于 terminal lastIndexJob。任何取消都不得删除、回滚或把未提交 GraphPatch 暴露为缓存。

### AD-9 — [ADOPTED] rules.yaml 以 JSON Schema 为唯一公共契约

- **Binds:** FR-12..FR-15, FR-18
- **Prevents:** 插件、CLI 和规则引擎对同一配置产生不同解释。
- **Rule:** .codegraph/rules.yaml v1 由 JSON Schema 2020-12 定义，version 必须为 1，所有对象拒绝未知字段，rule id 全局唯一，severity 只允许 warning/error。forbidden-dependency 使用 from/to；layer-order 按声明顺序允许依赖自身及后续层、禁止反向依赖；no-cycle 的 scope 只允许 file/directory/package，并通过 AD-25 的 CycleProjectionKernelV1 在规则过滤后的有向图上计算 SCC：大小大于 1 或含自环的 SCC 产生一个 Finding，不按所有 simple cycle 分裂。路径相对工作区并使用 /，glob 中 * 只匹配一段、** 可跨段。rules.yaml 的全局 ignore 只裁剪规则评估范围：在已由 AD-14 `.codegraphignore` 裁剪的 file graph 上，先删除命中文件及全部 incident edges，再执行规则匹配和 directory/package 投影；禁止先聚合再重新解释 glob。被 rules ignore 命中的实体仍保留在规范图谱、普通查询、workspace package 聚合与索引规模统计中；只有 `.codegraphignore` 能改变索引范围。YAML 保留 CST/范围，Ajv 严格校验。ConfigDiagnosticV1 为 Problems、CLI 与 doctor 的唯一配置诊断合同，至少包含 code/severity/message/relativePath/range/instancePath/invalidValue/suggestedAction 与可选 ruleId。配置无效时保留上一有效 Findings、推进 findingsRevision 并全部标记 stale，禁止产生 resolved；只有有效配置在完整 scope 上成功评估后，缺失 Finding 才能转为 resolved。

### AD-10 — [ADOPTED] VS Code 表面职责不可重叠

- **Binds:** FR-6..FR-10, FR-13, FR-22, UJ-1..UJ-4
- **Prevents:** TreeView、Webview、Problems 和状态栏复制状态与业务逻辑。
- **Rule:** Activity Bar/TreeView 负责状态入口与导航；Webview Editor 负责 Overview、Current Context、Changes 的图与等价列表；Problems 只承载可定位诊断；Status Bar 只显示单行服务状态；全部操作同时注册 Command Palette。扩展持有语义会话状态，Webview 只持有视觉状态。ContextLock 仅存在于当前 extension-host 会话内：Webview reload 可由扩展内存恢复，窗口 reload、VS Code 重启或重新打开工作区后必须清除；workspaceState/globalState 不得保存固定标记，筛选、范围和视图模式可独立持久化。

### AD-11 — [ADOPTED] 不受信任工作区不运行分析

- **Binds:** all VS Code capabilities, NFR-security-privacy
- **Prevents:** 恶意仓库利用解析器、路径、项目配置或 Webview 扩大本地攻击面。
- **Rule:** VS Code Workspace Trust 未授予时不启动服务、不读取项目文件、不运行 Git 分析。POSIX 缓存目录为 0700、文件与 socket 为 0600。Windows 缓存、令牌和服务元数据放在 OS 当前用户缓存并继承用户配置文件 ACL；Node 24/libuv 命名管道使用其默认安全描述符，不承诺公共 API 无法兑现的 current-SID-only pipe DACL。Windows endpoint 带随机不可猜后缀，服务在处理任何业务请求前校验缓存中随机令牌、workspace-key 与协议版本，并限制失败握手。所有路径 realpath 后验证位于 indexing root，拒绝路径穿越和外部符号链接。MVP 硬限制为：单文件 10 MiB、最多 20000 个候选源码文件、1000 条规则、YAML alias 50、查询 3 跳/500 节点/1000 边、64 个待处理显式 Job；超过限制返回稳定诊断，不静默截断规则或执行项目代码。Webview 使用严格 CSP、nonce、本地资源根和消息 Schema 校验，不直接连接服务。

### AD-12 — [ADOPTED] 交付不依赖运行时下载或全局 daemon

- **Binds:** FR-20..FR-22, NFR-reliability, deployment
- **Prevents:** 用户环境 Node/ABI 漂移、安装后联网下载和不同客户端争抢不兼容服务。
- **Rule:** CLI 作为要求 Node 24 LTS 的 npm 包发布；VS Code 使用平台特定 VSIX，携带同源服务构建、精简 Node 24 LTS 运行时和对应 Node ABI 的 SQLite 模块，服务不依赖 VS Code/Electron ABI。engines.vscode 下限为 1.125.0，发布 CI 同时验证 1.125.0、最新稳定版与前一稳定版。esbuild 必须 externalize better-sqlite3，平台打包步骤复制精确原生文件、Node runtime 与许可证。连接握手交换 client/service/protocol/schema 版本；不兼容时拒绝并提示更新，不启动第二实例。MVP 构建目标为 Windows x64、macOS arm64/x64、Linux x64。

### AD-13 — [ADOPTED] CLI 是稳定的公共自动化契约

- **Binds:** FR-15..FR-18, FR-20, FR-23, UJ-4, UJ-5
- **Prevents:** 人类输出、CI 输出与服务协议混杂，脚本依赖不稳定文本。
- **Rule:** 单一 codegraph 提供 rebuild/query/check/impact/export/status/doctor/cache 子命令。默认文本，--format json 的 schemaVersion:1 envelope 至少包含 command、workspaceKey、graphRevision、findingsRevision、status、data、diagnostics、error；impact/export 可输出 Markdown。结果写 stdout，进度与可恢复警告写 stderr，机器模式无 ANSI。退出码固定为：0 成功或仅 warning，1 error 规则违反/失败条件命中，2 参数/工作区/配置无效，3 分析/存储/内部失败，4 协议或 schema 不兼容，130 取消；路径一律相对工作区。

### AD-14 — [ADOPTED] 策略配置与运行偏好分离

- **Binds:** FR-4, FR-12, FR-20..FR-23
- **Prevents:** 用户设置隐式关闭团队规则，或仓库策略绑死个人性能与 UI 偏好。
- **Rule:** rules.yaml 与 codegraphignore 由仓库独占；显式 --config 只影响当前命令并报告来源。.codegraphignore v1 是确定性的 gitignore-style 子集：严格 UTF-8 按行解析，空行和未转义 # 起始行为注释，未转义前导 ! 表示反选，最后一次匹配生效；前导 / 锚定 indexing root，尾随 / 只匹配目录及后代，反斜杠只转义下一字符；规范路径统一 / 且区分大小写，* 与 ? 不跨路径段，** 跨零个或多个路径段，字符类不支持并按字面量处理。BuiltinIgnoreV1 的有序规则固定为 `/.git/`、`**/node_modules/`、`**/.pnpm/`、`**/dist/`、`**/build/`、`**/out/`、`**/coverage/`、`**/.next/`、`**/.nuxt/`、`**/.svelte-kit/`、`**/.turbo/`、`**/.cache/`、`**/generated/`、`**/.generated/`、`**/__generated__/`；内置规则先应用，用户规则后应用，因此显式 `!` 可重新纳入。graph-service 是原文件的唯一解释者，生成 EffectiveIgnoreSnapshotV1={version:1,generation,validity:valid|invalid,contentHash|null,builtinRulesVersion:"builtin-ignore-v1",userRules,effectiveRules,effectiveDigest,lastValidDigest}。确认文件不存在时建立 generation=0、validity=valid、contentHash=null、userRules=[] 的空用户规则快照，但 effectiveRules 必须已包含 BuiltinIgnoreV1；已有文件在当前 statusEpoch 从 generation=1 开始，任意原始内容变化推进 generation，generation 不跨实例持久化。effectiveDigest 对 {version,builtinRulesVersion,effectiveRules} 执行 RFC 8785 JCS → UTF-8 → SHA-256。每次 valid snapshot 原子写入 LastValidIgnoreRecordV1={workspaceKey,grammarVersion:1,builtinRulesVersion,userRules,effectiveRules,effectiveDigest,acceptedContentHash,checksum}；跨重启遇到 invalid 文件时，只有 workspace、grammar、builtin version 与 checksum 均匹配才恢复该记录，否则回退空用户规则与 BuiltinIgnoreV1。“首次 invalid”只指没有可恢复历史 valid 记录。invalid ignore 保持工作区 stale，只有后续 valid generation 完成 reconciliation 才能恢复 current。scanner、AnalyzerConfigSnapshot、doctor、CLI 与 UI 只消费该 snapshot、过滤后的候选集或服务返回的排除摘要，不得再次解析原文件。命中 effectiveRules 的路径不得进入节点、边、Evidence、workspace package 聚合、规则检查或成功指标；重新纳入时仍使用原确定性 ID。所有原始内容变化和 LastValidIgnoreRecordV1 恢复结果都进入 bootstrap read-set 与完整 snapshot mutation CAS，只有 effectiveDigest 变化进入语义 configDigest；服务启动以 effectiveDigest 对比已提交 snapshot 判断语义缓存是否变化。运行偏好优先级为 CLI > workspace settings > user settings > defaults。Workspace Trust、IPC、路径、CSP、默认不上传、禁止执行项目脚本和服务端安全预算不可覆盖。源码导出的默认 requestedPolicy=structure-only 同样不可被持久设置覆盖；include-source 只能来自当前 CLI invocation 或当前交互导出命令中的显式授权。

### AD-15 — [ADOPTED] 图与列表必须任务等价

- **Binds:** FR-10, NFR-accessibility, UX DESIGN, UX EXPERIENCE
- **Prevents:** 核心信息只能通过画布、颜色或动画理解。
- **Rule:** GraphViewModel 的节点、边、Finding、变化与截断信息必须可由图和列表完成同一核心任务；关系和风险同时使用文字、方向、图标/线型，不只依赖颜色。图内键盘语义固定为 Tab 进入区域、方向键遍历邻接节点、Enter 选择/打开、Space 展开聚合、Esc 返回；屏幕阅读器可获得节点类型、入/出边数、Finding 数、边方向、来源与置信度。主题、字体、焦点、高对比和减少动态效果服从 VS Code；布局在 Web Worker 中运行。刷新后只要稳定 ID 仍存在，就必须保留中心节点、选择、展开、缩放和列表位置。

### AD-16 — [ADOPTED] 可观测性默认本地，遥测默认空实现

- **Binds:** FR-19, FR-22, SM-1..SM-6, NFR-security-privacy
- **Prevents:** 为诊断性能而上传项目结构、不同模块使用无法关联的日志，或用户关闭遥测后活动 Job 仍继续发送事件。
- **Rule:** 本地结构化日志使用 requestId、jobId、workspaceKey、graphRevision 和错误 code 关联，日志有界轮转且不记录源码正文。性能基准与诊断可本地导出。TelemetryPort 默认 Noop；只有显式 opt-in 才能发送编译期允许列表中的匿名事件、耗时、计数与错误分类，禁止源码、diff、完整路径、符号、图谱或规则内容。TelemetryStatusV1={requestedState,effectiveState,requestedConfigRevision,appliedConfigRevision,pending} 必须进入 ServiceStatusV1；service/status 与 statusChanged 是唯一权威。任何 off 请求都必须在同一临界区取消所有较早 pending-on、切回 Noop、拒绝新事件、丢弃未发送缓冲、递增并广播 configRevision，响应返回 effectiveState=off 与 appliedConfigRevision，不等待活动 Job 边界。

### AD-17 — [ADOPTED] Finding 身份稳定，“新增”只相对于基线

- **Binds:** FR-11..FR-18, UJ-3, UJ-4
- **Prevents:** 同一违规在刷新后反复变成“新增”，或 IDE 与 PR 摘要使用不同的新旧定义。
- **Rule:** Finding ID 为 ruleId、scope 与 canonicalSubject 的哈希：单边规则的 canonicalSubject 为 edgeId；no-cycle 的 canonicalSubject 为 SCC 内规范 node ID 的排序数组。循环证据路径从字典序最小 node 开始、按 edge ID 升序 DFS，取第一条闭合路径。Finding 记录 firstSeenFindingsRevision、lastSeenFindingsRevision、boundGraphRevision 与状态 active/resolved/stale。图谱 partial/stale 时，未被完整评估 scope 覆盖的既有 Finding 只能转 stale；只有有效配置在完整 scope 上成功评估后，缺失 Finding 才能 resolved。FindingSummaryV1 固定 subject=edge{edgeId}|scc{nodeIds,evidencePathEdgeIds}，并携带 findingId/ruleId/ruleName/severity/status/boundGraphRevision、expectedConstraint、relativeLocations 与 detectedAt。comparisonContext 固定为 job{baseFindingsRevision}|git{baseRef,baselineId,derivedFromGraphRevision,derivedFromFindingsRevision}|none；Git canonical baseRef 固定为 workspace-key/subroot、Git object-format 与解析后的完整 commit OID，branch/tag/短 SHA 仅作显示元数据。baselineId 继续哈希 canonical baseRef、规则/config digest 与派生输入，临时 Git 基线不得复用或推进主图 revision。comparison 固定 new|existing|not-applicable；无显式基线或 Finding 为 stale 时必须为 not-applicable。Problems、Findings、NodeDetails、ChangeSummary、CLI 与导出复用该合同，不得各自推导“新增”。

### AD-18 — [ADOPTED] PR 摘要与 AI 导出默认只含结构

- **Binds:** FR-17..FR-19, FR-23, UJ-4, UJ-5, SM-7, SM-8
- **Prevents:** 导出泄露源码、不同入口生成不可比较的摘要、生成失败时暴露部分内容，或目标写出失败后丢失已完整生成的 artifact。
- **Rule:** PrReviewSummaryV1 固定包含 verdict、majorRisks、keyPaths、新增风险、新增/删除边、受影响目录、循环变化、建议复查文件、graphRevision、findingsRevision、graphUpdatedAt 与 generatedAt。StructureContextExportV1 固定包含 scope、graphRevision、findingsRevision、graphUpdatedAt、generatedAt、entities、relations、rules、findings、truncation；内部 file/directory/workspace-package/symbol entity 必须含 id/nodeType/relativePath，外部 entity 从 GraphView externalKind 唯一映射为 external-package 或 node-builtin 并含 id/nodeType/externalId/displayName。服务只有在生成完整结束后才返回不可变 ExportArtifactV1；可复制或写出的 artifact 必须携带 artifactId、artifactStatus=complete、workspaceKey、artifactKind、format、scope、graphRevision、findingsRevision、requestedPolicy、effectivePolicy、containsSource、contentDigest 与 generatedAt，partial 或 generating 状态不得表示为 ExportArtifactV1。JSON content 使用 RFC 8785 JCS UTF-8，Markdown/text 使用无 BOM、LF 规范化 UTF-8；contentDigest 是最终 content 字节的小写十六进制 SHA-256。artifactId 是 `{schemaVersion:1,workspaceKey,artifactKind,format,scope,graphRevision,findingsRevision,requestedPolicy,effectivePolicy,containsSource,contentDigest}` 的 RFC 8785 JCS UTF-8 SHA-256，不含目标位置或 generatedAt。requestedPolicy/effectivePolicy 只允许 structure-only|include-source，默认为 structure-only；include-source 只能按 AD-14 由当前请求显式授权，effectivePolicy 只能与 requestedPolicy 相同或更严格，containsSource 必须从 artifact 实际内容推导且 structure-only 时为 false。生成失败不得暴露或复制部分内容；界面可以保留上一份完整 artifact，但必须标记其 generatedAt、revision/policy 和“上一份有效结果”。extension 在本地持有绝对目标、执行 clipboard/原子文件写入并组合 ExportPreviewModelV1，Webview 只接收脱敏 targetState。只有 clipboard、文件写入等目标操作失败时，才允许重试本次完整 artifact 或改用另一目标；目标重试不得改变 artifact 内容或身份。ExportArtifactV1 进入 ProductValidationEvidenceV1 时，evidence 必须同时引用 artifactId、contentDigest 与 AD-30 candidateRefDigest；`packages/application/validation` 的 evidence recorder 是 ValidationArtifactBindingV1={artifactId,contentDigest,candidateRefDigest,evidenceId,evidenceDigest} 的唯一写入者，绑定记录 append-only 并以 artifactId 做 CAS：相同候选重放幂等，不同 candidateRefDigest 冲突即 invalid，禁止把相同 artifact 重新标注到另一候选。
- **Validation binding transaction:** evidence recorder 以发布证据存储的唯一 service identity 写入；ProductValidationEvidenceV1 与 ValidationArtifactBindingV1 必须在同一个 append-only commit record 中原子提交，artifactId 与 evidenceId 分别唯一。恢复时存在孤儿 binding 或孤儿 evidence 均使该记录 invalid，不能补写或人工关联。

### AD-19 — [ADOPTED] 标准规模与性能线是发布门禁

- **Binds:** SM-1..SM-8, NFR-performance, NFR-reliability
- **Prevents:** 各模块用不同数据规模宣称达标，或 UI 达标但阻塞 extension host。
- **Rule:** 标准验收为 8 逻辑 CPU、16 GB RAM、SSD、最多 5000 个受支持文件、500000 LOC、50 workspace packages；首次概览不超过 60 秒，缓存邻域不超过 300ms，保存后局部更新与 Findings 不超过 2 秒。BenchmarkPlanV1 是性能发布门禁的唯一 oracle：仓库中的版本化 manifest 固定 fixture/digest、参考环境、每项 SLA 起止事件、cold/warm cache、2 次 warm-up、至少 20 次测量和 p95；reference runner preflight 必须核对分配的 8 vCPU/16 GB/SSD、fixture 与 toolchain digest，任一不匹配产出 invalid 并使 gate 失败。单一 benchmark harness 使用 process.hrtime.bigint() 从动作发起计时到同一 harness 观察到完成事件，禁止比较跨进程时钟；p95 使用 nearest-rank `x[ceil(0.95*n)]`。首次概览使用 clean cache，缓存邻域使用已提交 warm cache，保存更新从宿主 save 动作到对应 graph/Findings revision 可见；结果输出 BenchmarkResultV1 并由单一 gate command 判定。SM-4 同样由版本化 corpus manifest 与单一 gate command 判定：至少 500 条人工标注且争议经复核的声明，覆盖 ESM、CJS、re-export、type-only、literal require、literal dynamic import、path alias、跨 package、Node built-in 与负样本；规范依赖边 micro-F1 不低于 0.80，high-confidence 边 precision 不低于 0.90，并输出 precision、recall、F1、分类结果和失败样本。Beta 必须识别 npm/Yarn/pnpm workspace 边界和跨 package import。真实团队验证还必须证明用户首先感知“理解结构更快”而非“图更好看”，且 Tech Lead 能直接使用 PR Markdown 讨论风险。超规模时不承诺相同 SLA，但不得阻塞 extension host，必须显示进度并可取消。

### AD-20 — [ADOPTED] 协议、图谱、规则和 CLI Schema 独立版本化

- **Binds:** FR-5, FR-12, FR-20..FR-23, deployment
- **Prevents:** 一个 version 字段同时表示传输、数据库、配置和导出，导致错误迁移或错误兼容。
- **Rule:** protocolVersion、graphSchemaVersion、rulesSchemaVersion、cliSchemaVersion 分别演进。协议 major 不同即拒绝，minor 通过 capabilities 协商；graph schema 只由服务事务化迁移，旧服务不得降级写入新 schema，缓存可在保留故障副本后重建；rules v1 与 CLI schemaVersion:1 的破坏性变更必须升版。

### AD-21 — [ADOPTED] Evidence 置信度和冲突处理固定

- **Binds:** FR-2, FR-5, FR-14, SM-4
- **Prevents:** 分析器使用不可比较的分数、低置信推断触发 error Finding，或冲突证据被静默覆盖。
- **Rule:** confidence 只允许 high/medium/low；language 只允许 typescript/typescriptreact/javascript/javascriptreact，detectedAt 使用 UTC ISO 8601。TypeScript 成功解析到具体目标的静态 import/export 为 high，部分解析或不完整项目上下文为 medium，启发式/动态推断为 low。Evidence 去重键为 edgeId、provenance、analyzerVersion、sourceFileId、normalizedRange、evidenceKind。MVP 规则引擎只评估 high 依赖边；medium/low 只能展示或导出并明确标注。权威来源对同一证据位置给出冲突目标时，生成分析诊断并排除该证据，不静默选边。

### AD-22 — [ADOPTED] 共享运行配置由服务持有版本化快照

- **Binds:** FR-3, FR-7, FR-19..FR-22, multi-client operation
- **Prevents:** VS Code 与 CLI 连接同一服务却使用不同并发度、settle、预算或日志配置，或隐私收紧被普通配置的 Job 边界延迟。
- **Rule:** graph-service 持有 EffectiveServiceConfig、configRevision、viewConfigRevision 与来源映射。首个启动者提交完整候选配置；后续客户端不得通过连接隐式覆盖。共享设置变更必须调用 service/reconfigure，服务按接收顺序 latest-wins 并为请求分配 requested configRevision；requested/applied revisions 在等待期间保持分离。配置应用边界固定为：无 currentIndexJob 时立即应用；存在活动 Job 时，在其进入 terminal 后、下一 Job dequeue 前应用。telemetry off 按 AD-16 立即提交；pending-on 只有在其 requestedConfigRevision 仍是最新 telemetry 请求时，才在应用边界实际启用并更新 TelemetryStatusV1 的 effectiveState=on/appliedConfigRevision/pending=false，否则作废。只有会改变视图形状或语义的配置才推进 viewConfigRevision；queryFingerprint 只绑定 viewConfigRevision。CLI 单命令参数仅为 request-scoped；视图模式、缩放等 session-scoped 偏好仍归客户端。

### AD-23 — [ADOPTED] 服务生命周期与升级交接可恢复

- **Binds:** FR-1, FR-20..FR-22, deployment, NFR-reliability
- **Prevents:** stale lock、孤儿服务、升级时强杀事务或两个版本同时持有缓存。
- **Rule:** 启动先取得 OS 排他锁，再生成非秘密 serviceInstanceId/statusEpoch 并原子写 service metadata；initialize 与 ServiceStatusV1 必须返回二者，状态计数器无需跨实例持久化。lifecycle=starting 时完成存储迁移后先注册 source/config/manifest watchers，再读取并校验 rules.yaml、codegraphignore 与 workspace manifests；在任何首次 rebuild/Analyzer Job 前，必须建立 AD-14 的 BuiltinIgnoreV1 和与 `.codegraphignore` 实际存在状态一致、Analyzer 可消费的 EffectiveIgnoreSnapshotV1：确认文件不存在才使用 generation=0 空用户规则，文件存在则从 generation=1 按 valid/invalid/last-valid 语义建立。扫描期间已观察事件按路径合并并重新读取，直到 watcher generation 与 ManifestSnapshot、AnalyzerConfigSnapshot、EffectiveIgnoreSnapshotV1、RulesSnapshotRef 在同一 bootstrapGeneration 上收敛并原子建立，之后才进入 running、接受查询或 dequeue 首个 snapshot mutation Job。确认 rules.yaml 不存在才建立 generation=0 空策略；已有有效文件直接建立有效 generation，已有无效文件建立 invalid generation、EMPTY_RULES_DIGEST 与诊断。首个 snapshot mutation Job 及提交 CAS 绑定 bootstrapGeneration，并在提交前重新 hash 完整 bootstrap read-set；任何较新事件或 hash 差异使其失效并重排。watcher 不提供无丢失保证，运行期按 AD-8 的有界 reconciliation 恢复静默丢失。客户端用 PID liveness、token 和 endpoint 验证，只有确认进程不存在才回收 stale metadata。无客户端且无活动 Job 达 5 分钟后服务优雅退出。initialize、service/status、service/shutdown 构成跨应用协议 major 保持兼容的控制子集；升级关闭必须等待当前事务完成，取消排队 Job，关闭数据库与 endpoint，删除 metadata 后释放锁，新版本随后启动。禁止自动强杀活动事务。

### AD-24 — [ADOPTED] TS/JS 语法到规范关系的映射唯一

- **Binds:** FR-2, FR-5, FR-11..FR-14, SM-4
- **Prevents:** 两个分析器对同一语法分别生成 imports/exports 或不同 qualifier，及孤儿外部节点长期残留。
- **Rule:** 模块目标解析优先级固定：Node built-in → TypeScript resolvedFileName 位于 indexing root 内的 file（workspace package 关系由投影派生）→ root 外 resolved package 的最近 package.json 版本 purl → 未解析 bare specifier 的 pkg:npm/name@unresolved（medium）→ 未解析 relative/absolute specifier 只报诊断、不建 edge。type/value 只按源码语法判定：statement-level import type/export type、specifier-level type modifier、ImportEqualsDeclaration.isTypeOnly 为 type；其他 static import/export、side-effect import、default/namespace import、literal require 为 value，不读取 emit 结果或 SymbolFlags；混合 declaration 按 specifier 独立拆边。ImportEqualsDeclaration 只有 moduleReference 为 ExternalModuleReference 且 expression 为字符串 literal 时生成 imports(type/value)；EntityName 内部别名不生成模块 edge。import() 仅在字符串 literal 时生成 imports(dynamic)。本地 named/default export 每个导出绑定生成一条 file→local symbol edge，qualifier 分别为 local:<exportedName>:type|value 或 default:type|value；带 from 的 named re-export 每个 specifier 生成相应 imports edge，并生成一条 file→target module entity 的 exports edge，qualifier 为 reexport:<exportedName>:<importedName>:type|value；export * from 每个 declaration 生成一条 imports edge与一条 file→target module entity 的 exports edge，qualifier 为 star:type|value。references 在 MVP 不生成。最后 active Evidence 消失时同事务删除 edge、重算 depends_on；外部节点引用计数归零删除，内部节点只由 ownership slice 删除。

### AD-25 — [ADOPTED] Overview 指标与基础循环投影唯一

- **Binds:** FR-6, FR-7, FR-11, FR-14, FR-21, SM-1, SM-2, SM-6
- **Prevents:** CLI、Overview 与规则引擎分别解释依赖强度、热点或循环，及 Beta UI 反向依赖尚未交付的规则 Story。
- **Rule:** application/querying 唯一生成 ProjectionMembershipV1={scopeRoot,groupBy:directory|workspace-package,aggregationDepth,fileToLeafAggregate}，每个文件只能属于一个当前查询叶子聚合节点，禁止向祖先重复累计。groupBy=directory 时取 scopeRoot 下最多 aggregationDepth 段的最近目录祖先，scopeRoot 直接文件归 scopeRoot；groupBy=workspace-package 时取包含文件的最深 recognized package root，非 package 文件归 indexing-root 聚合，等深冲突按规范 root ID 升序。scopeRoot、groupBy、aggregationDepth 和 membership digest 进入 queryFingerprint。CycleProjectionKernelV1、dependencyStrength 与 FindingAttributionKernelV1 必须消费同一 membership。CycleProjectionKernelV1 对 high-confidence 内部 imports 构造确定性有向图：file scope 保留自环；directory/workspace-package scope 折叠端点、去重并移除聚合自边；大小大于 1 的 SCC 或 file 自环构成基础循环，projectionId=hash(kernelVersion,scope,sortedNodeIds)，cycleMemberCount 为节点所在循环 SCC 的成员数，否则为 0。BaseCycleProjectionV1 不读取 rules.yaml，必须在 Alpha 查询切片完成并先于 Beta Overview；no-cycle 规则在应用 rules ignore 后复用同一 Kernel 与 canonicalization。FindingAttributionKernelV1 对 active Finding 按 findingId 去重：edge subject 对存在的每个内部端点叶子聚合各计一次，同一聚合只计一次；SCC subject 对每个相交叶子聚合各计一次。合法空 RulesV1 基线下 active error/warning 计数固定为 0，不形成对后续 rules Story 的依赖。OverviewMetricV1 中 dependencyStrength 等于源、目标聚合节点间不同 high-confidence 文件级 imports 规范边数量，同一规范边的多条 Evidence 只计一次；internalDependencyStrength 是与其他内部聚合节点之间入向与出向 dependencyStrength 总和。热点按 active error、active warning、cycleMemberCount、internalDependencyStrength 降序，再按规范 node ID 升序；完整范围先排序再截断。仅 freshness=current 且 completeness=complete 时发布正式排名；stale 标记“可能过期”，partial 标记“基于部分结果”，两者不得显示正式排名徽标。rankingVersion 固定为 overview-metric-v1 并进入 queryFingerprint。

### AD-26 — [ADOPTED] ImpactVerdictV1 是结构影响的唯一结论

- **Binds:** FR-16..FR-18, FR-20, UJ-4, SM-8
- **Prevents:** IDE、CLI、Markdown 对相同变更给出不同 verdict、主要风险或复查顺序。
- **Rule:** application/impact 是 CycleDeltaV1、RankedRiskV1 与 ImpactVerdictV1 的唯一生成者，后续 VS Code、Markdown 与 CLI 入口只消费和呈现。CycleDeltaV1 必须比较绑定显式 canonical baselineId 的同 scope、同 kernelVersion 基线/当前投影：当前新增 projectionId 为 new，交集为 existing，基线消失为 resolved；SCC split/merge 自然表现为旧 resolved 与新 new，缺少基线或任一投影不完整时为 not-applicable。canonicalRiskId 只允许 finding:<findingId> 或 cycle:<scope>:<projectionId>。verdict 只允许 pass/review/block/unknown，判定优先级为 block > unknown > review > pass：存在权威 new+active+error Finding 时始终 block，并在范围不完整时同时标记 coverageIncomplete；无确定 error 但受影响范围 partial/stale、配置无效、Finding/Cycle comparison=not-applicable 或影响计算不完整时为 unknown；完整分析存在新增 active warning 或 CycleDeltaV1 new 时为 review；否则为 pass。existing 风险默认不改变 verdict，resolved 不导致失败，展示截断不改变 verdict。ImpactRankV1 的 riskClass 顺序固定为 new active error、新增循环、new active warning、existing active error、既有循环、existing active warning、stale/not-applicable；resolved 不进入 majorRisks。majorRisks 按 riskClass、canonicalRiskId；keyPaths 与 suggestedReviewFiles 按关联最小 riskClass、changeRole=changed-source|changed-target|affected|context、从变更集合起的最短有向依赖 hop、相对 POSIX 路径排序。PrReviewSummaryV1、ChangeSummary、CLI JSON/文本与 Markdown 必须复用 verdict、coverage 和排序结果，不得重算。

### AD-27 — [ADOPTED] BasicSymbolV1 限定 MVP 符号边界

- **Binds:** FR-2, FR-9, FR-23, NFR-evolvability
- **Prevents:** 一个分析切片抽取全部成员/局部变量，另一个只抽取导出符号，导致 ID、导航、导出与性能不可比较。
- **Rule:** BasicSymbolV1 只覆盖 TypeScript SourceFile 顶层、具有稳定名称与可导航名称范围的 function、class、interface、type-alias、enum、variable、namespace；每项固定携带 symbolId、kind、name、relativePath、SourceRangeV1 与 exported。身份与 ownership 保持 AD-3/AD-4 的 file scope：只合并同一 SourceFile 内的多声明绑定，由该 source:<analyzerKind>:<fileId> slice 唯一拥有与 tombstone；跨文件 interface/namespace declaration merging 在每个声明文件生成独立 BasicSymbolV1，不创建共享 owner。导航范围在同文件内优先实现声明，否则按 range.start 升序取第一项；输入枚举顺序不得影响结果。成员、参数、局部变量、import alias、匿名声明、调用图与 references 不进入 MVP。BasicSymbolV1 可用于 symbol-centered 查询、NavigationTargetV1 与结构导出，但不增加第五种默认 GraphViewNodeKind，也不改变 AD-24 的 references 延后决定。

### AD-28 — [ADOPTED] 能力首次落地即进入渐进式 CI

- **Binds:** all, deployment, traceability
- **Prevents:** 架构门禁只在发布尾声首次运行、尚未实现的能力用空测试占位，或 Story 完成但共享合同没有自动保护。
- **Rule:** Story 1.1 必须建立真实、可失败、可阻断的最小仓库 CI，并以稳定 check 名 `architecture-required` 运行 type、lint、unit、build、contract、dependency-boundary 与 basic-security；Story 1.2 只能通过该 CI 顺序合并。Story 1.3 必须把最小 CI 升级为完整架构门禁：`ci/quality-gates.v1.yaml` 是 gate 定义注册表；GateDefinitionV1 固定 `{gateId,checkId,triggerPaths,command,capabilityOwner,blocking}`，triggerPaths 必须排序去重，command 是 argv 字符串数组，gateDefinitionDigest 是该对象 RFC 8785 JCS UTF-8 的小写十六进制 SHA-256。ReadinessGateManifestV1 只负责按 policy、候选和阶段选择适用 gate，必须引用注册表 gateId 并携带匹配的 gateDefinitionDigest 与 command，不得重定义 gate。`architecture-required` 自身不允许 path filter，必须对每个 PR 运行；triggerPaths 只决定子 gate 的 required|not-applicable|invalid 状态，使用 AD-14 的规范 POSIX glob 语义但禁止反选。GateEvaluationContextV1 固定 providerRepositoryId、Git objectFormat、provider 提供的完整 baseOid/headOid，以及 `comparisonBaseOid=git merge-base(baseOid,headOid)`；affected paths 只由固定 OID 上的 `git diff --name-status -z --no-renames comparisonBaseOid headOid` 产生，重命名按 delete+add，删除使用旧路径，缺失 triggerPaths 表示 always applicable。manifest 无效、未知 gate、definition/command digest 不匹配、required gate 无有效证据、provider ruleset 或 drift monitor 不一致时均 fail closed。Story 1.3 后，仓库外 ArchitectureGateController app/service identity 是 `architecture-required` 结论的唯一发布者，结论 CAS 绑定 `{providerRepositoryId,headOid,manifestDigest}`，陈旧 head 结论不可复用；仓库 workflow 只能提交 child evidence。release/platform owner 持有 provider ruleset、Controller 与独立 drift monitor，Story 1.3 必须记录实际 provider、plan、权限和禁用 bypass 的能力证据，provider 不具备仓库外强制能力时 Story 1.3 阻塞，不得降级为仓库内自检。Story 1.3 还必须加入规划引用与 FR/NFR/AR/UX-DR/Story 双向追踪；完成前不得并行启动 Story 1.4 及其他功能 Story。“能力首次落地”固定为生产代码首次可由公共 CLI/RPC/extension 入口调用，或公共 Schema 首次发布；门禁必须在同一 PR 启用并持续阻止后续合并。首次 rebuild/SQLite 加入迁移、按需建表与快照；确定性提交加入 GraphPatch 幂等、完整 CAS、过期重排和半提交不可见；CLI 加入 JSON/stdout/stderr/退出码；VS Code 加入 Electron/Workspace Trust/CSP；rules/check 加入 Schema/Finding/退出码；impact/export 加入 CycleDeltaV1/ImpactVerdictV1/导出与默认无源码隐私。尚未实现的能力不得添加空测试、永久 skip、无断言或始终成功脚本。
- **Registry and context identity:** GateRegistryV1 固定 `{schemaVersion:1,gates}`，gates 按 gateId 升序且每项含 GateDefinitionV1 与 gateDefinitionDigest；gateRegistryDigest 是省略自身 digest 后的 RFC 8785 JCS UTF-8 SHA-256。`git merge-base --all baseOid headOid` 的完整 OID 集合按字典序排序，最小值才是 comparisonBaseOid；空集合为 invalid。GateEvaluationContextV1 还必须携带 gateRegistryDigest，evaluationContextDigest 是完整 context 的 RFC 8785 JCS UTF-8 SHA-256。
- **Child evidence and CAS:** GateEvidenceV1 是 child gate 唯一封闭合同：`{schemaVersion:1,gateId,gateDefinitionDigest,evidenceProducerId,evaluationContextDigest,headOid,status,outputDigest}`，status 只允许 pass|fail|invalid。GateDefinitionV1 必须声明 evidenceProducerId；Controller 只接受 provider-authenticated 且与定义匹配的 producer，同 gate/evaluationContextDigest 的相同 evidence digest 重放幂等，冲突证据为 invalid。`architecture-required` 结论 CAS 绑定 `{providerRepositoryId,headOid,evaluationContextDigest}`，发布前必须重新核对 provider 当前 base/head；任一变化都废弃旧结论并重算。
- **Gate evidence identity:** GateEvidenceV1 还必须包含 gateEvidenceDigest；该 digest 是省略 gateEvidenceDigest 字段后的完整 GateEvidenceV1 对象 RFC 8785 JCS UTF-8 小写十六进制 SHA-256。Controller 的幂等重放、冲突与缓存键只使用 gateEvidenceDigest，不得使用运行时对象地址、时间戳或 provider check URL。
- **GateDefinition refinement:** evidenceProducerId 是 GateDefinitionV1 的必填字段，并与 gateId/checkId/triggerPaths/command/capabilityOwner/blocking 一起进入 gateDefinitionDigest；前述简写字段列表不得被解释为排除它。
- **Refinement precedence:** `Registry and context identity`、`Child evidence and CAS`、`GateDefinition refinement` 是对 Rule 中 `git merge-base` 与 manifestDigest 简写的权威收敛；comparisonBaseOid 必须使用 `--all` 后的最小 OID，umbrella CAS 必须绑定 evaluationContextDigest，不再绑定未限定的 manifestDigest。

### AD-29 — [ADOPTED] 发布候选必须可追溯且可复现

- **Binds:** deployment, NFR-reliability, NFR-security-privacy
- **Prevents:** 两个平台或两次构建产出不同 payload 却共享同一版本号，及签名、许可证或原生 ABI 无法审计。
- **Lockfile identity:** LockfileDigestV1 固定为 Git 中已提交 `pnpm-lock.yaml` 的无 BOM、LF 规范化 UTF-8 字节的小写十六进制 SHA-256；所有 release 与 source CandidateRef 只能使用该值。
- **Rule:** release CI/packaging 唯一生成四个由 JSON Schema 2020-12 定义且 `additionalProperties:false` 的合同。ReleaseArtifactManifestV1 固定字段为 schemaVersion:1、artifactId、artifactKind=cli-npm|vscode-vsix、productVersion、platform=multi|win32|darwin|linux、arch=multi|x64|arm64、nodeVersion、nodeAbi、protocolVersion、graphSchemaVersion、rulesSchemaVersion、cliSchemaVersion、sourceCommit、lockfileDigest、toolchainDigest、payloadEntries、payloadRootDigest、licenseDigest、sbomDigest；artifactId 公式固定为 CLI=`codegraph-cli-npm`、VSIX=`codegraph-vsix-<platform>-<arch>`，payloadEntries 是按相对 POSIX path 升序的封闭 `{path,mode,size,sha256}` 数组。payloadRootDigest 对 payloadEntries 执行 RFC 8785 JCS → UTF-8 → SHA-256，输入域排除 artifact/set manifest 自身及签名、时间戳、provenance attestation；SBOM 输出无 timestamp、serial、绝对路径的规范 SbomInventoryV1 JCS 文件，并作为普通 payload entry 纳入 root。两个隔离 clean checkout 的未签名 payloadRootDigest 必须一致。ReleaseTrustBundleV1 固定字段为 schemaVersion:1、sequence、rootKeyId、previousBundleDigest、keys、revocations、bundleDigest；keys 项固定 keyId/publicKeySpkiBase64/notBefore/notAfter，revocations 项固定 keyId/revokedAt/reason；bundleDigest 对省略 bundleDigest 的 unsigned body 执行 JCS SHA-256。repository-external ReleaseTrustAnchorV1 固定 offline root public key fingerprint，仓库 PR 不得修改；bundle sequence 必须单调，root signatures 使用 detached ReleaseSignatureV1(subjectKind=trust-bundle,subjectDigest=bundleDigest)，root rotation 需要旧/新 root 两个 detached signatures 后更新外部 anchor。ReleaseSetManifestV1 固定字段为 schemaVersion:1、productVersion、sourceCommit、lockfileDigest、protocolVersion、graphSchemaVersion、rulesSchemaVersion、cliSchemaVersion、trustBundleDigest、targetMatrix、artifacts、releaseSetId；targetMatrix 是按 artifactKind/platform/arch 排序的封闭 tuples，artifacts 按 artifactId/platform/arch 排序且每项只含 artifactId、artifactKind、platform、arch、artifactManifestDigest、payloadRootDigest。artifactId 与 artifactKind/platform/arch tuple 分别唯一，artifacts tuples 必须与 targetMatrix 一一相等，同一 release set 必须且只能包含一个 CLI 和目标矩阵的每个 VSIX；公共字段必须一致，releaseSetId 对省略 releaseSetId 的其余对象执行 JCS SHA-256，候选只能作为完整 release set 发布。ReleaseSignatureV1 固定字段为 schemaVersion:1、profile=`ed25519-sha256-v1`、subjectKind=trust-bundle|artifact-manifest|release-set-manifest、subjectDigest、keyId、signatureBase64；subjectDigest 是精确 JCS bytes 的 SHA-256，签名输入是该 32-byte digest，keyId 是 Ed25519 public key SPKI DER 的 SHA-256。候选只接受 ReleaseTrustAnchorV1 验证的最新 bundle 中处于有效期且未 revoked 的 delegated key；revoked key 对后续候选一律拒绝。时间戳/provenance 在签名后附加并引用 subjectDigest 与 payloadRootDigest/releaseSetId。ABI、协议、schema、许可证/SBOM、artifact root、签名信任或 release-set 一致性任一不匹配即阻止发布。

### AD-30 — [ADOPTED] 产品验证与发布适用性必须版本化且可重复判定

- **Binds:** SM-1, SM-6, SM-7, SM-8, UJ-5, FR-6, FR-7, FR-11, FR-12, FR-17, FR-18, FR-23, release readiness
- **Prevents:** 各团队临场选择任务、样本、阈值或适用门禁，使同一候选被人工解释为通过，或 UJ-5 被误解为扩大当前 MVP。
- **Rule:** ProductValidationPlanV1 是 SM-1、SM-6、SM-7、SM-8 与 UJ-5 价值门禁的唯一任务、fixture、计时、ground truth、样本、剔除、评分与阈值来源；ReadinessGatePolicyV1 是仓库版本化的 release-slice/phase 适用性基线，ReadinessGateManifestV1 是由该 policy、AD-28 gate registry 与 CandidateRefV1 确定性编译出的候选清单；ProductValidationEvidenceV1 与 ProductValidationResultV1 是唯一证据与判定格式。CandidateRefV1 是封闭判别联合：source={schemaVersion:1,kind:"source",productVersion,sourceCommit,lockfileDigest}，release-set={schemaVersion:1,kind:"release-set",releaseSetId}；sourceCommit 必须为完整 commit OID，lockfileDigest 必须为 AD-29 LockfileDigestV1，releaseSetId 继承 AD-29，candidateRefDigest 是 CandidateRefV1 的 RFC 8785 JCS UTF-8 小写十六进制 SHA-256，gatePhase=release 只接受 release-set。上述对象均使用 JSON Schema 2020-12、`additionalProperties:false` 与稳定 ID；planDigest、policyDigest、manifestDigest、evidenceDigest、resultDigest 均对省略自身 digest 字段的对象执行 RFC 8785 JCS UTF-8 SHA-256，fixtureDigest 对相对 POSIX path 排序的 `{path,size,sha256}` 清单计算，taskDigest 对完整任务定义计算。Manifest 的 planRef 固定 planId/planVersion/planDigest，evidenceRefs 只声明执行前已知的 `{evidenceId,schemaRef,taskDigest,fixtureDigest}` slot，不含 evidenceDigest；Evidence 必须引用 planRef、policyDigest、manifestDigest、candidateRefDigest、taskDigest、fixtureDigest 与自身 evidenceDigest；Result 必须引用相同 planRef/policyDigest/manifestDigest/candidateRefDigest、排序的 `{evidenceId,evidenceDigest}` 和自身 resultDigest。任一引用、版本、digest、candidateRef 或 schema 不匹配即 invalid，不能被人工解释为通过；任务、fixture、ground truth、阈值或剔除规则变化必须提升 planVersion。`packages/contracts` 独占 Schema 与 canonical encode/hash helper，`validation/product` 独占版本化 plan/task/fixture/ground truth，`validation/readiness` 独占 ReadinessGatePolicyV1；readiness compiler 只能读取 policy、gate registry 与 CandidateRefV1 并独占 immutable Manifest 生成，禁止读取运行证据；`packages/application/validation` 的 release gate evaluator 只消费 finalized Manifest 与 Evidence，独占评分与 ProductValidationResultV1 生成，禁止改变 applicability。ReadinessGateManifestV1 的 requirementRefs 必须逐项展开 FR/NFR/SM/AR/UX-DR ID，并固定 releaseSlice、gatePhase、gateId、blocking、policyDigest、planRef、command、gateDefinitionDigest、evidenceRefs、owner、manifestDigest 与 candidateRef；它只能选择 AD-28 注册表中的 gate，不能重定义 gate。Beta+ release 必须消费固定 manifest 并通过全部列出的 blocking gate。UJ-5 只控制 v1.1 候选启动，不扩大 MVP。
- **Policy inheritance and scope:** ReadinessGatePolicyV1 必须显式形成无环 inherits：alpha 无父、beta→alpha、beta-plus→beta、v1.1→beta-plus。compiler 只对调用方显式给出的唯一 releaseSlice/gatePhase 计算传递闭包；缺失、重复规则、继承环，或同 gateId 在闭包中解析到不同 gateDefinitionDigest 均为 invalid。普通 PR 不选择 releaseSlice/gatePhase，也不编译 ReadinessGateManifestV1；它只使用 AD-28 gate registry 的 trigger applicability。Readiness manifest 仅用于明确的 entry、exit 或 release 候选判定。
- **Phase closure:** gatePhase 严格排序为 entry < exit < release。目标 slice 只纳入自身 phase 小于等于目标 gatePhase 的规则；每个 inherits 祖先 slice 纳入其全部已声明 phase。最终 gate 集按 gateId 排序去重，同 gateId 的 gateDefinitionDigest 不同即 invalid。因此 beta/exit 固定包含 alpha 的全部已声明 phase 与 beta 的 entry+exit，v1.1/entry 固定包含所有祖先 slice 的完整门禁再加 v1.1 entry。

## Consistency Conventions

| Concern | Convention |
| --- | --- |
| Packages | 可部署入口放 apps/*；核心与共享契约放 packages/*；基础设施实现放 packages/adapters/*。禁止通用 utils 包。 |
| Ports and adapters | 核心接口以 *Port 命名，具体实现以技术名 + Adapter 命名；组合只发生在 apps/graph-service。 |
| IDs and paths | ID 使用 cg://；外部输出路径一律为工作区相对 POSIX 路径；绝对路径不得进入线协议、遥测或导出。 |
| Source ranges | 公共范围使用 0-based UTF-16 code-unit 行列与 [start,end) 半开区间；插件、CLI、诊断、Evidence 和导出不得各自换算。 |
| Time and revisions | 时间使用 UTC ISO 8601；graphRevision 与 findingsRevision 分别单调递增；所有查询、Finding、CLI、导出和 Job 结果同时携带两者。 |
| RPC | 方法使用 area/action，通知使用过去式或状态变化，如 graph/didCommit、service/statusChanged；线协议必须运行时校验。 |
| Errors | 用户可见错误使用稳定 code、category、retryable、relativePath/range、logId、suggestedAction；堆栈只进本地日志。 |
| Mutations | 只有服务变更共享状态；GraphPatch 事务可推进 graphRevision/findingsRevision，规则重评估事务可只推进 findingsRevision；UI、CLI、分析器不得旁路写入。 |
| Configuration | 规则策略与运行偏好分层；每个生效值必须可由 doctor 报告来源。 |
| Logging | 不记录源码；默认相对路径；使用 requestId/jobId/revision 关联；日志大小和数量双重轮转。 |
| State | lifecycle、availability、freshness、completeness 按 graph+Findings 逐轴合成；cancelled 来自 terminal lastIndexJob，idle 由无 currentIndexJob 派生；service/status 的 ServiceStatusV1 与 serviceStatusRevision 是总排序权威，组件 revisions 用于审计，GraphViewPatchV1 只能原子 delta 或 invalidate。 |
| Versioning | protocol、graph schema、rules schema、CLI schema 分别版本化；禁止复用单一 version。 |
| Shared config | 服务持有 EffectiveServiceConfig、configRevision 与 viewConfigRevision；reconfigure 按服务接收顺序 latest-wins，telemetry 分 requested/effective 状态，视图身份只绑定 viewConfigRevision。 |
| Metrics | ProjectionMembershipV1、FindingAttributionKernelV1、CycleProjectionKernelV1/CycleDeltaV1、OverviewMetricV1、ImpactVerdictV1 与 ImpactRankV1 由服务端 application 层唯一计算；客户端只呈现。 |
| Delivery gates | Story 1.1 建真实最小 CI，Story 1.3 建完整 manifest、双向追踪与 provider 强制；其后每个能力首次落地时同步接入真实 gate。 |
| Product validation | ProductValidationPlanV1、ReadinessGateManifestV1、ProductValidationEvidenceV1 与 ProductValidationResultV1 是价值验证和发布适用性的唯一合同。 |
| Release evidence | 每个候选携带 ReleaseArtifactManifestV1，并绑定 ReadinessGateManifestV1 的 candidateRef；签名前的规范 payload root digest 必须可复现。 |

## Stack

以下版本已于 2026-07-13 通过官方发布源或 npm Registry 核对。TypeScript 6.0.3 是为稳定 Compiler API 明确锁定的兼容版本，不跟随 latest 7.x。

| Name | Version |
| --- | --- |
| Node.js LTS | 24.18.0 (Krypton) |
| TypeScript | 6.0.3 |
| pnpm | 11.12.0 |
| VS Code API types | 1.125.0 |
| generator-code | 1.12.0 |
| esbuild | 0.28.1 |
| vscode-jsonrpc | 9.0.1 |
| better-sqlite3 | 12.11.1 |
| yaml | 2.9.0 |
| Ajv | 8.20.0 |
| Cytoscape.js | 3.34.0 |
| Vitest | 4.1.10 |
| @vscode/test-cli | 0.0.15 |
| @vscode/test-electron | 3.0.0 |
| @vscode/vsce | 3.9.2 |

## Structural Seed

~~~text
apps/
  graph-service/            # 组合根、IPC host、Job 生命周期
  cli/                      # codegraph 公共命令
  extension/                # VS Code 薄客户端与宿主表面
  webview/                  # 图/列表渲染与可访问性交互
packages/
  domain/                   # ID、Node、Edge、Evidence、GraphPatch、Revision
  application/
    indexing/               # FactBatch → GraphPatch 管道
    cycles/                 # CycleProjectionKernelV1 与基础循环投影
    querying/               # 预算、聚合、GraphViewModel
    rules/                  # 规则编译、评估与 Findings
    impact/                 # git diff 结构影响
    exporting/              # JSON/Markdown/AI 结构上下文
    validation/             # ProductValidation 评分、证据校验与结果判定
  contracts/                # JSON-RPC、CLI envelope、配置与 UI DTO
  service-client/           # 服务发现、启动、重连、握手
  adapters/
    store-sqlite/           # GraphStorePort
    analyzer-typescript/    # AnalyzerPort
    git-local/              # ChangeSourcePort
~~~

~~~text
validation/
  product/                  # 版本化 plan、task、fixture、ground truth
  readiness/                # ReadinessGatePolicyV1；compiler 与 evaluator 分权
ci/
  quality-gates.v1.yaml     # gate 定义注册表；候选适用性由 ReadinessGateManifestV1 选择
~~~

~~~mermaid
flowchart LR
    subgraph HOST["用户机器"]
        EXT["平台特定 VSIX"]
        CLI["npm CLI"]
        WEB["Webview"]
        CLIENT["service-client"]
        SERVICE["每工作区 graph-service"]
        CACHE["OS 用户缓存<br/>graph.sqlite / logs / service metadata"]
        REPO["工作区<br/>rules.yaml / codegraphignore / source"]
        EXT --> CLIENT
        CLI --> CLIENT
        EXT <--> WEB
        CLIENT -->|"Named Pipe / UDS + JSON-RPC"| SERVICE
        SERVICE --> CACHE
        SERVICE --> REPO
    end
~~~

~~~mermaid
erDiagram
    WORKSPACE ||--o{ GRAPH_REVISION : commits
    WORKSPACE ||--o{ FINDINGS_REVISION : evaluates
    WORKSPACE ||--o{ NODE : contains
    NODE ||--o{ EDGE : originates
    NODE ||--o{ EDGE : terminates
    EDGE ||--o{ EVIDENCE : supported_by
    GRAPH_REVISION ||--o{ FINDINGS_REVISION : binds
    FINDINGS_REVISION ||--o{ FINDING : contains
    RULE ||--o{ FINDING : produces
    JOB }o--|| GRAPH_REVISION : starts_from
    JOB }o--|| FINDINGS_REVISION : starts_from
~~~

| Release slice | Required capabilities | Does not block |
| --- | --- | --- |
| Alpha | CLI rebuild/query/status/doctor、SQLite 图谱、TS/JS 分析、循环查询 | VS Code 图形体验、PR 摘要 |
| Beta | VS Code Overview/Current Context、保存后增量更新、stale/failed、图与列表 | PR 摘要 |
| Beta+（完整 MVP） | rules v1、Findings、check/impact、PR Markdown、结构导出 | MCP、云协作 |

各 release slice 累积：Beta 包含 Alpha，Beta+ 包含 Alpha 与 Beta。Beta 是首个可用版本；Beta+ 是完整 MVP 的完成门禁，必须消费 ReadinessGateManifestV1 并通过其中逐项列出的全部适用 FR、NFR、SM、AR、UX-DR 与发布完整性/信任链门禁。PR 摘要和本地结构导出属于 MVP；UJ-5 的价值门禁只控制 v1.1 候选启动，不扩大 MVP，也不阻塞 Beta 交付。

## Capability → Architecture Map

AD 条目的 `Binds` 是逐 ID 直接追踪的唯一规范来源；本表是人工维护的人类导航摘要，`Governed by` 可以列出直接绑定或提供共享机制的 supporting AD，不参与机器双向追踪，也不得覆盖或补写 Binds。Story 1.3 的追踪 gate 只校验展开后的 AD Binds、需求 ID 与 Story 引用。

| Capability / Area | Lives in | Governed by |
| --- | --- | --- |
| FR-1..FR-5 本地图谱索引与存储 | application/indexing, analyzer-typescript, store-sqlite, graph-service | AD-2..AD-6, AD-8, AD-14, AD-21..AD-24, AD-27 |
| FR-6..FR-10 IDE 结构视图 | application/cycles, application/querying, contracts, extension, webview | AD-7, AD-10, AD-15, AD-25, AD-27, AD-30 |
| FR-11..FR-15 规则与 Findings | application/cycles, application/rules, contracts schema, store-sqlite | AD-3, AD-4, AD-9, AD-17, AD-21, AD-24, AD-25, AD-30 |
| FR-16..FR-19 变更影响与隐私 | application/impact, git-local, exporting | AD-13, AD-16..AD-18, AD-26, AD-30 |
| FR-20..FR-23 CLI、服务与导出 | cli, service-client, graph-service, exporting | AD-2, AD-7, AD-8, AD-12..AD-14, AD-20, AD-22, AD-23, AD-30 |
| SM-1 用户影响判断 | product-validation task packs, query evidence, UX task runner | AD-19, AD-25, AD-30 |
| SM-2..SM-5 性能与分析正确性 | benchmark fixtures, Job instrumentation, query/index pipelines | AD-3, AD-5, AD-7, AD-8, AD-16, AD-19, AD-21, AD-25, AD-26 |
| SM-6 规则正确性 | rules validation fixtures, Finding evidence | AD-9, AD-17, AD-25, AD-30 |
| SM-7 / SM-8 真实团队验证 | product-validation plans, evidence schemas, result gate | AD-18, AD-26, AD-30 |
| UJ-5 v1.1 价值门禁 | structure export task pack, ProductValidationResultV1 | AD-18, AD-30 |
| 渐进式交付与 CI | repository CI, contract fixtures, planning trace checks | AD-28 |
| 发布与可复现产物 | release CI, packaging, artifact audit | AD-12, AD-20, AD-23, AD-29 |
| Release slice 适用性 | ReadinessGateManifestV1, release gate runner | AD-29, AD-30 |

## Deferred

- TypeScript 7 unstable API、Tree-sitter、LSP、SCIP 与第二语言：TypeScript 7 提供稳定公共 API，或新增非 TS/JS 语言、TypeScript 6 分析达不到 2 秒目标、需要无 TS project 降级时重新评估。
- Rust/WASM 热点迁移：只有基准证明单一适配器持续成为瓶颈时实施，端口与 JSON-RPC 契约保持不变。
- Node node:sqlite 与 SEA：达到官方 Stability 2，或原生构建矩阵成为主要交付成本时重新评估。
- Windows arm64、Linux arm64：CI 原生依赖构建和真实设备验收具备后加入。
- 具体代码托管 provider 与 plan：Story 1.3 前选择；必须证明仓库外 ruleset 可强制 always-run `architecture-required`、禁用管理员 bypass，并允许独立 drift monitor 读取策略。若当前 provider/plan 不满足，升级 plan、迁移 provider 或建立等价外部控制面，禁止退化为仓库内自检。
- 第二渲染器与 renderer-* 包：出现第二个实际渲染实现后再抽取。
- VS Code multi-root 合并图谱：MVP 每个 root 独立服务；出现明确跨根影响分析需求时再设计 federation。
- MCP server、云端团队共享、跨仓库 federation、历史趋势、CPG/数据流：均不进入 MVP，按 PRD 触发条件另立 feature/initiative spine。
