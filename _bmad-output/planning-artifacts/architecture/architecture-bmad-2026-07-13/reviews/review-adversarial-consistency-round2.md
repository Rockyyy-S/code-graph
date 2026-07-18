---
title: Reviewer Gate — 第二轮对抗性一致性审查
date: 2026-07-13
review_type: adversarial-consistency-round2
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第二轮对抗性一致性审查

## Verdict

**仍不建议直接定稿，但第一轮 critical 已基本消除。** 机械 lint 为 0 finding；FactBatch coverage、规范 edge、四维状态、view/query identity、graph/findings 双 revision 都已进入 AD。第二轮仍找到 6 个 high 孔洞：两个合规实现可以在提交时序、edge 形状、状态解释、patch 身份、revision 输出或 Finding 集合上产生不兼容结果。

## 第一轮重点闭环验证

| 检查项 | 结论 | 仍存缺口 |
| --- | --- | --- |
| FactBatch coverage | 大部分闭合 | 已有 complete/partial/failed 与遗漏删除规则；缺提交时 inputDigest 校验、analyzerVersion 升级替换和 tombstone 所有权边界。 |
| 关系/edge ID | 大部分闭合 | 已有 relationType、edge ID 和多 Evidence；`qualifierKey`、端点种类与关系方向仍可分叉。 |
| 四维状态 | 结构闭合、转换未闭合 | lifecycle/availability/freshness/completeness 已拆开，但合法组合、失败含义和状态转换未固定。 |
| view/query patch 身份 | 大部分闭合 | 已有 viewId/queryFingerprint 与双 revision；未规定 fingerprint 必须覆盖所有影响结果的参数和 configRevision。 |
| graph/findings revision | 核心存储闭合、公共输出未闭合 | ViewModel/patch 携带双 revision，但 CLI、导出、Job/一致性约定仍使用单一或模糊 revision。 |

## High Findings

### H1 — FactBatch 可在输入已变化后提交过期快照

**独立单元 A：分析 Worker**

读取文件内容 A，产生带 `inputDigest(A)` 的 complete FactBatch。分析期间文件被保存为 B。

**独立单元 B：indexing/GraphPatch 提交器**

只把 digest 当作审计字段，不在事务前与当前 manifest/最新内容 hash 比较，原子提交 A；后续 watcher 再尝试修正。

双方都遵守 `AD-3`（批次携带 digest、coverage，complete 可替换旧事实）和 `AD-8`（分析时重新读取文件并以 hash 为真相），因为没有 AD 要求 **commit-time compare-and-swap**。另一套同样合规的提交器可以在 digest 变化时拒绝并重排；两者会暴露不同 revision 和短期图谱。

**影响：** 保存后可能发布一个宣称 current、实则基于旧源码的 revision；规则 Finding、Problems 和导出可短暂错误，且原子事务无法补救语义过期。

**处理：收紧 AD-3/AD-8，不可 Deferred。** GraphPatch 必须绑定 analyzed input digest/manifest generation；提交前或事务内与服务当前已知输入版本比较，不匹配则不推进 graph/findings revision并重新排队。还应明确 analyzerVersion 是否属于 ownership identity：版本升级必须替换同一逻辑 slice 的旧事实，不能因版本不同永久并存。

### H2 — `qualifierKey` 与关系端点未定义，规范 edge 仍可不兼容

**独立单元 A：TypeScript analyzer/domain normalizer**

将 `imports` 建模为 file → resolved file，`qualifierKey` 恒为空；命名 import、default import 和 namespace import 都附着为 Evidence。

**独立单元 B：query/rules domain implementation**

将 `imports` 建模为 symbol → symbol，或将 import kind/export alias 放入 `qualifierKey`，从而为同一 from/to 产生多条 edge。

两者都满足 `AD-4` 的 relationType 和 edge hash 公式，也满足“多条 Evidence 附着到同一 edge”；当前没有规定每种关系允许的 from/to entity kind、方向、`qualifierKey` 的允许值及空值规则。

**影响：** 节点度数、目录/package 聚合、forbidden-dependency、循环、Finding ID、impact 新增/删除边和导出都不同。

**处理：收紧 AD-4，不可 Deferred。** 为 contains/imports/exports/references 固定端点类型、方向和 qualifier schema。若 MVP 的架构规则只基于文件依赖，应明确 symbol 关系如何投影到 canonical file edge，以及 import style 是否仅属于 Evidence。

### H3 — 四维状态缺少合法组合和失败边界

**独立单元 A：service status publisher**

增量 Job 失败但服务仍运行且有旧模型时发布：`lifecycle=failed, availability=available, freshness=stale, completeness=complete`。

**独立单元 B：extension consumer**

把 `lifecycle=failed` 解释为服务进程不可用，停止查询并显示重启；另一套发布器会对相同场景发送 `lifecycle=running` + stale + lastError。

