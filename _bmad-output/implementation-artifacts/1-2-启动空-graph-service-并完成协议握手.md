---
baseline_commit: 40acc281ee492f86f8dcdedcdd66926d37810e7e
created_at: 2026-07-18T12:41:36+08:00
---

# Story 1.2: 启动空 graph-service 并完成协议握手

Status: in-progress

<!-- 说明：本 Story 已完成需求、架构、现有代码、前序 Story、Git 与技术版本分析；实现完成状态仍由 dev-story 和独立代码审查流程决定。 -->

## Story

As a CLI 或扩展开发者，
I want 连接每个工作区唯一的空图谱服务并读取权威状态，
so that 后续能力可以复用同一本地服务实例和版本化协议。

## Acceptance Criteria

1. **Given** CLI 或 extension service-client 首次连接某个 indexing root  
   **When** 初始化本地 graph-service  
   **Then** 每个 indexing root 最多启动一个服务实例  
   **And** Windows 使用命名管道，macOS/Linux 使用 Unix Domain Socket  
   **And** 服务使用 JSON-RPC 2.0 且不监听 TCP。

2. **Given** 多个兼容客户端连接同一 indexing root  
   **When** 完成服务发现和 token、workspace-key、协议版本校验  
   **Then** 客户端复用同一实例而不是创建第二个 writer  
   **And** 不兼容或伪造连接安全失败并返回可操作诊断。

3. **Given** 当前尚未构建图谱  
   **When** 客户端完成 initialize 和 service/status 请求  
   **Then** 服务返回 protocol、graph、rules 和 CLI 独立版本及 capabilities  
   **And** 返回合法 ServiceStatusV1，其状态为 absent、freshness null、completeness empty  
   **And** 不伪造 graphRevision、节点、边或成功索引结果。

4. **Given** 服务或 endpoint 启动失败  
   **When** 客户端读取错误  
   **Then** 返回稳定 code、category、retryable、logId 和 suggestedAction  
   **And** 不启动 TCP 回退、全局 daemon 或第二个不兼容实例。

5. **Given** Story 1.2 的实现准备合并  
   **When** 同一 architecture-required 最小 CI 对该提交运行  
   **Then** type、lint、unit、build、contract、dependency-boundary 和 basic-security 全部通过  
   **And** 合并证据记录稳定 check 名、候选提交和最终结果  
   **And** 任一失败阻止 Story 1.2 合并，不得等待 Story 1.3 才补做实际门禁证据。

## Tasks / Subtasks

- [x] Task 1：定义并运行时校验服务控制面合同（AC: 2, 3, 4）
  - [x] 在 packages/contracts 内定义独立的 PROTOCOL_VERSION、GRAPH_SCHEMA_VERSION、RULES_SCHEMA_VERSION、CLI_SCHEMA_VERSION；V1 的 protocolVersion 是主版本整数 1，同一主版本的向后兼容增加通过 capabilities 和客户端兼容解析处理，禁止自行编码未定义的 minor 数字或把四个版本合并成单一字段。
  - [x] 定义并导出 InitializeRequest、InitializeResult、ServiceStatusV1、IndexStatusSummaryV1、TelemetryStatusV1、ErrorV1 与能力标识。InitializeRequest 必填 clientVersion、protocolVersion、supportedSchemaVersions、workspaceKey、sessionToken；InitializeResult 必填 serviceVersion、protocolVersion、graphSchemaVersion、rulesSchemaVersion、cliSchemaVersion、serviceStatus、capabilities。
  - [x] capabilities 使用排序去重的稳定字面量；本 Story 只允许 service/status 和 service/shutdown。initialize 是必需控制方法，不作为可选 capability；禁止声明 graph/query、rebuild、rules/check 等未实现能力。
  - [x] 为控制面对象提供 JSON Schema 2020-12，并以 Ajv 8.20.0 执行运行时校验。服务端请求、canonical 响应和 ErrorV1 schema 使用 additionalProperties:false；同一 protocol major 的客户端兼容解析必须校验全部已知必填字段并忽略未知响应字段，不能因服务新增可选响应字段而拒绝兼容实例。
  - [x] JSON-RPC error.data 必须通过同一 ErrorV1 validator；拒绝缺字段、错误类型、未知枚举和非法状态组合，不能只依赖 TypeScript 编译期接口或散落的 typeof 判断。
  - [x] 固定第一条请求必须是 initialize；握手成功前拒绝 service/status 或其他方法，并在单次失败后关闭连接，限制重复伪造握手。
  - [x] 将握手错误放入 JSON-RPC 错误 data 的 ErrorV1；稳定错误至少区分初始化顺序、token 失败、workspace-key 不匹配、协议不兼容、实例冲突和 endpoint 启动失败。
  - [x] ErrorV1 的稳定 code/category 不本地化；message 可供人阅读，但不得回显 token、完整绝对路径、原始堆栈或其他秘密。

