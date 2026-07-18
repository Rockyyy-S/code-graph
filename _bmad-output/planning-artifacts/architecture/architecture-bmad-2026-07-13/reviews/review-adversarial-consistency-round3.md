---
title: Reviewer Gate — 第三轮最终对抗复核
date: 2026-07-13
review_type: adversarial-consistency-round3
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第三轮最终对抗复核

## Verdict

**FAIL：无 critical，仍有 4 个 high。** 第二轮重点中的合法状态组合、queryFingerprint 和 graph/findings 双 revision 公共契约已闭合；inputDigest CAS、ownership slice 与 relation contract 已显著加强，但仍有跨独立单元可产生不兼容结果的细节。

## 重点闭环验证

| 检查项 | 结果 | 判断 |
| --- | --- | --- |
| inputDigest CAS | 部分通过 | 已强制 commit 前 CAS，但 digest 的算法与规范字节表示未固定，分析器和核心仍可计算出不同值。 |
| ownership slice | 部分通过 | v1 slice 类别与 analyzerVersion 替换已固定；canonical edge 与外部 package/node 的生命周期仍无所有者。 |
| relation endpoint/qualifier | 部分通过 | 端点集合、方向与 qualifier 枚举已固定；同一语法命中多个允许映射时缺少唯一选择规则。 |
| 合法状态组合 | PASS | 四维含义、availability 约束、service fatal 与 Job failure 已分离，未构造出新的 high 不兼容实现。 |
| queryFingerprint | PASS | 已覆盖影响 ViewModel 的查询参数、预算、聚合、ranking、expand lineage 与 configRevision，并与 viewId、双 revision 一起校验。 |
| 双 revision 公共契约 | PASS | ViewModel、patch、Job、CLI、PR/AI 导出与一致性约定均同时携带 graphRevision/findingsRevision。 |

## High Findings

### H1 — inputDigest 的规范算法未固定，CAS 可在合规实现间永久失败

**独立单元 A：`analyzer-typescript`**

把排序后的 `{path, contentHash, configDigest}` 以 JSON UTF-8 编码后做 SHA-256。

**独立单元 B：`application/indexing`**

把相同字段按 `path\0contentHash\0configDigest\n` 拼接，或采用平台默认字符串编码后做集合哈希。

两者都逐字遵守 `AD-3` 的“排序后的 path/contentHash/configDigest 集合哈希”，但生成值不同。B 在提交前对当前 manifest 做 CAS 时会拒绝 A 的每个批次；另一组合实现又可能正常工作。

**影响：** 索引 Job 可持续重排、永不推进 revision；问题发生在 analyzer/application 接缝，不能由 TypeScript 类型检查发现。

**处理：收紧 AD-3，不可 Deferred。** 固定 digest 算法、字段顺序、UTF-8、长度前缀或明确分隔、路径规范化及空值编码；更稳妥的替代是由 graph-service 在派发分析任务时生成 opaque inputGeneration，FactBatch 原样回传，提交器同时验证 generation 与服务侧 digest，分析器不自行重算跨层 hash。

### H2 — canonical edge 与外部 package/node 在 Evidence 消失后没有生命周期不变量

**独立单元 A：GraphPatch/store 实现**

source slice 的 complete 快照删除最后一条 Evidence 后，同时垃圾回收 canonical edge；若外部 npm package 或 Node built-in 不再被任何边引用，也删除节点。

**独立单元 B：GraphPatch/store 实现**

严格只删除 ownership slice 明确拥有的 symbol/Evidence，保留无 Evidence 的 edge 及曾出现过的外部 package/node，因为 `AD-3` 没有任何 slice 拥有它们，`AD-4` 也未规定存在条件。

两者都遵守当前 ownership 规则。B 甚至更保守地避免跨 slice 删除，但会留下幽灵关系/节点；A 则采用派生对象 GC。

**影响：** query、节点度数、package 聚合、规则、impact 和导出在删除 import 后产生不同结果；无 Evidence edge 是否能被 `AD-21` 的规则引擎评估也不明确。

**处理：收紧 AD-3/AD-4，不可 Deferred。** 固定 canonical edge 的存在条件，例如“至少有一条有效 Evidence；最后 Evidence 删除时同事务删除 edge”；固定外部 package/built-in 节点由解析事实 slice 拥有，或在零入/出规范边时同事务 GC。派生 `depends_on` 投影也应明确是查询时生成还是随 GraphPatch 物化。

### H3 — 关系端点/qualifier 集合已固定，但同一语法的唯一映射仍未固定

**独立单元 A：跨 workspace package import 分析器**

`import {x} from '@app/core'` 解析到内部源码文件时生成 `imports: importer file → target file, qualifier=value`，package 关系由 `depends_on` 聚合投影产生。

**独立单元 B：同样合规的分析器**

对相同语句生成 `imports: importer file → internal package, qualifier=value`，因为 `AD-4` 明确允许 imports 的 target 为 target file 或 internal package。

同样，`export * from './m'` 可被一个实现映射为 `exports → target file, qualifier=star`，另一个映射为 `qualifier=reexport`；`named/default/star` 与 `reexport` 实际是两个正交维度，但被放入同一 qualifier 枚举。

**影响：** 相同源码生成不同 edge ID、目录/package 聚合、循环和 Finding；Beta 的跨 package import 验收也无法使用单一预期图谱。

**处理：收紧 AD-4，不可 Deferred。** 给出语法到 canonical relation 的优先级/唯一映射表。建议 imports 始终指向最具体 resolved target（内部文件或外部 package），内部 package 依赖只作为投影；exports 将 `exportKind` 与 `isReexport` 分为规范 qualifier 组合，或明确 re-export 的唯一 endpoint/qualifier。

### H4 — `no-cycle` Finding ID 固定了单环规范化，却仍未固定要报告哪些环

**独立单元 A：规则引擎**

在一个 SCC 中枚举所有 simple directed cycles，每个环按 `AD-17` 做 edge 序列字典序最小旋转并生成 Finding。

**独立单元 B：规则引擎**

每个 SCC 只选择一个确定性代表环；该环也按同样规则生成 Finding ID。

双方都完全遵守 `AD-9` 的 no-cycle scope 与 `AD-17` 的 cycle canonicalSubject，但 Finding 数量、firstSeen/lastSeen、PR verdict 和性能特征可能数量级不同。

**影响：** CLI check、Problems、Changes 和导出对同一图给出不同违规集合；全 simple-cycle 枚举还可能突破性能门禁。

**处理：收紧 AD-9/AD-17，不可 Deferred。** 固定报告主体。MVP 建议“一个 SCC 或自环 = 一个 Finding”，Finding identity 基于 scope + 规范化成员节点/edge 集合；代表环仅作为可解释证据路径，不作为违规集合身份。

## 结论

未发现新的 critical。状态、view/query patch identity 和双 revision 已达到 initiative spine 所需的一致性强度。剩余 4 项均发生在 analyzer/indexing/domain/rules 的共享接缝，不能依赖单个实现单元自行收敛；补齐后可再运行一次轻量对抗复核，若无新增 critical/high 即可 PASS。
