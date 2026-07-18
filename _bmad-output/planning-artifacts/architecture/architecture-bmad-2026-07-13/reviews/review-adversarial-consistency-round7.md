---
title: Reviewer Gate — 第七轮最终对抗确认
date: 2026-07-13
review_type: adversarial-consistency-round7
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第七轮最终对抗确认

## Verdict

**PASS：未发现 critical/high。** `type/value` 已由源码修饰符唯一判定，endpoint、qualifier、每 binding/specifier/declaration 的边基数和 deterministic edge ID 共同阻止两个合规实现产生不同 edge 数或 ID。

## 验证结果

| 对抗场景 | 唯一结果 | 结论 |
| --- | --- | --- |
| class/enum/namespace 等 type/value 双命名空间符号 | 未写 `type` 修饰符时只生成 `value`，禁止读取 SymbolFlags 再复制 type edge | PASS |
| interface/type alias 或其他类型声明 | 仅按源码是否属于 statement-level `export type` / specifier-level `type` 判定，不允许实现自行改用 emit/SymbolFlags | PASS；即使产品语义可另行讨论，实现结果唯一 |
| mixed import/re-export specifier | 每个 specifier 独立判定，type/value 分别形成 qualifier 不同的 edge | PASS |
| local named/default export | 每个 exported binding 一条 file→local symbol edge，exportedName 与 type/value 进入 qualifier | PASS |
| named re-export | 每个 specifier 一条 imports edge和一条 file→target module entity exports edge，imported/exported name 与 type/value 进入 qualifier | PASS |
| `export *` / `export type *` | 每 declaration 各一条 imports 与 exports edge，star:type/value 唯一 | PASS |
| 同一位置被 TypeScript 同时识别为类型和值 | `AD-24` 明令不读取 emit 结果或 SymbolFlags，不能合法生成双边 | PASS |
| 重复等价声明/Evidence | edge ID 由 workspace、relation、from、to、qualifier 确定，相同语义合并为同一 canonical edge并保留多 Evidence | PASS |

## 尝试构造的合规分叉

### 1. 语法优先 vs SymbolFlags 优先

SymbolFlags 优先实现会为 class 生成 type/value 两条边，但最新 `AD-24` 明确禁止读取 SymbolFlags 决定 qualifier，因此不再是合规实现。

### 2. mixed declaration 合并为 value vs 拆成 type/value

合并实现违反“混合 declaration 按 specifier 独立拆边”；只有按 specifier 生成的结果合规。

### 3. named re-export 指向 symbol vs module

symbol endpoint 实现违反“file→target module entity”；endpoint 已唯一。

### 4. star 展开全部 symbols vs declaration-level 单边

逐 symbol 展开违反“每个 declaration 一条 exports edge”；只能生成 module-level star edge。

### 5. 重复声明产生平行 canonical edge

平行边会得到相同 edge ID，违反确定性规范边与多 Evidence 模型；合法实现只能合并。

## 结论

机械 lint 为 0 finding；本轮也未发现语义 critical/high。该对抗一致性 lens 可以通过 Reviewer Gate。
