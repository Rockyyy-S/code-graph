---
type: architecture-review
lens: technology-reality-readiness-update
date: 2026-07-15
artifact: ../ARCHITECTURE-SPINE.md
driving_input: ../../../implementation-readiness-report-2026-07-15.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Implementation Readiness 更新：技术现实审查

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** 当前架构仍是绿地规划制品，尚无 `package.json`、锁文件或实现代码可作为 brownfield 证据；但每个 committed decision 中命名的外部技术、精确版本和关键平台能力，均能由架构 memlog、既有 Reviewer Gate 记录、官方规范/文档或 npm Registry 现实核验支撑。本次新增 AD-25～AD-28 没有依赖不存在的库、未公开 API 或当前工具链无法提供的能力。

本轮在最终判断前重读了 2026-07-15 最新落盘的 `ARCHITECTURE-SPINE.md`，包括刚收紧的 AD-23：首次 rebuild/Analyzer Job 必须绑定与 `.codegraphignore` 实际存在状态一致的 `EffectiveIgnoreSnapshotV1`，只有确认文件不存在时才可使用 generation 0。该要求可由当前 Node 24 文件读取、watcher-first bootstrap、内容哈希、单 mutation channel 和提交前 read-set rehash 实现，不增加未经确认的技术依赖。

## 审查方法与证据边界

本轮按三层证据核验：

1. **项目内来源：** `ARCHITECTURE-SPINE.md`、`.memlog.md`、`IMPLEMENTATION-GUIDE.md`、`implementation-readiness-report-2026-07-15.md`、`sprint-change-proposal-2026-07-15.md`，以及既有 `review-technology-reality-round16.md`～`round19.md`。
2. **Registry/发布源：** 2026-07-15 重新查询每个 Stack pin 的 npm 精确版本元数据、Node.js 官方发布索引、VS Code 官方稳定版本索引和 better-sqlite3 GitHub release assets。
3. **能力级官方来源：** TypeScript 6.0.3 声明文件、VS Code Extension Testing/Workspace Trust/Webview 文档、Node/SQLite/JSON-RPC/RFC 8785 等规范与文档。

绿色项目尚无代码级可运行证据，因此性能阈值、准确率和真实团队验证仍属于 AD-19 明确规定的未来发布门禁，而不是被误报为“当前已经达到”的能力。

## 精确版本与平台现实核验

| 绑定项 | 2026-07-15 现实核验 | 结论 |
| --- | --- | --- |
| Node.js 24.18.0 LTS | 官方发布索引存在 `v24.18.0`，LTS `Krypton`，module ABI 137；Windows x64、macOS arm64/x64、Linux x64 资产均存在 | 通过 |
| TypeScript 6.0.3 | npm 精确版本存在，`main=./lib/typescript.js`；声明中存在 `createLanguageService`、`createIncrementalProgram`、`getSymbolAtLocation`、`Symbol.valueDeclaration/declarations` 及所需 AST type guards | 通过 |
| pnpm 11.12.0 | 精确版本存在，engine `node >=22.13`，与 Node 24 兼容；registry latest 已为 11.13.0，但架构 pin 仍有效且无需追随 latest | 通过 |
| VS Code API 1.125.0 | `@types/vscode@1.125.0` 和 VS Code 1.125.0/1.125.1 均存在；当前稳定序列已到 1.128.1，架构已要求同时测试最低版、最新和前一稳定版 | 通过 |
| generator-code 1.12.0 / esbuild 0.28.1 | 精确版本存在；官方 generator 只作为 `apps/extension` 局部模板，esbuild 对 better-sqlite3 明确 externalize | 通过 |
| vscode-jsonrpc 9.0.1 | 精确版本存在；Node stream reader/writer 可承载 named pipe/UDS 上的 JSON-RPC 2.0 | 通过 |
| better-sqlite3 12.11.1 | engine 明确包含 Node 24；v12.11.1 release 存在 ABI 137 的 Windows x64、darwin arm64/x64、linux x64 资产 | 通过 |
| yaml 2.9.0 / Ajv 8.20.0 | 精确版本存在；YAML source token/range 与 Ajv 2020-12 专用入口可实现 AD-9 的解析、定位和严格校验 | 通过 |
| Cytoscape.js 3.34.0 | 精确版本存在；预算内渲染可行，领域模型未绑定 Cytoscape JSON；Worker 负责位置计算、主线程负责渲染的边界仍成立 | 通过 |
| Vitest 4.1.10 | 精确版本存在，engine 包含 Node 24 | 通过 |
| @vscode/test-cli 0.0.15 / @vscode/test-electron 3.0.0 | 精确版本存在，均要求 Node >=22；可下载/启动指定 VS Code 版本并在 Extension Development Host 中运行 Mocha 集成测试 | 通过 |
| @vscode/vsce 3.9.2 | 精确版本存在，Node >=20；官方支持 platform-specific VSIX | 通过 |

