---
baseline_commit: f22624df284d8378d2bd4d57fc54df1b18ccb2c0
---

# Story 1.6：提取 BasicSymbolV1 并提供稳定导航范围

Status: done

<!-- 本 Story 只负责 BasicSymbolV1 事实合同与 source slice 接入；导航 UI、查询 surface 和完整 Evidence 生命周期由后续 Story 负责。 -->

## Story

As a 需要理解文件入口的开发者，
I want 图谱提取顶层可寻址符号及稳定源码范围，
so that 后续查询、导航和结构导出可以精确指向受支持声明。

**直接依赖：** Story 1.5（唯一直接前置；依赖权威为 `StoryDependencyDagV1`，不是 Story 编号邻接或正文顺序）。

**关联需求：** FR-2、FR-5、FR-9、NFR-22、AR-6、AR-7。

## Acceptance Criteria

1. **Given** 源文件包含顶层命名声明
   **When** 生成 `BasicSymbolV1`
   **Then** 只收录 `function`、`class`、`interface`、`type-alias`、`enum`、`variable` 和 `namespace`
   **And** 每项携带稳定 `symbolId`、`kind`、`name`、`relativePath`、`SourceRangeV1` 和 `exported`
   **And** `SourceRangeV1` 使用 0-based UTF-16 code-unit 行列与半开区间 `[start,end)`。

2. **Given** 同一文件存在多声明绑定
   **When** 选择导航范围
   **Then** 优先使用实现声明，否则按 `range.start` 选择第一项
   **And** 输入文件、AST 声明或 Worker 返回的枚举顺序不影响 `symbolId` 或导航位置。

3. **Given** `interface` 或 `namespace` 在多个文件声明
   **When** 建立 ownership
   **Then** 每个声明文件生成独立 `BasicSymbolV1`
   **And** 不创建跨文件共享 owner
   **And** 删除文件只影响对应 `source:<analyzerKind>:<fileId>` slice。

4. **Given** 声明属于成员、参数、局部变量、import alias、匿名声明、调用或 references
   **When** Analyzer 处理
   **Then** 该对象不进入 `BasicSymbolV1`
   **And** 不进入符号导航、结构导出或成功指标。

5. **Given** 相同源码和配置重复分析
   **When** 比较 `BasicSymbolV1`
   **Then** ID、kind、名称、路径、范围和 exported 状态保持确定
   **And** `NavigationTargetV1` 可以直接消费该合同
   **And** 本 Story 不增加默认 `GraphViewNodeKind`，不生成调用图或 `references`。

## Tasks / Subtasks

- [x] Task 1：先建立 RED 测试和范围护栏（AC: 1–5）
  - [x] 为 TS/TSX/JS/JSX 的每一种受支持顶层声明建立最小 fixture，覆盖直接 `export`、`export default`、`export { local as alias }`、非导出声明和同名多声明。
  - [x] 覆盖实现声明优先、同文件 declaration merge、跨文件 interface/namespace split、文件删除、输入重排、非 BMP 字符和 CRLF/多行源码的 UTF-16 行列范围。
  - [x] 明确负样本：成员、参数、局部变量、import alias、匿名 default、调用、references、字符串字面量 module declaration、未支持声明不得泄漏为 symbol。
  - [x] 先验证 Story 1.5 的 `LocalExportBindingSeedV1` 仍是内部交接事实；失败测试必须阻止 placeholder symbol、file→file 假 exports 或第二条写入主干。

- [x] Task 2：定义稳定 BasicSymbolV1 与导航范围合同（AC: 1, 2, 5）
  - [x] 在 `packages/domain` 定义封闭 `BasicSymbolKind` 与 `BasicSymbolV1`，字段固定为 `symbolId`、`kind`、`name`、`relativePath`、`range`、`exported`。
  - [x] 按 AD-4 使用工作区作用域 file ID、语言、kind、qualified name 和签名摘要构造确定性 symbol ID；不得把 range、exported、检测时间、Worker 枚举顺序或宿主绝对路径放入身份。
  - [x] 同一 `SourceFile` 内按 TypeScript 语义绑定同名 declaration；实现声明优先，否则按规范化 `range.start` 取最早声明。跨文件合并不得共享 symbol ID 或 owner。
  - [x] 为 `qualified name` 与签名摘要定义可审计的 canonical preimage：只使用规范化声明语义，不包含 range、注释/空白、`exported`、检测时间、宿主绝对路径或输入枚举顺序；无法稳定归并为单一受支持 `kind` 的混合声明必须拒绝或排除并保留诊断，不得猜测。
  - [x] 将架构要求的公共 `SourceRangeV1`（`{start:{line,character},end:{line,character}}`）与 Story 1.5 现有的数字 offset `normalizedRange` 分离；禁止直接把 SQLite `range_start/range_end` 当导航行列。建议把内部 offset 类型显式重命名为 `Utf16OffsetRangeV1`，保留已有 Evidence 身份语义并在边界一次转换。
  - [x] 所有 range 计算使用 TypeScript SourceFile 的 UTF-16 code unit 语义；不得按 Unicode code point、字节或宿主换行实现。范围必须半开、非负且 start 不晚于 end。

