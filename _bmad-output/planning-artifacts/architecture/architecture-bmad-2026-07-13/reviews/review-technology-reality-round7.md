---
type: architecture-review
lens: technology-reality-round7
date: 2026-07-13
artifact: ../ARCHITECTURE-SPINE.md
verdict: fail
critical: 0
high: 1
---

# Reviewer Gate 第七轮：syntax-only qualifier 技术确认

## Verdict

**FAIL：1 项 High。** syntax-only type/value 判定总体可由 TypeScript 6 稳定 AST 实现，但 AD-24 对 `import-equals` 的绑定与 TS6 真实 AST 不一致，会让两个实现生成不同 qualifier 或错误模块边。

## Critical / High Findings

### TR7-1 — [HIGH] `import-equals 一律 value` 与 TS6 的 `isTypeOnly`、两类 moduleReference 冲突

AD-24 同时规定：

- statement-level `import type` 判为 type；
- `import-equals` 一律判为 value 并生成 imports。

TypeScript 6.0.3 的稳定公开声明实际定义为：

```ts
interface ImportEqualsDeclaration {
  readonly isTypeOnly: boolean;
  readonly moduleReference: ModuleReference;
}
```

这产生两个现实冲突：

1. TypeScript 支持 type-only import-equals；其 `isTypeOnly=true`。一个实现会按“statement-level import type”生成 type，另一个会按“import-equals 一律 value”生成 value，直接违反 AD-24 试图保证的唯一 qualifier。
2. `moduleReference` 不只包含 `ExternalModuleReference`（`require("...")`），也可以是内部 `EntityName` 别名。后者没有模块 specifier/target module entity，不能按当前规则统一生成 imports edge。

需要把规则收敛为等价于：

- 只有 `moduleReference` 为带字符串 literal 的 `ExternalModuleReference` 时，import-equals 才进入模块 imports 映射。
- qualifier 读取公开的 `ImportEqualsDeclaration.isTypeOnly`：true → type，false → value。
- EntityName 形式的内部 import-equals 不生成模块 imports；MVP 未启用 references 时可忽略或只记分析诊断。

该修正不需要新增依赖或更换 TypeScript 版本；TS6 稳定 AST 已提供全部判定信息。

证据：

- TypeScript 6.0.3 declarations：`https://unpkg.com/typescript@6.0.3/lib/typescript.d.ts`

## 其他技术绑定

未发现其他 critical/high：

- `ImportClause.isTypeOnly`、`ImportSpecifier.isTypeOnly`、`ExportDeclaration.isTypeOnly`、`ExportSpecifier.isTypeOnly` 足以实现其余 syntax-only type/value 判定。
- TypeScript 6.0.3 稳定 Compiler API 绑定继续有效。
- RFC 8785/JCS、npm purl、SCC 语义未变化。
- Node 24.18.0、平台 VSIX、externalized `better-sqlite3@12.11.1` 与 VS Code 最低版 CI 未引入新风险。

