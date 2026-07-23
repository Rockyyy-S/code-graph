# Story 1.3 Provider 证据

> 当前结论：现有生产 Provider 基线已激活；Story 1.3 审查修复候选尚未部署。
> 外部 Controller App、独立 Drift Monitor App、active/strict/无 bypass ruleset、真实失败阻断、
> App identity 漂移检测与历史恢复均已验证。新的 gate 实现摘要信任根仍待明确批准和生产切换，
> 实际 GitHub account/repository plan 仍缺独立证据，因此 Story 保持 `in-progress`。

## Provider 与控制面身份

- Provider：GitHub.com public repository
- 候选仓库：`Rockyyy-S/code-graph`
- repository ID：`1303415307`
- visibility：`public`
- default branch：`main`
- billing plan API 字段：当前授权令牌返回 `null`；不以 ruleset 能力替代实际 plan 证据，此项仍阻塞验收
- 外部控制面仓库：`Rockyyy-S/code-graph-gate-controller`
- 外部控制面最终实现提交：`10487d2`
- reusable producer SHA：`3a0b53163e91bf14d4a3d1e911292b267e1e968a`
- GateHarness SHA：`442b755a70109edfa1221a47bd15b896d62c68cc`
- TrustedGateRegistryRecordV1 sequence：`2`
- gate registry digest：`d1b9e3c2529514dfbe4a058ed4d17f86d4e24e05951a4391ddf09161eb113378`
- registry approval evidence digest：`3d629b2ab6ace56a23b343189bbc5cb6ac2d3c0b710b94737c3558648954e6a4`

## 审查修复迁移候选（未部署）

- GateHarness 实现提交：`c90a2ceaea134228ce81e1045d27e32de1f4937f`
- reusable producer 提交：`4d3650e1698afe83dbb347a3f9115dcc40b6d352`
- 待批准 `gateRegistryDigest`：`0a4937d97bbaaf8288af350fd4f67b1ee9f68d7b00392dcacc9413279f2bf155`
- 待批准 `gateImplementationDigest`：`3294b01cbe2d0190bc94b275f8bcb4ba3c3bb69ec26e3143131d00c4625ec4b2`
- 实现摘要投影：九项根命令、根质量工具链，以及 47 个 gate runner、工作区发现器、
  TypeScript/esbuild/ESLint/Vitest 配置、八个受保护目录、依赖锁定与直接 Node 入口；
  本地忽略的 `scripts/architecture/graphify-out` 生成缓存明确排除，确保 clean checkout 可复现
- producer 隔离：候选执行 job 无 OIDC/attestation 权限，候选 lifecycle 被禁用并使用专用
  UID/GID；候选工作树对 gate 只读，artifact 由不同用户持有，attestation 在第二个干净 runner 完成
- 目标可信记录：`TrustedGateRegistryRecordV1 sequence=3`，审批类型
  `gate-trust-root-migration`
- 迁移状态：仅生成本地不可变提交与候选摘要；未推送、未改写外部可信记录、未切换生产 Controller

生产切换必须在精确 SHA/摘要获得明确批准后执行，并在切换后对同一主仓库候选 SHA
重新验证 child evidence、Controller umbrella、ruleset 阻断与恢复。下方 Hosted 运行仍是旧信任根的历史证据，
不能证明本节候选已经上线。

## GitHub App 与最小权限

| App | App ID | Repository permissions | Events |
| --- | --- | --- | --- |
| `rockyyy-code-graph-controller` | `4372284` | Actions read、Checks write、Contents read、Metadata read、Pull requests read | 空集合 |
| `rockyyy-code-graph-drift-monitor` | `4372296` | Administration read、Contents read、Metadata read | 空集合 |

两个 App 均只安装到 `Rockyyy-S/code-graph`。外部仓库 Actions Secrets 已配置以下名称：

- `CONTROLLER_APP_ID`
- `CONTROLLER_PRIVATE_KEY`
- `DRIFT_MONITOR_APP_ID`
- `DRIFT_MONITOR_PRIVATE_KEY`

私钥、installation token、webhook secret 均未写入源码、artifact、日志或本文档。

## 生产 ruleset

- ruleset ID：`19603163`
- name：`architecture-required`
- target：`branch`
- branch include：`refs/heads/main`
- enforcement：`active`
- strict/current-head：`true`
- required context：`architecture-required`
- integration ID：Controller App `4372284`
- bypass actors：空集合
- `current_user_can_bypass`：`never`
- 旧 branch protection `required_status_checks`：已移除

迁移顺序为：保留旧保护 → 创建新 active ruleset → monitor 通过 → Controller App 发布正式 pass →
移除旧 GitHub Actions required check → monitor/Controller 再次通过。全过程只有阻塞窗口，没有无保护窗口。

## 审查修复候选 Gate Registry 交付表