两边都遵守 `AD-7` 的字段枚举和“刷新与失败保留最后模型”。当前没有说明 lifecycle failure 只表示服务生命周期失败，还是也表示索引/查询 Job 失败；也没有合法组合矩阵和转换所有者。

**影响：** 相同故障可能触发重启服务、rebuild、仅刷新或继续使用缓存等互相冲突的恢复路径。

**处理：收紧 AD-7，不可 Deferred。** 固定每个维度的唯一含义、合法组合与核心转换。Job failure 应进入 `lastError/operation status`，不得复用 service lifecycle failure；availability 必须明确是“可查询模型”而非“服务可连接”。

### H4 — queryFingerprint 未保证覆盖 configRevision 与所有结果参数

**独立单元 A：query service**

fingerprint 只包含中心实体、方向、深度和筛选；服务 reconfigure 后预算从 100/200 变为 200/400，但 graph/findings revision 和 fingerprint 不变，随后发送聚合形状不同的 patch。

**独立单元 B：webview**

按 `AD-7` 检查 viewId、queryFingerprint 和双 revision 均匹配，因此把新预算 patch 应用到旧聚合模型。另一套实现会把 budget/configRevision 纳入 fingerprint 或提升 view generation。

双方都遵守 `AD-7` 与 `AD-22`；`AD-22` 只要求广播 configRevision，未要求 GraphViewModel/patch 绑定它，也未定义 fingerprint 的规范输入集合。

**影响：** patch 可作用到结构不同的基模型，造成重复/缺失聚合节点、选中项错误或错误截断提示。

**处理：收紧 AD-7/AD-22，不可 Deferred。** queryFingerprint 必须由所有影响 ViewModel 形状/语义的有效参数规范化计算，至少包括 indexing root、中心/scope/filter、方向/深度、实际服务端预算、规则/置信度过滤和 configRevision；或引入每次有效查询变化必增的 opaque viewGeneration。

### H5 — graph/findings revision pair 未贯穿 CLI 与导出公共契约

**独立单元 A：graph-service/ViewModel**

规则配置变化时保持 `graphRevision=12`，推进 `findingsRevision=19`，正确向 Webview 返回双 revision。

**独立单元 B：CLI/export**

严格按 `AD-13` 输出只含 `graphRevision` 的 schemaVersion:1 envelope，并按 `AD-18` 输出单一 `revision`。CI 缓存或用户比较认为两次输出都基于 revision 12，忽略 Finding 已变化。

另一套实现可以额外输出 findingsRevision；两者都合规，因为 `AD-13` 明列 graphRevision，`AD-18` 使用未限定的 revision，Time convention 也仍是单数。

**影响：** 同一 CLI schemaVersion:1 的合法实现具有不同可缓存性；PR Markdown、AI 导出、check JSON 和 IDE 无法证明它们引用同一 evaluation snapshot。

**处理：必须收紧 AD-13、AD-18 和 Consistency Conventions，不可 Deferred。** 定义统一 `SnapshotRef { graphRevision, findingsRevision }`，所有含 Findings 或规则结论的 Query、Job result、CLI envelope、PR/AI ExportArtifact 都必须携带；纯图查询也应明确 findingsRevision 是否为空或绑定。

### H6 — `no-cycle` 的 Finding canonicalSubject 固定了单环 ID，却未固定报告集合

**独立单元 A：规则引擎**

对一个强连通分量枚举所有 simple directed cycles；每个 cycle 按 `AD-17` 做 edge 序列最小旋转，生成多个合规 Finding。

**独立单元 B：规则引擎/impact 基线实现**

每个强连通分量只选择一个确定性代表环并生成一个 Finding；该代表环同样使用最小旋转，因此也完全符合 `AD-17`。

**影响：** 同一代码图的 cycle Finding 数、严重级别计数、PR verdict、firstSeen/lastSeen 和导出内容可能数量级不同；枚举所有 simple cycles 还可能造成性能爆炸。

**处理：收紧 AD-9/AD-17，不可 Deferred。** 固定 no-cycle 的违规主体和报告粒度。MVP 更适合“一 个 SCC/自环 = 一个 Finding”，canonicalSubject 使用规范化成员节点/边集合；如选择代表环，必须固定代表选择算法并明确它只是证据路径而非 Finding identity。

## 未发现新的 Critical

第一轮的“complete FactBatch 以遗漏删除但没有 coverage 声明”已修复，当前没有足以直接造成不可恢复全局数据破坏的 critical。H1 仍可能发布短期错误 revision，但 watcher/reconciliation 提供最终恢复路径，因此评为 high。

## 建议收敛顺序

1. 统一 `SnapshotRef(graphRevision, findingsRevision)` 并贯穿所有公共结果。
2. 为 FactBatch/GraphPatch 增加 commit-time input digest CAS。
3. 固定每种 relation 的端点与 qualifier schema。
4. 固定四维状态合法组合/转换及 query fingerprint 输入集合。
5. 固定 no-cycle 的 SCC 级报告语义。

以上六项均属于当前 MVP 多模块共享契约，不能安全放入 Deferred。
