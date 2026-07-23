---
baseline_commit: 40acc281ee492f86f8dcdedcdd66926d37810e7e
created_at: 2026-07-18T12:41:36+08:00
---

# Story 1.2: 启动空 graph-service 并完成协议握手

Status: done

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
  - [x] initialize 先固定时序校验 token，再校验封闭请求形状、workspace-key 和 protocolVersion；协议主版本不兼容直接拒绝，同一主版本的可选能力只通过 capabilities 协商。
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

- [x] Task 6：接入依赖、文档与最小真实 CI 证据（AC: 5）
  - [x] 在 packages/contracts 引入架构锁定的 Ajv 8.20.0，在 packages/service-client 和 apps/graph-service 引入 vscode-jsonrpc 9.0.1，并更新 pnpm-lock.yaml；不要提前安装 better-sqlite3 或 Analyzer 依赖。
  - [x] 更新 scripts/architecture/check-dependency-boundaries.mjs 的角色级第三方 allowlist，只允许 contracts 使用 Ajv、service-client 与 composition-root 使用 vscode-jsonrpc；补充正/负向边界测试，保持其他角色默认拒绝。
  - [x] package.json 内部 workspace 依赖继续使用 workspace:*，tsconfig.build.json project references 与 manifest 依赖完全一致；不得改写既有 type/build 脚本。
  - [x] 更新 docs/repository-layout.md，并新增协议控制面说明，记录 owner、IPC、发现、握手、空状态、错误码和范围外能力；文档路径使用仓库相对路径。
  - [x] 复用现有 .github/workflows/architecture-required.yml 和稳定 check 名；不得增加 path filter、continue-on-error 或 Story 1.3 的 ci/quality-gates.v1.yaml。
  - [x] 使用仓库锁定的 Node 24.18.0、pnpm 11.12.0 执行 pnpm install --frozen-lockfile 和 pnpm architecture-required，确保七条门禁全部真实通过。
  - [x] 新增 docs/ci/story-1-2-provider-evidence.md，记录候选完整 commit、architecture-required 运行链接、最终结论及失败会阻止合并的证据；不得等待 Story 1.3 补做。

### Review Findings

- [x] [Review][Patch] [High] 对 connect、start、initialize、status 与 shutdown 的异步等待执行真实 deadline，避免配置超时被永久 pending 绕过 [packages/service-client/src/discovery.ts:139]
- [x] [Review][Patch] [High] 在 UDS listen 成功但 chmod 失败时关闭 server 并删除 socket，避免孤儿 listener 与常驻子进程 [apps/graph-service/src/server.ts:72]
- [x] [Review][Patch] [High] 保留并传播 graph-service 在 spawn 后返回的安全 ErrorV1，避免 stdio ignore 将 endpoint 启动失败降级为超时 [packages/service-client/src/launcher.ts:53]
- [x] [Review][Patch] [High] 在 metadata hard link 成功后立即记录发布状态，确保后续临时文件清理或 chmod 失败会回滚已发布 metadata [apps/graph-service/src/instance-owner.ts:235]
- [x] [Review][Patch] [High] 将启动回滚与受控关闭改为可重试的 best-effort 全量清理，避免首个清理异常跳过 token、metadata 和 owner lock [apps/graph-service/src/instance-owner.ts:149]
- [x] [Review][Patch] [Medium] 在服务启动前注册终止信号处理，避免启动窗口收到 SIGINT/SIGTERM 后遗留 V1 无法回收的发现证据 [apps/graph-service/src/main.ts:34]
- [x] [Review][Patch] [Medium] 让 ErrorV1 validator 校验 code 与 category、retryable、suggestedAction 的注册表组合不变量 [packages/contracts/src/service-control-schema.ts:142]
- [x] [Review][Patch] [Medium] 放宽兼容响应中的 capability 解析，使旧客户端可忽略同一协议主版本新增的未知可选能力 [packages/contracts/src/service-control-schema.ts:108]
- [x] [Review][Patch] [Medium] 握手时验证客户端 supportedSchemaVersions 与服务当前 cli、graph、rules 版本存在交集 [apps/graph-service/src/handshake.ts:87]
- [x] [Review][Patch] [Medium] 校验 initialize 返回的 serviceInstanceId/statusEpoch 与 discovery metadata 一致 [packages/service-client/src/connection.ts:189]
- [x] [Review][Patch] [Medium] 将 cacheRoot 限制为绝对的当前用户 OS 缓存路径或内部测试注入，避免公共 API 将 token、metadata 和 IPC 写入任意目录 [packages/service-client/src/connection.ts:38]
- [x] [Review][Patch] [Medium] 为 service/status 与 service/shutdown 的请求及 shutdown 响应补充共享封闭 Schema 和 Ajv 校验 [apps/graph-service/src/server.ts:146]
- [x] [Review][Patch] [Low] 仅将 `..` 路径段判为仓库逃逸，允许仓库内合法的 `..generated` 等目录名 [packages/service-client/src/workspace-identity.ts:117]
- [x] [Review][Patch] [Low] 为真实多进程合同测试增加失败路径 finally 清理，避免断言前失败时遗留 detached graph-service [tests/contract/graph-service-process.test.ts:34]
- [x] [Review][Patch] [Low] 将新增的 TypeScript 行注释改为符合项目约束的中文 JSDoc 注释 [packages/service-client/src/discovery.ts:144]

