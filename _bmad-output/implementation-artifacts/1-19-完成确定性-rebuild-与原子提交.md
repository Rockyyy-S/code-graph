---
baseline_commit: 6d0c84c02b68b1f6fd6859e4f7e290ffad7693dc
created_at: 2026-07-26T04:30:40+08:00
---

# Story 1.19: 完成确定性 rebuild 与原子提交

Status: done

<!-- 说明：本 Story 已完成需求、架构、现有代码、前序 Story、Git、测试与技术版本分析。实现必须保持本切片边界：只把 Story 1.4 的 hierarchy rebuild 提升为确定性 FactBatch/GraphPatch、完整 read-set CAS、ownership 与原子 graphRevision；不得提前实现后续 Analyzer、完整 ignore、Evidence 生命周期、公共取消命令、查询或 UI。 -->

## Story

As a 依赖本地图谱做判断的开发者，
I want 相同输入得到相同已提交图谱，并在输入变化时拒绝过期结果，
so that 查询和后续分析永远基于完整、可重复、未被竞态污染的 revision。

## Acceptance Criteria

1. **Given** hierarchy FactBatch 已生成
   **When** indexing application 提交结果
   **Then** FactBatch 使用 `hierarchy:<indexingRootId>` ownership slice
   **And** GraphPatch、graphRevision 和关联元数据在同一事务提交
   **And** 查询无法观察半更新状态。

2. **Given** 工作区内容和有效排除快照未变化
   **When** 连续执行两次完整 rebuild
   **Then** 实体 ID、contains 关系和稳定排序相同
   **And** 不产生重复节点、边或孤立 ownership
   **And** GraphPatch 重放幂等。

3. **Given** manifest、文件 hash、bootstrap generation 或排除快照在 Job 期间变化
   **When** GraphPatch 准备提交
   **Then** 服务对完整 read-set 执行 CAS
   **And** 过期结果不得提交
   **And** Job 被有界重排并保持旧 revision 可读。

4. **Given** Job 为 partial、failed 或 cancelled
   **When** 事务边界到达
   **Then** 最新已提交 revision 保持不变
   **And** 状态准确显示 partial、failed、cancelled 或 stale
   **And** 未完成事实不得覆盖完整 ownership slice。

5. **Given** Story 1.19 首次公开确定性 rebuild
   **When** CI 运行
   **Then** 事务原子性、幂等重建、ownership、完整 CAS、过期重排和半提交不可见均为 blocking gate
   **And** 任一失败阻止 Story 1.5 开始。

## Tasks / Subtasks

- [x] Task 1：先建立失败测试、切片合同与越界保护（AC: 1–5）
  - [x] 先为确定性 FactBatch/GraphPatch、`hierarchy:<indexingRootId>` ownership、graphRevision、幂等重放、完整 read-set CAS、过期重排、partial/failed/cancelled 不提交以及第二读者不可见半提交分别增加 RED 测试；禁止先改生产实现再补覆盖。
  - [x] 在测试中固定直接依赖只有 Story 1.4；Story 1.5、1.12、1.15 由本 Story 解锁。不得根据编号或文档位置推断依赖，权威只读 `StoryDependencyDagV1.dependsOn`。
  - [x] 明确本 Story 的完整 hierarchy read-set：规范排序的 manifest 与逐文件 SHA-256、完整 `EffectiveIgnoreSnapshotV1`、`bootstrapGeneration` 和 `baseGraphRevision`。严格区分语义 digest 与并发栅栏：`inputDigest/configDigest` 只绑定规范输入和 ignore 的 version/effectiveDigest，不包含 ignore generation、bootstrapGeneration 或 base revision；完整 CAS 对象另行精确携带并比较这些 generation/revision 字段。当前切片不得伪造尚未落地的 AnalyzerConfigSnapshot 或 RulesSnapshotRef；后续 Analyzer/Findings 事务必须在同一组合式 CAS 模型中追加其完整快照。
  - [x] 明确非范围：不实现 import/export、模块解析、BasicSymbolV1、workspace package、通用 Evidence 去重/删除/tombstone、`.codegraphignore` 完整 grammar/last-valid、公共 `job/cancel`、完整进度与 completedScope、查询、CLI/UI、Findings、impact、export、缓存恢复或遥测。
  - [x] AC-4 只要求本 Story证明提交边界对 partial/failed/cancelled 安全，并为状态合同提供最低必要表达；用户主动取消入口、完整状态正交矩阵与客户端时钟恢复仍属于 Story 1.15。

- [x] Task 2：定义核心拥有的 FactBatch、GraphPatch、read-set 与 revision 合同（AC: 1–4）
  - [x] 在 `packages/domain` 定义不依赖基础设施的 GraphPatch/fact/ownership/revision 纯模型，在 `packages/application/src/indexing/` 定义 hierarchy FactBatch 构建与 patch 用例；`HierarchyFactBatchV1` 至少携带 `ownershipSliceId`、`inputDigest`、producer/analyzer version、`coverage=complete|partial|failed`、规范排序的节点与 contains 边。不得把 SQLite rowid、绝对路径、SQL 或 adapter 类型带入核心。
  - [x] `ownershipSliceId` 固定为 `hierarchy:<indexingRootId>`；`indexingRootId` 固定复用现有确定性 workspace 根 `cg://` 实体 ID，并由合同测试锁定，不得使用 Job UUID、缓存路径、物理根绝对路径或新造的随机身份。
  - [x] 定义确定性的 `GraphPatchV1`：携带 `baseGraphRevision`、ownership slice、read-set/input digest、规范排序的 node/edge upsert 与 delete、`patchDigest` 和 coverage；digest 不得包含 Job ID、生成时间、SQLite 顺序或其他非语义字段。
  - [x] 在 application 定义窄 `CanonicalDigestPort`（或职责等价端口），由 FactBatch/GraphPatch/read-set 用例通过该端口计算 digest；`apps/graph-service` 只负责注入调用 `packages/contracts` 现有 RFC 8785 JCS → UTF-8 → SHA-256 小写十六进制 helper 的实现。domain/application 不得为复用 helper 反向依赖 contracts，组合根不得接管 patch 建模，也禁止另写近似 JSON stringify/hash 实现。
  - [x] 将 `GraphStorePort` 收敛为唯一类型化的 snapshot/ownership 读取与原子 `commit(AtomicGraphUpdate)`（或职责等价命名），使 application 计算 patch、adapter 只执行持久化和事务 CAS；迁移完成后移除生产路径上的 `commitHierarchy()`，不得让旧全量直写与新 GraphPatch 提交长期并行。调用方不得传 SQL、表名、rowid 或未校验的任意 JSON。
  - [x] complete hierarchy batch 才允许替换该 ownership slice；partial 只可作为未完成结果返回，failed 不生成 GraphPatch，二者均不得删除或覆盖已提交完整 slice。Story 1.7 才实现 source/manifest slice 的通用 Evidence、tombstone 与跨来源删除语义。

