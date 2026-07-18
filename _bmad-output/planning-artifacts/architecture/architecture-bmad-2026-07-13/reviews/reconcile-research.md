---
type: architecture-input-reconciliation
date: 2026-07-13
reviewed_artifact: ../ARCHITECTURE-SPINE.md
inputs:
  - ../../../research/project-code-graph-three-way-research-2026-07-08.md
  - ../../../research/project-code-graph-mvp-stack-upgrade-analysis-2026-07-09.md
verdict: conditional-pass
---

# 架构输入对账报告：Research → Architecture Spine

## 1. 结论

结论：**有条件通过（Conditional Pass）**。

现有架构脊柱已吸收两份研究中大多数承重建议：六边形模块化单体、本地薄客户端服务、GraphStore/Analyzer 端口、原子 GraphPatch、SQLite 与 Cytoscape 隔离、预算内 GraphViewModel、单工作区写入所有权、可恢复 Job、用户缓存与仓库策略分离、TS/JS 单一权威分析源等均有明确落点。研究列出的十项高迁移风险中，六项已明确封堵，两项大体封堵但契约仍不完整，一项仅部分封堵，一项尚未明确封堵。

在标记架构为 `final` 前，建议至少关闭三个承重缺口：

1. 将稳定 ID 从“URI 方向”提升为可由不同实现一致重建的规范算法。
2. 明确图谱数据 schema 的独立版本、迁移与兼容策略，避免与 RPC、CLI、规则配置的 `schemaVersion` 混用。
3. 明确文件变化的权威采集者以及完整的 debounce/settle/batch/hash/fallback 状态机。

其余发现可放入架构脊柱的 `Deferred` 触发条件或开发实施说明，不要求扩大架构正文。

## 2. 审查范围与方法

本次只读取并对账以下输入，未修改 `ARCHITECTURE-SPINE.md`：

- `research/project-code-graph-three-way-research-2026-07-08.md`
- `research/project-code-graph-mvp-stack-upgrade-analysis-2026-07-09.md`
- `architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md`

对账标准不是检查研究中的每个建议是否逐字复制，而是检查：如果存储、分析器、服务、插件、CLI、Webview 等下一级单元独立实现，是否仍可能在共享身份、状态所有权、变更路径、线协议或升级边界上产生不兼容选择。

技术版本于 2026-07-13 通过 Node.js 官方发布索引与 npm Registry 独立复核。研究文档本身提供的是技术适用性来源，没有为架构脊柱中的每个精确版本号提供逐项证据，因此本报告将“研究证据”和“本次实时版本复核”分开记录。

## 3. 逐维度对账

