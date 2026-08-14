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
| `packages/adapters/analyzer-typescript` | `AnalyzerPort` 的真实 Worker 实现；只依赖 application/domain 与精确 `typescript@6.0.3` | 向核心泄露 Compiler API 类型、读取任意工作区物理路径、加载 plugin/transformer/scripts 或引入第二解析器 |
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
执行受控安装脚本。Story 1.5 仅为 `packages/adapters/analyzer-typescript` 增加
`typescript@6.0.3` workspace 专属 allowlist；其他 adapter 仍不得声明 TypeScript 或第二解析器。
版本由各 workspace manifest 与 `pnpm-lock.yaml` 锁定。

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
`repository-contract-preflight`。`typescript-module-analysis-v1` 额外构建真实 Worker 产物，并固定运行
配置封口、AD-24、目标解析、source FactBatch、composite patch、SQLite v3 与单 revision runtime 回归。
候选仓库的 `child-gate-evidence` workflow 只调用按完整 commit
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
`BuiltinIgnoreV1`。若同名对象存在，本切片不解析或部分应用，控制面仍可用，但 Job 以
`GRAPH_IGNORE_CONFIG_UNSUPPORTED` fail closed。scanner 只消费快照，使用已打开文件句柄读取原始
字节并计算 SHA-256；读取前后复核普通文件、realpath containment、inode/设备/长度与时间元数据，
单文件超过 10 MiB 或扫描中被替换时稳定失败；hash 使用固定小缓冲有界读取，并把 root、目录、
候选路径与已打开句柄的设备/文件身份交叉绑定，避免同路径替换或 Windows reparse 竞态先读取错误
对象。manifest 使用 NFC 相对 POSIX 路径与区域无关的 UTF-16 码元序，不把绝对路径、源码正文或
读取缓冲写入公开合同和持久摘要。

`packages/application` 把稳定 hierarchy 转为 `HierarchyFactBatchV1`，ownership 固定为
`hierarchy:<cg://.../workspace/>`。只有 complete batch 能计算 replacement `GraphPatchV1`；patch
按 node/edge ID 排序并以目标语义状态计算 digest，不包含 Job、时间、generation 或 base revision。
相同目标状态重算与重放是 no-op，不产生重复事实、孤立 ownership 或无意义 revision。

TypeScript/JavaScript 分析由构建后的 `analyzer-worker.js` 使用 TypeScript 6.0.3 稳定公开 API 完成。
scanner 交付与 manifest hash 同次读取的不可变源码字节；Worker 只返回逻辑解析候选路径，
`apps/graph-service` 经过普通文件、realpath containment、文件身份、单文件/总量预算检查后分阶段回送
`package.json`、声明文件等解析元数据；broker 在候选数量、路径/文件字节与依赖深度预算内持续迭代至
配置观察稳定，稳定确认本身不额外消耗依赖深度。冻结的
`AnalyzerConfigSnapshotV1`、`configDigest` 与 `inputDigest` 绑定全部实际文件 hash；提交同步栅栏在 mutation
前后再次复核这些字节。`rules.yaml`、项目 plugin、transformer、scripts 与 tsserver 私有状态不进入分析。

application 将 hierarchy 与全部 `source:typescript:<fileId>` Evidence slice 组合为唯一
`CompositeGraphPatchV1`。共享 imports/exports edge 与 external-package/node-builtin 节点不伪装成单一
source owner；一次 logical rebuild 只调用一次 `commitAtomicGraphUpdate()`、只开启一个同步事务并至多推进
一个 graph revision。`detectedAt` 不进入身份或语义 digest；移除 import 或删除 source slice 会在 complete
replacement 中退休旧 Evidence 与失去支持的模块 edge。

service-instance 级 `IndexReadSetProvider` 捕获规范 manifest/hash、完整 ignore snapshot、
`bootstrapGeneration`、`statusEpoch` 与 `baseGraphRevision`。`inputDigest/configDigest` 只绑定规范输入和
有效 ignore/producer 语义，generation/revision 仅作为完整 CAS 栅栏。提交前重新采集 read-set；过期
patch 被丢弃，并在同一 logical Job 内最多重排三次，旧 committed revision 全程可读。

SQLite migration v1 创建的 `meta`、`workspace`、`nodes`、`edges`、`evidence`、
`facts_ownership`、`jobs` 与 `schema_migrations` 八张用户表保持不变；migration v2 只演进现有表，
增加 graph revision、持久 freshness/completeness、read-set/patch digest、ownership kind 与 Job
base/result revision。旧的真实空图
或非空图保留并初始化为 revision 1，因为缺少可证明 read-set 而标记 stale；无提交的 v1 仍保持
absent。唯一 `commitAtomicGraphUpdate()` 在一个同步 `better-sqlite3.transaction()` 内完成 base/read-set
CAS、节点/边/ownership patch、摘要、digest、revision 与 Job 绑定；Job 额外保存完整 read-set JSON 与
patch digest，启动恢复会同 workspace digest、revision、真实 ownership 和绑定 succeeded Job 交叉回验。
snapshot 读取也使用单一只读事务，任一步失败整体回滚；WAL 第二读者只能在提交前看到旧 revision、
提交后一次看到新 revision。WAL、foreign keys、
`synchronous=NORMAL`、5000 ms busy timeout、未知高版本拒绝和故障副本规则继续保留。

migration v3 仍保持精确八表，通过单事务表重建扩展封闭 node/edge/ownership CHECK：hierarchy 节点继续
使用相对路径，外部 npm 节点使用版本化 purl，Node built-in 使用 `node:` 身份；关系允许
`contains|imports|exports` 且唯一性包含 qualifier。结构化 Evidence 保存 AD-21 ID 所需字段并由
`source:typescript:<fileId>` 唯一持有。重启恢复分别验证 hierarchy 树、source ownership、完整全图
`targetGraphDigest`、Job/read-set/patch digest 与 workspace 摘要，不能用全图计数冒充 hierarchy 子图计数。

“从未构建”仍为 `availability=absent`、`freshness=null`、`completeness=empty`、
`committed=null`、`graphRevision=null`。真实提交为 available/current，partial、failed、cancelled 或
CAS 重排不会覆盖最后完整 ownership；partial/stale 证据会持久化，重启不得恢复成虚假 current/complete。
logical Job 的初始 base 与重排 attempt 的 CAS base 分离；旧迁移图和发现输入变化的状态为 stale。terminal Job 显式携带
base/result revision，service/status revision 不与 graphRevision 混用。本切片不创建 Findings、impact、
export 表，也不新增公共 cancel/query RPC。

## VS Code extension 模板来源

`apps/extension` 来源于 Microsoft 官方 `generator-code@1.12.0` TypeScript 模板，
明确选择 pnpm 与 esbuild。生成选项和生成后调整记录在
`apps/extension/TEMPLATE_ORIGIN.md`。

Hello World 命令、示例测试和占位 UI 已删除，激活函数保持无副作用。该模板不代表产品 UX 已完成；
真实 VS Code surface、Webview、主题、键盘和辅助技术证据属于后续 Story。
