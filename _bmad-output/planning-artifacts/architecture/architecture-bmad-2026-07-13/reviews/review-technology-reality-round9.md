---
type: architecture-review
lens: technology-reality-round9
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: changes-required
critical: 0
high: 1
medium: 0
---

# Reviewer Gate 第九轮：技术现实性复核

## Verdict

**CHANGES REQUIRED。** 本轮 PRD/UX 同步新增的 `WorkspaceDiscoverySummary`、`IndexStatusSummaryV1`、`NavigationTargetV1` 和遥测 kill switch 都可由现有技术栈实现，没有引入需要改栈的新依赖；全部精确版本绑定也仍然存在且相互兼容。但 AD-11 的 Windows 命名管道“ACL 只允许当前用户 SID”无法由当前绑定的 Node 24 公共 API 按字面实现，属于 1 项既有 High 技术缺口。

## Web research 判断

本轮没有更换技术栈，且 Stack 中已有 2026-07-13 的官方源核验声明，因此**不需要重做一次宽泛的技术选型研究**。为避免凭训练数据延续旧结论，本轮仍执行了定点在线刷新，范围仅包括：所有精确版本是否仍可解析、Node/better-sqlite3 ABI 与目标平台、TypeScript 6 稳定 API、VS Code 1.125 UTF-16/API、JSON-RPC 流传输、YAML/Ajv 契约能力，以及 Windows 命名管道 ACL。

刷新结果：版本表中的全部精确 pin 均可从 npm Registry 或官方发布源解析；`pnpm@11.12.0` 虽非当前 latest（latest 为 11.13.0），但它是有效精确 pin，Node 要求 `>=22.13`，与 Node 24.18.0 相容，不构成 finding。

## Critical / High Findings

### HIGH-1 — Node 24 公共 API 不能兑现“Windows 命名管道 ACL 只允许当前用户 SID”

- **位置：** AD-11；关联 AD-2、AD-12。
- **架构承诺：** Windows 命名管道作为服务端点，并要求 Windows ACL 只允许当前用户 SID。
- **技术现实：** Node 24.18.0 的 `net.Server.listen()` 只公开 `readableAll` / `writableAll` 开关。当前 Node 源码仅在任一开关为 `true` 时调用 `uv_pipe_chmod()`；没有公开“移除默认 Everyone ACE”或传入 `SECURITY_ATTRIBUTES`/SID DACL 的入口。随 Node 24.18.0 携带的 libuv 仍以 `CreateNamedPipeW(..., NULL)` 创建管道，即使用 Windows 默认安全描述符。微软文档明确该默认 DACL 向 LocalSystem、管理员和创建者授予完全控制，同时向 Everyone 与 anonymous 授予读权限。现有 `vscode-jsonrpc` 只消费已建立的流，不能补上端点 ACL。
- **影响：** 随机 token 与 workspace-key 校验仍能提供应用层认证，但它们不等价于 AD-11 明文规定的 OS 层“仅当前 SID”；开发团队若只使用当前 Stack 无法实现并验收该不变量。
- **建议处理：** 二选一后更新架构：
  1. 若必须保留“仅当前 SID”，显式绑定 Windows 原生 ACL 适配器/helper，并要求其用带专用 DACL 的 `SECURITY_ATTRIBUTES` 创建命名管道，同时纳入四平台构建与安全测试；或
  2. 若不引入原生组件，收窄 AD-11 为 Node 可兑现的端点控制（不可预测 pipe 名、严格 token-first 握手、握手前不发送任何数据、速率/超时限制），并明确接受默认 Windows pipe DACL 的剩余风险。

## 定点技术复核