| checkId | capabilityOwner | evidenceProducerId | gateDefinitionDigest |
| --- | --- | --- | --- |
| `basic-security` | `security` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#basic-security` | `0877429d7e757f66c2f0ef62deeb86e96522c7fa8fdcbaaf4055ea77e364a547` |
| `build` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#build` | `e3c3e3f01cc52074bc80d22b3c3732b338281e2f54e2a7d13083cf6d71eda4ca` |
| `contract` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#contract` | `5a19c436a429dd65a39d53d2e15e3ec8cc36022ec9cdf9f1bc03ae2591f01d0a` |
| `dependency-boundary` | `architecture` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#dependency-boundary` | `871c259477f7022228d4318f72a757347c602155f8a608f0e81ee62ebcff5924` |
| `lint` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#lint` | `3fa854d0c801494314ea0f32bf40f60bc500397ff1dbc4fa2b8f583b570ba09a` |
| `planning-traceability` | `architecture-po` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#planning-traceability` | `b89f2ed1d7d74a24f59d3343bcd9d136fcad0cc617926a3b12c1ca1989e533aa` |
| `repository-contract-preflight` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#repository-contract-preflight` | `f2b9e4ffeb654ed3f1e74f50205eedfdee74baddb61415023a0634588b7e0cbe` |
| `type` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#type` | `716af6dc1f08e139d579a6e883421b194bd18d72064769826f7e21f1692207a9` |
| `unit` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@4d3650e1698afe83dbb347a3f9115dcc40b6d352#unit` | `28fabd86623e7ab4b00a147426a291d02ef0cb4802b6d53c59e29b705beabee4` |

九项 gate 均为 `blocking:true`、always applicable；旁路 registry digest 如上。

## Hosted child 失败、umbrella 阻断与恢复

| 证据 | 候选 SHA | 结果 |
| --- | --- | --- |
| child run `29987139754` | `b2c2e540e89d6a8fb2fa53a41c97a741c031430f` | 临时 contract fixture 真实失败，artifact 与 attestation 仍上传 |
| Controller run `29987237267` | 同上 | 发布 App `4372284` 的 `architecture-required=failure`，check run `89141740442` |
| PR #5 | 同上 | `mergeStateStatus=BLOCKED`；ruleset `current_user_can_bypass=never` |
| child run `29987370737` | `e416735c0d42d84324dd3c6dacd4235ae44cd3df` | revert fixture 后九项 gate 全部通过 |
| Controller run `29987457501` | 同上 | 发布正式 `architecture-required=success`，check run `89142452033` |

最终恢复 artifact：

- artifact ID：`8555575969`
- artifact name：`gate-evidence-29987370737-1-e416735c0d42d84324dd3c6dacd4235ae44cd3df`
- provider archive digest：`sha256:32e147404cb89ac97c1666130be6fafb80262926345c6f1f37e867e0f7cc13ff`
- attested `gate-evidence.json` digest：`962913710943c77513433362224ede7ff1279075cfe316d4419278cc6a15ee47`
- evaluation context digest：`af502cad4f103858d2f2d890c3b3f82ffd5906c08ca6fef0ffca99b66f9ee5f9`
- base/comparison OID：`e29edc1f6cb06b1a8670a9b784a0adad7b7f6b42`
- source PR merge commit：`6d2398edae151f2e4fb15a17d88bf836349b59d5`
- provider gate job/check：`89142143509`，GitHub Actions App ID `15368`

## Drift 演练与恢复

| 运行 | 结果 |
| --- | --- |
| monitor `29986321756` | ruleset 尚不存在时检测 `ruleset-count-drift` 并失败 |
| monitor `29986650681` | active/strict/无 bypass/Controller App ruleset 创建后通过 |
| monitor `29987529815` | integration ID 临时改为错误 App `15368` 后检测 `required-check-drift` 并失败 |
| Controller `29987576544` | 因最新 monitor 失败而 fail closed，不发布新结论 |
| monitor `29987637959` | integration ID 恢复为 `4372284` 后通过 |
| Controller `29987688733` | 恢复后重新验证最终候选和正式 check 成功 |

Drift Monitor 使用 REST 验证 ruleset 内容，并使用同一只读 App 的 GraphQL
`bypassActors.totalCount` 验证 bypass 空集合，避免因 REST 对只读 token 隐藏 `bypass_actors`
而降低权限。Controller 与 monitor workflow 均配置五分钟 schedule，并支持受控手动运行；
失败、缺失或超过 15 分钟的新鲜度均使 Controller fail closed。

## 最终验证

- 外部 Controller 审查修复分支 tests：43/43 通过
- `pnpm install --frozen-lockfile`：通过
- `pnpm architecture-required`：九项全部通过
- 历史生产候选 child evidence、Controller umbrella、ruleset 与 drift monitor：全部通过
- 审查修复候选：本地门禁通过后仍需生产切换与同一候选 SHA 的 Hosted 复验
- Story 1.1/1.2 provider 文档保持历史只读证据，未用旧运行替代本 Story 结果