- [x] Task 3：把 workspace scanner 提升为确定性 manifest/read-set 采集器（AC: 2, 3, 4）
  - [x] 扩展 `apps/graph-service/src/workspace-scanner.ts`，在保持 realpath containment、NFC/POSIX 路径、BuiltinIgnoreV1 和稳定排序的前提下，为每个纳入文件计算原始字节 SHA-256 小写十六进制，并返回不可变、按规范路径升序的 manifest entries。
  - [x] 文件 hash 必须基于实际打开的文件字节；读取前后验证文件仍是受信任 root 内普通文件，并对替换、截断、路径规范化冲突或读取失败稳定 fail closed。不得把源码正文、绝对路径或文件句柄泄露到公共合同、日志或持久元数据。
  - [x] 由于本 Story 开始真实读取源码字节用于 hash，应用架构的单文件 10 MiB 安全上限；超限使用稳定可操作诊断，不静默截断、不跳过后宣称 complete，也不扩大 Story 1.4 的 20,000 候选文件与 100,000 目录项预算。
  - [x] 从规范 manifest entries 生成 `manifestDigest`，并按架构形状生成 hierarchy `configDigest/inputDigest`：producer kind/version 与 ignore version/effectiveDigest 进入 configDigest，排序后的 `{path,contentHash}` 进入 inputDigest；ignore generation、bootstrapGeneration、baseGraphRevision 只进入 CAS read-set，不进入语义 digest。相同文件集合、字节内容和有效 ignore 语义必须得到字节级相同 digest，与目录枚举顺序、宿主分隔符和区域设置无关。
  - [x] 在 GraphPatch 准备提交前重新采集或复核完整 read-set；分别检测文件集合变化、单文件 hash 变化、`bootstrapGeneration` 变化和完整 `EffectiveIgnoreSnapshotV1` 变化。只比较 generation 或只比较 effectiveDigest 都不足以满足 AC-3。
  - [x] 新增 service-instance 级 `IndexReadSetProvider`（或职责等价边界），在启动配置屏障完成后以 `bootstrapGeneration=0` 初始化，并允许未来 watcher/reconciliation 在同一 `statusEpoch` 内单调推进；当前 Story不实现完整 watcher，但必须通过注入测试证明 generation 变化可使在途 patch 失效。generation 不跨服务实例比较。
  - [x] `buildHierarchyGraph()` 继续只消费规范相对路径，不读取文件系统或解释 ignore；scanner/graph-service 负责采集事实，application 负责确定性建模，SQLite adapter 不得反向扫描工作区。

- [x] Task 4：计算确定性 hierarchy GraphPatch 与 ownership 替换（AC: 1, 2, 4）
  - [x] 基于 Story 1.4 现有 `buildHierarchyGraph()` 生成 complete hierarchy FactBatch；保持 `cg://` 实体 ID、contains 方向、qualifier 与 edge ID 算法不变，禁止因本 Story重写身份模型。
  - [x] 从 `GraphStorePort` 读取当前已提交 revision 和 `hierarchy:<indexingRootId>` 拥有的事实，按 fact kind + 规范 ID 计算 upsert/delete；输入排列、重复候选或 SQLite 返回顺序不得改变 patch 内容或 digest。
  - [x] complete replacement 必须为目标节点、边写入 ownership；删除时先移除该 slice 的旧 ownership，只删除已无任何 owner 的事实，并保持外键安全顺序。当前 hierarchy 不得提前实现 Story 1.7 的 Evidence 合并算法。
  - [x] 相同目标状态重算得到空语义 patch；相同 `patchDigest` 或同一 patch 重放必须是 no-op，不重复节点、边或 ownership，也不得仅因重放推进 graphRevision。
  - [x] 节点、边、ownership 与 patch 操作使用稳定排序；任何时间戳只作为提交元数据，不能参与实体 ID、edge ID、inputDigest 或 patchDigest。
  - [x] 为后续 source/manifest slice 保留可扩展边界，但本 Story仅允许 hierarchy slice 进入生产写路径；未知 slice kind、coverage 或 fact kind 必须在 application/adapter 边界被拒绝。

- [x] Task 5：新增 SQLite 增量迁移并实现单事务 CAS/commit（AC: 1–4）
  - [x] 保留 `001-bootstrap.ts` 作为历史 migration；新增下一版本 migration，演进当前八表中的 workspace/meta/jobs/facts_ownership（或职责等价结构），分别持久化 graphRevision、语义 input/config/manifest/effective-ignore digest、patch digest、ownership 和 Job base/result revision；statusEpoch-scoped ignore/bootstrap generation 只可作为当次 Job 审计/CAS 证据，不得在服务重启后当作语义缓存身份或跨 epoch 比较。不提前创建 Findings、impact、export 或发布表。
  - [x] 锁定 v1→v2 三类迁移规则：无 committed snapshot 的 v1 保持 absent 且不分配 graphRevision；已有真实空提交或非空提交的 v1 均保留节点/边、summary、精确 succeeded Job 并初始化为 graphRevision 1，同时因缺少可证明的 read-set 标记 stale，直到首次 1.19 rebuild 成功。不得清空旧图、伪造当前 digest 或把 migration 当成一次新图谱提交。
  - [x] 唯一 `commitAtomicGraphUpdate` 使用单个同步 `better-sqlite3.transaction()`：在事务内 CAS `baseGraphRevision` 与持久化 read-set/base metadata，应用 node/edge/ownership 的有序 delete/upsert，更新提交摘要与关联 digest，按且仅按真实图谱变化推进 graphRevision，并完成 Job result revision；任何一步失败整体回滚。
  - [x] 文件系统/ignore/bootstrap 的当前 read-set 由 graph-service 在进入存储事务前复核；SQLite 事务仍必须 CAS 持久化 base revision/read-set，防止旧 patch、重复调用或未来 mutation producer 越过唯一通道提交。
  - [x] graphRevision 使用非负安全整数；空语义 patch 允许 Job succeeded，但 `resultGraphRevision=baseGraphRevision`，不得为无变化 rebuild 制造 revision 噪声。真实 patch 每次且仅推进 `baseGraphRevision + 1`，首次无基线提交不得对外暴露伪造 revision 0。
  - [x] partial、failed、cancelled、CAS mismatch 或 fault injection 不得改变 nodes、edges、facts_ownership、committed summary/digest 或 graphRevision。terminal Job 记录可以在独立小事务收敛，但不能覆盖原始诊断或伪装 GraphPatch 已提交。
  - [x] 保持 WAL、foreign keys、`synchronous=NORMAL`、有界 busy timeout、未知 schema 安全拒绝和故障备份语义；migration/commit 回调保持同步，禁止在 `better-sqlite3.transaction()` 中跨 `await`。
  - [x] 同一事务还必须把 committed summary 与实际 succeeded Job、result revision、patch/read-set 元数据精确绑定；启动恢复继续交叉回验真实事实、摘要与绑定 Job，不能只按时间戳或“最后一行”猜测提交。
  - [x] 使用第二个 SQLite 只读连接或等价真实读路径证明 WAL reader 在事务期间只看到旧 revision，提交后一次性看到新 revision、图与 ownership；不得以单连接内的测试替代“半提交不可见”证据。