| 维度 | 结论 | 已落地证据 | 尚缺内容或判断 |
| --- | --- | --- | --- |
| 技术边界 | 已落地 | Design Paradigm、AD-1、AD-2、AD-5、AD-7；组合根、端口、适配器与薄客户端边界清楚 | 无承重缺口。未来端口细节应在契约包中固化，不应把适配器 DTO 反向暴露给核心 |
| 升级触发条件 | 部分落地 | `Deferred` 已覆盖第二语言/Tree-sitter/LSP/SCIP、Rust/WASM、`node:sqlite`/SEA、ARM64、第二渲染器及 MCP/云端/跨仓库/CPG | 缺少研究中的查询变慢、事件风暴、团队共享、历史分析、Webview 卡顿等可观测触发信号；部分项目只被“延后”，没有说明何时重开决策 |
| 稳定 ID | 部分落地，承重缺口 | AD-4 规定 `cg://`、工作区作用域、相对 POSIX 路径、确定性边 ID 与 `movedFrom` | 未规定 workspace-key、文件/目录/包/外部包/符号的逐类配方、大小写与百分号编码、符号链接与匿名符号稳定性；两个合规实现仍可能生成不同 ID |
| 来源与置信度 | 部分落地 | AD-4 将 provenance、confidence、sourceRange、analyzerVersion、lastSeenRevision 放入 Evidence；AD-5 指定 MVP 的权威分析源 | 研究要求节点和边均可追溯，当前只明确了规范边 Evidence；confidence 的类型、刻度、语义和冲突合并规则未定，Evidence 去重身份也未定 |
| 增量队列 | 大体落地，入口未闭合 | AD-3 固定 FactBatch → GraphPatch → 原子提交；AD-8 固定单变更通道、Job 状态、按路径合并、hash 去重、rebuild 吸收与安全取消 | 未明确文件事件由扩展、服务还是二者产生；缺 debounce、settle、批次封口、watcher 丢事件/溢出后的全量校验，以及 Watchman 的明确升级触发器 |
| 本地服务 | 大体落地 | AD-2、AD-11、AD-12 固定每工作区单实例、IPC、状态所有权、安全与发布方式 | 按需启动后的空闲退出、陈旧锁/PID 恢复可留给实施说明；但 VSIX 启动服务时使用 Node 还是 Electron runtime、原生 SQLite ABI 如何构建和验收需要明确 |
| 存储/渲染隔离 | 已落地 | AD-1、AD-6、AD-7；只有服务开库，GraphViewModel 不含 SQL/Cytoscape JSON/像素坐标 | 研究建议的 `RendererAdapter` 未首版抽包是可接受的 Rule of Three 取舍，GraphViewModel 已提供足够隔离；出现第二渲染器时再抽取合理 |
| Monorepo | 部分落地 | pnpm workspace 结构种子清楚；AD-5 覆盖 `tsconfig paths`、project references 与 workspace 跨包引用 | “每工作区”在 VS Code multi-root、单仓多 package、嵌套 workspace/tsconfig 时的边界未定义；workspace-key 与 package identity 也因此不够确定 |
| 迁移风险 | 大体落地 | 自增业务 ID、Cytoscape 持久化、UI 查库、主线程索引、无来源、无增量/stale、无忽略规则等风险均有对应 AD | 图谱 schema version 仍不明确；路径规范化只有“相对 POSIX + realpath 安全校验”，不足以保证跨平台 ID 一致 |
| 技术版本 | 已核实 | Node 官方索引与 npm Registry 均能找到架构列出的全部精确版本，且截至复核时均为对应稳定/latest 版本 | 版本证据未落盘到脊柱；`@types/vscode` 版本隐含最低宿主 API 风险，`better-sqlite3` 仍需 Node/Electron 双 ABI 验收 |

## 4. 关键发现

### RR-1 — [高] 稳定 ID 仍是“格式方向”，不是可互操作算法

研究把“稳定、可重建的业务 ID”列为比数据库选择更重要的迁移前提；AD-4 已正确禁止自增 ID，并规定 `cg://` 与相对 POSIX 路径，但还不足以让两个独立分析器或一次缓存重建得到同一身份。

需要固定的最小不变量包括：

- workspace-key 的输入与优先级：例如 Git 远程身份、monorepo 子路径、本地无 Git 回退，以及远程 URL 变化时的行为。
- 路径规范化：Unicode、大小写、盘符、分隔符、百分号编码、符号链接和 workspace root 的处理。
- 每类实体的确定性配方：workspace、package、directory、file、external package、symbol。
- 符号 ID 的限定名称、语言、kind、签名摘要，以及匿名/局部符号的低稳定性标记。
- 文件移动时 `movedFrom` 是单次 patch 提示还是持久别名；它不能同时被两种实现解释成不同身份保留策略。

建议：在 AD-4 中只保留上述不可分歧的规则，把精确编码写入 `contracts` 下的规范性 ID 文档并由契约测试锁定。只写示例 URI 不足以形成契约。

### RR-2 — [高] 图谱数据 schema 版本与其他 schema 版本发生语义混叠

升级研究将“没有图谱 schema version”列为十大最大迁移风险之一。当前 AD-6 规定迁移事务化，AD-12 规定握手交换 `schemaVersion`，AD-13 和 AD-9 又分别有 CLI JSON schema 与 rules schema；但脊柱没有说明这些是否是同一个版本，也没有明确数据库内保存哪个图谱 schema 版本。

这会导致以下不兼容实现：

- 一个实现把握手 `schemaVersion` 当 RPC DTO 版本，另一个把它当 SQLite schema 版本。
- 一个服务原地迁移数据库，另一个遇到不兼容版本直接重建，二者对故障副本和回滚的行为不同。
- 导出 JSON 的 `schemaVersion: 1` 被误当成内部图模型或存储 schema 的兼容承诺。

