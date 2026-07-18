---
name: 项目代码图谱 MVP 开发实施说明
type: implementation-guide
audience: 开发团队
status: final
created: 2026-07-13
updated: 2026-07-16
architecture: ARCHITECTURE-SPINE.md
---

# 项目代码图谱 MVP 开发实施说明

## 1. 使用方式

本说明用于把架构脊柱转换为开发顺序、模块责任和验证动作。所有实现必须先满足 [ARCHITECTURE-SPINE.md](ARCHITECTURE-SPINE.md) 的 AD；本文中的目录、接口草图和阶段顺序是冷启动种子，代码落地后由仓库自身维护细节。

实施原则：

1. 先建立契约和可运行的端到端细切片，再扩展图谱宽度。
2. 先保证 revision、一致性、恢复和相对路径正确，再优化图形效果。
3. 插件、CLI 与 Webview 不复制分析、查询或规则逻辑。
4. 任何性能优化都必须基于标准基准记录，不凭感觉引入 Rust、Tree-sitter 或第二存储。

## 2. 模块职责

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| domain | 稳定 ID、Node/Edge/Evidence、GraphPatch、Revision、Finding 基础模型 | SQL、JSON-RPC、VS Code、Git、YAML |
| application/indexing | Job 输入切片、FactBatch 规范化、diff、GraphPatch 编排 | TypeScript AST 细节、SQLite 语句 |
| application/cycles | CycleProjectionKernelV1、基础循环投影与确定性 SCC | rules.yaml 解析、Finding 生命周期 |
| application/querying | ProjectionMembershipV1、FindingAttributionKernelV1、邻域、聚合、OverviewMetricV1、相关性、预算、GraphViewModel | Cytoscape 布局、数据库行 |
| application/rules | 编译后的规则模型、受影响范围评估、Finding 生命周期 | YAML CST、Problems API |
| application/impact | ChangeSet、ImpactVerdictV1、ImpactRankV1 到结构变化摘要 | 运行 git 命令、Markdown 渲染细节 |
| application/exporting | 结构上下文与 PR 摘要的领域输出 | 文件系统写入、剪贴板 |
| application/validation | ProductValidation plan/evidence 校验、评分与 ProductValidationResultV1 判定 | 选择试用者、修改 fixture/ground truth、发布平台策略 |
| contracts | RPC、CLI envelope、GraphViewModel、诊断 Schema | 领域行为和基础设施实现 |
| service-client | 服务发现、启动、握手、重连、Job 恢复 | 查询语义和图谱缓存 |
| store-sqlite | 迁移、事务、GraphStorePort、查询投影 | 业务预算和 UI DTO |
| analyzer-typescript | TS/JS 工作区发现、增量 Program、FactBatch | 图谱写入和规则评估 |
| git-local | 本地 diff 与 ChangeSet | 结构影响计算 |
| graph-service | 组合根、IPC、Job 调度、状态通知 | 宿主 UI |
| extension | Workspace Trust、VS Code 命令/视图/诊断、会话状态 | 索引、SQL、规则计算 |
| webview | 图/列表、布局、主题、键盘和可访问性 | 服务连接、文件读取 |
| cli | 参数、stdout/stderr、退出码、格式选择 | 分析和存储实现 |

## 3. 实施顺序

### 阶段 A：架构地基

- 初始化 pnpm workspace；只用官方 VS Code TypeScript + esbuild 模板生成 apps/extension，再接入仓库边界。
- 建立 domain、application、contracts、service-client 与 adapter 包。
- 配置依赖边界 lint，禁止核心导入适配器或 VS Code。
- 完成协议、错误、诊断和 CLI JSON envelope Schema。
- Story 1.1 建立真实最小 CI：以稳定 check 名 `architecture-required` 运行 type、lint、unit、build、contract、dependency-boundary 与 basic-security；Story 1.2 只能通过该 CI 顺序合并。
- Story 1.3 建立 `ci/quality-gates.v1.yaml`、规划引用与 FR/NFR/AR/UX-DR/Story 双向追踪、provider required check、禁用管理员 bypass 与外部 drift monitor，并将最小 CI 升级为完整地基门禁。
- Story 1.3 同时记录实际代码托管 provider、plan、规则配置权限、禁用管理员 bypass 和外部 drift monitor 读取权限的证据；provider 无法在仓库外强制 always-run required check 时阻塞，不得降级为仓库内自检。

完成标准：空服务可完成握手；extension 与 CLI 能连接同一工作区实例；不产生伪造图谱；Story 1.1 最小 CI 已持续阻断失败；Story 1.3 完整基线和 provider 强制已通过。阶段 A 完成前不得并行开放 Story 1.4 或其他功能 Story。

### 阶段 B：Alpha CLI 图谱

- Story 1.4 在首次 rebuild 前实现 BuiltinIgnoreV1、缺失 `.codegraphignore` 时的 generation=0 合法空用户规则快照和 Analyzer 可消费的 EffectiveIgnoreSnapshotV1；该前置切片只验收“文件缺失”基线，不得宣称完整 FR-4。现有文件的语法、generation=1+、last-valid 与诊断由 Story 1.10–1.13 补齐，并在其完成后成为所有 rebuild 的强制启动屏障。
- 实现稳定 ID、当前切片所需 SQLite schema 与迁移机制、Job 调度。
- 实现 TypeScript Analyzer 与全量 rebuild。
- Story 1.6 实现 BasicSymbolV1 的顶层可寻址符号边界。
- Story 1.19 实现 GraphPatch 原子提交、完整 CAS、过期重排和半提交不可见。
- 实现 query/status/doctor 与 JSON 输出。
- Story 1.14 实现独立于 rules.yaml 的 BaseCycleProjectionV1 与循环依赖基础查询，不可晚于 Story 2.2。

完成标准：标准 fixture 可 rebuild；重建结果确定；CLI 能查询一跳邻域；损坏缓存可恢复。

### 阶段 C：Beta VS Code 体验

- 实现 Workspace Trust 与平台服务启动。
- 识别 npm、Yarn、pnpm workspace 边界和跨 package import；识别失败时输出 degraded 状态并继续普通单根索引。
- 实现 TreeView、Status Bar、Current Context、Overview。
- 实现 OverviewMetricV1；CLI 与 VS Code 复用同一依赖强度、热点、循环和排序结果。
- 实现带固定 nodeKind、WorkspaceDiscoverySummary 和独立聚合元数据的 GraphViewModel、Cytoscape 图与等价列表。
- 实现保存后增量更新、stale/failed/partial 状态和视图固定。

完成标准：缓存邻域 300ms 内显示；保存后局部更新 2s 内完成；workspace 识别降级不阻断文件/目录图谱并提供恢复诊断；VS Code extension host 不被索引或布局阻塞。

### 阶段 D：Beta+ 规则与 PR 影响（完整 MVP）

- 实现 rules-v1.schema.json、诊断和三种规则。
- 实现 Problems/Findings。
- 实现 git ChangeSet、impact、Markdown PR 摘要。
- Story 4.4 由 application/impact 生成 ImpactVerdictV1 与 ImpactRankV1；VS Code、CLI 和 Markdown 只呈现，且不可晚于 Story 4.5、4.6、4.8。
- 实现结构上下文 export；服务只有在完整生成后才返回 `artifactStatus=complete` 的不可变 ExportArtifactV1，生成失败不得暴露或复制部分内容。

完成标准：error Finding 使 check 返回 1；impact 区分新增与既有风险；导出默认无源码和绝对路径。

阶段能力累积：Beta 必须同时满足 Alpha，Beta+ 必须同时满足 Alpha 与 Beta；完整 MVP 还必须通过架构 frontmatter 绑定的全部适用 FR、SM、NFR 门禁，不能只完成阶段 D 的增量条目。

### 阶段 E：发布与真实团队验证

- 构建 Windows x64、macOS arm64/x64、Linux x64 VSIX。
- VSIX 携带精简 Node 24 LTS 运行时、服务 bundle 和对应 Node ABI 的 SQLite 模块，不依赖 VS Code/Electron ABI。
- esbuild externalize better-sqlite3；平台打包步骤复制原生模块、Node runtime 与许可证。
- 运行原生模块、IPC 权限、安装/升级/降级测试。
- 生成 ReleaseArtifactManifestV1、ReleaseSetManifestV1 与 ReleaseSignatureV1，并以两个隔离 clean checkout 的未签名 payload root digest 一致、同 release set 公共字段一致作为发布门禁。
- VS Code 集成测试覆盖 engines.vscode 最低版本 1.125.0、最新稳定版和前一稳定版。
- 使用 ProductValidationPlanV1 在 5–15 人团队真实 TS/JS 仓库执行 SM-1、SM-6、SM-7、SM-8；ProductValidationEvidenceV1 与 ProductValidationResultV1 必须绑定 planVersion、完整 digest 引用链与 candidateRefDigest。gatePhase=release 只能使用绑定 AD-29 releaseSetId 的 release-set CandidateRefV1。
- 使用 ReadinessGateManifestV1 逐项固定 Alpha/Beta/Beta+/v1.1 的适用门禁；Beta+ 候选必须通过全部列出的 blocking gate，UJ-5 只控制 v1.1 候选启动。
- 记录性能基线与失败分类，决定是否触发 Deferred 项。

规划修订必须保持以下能力归属与前置关系；Story 重编号可以变化，但责任不得漂移：