- [x] Task 6：在唯一 snapshot mutation channel 中执行 CAS 与有界重排（AC: 1, 3, 4）
  - [x] 继续由 `apps/graph-service` 作为唯一组合根和每 indexing root 的唯一 writer；复用当前共享 `GraphServiceRuntime`，不得新增第二队列、连接级 store/state 或 adapter 直写旁路。
  - [x] 每个 logical rebuild Job 固定流程：读取 base committed snapshot → 捕获完整 read-set → 构建 complete FactBatch → 计算 GraphPatch → 在安全取消点检查 signal → 复核完整 read-set → 调用原子 store CAS/commit → 发布 terminal 状态。查询与 status 始终引用最后已提交 revision。
  - [x] read-set 或 store CAS 不匹配时丢弃当前 batch/patch，不写任何 ownership/graph 行，并对同一个 logical Job 做内部重排；具名常量固定为 `MAX_STALE_REQUEUE_ATTEMPTS = 3`，并测试第 1–3 次重排及耗尽终态，禁止无限循环、递归失控或创建一串伪 terminal Job。
  - [x] 重排期间旧 committed revision 保持可读，freshness 标记 stale；新尝试必须重新采集 manifest/hash/ignore/bootstrap，而不是复用已过期 digest。超过上限后使用稳定 ErrorV1 code `GRAPH_INPUT_CHANGED_DURING_BUILD` 结束，并由合同测试锁定 category、retryable、message 与 suggestedAction；旧 revision 与 ownership 不变。
  - [x] shutdown/AbortSignal 在事务外安全点到达时记录 cancelled，而不是继续复用 `GRAPH_SCAN_FAILED` 冒充普通失败；事务一旦开始不强杀、不回滚已提交结果。公共 `job/cancel` RPC、取消原因枚举、完整 progress/completedScope 留给 Story 1.15。
  - [x] coverage=partial 时不得生成替换 patch；状态必须表达 partial/stale 并保留旧 revision。failed 保留稳定错误、logId 与 suggestedAction；cancelled 保留旧摘要/完整度，若已发现输入差异不得恢复 current。
  - [x] 保持现有 shutdown 有界等待、store 关闭所有权、并发第二 Job 拒绝、时间戳单调钳制和连接间共享状态；新增重排不能让 `close()` 永久等待或在 store 已关闭后继续调度。

- [x] Task 7：扩展最低必要公共 revision/状态合同并同步专属门禁（AC: 1, 3–5）
  - [x] 在 `packages/contracts` 为 committed summary 与 Index Job 增加最低必要的 `graphRevision`、`baseGraphRevision`、`resultGraphRevision` 表达；queued/running 的 result 必须为 null，terminal 未提交时 result 等于 base，成功性只由 Job state 表达。
  - [x] 为 terminal cancelled 和 workspace `current|stale`、必要的 `partial` 表达更新严格 Schema、兼容 Schema、运行时校验与 canonicalization；兼容入口必须安全读取 Story 1.2/1.4 旧状态并确定性归一化，严格入口不得继续把架构 `current` 私自命名为 `fresh`。
  - [x] `availability=absent` 时不得伪造 graphRevision；`available` 必须绑定真实 committed revision。status/service revisions 与 graphRevision 语义分离：状态观察变化不等于图谱提交，GraphPatch no-op 不推进 graphRevision。
  - [x] 保持现有 `job/start {kind:"rebuild"}` 公共入口，不新增平行 RPC 方言；本 Story不增加公共 cancel 方法。若 RPC 或现有 Schema 的语义发生变化，必须通过 base/head 公共能力差异检查枚举全部变化能力。
  - [x] 预期至少重新门禁 `rpc:job/start`、`schema:errorV1Schema`、`schema:initializeResultSchema`、`schema:initializeResultCompatibleSchema`、`schema:jobStartResultV1Schema`、`schema:serviceStatusV1Schema` 与 `schema:serviceStatusV1CompatibleSchema`；最终集合以 `validate-public-capability-gates.mjs` 对基线提交与候选提交的实际差异为准，不得手工遗漏嵌套 status 引起的 initialize 能力变化。
  - [x] 每个新增或语义变化的 `rpc:*` / `schema:*` 能力都必须在同一 PR 获得唯一 verification、fixture、测试、evidenceId 与 blocking gate，并更新 `ci/public-capability-gates.v1.json`、`ci/quality-gates.v1.yaml` 及相应 digest；不得把多个变化能力重新塞回通用 `contract` gate。
  - [x] 公共能力 validator 要求变化能力绑定“本次变更新增”的唯一 gate，并要求 entry/test/fixture 同 PR 新增或更新；不得继续复用 Story 1.4 的旧 gateId 或让新旧 gate 使用相同命令。以现有 `scripts/contracts/verify-graph-bootstrap-*.mjs`、`tests/unit/graph-bootstrap-*-capability.test.ts`、`tests/fixtures/graph-bootstrap-*.json` 为模式创建 Story 1.19 专属资产，并同步更新 `tests/contract/quality-gates-manifest.test.ts` 的精确 gate 列表与计数。
  - [x] CI 专属验证必须覆盖事务原子性、幂等 rebuild、ownership、完整 CAS、过期重排和半提交不可见；门禁失败阻止 Story 1.5、1.12、1.15 使用该地基。

