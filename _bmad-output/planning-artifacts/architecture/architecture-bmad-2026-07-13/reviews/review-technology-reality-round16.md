---
type: architecture-review
lens: technology-reality-round16
date: 2026-07-14
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Reviewer Gate 第十六轮：Technology Reality 最终审查

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** 所有精确技术版本仍可从官方发布源或 npm Registry 解析，Node 24/TypeScript/VS Code/better-sqlite3 的版本、ABI 与目标平台相互匹配；Node/libuv Windows IPC 的现实限制被准确建模；规则快照启动屏障与 service/view epoch 设计均可由现有栈实现。

## 关键技术与版本复核

| 绑定 | 当前现实证据 | 结果 |
| --- | --- | --- |
| Node.js 24.18.0 LTS | Node 官方发布索引存在 `v24.18.0`，LTS `Krypton`，module ABI 137，并提供 Windows x64、macOS arm64/x64、Linux x64 发布资产 | 通过 |
| TypeScript 6.0.3 | npm pin 存在；稳定声明继续提供 Language Service、incremental Program 与 module resolution API；架构未使用 TypeScript 7 unstable exports | 通过 |
| pnpm 11.12.0 | pin 存在，Node engine 为 `>=22.13`，与 Node 24 相容 | 通过 |
| VS Code 1.125.0 | 官方 1.125 release 与 `@types/vscode@1.125.0` 均存在；Workspace Trust、UTF-16 Position、Webview CSP 等所需 API 可用 | 通过 |
| vscode-jsonrpc 9.0.1 | pin 存在，提供 Node stream 入口；JSON-RPC 2.0 可运行于 Node pipe/UDS stream | 通过 |
| better-sqlite3 12.11.1 | npm 声明支持 Node 24；release 提供 ABI 137 的 Windows x64、macOS arm64/x64、Linux x64 原生资产 | 通过 |
| 其余 Stack pins | generator-code 1.12.0、esbuild 0.28.1、yaml 2.9.0、Ajv 8.20.0、Cytoscape.js 3.34.0、Vitest 4.1.10、VS Code 测试/发布工具精确版本均可解析；声明的 Node engines 与 Node 24 相容 | 通过 |

## 重点现实性复核

### 1. Node/libuv IPC

- Node 24 `net` 支持 Windows named pipe 与 POSIX Unix Domain Socket，`vscode-jsonrpc` 可在这些 duplex streams 上承载消息。
- Node 24.18.0 携带的 libuv 仍以默认安全描述符创建 Windows pipe；微软文档说明默认 DACL 包含 Everyone/anonymous 读权限。
- AD-11 没有重新宣称 Node 公共 API 能设置 current-SID-only pipe DACL，而是明确使用默认 DACL，并通过当前用户缓存 token、随机 endpoint、token-first 握手、workspace-key/protocol 校验和失败握手限制补偿。
- 该边界与实际 API 一致。随机 token/endpoint 可由 Node crypto 生成，握手 gate 与超时/限流可由 graph-service 状态机实现。

### 2. VS Code 宿主能力

- Workspace Trust 可在未授予时阻止服务启动与项目读取。
- TreeView、Webview、Problems、Status Bar、Command Palette 与 clipboard API 均在绑定 API 版本中存在。
- `Position.character` 明确定义为 0-based UTF-16 code units，与架构公共 range 合同一致。
- Webview CSP、nonce、本地资源根、消息 schema 校验和 extension→Webview epoch 清队列都是现有扩展/Webview 模型可实现的控制。

### 3. TypeScript 分析

- TypeScript 6.0.3 稳定 Compiler API 支持 Language Service、incremental Program、module resolution、project references 与 AST import/export 信息。
- Worker 只产出 FactBatch，主服务在 SQLite mutation channel 提交，不要求 TypeScript API 跨线程共享可变 Program。
- Workspace discovery、degraded DTO 和 workspace manifest 解析是 graph-service/analyzer adapter 自有逻辑，不误设为 TypeScript 内建能力。

### 4. SQLite 与 snapshot mutation