### Review Findings（第二轮复审，2026-07-20）

- [x] [Review][Patch] [High] 当前工作区修复没有对应的候选提交与 Hosted `architecture-required` 证据，旧运行不能证明同一候选提交满足 AC5 [docs/ci/story-1-2-provider-evidence.md:6]
- [x] [Review][Patch] [High] UDS `listen` 因路径已被占用而失败时仍无条件删除 endpoint，可破坏其他活动服务或普通文件 [apps/graph-service/src/server.ts:92]
- [x] [Review][Patch] [High] 认证前的 JSON-RPC reader 没有帧头和正文大小上限，本地 IPC 客户端可用超大 `Content-Length` 耗尽服务内存 [apps/graph-service/src/server.ts:182]
- [x] [Review][Patch] [High] 启动超时仅发送一次 `child.kill()` 且不等待退出，子进程在启动期也可无界吞掉终止信号，最终留下孤儿进程和 stale 发现证据 [packages/service-client/src/launcher.ts:113]
- [x] [Review][Patch] [High] RPC shutdown 通过 `void shutdown()` 丢弃清理失败，可引发未处理 rejection 并在客户端已收到 accepted 后遗留 lock/token/metadata [apps/graph-service/src/server.ts:275]
- [x] [Review][Patch] [High] 启动回滚的每个清理步骤只尝试一次，瞬时关闭失败后会丢失全部重试引用并永久留下 owner lock [apps/graph-service/src/instance-owner.ts:233]
- [x] [Review][Patch] [Medium] `timeoutMs`/`pollIntervalMs` 未校验且轮询总是等待完整间隔，调用可超过公开 deadline 很久或陷入忙轮询 [packages/service-client/src/discovery.ts:122]
- [x] [Review][Patch] [Medium] 外层 deadline 超时不取消底层 connect/initialize，超时后仍可构造无人持有的连接并泄漏 socket [packages/service-client/src/discovery.ts:139]
- [x] [Review][Patch] [Medium] 发现文件在 `lstat` 后的 `readFile` 错误未映射，竞态或权限失败会泄漏缺少 ErrorV1 字段的原生异常 [packages/service-client/src/discovery.ts:245]
- [x] [Review][Patch] [Medium] 发现文件的 `lstat`/`readFile` 存在 TOCTOU 且无大小上限，可读取被替换的代际文件或在校验前分配任意内存 [packages/service-client/src/discovery.ts:245]
- [x] [Review][Patch] [Medium] 兼容 capability Schema 要求服务包含客户端已知的全部可选能力，未来新客户端会错误拒绝缺少新能力的旧同主版本服务 [packages/contracts/src/service-control-schema.ts:116]
- [x] [Review][Patch] [Low] metadata 临时文件在 write/sync/close 阶段失败时不会被删除，重复启动失败可在缓存目录持续堆积 `.tmp` [apps/graph-service/src/instance-owner.ts:291]
- [x] [Review][Patch] [Low] 真实子进程与 IPC 测试失败路径缺少内部 timeout/finally 回收，worker 或 socket 挂起时可让 Vitest 超时后继续遗留资源 [tests/contract/graph-service-process.test.ts:95]

### Review Findings（第三轮复审，2026-07-20）