建议至少区分并命名：`protocolVersion`、`contractSchemaVersion`、`graphSchemaVersion`、`rulesSchemaVersion`、`cliSchemaVersion`。`graphSchemaVersion` 由服务内部持有，通过迁移表或 SQLite `user_version` 管理；明确哪些版本可迁移、哪些必须备份后重建，以及迁移失败不得推进 graphRevision。

### RR-3 — [高] 增量更新的变更通道已确定，但事件采集所有权仍未确定

AD-8 已很好地封堵“每个文件事件直接触发重建”的风险，但没有规定谁是权威 FileEvent 生产者。研究一处建议 MVP 使用 VS Code `FileSystemWatcher`，同时又要求插件保持薄客户端、CLI 复用同一本地服务；这两点若不裁决，扩展和服务可能各建 watcher，造成重复、漏事件或 CLI/插件结果不同。

建议明确一条规范状态机：

```text
ChangeSource → Debounce → Settle → Batch → Content Hash → Index Job → GraphPatch
```

并固定以下规则：

- 只有一个组件拥有权威文件系统变更流；其他客户端事件只能作为加速提示，不能成为唯一事实来源。
- watcher overflow、branch switch、git pull 或服务离线期间的变化必须触发受控 rescan/reconcile。
- debounce/settle 可以是运行偏好，但服务端应有安全范围，并按 workspace 相对规范路径合并。
- 把 Watchman 加入 Deferred：当事件风暴、漏事件、重复重建或 monorepo 监听成本达到观测阈值时替换 ChangeSource 适配器。

### RR-4 — [中] Evidence 字段齐全，但来源合并语义仍可分歧

AD-4 已把多来源建模为规范边上的 Evidence，这比平行重复边更稳健；AD-5 也通过 TypeScript 单一权威源降低了 MVP 冲突。但研究期待分析结果带来源与置信度，未来 Tree-sitter/LSP/SCIP 接入时仍需统一：

- confidence 是枚举（如 exact/strong/heuristic）还是数值；若为数值，其区间和含义是什么。
- Evidence 的去重键是否包含 analyzer、版本、sourceRange、事实类型。
- 多条证据冲突时，规范边的可见性、方向和聚合 confidence 如何决定。
- 节点、Finding 与分析完整性是否也携带 provenance/completeness，还是只给边携带。
- language 与分析诊断目前在研究模型中存在，但 AD-4 的 Evidence 最小字段未包含 language。

建议在 `contracts` 中定义 Evidence 判别联合与合并真值表；MVP 可只实现 `provenance=typescript`，但公共形状不能留给后续适配器各自解释。

### RR-5 — [中] Deferred 罗列了升级方向，但未完整继承研究的可观测触发器

当前 Deferred 对 TypeScript 分析超过 2 秒、第二语言、原生热点、Node 稳定度、ARM64 和第二渲染器给出了重新评估条件，质量较好。缺失的研究触发器主要有：

| 观测信号 | 研究建议 | 当前状态 |
| --- | --- | --- |
| 局部查询超过 500ms | materialized view、索引、缓存 | 未列入 Deferred |
| watcher 事件风暴/重复重建/漏事件 | Watchman、settle、batch queue | batch/hash 已在 AD-8，Watchman 及重开条件缺失 |
| Webview 明显卡顿 | 节点预算、预布局、Sigma.js/矩阵 | 预算已固定；第二渲染器只以“出现第二实现”为触发，不以性能为触发 |
| 团队共享写入 | Postgres/AGE/服务端 GraphStore | “云端团队共享”已延后，但没有存储升级触发条件 |
| 历史趋势/大聚合 | DuckDB/列式分析 | 历史趋势已延后，未说明何时引入分析存储 |
| 精确引用/实现关系 | LSP/SCIP | TS Compiler API 对 TS/JS 可覆盖一部分；未来非 TS 或能力缺口的触发条件可写得更明确 |

建议把这些作为精简的“信号 → 重开决策”表，而不是提前绑定升级技术。这样既符合架构脊柱的 Deferred 语义，也避免无指标的技术预留。

### RR-6 — [中] 本地服务交付方案可行，但 Node/Electron ABI 与 VS Code 支持下限需成为验收契约

AD-12 选择 npm CLI + 平台特定 VSIX 是合理的，`better-sqlite3@12.11.1` 也明确支持 Node 24。但扩展携带同源服务代码和“目标 ABI 的 SQLite 模块”仍留下两个实现分叉：