- [x] Task 2：实现可测试的 workspace 身份、endpoint 与发现元数据（AC: 1, 2, 4）
  - [x] service-client 对 indexing root 先执行 realpath 与规范化；workspace-key 采用架构定义的 SHA-256 身份输入，不得直接使用绝对路径、进程内对象或随机值作为 key。
  - [x] 定义 WorkspaceIdentityInputV1 封闭联合：git 分支包含 version:1、kind:git、去凭据并规范化的 remoteIdentity、Unicode NFC 的相对 POSIX subroot；local 分支包含 version:1、kind:local、realpath.native 后规范化的 file URI。
  - [x] Git remote 规范化至少移除凭据、默认端口、尾随斜杠和 .git，host 小写；本地 URI 统一 percent-encoding，Windows 盘符大写并使用 realpath 返回的规范路径大小写。workspace-key 对完整 WorkspaceIdentityInputV1 执行 RFC 8785 JCS → UTF-8 → SHA-256 小写十六进制。
  - [x] Git 身份发现作为受信任宿主可注入输入；没有稳定 Git 身份时使用 local 分支。contracts/service-client 只提供一个权威 identity 函数，客户端不得自行哈希，service-client 不得反向依赖 git-local adapter。
  - [x] Windows endpoint 使用带随机不可猜后缀的命名管道；macOS/Linux 使用 OS 用户缓存中长度受控的 Unix Domain Socket。公开 API 不接受 host/port，也不提供 TCP fallback。
  - [x] 服务发现所需的 metadata、token、锁与 socket 只位于当前用户 OS 缓存的 workspace-key 目录，不写入工作区。POSIX 当前切片至少保证目录 0700、文件与 socket 0600；Windows 继承当前用户配置文件 ACL。
  - [x] Windows 不得宣称 Node/libuv 公共 API 无法保证的 current-SID-only pipe DACL；明确接受默认 Pipe DACL 的剩余风险，并使用随机不可猜 endpoint、受限缓存中的 32-byte 随机 token、token-first 握手、crypto.timingSafeEqual、握手超时和失败次数限制共同收敛风险。
  - [x] 认证成功前不返回 service/status 或任何业务数据；失败立即返回脱敏 ErrorV1 并断开。token 不进入公开 metadata、命令行、日志、错误或 provider 证据。
  - [x] 发现流程采用 connect-first、再按需启动。当前切片的所有权原语固定为受限缓存目录内的独占创建，例如 fs.open 的 wx/O_CREAT|O_EXCL 语义；只有胜者可创建 token 并绑定 endpoint，endpoint bind 是第二道互斥。
  - [x] 启动顺序固定为：取得排他所有权 → 创建 token → 成功绑定 endpoint → 生成 serviceInstanceId/statusEpoch → 原子发布 metadata → 开放 initialize 握手。失败者绝不监听，只能有界重试连接胜者或 fail-closed。
  - [x] 本 Story 对疑似 stale metadata 采取 fail-closed：无法同时确认旧实例已失效时不得回收或启动第二实例；完整崩溃恢复与 stale metadata 回收由 Story 1.17 实现。
  - [x] 定义封闭 ServiceMetadataV1：version、workspaceKey、pid、endpointKind、endpoint、serviceInstanceId、statusEpoch、createdAt 和完整性校验字段；token 单独存储。读取时拒绝未知版本、符号链接、非普通文件、不安全权限和身份不匹配。
  - [x] token 只能存入受限缓存文件并通过 initialize 传递；禁止写入源码、固定测试值、命令行日志、错误消息或 provider 证据。

