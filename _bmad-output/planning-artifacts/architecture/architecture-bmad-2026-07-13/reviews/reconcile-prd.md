---
title: PRD / Addendum → Architecture Spine 独立对账
date: 2026-07-13
review_scope: 项目代码图谱 MVP
verdict: revise-before-final
sources:
  - ../../../prds/prd-bmad-2026-07-09/prd.md
  - ../../../prds/prd-bmad-2026-07-09/addendum.md
  - ../ARCHITECTURE-SPINE.md
---

# PRD / Addendum → Architecture Spine 独立对账

## 结论

**结论：方向一致，但不能按“输入已完整落地”通过最终对账；建议在定稿前做一次定向补强。**

六边形模块化单体、单工作区服务、原子 GraphPatch、确定性 ID、本地缓存、TypeScript 权威分析源、薄 VS Code 客户端、默认本地与遥测关闭等主干决策与 PRD 一致。没有发现已采用 AD 直接违反 PRD 的硬性要求。

问题在于，脊柱用 `FR-1..FR-23`、`SM-1..SM-6` 的范围映射声明了广泛覆盖，但若干真正会让独立实现单元产生不同结果的契约没有被固定。逐项审查结果为：**8 项 FR 已充分进入架构，15 项 FR 只有部分承载，0 项完全没有任何引用**。最严重的不是模块缺失，而是验收基线与公共契约被压缩成了名称：性能数字、发布阶段、规则语义、CLI 退出码语义、服务状态、PR/AI 导出格式均可能由下游各自解释。

建议把本报告的高优先级项视为定稿门槛；中优先级项至少应明确落入契约种子或 Deferred，并给出重新评估条件。

## 判定口径

- **充分承载**：需求已由 AD、约定、结构种子或 Deferred 固定，两个下游单元无法在遵守脊柱的同时做出互不兼容的实现。
- **部分承载**：能力有归属或范围映射，但关键语义、字段、阈值、状态或阶段仍可被不同实现自由解释。
- **静默丢失**：PRD/Addendum 明确要求架构确认或给出硬边界，但脊柱既未决定，也未标为 Deferred/Open Question。
- 本报告不要求脊柱复述所有 UI 验收文案；只追踪会影响跨模块一致性、产品边界、发布顺序、隐私或验收结果的负载型要求。

## 高优先级发现

### R-01 — 性能与正确性验收 envelope 被范围映射替代，硬指标未落地

**来源**

- PRD §5.1（347–353）：5,000 个源码文件、500,000 LOC、50 个 workspace package；8 逻辑 CPU、16 GB、SSD；首次概览 60 秒、缓存邻域 300ms、保存后更新 2 秒；超规模不得阻塞编辑器并需进度/取消/重建。
- PRD SM-1..SM-5（445–452）：3 分钟任务完成、300ms、2 秒、依赖识别准确率至少 80%、60 秒首次概览。
- Addendum §5.2（87–92）再次把这些数字声明为硬指标。

**当前承载**

- `AD-5` 选择 Worker 中的 TypeScript Compiler API。
- `AD-7` 固定 1 跳、100 节点、200 边的默认查询预算。
- `AD-15` 把布局放入 Web Worker。
- 能力映射只写 `SM-1..SM-6 → benchmark fixtures / instrumentation / pipelines`（Spine 243–252）。
- Deferred 只在 TypeScript 分析达不到 2 秒时触发替代分析器评估（Spine 254–256）。

**缺口与影响**

- 脊柱没有记录标准项目规模、参考硬件和 60s/300ms/2s/80% 的验收数字。
- `SM-1` 的 3 分钟用户任务指标与 `SM-4` 的 80% 准确率并非一般性能日志能替代，当前映射会让它们失去可执行验收方法。
- 下游可以都遵守现有 AD，却分别把“可接受”理解为不同延迟、不同仓库规模和不同准确率。

**建议落点**

- 增加一个明确的验收 envelope（可为 AD、Consistency Convention 或测试契约种子），固定规模、参考环境、目标与超规模行为。
- 将 `SM-1..SM-6` 拆分为性能基准、准确率基准、规则正确性和用户任务验证，不再用单行范围映射合并。

### R-02 — Alpha / Beta / Beta+ 的产品发布边界静默丢失

**来源**

- PRD §7（403–435）：完整 MVP 分段验证；PR 摘要属于完整 MVP，但不阻塞首个可用版本。
- PRD §9（464–492）：Alpha 是 CLI 单包原型；Beta 才要求 VS Code 与常见 monorepo 边界；Beta+ 才加入规则与 PR 摘要；MCP 仅在 SM-1..SM-4 达标且导出价值得到确认后进入 v1.1 候选。
- Addendum §5.1（80–85）：Alpha 可把 monorepo 当普通工作区，Beta 必须识别 npm/Yarn/pnpm workspace。