| 能力合同 | 首次负责切片 | 不可晚于 |
| --- | --- | --- |
| BuiltinIgnoreV1 + generation=0 空用户规则快照 | 首次 rebuild Story 的前置 AC（Story 1.4）；完整用户 `.codegraphignore` 语法由 Story 1.10–1.13 承担 | 首个 Analyzer/rebuild Job |
| BasicSymbolV1 | BasicSymbolV1 专属事实切片（Story 1.6） | symbol 导航或结构导出 |
| BaseCycleProjectionV1 | Alpha CLI 查询与基础循环切片（Story 1.14） | Project Overview（Story 2.2） |
| OverviewMetricV1 | Project Overview 查询合同（当前 Story 2.2） | Overview UI 验收 |
| ImpactVerdictV1 / ImpactRankV1 | 结构影响 verdict 与排序切片（Story 4.4） | Story 4.5、4.6、4.8 及其 Changes、PR Markdown、CLI impact |
| 渐进式 CI | Story 1.1 建最小真实 CI；Story 1.3 建完整 manifest、双向追踪与 provider 强制；各能力首次 Story 扩展 | 对应 Story 合并 |
| ProductValidationPlanV1 / ReadinessGateManifestV1 | Epic 5 产品验证合同 Story | 最终发布审计与 v1.1 候选判定 |
| ReleaseArtifactManifestV1 | 发布候选与产物审计（Epic 5） | CLI/VSIX 候选发布 |

## 4. 核心端口草图

接口名称可以在实现中微调，但依赖方向和责任不可改变。

~~~ts
export interface AnalyzerPort {
  analyze(input: AnalysisInput, signal: AbortSignal): Promise<FactBatch>;
}

export interface GraphStorePort {
  getRevision(): Promise<number>;
  loadOwnedFacts(slice: FactOwnershipSlice): Promise<OwnedFacts>;
  commit(update: AtomicGraphUpdate): Promise<CommittedRevision>;
  query(snapshot: RevisionRef, query: GraphQuery): Promise<GraphSlice>;
}

export interface ChangeSourcePort {
  getChangeSet(request: ChangeSetRequest): Promise<ChangeSet>;
}

export interface TelemetryPort {
  record(event: AllowedTelemetryEvent): void;
}
~~~

GraphStorePort 的实现必须保证：

- commit 是推进 revision 的唯一入口。
- 同一事务内完成 GraphPatch、受影响 Findings 和 revision 提交。
- 查询只能选择已提交 revision。
- 调用者不能传入 SQL、表名或数据库主键。

FactBatch 必须携带 ownershipSliceId、inputDigest、analyzerVersion 和 coverage：

- complete：当前 slice 的完整快照；缺失旧事实可删除。
- partial：只允许 upsert 和显式 tombstone；禁止按缺失删除。
- failed：不生成 GraphPatch。

v1 ownershipSliceId：

- source:<analyzerKind>:<fileId>：拥有该文件声明的 symbol 和 sourceFileId 相同的 Evidence。
- manifest:<manifestKind>:<relativePath>：拥有 package/workspace 元数据。
- hierarchy:<indexingRootId>：拥有文件/目录节点和 contains 关系。

analyzerVersion 不进入 slice 身份；新分析器版本的 complete 快照替代旧事实。每个 contentHash 是原始文件字节的 SHA-256 小写十六进制；inputDigest 是 RFC 8785 JCS 规范化对象的 UTF-8 字节 SHA-256：

~~~json
{
  "version": 1,
  "analyzerKind": "typescript",
  "configDigest": "sha256-hex",
  "inputs": [
    { "path": "src/a.ts", "contentHash": "sha256-hex" }
  ]
}
~~~

configDigest 只能由 graph-service 从 AnalyzerConfigSnapshot v1 计算：

~~~json
{
  "version": 1,
  "analyzerKind": "typescript",
  "analyzerVersion": "6.0.3",
  "effectiveCompilerOptions": {},
  "consultedFiles": [
    { "path": "tsconfig.json", "contentHash": "sha256-hex" }
  ],
  "effectiveIgnore": {
    "version": 1,
    "effectiveDigest": "sha256-hex"
  },
  "workspacePackages": [
    { "root": "packages/core", "name": "@app/core" }
  ]
}
~~~

consultedFiles 包含 tsconfig/jsconfig extends 链、package/workspace manifest、lockfile 和模块解析实际读取的非源码 package.json。inputs、consultedFiles、workspacePackages 按规范 path/root 排序；compiler option 中语义有序的数组保留顺序；rules.yaml 不进入分析配置。effectiveIgnore 只引用服务生成的 EffectiveIgnoreSnapshotV1 的 version/effectiveDigest，Analyzer 不得解析 `.codegraphignore`。generation 只在当前 statusEpoch 内作为并发栅栏，不进入 configDigest、无需跨实例持久化。configDigest 与 inputDigest 均使用 RFC 8785 JCS + UTF-8 + SHA-256。提交前与当前 manifest、完整 EffectiveIgnoreSnapshotV1 做 CAS，不一致时丢弃 batch 并重新排队。

`.codegraphignore` v1 合同：

- graph-service 是原始文件的唯一解释者，输出 `EffectiveIgnoreSnapshotV1={version:1,generation,validity,contentHash|null,builtinRulesVersion:"builtin-ignore-v1",userRules,effectiveRules,effectiveDigest,lastValidDigest}`。确认文件不存在时使用 generation=0、validity=valid、contentHash=null、userRules=[]；该“空”只指用户规则，effectiveRules 必须已包含 BuiltinIgnoreV1。已有文件在当前 statusEpoch 从 generation=1 开始，任意原始内容变化推进 generation，generation 不跨实例持久化。
- BuiltinIgnoreV1 的有序规则为 `/.git/`、`**/node_modules/`、`**/.pnpm/`、`**/dist/`、`**/build/`、`**/out/`、`**/coverage/`、`**/.next/`、`**/.nuxt/`、`**/.svelte-kit/`、`**/.turbo/`、`**/.cache/`、`**/generated/`、`**/.generated/`、`**/__generated__/`。内置规则先应用，用户规则后应用，因此用户可用显式 `!` 重新纳入。
- 严格 UTF-8 按行解析。每次 valid snapshot 原子写入用户缓存中的 `LastValidIgnoreRecordV1={workspaceKey,grammarVersion:1,builtinRulesVersion,userRules,effectiveRules,effectiveDigest,acceptedContentHash,checksum}`。解码失败时整份 generation invalid、不做部分解析，记录原始 contentHash 并发布稳定 `IGNORE_INVALID_UTF8` ConfigDiagnostic；跨重启只恢复 workspace、grammar、builtin version 与 checksum 均匹配的历史记录，否则使用空用户规则与 BuiltinIgnoreV1。“首次 invalid”只表示不存在可恢复历史记录。invalid 状态保持 workspace stale，直到后续 valid generation 完成 reconciliation。
- 空行和未转义 `#` 起始行为注释，未转义前导 `!` 为反选，最后一次匹配生效。effectiveDigest 对 `{version:1,builtinRulesVersion:"builtin-ignore-v1",effectiveRules}` 执行 RFC 8785 JCS → UTF-8 → SHA-256，并在有效时同步为 lastValidDigest。
- 前导 `/` 锚定 indexing root；尾随 `/` 只匹配目录及后代；反斜杠只转义下一字符。规范路径使用 `/` 且区分大小写；`*`、`?` 不跨路径段，`**` 跨零个或多个路径段；字符类不支持并按字面量处理。
- 命中 effectiveRules 的路径不参与节点、边、Evidence、workspace package 聚合、规则检查或成功指标；被后续反选重新纳入时继续使用原有确定性 ID。rules.yaml 的 ignore 只裁剪规则评估，不改变索引范围或规模统计。
- 所有原始内容变化与 LastValidIgnoreRecordV1 恢复结果都进入 bootstrapGeneration/read-set 与完整 snapshot mutation CAS；AnalyzerConfigSnapshot/configDigest 只绑定 version/effectiveDigest，只有 effectiveDigest 变化造成语义缓存失效。服务启动以 effectiveDigest 对比已提交 snapshot 判断语义缓存是否变化；任何适配器不得按宿主 OS 或 Git 配置改变匹配语义。首次 rebuild/Analyzer Job 在有效 snapshot 建立前不得 dequeue。

## 5. 线协议与版本

服务连接的第一条请求必须是握手：

~~~ts
interface InitializeRequest {
  clientVersion: string;
  protocolVersion: number;
  supportedSchemaVersions: number[];
  workspaceKey: string;
  sessionToken: string;
}

interface InitializeResult {
  serviceVersion: string;
  protocolVersion: number;
  graphSchemaVersion: number;
  rulesSchemaVersion: number;
  cliSchemaVersion: number;
  serviceStatus: ServiceStatusV1;
  capabilities: string[];
}
~~~

Job 的公共 revision 字段：

~~~ts
interface JobRevisions {
  baseGraphRevision: number;
  baseFindingsRevision: number;
  resultGraphRevision: number | null;
  resultFindingsRevision: number | null;
}
~~~

- queued/running 的 result pair 必须为 null。
- terminal mutation Job 的 result pair 是结束时最新已提交 snapshot；没有提交时等于 base。
- terminal 只读 Job 的 result pair 是实际读取或比较的目标 snapshot；成功或失败只由 Job state 表达。

Job 与工作区状态必须分开：

- `cancelled` 只属于 Job；`idle` 是 `lifecycle=running` 且没有活动 Job 的展示状态。
- 取消后保留最新已提交 revision 与缓存；不得为了显示“已取消”清空 GraphViewModel。
- rebuild 未完成完整 reconciliation 时，返回 `completeness=partial`、`freshness=stale` 和已完成范围；后续成功 rebuild 才恢复 complete/current。

`service/status`、`job/get` 与 GraphViewModel 复用同一个索引状态读模型：

~~~ts
type IndexJobPhase =
  | "discovering"
  | "analyzing"
  | "normalizing"
  | "committing"
  | "evaluating-findings";