- [x] Task 8：建立完整单元、属性、集成、进程与回归证据（AC: 1–5）
  - [x] Unit：manifest/file hash、JCS digest、FactBatch、GraphPatch diff/排序/digest、ownership slice、no-op/replay、revision 与状态合法/非法矩阵；使用多种输入排列和重复项验证确定性，不为此引入新的通用工具包。
  - [x] CAS：分别在 scan 后、patch 后、commit 前注入 manifest 增删、同路径字节变化、bootstrap generation 变化、ignore snapshot 任一字段变化和 base revision 变化；断言旧 patch 被丢弃、内部重排有界且旧 revision 可读。
  - [x] SQLite：v1→v2 migration、clean migration、未知未来 schema、精确表集合、ownership 写入/移除、原子 rollback、no-op revision、重复 patch、第二读者隔离、`SQLITE_BUSY`/`SQLITE_FULL`/触发器故障和幂等 teardown。
  - [x] Runtime：首次 commit、连续相同 rebuild、真实变化 rebuild、partial、scan/hash failed、queued/running cancel、CAS 重排成功/耗尽、并发第二 Job、shutdown timeout、跨重启恢复 revision/read-set/job。
  - [x] Process/API：通过真实 Named Pipe/UDS 完成 initialize → `job/start` → `service/status`；覆盖旧 revision 在重排/失败/取消期间持续可读、成功后 revision 一次性切换、公共输出不含绝对路径/源码/hash read buffer。
  - [x] Contract/gate：更新严格与兼容 fixtures、每个变化公共能力的独立验证脚本/测试/gate/evidence；保留受控失败样本，禁止 skip/todo/only、无断言、空测试或始终成功脚本。
  - [x] 回归 Story 1.4：BuiltinIgnoreV1、generation 0、`.codegraphignore` unsupported fail closed、受信任 root、空工作区、迁移/PRAGMA、稳定错误、共享 runtime 与关闭清理全部继续通过。
  - [x] 运行 `pnpm type`、`pnpm lint`、`pnpm unit`、`pnpm build`、`pnpm contract`、`pnpm dependency-boundary`、`pnpm basic-security`、`pnpm planning-trace` 和 `pnpm architecture-required`；记录测试计数、受控失败、候选 SHA 与 provider 结果。

- [x] Task 9：更新文档、交付记录与 Sprint 状态（AC: 5）
  - [x] 更新 `docs/repository-layout.md` 或同职责文档，说明 hierarchy FactBatch/GraphPatch、ownership slice、graphRevision、manifest/read-set、CAS、重排与 SQLite migration；路径使用相对路径，不写本机绝对路径。
  - [x] 更新 `docs/protocol/service-control-v1.md`：移除“状态不含 graphRevision”的 Story 1.4 临时说明，记录 committed revision 的原子可见性、partial/failed/cancelled/stale 的最低语义、CAS 冲突有界重排与旧 revision 可读；明确没有新增公共 cancel/query RPC。
  - [x] 新增 Story 1.19 provider/门禁证据文档，逐项记录变化能力、checkId、capabilityOwner、evidenceProducerId、gate/registry digest、候选 SHA、Hosted run 与最终结果。
  - [x] 在 Dev Agent Record 中记录实际修改文件、migration 版本、read-set/digest 形状、ownership 与 revision 规则、重排上限、稳定错误 code、公共能力 diff、测试计数、真实进程/第二读者证据及明确未实现的后续 Story 边界。
  - [x] 只有实现、全部本地 blocking gate、变化公共能力专属 gate 和当前候选 provider 证据均完成后，才把本 Story 从 `in-progress` 推进到 `review`；独立代码审查完成后才可置为 `done`。

### Review Findings

- [x] [Review][Patch] 使用区域无关的稳定排序，避免 Unicode 路径改变 manifest 与 patch digest [`apps/graph-service/src/workspace-scanner.ts:140`]
- [x] [Review][Patch] 将源码 hash 改为有界分块读取，读取期间增长也不得突破 10 MiB [`apps/graph-service/src/workspace-scanner.ts:281`]
- [x] [Review][Patch] 用设备/文件身份绑定 root、目录、路径与已打开句柄，拒绝同路径替换和 Windows reparse 竞态 [`apps/graph-service/src/workspace-scanner.ts:122`]
- [x] [Review][Patch] stale 重排后的 attempt base 不得与 logical Job 初始 base 混用 [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:480`]
- [x] [Review][Patch] 在单一 SQLite 只读事务中读取 revision、节点、边与 ownership 快照 [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:283`]
- [x] [Review][Patch] 启动恢复必须交叉校验 committed Job 的 patch/read-set 证据与 workspace digest [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:247`]
- [x] [Review][Patch] 相同 patchDigest 不得跳过仍存在的 ownership/事实修复操作 [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:427`]
- [x] [Review][Patch] partial/stale 证据必须持久化并在服务重启后保持 [`apps/graph-service/src/service-state.ts:108`]
- [x] [Review][Patch] 已观察输入差异或扫描失败时不得继续把旧 revision 标记为 current [`apps/graph-service/src/index-job-runtime.ts:174`]
- [x] [Review][Patch] 严格状态校验不得把 terminal result 的显式 null 当成兼容缺失字段 [`packages/contracts/src/runtime-validation.ts:350`]
- [x] [Review][Patch] blocking gate 补齐真实 base revision CAS、完整 read-set 变化和各事务阶段回滚证据 [`tests/unit/index-job-runtime.test.ts:313`]
- [x] [Review][Patch] 为 migrated succeeded Job 持久化显式 legacy provenance，现代 revision 1 不得冒充 v1 数据 [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:1935`]
- [x] [Review][Patch] mutation 异常使用独立失败哨兵，确保 `throw undefined` 仍强制回滚 [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:432`]
- [x] [Review][Patch] 最终 fence mutation capability 仅同步期、仅一次有效，禁止回调逃逸后在事务外提交 [`packages/adapters/store-sqlite/src/sqlite-graph-store.ts:431`]
- [x] [Review][Patch] pending ambiguous rename 期间所有 read-set fence 必须 fail closed [`apps/graph-service/src/index-read-set.ts:367`]
- [x] [Review][Patch] 启动验证等待 pending rename，并以 8 次稳定化预算收敛为 stale，禁止无限握手阻塞 [`apps/graph-service/src/index-job-runtime.ts:46`]
- [x] [Review][Patch] watcher 序列饱和、worker fatal 或退出必须通过共享 fatal 位同步暴露 [`apps/graph-service/src/index-read-set.ts:524`]
- [x] [Review][Patch] ignored rename 使用可取消的异步完整内容扫描，提交前后继续同步校验内容 hash [`apps/graph-service/src/index-read-set.ts:220`]
- [x] [Review][Patch] provider close 或后继 ambiguous rename 必须取消扫描并立即失效 generation，避免事件丢失 [`apps/graph-service/src/index-read-set.ts:214`]
- [x] [Review][Patch] succeeded `initial-index` 只能产生首个 graph revision 1，严格与兼容 validator 均拒绝伪造的后续 revision [`packages/contracts/src/runtime-validation.ts:391`]
- [x] [Review][Patch] Provider 证据结论必须与 Story/Sprint 的本地终审完成状态一致，同时保留 Hosted Provider 合并前置条件 [`docs/ci/story-1-19-provider-evidence.md:72`]
- [x] [Review][Patch] 已有 committed graph 时 failed/partial/cancelled Job 必须是 `rebuild`，不得接受无基线 `initial-index` [`packages/contracts/src/runtime-validation.ts:403`]
- [x] [Review][Patch] terminal `partial` Job 必须同步映射为顶层 `completeness=partial`，拒绝持久化不可能产生的完整度组合 [`packages/contracts/src/runtime-validation.ts:295`]
- [x] [Review][Patch] 顶层 `completeness=partial` 必须保留 partial/failed/cancelled terminal 证据，缺失终态或 succeeded 均应拒绝 [`packages/contracts/src/runtime-validation.ts:296`]

