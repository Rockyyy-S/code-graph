# 仓库布局与责任边界

本仓库采用六边形架构的模块化单体。依赖只向核心收敛，运行时组合只发生在
`apps/graph-service`；新增代码必须先确定 owner，再选择 workspace。

## Workspace owner

`packages/adapters/*` 统一属于技术实现层：只能实现 application/domain 定义的端口，
不能被核心反向导入，也不能在 `apps/graph-service` 之外承担组合根职责。

| Workspace | Owner 与允许依赖 | 禁止事项 |
| --- | --- | --- |
| `apps/graph-service` | 唯一组合根；允许依赖 application、contracts 和 adapters | 实现 Story 1.2 之前不得伪造服务、握手或索引状态 |
| `apps/cli` | 薄客户端；允许依赖 service-client、contracts | 直接访问 store/analyzer 或复制业务逻辑 |
| `apps/extension` | VS Code 薄客户端；允许依赖 service-client、contracts | 直接访问 adapter，或提前注册未实现的产品能力 |
| `apps/webview` | 渲染边界；只依赖 contracts | 直接连接服务、读取文件或持有业务计算 |
| `packages/domain` | 领域行为与不变量；不依赖其他项目包 | application、contracts、service-client、adapter、宿主 API |
| `packages/application` | 用例与稳定端口；只依赖 domain | adapter、VS Code、SQLite、Compiler API、传输 DTO |
| `packages/contracts` | 共享 Schema/DTO 的独立边界 | 领域行为、适配器实现、渲染库内部格式 |
| `packages/service-client` | 服务发现与连接边界；只依赖 contracts | 业务查询语义、图存储、adapter |
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
诊断提供相对 POSIX 路径、规则与修复建议。

## 根级质量命令

| 命令 | 作用 |
| --- | --- |
| `pnpm type` | 对所有 TypeScript workspace 和质量测试执行真实类型检查 |
| `pnpm lint` | 检查源码、测试和仓库脚本，并禁止 focused/skip/todo 测试 |
| `pnpm unit` | 运行具有真实断言的 Vitest 单元测试，零测试或跳过测试失败 |
| `pnpm build` | 构建全部 workspace，并由 esbuild 构建 extension |
| `pnpm contract` | 验证工具链、workspace、extension 与 CI 仓库合同 |
| `pnpm dependency-boundary` | 验证 manifest 和 import 的依赖方向 |
| `pnpm basic-security` | 扫描产品实现/配置中的硬编码秘密和危险占位凭据 |

GitHub 以稳定 check 名 `architecture-required` always-run 执行以上七条命令。
真实 required-check 与受控失败证据见 `docs/ci/story-1-1-provider-evidence.md`。

## VS Code extension 模板来源

`apps/extension` 来源于 Microsoft 官方 `generator-code@1.12.0` TypeScript 模板，
明确选择 pnpm 与 esbuild。生成选项和生成后调整记录在
`apps/extension/TEMPLATE_ORIGIN.md`。

Hello World 命令、示例测试和占位 UI 已删除，激活函数保持无副作用。该模板不代表产品 UX 已完成；
真实 VS Code surface、Webview、主题、键盘和辅助技术证据属于后续 Story。
