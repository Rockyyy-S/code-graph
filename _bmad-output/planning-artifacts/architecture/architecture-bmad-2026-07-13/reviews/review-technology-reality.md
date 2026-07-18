---
type: architecture-review
lens: technology-reality
date: 2026-07-13
artifact: ../ARCHITECTURE-SPINE.md
verdict: fail
critical: 1
high: 2
medium: 4
---

# Reviewer Gate：技术现实核验

## Verdict

**不通过。** 大多数版本和平台交付选择当前、存在且相互兼容，但 AD-5 绑定了一个当前不存在的稳定 API：`typescript@7.0.2` 没有架构所依赖的公开 Compiler API/Language Service。该问题会直接阻断核心分析器实现，必须在架构定稿前修正。

## Critical / High Findings

### TR-1 — [CRITICAL] TypeScript 7 不提供 AD-5 所声明的公开 Compiler API

AD-5 要求：

> 使用 TypeScript 7 的公开 Compiler API 维护增量 Program/Language Service。

当前官方 npm 包 `typescript@7.0.2` 确实存在且为 latest，但其官方 package manifest 显示：

- 包根 `typescript` 只导出 `./lib/version.cjs`。
- `./lib/version.cjs` 只提供 `version` 与 `versionMajorMinor`。
- 可编程 API 仅位于 `typescript/unstable/async`、`typescript/unstable/sync`、`typescript/unstable/ast` 等明确标记为 `unstable` 的导出。
- 包不再提供 TypeScript 6 时代的 `main: ./lib/typescript.js` 与 `tsserver`；只有 `tsc` 命令。

对照 `typescript@6.0.3`：其 manifest 仍包含 `main: ./lib/typescript.js`、`tsc` 和 `tsserver`，即传统稳定 Compiler API/Language Service 可编程表面。

因此，以下实现不会在 TS 7 上成立：

```ts
import ts from "typescript";
ts.createProgram(...);
ts.createLanguageService(...);
```

风险不是“版本可能较新”，而是架构主分析路径绑定到不存在的稳定接口。两个现实选项：

1. **建议：分析器固定 TypeScript 6.0.3 的稳定 Compiler API。** 项目本身仍可使用其他 TypeScript 版本编译，但 analyzer 依赖明确固定在 TS 6 API，并通过 fixture 验证能解析 TS 7 项目语法/配置的范围。
2. **若坚持 TypeScript 7：** AD-5 必须改为依赖 `typescript/unstable/*` 或直接驱动 `tsc`/原生服务进程，并把 API 不稳定、协议变化、平台二进制和降级方案列为显式风险；不能继续称为“公开稳定 Compiler API/Language Service”。

证据：

- `https://registry.npmjs.org/typescript/7.0.2`
- `https://unpkg.com/typescript@7.0.2/lib/version.cjs`
- `https://registry.npmjs.org/typescript/6.0.3`

### TR-2 — [HIGH] TypeScript 7 也是平台原生依赖，AD-12 的发布边界漏算了它

`typescript@7.0.2` 依赖 `@typescript/typescript-<platform>-<arch>` 原生包。以 Windows x64 为例，`@typescript/typescript-win32-x64@7.0.2`：

- 限定 `os: win32`、`cpu: x64`。
- 解包约 28.4 MB。
- 不是可被 esbuild 直接内联的纯 JavaScript Compiler API。

AD-12 只明确 VSIX 携带 Node 24 runtime 与对应 Node ABI 的 SQLite 模块，却未把 TypeScript 7 原生分析器二进制纳入平台清单、许可清单、包体与 smoke test。若 TR-1 选择 TypeScript 6 稳定 API，此问题大幅简化；若保留 TS 7，四个平台 VSIX 都必须额外验证对应 TypeScript 原生包被正确裁剪、复制、授权并能由服务调用。

同时，esbuild 不能把 `better-sqlite3` 的 `.node` 文件或 TypeScript 7 平台二进制当普通 JS 打包。构建必须显式 externalize 这些依赖，再由平台打包步骤复制精确目标文件。

证据：

- `https://registry.npmjs.org/@typescript/typescript-win32-x64/7.0.2`
- `https://registry.npmjs.org/typescript/7.0.2`