type CancellationReason =
  | "user"
  | "superseded-by-rebuild"
  | "shutdown"
  | "trust-revoked";

interface ErrorV1 {
  code: string;
  category: string;
  retryable: boolean;
  message: string;
  relativePath?: string;
  range?: SourceRangeV1;
  logId?: string;
  suggestedAction?: string;
}

type ProgressV1 =
  | { mode: "determinate"; unit: "files" | "packages" | "steps"; completed: number; total: number }
  | { mode: "indeterminate"; unit: "files" | "packages" | "steps"; completed: number };

interface IndexJobCommonV1 {
  jobId: string;
  kind: "initial-index" | "rebuild" | "incremental" | "rules-evaluation";
  phase?: IndexJobPhase;
  completedScope: ProgressV1;
  createdAt: string;
  startedAt?: string;
}

type CurrentIndexJobSummaryV1 = IndexJobCommonV1 & {
  state: "queued" | "running";
};

type TerminalIndexJobSummaryV1 =
  | (IndexJobCommonV1 & { state: "succeeded"; finishedAt: string })
  | (IndexJobCommonV1 & { state: "failed"; finishedAt: string; lastJobError: ErrorV1 })
  | (IndexJobCommonV1 & {
      state: "cancelled";
      finishedAt: string;
      cancelledAt: string;
      cancellationReason: CancellationReason;
    });

interface CommittedIndexSummaryV1 {
  graphRevision: number;
  findingsRevision: number;
  generatedAt: string;
  indexedFileCount: number;
  nodeCount: number;
  edgeCount: number;
  workspacePackageCount: number;
  excludedPathSummary: string[];
}

interface IndexStatusSummaryV1 {
  statusRevision: number;
  lifecycle: "stopped" | "starting" | "running" | "stopping" | "failed";
  availability: "absent" | "available";
  freshness: null | "current" | "stale";
  completeness: "empty" | "partial" | "complete";
  currentIndexJob?: CurrentIndexJobSummaryV1;
  lastIndexJob?: TerminalIndexJobSummaryV1;
  committed: CommittedIndexSummaryV1 | null;
}

interface TelemetryStatusV1 {
  requestedState: "off" | "on";
  effectiveState: "off" | "on";
  requestedConfigRevision: number;
  appliedConfigRevision: number;
  pending: boolean;
}

interface ServiceStatusV1 {
  serviceInstanceId: string;
  statusEpoch: string;
  serviceStatusRevision: number;
  indexStatus: IndexStatusSummaryV1;
  telemetryStatus: TelemetryStatusV1;
  configRevision: number;
  viewConfigRevision: number;
}
~~~

- `service/status` 与 `service/statusChanged` 的唯一权威合同是 ServiceStatusV1；serviceStatusRevision/statusRevision 只在同一 statusEpoch 内单调，任何 index、telemetry、config 或 viewConfig 可观察变化都推进 serviceStatusRevision。
- statusChanged 携带完整原子快照；客户端在同一 epoch 只接受更高 revision。serviceInstanceId/statusEpoch 改变时无条件替换本地状态并全量重取，不比较旧 epoch 计数。
- absent 只能与 committed=null、freshness=null、completeness=empty 组合；available 必须有 committed，且只能与 freshness=current|stale、completeness=partial|complete 组合。
- currentIndexJob/lastIndexJob 只包含图谱或 Findings 变更 Job；check/impact/export 仅通过 job/get 暴露。
- 每 indexing root 只有一条 snapshot mutation channel，任何时刻最多一个 currentIndexJob；所有推进 graphRevision 或 findingsRevision 的 Job 都必须进入该通道。
- 任何推进 findingsRevision 的事务（含 GraphPatch 事务）携带 baseGraphRevision、effectiveRulesDigest、rulesConfigGeneration 并在提交前 CAS；rules.yaml 变化立即推进 desired generation、标记整体 stale，并使旧 generation 结果失效。CAS 失败时丢弃并重排，Finding revision 记录实际 effectiveRulesDigest。
- manifest/input digest 与 committed snapshot 不同时立即 stale。只读 Job 取消不改变 committed；变更 Job 在首次提交前取消保留旧 completeness 但不恢复 current，首次提交后取消或 rebuild 未完成 reconciliation 时使用最新 revision 并标记 partial/stale。
- 任何可观察的 lifecycle、索引 Job、progress 或 committed summary 变化都推进 statusRevision。

兼容规则：

- protocolVersion、graphSchemaVersion、rulesSchemaVersion、cliSchemaVersion 独立演进，不共享一个 version 字段。
- 同一 protocol major 内只做向后兼容增加，minor 通过 capabilities 协商。
- 未识别字段由线协议 Schema 明确决定是否忽略；配置 Schema 仍严格拒绝未知字段。
- Job、查询、Finding、导出和错误均携带 graphRevision 或 baseRevision。
- 客户端仅原子应用身份与 graph/findings/status 三个时钟连续的 GraphViewPatchV1 delta；收到 invalidate、身份不匹配或差量不完整时请求完整快照。
- graph schema 只由服务事务化迁移；旧服务不得对更新 schema 降级写入，迁移失败时保留故障副本并重建缓存。
- initialize、service/status、service/shutdown 是跨应用协议 major 保持兼容的控制子集。

共享运行配置：

- graph-service 持有 EffectiveServiceConfig、configRevision、viewConfigRevision 和来源映射。
- 首个启动者提交完整候选配置；后续连接不得隐式覆盖。
- 共享设置通过 service/reconfigure 提交；服务按接收顺序 latest-wins，并保持 requested/applied configRevision 分离。
- 无 currentIndexJob 时立即应用 pending 配置；存在活动 Job 时，在其进入 terminal 后、下一 Job dequeue 前应用。等待期间后续请求仍可覆盖或取消 pending 变更。
- TelemetryStatusV1 记录 requestedState、effectiveState、requestedConfigRevision、appliedConfigRevision、pending。
- 任意 telemetry off 请求立即取消全部更早 pending-on，在同一临界区切 Noop、拒绝新事件、丢弃缓冲、递增并广播 configRevision，再返回 effectiveState=off 与 appliedConfigRevision。
- telemetry on 只能由用户显式 opt-in；到上述应用边界时仅当 requestedConfigRevision 仍是最新 telemetry 请求才实际启用，否则作废。Settings & Rules 只显示 ServiceStatusV1 中服务确认的 TelemetryStatusV1。
- 只有会改变查询形状或语义的配置才推进 viewConfigRevision；queryFingerprint 不绑定 telemetry、日志等隐私/运维配置。
- CLI 单命令参数只影响该请求；视图模式、缩放等会话偏好仍归客户端。

生命周期：

- 启动顺序为取得 OS 排他锁 → 生成非秘密 serviceInstanceId/statusEpoch → 写 service metadata → 开放 endpoint → 完成存储迁移 → 注册 source/config/manifest watchers → 在 `lifecycle=starting` 阶段执行 reconciliation scan；状态 counters 不跨实例持久化。
- 扫描期间已观察 watcher 事件按路径合并并重新读取，直到 watcher generation 与 ManifestSnapshot、AnalyzerConfigSnapshot、EffectiveIgnoreSnapshotV1、RulesSnapshotRef 在同一 bootstrapGeneration 上收敛并原子发布。配置快照屏障完成前不得进入 `running`、接受查询或 dequeue 首个 snapshot mutation Job。
- 只有确认 rules.yaml 不存在时才建立 `generation=0, validity=valid` 的空规则快照；已有有效文件直接建立有效 generation，已有无效文件建立 invalid generation、EMPTY_RULES_DIGEST 与配置诊断。首个 snapshot mutation Job 及其提交 CAS 必须绑定 bootstrapGeneration，并在提交前重新 hash 完整 bootstrap read-set；任何较新 watcher generation 或 hash 差异使其失效并重排。
- watcher 只提供可能丢失、重复或乱序的候选，不证明文件系统强一致；有客户端连接时每次 reconciliation 完成后至多 5 分钟启动下一次有界对账，显式 rebuild/check/impact/export 开始前先完成或复用一次对账。
- 只有 PID 已不存在且 token/endpoint 无效时才能回收 stale metadata。
- 无客户端且无活动 Job 5 分钟后优雅退出。
- 升级关闭等待当前事务结束，取消排队 Job，关闭数据库和 endpoint，删除 metadata，再释放锁；禁止自动强杀活动事务。

首批 RPC 面：

~~~text
initialize
service/status
service/reconfigure
service/shutdown
job/start
job/get
job/cancel
graph/query
rules/check
impact/compute
export/render
job/progress
graph/didCommit
findings/didChange
service/statusChanged
~~~

## 6. 图谱更新实现

保存后增量路径：

~~~mermaid
sequenceDiagram
    participant FS as File events
    participant JOB as Job scheduler
    participant TS as TypeScript analyzer
    participant IDX as Indexing application
    participant DB as SQLite adapter
    participant RPC as JSON-RPC notifications

    FS->>JOB: changed(relativePath)
    JOB->>JOB: settle + hash dedupe
    JOB->>TS: analyze(input slice)
    TS-->>IDX: FactBatch
    IDX->>DB: loadOwnedFacts(slice)
    DB-->>IDX: previous facts
    IDX->>IDX: normalize + diff + rules
    IDX->>DB: commit(AtomicGraphUpdate)
    DB-->>IDX: nextRevision
    IDX->>RPC: graph/didCommit(nextRevision)
~~~

实现约束：