- [x] [Review][Patch] [High] 使用私有父子 IPC 取消通道执行跨平台优雅关闭和退出确认，仅在硬 deadline 后强杀；不再依赖 Windows `SIGTERM`，并显式处理 kill/close 失败 [packages/service-client/src/launcher.ts:135]
- [x] [Review][Patch] [High] AC5 当前仍无同候选提交 Hosted required-check，但 Task 6 及 Provider 证据子任务仍被错误勾选完成 [docs/ci/story-1-2-provider-evidence.md:3]
- [x] [Review][Patch] [High] 信号关闭时 `runtime.close()` 拒绝仍会清除强制终止计时器并移除信号处理，残留 listener/lock 可使进程永久存活 [apps/graph-service/src/main.ts:83]
- [x] [Review][Patch] [High] RPC shutdown 全部清理重试失败后只设置 `process.exitCode=1`，活动 server 句柄仍可阻止退出 [apps/graph-service/src/server.ts:300]
- [x] [Review][Patch] [High] 启动回滚重试耗尽或 bind 后清理失败时仍丢失 endpoint/lock 引用，且 `closeFailedBoundServer` 吞掉 server/UDS 清理错误 [apps/graph-service/src/instance-owner.ts:235]
- [x] [Review][Patch] [High] 1 MiB 单帧限制没有限制认证前累计帧数或排队字节，vscode-jsonrpc 可在首个 initialize 处理前排队任意多个合法大帧 [apps/graph-service/src/server.ts:193]
- [x] [Review][Patch] [Medium] metadata 发布前的 pending socket 没有 `error` 监听器，连接复位可以未处理 error 终止服务 [apps/graph-service/src/server.ts:71]
- [x] [Review][Patch] [Medium] launcher 在校验非法 timeout 之前已 spawn/unref 子进程，调用抛出 TypeError 时 detached 服务仍可继续运行 [packages/service-client/src/launcher.ts:60]
- [x] [Review][Patch] [Medium] 公开 timeout 校验只检查正有限数，超过 Node `2^31-1` 定时器上限时会被收缩为约 1ms [packages/service-client/src/discovery.ts:455]
- [x] [Review][Patch] [Medium] 发现阶段的 `lstat/open/read` 不在绝对 deadline 内，本地文件系统操作挂起时整个 connect-first 永不超时 [packages/service-client/src/discovery.ts:139]
- [x] [Review][Patch] [Medium] 兼容解析允许 capability 子集后，`status()`/`shutdown()` 仍会调用服务未声明支持的方法 [packages/service-client/src/connection.ts:82]
- [x] [Review][Patch] [Medium] `status()` 收到畸形或不兼容响应时不关闭终态连接，调用方丢弃对象后会泄漏 socket [packages/service-client/src/connection.ts:91]
- [x] [Review][Patch] [Low] 新增原始 JSON-RPC 测试客户端及 worker 强杀路径在无 close/exit 时仍缺少最终超时拒绝和 stdio 销毁 [tests/unit/bound-endpoint-cleanup.test.ts:173]

### Review Findings（第四轮复审，2026-07-20）