- [x] Task 3：在 TS6 Worker 中提取顶层声明（AC: 1, 2, 4）
  - [x] 复用 Story 1.5 已建立的 TypeScript 6.0.3 稳定公开 Compiler API、持久 Worker、受控源码快照和增量 `Program/SourceFile`；不引入 Tree-sitter、LSP、SCIP、tsserver 私有状态、plugin、transformer 或项目 scripts。
  - [x] 只遍历 `SourceFile` 直接子节点，或通过等价的公开 AST 语义保证“顶层”边界；不得递归把成员/局部声明当作顶层 symbol。
  - [x] `variable` 只接纳具有稳定单一名称的顶层绑定；对于无法形成单一稳定名称的匿名/复杂 binding pattern，保持 V1 排除并以测试锁定，不能生成猜测名称。
  - [x] `name` 使用规范化声明名称；匿名 `default` function/class、无名 module declaration 和无法稳定寻址的声明不得生成 symbol 或占位边。
  - [x] `exported` 由声明修饰符与 Story 1.5 的本地导出 seed 统一归并；同一 symbol 被多个 export alias 导出时只生成一个 symbol，并为每个可解析 alias 生成独立的 exports 关系。
  - [x] Worker 输出在返回 host 前执行封闭对象、范围、语言、kind、路径和 sourceFileId 交叉校验；host 重新推导 file-scoped symbol identity，不能信任 Worker 传入的绝对路径或任意 symbol ID。

- [x] Task 4：把 symbol 与 local export 接入 source FactBatch/GraphPatch（AC: 1–3, 5）
  - [x] 扩展 `ModuleSourceFactBatchV1` 或职责等价的封闭交接合同，使一个 source slice 同时表达该文件的 BasicSymbol、可解析 local export seed 和既有 module Evidence；输入排序不影响 batch digest。
  - [x] symbol 节点/事实由 `source:<analyzerKind>:<fileId>` 唯一拥有；同一文件 complete replacement 可删除该 slice 消失的 symbol 与其 source-derived exports 事实，partial/failed 不按缺失删除。
  - [x] 将 local named/default export 从 seed 提升为 file→symbol 的 `exports` 规范边，使用现有 AD-24 qualifier 序列化和统一 graph-edge ID；别名、type/value、default 必须可逆且不碰撞。无法解析到受支持 BasicSymbol 的 seed 不得生成 placeholder symbol、file→file 假边或伪成功事实。
  - [x] 继续通过唯一 `GraphStorePort.commitAtomicGraphUpdate()` 和 Story 1.19 的 snapshot mutation channel 一次提交 hierarchy、module、symbol、exports；禁止 Analyzer 直写 SQLite、每个 symbol 单独推进 revision 或新增 writer。
  - [x] `detectedAt` 仍是观察元数据，不进入 symbol/edge ID、targetGraphDigest、patchDigest 或 no-op 判定；相同源码重放不得仅因时间变化推进 graphRevision。