## AD-1～AD-24 技术现实回归

| 决策簇 | 命名技术/能力 | 现实来源与判断 |
| --- | --- | --- |
| AD-1、AD-2、AD-20、AD-22、AD-23 | 六边形模块边界、本地单服务、JSON-RPC 2.0、named pipe/UDS、协议协商、服务 epoch | 架构/状态机为项目自有合同；Node `net`、OS socket/pipe、vscode-jsonrpc 和 OS 排他锁足以实现。AD-23 的 actual-existence ignore snapshot 可由 watcher-first + fs read/hash + CAS 闭合 | 通过 |
| AD-3、AD-6、AD-8、AD-17 | GraphPatch、SQLite WAL/事务、CAS、Job、Git baseline | better-sqlite3/SQLite 支持同步事务、WAL、foreign keys、busy timeout；Git 完整 commit OID/object format 可读取；其余为服务自有状态机 | 通过 |
| AD-4、AD-14、AD-21、AD-24 | SHA-256、Unicode NFC、purl、RFC 8785 JCS、TS 模块解析与 AST 映射 | 标准规范与 TypeScript 6.0.3 公开 API 均存在；未绑定 TypeScript 7 unstable API | 通过 |
| AD-5、AD-27 | 增量 Program/Language Service、基础 symbol | TypeScript 6.0.3 的稳定 Compiler API 提供所需 Program、Language Service、checker、symbol declarations/valueDeclaration 和 AST guards | 通过 |
| AD-7、AD-9、AD-13、AD-18 | GraphViewModel、JSON Schema 2020-12、YAML/Ajv、CLI/导出合同 | 外部解析/校验能力存在；排序、预算、DTO、退出码和隐私策略均为项目自有纯函数/合同 | 通过 |
| AD-10、AD-11、AD-12、AD-15 | VS Code surfaces、Workspace Trust、Webview CSP、平台 VSIX、Node runtime、Cytoscape/Web Worker | VS Code 1.125 API 与发布机制提供所需表面；Node 24/better-sqlite3 ABI/资产匹配；Windows pipe 现实限制已按 Node/libuv 默认 DACL + token/endpoint 握手建模 | 通过 |
| AD-16、AD-19 | Noop telemetry、性能/准确率门禁 | immediate-off/latest-wins 是服务自有状态机；性能和 SM-4 准确率未伪称已达成，而是明确留给 benchmark/人工标注语料门禁 | 通过 |

## 新增 AD-25～AD-28 专项核验

### AD-25 — OverviewMetricV1 与 CycleProjectionKernelV1

**通过，无未确认技术假设。**

- SCC、聚合端点折叠、规范边去重、排序后哈希和稳定排序都是普通确定性图算法，不依赖未命名第三方图库或 Cytoscape 内部模型。
- 输入明确复用 AD-21/AD-24 已存在的 high-confidence canonical imports；多 Evidence 只计一条 canonical edge 与现有数据模型一致。
- BaseCycleProjectionV1 与 rules.yaml 解耦，使 Alpha 查询不依赖 Beta+ rules Story；这是实施顺序约束，不要求框架提供特殊能力。
- `rankingVersion` 纳入 queryFingerprint 属于项目自有版本化合同，现有 JSON-RPC/GraphViewModel 可直接承载。

### AD-26 — ImpactVerdictV1 与 ImpactRankV1

**通过，无未确认技术假设。**

- verdict 优先级、coverageIncomplete、riskClass、最短有向依赖 hop 和稳定路径排序都可在 `application/impact` 中作为纯函数实现。
- 输入已由 AD-17 的 Finding/comparison、AD-25 的基础循环和 Git ChangeSet 提供；不依赖 GitHub/GitLab API、云服务或未选定 SDK。
- IDE、CLI、Markdown 只消费同一 DTO，当前 contracts/JSON-RPC/CLI envelope 栈可表达，不需要额外运行时能力。