- [x] [Review][Patch] [High] 客户端在 initialize 身份校验前直接使用无界 `SocketMessageReader`，伪造或不兼容 endpoint 可用超大 `Content-Length` 耗尽 CLI/extension host 内存 [packages/service-client/src/connection.ts:235]
- [x] [Review][Patch] [High] RPC shutdown 的单次清理 Promise 没有硬 deadline，任一步永久 pending 时重试与 `forceTerminate` 永远不会执行 [apps/graph-service/src/server.ts:332]
- [x] [Review][Patch] [High] 外层绝对 deadline 会在 abort 后立即返回并吞掉 launcher 的子进程回收结果，且 metadata `access()` 不可取消，detached 子进程可能在超时后继续运行 [packages/service-client/src/discovery.ts:442]
- [x] [Review][Patch] [High] 握手开放后没有全局未认证连接上限，本地进程可持续占用 socket、reader/writer、状态对象和五秒计时器直至耗尽 FD/内存 [apps/graph-service/src/server.ts:81]
- [x] [Review][Patch] [Medium] launcher 观察到共享 metadata 后未确认本次 spawn 的子进程已经退出；慢速 loser 可在 winner 退出后脱离父进程意外启动 [packages/service-client/src/launcher.ts:131]
- [x] [Review][Patch] [Medium] 信号监听使用 `once` 且 `void closeRuntime()` 不捕获最终拒绝，第二次信号或未处理 rejection 可在 hard deadline 前绕过确定性关闭路径 [apps/graph-service/src/main.ts:122]
- [x] [Review][Patch] [Medium] 非 ErrorV1 的标准 JSON-RPC `ResponseError` 被统一映射为 `SERVICE_START_TIMEOUT` 并重试，无法为伪造或不兼容服务返回可操作的协议诊断 [packages/service-client/src/connection.ts:319]
- [x] [Review][Patch] [Medium] Windows UNC indexing root 被编码为 `file://///server/...` 而非规范 `file://server/...`，会生成不稳定且与标准实现不一致的 workspace-key [packages/service-client/src/workspace-identity.ts:169]
- [x] [Review][Patch] [Medium] `connectTimeoutMs` 与 `requestTimeoutMs` 在身份派生及服务启动后才校验，非法配置会先产生 detached 服务副作用并被误报为启动超时 [packages/service-client/src/connection.ts:188]
- [x] [Review][Patch] [Medium] 默认 POSIX 缓存路径导致 UDS 超长时公共连接入口直接抛原生 `Error`，缺少 AC4 要求的稳定 ErrorV1 字段 [packages/service-client/src/endpoint.ts:65]
- [x] [Review][Patch] [Low] `SafeLocalLogger.close()` 在句柄真正关闭前提交 `#closed=true`，首次 close 瞬时失败后所有清理重试都会误判成功 [apps/graph-service/src/safe-log.ts:37]
- [x] [Review][Patch] [Low] 新增合同类型仍有三个接口缺少项目约束要求的中文 JSDoc [packages/contracts/src/protocol-error.ts:36]
- [x] [Review][Patch] [High] 第四轮本地修复尚未形成候选提交与同 SHA Hosted `architecture-required` 证据，当前旧运行不能证明 AC5 [docs/ci/story-1-2-provider-evidence.md:3]

### Review Findings（第五轮复审，2026-07-20）

- [x] [Review][Patch] [High] RPC shutdown 失败分支在重试与 `forceTerminate` 之前无界等待 `logger.record()`，日志写入永久 pending 时强制终止仍不可达 [apps/graph-service/src/server.ts:365]
- [x] [Review][Patch] [Medium] 客户端未将 JSON-RPC reader 的解码/超限错误立即结算为协议不兼容，畸形或超大响应销毁 socket 后请求仍挂到 deadline 并可误报 `SERVICE_START_TIMEOUT` [packages/service-client/src/connection.ts:263]
- [x] [Review][Patch] [Medium] launcher 将子进程 `exit` 与 stdio `close` 视为同一状态，可在 stderr 排空前解析并丢失原始安全 ErrorV1 的 code/logId [packages/service-client/src/launcher.ts:217]
- [x] [Review][Patch] [Medium] start 超时后仍固定等待最多 3.5 秒 abort settlement，短 `timeoutMs` 调用会显著超过对外声明的共享绝对 deadline [packages/service-client/src/discovery.ts:467]

### Review Findings（第六轮复审，2026-07-22）

- [x] [Review][Patch] [High] 握手超时、握手拒绝或 reader error 路径先 `dispose()` 连接，但活跃连接集合仅在 `onClose` 删除；64 次失败可永久占满配额并拒绝后续客户端 [apps/graph-service/src/server.ts:289]
- [x] [Review][Patch] [High] indexing-root 身份派生位于绝对 deadline 和稳定 ErrorV1 边界之外，挂起的 `realpath` 可使公共连接永不返回，权限错误还可原样泄露绝对路径 [packages/service-client/src/connection.ts:229]
- [x] [Review][Patch] [High] 公开 deadline 返回后完全丢弃 launcher 的晚到回收失败，子进程无法终止时孤儿进程会继续占用单实例资源 [packages/service-client/src/discovery.ts:441]
- [x] [Review][Patch] [Medium] 客户端依赖 `vscode-jsonrpc` 的宽松消息判定，会接受缺失/伪造 `jsonrpc: "2.0"` 的响应，并将缺少 `result/error` 的同 id 响应误报为启动超时 [packages/service-client/src/connection.ts:285]
- [x] [Review][Patch] [Medium] 子进程临近 deadline 退出时不再等待 stderr close，仍可丢失原始 ErrorV1；close 永不到达时也未销毁 stderr/IPC 管道 [packages/service-client/src/launcher.ts:305]
- [x] [Review][Patch] [Low] Provider 文档顶部声明当前本地门禁为 unit 85/85、contract 83/83，但“本地验收”章节仍保留 84/84、81/81 [docs/ci/story-1-2-provider-evidence.md:25]