- [x] Task 5：扩展持久模型但保持渲染器无关（AC: 3, 5）
  - [x] 优先复用现有 `nodes` + `facts_ownership` + `GraphSliceMutationV1` 表达 symbol；若 SQLite CHECK/恢复合同需要扩展，只新增版本化 migration，不回改历史 migration，不创建与 nodes 并行的旁路 symbol store。
  - [x] symbol 是可被 NavigationTarget/导出消费的领域事实，但不是默认图形节点类型；`GraphViewNodeKind` 仍只允许 file、directory、workspace-package、external-package。
  - [x] 恢复、拓扑、ownership 和事务校验必须同时验证 symbol 节点、exports 边及 source slice；旧 hierarchy/module 图谱在迁移后 ID、revision、contains/imports/exports 语义保持不变。
  - [x] 若公共 contracts/schema 因 symbol 或 NavigationTarget 首次发布而改变，先执行公共能力 base/head diff，再在同一变更中登记真实 blocking gate；不得凭文件变动猜测公共能力，也不得使用空测试或永久 skip。

- [x] Task 6：测试与阻断门禁（AC: 1–5）
  - [x] Unit/Golden：七种 kind、TSX/JSX、声明修饰符、默认导出、别名导出、同文件 merge、跨文件 split、实现优先、range 与 exported 的确定性。
  - [x] Contract：BasicSymbolV1 封闭字段、SourceRangeV1 UTF-16 行列/半开区间、NavigationTargetV1 symbol 分支、symbol ID canonical preimage、exports qualifier 与未知字段行为。
  - [x] Property：源码/声明/文件输入排列、区域设置、重复 rebuild、换行和 emoji 变化；验证 ID/range 不受枚举顺序影响，语义变化才改变签名摘要/ID。
  - [x] Replacement/SQLite：文件删除或 complete source replacement 只移除对应 symbol slice；partial/failed 保留旧事实；事务 fault injection、重启恢复、旧 migration reopen、未来 schema fail-closed 均不得破坏既有 hierarchy/module 事实。
  - [x] Boundary/negative：成员、参数、局部变量、import alias、匿名声明、references、调用、复杂 binding pattern、跨文件共享 owner、绝对路径和 Worker 伪造 symbol ID 均被拒绝或排除。
  - [x] 真实构建产物 Worker 回归必须覆盖 TS6 公开 API、取消、异常收敛和单一 graph-service writer；不得只在 tsx/Vitest mock 环境验证。

## Dev Notes

### 权威合同与实现护栏

- `BasicSymbolV1` 是 Story 1.6 专属事实切片。权威范围来自 `AD-27`：仅限 TypeScript `SourceFile` 顶层、具有稳定名称与可导航名称范围的 function/class/interface/type-alias/enum/variable/namespace；成员、参数、局部变量、import alias、匿名声明、调用图和 references 全部排除。
- `SourceRangeV1` 的公共形状来自 Architecture Spine 的 Source ranges 一致性约定、AD-7，以及 Implementation Guide §8/§9：0-based UTF-16 code-unit 行列、`[start,end)` 半开区间。现有 module Evidence 的数字 offset `normalizedRange` 是 Story 1.5 内部证据定位，不得被误当成导航合同。
- symbol ID 必须遵循 AD-4 的确定性输入原则：工作区作用域 file ID、语言、kind、qualified name、签名摘要；ID 不依赖绝对路径、range、exported、检测时间或输入枚举顺序。路径统一 Unicode NFC、工作区相对 POSIX。
- source ownership 继续遵循 AD-3：`source:<analyzerKind>:<fileId>`。同文件多声明只在该文件内合并；跨文件 declaration merge 必须分开拥有。Analyzer 只返回 FactBatch，application 负责规范化和 GraphPatch，GraphStore 仍是唯一提交入口。
- BasicSymbol 可以被 `NavigationTargetV1`、symbol-centered 查询和结构导出消费，但本 Story 不实现查询 RPC、VS Code NodeDetails、Webview 图/列表、CLI surface 或文件打开动作；这些消费者必须后续复用本 Story 的合同而不能自行换算 range。
- local export 最终边是本 Story 的必要接续：Story 1.5 只交付 `LocalExportBindingSeedV1`，本 Story 将可解析 seed 提升为 file→symbol `exports` 边；不可解析 seed 不得伪造 file→file、placeholder symbol 或成功指标。

### 与相邻 Story 的边界

