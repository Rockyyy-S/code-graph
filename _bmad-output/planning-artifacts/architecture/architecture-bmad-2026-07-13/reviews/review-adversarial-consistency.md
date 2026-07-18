---
title: Reviewer Gate — 对抗性一致性审查
date: 2026-07-13
review_type: adversarial-consistency
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 对抗性一致性审查

## Verdict

**暂不建议定稿。** 机械 lint 为 0 finding，但仍存在 1 个 critical、5 个 high 和 2 个 medium 语义孔洞。以下每一组独立实现单元都可以逐字遵守当前全部 AD，却仍在共享数据、状态或结果上不兼容。

## 审查方法

只审查最新 `ARCHITECTURE-SPINE.md`。对每个共享接缝构造两个“一层下”的独立实现单元，检查它们在不违反任何 AD 的情况下能否作出互不兼容的选择。每项给出处理结论：收紧/新增 AD，或可进入 Deferred。

## Critical / High Findings

### C1 — [Critical] `FactBatch` 的快照/增量和遗漏删除语义未定义

**独立单元 A：`analyzer-typescript`**

只输出本轮新发现或变化的事实；未出现的旧事实表示“未检查/保持不变”。这符合 `AD-3` 的“分析器只输出 FactBatch”。

**独立单元 B：`application/indexing`**

把同一文件和 provenance 的每个 FactBatch 当作完整替换快照；批次中未出现的旧事实全部删除。这也符合 `AD-3` 的“按输入切片与来源计算 GraphPatch”。

**不兼容结果：** 一次局部或失败恢复分析会静默删除仍存在的节点/边；反过来，若 B 按 delta 处理而 A 输出 snapshot，删除事实将永远残留。原子事务只保证错误结果原子可见，不能保证结果正确。

**缺口位置：** `AD-3`（第 69 行附近）固定了变更路径，却没有固定 `FactBatch` 的 `sliceKey`、`mode`、完整性、内容版本和 tombstone 语义。

**处理：必须收紧 AD-3，不可 Deferred。** 至少固定：

- 每批携带 `sliceKey`（workspace/root/file 或 project）、`provenance`、`contentHash`、`mode: snapshot|delta`、`complete`；
- snapshot 的遗漏只删除同一 slice + provenance 的旧事实；不完整批次不得触发遗漏删除；
- delta 必须显式携带 additions/removals，不能用遗漏表达删除；
- 批次基于过期内容 hash 时拒绝提交并重新分析。

### H1 — [High] 规范边身份与关系类型没有固定

**独立单元 A：索引核心**

将 `(fromId, relationType, toId)` 合并为一条语义边，多个 import 位置作为多个 Evidence。

**独立单元 B：分析/存储适配器**

每个 import/export 语法位置生成一条边，`sourceRange` 是 edge identity 的一部分；每条边只有一个 Evidence。

两者都可遵守 `AD-4` 的实体 ID、`AD-5` 的 TypeScript 权威来源和 `AD-21` 的 Evidence 去重键，因为最新 `AD-4` 没有定义 edge ID，`AD-21` 只引用未定义的 `edgeId`，也没有规定 relation taxonomy。

**不兼容结果：** 图节点度数、规则违规数量、循环、PR 新增/删除边、Finding ID 和导出内容全部不同；同一 import 移动行号时 B 还会表现为删边+增边。

**处理：必须收紧 AD-4/AD-21，不可 Deferred。** 固定规范边键和方向；明确语法出现是 Evidence 而不是平行语义边；定义 MVP 关系类型及 import/export/re-export/dynamic import 的映射。若同一 from/type/to 允许平行边，必须显式说明区分维度。

### H2 — [High] 工作区状态把正交维度压成单一枚举，合法实现会选择不同优先级

**独立单元 A：graph-service 状态发布器**

初次索引已有部分提交时发布 `indexing`；后台刷新失败但有旧模型时发布 `failed`。

**独立单元 B：extension/webview 状态消费者**

相同场景分别期待 `partial` 和 `stale`，因为要决定是否显示已完成覆盖率或可继续操作的缓存。

两者都逐字遵守 `AD-7` 和 Consistency Conventions 中的固定枚举 `no-index/indexing/ready/refreshing/stale/failed/partial`，但这些状态不是互斥概念：lifecycle、activity、freshness、completeness 和 error 可以同时成立。

**不兼容结果：** UI、CLI status 和 service notification 对同一工作区显示不同状态；恢复动作和缓存可用性也会不同。

**处理：必须收紧 AD-7，不可 Deferred。** 将状态拆为正交字段，例如 lifecycle、activity、freshness、completeness、lastError/lastGoodRevision，并固定组合与转换；若仍保留单枚举，必须给出严格优先级和完整转换表。

### H3 — [High] View patch 只有 graph revision，没有查询身份或 view generation

**独立单元 A：`application/querying`**

对 graph revision 41→42 生成 Current Context(A) 的 patch，只携带 `baseRevision=41/nextRevision=42`。

**独立单元 B：extension/webview**

用户在 patch 到达前把中心切到 B；当前完整 ViewModel 仍基于 revision 41，因此客户端按 `AD-7` 认为 revision 连续并应用 A 的 patch。

双方都遵守 `AD-7` 的完整模型/增量 patch 和断档重取规则，也遵守 `AD-10` 的状态所有权。当前 AD 没有 `viewId/queryFingerprint/requestGeneration`，也没有枚举哪些状态属于 extension 的“语义状态”。

**不兼容结果：** 图、列表或详情把 A 的节点/Findings 混入 B 的查询；revision 连续性无法检测这种错误。扩展和 Webview 还可分别把 expanded aggregate 解释为语义查询状态或纯视觉状态。