### TR-3 — [HIGH] `engines.vscode: 1.125.0` 的兼容承诺没有由当前 CI 规则验证

`@types/vscode@1.125.0` 存在，VS Code 官方稳定发布序列当前为 1.128.0、1.127.0、1.126.0、1.125.1、1.125.0，因此把 1.125.0 设为下限在版本现实上成立。

问题在于 AD-12 只要求 CI 验证“最新稳定版与前一稳定版”。这能验证 1.128/1.127，却不能证明扩展仍兼容所承诺的最低版本 1.125。实现者可无意使用 1.126+ API，类型检查与最新两版测试全部通过，但 1.125 用户运行失败。

发布门禁应至少覆盖：

- 最低支持版 1.125.x。
- 最新稳定版。
- 可选：前一稳定版，用于发现最近回归。

如果不准备持续测试 1.125，则应把 `engines.vscode` 下限随实际测试矩阵提升，而不是保留未经验证的兼容承诺。

证据：

- `https://update.code.visualstudio.com/api/releases/stable`
- `https://registry.npmjs.org/@types/vscode/1.125.0`

## Medium Findings

### TR-4 — [MEDIUM] 官方 starter 存在，但不是架构所暗示的开箱即用组合

`generator-code@1.12.0` 是 Microsoft 官方、当前 latest 的 Yo Code generator，确实支持：

- `--pkgManager pnpm`
- `--bundle esbuild`
- TypeScript extension 模板

但其实际默认值是 npm + unbundled；1.12.0 模板依赖版本为 TypeScript `^6.0.3`、esbuild `^0.28.1`。它只生成单扩展骨架，不生成当前架构的 pnpm monorepo、本地服务、CLI、Webview 四应用组合。

因此 `generator-code` 可以作为 `apps/extension` 的局部种子，但不能被描述成整个仓库的 starter，也不能声称其 live defaults 已经是 pnpm + esbuild + TypeScript 7。实施时需固定显式命令和后续改造步骤，例如选择 pnpm/esbuild，并把生成物移入 monorepo；若采纳 TR-1 建议，模板的 TypeScript 6.0.3 反而与稳定 Compiler API 路线一致。

证据：

- `https://github.com/microsoft/vscode-generator-code/tree/v1.12.0`
- `https://raw.githubusercontent.com/microsoft/vscode-generator-code/v1.12.0/generators/app/dependencyVersions/package.json`
- `https://raw.githubusercontent.com/microsoft/vscode-generator-code/v1.12.0/generators/app/prompts.js`

### TR-5 — [MEDIUM] Ajv 8.20 可支持 JSON Schema 2020-12，但不能使用默认 Ajv 类

`ajv@8.20.0` 当前、存在且适配 Node 24。JSON Schema 2020-12 需要使用 Ajv 的 2020 专用入口/类（通常为 `Ajv2020`），不能把默认 draft-07 实例当成 2020-12 validator。AD-9 的技术选择可行，但实施说明或契约测试应固定：

- 使用 2020-12 validator 入口。
- strict mode 打开。
- 将 `rules-v1.schema.json` 自测为有效 schema。
- 用未知字段、判别联合、重复 ID、非法 glob 的负例做契约测试。

`yaml@2.9.0` 同样可行；官方文档确认 `keepSourceTokens`、`srcToken`、节点 `range` 与 `LineCounter` 可用于 CST/source token 和定位。实现必须显式开启这些选项，默认解析不会自动保留全部所需信息。

证据：

- `https://registry.npmjs.org/ajv/8.20.0`
- `https://ajv.js.org/json-schema.html`
- `https://registry.npmjs.org/yaml/2.9.0`
- `https://eemeli.org/yaml/`

### TR-6 — [MEDIUM] Cytoscape.js 可用，但“布局在 Web Worker”不是现成的一键能力

`cytoscape@3.34.0` 当前、存在且适合几十到数百节点的 Webview 局部图。官方文档支持浏览器中的 headless instance，因此在 Worker 内创建 headless graph、计算位置、再传回主线程具有技术可行性。