- VS Code watcher、服务 watcher、显式 CLI/Git 操作只产生可能丢失、重复或乱序的变更候选；服务在分析时重新读取文件，内容 hash 是是否变化的权威判断。
- settle 流程为：按规范路径合并 → 等待 quiet window（静默窗口）或最大截止时间 → 读取文件/hash → 生成输入切片。watcher overflow、Git HEAD/配置变化和服务恢复触发 manifest reconciliation scan（清单对账扫描）；有客户端连接时，每轮对账完成后至多 5 分钟启动下一轮，显式 rebuild/check/impact/export 先对账。
- `freshness=current` 只表示已提交快照匹配最近一次完成的内容对账；之后发生且 watcher 静默丢失的变化允许短暂未观测，但下一轮有界对账必须发现并转为 stale。
- Fact ownership（事实归属）至少包含 workspace、input slice、analyzer kind 和 analyzer version。
- 文件删除和配置变化同样生成 FactBatch/GraphPatch，不开旁路。
- 动态 import 无法可靠解析时不得伪装为高置信精确边。
- Analyzer 诊断与图谱完整性分开表示；有语法错误的文件可以产生部分事实。
- 事务提交后再通知客户端；通知失败不回滚图谱。

Evidence 规则：

- confidence 只使用 high、medium、low。
- TypeScript 成功解析到具体目标的静态 import/export 为 high；部分项目上下文为 medium；启发式或动态推断为 low。
- 规则引擎 v1 只评估 high 依赖边。
- 同一证据位置出现冲突目标时生成分析诊断并排除该证据。
- Evidence 去重键为 edgeId、provenance、analyzerVersion、sourceFileId、normalizedRange、evidenceKind。
- Evidence 的 language 只允许 typescript、typescriptreact、javascript、javascriptreact；detectedAt 使用 UTC ISO 8601。

规范关系：

- contains：container → child，qualifier 为 childKind。
- imports：importer file → target file/internal package/external package，qualifier 为 value/type/dynamic。
- exports：exporting file → local symbol 或 target module entity，qualifier 使用下方唯一映射。
- references：source symbol → target symbol，qualifier 为 read/write/call/extends/implements。
- depends_on 是目录/package 聚合投影；violates 和 changed_by 不进入规范边。
- edge ID 为 workspace-key、relationType、fromId、toId、qualifier 的哈希。
- edge 在最后一条 active Evidence 消失时同事务删除，并重新计算聚合 depends_on。
- 外部 package 和 node built-in 节点按规范 edge 引用计数；最后一条入/出 edge 消失时删除。
- 内部节点只由 ownership slice 删除，相关 edge/Evidence 同事务清理。

TS/JS 语法映射：

- 目标解析优先级：Node built-in → indexing root 内 resolved file → root 外 resolved package 的最近 package.json purl → 未解析 bare package 的 @unresolved → 未解析 relative/absolute 只报诊断。
- 静态 import、literal require、import-equals → imports(value/type)。
- 字符串 literal 的 import() → imports(dynamic)；非 literal 不生成精确 edge。
- type/value 只按源码语法分类：statement-level import type/export type、specifier-level type modifier、ImportEqualsDeclaration.isTypeOnly 为 type；其余 static import/export、side-effect import、default/namespace import、literal require 为 value，不读取 emit 结果或 SymbolFlags。混合 declaration 按 specifier 独立拆边。
- ImportEqualsDeclaration 仅在 moduleReference 为 ExternalModuleReference 且 expression 为字符串 literal 时生成 imports(type/value)；EntityName 内部别名不生成模块 edge。
- 本地 named/default export 每个导出绑定生成一条 file→local symbol edge；qualifier 为 local:<exportedName>:type|value 或 default:type|value。
- 带 from 的 named re-export 每个 specifier 生成 imports(value/type)，并生成一条 file→target module entity 的 exports edge；qualifier 为 reexport:<exportedName>:<importedName>:type|value。
- export * from 每个 declaration 生成一条 imports edge 和一条 file→target module entity 的 exports edge；qualifier 为 star:type|value。
- references 在 MVP 不生成。

## 7. SQLite 起始模型

身份规范：

- Git 工作区的 workspace-key 为规范化远程仓库身份与仓库内子根路径的 SHA-256。
- 无稳定 Git 身份时使用规范化本地 workspace URI；移动目录后视为新工作区。
- 路径采用 Unicode NFC 和工作区相对 POSIX 形式；Git 管理文件使用索引大小写。
- symbol ID 由 file ID、语言、kind、qualified name 和签名摘要组成；匿名符号标记低稳定性。
- VS Code multi-root 的每个 root 使用独立服务和图谱，不在 MVP 合并。
- 内部 workspace package ID 使用 cg:// 和 package 根相对路径。
- 外部 npm 包使用标准 purl pkg:npm/<name>@<resolvedVersion>；npm/Yarn/pnpm 不改变身份，未解析版本使用 @unresolved 并降低置信度。
- Node built-in 使用 node:<module>。

建议的首批表：

~~~text
meta
workspace
nodes
edges
evidence
facts_ownership
findings
jobs
schema_migrations
~~~

该列表是完整 MVP 的最小表集合，不是 Story 1.4 的一次性建表清单。Story 1.4 首次 rebuild 只创建当前切片实际使用的 meta、workspace、nodes、edges、evidence、facts_ownership、jobs 与 schema_migrations；findings 在规则/Findings 首次落地时通过增量迁移加入，后续能力同理。禁止提前创建没有读写路径和合同测试的未来表。

数据库规则：

- 业务 ID 使用文本 cg:// URI；SQLite rowid 仅为内部优化。
- edges 对 from_id、relation_type、to_id 建唯一约束。
- evidence 对规范边、来源、证据位置建立唯一约束。
- revision 相关写入使用一个事务。
- 所有查询先有可测试 SQL 计划；常用反向依赖、路径、finding、revision 条件建立索引。
- schema 不兼容时由服务迁移；失败保留故障副本并返回可恢复错误。

## 8. TypeScript 分析器

第一版只使用 TypeScript 6.0.3 的稳定 Compiler API：

1. 发现 tsconfig/jsconfig 与 npm、Yarn、pnpm workspace 边界。
2. 使用公开 API 构建增量 Program 或 Language Service。
3. 统一 TypeScript 模块解析结果和工作区相对路径。
4. 输出文件、目录、package、基础 symbol 与 import/export Evidence。
5. 保存后只重算受影响输入切片。
6. 记录 analyzer version、配置摘要和完整性诊断。

工作区发现合同：

~~~ts
type WorkspaceKind = "npm" | "yarn" | "pnpm";

type WorkspaceDiscoverySummary =
  | { status: "single"; packageCount: 0 }
  | { status: "recognized"; kind: WorkspaceKind; packageCount: number }
  | {
      status: "degraded";
      detectedKind?: WorkspaceKind;
      packageCount: 0;
      diagnosticRef: "workspace-discovery-degraded";
    };
~~~

- `single`：未检测到受支持的 workspace 意图，按普通单根项目索引。
- `recognized`：边界枚举成功且 `packageCount >= 1`，可生成 workspace-package 节点与跨 package 聚合边。
- `degraded`：检测到 workspace 意图但清单无效、冲突或不可完整枚举；继续文件、目录和源码关系索引，不生成 workspace-package 节点或 package 聚合结论，并通过必填 diagnosticRef 返回检查配置/rebuild 动作。

BasicSymbolV1 合同：

~~~ts
type BasicSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "variable"
  | "namespace";

interface BasicSymbolV1 {
  symbolId: string;
  kind: BasicSymbolKind;
  name: string;
  relativePath: string;
  range: SourceRangeV1;
  exported: boolean;
}
~~~

- 只收录 SourceFile 顶层、具有稳定名称和可导航名称范围的声明；成员、参数、局部变量、import alias 与匿名声明不进入 V1。
- 只合并同一 SourceFile 内的多声明绑定，并由该文件的 source slice 唯一拥有与 tombstone；跨文件 interface/namespace declaration merging 在每个声明文件生成独立 BasicSymbolV1，保持 AD-4 的 file-scoped symbol ID。
- 导航范围在同文件内优先实现声明；无实现时按 range.start 升序取第一项。文件输入枚举顺序不得影响 ID、路径或范围。
- BasicSymbolV1 可用于 symbol-centered 查询、NavigationTargetV1 与结构导出，但默认 GraphViewNodeKind 仍只有 file、directory、workspace-package、external-package。
- MVP 不生成调用图或 references。

禁止事项：

- 不加载 TypeScript plugins 或自定义 transformer。
- 不调用项目 scripts。
- 不从 VS Code TypeScript Server 私有状态读取结果。
- 不让 Analyzer 访问 GraphStore。
- 不使用 TypeScript 7 unstable API 或其平台原生分析器。

## 9. 查询与 GraphViewModel

默认查询：

- 中心实体：当前文件或用户选择实体。
- 深度：1 跳。
- 预算：100 节点、200 边。
- 优先级：当前实体 → 直接依赖/反向依赖 → 同 package/目录 → 外部依赖 → 聚合节点。

基础循环与 Overview 指标合同：

