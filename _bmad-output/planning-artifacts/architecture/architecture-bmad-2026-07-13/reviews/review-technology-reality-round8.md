---
type: architecture-review
lens: technology-reality-round8
date: 2026-07-13
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
---

# Reviewer Gate 第八轮：ImportEqualsDeclaration 最终技术复核

## Verdict

**PASS。未发现 critical/high finding。** AD-24 已准确对齐 TypeScript 6.0.3 稳定 AST 对 `ImportEqualsDeclaration` 的建模，上一轮 High 已闭合。

## 定点复核

| 检查项 | 最新规则 | TS6 技术现实 | 结果 |
| --- | --- | --- | --- |
| type/value qualifier | `ImportEqualsDeclaration.isTypeOnly` 为 true 时生成 type，否则 value | TS6 稳定公开声明提供只读 `isTypeOnly: boolean`，无需 emit、SymbolFlags 或私有 API | 通过 |
| 外部 import-equals | 仅当 `moduleReference` 为 `ExternalModuleReference` 且 expression 为字符串 literal 时生成 imports | TS6 将 `import x = require("pkg")` 表示为 ExternalModuleReference；可用公开 AST guard 与字符串 literal guard 稳定识别 | 通过 |
| 内部 import-equals | `EntityName` 内部别名不生成模块 edge | TS6 的另一种 ModuleReference 正是 EntityName；它没有模块 specifier，不进入模块依赖图是技术上正确的边界 | 通过 |
| 其余 syntax-only mapping | statement/specifier-level type modifier 决定 type；其余静态 import/export 为 value；混合 specifier 拆边 | `ImportClause.isTypeOnly`、`ImportSpecifier.isTypeOnly`、`ExportDeclaration.isTypeOnly`、`ExportSpecifier.isTypeOnly` 均可由 TS6 稳定 AST 提供 | 通过 |
| 现有技术绑定 | TypeScript 6.0.3、Node 24.18.0、平台 VSIX、externalized `better-sqlite3@12.11.1` | 版本与平台规则未变化；未重新引入 TS7 unstable API 或 Electron ABI 依赖 | 通过 |

## Critical / High Findings

无。

## 证据来源

- TypeScript 6.0.3 declarations：`https://unpkg.com/typescript@6.0.3/lib/typescript.d.ts`
- TypeScript 6.0.3 manifest：`https://registry.npmjs.org/typescript/6.0.3`
- Node.js releases：`https://nodejs.org/dist/index.json`
- better-sqlite3 assets：`https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1`

