# Story 1.3 Provider 证据

> 当前结论：生产 Provider 已激活。外部 Controller App、独立 Drift Monitor App、
> active/strict/无 bypass ruleset、真实失败阻断、App identity 漂移检测与最终恢复均已验证。

## Provider 与控制面身份

- Provider：GitHub.com public repository
- 候选仓库：`Rockyyy-S/code-graph`
- repository ID：`1303415307`
- visibility：`public`
- default branch：`main`
- billing plan API 字段：当前授权令牌返回 `null`；不以推测 plan 作为证据，实际 ruleset 能力已通过创建、读取、阻断和恢复验证
- 外部控制面仓库：`Rockyyy-S/code-graph-gate-controller`
- 外部控制面最终实现提交：`10487d2`
- reusable producer SHA：`3a0b53163e91bf14d4a3d1e911292b267e1e968a`
- GateHarness SHA：`442b755a70109edfa1221a47bd15b896d62c68cc`
- TrustedGateRegistryRecordV1 sequence：`2`
- gate registry digest：`d1b9e3c2529514dfbe4a058ed4d17f86d4e24e05951a4391ddf09161eb113378`
- registry approval evidence digest：`3d629b2ab6ace56a23b343189bbc5cb6ac2d3c0b710b94737c3558648954e6a4`

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

## Gate Registry 交付表

| checkId | capabilityOwner | evidenceProducerId | gateDefinitionDigest |
| --- | --- | --- | --- |
| `basic-security` | `security` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#basic-security` | `05e0e6e431a48a4e21f50951d4d8f1ca224b76530cf61b13b8f284e27e2447aa` |
| `build` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#build` | `cea7b1919c73d5cc090d03528b8d10133f936e45f85275fa5967af79c597b4c0` |
| `contract` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#contract` | `bc508cb20a6b80ccbf32d2fe1d691453172137302a8144c36f903a680d019a33` |
| `dependency-boundary` | `architecture` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#dependency-boundary` | `0fd2575468fbb31d1ecf179323dfefa0df16a241a7cdb3471667a2af65074772` |
| `lint` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#lint` | `428e57af8f37d9f2d294584b4e918ebfd35e9bddb00c1ae169a1dc5f91d0bf48` |
| `planning-traceability` | `architecture-po` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#planning-traceability` | `5c7e1adfadf3c2ca09c25dea9628c2d9636a0dd2a406a321db038c63fe8c7158` |
| `repository-contract-preflight` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#repository-contract-preflight` | `29e68a9aad9154cc3d553e1676ad728a3ccb92244ca881a3b171772b950f967d` |
| `type` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#type` | `11960ea785a5f56137ed1d0cd0cefe08ed0064489043b71039ab6cd05b0993f0` |
| `unit` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3a0b53163e91bf14d4a3d1e911292b267e1e968a#unit` | `269f4ec927b79330897695a69994f87e8282ea7b4ca890d4a0f0560d99886b85` |

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

- 外部 Controller tests：23/23 通过
- `pnpm install --frozen-lockfile`：通过
- `pnpm architecture-required`：九项全部通过
- 最终候选 child evidence、Controller umbrella、ruleset 与 drift monitor：全部通过
- Story 1.1/1.2 provider 文档保持历史只读证据，未用旧运行替代本 Story 结果