- [x] Task 3：启动空 graph-service 并提供 JSON-RPC 控制面（AC: 1, 2, 3, 4）
  - [x] 在 apps/graph-service 建立可作为子进程启动的入口、node:net IPC server 与 vscode-jsonrpc 消息连接；使用 SocketMessageReader/SocketMessageWriter 或等价流包装，不使用基于端口的 socket transport。
  - [x] graph-service 保持唯一组合根；本 Story 不引入 SQLite、Analyzer、watcher、rebuild、GraphPatch、节点、边或 Findings。
  - [x] 服务进程取得当前 indexing root 的排他所有权后，生成 serviceInstanceId 和 statusEpoch，原子发布 endpoint metadata，再接受连接；启动失败必须清理本次未完成资源并返回 ErrorV1。
  - [x] initialize 依次校验请求形状、token、workspace-key 和 protocolVersion；协议主版本不兼容直接拒绝，同一主版本的可选能力只通过 capabilities 协商。
  - [x] service/status 返回单一权威快照：lifecycle=running、availability=absent、freshness=null、completeness=empty、committed=null，无 currentIndexJob/lastIndexJob。
  - [x] 初始 ServiceStatusV1 必须包含非空 serviceInstanceId/statusEpoch、单调起始 serviceStatusRevision/statusRevision、telemetry requested/effective 均 off、pending=false，以及 configRevision/viewConfigRevision 的合法起始值。
  - [x] 不返回 graphRevision、findingsRevision、节点数、边数或成功索引时间；capabilities 不得声明 graph/query、rules/check、rebuild 或其他后续能力。
  - [x] 实现必要的 service/shutdown 以便受控关闭、关闭 endpoint 并释放本次实例资源；五分钟空闲退出、升级交接和崩溃恢复的完整合同留给后续生命周期 Story。
  - [x] 启动和握手错误生成可关联的 logId；当前切片只实现最小本地安全日志，不提前实现 Story 1.16 的日志轮转、cache 命令或完整容量治理。

- [x] Task 4：实现共享 service-client 的连接、握手与复用（AC: 1, 2, 3, 4）
  - [x] packages/service-client 提供发现、按需启动、连接、initialize、service/status、关闭连接与受控 shutdown 的公共 API；查询语义和图谱缓存不得进入该包。
  - [x] 启动器通过依赖注入接收 graph-service 可执行入口，service-client 不导入 apps/graph-service，也不假定 CLI npm 包或 VSIX 的最终打包路径。
  - [x] 可执行入口只能由受信任的 CLI/extension 组合配置或测试夹具注入，不能来自 workspace 文件、仓库配置或用户项目内容；使用 child_process.spawn 且 shell:false，禁止字符串拼接 shell 命令。
  - [x] 多个客户端连接同一 workspace-key 时返回相同 serviceInstanceId/statusEpoch，并各自维护连接生命周期；客户端断开不得修改共享图谱状态。
  - [x] 对启动中竞争使用有界重试和确定性超时；超时、拒绝连接、无权限、协议不兼容和伪造 metadata 均映射为稳定 ErrorV1。
  - [x] CLI 与 extension 不复制发现或握手逻辑。本 Story 不新增公共 CLI status 命令，也不在 extension 激活时自动启动服务；CLI 公共命令属于 Story 1.14，Workspace Trust 宿主流程属于 Story 2.1。
  - [x] 为后续 extension 调用保留显式 trust gate：宿主未授予 Workspace Trust 时不得调用启动器、读取项目或执行 Git；本 Story 通过无副作用适配边界或测试证明，不提前实现 UI。

- [x] Task 5：建立真实协议、安全与多进程竞争测试（AC: 1, 2, 3, 4）
  - [x] 单元测试覆盖 workspace-key 规范化、Windows/POSIX endpoint 生成、版本兼容判断、ErrorV1 映射、ServiceStatusV1 合法与非法组合。
  - [x] 合同测试覆盖 InitializeRequest/Result、ServiceStatusV1 和 ErrorV1 的运行时校验、未知字段策略、独立版本字段及稳定 capabilities。
  - [x] 当前 OS 上启动真实 graph-service 子进程，使用真实命名管道或 UDS 完成 initialize 和 service/status；禁止只用进程内 mock 证明 AC1/AC2。
  - [x] 当前 Story 创建环境为 Windows，Dev Agent Record 必须保存至少一次真实 Windows Named Pipe 双进程握手与单实例竞争结果；Ubuntu CI 继续验证 POSIX UDS，macOS 真实进程矩阵由 Epic 5 复验。
  - [x] 并发发起至少两个独立客户端/进程连接同一临时 indexing root，断言只存在一个有效 PID、serviceInstanceId、statusEpoch 和 writer。
  - [x] 覆盖错误 token、错误 workspace-key、协议不兼容、首请求非 initialize、重复失败握手、endpoint 冲突、启动超时和权限失败；所有路径均不得退回 TCP 或创建第二实例。
  - [x] 断言空状态为 absent/null/empty/committed=null，且响应不包含 graphRevision、节点、边或伪造成功索引字段。
  - [x] POSIX 平台校验目录、文件与 socket 权限；Windows 分支通过可注入平台单测校验命名管道格式和随机后缀，完整四平台运行矩阵由发布 Epic 复验。
  - [x] 测试中的伪 token 仅放 tests 目录或运行时生成，避免 basic-security 将测试材料误判为产品凭据。
  - [x] 测试保持 Red → Green → Refactor；禁止 skip/todo/only、空断言、passWithNoTests 或恒成功脚本。