- VSIX 拉起的服务究竟运行在 VS Code/Electron 自带 Node、`ELECTRON_RUN_AS_NODE`，还是扩展自带 Node runtime。
- CLI 的 Node ABI 构建与 VSIX 的 Electron ABI 构建如何共享服务版本、缓存 schema 和单实例发现。

此外，`@types/vscode@1.125.0` 是当前版本，但脊柱未指定 `engines.vscode` 最低版本。若实现使用 1.125 新 API，却宣称支持更低 VS Code，编译能过而运行会失败。

建议在实施说明中固定运行时与构建矩阵，并把以下 smoke test 设为发布门槛：每个目标平台实际启动服务、加载原生模块、创建/迁移 SQLite、完成握手、由 CLI 与扩展交叉连接同一实例。`engines.vscode` 必须与实际 API 使用和测试矩阵一致。

### RR-7 — [中] Monorepo 分析能力已声明，workspace 边界仍含糊

AD-5 已覆盖 `tsconfig paths`、project references 与 workspace 跨包引用，说明分析目标并非只支持单 package。结构种子本身也采用 pnpm monorepo，内部模块边界清楚。

仍需裁决的是被分析项目的 workspace 含义：

- 一个 Git monorepo 中多个 npm/pnpm/Yarn package 是否共享一个 graphRevision 与 graph.sqlite。
- VS Code multi-root 是一个服务还是每个 root 一个服务。
- 嵌套 Git 仓库、嵌套 workspace、多个 lockfile、多个顶层 tsconfig 如何划分 package identity。
- workspace-key 是否包含 monorepo 子路径；同一仓库以不同子目录打开时是否视为同一图谱。

这些问题直接影响 S1 单实例、本地缓存键与稳定 ID，应与 RR-1 一起关闭；具体 package discovery 可留给 Analyzer 实施说明。

## 5. 研究建议中的合理收敛与偏离

以下差异不应被误判为遗漏：

1. **Tree-sitter + LSP 未进入 MVP：可接受。** 两份研究偏向 Tree-sitter 语法层叠加 LSP/SCIP，架构改为 TypeScript Compiler API 单一权威源。对仅支持 TS/JS 的 MVP，这减少重复解析和来源冲突，且 AD-5/Deferred 给出了性能、非 TS 语言和无 TS project 的重开条件。前提是实际基准满足保存后 2 秒目标。
2. **未从首版抽取 RendererAdapter 包：可接受。** 研究要求渲染器可替换，AD-7 已通过渲染器无关 GraphViewModel 封堵核心耦合；AD-15 将布局放入 Web Worker，Deferred 在第二实现出现时再抽包，符合 Rule of Three。
3. **图谱不放仓库：是对研究的改进。** 研究允许 `.gitignore`，AD-6 选择 OS 用户缓存并只把规则/忽略配置留在仓库，进一步降低误提交和 watcher 自触发风险。
4. **SQLite 保留：正确。** 本地单用户、有限深度查询、事务 GraphPatch 与 S1 单写者模型都适配 SQLite，不存在必须提前引入图数据库的证据。

## 6. 最大迁移风险逐项复核

| 研究列出的风险 | 当前结果 | 证据/缺口 |
| --- | --- | --- |
| 1. 数据库自增 ID 当业务 ID | 已封堵 | AD-4 使用确定性业务 URI；但算法仍需补全 |
| 2. Cytoscape JSON 当持久化图谱 | 已封堵 | AD-7 明确禁止 Cytoscape JSON 进入 GraphViewModel/领域模型 |
| 3. UI 直接查询数据库 | 已封堵 | AD-6 规定仅服务开库；AD-7 规定服务查询与 ViewModel |
| 4. 插件主线程做索引和布局 | 已封堵 | AD-2 服务化；AD-5 Analyzer Worker；AD-15 Web Worker 布局 |
| 5. 不记录来源和置信度 | 部分封堵 | AD-4 有 Evidence 字段，缺 confidence 与冲突合并语义 |
| 6. 把 Tree-sitter 语法边伪装成精确语义边 | MVP 已规避 | AD-5 不启用 Tree-sitter，TypeScript 是权威源；未来适配器仍需 Evidence 合并契约 |
| 7. 没有增量更新和 stale 状态 | 已封堵 | AD-3、AD-7、AD-8；但事件采集入口和丢事件恢复需补全 |
| 8. 没有图谱 schema version | 未明确封堵 | AD-12 的 `schemaVersion` 含义不明确，需独立 graphSchemaVersion |
| 9. 文件路径未统一规范化 | 部分封堵 | 相对 POSIX、realpath 与 workspace 边界已规定；大小写、Unicode、编码、symlink identity 仍未固定 |
| 10. 无排除规则导致污染 | 已封堵 | AD-6、AD-14 从首版支持 `.codegraphignore`，且策略归仓库 |