**处理：必须收紧 AD-7/AD-10，不可 Deferred。** patch 必须绑定稳定的 query fingerprint/view generation；客户端仅对相同 query generation 应用 patch。明确 center、scope、filters、selection、view mode、context lock、expanded aggregate 的权威所有者及 reload 恢复顺序。

### H4 — [High] 规则变更可产生“同一 graphRevision、不同 Findings”

**独立单元 A：规则引擎**

有效 `rules.yaml` 变化时，在相同图谱上重新评估并更新 Findings，但不推进 graphRevision，因为图节点/边没有变化。

**独立单元 B：查询/导出/CLI 缓存**

按 `graphRevision` 缓存 Findings、GraphViewModel 和 ExportArtifact；revision 未变便继续返回旧结果。

两者都能遵守当前 AD：`AD-3` 只明确 GraphPatch 推进 graphRevision，`AD-9` 固定规则配置，`AD-17` 记录 Finding revision，`AD-20` 独立版本化 schema，但没有运行时 `rulesRevision/configDigest/evaluationRevision`。

**不兼容结果：** 同一个 graphRevision 在 Problems、CLI check、PR 摘要和导出中对应不同 Finding 集；`firstSeenRevision/lastSeenRevision` 也无法准确表达规则变更。

**处理：必须新增或收紧 AD，不可 Deferred。** 选择并固定一种模型：

1. 有效规则变更通过空图 GraphPatch 推进统一 graphRevision；或
2. 引入 `rulesRevision/configDigest`，所有 Finding、ViewModel、Job 和导出结果绑定 `(graphRevision, rulesRevision)`。

第二种语义更准确，但契约更宽；无论选择哪种都不能留给各模块自行决定。

### H5 — [High] Finding identity 的“规范证据签名”仍可包含易变定位信息

**独立单元 A：规则引擎**

按照 `AD-21` 的 Evidence 去重键，把 `normalizedRange`、`analyzerVersion` 纳入 `AD-17` 所称的“规范证据签名”。插入一行注释后 range 改变，生成新 Finding ID。

**独立单元 B：impact/export**

将同一 ruleId + canonical edge/cycle 视为同一 Finding，只更新 locator 和 lastSeenRevision。

两者均符合 `AD-17`，因为“规范证据签名”未定义；`AD-21` 反而提供了包含易变字段的合理候选。

**不兼容结果：** 无关行移动会把既有风险重新标为新增；IDE 与 PR 摘要对同一违规的稳定 ID、active/resolved 状态和计数不同。`resolved` 的保留期限也未定义，与 Deferred 中“不做历史趋势”存在解释空间。

**处理：必须收紧 AD-17，不可 Deferred。** 对依赖规则，Finding identity 应建立在 rule identity + canonical semantic edge + evaluation scope；range、provenance、analyzerVersion 是可更新 locator/evidence，不进入稳定 ID。循环 Finding 需定义成员/边集合的规范排序。另需明确 resolved 是短期比较结果还是持久记录及其保留边界。

## Medium Findings

### M1 — [Medium] `SourceRange/normalizedRange` 坐标约定缺失

**独立单元 A：TypeScript 分析器**使用零基 UTF-16 offset 或绝对字符 offset；**独立单元 B：VS Code Problems 适配器**按一基 Unicode code point 行列解释。双方都能声称输出/消费 `normalizedRange`，当前没有违反任何 AD。

**结果：** Problems、源码跳转、Finding identity 和 Evidence 去重偏移，尤其在 emoji、组合字符和 CRLF 文件中出现。

**处理：收紧 Consistency Conventions 或 AD-21。** 固定路径、零/一基、UTF-16/code point、半开/闭区间和换行标准。无需新增完整 AD，但不可 Deferred 到具体适配器。

### M2 — [Medium] `.codegraphignore` 的语法和生效权威未固定

**独立单元 A：graph-service scanner**采用 gitignore 语义、顺序覆盖和 `!` 反选；**独立单元 B：extension 的“将被索引范围”/doctor**采用普通 glob，无反选并按操作系统大小写匹配。`AD-9` 只定义规则 glob 的 `*`/`**`，没有明确 `.codegraphignore` 是否复用同一语法；`AD-14` 也没有规定有效索引范围只能由服务计算。

**结果：** UI 预览、实际图谱和规则覆盖范围不同，跨 Windows/Linux 结果漂移。

**处理：收紧 AD-9/AD-14。** 固定 `.codegraphignore` grammar、顺序/反选/目录/大小写语义，并规定服务是 effective scope 的唯一权威，客户端通过协议读取。不能仅 Deferred，因为它直接影响当前 MVP 图谱内容。

## 可以 Deferred 的边界

本轮发现中没有 Critical/High 项可安全 Deferred。以下细节可由共享 contracts/domain 包在首次实现后成为代码权威，无需继续膨胀脊柱：

- JSON 字段的具体排列顺序和 TypeScript 接口文件名；
- IPC capability 字符串的命名，只要协议 minor 协商契约测试固定；
- 状态文案、图标和具体错误提示；
- SQL 表结构与索引选择。

## 建议收敛顺序

1. 先修 `AD-3` 的 FactBatch replacement contract；这是静默数据破坏风险。
2. 再修规范 edge/evidence identity 与 Finding identity。
3. 决定 graphRevision 与 rulesRevision 的关系。
4. 将工作区状态拆为正交维度，并为 View patch 增加查询身份。
5. 补充 range 坐标和 ignore grammar 的一致性 convention。

完成以上调整后，再用同样方法复测：分析器与索引、规则与缓存、query 与 webview、extension 与 service-client、export 与 preview 五条接缝。