### AD-27 — BasicSymbolV1

**通过，所需 TypeScript 能力已现实确认。**

- TypeScript 6.0.3 公开声明提供顶层声明 AST guards、checker symbol、`declarations` 与 `valueDeclaration`，足以合并 overload/declaration binding，并从有 body/value 的声明或源码顺序首项选择导航范围。
- SourceFile 顶层、稳定名称、匿名/局部/成员排除都是 analyzer 自有遍历规则；0-based UTF-16 半开范围与 TypeScript/VS Code 的位置语义一致。
- `exported` 需由 checker/module exports 与声明语法统一计算，但这是已存在 API 上的实现规则，不依赖私有 tsserver 状态。
- 调用图/references 明确延期，避免无依据地假设 TypeScript 6 能以低成本提供跨项目精确引用图。

### AD-28 — 渐进式 CI

**通过，CI 基线与现有工具链相容。**

- type/lint/unit/build/contract/dependency-boundary/basic-security/规划引用检查均可由 Node 脚本、ESLint/TypeScript/Vitest 和 CI provider 的普通 required check 组成；架构不错误绑定某个不存在的 CI 产品能力。
- SQLite、CLI、rules、impact/export 门禁均对应确定性 fixture、Schema 或进程级测试，不需要外部服务。
- `@vscode/test-cli`/`@vscode/test-electron` 可启动指定 VS Code 版本并执行 extension-host 集成测试，足以覆盖 Electron 启动、命令/表面注册和 Workspace Trust API 路径；CSP 可通过生成 HTML 的静态合同测试加真实 VS Code 启动 smoke 组合验证。
- 非阻塞观察：若后续把“CSP/主题/键盘冒烟”提升为必须直接断言 Webview renderer DOM/浏览器安全策略效果的端到端测试，当前 Stack 表没有固定 renderer 自动化 harness；届时应在该 surface 首次落地 Story 中选择并锁定 Playwright/CDP 或等价方案。AD-28 当前只固定门禁责任与时点，因此这不是架构技术现实缺陷。

## Critical / High / Medium Findings

无。

## 最高优先观察

1. **版本有效性通过：** 所有精确 Stack pins 仍可解析并与 Node 24 相容；pnpm latest 已从 11.12.0 前进到 11.13.0，但现有 pin 没有兼容或安全证据要求立即升级。
2. **AD-23 最新收紧通过：** actual-existence `.codegraphignore` snapshot 不依赖文件系统原子快照；现有 watcher-first、hash/re-read、bootstrapGeneration 与 CAS 组合足以实现。
3. **AD-25～AD-27 通过：** 三项均是建立在现有规范图谱、Finding/Git 输入和 TypeScript 6 稳定 API 上的项目自有确定性合同，不依赖未确认库。
4. **AD-28 通过：** 当前 VS Code 测试包能建立 extension-host 集成门禁；只有未来要求 renderer DOM 级 E2E 时才需补选自动化 harness。

## 证据来源

- 项目内：`../ARCHITECTURE-SPINE.md`、`../IMPLEMENTATION-GUIDE.md`、`../.memlog.md`、`review-technology-reality-round16.md`～`round19.md`
- Node releases：`https://nodejs.org/dist/index.json`
- npm Registry 精确版本元数据：`https://registry.npmjs.org/`
- better-sqlite3 v12.11.1 assets：`https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1`
- TypeScript 6.0.3 declarations：`https://unpkg.com/typescript@6.0.3/lib/typescript.d.ts`
- VS Code stable releases：`https://update.code.visualstudio.com/api/releases/stable`
- VS Code extension tests：`https://code.visualstudio.com/api/working-with-extensions/testing-extension`
- VS Code Workspace Trust：`https://code.visualstudio.com/api/extension-guides/workspace-trust`
- VS Code Webview/CSP：`https://code.visualstudio.com/api/extension-guides/webview`
- JSON-RPC 2.0：`https://www.jsonrpc.org/specification`
- RFC 8785 JCS：`https://www.rfc-editor.org/rfc/rfc8785`
- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