### Review Findings（第七轮复审，2026-07-22）

- [x] [Review][Patch] [High] pending cleanup 记录会被并发覆盖且失败 tombstone 只消费一次，未知子进程状态可被遗忘并重新启动 [packages/service-client/src/discovery.ts:485]
- [x] [Review][Patch] [High] partial JSON-RPC 消息的内部 timer 在连接 dispose 后仍永久续期，可阻止客户端进程退出 [packages/service-client/src/connection.ts:397]
- [x] [Review][Patch] [Medium] 导出的 launcher 启动 deadline 不覆盖 spawn 等待及超时后的同步回收，直接调用可明显超时 [packages/service-client/src/launcher.ts:94]
- [x] [Review][Patch] [Medium] 服务端未校验 JSON-RPC 2.0 信封，缺失或伪造 jsonrpc 字段的 initialize 仍可成功 [apps/graph-service/src/server.ts:232]
- [x] [Review][Patch] [Medium] JSON-RPC 正文为 null 时严格信封校验自身抛错，协议违规仍会退化为启动超时 [packages/service-client/src/connection.ts:417]
- [x] [Review][Patch] [Medium] 宽松 Content-Length/附加 header 校验会把畸形帧交给下游并误映射为启动超时 [packages/service-client/src/bounded-json-rpc-input.ts:56]
- [x] [Review][Patch] [Medium] 同 PID metadata 会在检查子进程 exit 前被接受，发布后立即崩溃可被误报为启动成功 [packages/service-client/src/launcher.ts:141]

### Review Findings（第八轮复审，2026-07-22）

- [x] [Review][Patch] [High] launcher 在公开 deadline 耗尽后给 IPC 取消和强杀确认的剩余预算为零，普通启动超时可被误记为永久回收失败 tombstone 并阻断后续连接 [packages/service-client/src/launcher.ts:194]
- [x] [Review][Patch] [High] 子进程收到 spawn 后会移除唯一 error 监听器，回收期 kill/IPC 失败触发 error 时可以未捕获异常终止 CLI 或 extension host [packages/service-client/src/launcher.ts:286]
- [x] [Review][Patch] [Medium] 客户端 initialize 阶段仍接受服务端请求、通知或额外小帧，伪造 endpoint 可将协议违规退化为请求超时并累积待解码消息 [packages/service-client/src/connection.ts:399]
- [x] [Review][Patch] [Medium] socket 在帧头或正文未完整时结束仅会关闭输入流，截断的 JSON-RPC 响应会被误映射为可重试启动超时 [packages/service-client/src/bounded-json-rpc-input.ts:88]
- [x] [Review][Patch] [Medium] launcher PID 探针会跟随 metadata 符号链接并以阻塞方式打开 FIFO，外层 deadline 返回后底层 open 仍可永久 pending 并阻止客户端进程退出 [packages/service-client/src/launcher.ts:483]

### Review Findings（第九轮复审，2026-07-22）

- [x] [Review][Patch] [Medium] 客户端响应预算未绑定实际 JSON-RPC id，单个错配 id 会被误报为超时，并发请求的乱序合法响应还会互相消费 token 并误杀连接 [packages/service-client/src/connection.ts:351]

### Review Findings（第十轮复审，2026-07-22）

- [x] [Review][Patch] [High] bootstrap 原始 fatal cleanup 错误会被 logger.close 失败覆盖，导致入口无法执行强制退出并可能永久保留活跃 listener [apps/graph-service/src/index.ts:38]
- [x] [Review][Patch] [Medium] revision Schema 未限制 JavaScript 安全整数上界，会接受已丢失精度的权威 revision 并破坏单调比较语义 [packages/contracts/src/service-control-schema.ts:10]
- [x] [Review][Patch] [Medium] 安全日志按路径跟随 service.log 符号链接并 chmod 目标文件，可追加和修改非预期用户文件 [apps/graph-service/src/safe-log.ts:62]
- [x] [Review][Patch] [Medium] 服务端 canonical initialize 与 service/status 响应未调用现有 Ajv validator，产品运行路径仍只依赖 TypeScript 构造 [apps/graph-service/src/server.ts:277]
- [x] [Review][Patch] [Medium] token-first 握手顺序在实现、协议文档、Story Task 与仓库布局文档之间自相矛盾，已勾选验收行为不唯一 [docs/repository-layout.md:70]