- application/querying 唯一生成 `ProjectionMembershipV1={scopeRoot,groupBy,aggregationDepth,fileToLeafAggregate}`，每个文件只属于一个叶子聚合节点，不向祖先重复累计。groupBy=directory 时取 scopeRoot 下最多 aggregationDepth 段的最近目录祖先，scopeRoot 直接文件归 scopeRoot；groupBy=workspace-package 时取包含文件的最深 recognized package root，非 package 文件归 indexing-root 聚合，等深冲突按规范 root ID 升序。scopeRoot、groupBy、aggregationDepth 和 membership digest 进入 queryFingerprint。
- `CycleProjectionKernelV1`、dependencyStrength 与 FindingAttributionKernelV1 必须消费同一 membership。Kernel 只读取 high-confidence 内部 imports；file scope 保留自环，directory/workspace-package scope 折叠端点、去重后移除聚合自边。
- 大小大于 1 的 SCC 或 file 自环构成基础循环；`projectionId=hash(kernelVersion,scope,sortedNodeIds)`，cycleMemberCount 是节点所在循环 SCC 的成员数，否则为 0。
- `BaseCycleProjectionV1` 不读取 rules.yaml，必须由 Story 1.14 的 Alpha 查询切片完成且不可晚于 Story 2.2；规则 no-cycle 在应用 rules ignore 后复用相同 Kernel 与 canonicalization。
- `FindingAttributionKernelV1` 对 active Finding 按 findingId 去重：edge subject 对存在的每个内部端点叶子聚合各计一次，同一聚合只计一次；SCC subject 对每个相交叶子聚合各计一次。合法空 RulesV1 基线下 active error/warning 固定为 0。
- `OverviewMetricV1.dependencyStrength` 是两个聚合节点之间不同 high-confidence 文件级 imports 规范边数，多 Evidence 不重复计数；`internalDependencyStrength` 是与其他内部聚合节点之间入向和出向强度总和。
- 热点排序依次按 active error 数、active warning 数、cycleMemberCount、internalDependencyStrength 降序，再按规范 node ID 升序；在完整范围上先排序，再执行展示截断。
- 只有 freshness=current 且 completeness=complete 时返回正式 rank；stale 标记“可能过期”，partial 标记“基于部分结果”，均不显示正式排名徽标。
- `rankingVersion="overview-metric-v1"`，并进入 queryFingerprint；CLI、extension 与 Webview 不得自行重算。

工作区状态由四个正交字段组成：

~~~text
lifecycle: stopped | starting | running | stopping | failed
availability: absent | available
freshness: null | current | stale
completeness: empty | partial | complete
~~~

合法组合：

- availability=absent 时 freshness=null、completeness=empty。
- availability=available 时 freshness 为 current/stale，completeness 为 partial/complete。
- freshness 与 completeness 独立合成：graph 和 Findings 都 current 时 overall freshness=current，否则 stale；两者覆盖都 complete 时 overall completeness=complete，否则 partial。stale 不推出 partial。
- lifecycle=failed 只表示服务级致命错误；Job 失败记录 lastJobError，旧图可用时只把 freshness 设为 stale。
- `refreshing` 从 currentIndexJob 投影，`cancelled` 从 lastIndexJob 投影，`idle` 由无 currentIndexJob 投影；三者不得加入上述四维枚举。

图节点合同：

~~~ts
type GraphViewNodeKind =
  | "file"
  | "directory"
  | "workspace-package"
  | "external-package";

type GraphViewNodeIdentityV1 =
  | { nodeKind: "file" | "directory" | "workspace-package" }
  | {
      nodeKind: "external-package";
      externalKind: "npm-package" | "node-builtin";
      externalId: string;
      displayName: string;
    };

interface GraphViewAggregation {
  // 聚合是查询投影属性，不得伪装成新的领域实体类型。
  groupBy: "directory" | "workspace-package";
  scopeRoot: string;
  aggregationDepth: number;
  membershipDigest: string;
  hiddenNodeCount: number;
  expandToken: string;
}

interface SourceRangeV1 {
  // 位置采用 0-based UTF-16 code units；范围为 [start, end) 半开区间。
  start: { line: number; character: number };
  end: { line: number; character: number };
}

type NavigationTargetV1 =
  | { targetKind: "file"; relativePath: string }
  | { targetKind: "directory"; relativePath: string }
  | { targetKind: "symbol"; symbolId: string; relativePath: string; range: SourceRangeV1 };
~~~

- file、directory 节点分别携带对应分支；workspace-package 使用 `directory{relativePath:<package-root>}`；symbol-centered 查询中的对应 file 节点携带 symbol 目标。
- external-package（包括 node-builtin）在 V1 不携带本地 NavigationTarget，但必须保留其所有 incident edges。

返回模型必须包含：

- serviceInstanceId、statusEpoch、viewId、queryFingerprint、graphRevision、findingsRevision、statusRevision、scope 与四维状态。
- WorkspaceDiscoverySummary、IndexStatusSummaryV1，以及稳定 view node/edge ID、GraphViewNodeIdentityV1 和 NavigationTargetV1。
- relation direction、provenance、confidence。
- Finding 摘要和新增/既有状态。
- truncation reason 与独立 GraphViewAggregation；其 scopeRoot/groupBy/aggregationDepth/membershipDigest 必须对应服务生成的 ProjectionMembershipV1，Webview 不得从节点集合猜测 workspace 识别状态或成员归属。

Webview 不得自行扩大查询范围；展开聚合必须携带服务签发的 expand token 发起新查询。

queryFingerprint 是规范化查询 JSON 的 SHA-256，覆盖 indexingRoot、center/scope、relation/direction/filter、depth、node/edge budget、ProjectionMembershipV1 的 scopeRoot/groupBy/aggregationDepth/membershipDigest、rankingVersion、expand lineage 和 viewConfigRevision，不包含数据 revision、telemetry 或日志配置。

GraphViewPatchV1 是判别联合：

~~~ts
type GraphViewPatchV1 =
  | {
      kind: "delta";
      serviceInstanceId: string;
      statusEpoch: string;
      viewId: string;
      queryFingerprint: string;
      baseGraphRevision: number;
      nextGraphRevision: number;
      baseFindingsRevision: number;
      nextFindingsRevision: number;
      baseStatusRevision: number;
      nextStatusRevision: number;
      delta: MaterializedGraphViewDeltaV1;
    }
  | {
      kind: "invalidate";
      serviceInstanceId: string;
      statusEpoch: string;
      viewId: string;
      queryFingerprint: string;
      baseStatusRevision: number;
      reason: string;
    };
~~~

- delta 是两个已物化 GraphViewModel 的精确差量，覆盖节点、边、Finding、排序、聚合、截断、WorkspaceDiscoverySummary 和 IndexStatusSummaryV1。
- 客户端先校验 serviceInstanceId/statusEpoch、view/query 与 base/next graph、findings、status 三个时钟，再一次性应用并发布；任一时钟断档或无法生成完整 delta 时只能 invalidate 并请求完整模型。
- serviceInstanceId/statusEpoch 改变时必须旋转 viewId、丢弃旧 epoch 消息、清空 extension→Webview 的待处理 patch，并全量重取 GraphViewModel；不得比较旧 epoch 的 revision。
- 稳定 ID 仍存在时，完整刷新或原子 patch 必须保留中心节点、选择、展开状态、缩放和列表位置。

## 10. 规则与诊断

实现顺序：

1. 发布 rules-v1.schema.json。
2. 使用 yaml 解析并保留 CST/range。
3. 使用 Ajv 严格验证。
4. 把 JSON Pointer 映射回 YAML 范围。
5. 编译为不含 YAML/JSON Schema 概念的内部规则模型。
6. 对受 GraphPatch 影响的范围增量评估。
7. 生成带稳定 ruleId、相关边和 revision 的 Finding。

rules v1 语义：

- forbidden-dependency 使用 from/to 工作区相对 glob。
- layer-order 按声明顺序允许依赖自身及后续层，禁止反向依赖。
- no-cycle 的 scope 只允许 file、directory、package；在规则过滤后的有向图上复用 CycleProjectionKernelV1，大小大于 1 或含自环的 SCC 产生一个 Finding。
- severity 只允许 warning、error，rule id 全局唯一。
- glob 中 * 匹配一段，** 可跨目录。全局 ignore 的固定顺序为：先从已被 `.codegraphignore` 裁剪的 file graph 删除命中文件及全部 incident edges，再执行规则匹配和 directory/package 投影；禁止聚合后重新解释 glob。该 ignore 不删除规范图谱实体，也不改变普通查询、package 聚合或规模统计。

规则快照合同：

~~~ts
interface RulesSnapshotRef {
  generation: number;
  validity: "valid" | "invalid";
  effectiveRulesDigest: string;
  lastValidRulesDigest: string;
}
~~~

- rules.yaml 任意变化都推进 generation；无效 generation 保持 effectiveRulesDigest/lastValidRulesDigest 为最后有效值。
- 启动时只有确认 rules.yaml 不存在才使用 `generation=0, validity=valid` 的合法 RulesV1 空策略，两个 digest 均为 EMPTY_RULES_DIGEST；已有有效文件直接建立有效 generation，已有无效文件建立 invalid generation 并保留 EMPTY_RULES_DIGEST，同时发布配置诊断。
- 所有有效 rules digest 对 Schema 校验通过且默认值显式化的 RulesV1 对象执行 RFC 8785 JCS → UTF-8 → SHA-256 小写十六进制；EMPTY_RULES_DIGEST 用同一算法计算合法空策略对象。
- 所有推进 findingsRevision 的事务 CAS baseGraphRevision 与完整 RulesSnapshotRef。无效 generation 不阻塞 GraphPatch：可提交 graphRevision，同时推进 findingsRevision、保留旧 Findings 为 stale 并禁止 resolved。
- 有效 generation 才执行新规则评估；CAS 失败时丢弃并重排，Finding revision 记录实际 effectiveRulesDigest。

Finding 生命周期：

- 单边 Finding 的 canonicalSubject 为 edgeId。
- no-cycle Finding 的 canonicalSubject 为 SCC 内规范 node ID 排序数组；展示路径从最小 node 开始并按 edge ID 升序 DFS，取第一条闭合路径。
- Finding ID 是 ruleId、scope、canonicalSubject 的哈希。
- 持久字段包含 firstSeenFindingsRevision、lastSeenFindingsRevision、boundGraphRevision 和 active/resolved/stale。
- 保存后的“新增”相对于 Job base findings revision；impact 使用独立 Git baselineId，不复用主图 revision 命名空间。
- 配置无效时保留上一有效 Findings、推进 findingsRevision 并标记 stale；图谱 partial/stale 时，未被完整 scope 覆盖的既有 Finding 同样只能 stale。
- 只有有效配置在完整 scope 上成功评估后，缺失 Finding 才能标记 resolved。
- 规则配置变化可以保持 graphRevision 不变，但必须推进 findingsRevision。

