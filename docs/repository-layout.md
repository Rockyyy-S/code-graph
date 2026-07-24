# 仓库布局与责任边界

本仓库采用六边形架构的模块化单体。依赖只向核心收敛，运行时组合只发生在
`apps/graph-service`；新增代码必须先确定 owner，再选择 workspace。

## Workspace owner

`packages/adapters/*` 统一属于技术实现层：只能实现 application/domain 定义的端口，
不能被核心反向导入，也不能在 `apps/graph-service` 之外承担组合根职责。

| Workspace | Owner 与允许依赖 | 禁止事项 |
| --- | --- | --- |
| `apps/graph-service` | 唯一组合根；拥有本机 IPC 服务、握手、空状态与实例资源 | TCP fallback、全局 daemon，或提前组合索引/存储能力 |
| `apps/cli` | 薄客户端；允许依赖 service-client、contracts | 直接访问 store/analyzer 或复制业务逻辑 |
| `apps/extension` | VS Code 薄客户端；允许依赖 service-client、contracts | 直接访问 adapter，或提前注册未实现的产品能力 |
| `apps/webview` | 渲染边界；只依赖 contracts | 直接连接服务、读取文件或持有业务计算 |
| `packages/domain` | 领域行为与不变量；不依赖其他项目包 | application、contracts、service-client、adapter、宿主 API |
| `packages/application` | 用例与稳定端口；只依赖 domain | adapter、VS Code、SQLite、Compiler API、传输 DTO |
| `packages/contracts` | 共享 Schema/DTO 与 Ajv 运行时校验的独立边界 | 领域行为、适配器实现、渲染库内部格式 |
| `packages/service-client` | 工作区身份、用户缓存发现、deadline 连接、握手与客户端生命周期 | 业务查询语义、图存储、adapter、graph-service 入口定位 |
| `packages/adapters/store-sqlite` | 存储端口实现；依赖 application/domain | 承担组合根职责或被核心反向导入 |
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
Schema/RPC 库继续默认拒绝。版本由各 workspace manifest 与 `pnpm-lock.yaml` 锁定。

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

`ci/quality-gates.v1.yaml` 是九项 blocking gate 的唯一机器清单，其中包含以上质量命令与
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

每条连接的首请求必须是 `initialize`，并依次通过 token、封闭请求形状、workspace-key 和协议
主版本校验。握手前不会返回 `service/status`；失败返回脱敏 `ErrorV1` 后关闭连接。
成功后仅声明 `service/status` 与 `service/shutdown`，详细合同见
`docs/protocol/service-control-v1.md`。

当前空状态是合法产品状态：`availability=absent`、`freshness=null`、
`completeness=empty`、`committed=null`。本 Story 不创建 SQLite、节点、边、Findings、
graphRevision、索引 Job 或成功索引时间。

## VS Code extension 模板来源

`apps/extension` 来源于 Microsoft 官方 `generator-code@1.12.0` TypeScript 模板，
明确选择 pnpm 与 esbuild。生成选项和生成后调整记录在
`apps/extension/TEMPLATE_ORIGIN.md`。

Hello World 命令、示例测试和占位 UI 已删除，激活函数保持无副作用。该模板不代表产品 UX 已完成；
真实 VS Code surface、Webview、主题、键盘和辅助技术证据属于后续 Story。