| 相邻能力 | Story 1.6 负责 | 明确不负责 |
| --- | --- | --- |
| Story 1.5 | 消费既有 TS6 Worker、source FactBatch、`LocalExportBindingSeedV1`、CompositeGraphPatch、完整 read-set/CAS 和唯一 mutation channel；补齐 symbol 与 local export 终点 | 重写模块 resolver、workspacePackages、已有 imports/re-exports 语义或第二套 Analyzer/GraphStore 主干 |
| Story 1.7 | 为 symbol/source-derived exports 使用现有 ownership/GraphPatch 形态，保证 complete replacement 的本 slice 行为 | 全量 Evidence 冲突仲裁、last-active 回收、partial tombstone、跨来源 ownership 与通用删除生命周期 |
| Story 1.9 | 保持 symbols 与普通 TS/JS 文件分析独立于 workspace discovery | npm/Yarn/pnpm 边界、workspace-package 节点、跨包聚合和 degraded summary |
| Epic 2/Story 2.7 | 输出可供导航消费的稳定 symbol target 合同 | VS Code/CLI 查询、NodeDetails、源码打开、图形渲染和会话状态 |
| Story 1.8 | 为后续准确率验证保留可标注的 symbol/依赖事实 | ≥500 标注 corpus、micro-F1/high-confidence precision 门禁和失败样本发布 |

### Current Repository State and Required Updates

| 路径 | 当前状态 | 本 Story 预期变化 | 必须保持 |
| --- | --- | --- | --- |
| `packages/domain/src/module-dependency.ts` | 有 module target/edge/Evidence、数字 offset `SourceRangeV1`、`LocalExportBindingSeedV1` | 分离内部 offset range 与公共导航 range；增加 BasicSymbol、symbol node/事实及 local/default export qualifier | AD-4/AD-21 ID、已有 imports/re-exports、旧 Evidence range 语义和中文 JSDoc 不回退 |
| `packages/domain/src/graph-identity.ts` | 统一 file/module edge ID | 支持 symbol ID 与 local/default exports 的 canonical preimage | 既有 hierarchy/contains/imports/exports ID 不漂移；拒绝绝对路径、lone surrogate 和未规范文本 |
| `packages/domain/src/graph-patch.ts` | Composite patch 的 node/edge/evidence/slice 模型 | 允许 source slice 携带 symbol 节点及其 source-derived exports 事实 | 单 revision、单 writer、完整 CAS、no-op 不推进 revision |
| `packages/application/src/ports/analyzer-port.ts` | Worker payload 含 module relations 与 local export seeds | 增加封闭 BasicSymbol payload/校验类型 | application 不导入 TypeScript、fs、Worker 或 SQLite |
| `packages/application/src/indexing/module-fact-batch.ts` | 规范化 module relations/Evidence | 规范化 symbol、导出边、排序、冲突拒绝和 source ownership | `detectedAt` 不影响语义比较；不复制 source commit 逻辑 |
| `packages/application/src/indexing/composite-graph-patch-builder.ts` | source slice 当前只 replacement Evidence，shared module node/edge 单独维护 | 将 symbol/source-derived exports 纳入同一 atomic patch，并精确处理 complete/partial/failed | 不越权实现 Story 1.7 的通用回收与跨来源仲裁 |
| `packages/adapters/analyzer-typescript/src/module-syntax.ts` | 提取模块关系和 `LocalExportBindingSeedV1` | 增加仅顶层的 BasicSymbol AST 提取或职责等价模块 | 只用 TS 6.0.3 公开 API；不递归成员/局部声明，不读 tsserver |
| `packages/adapters/analyzer-typescript/src/worker-analysis.ts` / `typescript-analyzer.ts` | 持久 Worker、Program/SourceFile 缓存、payload 深度校验 | 传递并校验 symbols/range/exported/sourceFileId | host 重算身份；不信任 Worker 绝对路径或 symbol ID；保留资源预算 |
| `packages/adapters/store-sqlite/src/sqlite-graph-store.ts`、`src/migrations/*` | nodes/edges/evidence/ownership 的原子写入与恢复 | 扩展 symbol kind/载荷及 source ownership；必要时新增版本化 migration | 不回改 001–004；WAL、foreign keys、故障副本、未来 schema fail-closed |
| `tests/unit/*symbol*`、`tests/unit/typescript-module-syntax.test.ts`、`tests/unit/module-fact-batch.test.ts` | 已有 module/seed/edge/range 回归 | 增加 symbol、range、merge、export promotion、replacement/property 覆盖 | 先 RED 后 GREEN；无 skip/only/空断言 |
| `tests/contract/*`、`scripts/ci/verify-typescript-module-analysis-v1.mjs` | Story 1.5 module analysis blocking gate | 扩展真实 symbol contract/gate evidence；仅在公共 surface 真实变化时更新 gate registry | 真实 Worker、SQLite、GraphPatch、planning trace 和 clean-build 证据 |
| `docs/protocol/graph-edge-identity-v1.md`、`docs/repository-layout.md` | 记录 edge 身份和模块边界 | 若 local/default exports 或 symbol node 成为公共合同，补充相对路径协议说明 | 只记录真实协议变化，不扩张到 UI/CLI 未实现能力 |