- SQLite 单写事务与每 indexing root 单 snapshot mutation channel 直接匹配；better-sqlite3 同步事务可在同一临界区执行 CAS、数据写入及 revision 推进。
- GraphPatch 与 findings-only transaction 可比较 baseGraphRevision 和完整 RulesSnapshotRef；CAS 失败回滚并重排不需要外部分布式锁。
- WAL、foreign keys、`synchronous=NORMAL`、busy timeout 与事务化迁移均为 SQLite/better-sqlite3 可配置能力。
- 无效 rules generation 允许图谱提交、保留旧 Findings 为 stale 并禁止 resolved，是普通事务数据变更，不依赖 temporal database 或 event-sourcing 框架。

### 5. 规则快照启动屏障

- 服务在 `lifecycle=starting` 期间读取 `rules.yaml`、`.codegraphignore` 和 workspace manifests，使用 yaml/Ajv 校验并构造初始 RulesSnapshotRef，完成后才进入 `running`、开放查询或 dequeue 首个 mutation Job；Node async/sync fs 与单服务队列足以实现该 barrier。
- `rules.yaml` 不存在、有效、无效三条路径均闭合：只有确认不存在才采用合法空 RulesV1；有效文件生成规范 digest；无效文件建立 invalid generation、EMPTY_RULES_DIGEST 与诊断。
- 启动读取后的文件竞争可由现有 watcher/content-hash/reconciliation 机制发现并推进新 generation；不要求文件系统提供全仓库原子快照。
- 默认值显式化 + RFC 8785 JCS + UTF-8 + Node SHA-256 可产生确定性 `EMPTY_RULES_DIGEST` 与有效 rules digest。

### 6. Epoch 与状态恢复

- Node crypto 可生成非秘密 `serviceInstanceId/statusEpoch`；Node fs 可原子替换 service metadata。
- 状态计数只要求 epoch 内单调，不需每个 progress 更新写 SQLite或跨进程持久化。
- `ServiceStatusV1` 和 GraphViewModel/Patch 携带实例/epoch；实例变化时旋转 viewId、丢弃旧消息并 full-refetch，可解决服务重启后 revision 重新从低值开始的问题。
- JSON-RPC notification 不持久化不是阻塞：同 epoch 通过 revision 检测断档，跨 epoch 无条件全量恢复，权威来源始终是 `service/status` request/response。

## 其他绑定能力抽查

- Git canonical baseline 使用 object-format 与解析后的完整 commit OID，可由 Git `rev-parse`/object database 实现。
- ExportArtifact policy、VS Code clipboard 与 Node 同目录临时文件 + rename 均有现成 API。
- Telemetry requested/effective/pending/latest-wins 与 immediate-off 是服务自有状态机，不依赖遥测 SDK 提供同名语义。
- JSON Schema 2020-12、YAML CST/range、RFC 8785、SHA-256 与 purl/cg URI 均是可实现的规范合同，没有绑定不存在的框架能力。

## Critical / High / Medium Findings

无。

## 本轮在线证据来源

- Node.js releases：`https://nodejs.org/dist/index.json`
- Node.js v24 API：`https://nodejs.org/docs/latest-v24.x/api/`
- Node/libuv Windows pipe implementation：`https://github.com/nodejs/node/blob/v24.18.0/deps/uv/src/win/pipe.c`
- Microsoft Named Pipe Security：`https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights`
- TypeScript 6.0.3 declarations：`https://unpkg.com/typescript@6.0.3/lib/typescript.d.ts`
- VS Code 1.125 release：`https://code.visualstudio.com/updates/v1_125`
- VS Code 1.125 declarations：`https://unpkg.com/@types/vscode@1.125.0/index.d.ts`
- better-sqlite3 12.11.1 release：`https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1`
- SQLite transactions：`https://www.sqlite.org/lang_transaction.html`
- JSON-RPC 2.0：`https://www.jsonrpc.org/specification`
- RFC 8785 JCS：`https://www.rfc-editor.org/rfc/rfc8785`
- npm Registry exact-version checks performed on 2026-07-14 for every Stack pin