## Dev Notes

### Developer Context

- Story 1.4 已交付安全首次 hierarchy、最小 SQLite 和公共 rebuild 入口，但其实现有意停在“单次全量事务”：`scanWorkspace()` 只返回相对路径与排除计数；`createIndexJobRuntime()` 直接执行 scan → `buildHierarchyGraph()` → `commitHierarchy()`；`commitHierarchy()` 在一个事务中删除全部当前 workspace 节点/边后重插，并更新 summary/Job。
- 当前路径没有文件字节 hash、manifest/input digest、GraphPatch、graphRevision、完整 read-set CAS 或过期重排；`facts_ownership` 只建表未写，`evidence` 只建表未消费。不得把 Story 1.4 的事务回滚误报为已完成 Story 1.19。
- 当前 `ServiceStatusV1` 有 service/status revision，但没有 graphRevision；freshness 仍是 `fresh|null`，Job 只有 queued/running/succeeded/failed，shutdown abort 被映射为 `GRAPH_SCAN_FAILED`。本 Story只补 AC 所需的最低 revision/cancelled/stale/partial 语义，完整 UX 状态模型仍由 Story 1.15 收口。
- Story 1.19 是后续 Analyzer 的提交地基。实现必须先让 hierarchy slice 走唯一 FactBatch → GraphPatch → CAS → atomic commit 主干；Story 1.5 只能在该主干上增加 source analyzer，不能再新增第二种直写存储路径。
- 权威依赖为：`1.19 dependsOn [1.4]`；直接解锁 `1.5`、`1.12`、`1.15`。展示顺序和 Story 数字均不是调度权威。

### Current Files to Update

| 文件 | 当前状态 | 本 Story 改动 | 必须保持 |
| --- | --- | --- | --- |
| `apps/graph-service/src/workspace-scanner.ts` | 仅返回稳定排序路径和排除计数，不读取文件字节 | 采集 manifest/file hash、生成 read-set 并支持提交前复核 | realpath containment、BuiltinIgnoreV1、预算、NFC/POSIX、无绝对路径泄露 |
| `apps/graph-service/src/index-job-runtime.ts` | 单 Job scan→build→commit；无 CAS/重排；abort 归类 failed | 接入 FactBatch/GraphPatch、base revision、完整 CAS、有界重排、cancelled 安全点 | 共享 runtime、并发拒绝、时间单调、close 有界、store 所有权 |
| `apps/graph-service/src/service-state.ts` | 发布最小 Job/summary 与 service/status revisions | 增加 graph revision、current/stale/partial/cancelled 的最低发布规则 | 状态原子冻结、连接共享、service revision 与 graph revision 分离 |
| `apps/graph-service/src/index.ts` | 唯一生产组合根，装配 store、ignore 与共享 runtime | 按需注入 read-set provider、GraphPatch 编排器和固定重排策略 | graphRevision 恢复必须在 runtime barrier 内完成，握手开放后不得异步补载 |
| `apps/graph-service/src/instance-owner.ts` | 管理唯一 writer、runtime barrier 与关闭顺序 | 仅在 runtime 接口变化时做最小跟随 | 不把 read-set/GraphPatch/revision 放入 metadata；先关 runtime 再回收 endpoint/lock |
| `apps/graph-service/src/server.ts` | 认证、校验并委托共享 runtime | 原则上只审查，类型要求时最小跟随 | CAS/重排不得放在 IPC handler；不新增 cancel/query RPC；保持脱敏与帧预算 |
| `packages/application/src/indexing/hierarchy-builder.ts` | 从规范候选路径构造稳定 hierarchy | 输出/组合 complete hierarchy FactBatch，保持现有 ID/排序 | application 不读文件系统、不解释 ignore、不依赖 adapter |
| `packages/domain/src/graph-patch.ts`、`packages/domain/src/index.ts` | 当前只有 hierarchy/identity 模型及其 barrel export | 新增并导出 fact、ownership、GraphPatch、revision 的基础设施无关形状 | domain 不依赖其他项目包，不出现 IPC/SQL/host 类型 |
| `packages/application/src/indexing/*`、`packages/application/src/index.ts` | 只有 hierarchy builder，尚无 patch/read-set 用例或 digest 端口 | 新增 hierarchy FactBatch、GraphPatch builder、`CanonicalDigestPort` 并导出稳定核心 API | application 只依赖 domain；digest 实现由组合根注入，不反向依赖 contracts |
| `packages/application/src/ports/graph-store-port.ts` | 只有 Story 1.4 `commitHierarchy` 与最小 Job 方法 | 用 typed snapshot/ownership read、CAS `commitAtomicGraphUpdate`、revision/read-set 结果替换旧生产提交入口 | 不暴露 SQL、表名、rowid；核心拥有端口；不保留双写路径 |
| `packages/adapters/store-sqlite/src/sqlite-graph-store.ts` | 全量 delete/insert 单事务；无 ownership/revision/read-set | 应用确定性 patch、完整事务 CAS、ownership、revision、no-op、恢复 | 同步 transaction、WAL/FK/NORMAL/busy timeout、失败回滚、仅服务写 |
| `packages/adapters/store-sqlite/src/migrations/001-bootstrap.ts`、新增 `002-deterministic-commit.ts`、`packages/adapters/store-sqlite/src/index.ts` | v1 是 Story 1.4 历史 migration，barrel 只导出当前 store API | 保持 001 不改；新增并注册 v2 migration，导出收敛后的 store API | v1 可重复打开、未知 schema 安全拒绝，不把新字段伪装成旧 schema |
| `packages/contracts/src/index-job.ts` / `index-job-schema.ts` | 最小 Job，无 base/result revision 或 cancelled | 增加最低 revision/cancelled 合同 | 封闭联合、UTC 时间、严格/兼容语义 |
| `packages/contracts/src/service-status.ts` / `service-control-schema.ts` / `runtime-validation.ts` / `protocol-error.ts` / `index.ts` | 无 graphRevision，freshness=`fresh|null`，错误注册表无输入竞态终态 | 增加真实 committed revision、current/stale/partial、cancelled、稳定竞态错误并同步导出/兼容归一化 | absent 不伪造 revision；严格 Schema、运行时 validator 与错误不变量一致 |
| `tests/unit/index-job-runtime.test.ts` / `sqlite-graph-store.test.ts` / `workspace-scanner.test.ts` | 覆盖 Story 1.4 rollback、扫描安全与关闭 | 增加 determinism、CAS、retry、ownership、revision、reader isolation | 现有 1.4 负向与恢复用例全部保留 |
| `tests/contract/graph-bootstrap-contract.test.ts`、`service-control-contract.test.ts`、`graph-service-process.test.ts` 与 capability/gate 资产 | 锁定 1.4 公共状态、Job、真实 IPC 与 22 项 gate | 扩展 strict/compatible、真实进程原子切换、变化能力专属 gate 与 Story 1.19 提交 gate | base/head 能力追踪、每能力唯一新增 gate、无共享假 gate |
| `docs/protocol/service-control-v1.md` / `docs/repository-layout.md` | 仍描述 Story 1.4 的无 graphRevision、首次整表事务 | 更新为 committed revision、ownership GraphPatch、完整 CAS、追加 migration 与状态边界 | 保持控制面方法集合、IPC 安全、唯一 writer 与后续能力非范围 |

