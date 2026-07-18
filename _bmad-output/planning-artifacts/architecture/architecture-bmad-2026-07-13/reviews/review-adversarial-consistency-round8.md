---
title: Reviewer Gate — 第八轮最终对抗确认
date: 2026-07-13
review_type: adversarial-consistency-round8
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第八轮最终对抗确认

## Verdict

**PASS：未发现 critical/high。** `ImportEqualsDeclaration` 的外部模块/内部别名分流、字符串 literal 限制、`isTypeOnly` qualifier 和目标解析优先级已令 edge 是否存在、数量与 ID 唯一。

## 验证矩阵

| TypeScript 形态 | 唯一规范结果 | 结论 |
| --- | --- | --- |
| `import x = require("pkg")` | `ExternalModuleReference` + string literal；生成一条 `imports(value)`，target 按 AD-24 解析优先级确定 | PASS |
| `import type x = require("pkg")` | `isTypeOnly=true`；生成一条 `imports(type)` | PASS |
| `import x = require("./local")` | resolvedFileName 位于 root 内时 target 必须为 file | PASS |
| `import x = require("node:fs")` | Node built-in 优先，target 唯一 | PASS |
| `import x = require("external")` | root 外 resolved package 使用最近 package.json 版本 purl；未解析 bare 使用 unresolved purl/medium | PASS |
| `import x = Namespace.Member` | moduleReference 为 EntityName；明确不生成模块 edge | PASS |
| ExternalModuleReference 非字符串 literal | 明确不生成 imports edge | PASS |
| 同一语句的 type/value 判定 | 只读 `ImportEqualsDeclaration.isTypeOnly`，禁止 emit/SymbolFlags 推断 | PASS |

## 尝试构造的合规分叉

### 1. 将 EntityName 内部别名当作模块依赖

该实现会违反“EntityName 内部别名不生成模块 edge”，不再合规。

### 2. 按目标 SymbolFlags 将普通 ImportEquals 拆成 type/value 双边

该实现违反“type/value 只按源码语法”和 `isTypeOnly` 规则；普通声明只能产生 value edge。

### 3. 对 `import type = require(...)` 仍生成 value edge

直接违反 `ImportEqualsDeclaration.isTypeOnly 为 type`。

### 4. 对同一 external ImportEquals 同时生成 file 与 package edge

目标解析优先级只允许首个命中目标；workspace package 关系只能由投影派生，不能生成平行 canonical imports edge。

### 5. 非 literal external reference 的启发式模块 edge

违反“expression 为字符串 literal 时才生成”，只能不建 edge。

## 结论

机械 lint 为 0 finding；对抗复核未发现 critical/high。ImportEquals 的 AST 分流、qualifier、边基数和 target identity 已闭合，本审查 lens PASS。