共享 Finding 与配置诊断合同：

~~~ts
interface SourceLocationV1 {
  relativePath: string;
  range?: SourceRangeV1;
}

type FindingSubjectV1 =
  | { kind: "edge"; edgeId: string }
  | { kind: "scc"; nodeIds: string[]; evidencePathEdgeIds: string[] };

type ComparisonContextV1 =
  | { kind: "job"; baseFindingsRevision: number }
  | {
      kind: "git";
      baseRef: string;
      baseRefDisplay?: string;
      baselineId: string;
      derivedFromGraphRevision: number;
      derivedFromFindingsRevision: number;
    }
  | { kind: "none" };

interface FindingSummaryV1 {
  findingId: string;
  ruleId: string;
  ruleName: string;
  severity: "warning" | "error";
  status: "active" | "resolved" | "stale";
  boundGraphRevision: number;
  subject: FindingSubjectV1;
  actualRelation?: { fromId: string; relationType: string; toId: string };
  expectedConstraint: {
    ruleType: "forbidden-dependency" | "layer-order" | "no-cycle";
    from?: string[];
    to?: string[];
    allowedDirection?: string;
    scope?: "file" | "directory" | "package";
  };
  relativeLocations: SourceLocationV1[];
  detectedAt: string;
  comparisonContext: ComparisonContextV1;
  comparison: "new" | "existing" | "not-applicable";
}

interface ConfigDiagnosticV1 {
  code: string;
  severity: "warning" | "error";
  message: string;
  relativePath: string;
  range: SourceRangeV1;
  instancePath: string;
  invalidValue?: unknown;
  ruleId?: string;
  suggestedAction: string;
}
~~~

- comparisonContext 为 none，或 Finding 状态为 stale 时，comparison 必须为 not-applicable。
- canonical baseRef 由 workspace-key/subroot、Git object-format 与解析后的完整 commit OID 组成；branch、tag、短 SHA 只用于显示。baselineId 继续哈希 canonical baseRef、规则/config digest 与派生输入；临时 Git 基线不得复用或推进主图 graphRevision/findingsRevision。
- Problems、Findings、NodeDetails、ChangeSummary、CLI 与导出只能消费该比较结果，不得自行选择或猜测基线。

规则文件无效时：

- 图谱继续可用。
- 本次 revision 不执行新规则；服务仍推进 findingsRevision 以发布状态变化。
- 旧 Findings 标记为 stale: config-invalid，不得产生 resolved。
- Problems、CLI 与 doctor 使用同一个 ConfigDiagnostic。

## 11. VS Code 与 Webview

扩展侧：

- activation 时先检查 Workspace Trust。
- 通过 service-client 发现或启动服务。
- TreeView 只显示入口、状态和计数。
- DiagnosticCollection 只接收可定位 Finding/配置诊断。
- 当前实体与 ContextLock 只保存在当前 extension-host 会话内；Webview reload 时可由扩展内存恢复，但窗口 reload、VS Code 重启或重新打开工作区后必须清除。workspaceState/globalState 禁止保存固定标记；筛选、范围和视图模式可持久化，但不得持久化源码或图谱。
- Webview 重建时发送完整 GraphViewModel。

安全硬限制：

- 单文件 10 MiB。
- 最多 20000 个候选源码文件。
- 最多 1000 条规则，YAML alias 上限 50。
- 查询绝对上限为 3 跳、500 节点、1000 边。
- 最多 64 个待处理显式 Job。
- POSIX 缓存目录 0700、文件/socket 0600。Windows 缓存、令牌和服务元数据位于当前用户 OS 缓存并继承用户配置文件 ACL；Node/libuv 命名管道使用默认安全描述符，endpoint 增加随机不可猜后缀，业务请求前必须校验随机令牌、workspace-key 和协议版本并限制失败握手。

Webview 侧：

- Cytoscape.js 只消费 GraphViewModel。
- 图与列表共享选择、筛选和范围。
- 布局放入 Web Worker。
- 严格 CSP、nonce、无网络访问。
- 所有消息运行时校验。
- 键盘固定为 Tab 进入区域、方向键遍历邻接节点、Enter 选择/打开、Space 展开、Esc 返回。
- 屏幕阅读器可获得节点类型、入/出边数、Finding 数，以及边方向、来源和置信度。
- 高对比、键盘、屏幕阅读器和减少动态效果进入首批验收，不作为后补。

## 12. CLI 契约

| 命令 | 最小职责 |
| --- | --- |
| rebuild | 启动/等待全量索引 Job |
| query | 查询路径或实体邻域 |
| check | 对指定 revision 执行规则检查 |
| impact | 读取 working tree/staged/base ref 的 ChangeSet 并生成结构影响 |
| export | 输出预算内结构上下文 |
| status | 显示服务、revision、freshness 和 Job |
| doctor | 检查配置、缓存、协议、权限和环境 |
| cache path/clear | 显示或安全清理工作区缓存 |

机器可读模式的 stdout 只能包含 schema envelope；进度信息写入 stderr。端到端测试必须锁定退出码、JSON Schema、相对路径和无 ANSI 输出。

JSON envelope 至少包含 command、workspaceKey、graphRevision、findingsRevision、status、data、diagnostics、error。退出码固定为：

| Code | Meaning |
| ---: | --- |
| 0 | 成功或仅 warning |
| 1 | error 规则违反或 fail-on 条件命中 |
| 2 | 参数、工作区或配置无效 |
| 3 | 分析、存储或内部失败 |
| 4 | 协议或 schema 不兼容 |
| 130 | 用户取消或中断 |

导出契约：

- PrReviewSummaryV1 固定包含 verdict、majorRisks、keyPaths、新增风险、新增/删除边、受影响目录、循环变化、建议复查文件、graphRevision、findingsRevision、graphUpdatedAt 和 generatedAt。
- StructureContextExportV1 包含 scope、graphRevision、findingsRevision、graphUpdatedAt、generatedAt、entities、relations、rules、findings、truncation。内部 file/directory/workspace-package/symbol entity 必须包含 id、nodeType、relativePath；外部 entity 按 GraphView 的 externalKind 唯一映射为 external-package 或 node-builtin，并包含 id、nodeType、externalId、displayName。
- 服务只有在生成完整结束后才返回不可变 ExportArtifactV1；可复制或写出的 artifact 必须包含 artifactId、artifactStatus=complete、workspaceKey、artifactKind、format、scope、graphRevision、findingsRevision、requestedPolicy、effectivePolicy、containsSource、contentDigest 和 generatedAt，partial 或 generating 状态不得表示为 ExportArtifactV1。JSON content 使用 RFC 8785 JCS UTF-8，Markdown/text 使用无 BOM、LF 规范化 UTF-8；contentDigest 是最终 content 字节的小写十六进制 SHA-256。artifactId 是 `{schemaVersion:1,workspaceKey,artifactKind,format,scope,graphRevision,findingsRevision,requestedPolicy,effectivePolicy,containsSource,contentDigest}` 的 RFC 8785 JCS UTF-8 SHA-256。requestedPolicy/effectivePolicy 只允许 structure-only/include-source，默认为且不可被持久设置覆盖为 structure-only；include-source 只能来自当前 CLI invocation 或当前交互导出命令的显式授权，effectivePolicy 只能相同或更严格，containsSource 从 artifact 实际内容推导，structure-only 时必须为 false。
- extension 在本地持有绝对目标并执行 clipboard/原子文件写入，再组合 ExportPreviewModelV1；Webview 只接收 clipboard/file/none、脱敏显示标签及 pending/succeeded/failed，不接收绝对路径。
- 默认只含相对路径、规范 externalId 和结构信息；源码只能由当前命令显式开启。生成失败不得暴露或复制部分内容；界面可以保留上一份完整 artifact，但必须标记生成时间、revision/policy 和“上一份有效结果”。只有 clipboard、文件写入等目标操作失败时，才允许重试本次完整 artifact 或改用另一目标；目标重试不得改变 artifact 内容或身份。作为 ProductValidationEvidenceV1 提交时必须同时引用 artifactId、contentDigest 与 candidateRefDigest；application/validation evidence recorder 独占 append-only ValidationArtifactBindingV1 写入并以 artifactId 做 CAS，相同候选重放幂等，不同候选绑定冲突即 invalid。
- evidence recorder 使用发布证据存储的唯一 service identity；ProductValidationEvidenceV1 与 ValidationArtifactBindingV1 在同一个 append-only commit record 中原子写入，artifactId/evidenceId 分别唯一。恢复时孤儿 binding 或孤儿 evidence 直接 invalid，禁止事后补写关联。

ImpactVerdictV1 与排序合同：

~~~ts
type ImpactVerdict = "pass" | "review" | "block" | "unknown";

interface CycleDeltaV1 {
  kernelVersion: string;
  baselineId: string;
  scope: "file" | "directory" | "workspace-package";
  comparison: "new" | "existing" | "resolved" | "not-applicable";
  projectionId: string;
  canonicalRiskId: `cycle:${string}:${string}`;
}

interface ImpactVerdictV1 {
  version: 1;
  verdict: ImpactVerdict;
  coverageIncomplete: boolean;
  majorRisks: RankedRiskV1[];
  keyPaths: string[];
  suggestedReviewFiles: string[];
}
~~~