**当前承载**

- `AD-12` 只规定发布产物和平台矩阵（Spine 122–126）。
- Structural Seed 一次性列出 CLI、扩展、Webview、规则、impact、export 全部包。
- Deferred 对 MCP 写了“按 PRD 触发条件另立 spine”，但没有 Alpha/Beta/Beta+ 顺序。

**缺口与影响**

- 实现团队无法从脊柱判断首个交付是否应被 monorepo、规则、PR 摘要或 VS Code 打包阻塞。
- `AD-5` 已把 workspace 跨包分析纳入 MVP 权威源，但没有保留“Alpha 可退化、Beta 必须识别”的阶段边界。
- 发布计划可能被错误串行化为“大爆炸 MVP”，直接违背 PRD 的降风险路径。

**建议落点**

- 在结构种子旁增加最小 Release Slice / Capability Gate，固定 Alpha、Beta、Beta+ 的进入与退出条件。
- Deferred 补齐 v1.1 的确切启动条件，而不只写“按 PRD”。

### R-03 — `rules.yaml` 被命名为唯一契约，但契约内容没有被固定

**来源**

- PRD FR-12（217–230）：仅三种规则；稳定唯一 ID；warning/error；`forbidden-dependency`、`layer-order`、`no-cycle` 的精确语义；POSIX 相对路径与 `*`/`**` glob 语义；全局 ignore；rebuild/save/check 三个执行点；重复 ID 和非法输入必须定位报错；明确列出 v1 不支持项。
- Addendum §4（39–76）：给出完整示例，并规定 `layer-order` 从上到下、每层可依赖自身及后续层。

**当前承载**

- `AD-9` 固定 JSON Schema 2020-12、`version: 1`、拒绝未知字段、按 `type` 判别、YAML 范围与 Ajv 校验（Spine 104–108）。
- Structural Seed 只有泛化的 `contracts` 和 `application/rules` 目录（Spine 196–204）。

**缺口与影响**

- 脊柱未列出三种允许类型、各类型字段、severity 枚举、no-cycle scope、layer-order 方向、glob 语义、全局 ignore、执行时机和 v1 明确禁用能力。
- “重复规则 ID”不是仅靠常规 JSON Schema `uniqueItems` 就能可靠表达的对象字段唯一性约束；现有 AD 没有要求补充语义校验。
- 两个实现都可以声称使用 JSON Schema 2020-12，却生成不兼容的 v1 schema，正是 `AD-9` 声称要防止的分歧。

**建议落点**

- 在契约种子中明确 `rules-v1.schema.json` 的规范路径，并把 PRD/Addendum 中的规则集合、字段与语义设为不可变 v1 合同。
- 单列 Schema 之外的语义校验：重复 ID、非法 glob、层名/路径冲突等。

### R-04 — CLI 与服务状态被称为稳定公共契约，但只固定了名称，没有固定语义

**来源**

- PRD FR-15、FR-16、FR-20、FR-22：check 的 warning/error 退出行为；working tree、staged、base 三种变更集合；rebuild/query/check/impact/export；`idle/indexing/stale/failed` 状态；失败摘要与日志位置。
- PRD FR-20/FR-23 要求机器可读、可导出的稳定结果。
- Addendum §7（116）要求架构确认命令命名、输入输出格式、退出码语义。

**当前承载**

- `AD-13` 固定子命令、stdout/stderr、文本/JSON/Markdown 和退出码数字集合 `0/1/2/3/4/130`（Spine 128–132）。
- `AD-8` 固定 Job 状态 `queued/running/succeeded/failed/cancelled`（Spine 98–102）。
- `Consistency Conventions` 固定 RPC 命名和错误字段（Spine 154–164）。

**缺口与影响**

- 退出码只列数字，没有绑定含义；两个 CLI 可以对 `2/3/4` 作不同解释并仍遵守 AD-13。
- JSON envelope 仅有名字，没有最小字段与状态语义；`schemaVersion`、command、workspaceKey、graphRevision、diagnostics、error 等没有进入脊柱契约种子。
- FR-16 的 working tree、staged、base 选择及互斥关系没有落地。
- Job 状态不等于 FR-22 的服务/图谱状态；`idle/indexing/stale/failed` 没有公共枚举，扩展、CLI 与服务可能各自翻译。
- `check` 在只有 warning 时返回 0 的硬行为没有在退出码合同中绑定。