## 7. 技术版本复核

复核来源：

- Node.js 官方发布索引：`https://nodejs.org/dist/index.json`
- npm Registry：`https://registry.npmjs.org/<package>`

截至 2026-07-13，架构脊柱列出的版本均可在官方源找到，且本次复核时均为相应稳定/latest 版本：

| 架构名称 | 实际包/来源 | 脊柱版本 | 复核结果 | 兼容性备注 |
| --- | --- | --- | --- | --- |
| Node.js LTS | Node.js 官方发布索引 | 24.18.0, Krypton | 存在；当前 24.x LTS | 适合作为 CLI 基线 |
| TypeScript | `typescript` | 7.0.2 | 存在；latest | Node 要求 `>=16.20.0`，与 Node 24 兼容 |
| pnpm | `pnpm` | 11.12.0 | 存在；latest | Node 要求 `>=22.13`，与 Node 24 兼容 |
| VS Code API types | `@types/vscode` | 1.125.0 | 存在；latest | 需同步声明并测试 `engines.vscode` |
| generator-code | `generator-code` | 1.12.0 | 存在；latest | 仅应视为脚手架种子，不是运行时架构依赖 |
| esbuild | `esbuild` | 0.28.1 | 存在；latest | Node 要求 `>=18` |
| vscode-jsonrpc | `vscode-jsonrpc` | 9.0.1 | 存在；latest | Node 要求 `>=14` |
| better-sqlite3 | `better-sqlite3` | 12.11.1 | 存在；latest | engines 包含 Node 24；Electron ABI 仍须逐平台实测 |
| yaml | `yaml` | 2.9.0 | 存在；latest | Node 要求 `>=14.6` |
| Ajv | `ajv` | 8.20.0 | 存在；latest | 与 Node 24 无明显冲突 |
| Cytoscape.js | `cytoscape` | 3.34.0 | 存在；latest | 用于 Webview 局部图合理 |
| Vitest | `vitest` | 4.1.10 | 存在；latest | engines 包含 Node `>=24` |
| VS Code test CLI | `@vscode/test-cli` | 0.0.15 | 存在；latest | Node 要求 `>=22` |
| VS Code test Electron | `@vscode/test-electron` | 3.0.0 | 存在；latest | Node 要求 `>=22` |
| VS Code packaging | `@vscode/vsce` | 3.9.2 | 存在；latest | Node 要求 `>=20` |

版本结论：没有发现不存在、明显过时或与 Node 24 明显不兼容的版本。主要风险不在版本号，而在以下两点：

- “截至某日的 latest”属于 Structural Seed，应由 lockfile 和更新策略接管，不应被当作长期架构不变量。
- 原生 SQLite 模块的 Node/Electron ABI、VS Code 最低支持版本与平台发布矩阵必须通过真实产物验收，而不能只依赖 npm `engines`。

## 8. 建议处置顺序

### 标记 `final` 前应关闭

1. RR-1：稳定 ID 的规范算法与 monorepo/workspace identity。
2. RR-2：独立的 graph schema 版本、迁移、备份/重建与命名。
3. RR-3：权威文件变更源、增量状态机和丢事件恢复。

### 可进入开发实施说明或 Deferred

1. RR-4：Evidence/confidence 判别联合与合并真值表。
2. RR-5：研究中的升级信号表。
3. RR-6：Node/Electron runtime、ABI 构建矩阵、`engines.vscode` 与跨客户端 smoke test。

### 无需反向改回研究原方案

- 不需要为了“与研究一致”而把 Tree-sitter/LSP 强行塞回 MVP。
- 不需要为了可替换性而提前建立空的 `RendererAdapter` 包。
- 不需要把 SQLite 换成图数据库，也不需要把缓存移入仓库。