- 判定优先级为 block > unknown > review > pass。存在权威 new+active+error Finding 时始终 block；若同时范围不完整，保留 block 并设置 coverageIncomplete=true。
- application/impact 以显式 canonical baselineId 比较同 scope、同 kernelVersion 的基线/当前投影：当前新增 projectionId 为 new，交集 existing，基线消失 resolved；SCC split/merge 表现为旧 resolved 与新 new。缺少基线或任一投影不完整时 comparison=not-applicable。
- canonicalRiskId 只允许 `finding:<findingId>` 或 `cycle:<scope>:<projectionId>`。无确定 error，但受影响范围 partial/stale、配置无效、Finding/Cycle comparison=not-applicable 或影响计算不完整时为 unknown；完整分析中存在新增 active warning 或 CycleDeltaV1 new 时为 review；否则为 pass。
- existing 风险默认不改变 verdict，resolved 不导致失败；展示截断不改变 verdict，计算范围不完整才产生 unknown。
- riskClass 顺序为 new active error、新增循环、new active warning、existing active error、既有循环、existing active warning、stale/not-applicable；resolved 不进入 majorRisks。
- majorRisks 按 riskClass、canonicalRiskId；keyPaths 与 suggestedReviewFiles 按关联最小 riskClass、changeRole（changed-source、changed-target、affected、context）、从变更集合起的最短有向依赖 hop、相对 POSIX 路径稳定排序。
- application/impact 生成完整合同；Changes、PrReviewSummaryV1、CLI 文本/JSON 与 Markdown 只消费，不得改变 verdict 或重新排序。

## 13. 验证与门禁

### 版本化产品验证与发布适用性

ProductValidationPlanV1 是 SM-1、SM-6、SM-7、SM-8 与 UJ-5 价值门禁的唯一 oracle，至少固定：

- planId、planVersion 与 candidateRef 绑定规则。
- fixture/task manifest 及 digest。
- 每个任务的 startEvent、stopEvent 与 timeout。
- groundTruthRef、acceptableAliases、requiredEntities 与 criticalDistractors。
- eligibleParticipant、minimumSample、repository/team coverage 与 predeclaredExclusionRules。
- score instrument、threshold、aggregation rule、evidenceSchemaRef、resultSchemaRef、owner 与复测条件。

CandidateRefV1 是封闭判别联合：

- source：`{schemaVersion:1,kind:"source",productVersion,sourceCommit,lockfileDigest}`，其中 sourceCommit 是完整 commit OID，lockfileDigest 是 Git 中已提交 `pnpm-lock.yaml` 的无 BOM、LF 规范化 UTF-8 字节小写 SHA-256。
- release-set：`{schemaVersion:1,kind:"release-set",releaseSetId}`，releaseSetId 继承 AD-29；gatePhase=release 只接受该分支。
- candidateRefDigest：CandidateRefV1 的 RFC 8785 JCS UTF-8 小写十六进制 SHA-256。

所有 plan/policy/manifest/evidence/result 对象均使用 JSON Schema 2020-12、`additionalProperties:false` 和稳定 ID。planDigest、policyDigest、manifestDigest、evidenceDigest、resultDigest 对省略自身 digest 字段的对象执行 RFC 8785 JCS UTF-8 SHA-256；fixtureDigest 对相对 POSIX path 排序的 `{path,size,sha256}` 清单计算，taskDigest 对完整任务定义计算。Manifest.planRef 固定 planId/planVersion/planDigest，evidenceRefs 只声明 `{evidenceId,schemaRef,taskDigest,fixtureDigest}` slot，不含 evidenceDigest；Evidence 引用 planRef、policyDigest、manifestDigest、candidateRefDigest、taskDigest、fixtureDigest；Result 引用同一 planRef/policyDigest/manifestDigest/candidateRefDigest 与按 evidenceId 排序的 evidenceDigest。任一断链为 invalid。`packages/contracts` 独占 Schema 与 canonical encode/hash helper，`validation/product` 独占版本化 plan/task/fixture/ground truth，`validation/readiness` 独占 ReadinessGatePolicyV1；readiness compiler 只读取 policy、gate registry 与 CandidateRef 并独占 immutable Manifest 生成，禁止读取运行证据；application/validation release gate evaluator 只消费 finalized Manifest 与 Evidence，独占 Result 生成，禁止改变 applicability。

ReadinessGateManifestV1 是 release slice 适用性的唯一候选清单，至少固定 releaseSlice=alpha|beta|beta-plus|v1.1、gatePhase=entry|exit|release、逐项展开的 requirementRefs、gateId、blocking、policyDigest、planRef、command、gateDefinitionDigest、evidenceRefs、owner、manifestDigest 与 candidateRef。它只能由 ReadinessGatePolicyV1、`ci/quality-gates.v1.yaml` 和 CandidateRef 确定性编译，只能选择已定义 gateId；command 与 gateDefinitionDigest 必须匹配注册表，不得在候选 manifest 内重定义 gate。任务、fixture、ground truth、阈值或剔除规则变化必须提升 planVersion。不匹配 planVersion、digest、candidateRef 或 evidence schema 的 ProductValidationEvidenceV1/ProductValidationResultV1 为 invalid，不得人工解释为通过。

ReadinessGatePolicyV1 的继承固定为 alpha 无父、beta→alpha、beta-plus→beta、v1.1→beta-plus，必须无环。compiler 只对显式且唯一的 releaseSlice/gatePhase 计算传递闭包；缺失/重复规则、继承环或同 gateId 解析到不同 gateDefinitionDigest 均 invalid。普通 PR 不选择 slice/phase，也不编译 Readiness manifest，只使用 gate registry 的 trigger applicability。

phase 闭包固定为 entry < exit < release：目标 slice 纳入自身不高于目标 phase 的规则，每个继承祖先纳入全部已声明 phase；gate 集按 gateId 排序去重，digest 冲突 invalid。beta/exit 因此固定为 alpha 全 phase + beta entry/exit，v1.1/entry 固定为完整祖先门禁 + v1.1 entry。

| Slice / Phase | 必须列入 |
| --- | --- |
| Beta entry | FR-1 至 FR-10、FR-19 至 FR-22 的逐项 ID；适用 NFR；SM-2、SM-3、SM-4、SM-5；安装、隐私、安全、兼容和基础可访问性 gate |
| Beta exit | SM-1、SM-7 及对应 ProductValidationPlanV1 |
| Beta+ release | FR-1 至 FR-23、NFR-1 至 NFR-27、SM-1 至 SM-8、发布完整性和信任链 gate，全部逐项展开 |
| v1.1 entry | 完整 MVP 已通过，且 UJ-5 价值门禁通过；MCP 不进入当前 manifest 的 MVP requirementRefs |

### 验证矩阵

`BenchmarkPlanV1` 是性能门禁唯一 oracle。仓库版本化 manifest 固定 fixture/digest、参考环境、每项 SLA 起止事件、cold/warm cache、2 次 warm-up、至少 20 次测量与 p95。reference runner preflight 必须核对分配的 8 vCPU/16 GB/SSD、fixture/toolchain digest，任一不匹配产出 invalid 并使 gate 失败。单一 harness 使用 `process.hrtime.bigint()` 从动作发起计时到同一 harness 观察到完成事件；p95 固定为 nearest-rank `x[ceil(0.95*n)]`。首次概览使用 clean cache，缓存邻域使用已提交 warm cache，保存更新从宿主 save 动作到对应 graph/Findings revision 可见。运行器输出机器可读 `BenchmarkResultV1`，SM-4 corpus manifest 由同一 gate command 体系判定。

| 层级 | 必测内容 |
| --- | --- |
| Unit | ID 规范化、Evidence 合并、GraphPatch diff、BuiltinIgnoreV1/`.codegraphignore` 匹配与跨重启 last-valid 回退、ProjectionMembershipV1、FindingAttributionKernelV1、CycleProjectionKernelV1/CycleDeltaV1、OverviewMetricV1、ImpactVerdictV1/ImpactRankV1、规则匹配、预算排序、退出码映射 |
| Property | 相同输入重建得到相同 ID/边；GraphPatch 重放幂等；删除一个来源不删除其他 Evidence；过期 inputDigest/ignore/bootstrap generation 无法提交；complete slice 不删除其他 slice 的事实；跨文件 declaration merge 的 source ownership 不漂移；SCC split/merge 得到旧 resolved+新 new |
| Contract | JSON-RPC、CLI envelope、rules Schema、EffectiveIgnoreSnapshotV1/LastValidIgnoreRecordV1、BasicSymbolV1、ProjectionMembershipV1、GraphViewModel、OverviewMetricV1、CycleDeltaV1、ImpactVerdictV1、CandidateRefV1、ProductValidationPlanV1、ProductValidationEvidenceV1、ProductValidationResultV1、ReadinessGatePolicyV1、ReadinessGateManifestV1、GateDefinitionV1、GateRegistryV1、GateEvaluationContextV1、GateEvidenceV1、ValidationArtifactBindingV1、ReleaseArtifactManifestV1、ReleaseSetManifestV1、ReleaseSignatureV1 的向后兼容与未知字段行为 |
| Integration | SQLite 迁移/事务、服务单实例、双客户端、重连、取消、启动扫描竞态、watcher 丢事件后的周期对账、损坏缓存恢复 |
| Analyzer | tsconfig paths、project references、ESM/CJS、re-export、type-only、literal require/import()、JS、monorepo、Node built-in、BasicSymbolV1、语法错误、文件移动/删除 |
| VS Code | Workspace Trust、TreeView/Webview/Problems、主题、键盘、Webview reload、CSP |
| Security | 路径穿越、外部 symlink、恶意 YAML alias、超大文件、伪造 IPC token、Webview 消息 |
| Performance & accuracy | 8 逻辑 CPU、16 GB RAM、SSD；5000 文件、500000 LOC、50 packages；60s 首次概览、300ms 缓存邻域、2s 保存更新；至少 500 条版本化人工标注声明，规范依赖边 micro-F1 >= 0.80、high-confidence precision >= 0.90，并输出 precision/recall/F1、分类和失败样本 |
| Product validation | 由 ProductValidationPlanV1 固定 SM-1、SM-6、SM-7、SM-8、UJ-5 的任务、fixture、ground truth、样本、剔除、评分与阈值；证据/结果必须通过 schema、planVersion、digest 与 candidateRef 校验 |
| Packaging | 四类目标平台的安装、启动、原生 SQLite ABI、升级、卸载和缓存保留/清理；两个隔离 clean checkout 的未签名 payload root digest 一致 |