但 Cytoscape.js 官方文档没有提供通用的内建 Web Worker 布局开关。不同 layout 扩展对 DOM、样式维度、线程环境的要求不同。AD-15 仍可保留，但实施必须选定并实测 worker-safe layout；不能假设任意 Cytoscape layout 都能搬入 Worker。必要时应把“Worker 只计算位置，主线程 Cytoscape 只渲染”作为明确边界。

证据：

- `https://registry.npmjs.org/cytoscape/3.34.0`
- `https://js.cytoscape.org/`

### TR-7 — [MEDIUM] 捆绑 Node runtime 可行，但“精简”必须定义且需保留许可材料

AD-12 的总体路线可行：

- Node.js 24.18.0 是 Krypton LTS，官方为 Windows x64、macOS x64/arm64、Linux x64 提供二进制。
- VS Code 官方支持通过 `vsce --target` 发布 platform-specific VSIX，并明确把 native Node modules 作为典型用例。
- Node.js MIT 许可允许再分发，但要求在副本或重要部分中保留版权和许可声明；Node 分发还含第三方许可。
- `better-sqlite3@12.11.1` engines 明确包含 Node 24；其 v12.11.1 release 为 Node ABI v137 提供 Windows x64、macOS x64/arm64、Linux x64 预编译资产，与 Node 24.18.0 的 `modules: 137` 对应。

剩余问题是“精简 Node runtime”没有官方固定定义。安全做法是从官方 archive 复制经逐平台 smoke test 的最小运行集合，同时携带 Node LICENSE/第三方 notices；不要未经验证地删除运行时所需文件。Unix 执行权限、macOS 签名/隔离、Linux libc 基线与 VSIX 解包后可执行性都应在真实安装产物中测试。

证据：

- `https://nodejs.org/dist/index.json`
- `https://nodejs.org/dist/v24.18.0/`
- `https://raw.githubusercontent.com/nodejs/node/v24.18.0/LICENSE`
- `https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions`
- `https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1`

## 已核实为当前且适配的绑定

| 绑定项 | 版本 | 现实核验 |
| --- | --- | --- |
| Node.js LTS | 24.18.0 | 存在；Krypton LTS；Node ABI 137；四个目标平台均有官方二进制 |
| pnpm | 11.12.0 | 存在；latest；要求 Node >=22.13，与 Node 24 兼容 |
| esbuild | 0.28.1 | 存在；latest；Node >=18；适合 extension/webview JS 构建，原生依赖需 externalize |
| vscode-jsonrpc | 9.0.1 | 存在；latest；Microsoft 仓库；支持 standalone JSON-RPC channel 与 StreamMessageReader/Writer，可用于 Node net.Socket 的 Pipe/UDS 流 |
| better-sqlite3 | 12.11.1 | 存在；latest；支持 Node 24；Node ABI 137 的全部 MVP 平台预编译资产存在 |
| yaml | 2.9.0 | 存在；latest；CST/source token、range、LineCounter 能力满足配置诊断需求 |
| Ajv | 8.20.0 | 存在；latest；支持 2020-12，但必须使用对应入口 |
| Cytoscape.js | 3.34.0 | 存在；latest；适合预算内局部图；Worker layout 需专项验证 |
| Vitest | 4.1.10 | 存在；latest；engines 包含 Node >=24 |
| @vscode/test-cli | 0.0.15 | 存在；latest；Node >=22 |
| @vscode/test-electron | 3.0.0 | 存在；latest；Node >=22；可下载指定 VS Code 版本做宿主测试 |
| @vscode/vsce | 3.9.2 | 存在；latest；Node >=20；官方支持 platform-specific `--target` |
| generator-code | 1.12.0 | 存在；latest；Microsoft 官方；仅适合作为 extension 局部脚手架 |
| VS Code API types | 1.125.0 | 存在；当前稳定 VS Code 已到 1.128；下限可行但必须测试最低版 |

## 处置建议

在 Reviewer Gate 通过前：

1. 必须裁决 TR-1：改用 TypeScript 6 稳定 Compiler API，或显式接受 TypeScript 7 unstable API/原生进程方案。
2. 若保留 TS 7，更新 AD-12 的平台产物清单与 CI，纳入 TypeScript 原生二进制。
3. 把 VS Code 最低支持版加入 CI 矩阵。

其余中等级问题可在实施说明和发布门禁中关闭，不要求改变总体架构范式。