| 检查项 | 现实证据 | 结果 |
| --- | --- | --- |
| TypeScript 6.0.3 | npm pin 存在；公开声明包含 `createLanguageService`、`createIncrementalProgram`、`resolveModuleName`、`getLineAndCharacterOfPosition` 与 Import/Export AST。TypeScript 7.0.2 的包导出仍以 `unstable/*` 为主，因此继续锁定 TS 6 是有意且现实的兼容选择。 | 通过 |
| Node.js 24.18.0 LTS | Node 官方发布索引记录 `v24.18.0`、LTS `Krypton`、module ABI 137，并提供 Windows x64、macOS arm64/x64、Linux x64 资产。 | 通过 |
| pnpm 11.12.0 | pin 存在，要求 Node `>=22.13`；与 Node 24.18.0 相容。不是 latest 不影响可复现绑定。 | 通过 |
| VS Code 1.125.0 | 官方 1.125 release 页面存在，`@types/vscode@1.125.0` 可解析；Workspace Trust、Webview CSP、Tree/Problems/Status 等所需 API 存在。 | 通过 |
| better-sqlite3 12.11.1 | npm 声明支持 Node 24；GitHub release 提供 Node ABI 137 的 Windows x64、macOS arm64/x64、Linux x64 预编译资产，吻合 AD-12 目标矩阵；externalize 后复制原生模块可行。 | 通过 |
| UTF-16 source range | VS Code 1.125 `Position.character` 官方声明为 0-based UTF-16 code units；TypeScript 位置基于 JS 字符串 offset 并提供 line/character 转换。统一为 `[start,end)` 是项目自有合同，不依赖缺失 API。 | 通过 |
| JSON-RPC 2.0 + Pipe/UDS | JSON-RPC 2.0 不绑定传输；`vscode-jsonrpc@9.0.1` 是 stream-based 实现并导出 Node 入口，Node `net` 支持 Windows pipe 与 Unix socket。协议运行时 schema 校验由 contracts/Ajv 提供，不要求 LSP。 | 通过（Windows ACL 例外见 HIGH-1） |
| Telemetry kill switch | `TelemetryPort`、Noop、allowlist、缓冲区与 `service/reconfigure` 都是应用端口/服务状态机，不依赖 VS Code telemetry API。服务可先原子切换 Noop、阻止新事件、清空未发送缓冲，再回复 opt-out；已发送到远端的事件无法撤回，但架构也未承诺撤回。 | 通过 |
| WorkspaceDiscovery | npm/Yarn workspace 可从 `package.json` 与 lockfile/packageManager 线索发现，pnpm 从 `pnpm-workspace.yaml` 发现；`yaml@2.9.0` 与 Node 24 文件/glob 能力足够。`single/recognized/degraded` 是自有 DTO，不假定 TypeScript API 或包管理器 CLI 会直接提供该枚举。 | 通过 |
| 新增 DTO | `WorkspaceDiscoverySummary`、`IndexStatusSummaryV1`、`NavigationTargetV1`、`GraphViewModel` patch 身份均属于 `packages/contracts`；Ajv 8.20.0 支持 JSON Schema 2020-12、枚举、nullable 联合和判别联合。VS Code range 与导航能力匹配，不存在同名第三方 DTO 依赖。 | 通过 |
| YAML / rules | `yaml@2.9.0` 提供 source token/CST、node range 与 line counter；Ajv 8.20.0 提供 2020-12 实现，支持 ConfigDiagnosticV1 的来源定位方案。 | 通过 |
| 其余 Stack pins | `generator-code@1.12.0`、`esbuild@0.28.1`、`vscode-jsonrpc@9.0.1`、`yaml@2.9.0`、`ajv@8.20.0`、`cytoscape@3.34.0`、`vitest@4.1.10`、`@vscode/test-cli@0.0.15`、`@vscode/test-electron@3.0.0`、`@vscode/vsce@3.9.2` 均可解析；已声明的 Node engines 与 Node 24 相容。 | 通过 |

## Medium Findings

无。

## 证据来源

- Node.js releases：`https://nodejs.org/dist/index.json`
- Node.js v24 net API：`https://nodejs.org/docs/latest-v24.x/api/net.html`
- Node.js v24.18.0 `net.js`：`https://github.com/nodejs/node/blob/v24.18.0/lib/net.js`
- Node.js v24.18.0 bundled libuv pipe implementation：`https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/pipe.c`
- Microsoft Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- TypeScript 6.0.3 declarations：`https://unpkg.com/typescript@6.0.3/lib/typescript.d.ts`
- TypeScript 6.0.3 manifest：`https://registry.npmjs.org/typescript/6.0.3`
- TypeScript 7.0.2 manifest：`https://registry.npmjs.org/typescript/7.0.2`
- VS Code 1.125 release：`https://code.visualstudio.com/updates/v1_125`
- VS Code 1.125 API declarations：`https://unpkg.com/@types/vscode@1.125.0/index.d.ts`
- better-sqlite3 12.11.1 release：`https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1`
- JSON-RPC 2.0 specification：`https://www.jsonrpc.org/specification`
- vscode-jsonrpc 9.0.1 manifest：`https://registry.npmjs.org/vscode-jsonrpc/9.0.1`
- YAML 2.9.0 declarations：`https://unpkg.com/yaml@2.9.0/dist/options.d.ts`
- Ajv 8.20.0 JSON Schema 2020-12 entry：`https://unpkg.com/ajv@8.20.0/dist/2020.d.ts`
- npm workspaces：`https://docs.npmjs.com/cli/v11/using-npm/workspaces/`
- pnpm workspace：`https://pnpm.io/pnpm-workspace_yaml`