**建议落点**

- 把退出码“数字 → 含义”、CLI envelope 最小字段和 impact 输入互斥规则写入 contracts seed 或 AD-13。
- 独立定义 JobState、ServiceStatus、Freshness，避免一个枚举承担三种语义。

### R-05 — PR Markdown 与 AI 结构上下文格式是 Addendum 明示待确认项，但既未决定也未 Deferred

**来源**

- PRD FR-18（281–288）：总体 verdict、主要风险、关键路径、建议复查文件、相对路径、默认无源码。
- PRD FR-23（334–341）：路径、节点类型、依赖边、规则 findings、图谱更新时间、预算、默认无源码。
- Addendum §7（118–119）：明确要求架构确认 PR Markdown 模板与 AI 结构上下文格式。

**当前承载**

- `AD-13` 只说 impact/export 可输出 Markdown。
- Structural Seed 只写 `exporting # JSON/Markdown/AI 结构上下文`（Spine 198–204）。
- `AD-7` 与路径约定提供预算、revision 和相对路径基础。

**缺口与影响**

- 没有 PR Markdown 的最小章节/字段合同，也没有 AI 导出的版本化结构。
- “默认不包含源码正文，只有显式开启才能包含”没有成为 exporting 的硬护栏；现有“日志不记录源码”不能替代导出隐私规则。
- Addendum 的两个待架构确认项在 Deferred 中也没有出现，属于明确的静默丢失。
- CLI、VS Code 导出和未来 MCP 可能产生不同字段、不同风险语义和不同隐私默认值。

**建议落点**

- 固定两个独立版本化契约：`PrReviewSummaryV1` 与 `StructureContextExportV1`；不应复用 UI `GraphViewModel`。
- 明确源码正文默认禁止、显式开关的作用域，以及输出必须携带的 revision、生成时间、预算/截断信息和配置来源。

## 中优先级发现

### R-06 — 分析事实质量、monorepo 发现与动态依赖降级规则只有部分落地

**来源**

- FR-1/FR-2：识别 npm/Yarn/pnpm workspace，无法识别时退化；跨 package import 聚合；Evidence 需含来源、置信度、语言、文件范围和最后检测时间；动态依赖不得伪装成精确结果。
- SM-4：import/export 依赖识别准确率至少 80%。
- Addendum §5.1：package 边界发现与 project references 的角色。

**当前承载与缺口**

- `AD-5` 固定 TS Compiler API、project references、workspace 跨包引用，但没有固定 npm/Yarn/pnpm 边界发现输入、失败退化和 package 聚合规则。
- `AD-4` 的 Evidence 包含 provenance、confidence、sourceRange、analyzerVersion、lastSeenRevision，但缺少 PRD 明示的 `language` 与最后检测时间；revision 不能完全替代时间。
- 没有“不确定动态依赖必须低置信或排除”的判断规则，也没有 80% 准确率基准的 fixture/计算口径。

**风险**：同一仓库在不同入口得到不同 package 图，或启发式动态依赖被误当作精确边。

### R-07 — 排除与文件事件风暴的语义不完整

**来源**

- FR-3/FR-4 与 Addendum §2：debounce、settle、hash check、batch queue；默认排除依赖目录/构建产物；排除项不得参与节点、边、规则或成功指标统计。

**当前承载与缺口**

- `AD-8` 已固定按路径合并和 hash 去重，单变更通道可承担 batch queue，但没有明确 debounce/settle，可能在文件仍写入时解析。
- `AD-6` 固定 `.codegraphignore` 所有权与位置，但没有固定默认排除集合和“排除贯穿分析、规则、统计”的统一语义。

**风险**：git pull、分支切换或生成器仍可能产生不稳定中间 revision；不同模块对 ignore 的解释不一致。

### R-08 — `GraphViewModel`、Finding 解释与服务状态缺少最小语义形状

**来源**

- FR-1：空工作区状态与初始化摘要。
- FR-6/FR-7：依赖强度、循环风险、更新时间、方向、外部包、下钻与聚合。
- FR-9：节点详情与文件移动后的恢复提示。
- FR-11/FR-13/FR-14：循环路径、新增边、实际/期望方向、严重级别、范围、检测时间、来源/置信度。
- FR-22：idle/indexing/stale/failed、错误摘要、日志位置和重建恢复。

**当前承载与缺口**

