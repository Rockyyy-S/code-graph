---
title: Reviewer Gate — 第五轮最终对抗复核
date: 2026-07-13
review_type: adversarial-consistency-round5
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第五轮最终对抗复核

## Verdict

**FAIL：无 critical，仍有 1 个 high。** `AnalyzerConfigSnapshot/configDigest` 权威、普通 import target 优先级和 mixed type/value 拆边已闭合；re-export 的 canonical `exports` endpoint 仍允许两个合规实现产生不同 edge。

## 重点验证

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| AnalyzerConfigSnapshot 权威 | PASS | 只允许 graph-service 计算；v1 payload、consulted files、排序、JCS/UTF-8/SHA-256 和排除 rules.yaml 均已固定。 |
| configDigest/inputDigest CAS | PASS | 输入 schema、算法与提交前 manifest CAS 已形成单一权威路径，未再构造出跨 analyzer/application 的 high 分叉。 |
| 普通 import target | PASS | Node built-in、root 内 resolved file、root 外 purl、unresolved bare、unresolved relative 的优先级唯一。 |
| mixed type/value import | PASS | 已明确按 specifier 语义同时产生 type/value 两条 qualifier 不同的 canonical edge。 |
| re-export mapping | 部分通过 | imports side 与 qualifier 已固定，但 exports edge 的 target 仍可选 symbol 或 target file。 |

## High Finding

### H1 — named/star re-export 的 `exports` endpoint 未唯一化

**独立单元 A：symbol 精度 analyzer**

对：

```ts
export { foo } from "./module";
```

生成：

- `imports: exporting file → resolved target file, qualifier=value`
- `exports: exporting file → resolved foo symbol, qualifier=reexport`

对 `export * from "./module"`，枚举目标模块的可导出 symbol，生成多条 `exports(...→symbol, star)`。

**独立单元 B：module 精度 analyzer**

对相同语法生成相同 imports edge，但 exports side 为：

- `exports: exporting file → resolved target file, qualifier=reexport`
- `export *` 只生成一条 `exports: file → target file, qualifier=star`

两者都逐字遵守：

- `AD-4` 允许 exports 为 `exporting file → symbol/target file`；
- `AD-24` 只规定 named re-export 生成 `exports(reexport)`、star re-export 生成 `exports(star)`，没有规定 endpoint 或“一条/按 symbol 多条”的基数。

**不兼容结果：** 同一源码得到不同 edge ID、节点度数、export 关系数量、GraphViewModel、impact 新增/删除边、Evidence/Finding subject 和结构导出。两者无法仅靠共享 qualifier 收敛。

**处理：收紧 AD-4/AD-24，不可 Deferred。** 固定 v1 re-export canonical mapping。建议：

- named/default re-export：`exports` 指向 resolved target symbol；无法解析 symbol 时指向 target file 并降级置信度，不能两者同时生成；
- `export *` / `export type *`：只生成一条 file→target file 的 star edge，具体被转出的 symbols 不在 MVP 展开；
- 明确 edge 基数和 fallback，以防实现同时生成 symbol 与 file edge。

## 已闭合项的对抗结论

### AnalyzerConfigSnapshot / configDigest

未能再构造 critical/high 分叉。graph-service 是唯一计算者，Analyzer adapter 无权自行定义 digest；consultedFiles 与 effectiveCompilerOptions 的版本化 JCS payload 足以让 CAS 契约成为单一实现权威。

### import target 与 type/value

未能再构造 critical/high 分叉。跨 workspace package import 解析到 root 内文件时只能生成 file target，package 关系由投影派生；mixed declaration 必须生成两条 qualifier edge。

## 结论

本轮没有发现新的 critical。补齐 re-export endpoint/基数后，本 lens 预期可 PASS；其余差异已下降为实现细节或可由 contracts/测试固定的非 high 项。