### 技术/库约束

- Node.js 24.18.0、TypeScript 6.0.3、pnpm 11.12.0、Vitest 4.1.10；TS 分析只能使用锁定版本的稳定公开 Compiler API。
- 复用现有 JCS → UTF-8 → SHA-256 canonical digest helper；禁止 `localeCompare`、宿主绝对路径、SQLite rowid、时间戳或数组输入顺序进入 symbol identity。
- 复用现有 `GraphStorePort.commitAtomicGraphUpdate()`、CompositeGraphPatch、WAL/foreign key/同步事务和 bounded Worker；禁止新增通用 `utils` 包、第二解析器、第二 writer 或运行时下载。
- 代码注释、JSDoc、测试说明和新增文档使用中文；复杂 AST 归并、range 换算、ID preimage 和安全拒绝路径必须写出说明关键约束的 JSDoc。

### 测试要求与完成证据

- 最小验证必须同时证明：符号提取边界、UTF-16 range、确定性 ID、同/跨文件 ownership、local export promotion、complete replacement、GraphPatch 单事务和既有 Story 1.5 imports/re-exports 回归。
- 运行真实构建产物 Worker 与 SQLite 迁移/重启测试；不能只运行单元 mock，也不能用固定成功脚本替代门禁。
- 若新增 `symbols`/`NavigationTargetV1` 公共 schema 或 RPC，必须在同一变更中登记真实 blocking gate、schema contract、未知字段行为和 planning trace；若只增加内部事实，则不得借机扩张公共能力清单。
- 任何无法在本 Story 验证的 UI/性能/准确率能力，交付说明须明确留给对应 Story，不得把“有 BasicSymbol 数据”表述为“导航 UI 已完成”。

### References