- `AD-7` 固定了 ViewModel 与预算/聚合/revision/freshness 边界，但没有最小字段或不同视图所需语义。
- `AD-10` 固定宿主表面，却没有明确 Findings 面板的状态所有者和数据合同。
- `AD-4`/错误约定提供了 Evidence 与错误基础，但没有固定解释型 Finding 的 cycle path、trigger edge、expected rule、existing/new 分类等字段。

**风险**：服务、Webview、CLI 和 Problems 都能“遵守架构”但展示不同风险解释，破坏 FR-14 的可解释性。

### R-09 — 追踪声明过宽，Deferred 与成功指标覆盖不完整

**证据**

- Spine frontmatter 声明绑定全部 FR，但未声明 PRD §5.5 的 `NFR-evolvability`（Spine 11–21）。
- 能力映射只覆盖 `SM-1..SM-6`，漏掉 `SM-7`、`SM-8` 及四个 counter-metrics（Spine 243–252）。
- Deferred 未明确列出 hosted PR app、AI 自动重构、可视化规则编辑器、独立 Web dashboard；这些在 PRD §7.2 明确排除。

**判断**

- 可演进性实际由 AD-1/4/5/7 与 Deferred 较好支持，这是追踪元数据遗漏，不是架构能力缺失。
- `SM-7` 偏产品研究，可以不做 AD，但应进入验证计划；`SM-8` 直接检验 PR Markdown，可与 R-05 一并落地。
- Counter-metrics 中“不做全局大图”和“不以语言数量为目标”已由 AD-7/Deferred 间接体现；“不最大化 Findings”和“不以 AI 自动修改为目标”仍应显式保留，避免实施优化错方向。

## FR 逐项覆盖表

| FR | 状态 | 已承载位置 | 仍缺失的负载型内容 |
| --- | --- | --- | --- |
| FR-1 初始化图谱 | 部分 | AD-2、AD-5、AD-8；indexing seed | npm/Yarn/pnpm 边界发现与退化、空状态、初始化统计摘要、Alpha/Beta 阶段差异 |
| FR-2 TS/JS 依赖 | 部分 | AD-4、AD-5 | Evidence 的 language/检测时间、动态依赖降级、package 聚合合同、80% 准确率口径 |
| FR-3 增量更新 | 部分 | AD-3、AD-8 | debounce/settle 明示；事件风暴下的稳定快照边界 |
| FR-4 路径排除 | 部分 | AD-6、AD-14 | 默认排除集合；排除必须贯穿图谱、规则、指标的统一语义 |
| FR-5 版本/ID/stale | 充分 | AD-2..AD-4、AD-6；revision/time conventions | 无关键结构缺口 |
| FR-6 项目概览 | 部分 | AD-7、AD-10；querying seed | 依赖强度、循环风险、更新时间、下钻所需 ViewModel 语义 |
| FR-7 文件邻域 | 充分 | AD-7、AD-15 | 核心预算、方向、聚合与文本等价已固定 |
| FR-8 跟随与固定 | 充分 | AD-10（扩展语义状态 / Webview 视觉状态） | 建议在 UI DTO 中明确 follow/pin，但不构成主架构缺口 |
| FR-9 导航/上下文 | 部分 | AD-10、AD-4、错误约定 | Node detail 最小字段、文件移动/缺失恢复动作合同 |
| FR-10 多视图 | 充分 | AD-15 | 图/列表任务等价和无障碍语义已固定 |
| FR-11 循环检测 | 部分 | rules seed、AD-3、AD-7、AD-9 | file/directory/package scope、完整/折叠路径与 existing/new Finding 形状 |
| FR-12 规则配置 | 部分 | AD-9、AD-14 | 三类规则的精确 schema/语义、glob、重复 ID、执行点和不支持项 |
| FR-13 保存后 Findings | 部分 | AD-3、AD-9、AD-10 | Finding 最小字段、触发新增边、检测时间与面板所有权 |
| FR-14 风险解释 | 部分 | AD-4、AD-7 | cycle path、actual/expected direction、限制/低置信解释合同 |
| FR-15 CLI check | 部分 | AD-13 | warning/error 的退出码精确语义、summary/findings JSON 形状 |
| FR-16 变更集合 | 部分 | impact seed、git-local、AD-8、AD-13 | working-tree/staged/base 参数与互斥；VS Code 入口；Git 不可用的替代动作 |
| FR-17 结构摘要 | 充分 | AD-7、AD-8、impact seed | 新增/既有风险和预算边界已进入主干；具体 DTO 可在 contracts 固定 |
| FR-18 PR Markdown | 部分 | AD-13、exporting seed | verdict/风险/关键路径/复查文件模板；源码显式 opt-in 边界 |
| FR-19 本地隐私 | 充分 | AD-6、AD-11、AD-14、AD-16 | 建议补充遥测当前状态可见性；主边界已充分固定 |
| FR-20 CLI 命令 | 充分 | AD-13、service-client seed | 命令集合与输出通道已固定；参数合同仍与 R-04 关联 |
| FR-21 查询服务 | 充分 | AD-2、AD-7、AD-12；service-client | 单一服务、IPC 和渲染器无关 DTO 已固定 |
| FR-22 状态/恢复 | 部分 | AD-2、AD-3、AD-6、AD-8、错误/日志约定 | ServiceStatus/Freshness 枚举、失败摘要与重建动作公共合同 |
| FR-23 上下文导出 | 部分 | AD-4、AD-7、AD-13；exporting seed | 版本化 AI 导出格式、必填字段、默认无源码与截断说明 |

