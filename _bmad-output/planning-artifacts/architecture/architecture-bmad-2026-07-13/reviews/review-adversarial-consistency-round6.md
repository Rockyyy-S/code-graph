---
title: Reviewer Gate — 第六轮最终对抗复核
date: 2026-07-13
review_type: adversarial-consistency-round6
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第六轮最终对抗复核

## Verdict

**FAIL：无 critical，仍有 1 个 high。** local/named re-export/star 的 endpoint 和声明级边基数已唯一化；`type|value` qualifier 对 TypeScript 类型/值双命名空间与隐式 type-only 导出仍没有唯一判定规则。

## 重点验证

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| local named/default endpoint | PASS | 每个导出绑定固定为 file→local symbol。 |
| named re-export endpoint | PASS | 每个 specifier 固定为 file→target module entity，不再允许 target symbol/file 二选一。 |
| star endpoint | PASS | 每个 declaration 固定一条 file→target module entity exports edge。 |
| qualifier 名称组成 | 基本通过 | local/default/reexport/star 均有版本化字符串结构，名称进入 qualifier。 |
| type/value 判定与边基数 | FAIL | class/enum/namespace 等双命名空间符号，以及未带 `type` 修饰但实际为 type-only 的 re-export，仍可产生一条或两条边。 |

## High Finding

### H1 — `type|value` 未规定按语法、运行时 emit 还是 SymbolFlags 判定

考虑以下合法或配置相关的 TypeScript 场景：

```ts
export class Service {}
export { Service };
export { Model } from "./types"; // Model 可能是 interface/type alias
```

**独立单元 A：运行时/语法优先实现**

- 未显式写 `type` 的 class export 只生成 `value` edge；
- `export { Model } from` 未写 `type`，按语法生成 `value` re-export edge；
- 只有 `export type`、interface、type alias 等明确不产生运行时值时生成 `type` edge。

**独立单元 B：TypeScript SymbolFlags 实现**

- class 同时拥有 type/value 两个 namespace，因此为同一绑定生成 `type` 与 `value` 两条 edge；
- 解析到 interface/type alias 的 named re-export 即使未写 `type`，也生成 `type` edge或排除 value edge；
- enum/namespace/merged declaration 也按符号能力产生一条或两条 edge。

两者都逐字遵守 `AD-24`：local qualifier 与 re-export qualifier 允许 `type|value`，且“每个导出绑定/specifier 生成一条”没有明确 qualifier 判定权威，也没有说明双命名空间符号是否例外地产生两条。`AD-5` 的 TypeScript 权威来源同样不能自动决定产品建模策略。

**不兼容结果：** 同一源码的 edge ID 和边基数不同；type-only 关系是否进入依赖图、package 聚合、规则、impact 和导出也随实现变化。对 class 产生双边还会令节点度数和变更摘要重复计数。

**处理：收紧 AD-24，不可 Deferred。** 固定 v1 的 qualifier 判定函数和边基数。建议采用 emit-aware 单边策略：

- 显式 `import type` / `export type`、interface/type alias 和确认无运行时 binding 的符号 → `type`；
- 其余可产生运行时 binding 的导入/导出 → `value`；
- class、enum、具有运行时值的 namespace/merged symbol 即使兼具类型能力也只生成 `value`，不为同一 binding 复制 type edge；
- 未显式 `type` 的 re-export 若目标仅存在于类型空间，按 TypeScript 6 当前 project 配置的有效语义生成 `type`，若为非法引用则只报诊断、不伪造 value edge；
- 明确每个 exported binding/specifier 最多一条 exports edge，除非语法本身是两个独立 binding。

具体选择也可以相反，但必须形成唯一函数，并以 fixture 覆盖 class、enum、interface、type alias、namespace、merged declaration 与 `verbatimModuleSyntax` 差异。

## 已闭合项的对抗结论

未能再构造 endpoint 或 declaration-level 基数的 critical/high 分叉：

- local export 只能指向 local symbol；
- named re-export 只能指向 target module entity，且每 specifier 一条；
- star 每 declaration 只有一条 exports edge；
- import side 与 export side 的 edge 数量分别明确。

## 结论

本轮没有发现新的 critical。补齐 `type|value` 的唯一判定函数与“每 binding 最多一条”规则后，本对抗 lens 可 PASS。