### Architecture Compliance

- 六边形模块化单体：domain/application 定义事实与端口，scanner/SQLite 是 adapter/host 边界，`apps/graph-service` 是唯一组合根。禁止 SQLite adapter 调 analyzer、application 读 `node:fs`、domain/application 依赖 contracts，或 graph-service 绕过端口直接写 SQL；跨边界 digest 由组合根复用 contracts helper 后注入核心模型。
- 每 indexing root 只有一个 graph-service 和一条 snapshot mutation channel；任何推进 graphRevision 的事务都必须进入该通道。查询只读已提交 revision。
- hierarchy FactBatch 使用 `hierarchy:<indexingRootId>`；complete 才允许 replacement，partial 只 upsert/显式 tombstone 的通用规则由后续 slice 实现，failed 不生成 GraphPatch。
- 公共身份继续使用工作区作用域 `cg://`、Unicode NFC、相对 POSIX 路径和确定性 edge ID；SQLite rowid、绝对路径、宿主分隔符不进入合同。
- SQLite 保持用户缓存、单 writer、WAL、foreign keys、NORMAL、有界 busy timeout、事务化 migration 与故障副本策略。
- 所有新注释、JSDoc、文档字符串、配置说明和脚本注释必须使用中文；TypeScript/JavaScript 接口、类、方法与复杂逻辑使用符合项目约束的 JSDoc。

### Library / Framework Requirements

- 不新增依赖。继续使用仓库锁定的 Node.js `24.18.0`、pnpm `11.12.0`、TypeScript `6.0.3`、Vitest `4.1.10`、`better-sqlite3` `12.11.1`、`@types/better-sqlite3` `7.6.13`、Ajv `8.20.0`、`vscode-jsonrpc` `9.0.1`、YAML `2.9.0` 与 esbuild `0.28.1`。
- 文件 hash 使用 Node `node:crypto`，文件读取使用 Node 24 稳定公开 API；canonical digest 由 `apps/graph-service` 复用 `packages/contracts/src/canonical-json.ts`，不得改变 application/domain 的既有依赖方向。
- `better-sqlite3.transaction()` 回调必须同步；不得引入 ORM、第二个 SQLite driver、通用队列框架、Tree-sitter、LSP、SCIP 或新 hash/canonical-json 包。
- 架构与 lockfile 已把本 Story所需技术版本锁定为实现权威；本 Story不做依赖升级，也不以 registry 的“最新版本”覆盖已批准架构版本。

### Testing Requirements

- Unit/Property：同输入、不同枚举顺序、重复候选、相同 patch 重放必须得到相同 ID、边、ownership、digest 与 revision 结果。
- Integration：用真实 SQLite 两连接验证旧/新快照原子可见；在 node、edge、ownership、metadata、revision、Job 各阶段注入失败并验证全回滚。
- CAS：四类 read-set 变化必须逐项独立测试，不允许只测“任意 digest 不同”；重排成功与上限耗尽都要验证。
- State：partial/failed/cancelled/stale 与 committed revision/availability/completeness 的组合必须有正负测试；serviceStatusRevision/statusRevision 与 graphRevision 不得混用。
- Process：真实 IPC 证明公共状态在失败、重排与取消期间继续引用旧 committed revision，成功后一次性切换。
- Regression：Story 1.1–1.4 的全部 blocking gate、公共 capability gate、provider 证据流程继续有效。

### Previous Story Intelligence

- Story 1.4 明确把 GraphPatch、graphRevision、完整 CAS、过期重排、完整 ownership replacement 留给 1.19；不要重新设计已完成的 BuiltinIgnoreV1、路径身份、最小 schema/PRAGMA、共享 runtime 或启动清理。
- Story 1.4 代码审查重点证明：受信任 root 可能被 junction/symlink 替换；launcher 不得在 runtime barrier 前误报成功；RPC timeout 必须大于 SQLite busy timeout；runtime close 必须有界；多连接必须共享状态。这些修复是 1.19 的保留性回归要求。
- 现有 fault injection、真实进程、严格/兼容 fixtures 与一能力一 gate 模式已经建立；直接扩展这些模式，禁止另建平行测试/证据体系。
- 旧 committed hierarchy 是真实可读缓存。migration 或首次 CAS 不得把它清空；无法验证旧 read-set 时应标 stale 并通过 rebuild 收敛。

### Git Intelligence