- [ ] Task 6：接入依赖、文档与最小真实 CI 证据（AC: 5）
  - [x] 在 packages/contracts 引入架构锁定的 Ajv 8.20.0，在 packages/service-client 和 apps/graph-service 引入 vscode-jsonrpc 9.0.1，并更新 pnpm-lock.yaml；不要提前安装 better-sqlite3 或 Analyzer 依赖。
  - [x] 更新 scripts/architecture/check-dependency-boundaries.mjs 的角色级第三方 allowlist，只允许 contracts 使用 Ajv、service-client 与 composition-root 使用 vscode-jsonrpc；补充正/负向边界测试，保持其他角色默认拒绝。
  - [x] package.json 内部 workspace 依赖继续使用 workspace:*，tsconfig.build.json project references 与 manifest 依赖完全一致；不得改写既有 type/build 脚本。
  - [x] 更新 docs/repository-layout.md，并新增协议控制面说明，记录 owner、IPC、发现、握手、空状态、错误码和范围外能力；文档路径使用仓库相对路径。
  - [x] 复用现有 .github/workflows/architecture-required.yml 和稳定 check 名；不得增加 path filter、continue-on-error 或 Story 1.3 的 ci/quality-gates.v1.yaml。
  - [x] 使用仓库锁定的 Node 24.18.0、pnpm 11.12.0 执行 pnpm install --frozen-lockfile 和 pnpm architecture-required，确保七条门禁全部真实通过。
  - [ ] 新增 docs/ci/story-1-2-provider-evidence.md，记录候选完整 commit、architecture-required 运行链接、最终结论及失败会阻止合并的证据；不得等待 Story 1.3 补做。

## Dev Notes

### Developer Context

- StoryDependencyDagV1 是唯一依赖权威：Story 1.2 直接依赖 Story 1.1；Story 1.1 已 done，已建立可复用的 workspace、依赖边界、真实七门禁与 provider required check。
- Story 1.2 直接解锁 Story 1.3，并为 Story 1.18 的共享服务配置提供前置；正文顺序不产生额外依赖。
- 本 Story 的交付物是控制面薄切片：单实例发现、平台本机 IPC、JSON-RPC 握手、权威空状态和可操作错误。空服务是合法状态，不是空数据库，也不是伪造成功索引。
- FR-21 的完整 Overview、邻域、Findings 和导出由后续 Story 实现；FR-22 的 Job、取消、stale/partial 缓存和完整恢复也不在本 Story。

### Scope Boundaries

本 Story 明确不实现：

- SQLite schema、迁移、graph.sqlite、rebuild、GraphPatch、graphRevision 或原子提交；分别由 Story 1.4、1.19 及后续索引 Story 承担。
- TS/JS Analyzer、模块依赖、BasicSymbolV1、workspace package 识别；由 Story 1.5–1.9 承担。
- 完整 ignore/rules bootstrap barrier、last-valid、诊断和 watcher；由 Story 1.4、1.10–1.13 承担。
- 公共 CLI query/status/doctor、JSON envelope 与退出码；由 Story 1.14 承担。
- Job 状态、取消、GraphViewPatch 与完整 ServiceStatusV1 状态机；由 Story 1.15 承担。本 Story 只交付合法 absent 基线。
- cache path/clear、日志轮转、容量治理；由 Story 1.16 承担。
- 崩溃、断线重连、stale metadata 回收、epoch 切换和损坏缓存恢复；由 Story 1.17 承担。
- 遥测重配置、VS Code Workspace Trust UI、Getting Started/Index Status UI、打包升级矩阵；分别由 Story 1.18、2.1、2.10 和 Epic 5 承担。
- TCP fallback、全局 daemon、第二 writer 永久禁止，不是后续补做项。

### Architecture Compliance

- 依赖方向：contracts 独立；service-client 只依赖 contracts 与其允许的 JSON-RPC 库；graph-service 组合 contracts 和基础设施；CLI/extension 只通过 service-client 连接。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-1依赖只向核心收敛]
- 服务所有权：一个 indexing root 最多一个 graph-service；multi-root 后续按 root 管理多个独立服务，不合并图谱。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-2每-indexing-root-一个按需本地服务]
- 安全：Windows 命名管道、macOS/Linux UDS；业务请求前校验 token、workspace-key、protocolVersion；不监听 TCP。[Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md#56-本地服务与安全边界]
- 协议：protocol、graph、rules、CLI schema 独立版本化；initialize、service/status、service/shutdown 是控制子集。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-20协议图谱规则和-CLI-Schema-独立版本化] [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-23服务生命周期与升级交接可恢复]
- 状态：absent 只能与 committed=null、freshness=null、completeness=empty 组合；不得伪造图谱 revision。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#5-线协议与版本]
- 交付：继续使用 Story 1.1 的 architecture-required 最小真实 CI；Story 1.3 前不得创建完整 gate registry 或 provider controller。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-28能力首次落地即进入渐进式-CI]

