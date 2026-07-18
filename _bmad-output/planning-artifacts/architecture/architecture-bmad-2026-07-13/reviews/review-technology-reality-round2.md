---
type: architecture-review
lens: technology-reality-round2
date: 2026-07-13
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
---

# Reviewer Gate 第二轮：技术现实核验

## Verdict

**通过。未发现 critical/high finding。** 第一轮的 TypeScript API、平台 VSIX 原生依赖边界和 VS Code 最低版本测试三个阻断项均已闭合；最新架构中的实际版本绑定存在且适配目标运行时。

## 阻断项复核

| 第一轮问题 | 最新架构修正 | 现实核验 | 结果 |
| --- | --- | --- | --- |
| TypeScript 7 没有稳定 Compiler API/Language Service | AD-5 与 Stack 改为 TypeScript 6.0.3，并明确排除 TypeScript 7 unstable API | `typescript@6.0.3` 官方 manifest 提供 `main: ./lib/typescript.js`、`tsc`、`tsserver`，Node 要求 `>=14.17`；传统 Compiler API/Language Service 可在 Node 24 Worker 中使用 | 已闭合 |
| VSIX 只计算 Node runtime/SQLite，且 esbuild 可能错误打包原生模块 | AD-12 要求 esbuild externalize `better-sqlite3`，平台步骤复制精确 `.node` 文件、Node runtime 与许可证 | Node 24.18.0 官方 ABI 为 137；`better-sqlite3@12.11.1` 支持 Node 24，并为 Windows x64、macOS arm64/x64、Linux x64 发布 Node ABI v137 预编译资产；VS Code 官方支持 platform-specific VSIX | 已闭合 |
| `engines.vscode` 下限 1.125.0 未被 CI 验证 | AD-12 要求 CI 同时验证 1.125.0、最新稳定版与前一稳定版 | 当前官方稳定序列为 1.128.0、1.127.0、1.126.0、1.125.1、1.125.0；测试矩阵覆盖最低承诺与当前宿主 | 已闭合 |

## 实际绑定版本核验

以下均为架构当前实际绑定项；未发现不存在、已撤回或与 Node 24 明显不兼容的版本：

| 技术 | 绑定版本 | 核验结论 |
| --- | --- | --- |
| Node.js | 24.18.0 Krypton LTS | 官方存在，Node ABI 137，四个 MVP 平台均有官方二进制 |
| TypeScript | 6.0.3 | 官方存在；稳定 JS Compiler API 与 tsserver；为解决 TS7 API 变化而有意锁定，不要求跟随 latest |
| pnpm | 11.12.0 | 官方存在；要求 Node >=22.13，与 Node 24 兼容 |
| VS Code API types | 1.125.0 | 官方包存在；与声明的宿主最低版本一致 |
| generator-code | 1.12.0 | Microsoft 官方版本存在；其 TypeScript 模板使用 6.0.3，支持 pnpm 与 esbuild 选项 |
| esbuild | 0.28.1 | 版本存在；与 Node 24 兼容；AD-12 已固定原生模块 externalize |
| vscode-jsonrpc | 9.0.1 | Microsoft 官方包存在；支持 standalone JSON-RPC stream channel，适配 Pipe/UDS 流 |
| better-sqlite3 | 12.11.1 | 版本存在；engines 包含 Node 24；目标平台 ABI 137 预编译资产存在 |
| yaml | 2.9.0 | 版本存在；支持 source token/CST、range 与 LineCounter 所需能力 |
| Ajv | 8.20.0 | 版本存在；支持 JSON Schema 2020-12 专用入口 |
| Cytoscape.js | 3.34.0 | 版本存在；适合预算内 Webview 局部图 |
| Vitest | 4.1.10 | 版本存在；engines 包含 Node >=24 |
| @vscode/test-cli | 0.0.15 | 版本存在；Node >=22 |
| @vscode/test-electron | 3.0.0 | 版本存在；Node >=22；可运行指定 VS Code 宿主版本 |
| @vscode/vsce | 3.9.2 | 版本存在；支持 `--target` 平台 VSIX |

## Critical / High Findings

无。

## 证据来源

- Node.js 官方发布索引：`https://nodejs.org/dist/index.json`
- npm Registry：`https://registry.npmjs.org/`
- VS Code 稳定版本 API：`https://update.code.visualstudio.com/api/releases/stable`
- VS Code platform-specific extensions：`https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions`
- better-sqlite3 v12.11.1 assets：`https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1`