- 基线提交：`6d0c84c02b68b1f6fd6859e4f7e290ffad7693dc`（`docs: complete story 1.4 review closure`）。
- 最近提交 `76fe163`、`4c071ce`、`2515a0a`、`42f31e2` 都围绕 Story 1.4 的恢复不变量、review findings 与 provider evidence；实现风格是“小步修复 + 全门禁 + 同 SHA provider 闭环”，本 Story沿用该证据纪律。
- 当前工作树已有与本 Story无关的未跟踪临时目录和 `想法.md`；不得删除、移动、纳入 Story 文件列表或用 destructive Git 命令处理。

### Project Structure Notes

- 建议新增 `packages/domain/src/graph-patch.ts`、`packages/application/src/indexing/hierarchy-fact-batch.ts`、`packages/application/src/indexing/graph-patch-builder.ts`、`packages/application/src/ports/canonical-digest-port.ts`、`apps/graph-service/src/index-read-set.ts` 与 `packages/adapters/store-sqlite/src/migrations/002-deterministic-commit.ts`（或职责等价、命名清晰的文件）；不要建立无责任边界的 `utils`、`common` 或 `helpers` 包。
- 若 FactBatch/GraphPatch 类型仅服务 application/store 端口，保持内部类型，不要无理由发布到跨进程 `packages/contracts`；只有公共 Job/Status/Schema 进入 contracts。
- 新测试优先扩展 `tests/unit/workspace-scanner.test.ts`、`index-job-runtime.test.ts`、`sqlite-graph-store.test.ts` 与现有 capability 测试；仅在真实新职责出现时新建测试文件。
- 公共能力语义变化必须为每个实际 diff 建立 Story 1.19 专属 verifier/test/fixture/gate；非公共的原子提交六项证明再使用独立、真实执行的 blocking gate，二者不得互相冒充。
- 文档和 Story 内路径使用仓库相对路径；生成数据仍只位于用户缓存，不写入 workspace。

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story-119完成确定性-rebuild-与原子提交`]
- [Source: `_bmad-output/planning-artifacts/epics.md#StoryDependencyDagV1权威`]
- [Source: `_bmad-output/planning-artifacts/epics.md#架构与实施附加要求`]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-1初始化工作区图谱`]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-5图谱版本稳定-ID-与过期状态`]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-22图谱状态与故障恢复`]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#52-可靠性`]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#55-可演进性`]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md#4-排除语义`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-3图谱只通过原子-GraphPatch-变更`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-4确定性实体-ID-与证据分层`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-6生成数据属于用户缓存策略属于仓库`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-8所有长操作使用可恢复-Job`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#4-核心端口草图`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#6-图谱更新实现`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#7-SQLite-起始模型`]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#13-验证与门禁`]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md#State-Patterns`]
- [Source: `_bmad-output/implementation-artifacts/1-4-安全初始化首次图谱与最小存储.md#Dev-Notes`]
- [Source: `docs/protocol/service-control-v1.md#握手与状态`]
- [Source: `docs/repository-layout.md#本地服务控制面`]
- [Source: `scripts/contracts/validate-public-capability-gates.mjs#验证变化能力的-gate测试fixture入口与-evidence-是否形成唯一且同-PR-更新的闭环`]
- [Source: `project-context.md#项目级编码约束`]

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Implementation Plan

- 按 FactBatch/GraphPatch → scanner/read-set → SQLite CAS/commit → runtime/status → 公共合同/Gate 的依赖顺序收敛唯一写入主干。
- 保持 Story 1.4 的 `cg://` 身份、BuiltinIgnoreV1、共享 runtime 与八表边界，只实现 Story 1.19 明确要求的 revision、ownership、CAS 和重排。
- 完成定向验证后运行全部根级质量命令与 23 项 blocking gate，再更新 Story/Sprint 状态。

### Debug Log References

- 2026-07-26 核心实现：新增 domain/application FactBatch、GraphPatch、digest port 与完整 read-set；scanner 使用打开句柄读取原始字节并执行 10 MiB、realpath、文件身份与读取前后元数据校验。
- 2026-07-26 存储实现：新增 SQLite migration v2，保留 v1 已提交图并初始化 revision 1/stale；唯一同步事务完成 base/read-set CAS、node/edge/ownership、摘要、digest、revision 与 Job 绑定，24 个 SQLite 用例通过。
- 2026-07-26 runtime 实现：同一 logical Job 最多三次 stale 重排，第四次以 `GRAPH_INPUT_CHANGED_DURING_BUILD` 结束；partial/failed/cancelled 保持旧 revision 与完整 ownership，11 个 runtime 用例通过。
- 2026-07-26 公共能力：7 个实际变化能力全部绑定 Story 1.19 专属 verifier/test/fixture/gate；使用独立 `GIT_INDEX_FILE` 生成隔离候选 `224024e3b13adc13d46ddc3bed6fbd08a5ca4341`，相对基线执行 base/head 校验得到 `violations=[]`，未污染正式索引且未纳入 Story 外临时目录或个人文档。
- 2026-07-26 循环审查：Blind Hunter、Edge Case Hunter、Acceptance Auditor 多轮并行审查；每轮发现立即修复并补回归，最终三层均返回 `[]`。主要收敛 legacy migration provenance、最终 mutation capability、`throw undefined` 回滚、startup 稳定预算、watcher fatal 同步、rename 内容消歧与 shutdown 取消竞态。
- 2026-07-26 收尾终审：补充拒绝 `initial-index` 成功结果指向 revision 2+ 的严格/兼容合同回归，并同步 Provider 证据的本地完成结论；修复后再次进入三层终审循环。
- 2026-07-26 相邻状态终审：补充 available graph 与 failed/partial/cancelled `initial-index` 不得并存的三类负向合同回归；修复后继续执行完整门禁与三层终审。
- 2026-07-26 完整度终审：补充 terminal `partial` 与顶层 completeness 的一致性负向合同回归，拒绝运行时和持久化不可能产生的状态组合；修复后继续执行完整门禁与三层终审。
- 2026-07-26 反向完整度终审：补充 `completeness=partial` 缺失 terminal 证据或与 succeeded Job 并存的负向合同回归，仅允许 partial/failed/cancelled 维持降级状态；修复后继续执行完整门禁与三层终审。
- 2026-07-26 门禁复验：首次 `architecture-required` 的并行 `contract` 子进程出现瞬时失败；立即独立完整 `pnpm contract` 21 文件/181 用例通过，随后原命令完整重跑 23/23 通过，未通过隐藏或跳过用例处理。
- 2026-07-26 最终全量验证：`type`、`lint`、`build`、`dependency-boundary`、`basic-security`、`planning-trace`、`git diff --check` 均通过；unit 54 文件/380 用例、contract 21 文件/181 用例通过；确定性 rebuild 专项 7 文件/121 用例及真实进程合同 1 文件/5 用例通过；`architecture-required` 23/23 通过。
- 2026-07-26 Provider 记录：`gateRegistryDigest=d584077454968a04d37fc7357fb278990b5fc34f1692f1628db7b80812ea2893`；本任务未创建/推送正式提交，因此 Hosted run 未触发且未被伪报，本地 provider-ready 证据见 `docs/ci/story-1-19-provider-evidence.md`。