### Review Findings（第十一轮复审，2026-07-22）

- [x] [Review][Patch] [High] bootstrap fatal cleanup 后无界等待 logger.close，日志关闭永久 pending 时原始致命错误仍无法到达入口强制退出 [apps/graph-service/src/index.ts:39]
- [x] [Review][Patch] [Medium] POSIX 安全日志只使用 O_NOFOLLOW，预置无 reader 的 FIFO 仍会在 open 阶段永久阻塞服务启动 [apps/graph-service/src/safe-log.ts:82]
- [x] [Review][Patch] [Medium] canonical 响应校验失败仅延迟关闭 socket，20ms 窗口内已 initialized 的连接仍会处理后续 status 或 shutdown [apps/graph-service/src/server.ts:280]

### Review Findings（第十二轮复审，2026-07-22）

- [x] [Review][Patch] [Medium] POSIX workspace 缓存目录若已存在，日志会在目录权限收紧为 0700 前打开，失败路径还会永久保留宽松权限 [apps/graph-service/src/safe-log.ts:81]
- [x] [Review][Patch] [Medium] 预置的多硬链接 service.log 仍会通过普通文件校验，服务可向非预期目标 inode 追加日志并修改权限 [apps/graph-service/src/safe-log.ts:85]

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
- 2026-07-18：Task 6 边界合同先失败后通过；`pnpm install --frozen-lockfile` 与最终 `pnpm architecture-required` 全部通过（unit 40/40，contract 73/73）。
- 2026-07-18：HALT 候选 Provider 证据：尚无包含本实现的候选完整 commit 与 GitHub Actions 运行链接，未伪造或复用 Story 1.1 证据。
- 2026-07-18：Hosted run 29635748123 在 Ubuntu unit 阶段暴露 UDS 路径过长；改用 144-bit key 前缀目录并保留完整 key metadata 校验。
- 2026-07-18：完整合同并行负载暴露子进程启动界限过短；按单测试策略调整启动与 subprocess 超时，不放宽全局配置。
- 2026-07-18：候选 8ca4166925cae57aea25b957ce43929a05caf267 的 hosted run 29636223822 全部门禁通过。
- 2026-07-18：代码审查 15 项修复先以 9 条定向失败路径进入 RED；修复后 `pnpm architecture-required` 全绿（unit 54/54，contract 76/76）。
- 2026-07-20：第二轮复审 12 项本地修复完成 RED → GREEN；`pnpm architecture-required` 全绿（unit 64/64，contract 77/77），当前候选 Hosted 证据待生成。
- 2026-07-20：第三轮复审采用私有父子 IPC 取消协议，12 项本地行动项完成 RED → GREEN；`pnpm architecture-required` 全绿（unit 74/74，contract 78/78）。
- 2026-07-20：Hosted run 29723702957 在候选 `3c6bf8c` 上真实阻断 Linux POSIX 测试夹具错误；修复后候选 `56f4e6385ee2d54f4b31f07c02c07969bc571e54` 的 run 29724059158 七门禁全部通过。
- 2026-07-20：第四轮复审 12 项本地补丁完成 RED → GREEN；补充客户端 1 MiB 响应帧限制、RPC shutdown 硬 deadline、全局连接上限、launcher 退出归属、UNC 身份与稳定错误映射，`pnpm architecture-required` 全绿（unit 84/84，contract 81/81）。
- 2026-07-20：第五轮复审 4 项本地补丁完成 RED → GREEN；收敛 shutdown 日志 deadline、reader 错误结算、exit/close 时序与启动绝对 deadline，`pnpm architecture-required` 全绿（unit 85/85，contract 83/83）。
- 2026-07-22：第六轮复审 6 项本地补丁完成 RED → GREEN；修复连接配额释放、身份 deadline/ErrorV1、晚到回收状态、JSON-RPC 2.0 信封与 stderr 管道回收，`pnpm architecture-required` 全绿（unit 87/87，contract 87/87）。
- 2026-07-22：第七轮复审 7 项本地补丁完成 RED → GREEN；修复并发 cleanup tombstone、partial-message timer、launcher 端到端 deadline/exit 竞态与双向 JSON-RPC 2.0 信封门禁，`pnpm architecture-required` 全绿（unit 90/90，contract 93/93）。
- 2026-07-22：第八轮复审 5 项本地补丁完成 RED → GREEN；将公开启动 deadline 与后台子进程回收预算分离，持续捕获 child error，限制客户端入站响应预算，并拒绝截断帧与阻塞 metadata 路径；`pnpm architecture-required` 全绿（unit 94/94，contract 96/96）。
- 2026-07-22：第九轮复审 1 项本地补丁完成 RED → GREEN；错配 JSON-RPC response id 合同测试先复现超时误报，修复后按真实 request id 拒绝错配/重复响应并接受带异步间隔的并发乱序响应；`pnpm architecture-required` 全绿（unit 94/94，contract 98/98）。
- 2026-07-22：第十轮复审 5 项本地补丁完成 RED → GREEN；保留 fatal cleanup 原始错误，收紧 revision 安全整数、POSIX 日志 no-follow、服务端 canonical Ajv 门禁并统一 token-first 文档；`pnpm architecture-required` 全绿（unit 96/96，contract 98/98）。
- 2026-07-22：第十一轮复审 3 项本地补丁完成 RED → GREEN；为启动失败日志关闭增加硬 deadline，以 non-block + 普通文件校验拒绝 FIFO，并让 canonical 失败在连接关闭前保持终态；首次并行门禁因资源争用触发既有计时测试超时，单独重跑 `pnpm architecture-required` 全绿（unit 98/98，contract 99/99）。
- 2026-07-22：第十二轮复审 2 项本地补丁完成 RED → GREEN；POSIX 日志打开前先将既有 workspace 目录收紧为 0700，并拒绝多硬链接日志目标；`pnpm architecture-required` 全绿（unit 100/100，contract 99/99）。
- 2026-07-23：候选 `01bcf2d` 与 `92d11e5` 的 Hosted 运行依次真实阻断 Unit、Contract 中超长 POSIX 测试夹具；修复后最终候选 `21c25f6c5381539910daba7a151f2d4cc121fc48` 的 run 29908232554 七门禁全部通过。

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Task 1：交付四套独立版本、稳定 capabilities、严格/兼容双模式 Schema 校验、统一 ErrorV1 注册表与 token-first 握手门禁。
- Task 2：交付 JCS workspace-key、平台本机 IPC 路径、排他启动所有权、受限发现文件、stale fail-closed 与有界 connect-first。
- Task 3：交付可执行 graph-service、vscode-jsonrpc 本机 IPC、权威 absent 状态、受控 shutdown 与最小安全日志。
- Task 4：交付共享 service-client 公共 API、受信任 spawn 启动器、双客户端复用与无副作用 Workspace Trust 门禁。
- Task 5：真实 Windows Named Pipe 结果为两个独立客户端进程获得相同 PID、serviceInstanceId、statusEpoch 和唯一 writer；第三客户端成功复用并 shutdown。
- Task 6：最终候选 `21c25f6c5381539910daba7a151f2d4cc121fc48` 的 Hosted run 29908232554 七门禁全部成功，同 SHA Provider 证据已完成。
- Task 6：第三轮候选 `56f4e63` 的历史 Hosted 证据仍保留，但不替代当前工作区的新候选证据。
- Code Review：完成 deadline、启动错误传播、Schema 协商、实例身份、异常安全清理、信号窗口、测试孤儿进程与 JSDoc 约束修复，15/15 审查项关闭。
- Code Review Round 2：本地代码与测试修复 12/12 完成；最终候选的 Hosted required-check 已关闭遗留证据行动项。
- Code Review Round 3：交付跨平台父子 IPC 取消、最终强制终止、fatal cleanup、认证前单帧排队、全链路 deadline 与 capability 门禁；全部行动项已关闭。
- Code Review Round 4：本地代码与测试补丁 12/12 完成；仅保留当前工作区候选提交的 Hosted required-check 证据行动项。
- Code Review Round 5：本地代码与回归测试 4/4 完成；Story 继续因同 SHA Hosted required-check 证据保持 in-progress。
- Code Review Round 6：本地代码与回归测试 6/6 完成；仅保留当前候选的同 SHA Hosted required-check 证据行动项。
- Code Review Round 7：本地代码与回归测试 7/7 完成；Story 继续因当前候选的同 SHA Hosted required-check 证据保持 in-progress。
- Code Review Round 8：本地代码与回归测试 5/5 完成；仅余当前候选的同 SHA Hosted required-check 证据行动项。
- Code Review Round 9：本地代码与回归测试 1/1 完成；客户端响应预算已绑定真实 JSON-RPC request id，仅余当前候选的同 SHA Hosted required-check 证据行动项。
- Code Review Round 10：本地代码、合同与文档补丁 5/5 完成；仅余当前候选的同 SHA Hosted required-check 证据行动项。
- Code Review Round 11：本地代码与回归测试补丁 3/3 完成；仅余当前候选的同 SHA Hosted required-check 证据行动项。
- Code Review Round 12：本地代码与回归测试补丁 2/2 完成；同 SHA Hosted required-check 证据已关闭最后行动项。

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
- packages/service-client/src/bounded-json-rpc-input.ts
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
- tests/contract/failure-propagation.test.ts
- tests/contract/graph-service-control.test.ts
- tests/contract/graph-service-process.test.ts
- tests/contract/service-client-control.test.ts
- tests/contract/service-control-contract.test.ts
- tests/unit/connect-first-discovery.test.ts
- tests/unit/bound-endpoint-cleanup.test.ts
- tests/unit/discovery-metadata.test.ts
- tests/unit/endpoint.test.ts
- tests/unit/handshake-guard.test.ts
- tests/unit/graph-service-process-lifecycle.test.ts
- tests/unit/graph-service-startup.test.ts
- tests/unit/safe-log.test.ts
- tests/unit/instance-bootstrap.test.ts
- tests/unit/service-state.test.ts
- tests/unit/service-client-trust.test.ts
- tests/unit/service-launcher.test.ts
- tests/unit/service-connection-timeout.test.ts
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
- 2026-07-18：候选 hosted required check 通过，完成 Task 6 并将 Story 状态更新为 review。
- 2026-07-18：完成独立代码审查全部 15 项修复，最终本地七门禁通过并将 Story 状态更新为 done。
- 2026-07-20：完成第二轮复审的 12 项本地修复，Hosted 候选证据未完成，Story 保持 in-progress。
- 2026-07-20：完成第三轮复审的 12 项本地修复，当前候选 Hosted 证据未完成，Story 保持 in-progress。
- 2026-07-20：候选 `56f4e6385ee2d54f4b31f07c02c07969bc571e54` 的 Hosted `architecture-required` run 29724059158 全绿，关闭 AC5 与全部复审 finding，Story 更新为 done。
- 2026-07-20：完成第四轮复审 12 项本地补丁并通过七门禁；新候选 Hosted 证据尚未生成，Story 回到 in-progress。
- 2026-07-20：完成第五轮复审 4 项本地补丁并通过七门禁；仅剩当前候选的 Hosted 证据行动项。
- 2026-07-22：完成第六轮复审 6 项本地补丁并通过七门禁；Story 与 Sprint 继续保持 in-progress。
- 2026-07-22：完成第七轮复审 7 项本地补丁并通过七门禁；仅余同 SHA Hosted `architecture-required` 证据，Story 与 Sprint 保持 in-progress。
- 2026-07-22：完成第八轮复审 5 项本地补丁并通过七门禁；仅余同 SHA Hosted `architecture-required` 证据，Story 与 Sprint 保持 in-progress。
- 2026-07-22：完成第九轮复审 1 项本地补丁并通过七门禁；仅余同 SHA Hosted `architecture-required` 证据，Story 与 Sprint 保持 in-progress。
- 2026-07-22：完成第十轮复审 5 项本地补丁并通过七门禁；仅余同 SHA Hosted `architecture-required` 证据，Story 与 Sprint 保持 in-progress。
- 2026-07-22：完成第十一轮复审 3 项本地补丁并通过七门禁；仅余同 SHA Hosted `architecture-required` 证据，Story 与 Sprint 保持 in-progress。
- 2026-07-22：完成第十二轮复审 2 项本地补丁并通过七门禁；仅余同 SHA Hosted `architecture-required` 证据，Story 与 Sprint 保持 in-progress。
- 2026-07-23：最终候选 `21c25f6c5381539910daba7a151f2d4cc121fc48` 的 Hosted `architecture-required` run 29908232554 全绿，关闭 AC5 与全部复审 finding，Story 更新为 done。
