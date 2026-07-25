# 仓库布局与责任边界

本仓库采用六边形架构的模块化单体。依赖只向核心收敛，运行时组合只发生在
`apps/graph-service`；新增代码必须先确定 owner，再选择 workspace。

## Workspace owner

`packages/adapters/*` 统一属于技术实现层：只能实现 application/domain 定义的端口，
不能被核心反向导入，也不能在 `apps/graph-service` 之外承担组合根职责。

| Workspace | Owner 与允许依赖 | 禁止事项 |
| --- | --- | --- |
| `apps/graph-service` | 唯一组合根；拥有本机 IPC、握手、共享索引 Job runtime、SQLite 生命周期与实例资源 | TCP fallback、全局 daemon，或把存储/扫描职责下放给客户端 |
| `apps/cli` | 薄客户端；允许依赖 service-client、contracts | 直接访问 store/analyzer 或复制业务逻辑 |
| `apps/extension` | VS Code 薄客户端；允许依赖 service-client、contracts | 直接访问 adapter，或提前注册未实现的产品能力 |
| `apps/webview` | 渲染边界；只依赖 contracts | 直接连接服务、读取文件或持有业务计算 |
| `packages/domain` | 领域行为与不变量；不依赖其他项目包 | application、contracts、service-client、adapter、宿主 API |
| `packages/application` | 用例与稳定端口；只依赖 domain | adapter、VS Code、SQLite、Compiler API、传输 DTO |
| `packages/contracts` | 共享 Schema/DTO 与 Ajv 运行时校验的独立边界 | 领域行为、适配器实现、渲染库内部格式 |
| `packages/service-client` | 工作区身份、用户缓存发现、deadline 连接、握手与客户端生命周期 | 业务查询语义、图存储、adapter、graph-service 入口定位 |
| `packages/adapters/store-sqlite` | `GraphStorePort` 的 SQLite 实现；依赖 application/domain | 承担组合根职责、泄露 SQL/rowid，或被核心反向导入 |
| `packages/adapters/analyzer-typescript` | 分析端口实现；依赖 application/domain | 向核心泄露 Compiler API 类型 |
| `packages/adapters/git-local` | Git 端口实现；依赖 application/domain | 承担业务用例或组合逻辑 |

## 共享代码选择规则

- 领域概念、规则或不变量放入 `packages/domain`。
- 用例编排和技术无关端口放入 `packages/application`。
- 跨进程或跨 surface 的稳定数据形状放入 `packages/contracts`。
- 服务发现、连接与客户端生命周期放入 `packages/service-client`。
- SQLite、TypeScript Analyzer、Git 等技术实现放入对应 adapter。
- 无法归位时先澄清 owner。禁止通用 `utils`、`common` 或杂物 workspace。

`pnpm dependency-boundary` 同时检查 workspace manifest 与 TypeScript import 图；
新 workspace 会被自动发现，未知责任、逆向依赖或非 graph-service 组合 adapter 均失败，
诊断提供相对 POSIX 路径、规则与修复建议。内部依赖必须以规范包名和
`workspace:*` 声明；第三方依赖按 workspace 角色默认拒绝，引入前必须更新架构所有的
allowlist。

Story 1.2 的角色级第三方 allowlist 只允许 `packages/contracts` 使用 `ajv`，只允许
`packages/service-client` 与 `apps/graph-service` 使用 `vscode-jsonrpc`；其他角色及其他
Schema/RPC 库继续默认拒绝。Story 1.4 仅为 `packages/adapters/store-sqlite` 增加
`better-sqlite3@12.11.1` 与 `@types/better-sqlite3@7.6.13`，并在 `allowBuilds` 中只允许该原生包
执行受控安装脚本。版本由各 workspace manifest 与 `pnpm-lock.yaml` 锁定。

TypeScript workspace 通过 project references 表达 manifest 依赖，质量 runner 按依赖拓扑
执行 type/build，保证 clean checkout 不依赖历史 `dist` 产物。

## 根级质量命令

| 命令 | 作用 |
| --- | --- |
| `pnpm type` | 对所有 TypeScript workspace 和质量测试执行真实类型检查 |
| `pnpm lint` | 检查源码、测试和仓库脚本，并禁止 focused/skip/todo 测试 |
| `pnpm unit` | 运行 `tests/unit` 及 apps/packages 共置的 Vitest 测试，零测试或任何跳过测试失败 |
| `pnpm build` | 构建全部 workspace，并由 esbuild 构建 extension |
| `pnpm contract` | 验证工具链、workspace、extension 与 CI 仓库合同 |
| `pnpm dependency-boundary` | 验证 manifest 和 import 的依赖方向 |
| `pnpm basic-security` | 扫描产品实现/配置（含 TSX/JSX 与根 `.env*`）中的硬编码秘密和危险占位凭据 |
| `pnpm planning-trace` | 校验需求、Architecture AD、Story、DAG、相对链接、ProductValidation 引用与 sprint 屏障 |
| `pnpm architecture-required` | 从唯一 registry 执行全部适用 blocking gate，并生成 GateEvidenceV1 |