### CI 与发布门禁

Story 1.1 先以稳定 check 名 `architecture-required` 建立真实最小仓库 CI，运行 type、lint、unit、build、contract、dependency-boundary 与 basic-security，并只允许 Story 1.2 顺序合并。Story 1.3 再建立 `ci/quality-gates.v1.yaml` 作为 gate 定义注册表；GateDefinitionV1 固定 gateId、checkId、排序去重 triggerPaths、argv 数组 command、capabilityOwner、blocking，gateDefinitionDigest 是该对象 RFC 8785 JCS UTF-8 的小写 SHA-256。ReadinessGateManifestV1 只按 policy/候选/阶段选择注册表 gate，不得重定义。`architecture-required` 自身无 path filter、每个 PR 都运行；GateEvaluationContextV1 固定 providerRepositoryId、Git objectFormat、完整 baseOid/headOid 与 `comparisonBaseOid=git merge-base(baseOid,headOid)`，affected paths 使用固定 OID 的 `git diff --name-status -z --no-renames comparisonBaseOid headOid`，重命名按 delete+add。triggerPaths 只控制子 gate，使用 AD-14 的 POSIX glob 语义但禁止反选，缺失表示 always applicable。子 gate 适用状态只允许 required/not-applicable/invalid；manifest 无效、未知 gate、definition/command digest 不匹配、required gate 无证据、provider/drift 不一致均 fail closed。Story 1.3 后仓库外 ArchitectureGateController app/service identity 是 umbrella 结论唯一发布者，CAS 绑定 providerRepositoryId/headOid/manifestDigest；仓库 workflow 只能提交 child evidence。release/platform owner 持有 Controller、ruleset 与外部 drift monitor，Story 1.3 必须记录实际 provider、plan、权限和能力证据，provider 不支持时阻塞。Story 1.3 完成前不得并行 Story 1.4 或其他功能 Story。能力首次落地定义为生产代码首次可由公共 CLI/RPC/extension 入口调用，或公共 Schema 首次发布；门禁必须在同一 PR 启用。尚未实现的能力不得用空测试、永久 skip、无断言或始终成功脚本，门禁失败必须阻止合并。

GateRegistryV1 固定 `{schemaVersion:1,gates}`，gates 按 gateId 升序并包含 GateDefinitionV1/gateDefinitionDigest，gateRegistryDigest 为省略自身 digest 后的 JCS SHA-256。GateDefinitionV1 还必须包含 evidenceProducerId，且该字段进入 gateDefinitionDigest。`git merge-base --all` 的完整 OID 集合按字典序取最小 comparisonBaseOid，无结果 invalid；GateEvaluationContextV1 绑定 gateRegistryDigest 并生成 evaluationContextDigest。GateEvidenceV1 是 child gate 唯一封闭合同，绑定 gateId、gateDefinitionDigest、evidenceProducerId、evaluationContextDigest、headOid、pass|fail|invalid、outputDigest 与 gateEvidenceDigest；gateEvidenceDigest 对省略自身 digest 字段后的完整对象执行 RFC 8785 JCS UTF-8 小写 SHA-256。Controller 只接受 provider-authenticated 且定义匹配的 producer；同 context 的相同 gateEvidenceDigest 重放幂等，冲突 digest invalid。umbrella CAS 绑定 providerRepositoryId/headOid/evaluationContextDigest，发布前重新核对当前 base/head，变化即废弃并重算。

| 首次落地切片 | 同步接入的门禁 |
| --- | --- |
| Story 1.1 最小仓库 CI | `architecture-required` 稳定 check；type、lint、unit、build、contract、dependency-boundary、basic-security |
| Story 1.3 完整地基门禁 | `ci/quality-gates.v1.yaml`、规划引用与 FR/NFR/AR/UX-DR/Story 双向追踪、provider required check、禁用 bypass、外部 drift monitor |
| Story 1.4 首次 rebuild / SQLite | 迁移、按需建表、事务、BuiltinIgnoreV1、generation=0 有效快照 |
| Story 1.19 确定性提交 | GraphPatch 幂等、完整 CAS、过期重排、半提交不可见 |
| CLI 首次公共命令 | JSON Schema、stdout/stderr、相对路径、无 ANSI、退出码 |
| VS Code 首个 surface | Electron、Workspace Trust、CSP、主题与基础键盘冒烟 |
| rules / check 首次能力 | rules Schema、Finding 生命周期、规则退出码与配置诊断 |
| impact / export 首次能力 | CycleDeltaV1、ImpactVerdictV1、ImpactRankV1、导出 Schema、默认无源码和无绝对路径 |

上述门禁一经加入，后续每次合并持续执行；不得移交给发布 Epic 才首次启用。

发布候选额外执行：

1. 读取与 candidateRef 匹配的 ReadinessGateManifestV1，拒绝缺失、digest 不匹配或存在未通过 blocking gate 的候选。
2. 四平台构建矩阵。
3. 标准性能基准、SM-4 版本化语料准确率与上一个版本对比。
4. 协议/schema 兼容测试。
5. 新安装、升级、降级、服务冲突和缓存恢复。
6. VSIX 内容审计：不得包含源码 fixture、密钥、绝对开发路径或未声明网络端点。
7. 生成封闭 Schema 的 `ReleaseArtifactManifestV1`：artifactId 固定为 CLI=`codegraph-cli-npm`、VSIX=`codegraph-vsix-<platform>-<arch>`；payloadRootDigest 对排除 manifest 自身、签名、时间戳和 provenance 后的 `{path,mode,size,sha256}` 排序 tuples 执行 JCS SHA-256。SBOM 输出无 timestamp/serial/绝对路径的规范 SbomInventoryV1 JCS，并作为 payload 纳入 root；两个 clean checkout 的未签名 root 必须相同。
8. 生成封闭 Schema 的 `ReleaseSetManifestV1`：同版本 CLI 与全部 VSIX 共享 productVersion、sourceCommit、lockfileDigest、protocol/schema 集合；targetMatrix 与 artifacts 按 artifactKind/platform/arch 排序并一一相等，artifactId 和 tuple 均唯一。releaseSetId 对省略自身字段的对象执行 JCS SHA-256，候选只允许整套发布。
9. 生成由 repository-external `ReleaseTrustAnchorV1` 验证的 `ReleaseTrustBundleV1`：bundleDigest 对省略 bundleDigest 的 unsigned body 执行 JCS SHA-256；root signatures 使用 detached ReleaseSignatureV1 引用该 digest，不进入 bundle 自身。bundle sequence 单调并包含 delegated keys 与 revocations；root rotation 需要旧/新 root 两个 detached signatures。候选只接受最新 bundle 中有效且未 revoked 的 key，revoked key 对后续候选一律拒绝。
10. 使用 `ReleaseSignatureV1` 的 `ed25519-sha256-v1` profile 签署 trust bundle、artifact/set 精确 JCS bytes 的 SHA-256；keyId 为 public key SPKI DER 的 SHA-256。时间戳/provenance 随后附加并引用 subject/root digest。

## 14. 关键风险与处理

| 风险 | 早期信号 | 处理 |
| --- | --- | --- |
| TypeScript 分析内存过高 | 5000 文件基准持续接近内存预算 | 使用 TypeScript 6 增量 Program，分 project/worker 隔离、释放 Program、记录 heap；证实后再评估 Tree-sitter/Rust |
| 原生 SQLite 发布失败 | 某平台 VSIX 无法加载模块 | VSIX 捆绑 Node 24 运行时并锁定 Node ABI；平台 CI 安装测试与产物自检；不在运行时下载 |
| 保存事件风暴 | git checkout 后 Job 队列持续增长 | settle、路径合并、hash 去重、rebuild 吸收 |
| 图谱可视化卡顿 | Webview 长任务、布局抖动 | 服务预算、聚合、Web Worker、列表默认降级 |
| 规则噪声失去信任 | 既有 Finding 淹没新增风险 | 新增/既有分组、稳定 ruleId、精确证据与范围 |
| 协议版本漂移 | CLI 与扩展连接不同服务失败 | 握手、兼容矩阵、禁止第二实例、明确更新动作 |

## 15. 开发完成定义

一个功能只有同时满足以下条件才算完成：

- 未违反任何 AD，且依赖边界测试通过。
- 功能首次公开落地时，相关真实 gate 已在 `ci/quality-gates.v1.yaml` 登记并由 `architecture-required` 执行；Story 交付说明同时引用 checkId、capabilityOwner 和验证证据。
- 插件与 CLI 复用同一 application 能力和 contracts。
- 输出带 revision、相对路径、稳定错误 code 和来源/置信度。
- 包含失败、stale、取消、重连和超预算路径测试。
- 不阻塞 extension host 或 Webview 主线程。
- 不新增默认网络访问、源码日志或不可解释遥测字段。
- 相关性能指标有基准记录；无法验证时在交付说明中明确风险。