### Stable Error Registry

| code | category | 触发条件 | retryable 基线 |
| --- | --- | --- | --- |
| SERVICE_INITIALIZE_REQUIRED | protocol | initialize 前调用其他方法 | false |
| SERVICE_AUTH_FAILED | security | token 缺失或不匹配 | true，仅允许重新发现后重试 |
| SERVICE_WORKSPACE_MISMATCH | security | workspace-key 与实例不匹配 | false |
| SERVICE_PROTOCOL_INCOMPATIBLE | compatibility | protocolVersion 主版本不匹配 | false |
| SERVICE_INSTANCE_CONFLICT | lifecycle | 无法确认唯一实例所有权 | true |
| SERVICE_ENDPOINT_START_FAILED | transport | Pipe/UDS 绑定或权限失败 | 由错误分类确定 |
| SERVICE_START_TIMEOUT | lifecycle | 胜者未在有界时间内发布可连接实例 | true |

- 错误注册表由 packages/contracts 单点定义，并以 schema/快照合同测试锁定；实现不得在 service-client 和 graph-service 分别发明同义 code。
- 本 Story 所有启动/连接错误必须包含非空 logId 与 suggestedAction；堆栈只进入本地安全日志。

### Library / Framework Requirements

| 技术 | 锁定版本 | 本 Story 用途 |
| --- | --- | --- |
| Node.js | 24.18.0 | node:net、node:fs、node:crypto、node:child_process、本机 IPC |
| TypeScript | 6.0.3 | NodeNext ESM、严格类型、合同与服务实现 |
| pnpm | 11.12.0 | workspace 依赖与冻结 lockfile |
| vscode-jsonrpc | 9.0.1 | JSON-RPC 2.0 消息连接、SocketMessageReader/SocketMessageWriter |
| Ajv | 8.20.0 | JSON Schema 2020-12 控制面运行时校验 |
| Vitest | 4.1.10 | 单元、合同与真实子进程集成测试 |

