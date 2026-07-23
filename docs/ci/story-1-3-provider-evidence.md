# Story 1.3 Provider 证据

> 当前结论：生产 Provider 控制面、active/strict/无 bypass ruleset 与历史失败阻断均已激活；
> 最新审查修复候选正在迁移到规范化 Gate 实现摘要和新 producer。Hosted run `30033569375`
> 已证明 sequence=10 错批 Windows CRLF 摘要时会 fail closed，但尚未取得最终候选同 SHA 的
> artifact、attestation、Controller umbrella 与 fresh monitor 证据。实际 GitHub
> account/repository plan 和外部调度 SLA 仍缺独立证据，因此 Story 保持 `in-progress`。

## Provider 与控制面身份

- Provider：GitHub.com public repository
- 候选仓库：`Rockyyy-S/code-graph`
- repository ID：`1303415307`
- visibility：`public`
- default branch：`main`
- billing plan API 字段：当前授权令牌返回 `null`；不以 ruleset 能力替代实际 plan 证据，此项仍阻塞验收
- 外部控制面仓库：`Rockyyy-S/code-graph-gate-controller`
- 当前生产可信记录：sequence `10`，source commit `7bf20c9d8d2ded763c5252786d6060490c96ef0e`
- 当前生产 reusable producer：`2327559590f0f377c56f9cae0d51544dea78bde5`
- 当前生产 gate registry digest：`55470a32ece8a4be5872d85ff7b8acddea974034049b8bc7aeff2e001c250c90`
- 当前生产 approval evidence digest：`56435f4bc0a652642bfb6f70c4431ebe029049ca2d084c3ea53b146e64916d0f`

## 最新审查修复迁移候选

- GateHarness 实现提交：`61dc5455c2140b594410be40fbbccd4dcf9d57fa`
- reusable producer 提交：`3be138e4808de92410d2235d772ce7d423ff143d`
- 待批准 `gateRegistryDigest`：`2034633e962fc22f7d7174cb63a6babb15a9c87d8eac7db23352def56fd3e2f0`
- 待批准 `gateImplementationDigest`：`3411b9c742fea63cc11211d10cef615b97c570936b8f886e923ddf34849e8fed`
- 实现摘要投影：九项根命令、根质量工具链，以及 47 个 gate runner、工作区发现器、
  TypeScript/esbuild/ESLint/Vitest 配置、八个受保护目录、依赖锁定与直接 Node 入口；
  本地忽略的 `scripts/architecture/graphify-out` 生成缓存明确排除；受保护文本的 CRLF 统一
  规范化为 LF，确保 Windows 与 Linux checkout 产生相同摘要
- producer 隔离：候选执行 job 无 OIDC/attestation 权限，候选 lifecycle 被禁用并使用专用
  UID/GID；候选工作树对 gate 只读，artifact 由不同用户持有，attestation 在第二个干净 runner 完成
- TypeScript 增量状态：11 个 composite 配置均把 `tsconfig*.tsbuildinfo` 固定到已授权 `dist`，
  不再要求 gate UID 写入只读源码目录
- 目标可信记录：移除过宽 `.gitattributes` 后以 `TrustedGateRegistryRecordV1 sequence=12` 仅推进 source commit；审批类型
  `gate-trust-root-migration`
- 迁移状态：sequence=11 已部署；run `30036453098` 因过宽 `.gitattributes` 对历史 CRLF blob 产生 tracked diff 而 fail closed，现已移除该规则，待 sequence=12 绑定新 source

生产切换必须在精确 SHA/摘要获得明确批准后执行，并在切换后对同一主仓库候选 SHA
重新验证 child evidence、Controller umbrella、ruleset 与 monitor freshness。下方历史成功运行不能证明
本节候选已经上线；run `30033569375` 仅证明错误摘要会安全阻断。

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
| `basic-security` | `security` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#basic-security` | `debf4979f57d02b176fe98879f0a5af7509680ed400c48875fc598bd0d07ca42` |
| `build` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#build` | `81987fd4f63451a5bbb4261a265ceb8b03e9ba3c29b7f1c9e10d0d5b06fea359` |
| `contract` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#contract` | `801c7f80be6e7313dd649973c3f1a18d95a3b700e180cd76f6b598b3fe43bf29` |
| `dependency-boundary` | `architecture` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#dependency-boundary` | `4e38e62ff98a893c55688321b88a9dc4625b7767a635e171b81abcca251ca777` |
| `lint` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#lint` | `9215ead0612b23062d103b765f1638bf9c2f6722c1e7642765986d53022dfb74` |
| `planning-traceability` | `architecture-po` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#planning-traceability` | `f765da104bf830975139a415414fd48b341b8205da97c4d01345ab1b4da74304` |
| `repository-contract-preflight` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#repository-contract-preflight` | `c7e1003458057a717116d61fc820a807a51e8ef769f7c3f253b3b0a5bd0e33f8` |
| `type` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#type` | `0579374e1038e6d3f5d59e7a5fd9c0e5e3eecc96040a4064e713b2226951085d` |
| `unit` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@3be138e4808de92410d2235d772ce7d423ff143d#unit` | `88a5fd85be061ac7dd13b2b445abb5f2d6aa421608da7fdb0a47749496e97c49` |

九项 gate 均为 `blocking:true`、always applicable；旁路 registry digest 如上。

## Hosted child 失败、umbrella 阻断与恢复

| 证据 | 候选 SHA | 结果 |
| --- | --- | --- |
| child run `29987139754` | `b2c2e540e89d6a8fb2fa53a41c97a741c031430f` | 临时 contract fixture 真实失败，artifact 与 attestation 仍上传 |
| Controller run `29987237267` | 同上 | 发布 App `4372284` 的 `architecture-required=failure`，check run `89141740442` |
| PR #5 | 同上 | `mergeStateStatus=BLOCKED`；ruleset `current_user_can_bypass=never` |
| child run `29987370737` | `e416735c0d42d84324dd3c6dacd4235ae44cd3df` | revert fixture 后九项 gate 全部通过 |
| Controller run `29987457501` | 同上 | 发布正式 `architecture-required=success`，check run `89142452033` |
| child run `30033569375` | `7bf20c9d8d2ded763c5252786d6060490c96ef0e` | frozen install、OID、可信 `.git` 与 tracked diff 通过；错误 CRLF 摘要在 gate 前 fail closed，无 raw artifact |
| PR #5 | 同上 | 两个 child job 失败且无 Controller umbrella，`mergeStateStatus=BLOCKED` |
| child run `30036453098` | `f196004abf97a5d75cb131d0105ae70c765d509d` | frozen install 完成；新增 `.gitattributes` 使历史 CRLF blob 在 tracked diff 处 fail closed，无 raw artifact |

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
而降低权限。monitor 保留五分钟 schedule；Controller 改为在 monitor 完成时直接触发，并在两分钟后
保留错开的 schedule 兜底。失败、缺失或超过 15 分钟的新鲜度仍使 Controller fail closed；
GitHub cron 不提供调度 SLA，因此外部可靠触发证据仍是 Story 完成阻塞项。

## 最终验证

- 外部 Controller 审查修复分支 tests：49/49 通过
- `pnpm install --frozen-lockfile`：通过
- `pnpm architecture-required`：九项全部通过
- 历史生产候选 child evidence、Controller umbrella、ruleset 与 drift monitor：全部通过
- 最新审查修复候选：仍需 sequence=12 source 绑定与同一候选 SHA 的 Hosted 复验
- Story 1.1/1.2 provider 文档保持历史只读证据，未用旧运行替代本 Story 结果