`ci/quality-gates.v1.yaml` 是注册表中全部 blocking gate 的唯一机器清单，其中包含以上质量命令与
`repository-contract-preflight`。候选仓库的 `child-gate-evidence` workflow 只调用按完整 commit
SHA 固定的 `Rockyyy-S/code-graph-gate-controller` reusable workflow，产出 child evidence 和
GitHub attestation；它不能发布权威 `architecture-required` umbrella check。

权威 `architecture-required` 只能由仓库外 Controller GitHub App 发布。Controller 通过 provider
API 拉取指定 run/attempt 的 artifact，核对 GitHub Actions App、workflow/job、OIDC issuer、
repository ID、PR merge ref、候选 head、registry/context/evidence digest，并在独立 drift monitor
确认 active、strict、无 bypass 且绑定 Controller App 的 ruleset 后才发布结论。任何证据缺失、
provider 漂移或 monitor 过期均 fail closed。Story 1.3 的真实运行与待激活项见
`docs/ci/story-1-3-provider-evidence.md`；Story 1.1/1.2 的历史基线证据继续保留。

## 本地服务控制面

每个 realpath 后的 indexing root 最多对应一个 `graph-service`。客户端统一通过
`packages/service-client` 计算 workspace-key、读取用户缓存中的 metadata/token、执行
connect-first 发现并按需启动。Windows 使用随机 Named Pipe；macOS/Linux 使用长度受控
且权限为 `0600` 的 UDS。公开 API 不接受 host/port，也不存在 TCP fallback。

indexing root 只通过私有启动配置传入服务进程，不进入 metadata、公开状态或线协议。生成数据与
工作区内容分离：数据库固定为 workspace-key 用户缓存目录下的 `graph.sqlite`，不会写入 indexing
root。服务在开放握手前完成 SQLite 打开/迁移、generation 0 ignore 快照与共享 runtime 屏障；关闭时
先停止接受新 Job 并关闭 SQLite/WAL/SHM，再清理 endpoint、metadata、token 与实例锁。

每条连接的首请求必须是 `initialize`，并依次通过 token、封闭请求形状、workspace-key 和协议
主版本校验。握手前不会返回 `service/status`；失败返回脱敏 `ErrorV1` 后关闭连接。
成功后声明 `job/start`、`service/status` 与 `service/shutdown`；同一服务实例的全部已认证连接共享
同一权威 Job/状态对象。`job/start` 当前只接受 `kind=rebuild`，首次无提交时实际 Job kind 为
`initial-index`，已有合法提交时为 `rebuild`。详细合同见
`docs/protocol/service-control-v1.md`。

工作区不存在 `.codegraphignore` 时，服务建立 `generation=0`、`validity=valid`、
`contentHash=null` 的 `EffectiveIgnoreSnapshotV1`，其 `effectiveRules` 固定包含完整
`BuiltinIgnoreV1`。若同名对象存在，本切片不解析或部分应用，控制面仍可用，但首次 Job 以
`GRAPH_IGNORE_CONFIG_UNSUPPORTED` fail closed。scanner 只消费快照并在排除后生成 TS/JS 候选，
不跟随符号链接，也不把绝对路径或源码正文写入公开合同。

SQLite migration v1 只创建 `meta`、`workspace`、`nodes`、`edges`、`evidence`、
`facts_ownership`、`jobs` 与 `schema_migrations` 八张用户表，并回验 WAL、foreign keys、
`synchronous=NORMAL` 与 5000 ms busy timeout。首次 hierarchy 在单个同步事务中提交；失败回滚，
未知更高 schema 安全拒绝并保留故障副本。业务实体使用 workspace 作用域确定性 `cg://` ID，路径
统一为 Unicode NFC 的相对 POSIX 形式，SQLite rowid 与宿主绝对路径不进入公共合同。

“从未构建”仍为 `availability=absent`、`freshness=null`、`completeness=empty`、
`committed=null`。一次可信但无受支持文件的构建会产生 terminal succeeded Job 与持久化空摘要，
状态为 available/fresh/empty；首次失败则保持 `committed=null`，并返回稳定错误 code、`logId` 与
`suggestedAction`。本切片不创建 Findings、impact、export 表，也不提前伪造 graphRevision。

## VS Code extension 模板来源

`apps/extension` 来源于 Microsoft 官方 `generator-code@1.12.0` TypeScript 模板，
明确选择 pnpm 与 esbuild。生成选项和生成后调整记录在
`apps/extension/TEMPLATE_ORIGIN.md`。

Hello World 命令、示例测试和占位 UI 已删除，激活函数保持无副作用。该模板不代表产品 UX 已完成；
真实 VS Code surface、Webview、主题、键盘和辅助技术证据属于后续 Story。