- 截至 2026-07-18，npm Registry 的 vscode-jsonrpc latest 为 9.0.1，Ajv latest 为 8.20.0；两者均与架构锁定版本一致。vscode-jsonrpc 的 Node API 提供 SocketMessageReader、SocketMessageWriter 和 createMessageConnection。
- 版本核验来源：[vscode-jsonrpc Registry](https://registry.npmjs.org/vscode-jsonrpc)、[Ajv Registry](https://registry.npmjs.org/ajv)。
- 不使用 vscode-jsonrpc 的 createClientSocketTransport/createServerSocketTransport，因为该 API 以 TCP port 为入口，与本 Story 禁止监听 TCP 冲突。
- 不追随 pnpm 或 TypeScript 的 latest；版本变更必须先经过架构变更。
- Story 创建时当前 shell 报告 Node 22.14.0，与仓库锁定的 24.18.0 不一致；开发和验收前必须切换到 .node-version/.nvmrc 指定版本。
- 本次 registry 安全 audit 因当前 npmmirror 缺少 advisories endpoint 而无法完成，不能据此宣称无漏洞；实现时应在可用的审计源下复核新增生产依赖，且 basic-security 仍必须通过。

### Current Files to Update or Preserve

| 文件 | 当前状态 | 本 Story 修改 | 必须保留 |
| --- | --- | --- | --- |
| packages/contracts/src/index.ts | 仅 export {}，明确不定义产品 DTO/RPC | 导出控制面类型、常量和运行时 validator | 不加入领域行为、数据库或渲染格式 |
| packages/contracts/package.json | 无第三方依赖 | 增加 Ajv 8.20.0 | role、exports、type/build 脚本不变 |
| packages/service-client/src/index.ts | 仅 export {}，注释声明 Story 1.2 才实现 | 导出发现、启动、握手、状态与关闭 API | 只依赖 contracts；不承担查询语义或 adapter |
| apps/graph-service/src/index.ts | 仅 export {}，不启动服务 | 导出服务工厂，并由独立 main 入口启动子进程 | graph-service 仍是唯一组合根；不提前实现索引 |
| packages/service-client/package.json | 只有 contracts workspace 依赖 | 增加 vscode-jsonrpc 9.0.1 | role、exports、type/build 脚本不变 |
| apps/graph-service/package.json | 组合根依赖已有核心/adapter 壳层 | 增加 vscode-jsonrpc 9.0.1 与必要入口声明 | 不删除现有架构依赖，不改角色 |
| packages/service-client/tsconfig.json | NodeNext 严格配置，types 为空 | 为 node:net/fs/crypto/child_process 增加 node types | strict、rootDir、noEmit 不变 |
| apps/graph-service/tsconfig.json | NodeNext 严格配置，types 为空 | 为 node:net/fs/crypto/process 增加 node types | strict、rootDir、noEmit 不变 |
| packages/service-client/tsconfig.build.json | 已引用 contracts build config | 原则上无需修改 | project references 与 manifest 内部依赖完全一致 |
| apps/graph-service/tsconfig.build.json | 已引用 contracts/application/adapter build config | 原则上无需修改；main.ts 由现有 include 自动编译 | project references 与 manifest 内部依赖完全一致 |
| scripts/architecture/check-dependency-boundaries.mjs | contracts、service-client、composition-root 外部依赖 allowlist 为空 | 精确允许 Ajv/vscode-jsonrpc，并补测试 | 默认拒绝、相对路径诊断与其余角色规则不弱化 |
| tests/contract/dependency-boundary-negative.test.ts | 已覆盖核心逆向依赖、adapter 组合、未批准第三方依赖和 workspace alias | 增加批准角色/版本的正向合同，以及错误角色或其他 RPC/schema 库的负向合同 | 保留全部现有失败场景与相对路径诊断断言 |
| pnpm-lock.yaml | 尚无 Ajv 8.20.0 与 vscode-jsonrpc 9.0.1 | 冻结新增生产依赖 | frozen install 可重现 |
| docs/repository-layout.md | 仍说明 Story 1.2 前不得伪造服务 | 更新为真实控制面责任和范围 | 继续记录 owner、禁用 utils 和七门禁 |
| .github/workflows/architecture-required.yml | always-run，稳定 check 名，七门禁 | 原则上无需改动 | 不加 path filter、不改 check 名、不放宽失败 |
| vitest.contract.config.ts | 合同测试默认超时 10 秒 | 原则上不修改；进程测试优先使用单测试 timeout 和可注入短超时 | 不全局放宽失败或启用 passWithNoTests |

### Recommended File Structure

~~~text
packages/contracts/src/
  index.ts                    # 导出公共控制面合同
  service-control.ts          # initialize、版本与 capabilities
  service-status.ts           # ServiceStatusV1 absent 基线
  protocol-error.ts           # ErrorV1 与稳定错误 code
  service-control-schema.ts   # 封闭 JSON Schema 2020-12
  runtime-validation.ts       # Ajv 严格线协议 validator
packages/service-client/src/
  index.ts                    # 公共客户端 API
  workspace-identity.ts       # workspace-key 规范化与哈希
  endpoint.ts                 # 平台 endpoint/cache path
  discovery.ts                # metadata、connect-first、并发启动
  connection.ts               # JSON-RPC 握手与 status
  launcher.ts                 # 可注入服务启动器
apps/graph-service/src/
  index.ts                    # 可测试服务工厂
  main.ts                     # 子进程入口
  server.ts                   # node:net + vscode-jsonrpc
  service-state.ts            # 空状态与单调 revision
  instance-owner.ts           # 排他所有权与 metadata
  safe-log.ts                 # 最小 logId 关联
tests/unit/
  service-control-contract.test.ts
  workspace-identity.test.ts
  endpoint.test.ts
tests/contract/
  graph-service-handshake.test.ts
  graph-service-single-instance.test.ts
  graph-service-security.test.ts
docs/
  protocol/service-control-v1.md
  ci/story-1-2-provider-evidence.md
~~~

- 文件名允许按实现微调，但 owner 和依赖方向不可改变。
- 可合并职责紧密的薄文件，避免机械创建过多文件；不得跨 contracts、service-client、graph-service owner 合并。
- 新的 NodeNext 相对 import 必须使用可解析的 .js 后缀。
- 所有接口、类、方法和复杂逻辑使用中文 JSDoc；避免显而易见或空泛注释。

### Testing Requirements

- Unit：身份规范化、SHA-256 输入稳定性、endpoint 选择、版本兼容、状态不变量、错误映射。
- Contract：JSON-RPC 方法名、请求/响应运行时形状、独立版本、未知字段、capabilities、ErrorV1。
- Integration：真实子进程、真实当前平台 IPC、并发双客户端、关闭与资源清理、启动失败。
- Security：错误 token/workspace-key、首请求绕过、协议降级、endpoint 冲突、无 TCP fallback、权限与秘密脱敏。
- Regression：Story 1.1 的 workspace 发现、project references、依赖边界、安全扫描、测试 marker 和七门禁继续通过。
- 当前 CI 主要运行 Ubuntu；Windows 命名管道和 macOS UDS 的分支必须有纯函数/可注入平台测试，完整四平台进程级复验属于 Epic 5，不能在本 Story 中虚报已经完成。

### Previous Story Intelligence

- Story 1.1 已建立 11 个 workspace、严格角色边界、自动 workspace 发现、拓扑 type/build、真实失败 fixture、always-run GitHub required check。
- 第三方依赖按角色默认拒绝；引入 Ajv/vscode-jsonrpc 必须同步改 allowlist 和负向测试，否则 dependency-boundary 会失败。
- manifest 内部依赖必须使用 workspace:*，tsconfig project references 与其完全对应，确保 clean checkout 不依赖历史 dist。
- Vitest 禁止 skip/todo/only，默认测试集排除故意失败 fixture；ESLint 覆盖 TS/JS 全部常用扩展名。
- basic-security 扫描 apps、packages、scripts 和 workflow；产品源码不得出现固定 token 或危险占位凭据。
- provider 证据采用独立 docs/ci/story-*.md，记录候选提交、稳定 check 和运行链接，不把 Story 1.3 的完整 provider 强制提前混入。

### Git Intelligence Summary

- 40acc28 只新增/更新规划、架构与项目约束，没有 Story 1.2 产品代码。
- f185cc0 的 Story 1.1 对抗审查修复强化了 external dependency allowlist、project references、测试发现、安全扫描与 CI；本 Story 必须建立在这些修复之上，不能回退。
- 5746381 建立 docs/repository-layout.md 和 provider 证据模式，可直接复用文档结构。
- 当前工作区存在用户未跟踪文件 想法.md；实现本 Story 时不得修改、删除或纳入提交。

### Project Context Reference

- 项目所有注释性内容使用中文。
- TypeScript/JavaScript 的接口、类、方法及复杂业务逻辑使用符合 JSDoc 的中文注释，说明职责和关键约束。
- 实现按任务顺序执行 Red → Green → Refactor；没有通过测试的任务不得标记完成。
- [Source: ../../project-context.md]

### References

- [Source: ../planning-artifacts/epics.md#Story-12启动空-graph-service-并完成协议握手]
- [Source: ../planning-artifacts/epics.md#StoryDependencyDagV1权威]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-21本地图谱查询服务]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-22图谱状态与故障恢复]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#53-安全与隐私]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#56-兼容性资源与本地服务边界]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md#3-已采用技术栈与保留替换边界]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md#56-本地服务与安全边界]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-2每-indexing-root-一个按需本地服务]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-20协议图谱规则和-CLI-Schema-独立版本化]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-23服务生命周期与升级交接可恢复]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-28能力首次落地即进入渐进式-CI]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#2-模块职责]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#3-实施顺序]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#5-线协议与版本]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-technology-reality-round9.md]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-technology-reality-round10.md]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-technology-reality-round16.md]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-adversarial-consistency-round13.md]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-adversarial-consistency-round14.md]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-adversarial-consistency-round15.md]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/reviews/review-adversarial-consistency-round16.md]
- [Source: ../planning-artifacts/sprint-change-proposal-2026-07-16.md]
- [Source: ../planning-artifacts/implementation-readiness-report-2026-07-16-rerun-3.md#总体实施就绪状态]
- [Source: ../planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md#Foundation]
- [Source: ../planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md#State-Patterns]
- [Source: 1-1-建立仓库模板-依赖边界与最小真实-ci.md]
- [Source: ../../docs/repository-layout.md]

## Dev Agent Record

### Implementation Plan

- 按 Tasks / Subtasks 顺序执行 Red → Green → Refactor。
- 每个协议/安全行为先建立可控失败测试，再实现最小通过代码。
- 保持本 Story 为控制面薄切片，不提前实现索引、存储、查询、规则或 UI。

### Agent Model Used

GPT-5 Codex

### Debug Log References

- 2026-07-18：Task 1 RED，`service-control-contract.test.ts` 5/5 失败；实现后 5/5 通过。
- 2026-07-18：Task 1 RED，`handshake-guard.test.ts` 因实现缺失失败；实现后 5/5 通过。
- 2026-07-18：`@codegraph/contracts` 与 `@codegraph/graph-service` 定向类型检查通过。
- 2026-07-18：Task 2 RED，身份、endpoint、metadata、实例启动和 connect-first 测试因实现缺失失败；实现后 29/29 通过。
- 2026-07-18：Task 3 RED，服务状态与真实 IPC 合同测试因实现缺失失败；实现后单元 12/12、合同 4/4 通过，graph-service build 通过。
- 2026-07-18：Task 4 RED，共享连接、启动器和 trust gate 测试因实现缺失失败；实现后新增测试 3/3 通过，contracts/service-client 类型检查通过。
- 2026-07-18：Task 5 在 Node 24.18.0 / Windows 上通过 34/34 单元测试与 16/16 合同测试；真实双客户端进程竞争复用同一 Named Pipe 实例。
- 2026-07-18：Task 6 边界合同先失败后通过；`pnpm install --frozen-lockfile` 与最终 `pnpm architecture-required` 全部通过（unit 39/39，contract 73/73）。
- 2026-07-18：HALT 候选 Provider 证据：尚无包含本实现的候选完整 commit 与 GitHub Actions 运行链接，未伪造或复用 Story 1.1 证据。

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Task 1：交付四套独立版本、稳定 capabilities、严格/兼容双模式 Schema 校验、统一 ErrorV1 注册表与 token-first 握手门禁。
- Task 2：交付 JCS workspace-key、平台本机 IPC 路径、排他启动所有权、受限发现文件、stale fail-closed 与有界 connect-first。
- Task 3：交付可执行 graph-service、vscode-jsonrpc 本机 IPC、权威 absent 状态、受控 shutdown 与最小安全日志。
- Task 4：交付共享 service-client 公共 API、受信任 spawn 启动器、双客户端复用与无副作用 Workspace Trust 门禁。
- Task 5：真实 Windows Named Pipe 结果为两个独立客户端进程获得相同 PID、serviceInstanceId、statusEpoch 和唯一 writer；第三客户端成功复用并 shutdown。
- Task 6（本地部分）：依赖锁定、角色 allowlist、协议/仓库文档、冻结安装和七门禁已完成；Hosted Provider 证据待候选提交。

### File List

- _bmad-output/implementation-artifacts/1-2-启动空-graph-service-并完成协议握手.md
- _bmad-output/implementation-artifacts/sprint-status.yaml
- apps/cli/tsconfig.json
- apps/graph-service/package.json
- apps/graph-service/src/handshake.ts
- apps/graph-service/src/index.ts
- apps/graph-service/src/instance-owner.ts
- apps/graph-service/src/main.ts
- apps/graph-service/src/safe-log.ts
- apps/graph-service/src/server.ts
- apps/graph-service/src/service-state.ts
- apps/graph-service/tsconfig.json
- docs/ci/story-1-2-provider-evidence.md
- docs/protocol/service-control-v1.md
- docs/repository-layout.md
- packages/contracts/package.json
- packages/contracts/src/index.ts
- packages/contracts/src/protocol-error.ts
- packages/contracts/src/runtime-validation.ts
- packages/contracts/src/service-control-schema.ts
- packages/contracts/src/service-control.ts
- packages/contracts/src/service-metadata.ts
- packages/contracts/src/service-status.ts
- packages/service-client/package.json
- packages/service-client/src/discovery.ts
- packages/service-client/src/connection.ts
- packages/service-client/src/endpoint.ts
- packages/service-client/src/errors.ts
- packages/service-client/src/index.ts
- packages/service-client/src/launcher.ts
- packages/service-client/src/workspace-identity.ts
- packages/service-client/tsconfig.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- scripts/architecture/check-dependency-boundaries.mjs
- tests/contract/dependency-boundary-negative.test.ts
- tests/contract/graph-service-control.test.ts
- tests/contract/graph-service-process.test.ts
- tests/contract/service-client-control.test.ts
- tests/contract/service-control-contract.test.ts
- tests/unit/connect-first-discovery.test.ts
- tests/unit/discovery-metadata.test.ts
- tests/unit/endpoint.test.ts
- tests/unit/handshake-guard.test.ts
- tests/unit/instance-bootstrap.test.ts
- tests/unit/service-state.test.ts
- tests/unit/service-client-trust.test.ts
- tests/unit/service-launcher.test.ts
- tests/unit/workspace-identity.test.ts
- tests/fixtures/service-client-process.mjs

## Change Log

- 2026-07-18：创建 Story 1.2 全量实现上下文，状态设为 ready-for-dev。
- 2026-07-18：完成 Task 1 控制面合同、运行时校验与握手门禁。
- 2026-07-18：完成 Task 2 工作区身份、IPC endpoint、单实例发现与安全启动顺序。
- 2026-07-18：完成 Task 3 空 graph-service、真实本机 JSON-RPC 控制面与受控关闭。
- 2026-07-18：完成 Task 4 共享 service-client、受信任启动器、连接复用与 trust gate。
- 2026-07-18：完成 Task 5 真实协议、安全路径与 Windows 多进程单实例竞争验证。
- 2026-07-18：完成 Task 6 本地依赖、文档与七门禁；Hosted Provider 候选证据保持阻塞。
