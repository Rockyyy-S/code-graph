---
title: Reviewer Gate — 第四轮最终对抗复核
date: 2026-07-13
review_type: adversarial-consistency-round4
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第四轮最终对抗复核

## Verdict

**FAIL：无 critical，仍有 2 个 high。** edge/node 生命周期与 SCC no-cycle 已达到一致性要求；JCS inputDigest 和 TS/JS mapping 仍各留有一个可让独立合规实现不兼容的权威/映射缺口。

## 重点验证

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| JCS inputDigest | 部分通过 | RFC 8785、UTF-8、SHA-256、输入排序和原始文件 hash 已固定；`configDigest` 的规范输入对象及计算权威仍未固定。 |
| edge/node 生命周期 | PASS | 最后 active Evidence 消失时同事务删除 edge，聚合重算；外部 package/built-in 引用计数删除；内部节点由 slice 删除并清理关联关系。 |
| TS mapping | 部分通过 | 语法类别已收敛，但 resolved target 选择和 mixed type/value declaration 的 edge 生成仍可分叉。 |
| SCC no-cycle | PASS | 过滤后有向图、一 SCC/自环一 Finding、node-set identity 和确定性证据路径均已固定。 |

## High Findings

### H1 — `configDigest` 使用 JCS，但没有固定 digest 的规范输入及唯一计算权威

**独立单元 A：TypeScript analyzer adapter**

将相关 `tsconfig.json`、extends 链、package/workspace manifest 的 `{path, contentHash}` 数组作为 JCS 对象计算 `configDigest`。

**独立单元 B：indexing manifest/CAS**

将 TypeScript 解析后的 effective compilerOptions、project references、include/exclude 和服务 EffectiveServiceConfig 作为 JCS 对象计算 `configDigest`。

两者都逐字遵守 `AD-3` 的“configDigest 同法计算”：均使用 RFC 8785 JCS、UTF-8 与 SHA-256；但“同法”只固定了编码/哈希，没有固定输入 schema，也没有规定由服务计算后作为 opaque token 传给分析器，还是分析器自行计算。

**不兼容结果：** 若两个单元各自计算，所有 FactBatch 都可能 CAS 失败并无限重排；若恰好某些配置变化被一方纳入、另一方忽略，则会提交基于过期 TypeScript project 状态的图谱。

**处理：收紧 AD-3，不可 Deferred。** 固定一种权威：建议 graph-service 根据明确版本化的 `AnalyzerInputManifestV1` 计算 configDigest/inputDigest，派发给 Worker；AnalyzerPort 只回显 opaque digest，禁止适配器自行重算。若允许自行计算，则必须在 contracts 中固定 config digest 的完整 JCS payload schema及配置文件/effective option 的纳入规则。

### H2 — TS mapping 未固定 resolved target 优先级与 mixed type/value 拆边规则

**独立单元 A：文件精度实现**

`import {x} from '@app/core'` 解析到 workspace package 的 `src/index.ts` 后生成 `imports: importer file → target file`；package 依赖只由 `depends_on` 投影得到。对 `import {type Foo, bar} from './m'` 同时生成 qualifier=type 和 qualifier=value 两条 canonical edge。

**独立单元 B：package 精度实现**

对同一 bare workspace import 生成 `imports: importer file → internal package`；对 mixed declaration 因存在运行时绑定只生成 qualifier=value 一条 edge。

两者都遵守 `AD-4`：imports 目标允许 target file/internal package，qualifier 允许 value/type；也遵守 `AD-24`：静态 import 生成 imports(value/type)。当前没有定义同一 resolved module 同时属于 file 与 internal package 时的唯一 target，也没有定义 qualifier 是 declaration 级还是 specifier 级。

同类歧义还存在于 named re-export：`exports(reexport)` 的 target 可按 `AD-4` 选择 symbol 或 target file。

**不兼容结果：** edge ID、文件/package 循环、forbidden-dependency、节点度数、impact 和 Finding 集不同，且两者都能通过当前文字规则自证合规。

**处理：收紧 AD-4/AD-24，不可 Deferred。** 固定 resolved target 优先级与投影规则，例如内部可解析模块始终生成 file→file imports，internal package 只由聚合投影产生；外部解析只指向 purl。固定 import qualifier 以 specifier 语义归并：同一 from/to 同时存在 type/value specifier 时生成两条不同 qualifier edge。对 named/star re-export 同样明确 imports edge 与 exports edge 的唯一 endpoint。

## 已闭合项的对抗结论

### edge/node 生命周期

未能再构造 high 分叉。`AD-24` 已明确 canonical edge、聚合投影、外部 package/built-in 和内部 ownership node 的删除路径，两个存储实现不能再合法地分别选择“保留幽灵 edge”与“最后 Evidence 即删除”。

### SCC no-cycle

未能再构造 high 分叉。`AD-9` 固定一 SCC/自环一 Finding，`AD-17` 固定 SCC node-set identity 与证据路径算法，simple-cycle 枚举与 SCC 代表模式不再同时合规。

## 结论

本轮没有发现新的 critical。补齐 `configDigest` 权威输入/所有者和 TS resolved-target/mixed-import 映射后，四个重点接缝即可通过最终对抗检查；届时若机械 lint 仍为 0，可判定该审查 lens 为 PASS。