- [Source: `_bmad-output/planning-artifacts/epics.md`#Story 1.6：提取 BasicSymbolV1 并提供稳定导航范围]
- [Source: `_bmad-output/planning-artifacts/epics.md`#StoryDependencyDagV1（权威）]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`#AD-3、AD-4、AD-5、AD-7、AD-27]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md`#§2 模块职责、§6 图谱更新实现、§8 TypeScript 分析器、§9 查询与 GraphViewModel、§13 验证与门禁]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md`#FR-2、FR-9、NFR-21、NFR-22、SM-4]
- [Source: `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md`#5.4 分析范围与正确性合同]
- [Source: `_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md`#Trust, Provenance & Performance、UJ-1/UJ-2 失败路径]
- [Source: `_bmad-output/implementation-artifacts/1-5-提取模块依赖并解析目标.md`#Scope Boundaries、Current Repository State and Required Updates、Direct Dependency Intelligence]
- [Source: `project-context.md`#项目级编码约束]

### Validation Result

- 已按 `bmad-create-story` validate 清单复核 AC、Tasks、StoryDependencyDagV1 直接依赖、Story 1.5 交接、架构/PRD/UX 约束、预期文件范围与测试门禁；未发现阻塞性缺口。
- 已补充 symbol ID canonical preimage、签名摘要和混合 kind 归并的 fail-closed 护栏，并明确本 Story 不实现导航 UI、查询 RPC、CLI 或完整 Evidence 生命周期。

## Dev Agent Record

### Agent Model Used

Codex / BMad dev-story

### Implementation Plan

- 以 RED fixture 先锁定七种顶层声明、UTF-16 导航范围、声明归并和负样本边界。
- 在 domain 定义 BasicSymbol/NavigationTarget/SourceRange 合同，由 application host 重算 file-scoped ID 并提升 local/default exports。
- 将 symbol/source-derived exports 纳入既有 CompositeGraphPatch 与唯一 SQLite writer，实现 complete/partial/failed 三态 source slice。
- 以 SQLite v5 版本化 migration 扩展既有八表模型，再扩展真实 Worker/SQLite blocking gate 证据。

### Debug Log References

- RED：`tests/unit/basic-symbol.test.ts` 初始 4/4 按预期失败，确认测试可阻断未实现合同。
- GREEN：聚焦 BasicSymbol/GraphPatch/Worker/SQLite 回归 147/147，聚焦合同 45/45。
- Review RED/GREEN：新增 failed source batch 携带 relation 的回归先失败；修复后 `tests/unit/composite-graph-patch.test.ts` 与 `tests/unit/basic-symbol.test.ts` 共 19/19 通过。
- Blocking gate：`typescript-module-analysis-v1` 通过 default 292/292、SQLite 60/60、contract 10/10；同步了独立登记的 unit 计数与 composite suite 计数。
- Full regression：`pnpm unit` 736/736，`pnpm contract` 265/265；`pnpm type`、`pnpm lint`、`pnpm build`、`pnpm dependency-boundary` 均通过。
- Architecture required：聚合门禁中 TypeScript module analysis 已通过；host-path Win32 gate 受未提交工作树与 HEAD 精确 blob 闭合约束阻断，POSIX helper gate 因本机未安装 Cargo 阻断，故本 Story 维持 `in-progress` 等待交付/具备 Rust 环境后的最终门禁。
- Host-path close：本进程临时加入 `C:\Users\shiqw\.cargo\bin` 后，`host-path-posix-helper-v1` 通过（Cargo metadata、类型检查、47 项 unit、46 项 contract、10 项 platform）；同步修正 quality-gate attestation fixture 至实际 292/60/10。Win32 exact-blob gate 在未提交工作树按设计返回 DELIVERY 后验证，非实现失败。

### Completion Notes List

- 完成 AD-27 七种顶层 `BasicSymbolV1` 提取，同文件归并、实现声明优先与混合 kind fail-closed 诊断已落地。
- 新增 0-based UTF-16 行列半开 `SourceRangeV1`、`NavigationTargetV1` symbol 分支与稳定 symbol ID canonical preimage；函数体、range、exported、时间和枚举顺序不进入 ID。
- Worker host 现对输出/file/symbol/range 执行封闭校验，拒绝未知字段、越界行列、错误语言/sourceFileId 和伪造 symbol ID。
- local/default export seed 已提升为 file→symbol AD-4 exports 边；不可解析 seed 不创建 placeholder 或 file→file 假边。
- CompositeGraphPatch 在同一 source slice 管理 symbol、local export 与 Evidence；complete 精确替换，partial 只覆盖已交付事实，failed 完全保留旧事实，仍只通过一次原子提交推进 revision。
- SQLite v5 保持精确八表，以 `nodes.payload_json` + `facts_ownership` 持久 symbol/source export；已验证 v4→v5、重启、故障回滚、未来 schema fail-closed 与全局拓扑不变式。
- 扩展既有真实 TypeScript module analysis blocking gate，不新增未发布的公共 RPC/schema 能力。
- 修复 failed coverage 不再接纳新的共享 module node/edge；仅保留已提交的 incomplete source facts，防止失败分析推进图谱 revision。
- 同步 `typescript-module-analysis-v1` 的独立 attestation 至实际 292 条 default-unit 测试，并完成全量 unit/contract 与类型、lint、构建、依赖边界验证。
- 边界保持：未实现 Story 1.7 通用 Evidence 仲裁/回收，未实现 Story 1.9 workspace package discovery，未实现导航 UI、查询 RPC、调用图或 references。
- 最终 architecture-required 仍需在交付提交后、且具备 Cargo 的环境中复跑 host-path 两个 gate；本工作流未创建提交或安装依赖。
- Host-path DS 已关闭 POSIX 本地验证；Win32 gate 只可在交付提交使工作树、候选 Git blob 与固定摘要闭合后验证。本次未提交，Story 与 sprint 保持 `in-progress`。

### File List

- `_bmad-output/implementation-artifacts/1-6-提取-basicsymbolv1-并提供稳定导航范围.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/graph-service/src/index-job-runtime.ts`
- `docs/protocol/graph-edge-identity-v1.md`
- `docs/repository-layout.md`
- `packages/adapters/analyzer-typescript/src/module-syntax.ts`
- `packages/adapters/analyzer-typescript/src/module-target-resolver.ts`
- `packages/adapters/analyzer-typescript/src/typescript-analyzer.ts`
- `packages/adapters/analyzer-typescript/src/worker-analysis.ts`
- `packages/adapters/store-sqlite/src/index.ts`
- `packages/adapters/store-sqlite/src/migrations/003-module-dependencies.ts`
- `packages/adapters/store-sqlite/src/migrations/004-ad4-edge-identity.ts`
- `packages/adapters/store-sqlite/src/migrations/005-basic-symbols.ts`
- `packages/adapters/store-sqlite/src/sqlite-graph-store.ts`
- `packages/application/src/indexing/composite-graph-patch-builder.ts`
- `packages/application/src/indexing/module-fact-batch.ts`
- `packages/application/src/ports/analyzer-port.ts`
- `packages/domain/src/graph-identity.ts`
- `packages/domain/src/graph-patch.ts`
- `packages/domain/src/module-dependency.ts`
- `scripts/ci/verify-host-path-identity-v1.mjs`
- `scripts/ci/verify-typescript-module-analysis-v1.mjs`
- `tests/contract/basic-symbol-contract.test.ts`
- `tests/contract/graph-edge-identity-protocol.test.ts`
- `tests/contract/quality-gates-manifest.test.ts`
- `tests/unit/basic-symbol.test.ts`
- `tests/unit/composite-graph-patch.test.ts`
- `tests/unit/index-job-runtime.test.ts`
- `tests/unit/module-dependency-domain.test.ts`
- `tests/unit/module-fact-batch.test.ts`
- `tests/unit/sqlite-graph-store.test.ts`
- `tests/unit/sqlite-module-dependencies.test.ts`
- `tests/unit/typescript-analyzer-worker.test.ts`
- `tests/unit/typescript-module-syntax.test.ts`

## Change Log

- 2026-08-17：完成 Story 1.6 BasicSymbolV1 领域合同、TS6 顶层声明提取、稳定导航范围、local/default export promotion、source slice 三态替换、SQLite v5 与真实阻断门禁；状态转为 `review`。
- `packages/domain/src/module-dependency.ts`
- `packages/domain/src/graph-identity.ts`
- `packages/domain/src/graph-patch.ts`
- `packages/application/src/ports/analyzer-port.ts`
- `packages/application/src/indexing/module-fact-batch.ts`
- `packages/application/src/indexing/composite-graph-patch-builder.ts`
- `packages/adapters/analyzer-typescript/src/module-syntax.ts`
- `packages/adapters/analyzer-typescript/src/worker-analysis.ts`
- `packages/adapters/analyzer-typescript/src/typescript-analyzer.ts`
- `packages/adapters/store-sqlite/src/sqlite-graph-store.ts` 与必要的新增版本化 migration
- `tests/unit/*symbol*`、既有 module/GraphPatch/SQLite 回归测试
- `tests/contract/*symbol*`、`scripts/ci/verify-typescript-module-analysis-v1.mjs`
- `docs/protocol/graph-edge-identity-v1.md`、`docs/repository-layout.md`（仅真实协议变化时）
- 2026-08-18：修复 failed source batch 泄漏新的共享 module facts；补齐真实 blocking gate 的 unit attestation（291→292）。全量 unit 736/736、contract 265/265、lint/type/build/dependency-boundary 通过；因未提交工作树的 exact-blob gate 与本机无 Cargo，Story 保持 `in-progress`。
- 2026-08-18：DS/close host-path 验证：使用已发现的 Cargo 1.88.0 通过 POSIX helper gate；修正 quality-gate attestation fixture 的实际 292/60/10 计数。Win32 exact-blob gate 按未提交工作树的 DELIVERY 后条件保留，未将其记为实现失败，状态保持 `in-progress`。

### Review Findings

- [x] [Review][Patch] failed source batch 仍会写入新的共享 module facts [packages/application/src/indexing/composite-graph-patch-builder.ts:117] — 已将 shared module node/edge 输入限制为非 failed 批次，并新增携带 relation 的 failed batch 回归；修复前测试可复现共享 imports 上写，修复后通过。

- [x] [Review][Done] 2026-08-18 final CR：复核 Story 1.6 owned diff、最新 failed source batch 修复及指定验证证据，未发现有效 patch finding；Win32 exact-blob gate 按脏工作树的 DELIVERY 后条件处理，不构成实现缺陷。