## NFR、隐私、性能、CLI、规则与发布边界汇总

| 维度 | 判定 | 说明 |
| --- | --- | --- |
| 性能 | **未充分落地** | 有 Worker、预算、Job 和 benchmark 归属，但标准规模、硬件、60s/300ms/2s 与超规模行为未固定。 |
| 正确性 | **未充分落地** | SM-4 的 80% import/export 准确率及其基准语料/计算口径缺失。 |
| 可靠性 | **大体一致，部分缺口** | 原子事务、stale、损坏缓存恢复、可取消 Job 已固定；settle/debounce 与服务状态合同不足。 |
| 安全与隐私 | **充分一致** | 无 TCP、当前用户 IPC、Workspace Trust、路径防护、本地缓存、默认不上传、Telemetry Noop/allowlist 均比 PRD 更具体。导出默认无源码仍需补。 |
| 可访问性 | **充分一致** | AD-15 明确图/列表任务等价、非颜色单通道、焦点/主题/高对比/减少动态。 |
| 可演进性 | **实质充分，追踪缺失** | 端口边界、证据层、渲染器无关模型和升级触发已存在；frontmatter 未绑定 NFR-evolvability。 |
| CLI | **方向正确，公共语义不完整** | 命令、输出通道、格式和数字集合已定；参数、envelope、退出码含义、service status 未定。 |
| 规则 | **验证技术已定，v1 业务合同未定** | JSON Schema/Ajv/YAML 范围已定；规则类型、字段、方向、glob、重复 ID、执行点仍未固定。 |
| 发布 | **平台发布已定，产品阶段丢失** | VSIX/npm 与平台矩阵清楚；Alpha/Beta/Beta+ 的能力 gate 未进入脊柱。 |
| Deferred | **部分完整** | 第二语言、Rust、SQLite/SEA、第二渲染器、MCP/云/跨仓/趋势/CPG 已列；hosted PR app、AI 自动重构、规则编辑器、Web dashboard 未列。 |

## 冲突检查

未发现需要回滚既有 AD 的直接冲突。以下是看似不同、实为合理架构收敛的项目：

1. **Tree-sitter + TypeScript/LSP 候选 → TypeScript Compiler API 单一权威源**：Addendum §3 明确是候选而非硬要求；AD-5 的选择与 TS/JS MVP、准确性和 CLI/插件一致性相容。第二语言与其他分析器已 Deferred。
2. **工作区内可识别位置或用户缓存 → OS 用户缓存**：PRD §6.2 允许二选一；AD-6 选择用户缓存并避免误提交，符合意图。建议补一句“生成数据无需加入仓库 `.gitignore`，仓库仅提交策略文件”，消除 PRD 中旧的通用建议歧义。
3. **本机监听 → Named Pipe / UDS 且不监听 TCP**：AD-2/AD-11 是更强的本地边界，不构成冲突。
4. **默认关闭遥测 → TelemetryPort Noop + 编译期 allowlist**：AD-16 是一致且更可执行的实现。

## 建议的定稿门槛

在把 spine 标记为 `final` 前，至少完成以下处置：

1. 固定性能/准确率验收 envelope 与 Alpha/Beta/Beta+ capability gates。
2. 为 `rules-v1.schema.json`、CLI envelope/exit codes、ServiceStatus/Freshness 写出最小契约种子。
3. 决定 `PrReviewSummaryV1` 与 `StructureContextExportV1`，或把它们显式 Deferred 到对应 story/feature 并给出阻塞条件；不能继续保持无归属。
4. 补齐 monorepo 发现/退化、动态依赖降级、Evidence 字段、settle/debounce 与排除语义。
5. 修正 traceability：加入 NFR-evolvability、SM-7/SM-8 的验证归属，并补全 PRD 明示的 MVP Out of Scope。