### Completion Notes List

- hierarchy batch ownership 固定为 `hierarchy:<indexingRootId>`，GraphPatch 目标语义 digest 不含 Job、时间、generation 或 base revision；相同目标状态、no-op 与 replay 不推进 graphRevision。
- read-set 精确包含排序 manifest/逐文件 SHA-256、完整 ignore snapshot、bootstrap generation、status epoch 与 base revision；input/config digest 与并发栅栏保持分离。
- `GraphStorePort` 已移除生产 `commitHierarchy()`，唯一 `commitAtomicGraphUpdate()` 提供单事务 CAS 与原子 revision；WAL 第二读者、fault injection、migration、busy timeout 与恢复不变量均有真实测试。
- 公共状态增加 graph/base/result revision、`current|stale|null` freshness、partial/cancelled；兼容入口确定性归一化 Story 1.2/1.4 旧 `fresh` 与缺失 revision。
- 最终 fence capability 仅允许同步单次 mutation，异常、后置 read-set 失效、回调逃逸及 `throw undefined` 均整体回滚；启动与运行期 watcher/rename 竞态统一 fail closed 且有界收敛。
- 新增 `deterministic-rebuild-atomic-v1` 及 7 个公共能力 blocking gate；原子 Gate 固定运行 7 个单元测试文件/121 用例与 1 个真实进程合同文件/5 用例，完整 registry 23/23 通过。
- 保持后续边界：未实现 Analyzer/BasicSymbol、完整 `.codegraphignore` grammar、通用 Evidence/tombstone、公共 `job/cancel`、查询、CLI/UI、Findings、impact、export、缓存恢复或遥测。

### File List

- `_bmad-output/implementation-artifacts/1-19-完成确定性-rebuild-与原子提交.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/graph-service/src/ignore-bootstrap.ts`
- `apps/graph-service/src/index-job-runtime.ts`
- `apps/graph-service/src/index-read-set.ts`
- `apps/graph-service/src/index.ts`
- `apps/graph-service/src/service-state.ts`
- `apps/graph-service/src/workspace-scanner.ts`
- `ci/public-capability-gates.v1.json`
- `ci/quality-gates.v1.yaml`
- `docs/ci/story-1-19-provider-evidence.md`
- `docs/protocol/service-control-v1.md`
- `docs/repository-layout.md`
- `packages/adapters/store-sqlite/src/index.ts`
- `packages/adapters/store-sqlite/src/migrations/002-deterministic-commit.ts`
- `packages/adapters/store-sqlite/src/sqlite-graph-store.ts`
- `packages/application/src/indexing/graph-patch-builder.ts`
- `packages/application/src/indexing/hierarchy-fact-batch.ts`
- `packages/application/src/indexing/hierarchy-builder.ts`
- `packages/application/src/index.ts`
- `packages/application/src/ports/canonical-digest-port.ts`
- `packages/application/src/ports/graph-store-port.ts`
- `packages/contracts/src/index-job-schema.ts`
- `packages/contracts/src/index-job.ts`
- `packages/contracts/src/protocol-error.ts`
- `packages/contracts/src/runtime-validation.ts`
- `packages/contracts/src/service-control-schema.ts`
- `packages/contracts/src/service-status.ts`
- `packages/domain/src/graph-patch.ts`
- `packages/domain/src/index.ts`
- `scripts/ci/verify-deterministic-rebuild-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-error-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-initialize-compatible-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-initialize-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-job-result-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-rpc-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-status-compatible-v1.mjs`
- `scripts/contracts/verify-deterministic-rebuild-status-v1.mjs`
- `tests/contract/graph-bootstrap-contract.test.ts`
- `tests/contract/graph-service-control.test.ts`
- `tests/contract/graph-service-process.test.ts`
- `tests/contract/quality-gates-manifest.test.ts`
- `tests/contract/service-client-control.test.ts`
- `tests/contract/service-control-contract.test.ts`
- `tests/fixtures/deterministic-rebuild-error-v1.json`
- `tests/fixtures/deterministic-rebuild-initialize-compatible-v1.json`
- `tests/fixtures/deterministic-rebuild-initialize-v1.json`
- `tests/fixtures/deterministic-rebuild-job-result-v1.json`
- `tests/fixtures/deterministic-rebuild-rpc-v1.json`
- `tests/fixtures/deterministic-rebuild-status-compatible-v1.json`
- `tests/fixtures/deterministic-rebuild-status-v1.json`
- `tests/unit/connect-first-discovery.test.ts`
- `tests/unit/deterministic-graph-patch.test.ts`
- `tests/unit/deterministic-rebuild-error-v1-capability.test.ts`
- `tests/unit/deterministic-rebuild-initialize-compatible-v1-capability.test.ts`
- `tests/unit/deterministic-rebuild-initialize-v1-capability.test.ts`
- `tests/unit/deterministic-rebuild-job-result-v1-capability.test.ts`
- `tests/unit/deterministic-rebuild-rpc-v1-capability.test.ts`
- `tests/unit/deterministic-rebuild-status-compatible-v1-capability.test.ts`
- `tests/unit/deterministic-rebuild-status-v1-capability.test.ts`
- `tests/unit/gate-applicability.test.ts`
- `tests/unit/ignore-bootstrap.test.ts`
- `tests/unit/index-job-runtime.test.ts`
- `tests/unit/index-job-state.test.ts`
- `tests/unit/index-read-set.test.ts`
- `tests/unit/process-deadline.test.ts`
- `tests/unit/public-capability-gate.test.ts`
- `tests/unit/service-connection-timeout.test.ts`
- `tests/unit/service-state.test.ts`
- `tests/unit/sqlite-graph-store.test.ts`
- `tests/unit/workspace-scanner.test.ts`

### Change Log

- 2026-07-26：完成 Story 1.19 确定性 rebuild、完整 read-set CAS、ownership replacement、原子 graphRevision、状态合同与专属 blocking gate，全部本地质量门禁通过，状态推进至 `review`。
- 2026-07-26：完成多轮三层对抗式代码审查并修复全部发现；最终 Blind Hunter、Edge Case Hunter、Acceptance Auditor 均为零发现，完整门禁复验通过，状态推进至 `done`。
