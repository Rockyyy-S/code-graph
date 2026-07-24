# Story 1.3 Provider 证据

> 当前结论：生产 Provider 控制面、active/strict/无 bypass ruleset 与历史失败阻断均已激活；
> sequence=14 已绑定候选 `6dcb03d9…`。Hosted run `30059752064` attempt 2 中 type/build 与其余
> 五项非测试 gate 已通过，但 Harness 把完整 gateId 叠加到隔离 `TMPDIR`，使 contract/unit 的
> Unix socket fixture 超过 100-byte 安全上限。Harness 已改用短 base36 槽位，producer 与 registry
> 正在迁移到 sequence=15，尚未取得最终候选同 SHA 的全绿证据。实际 GitHub
> account/repository plan 和外部调度 SLA 仍缺独立证据，因此 Story 保持 `in-progress`。

## Provider 与控制面身份

- Provider：GitHub.com public repository
- 候选仓库：`Rockyyy-S/code-graph`
- repository ID：`1303415307`
- visibility：`public`
- default branch：`main`
- billing plan API 字段：当前授权令牌返回 `null`；不以 ruleset 能力替代实际 plan 证据，此项仍阻塞验收
- 外部控制面仓库：`Rockyyy-S/code-graph-gate-controller`
- 当前生产可信记录：sequence `14`，source commit `6dcb03d93046b7c739fd5017d5587d5fb052c55d`
- 当前生产 reusable producer：`d49aec5544cbfece9451c92a1c0de91a9fdb6ceb`
- 当前生产 gate registry digest：`21b35a8408468c1c71800dcf2408497047a3aab429bed3a0bfc515077c4c56fe`
- 当前生产 gate implementation digest：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`
- 当前生产 approval evidence digest：`2c5452b8e5237434cf5c83a72dc44423fb57d76d30e78dcede3e6f8afc526540`

## 最新审查修复迁移候选

- GateHarness 实现提交：`da694bce36baf82a5e839ab72fe24139f4d0a25d`
- reusable producer 提交：`48a9ee8b1034f4b656a209bc6f1138dcd3755311`
- 待批准 `gateRegistryDigest`：`ee24d8e953625d32ab6a11f12678dff0bf86e3a62115b1272f3c2f3cf10f050b`
- 待批准 `gateImplementationDigest`：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`
- 实现摘要投影：九项根命令、根质量工具链，以及 47 个 gate runner、工作区发现器、
  TypeScript/esbuild/ESLint/Vitest 配置、八个受保护目录、依赖锁定与直接 Node 入口；
  本地忽略的 `scripts/architecture/graphify-out` 生成缓存明确排除；受保护文本的 CRLF 统一
  规范化为 LF，确保 Windows 与 Linux checkout 产生相同摘要
- producer 隔离：候选执行 job 无 OIDC/attestation 权限，候选 lifecycle 被禁用并使用专用
  UID/GID；候选工作树对 gate 只读，artifact 由不同用户持有，attestation 在第二个干净 runner 完成
- pnpm 只读执行：隔离安装阶段已执行 frozen install；gate 阶段固定
  `verify-deps-before-run=false`，并向嵌套 pnpm 传递同一约束，禁止 pnpm 11 默认再次执行 install
- Hosted 路径预算：每个 gate 的 HOME/TMP 使用 registry 顺序的 base36 短槽位，workflow 以
  root-owned `/g` 作为临时根；最长现有 Unix socket fixture 保持在 100-byte 安全上限内
- workspace pnpm 启动：相对 `npm_execpath=pnpm` 只允许从受控 PATH 解析；绝对 JS launcher 由
  当前 Node 执行，绝对 native launcher 直接执行，其他相对值 fail closed
- TypeScript 增量状态：11 个 composite 配置均把 `tsconfig*.tsbuildinfo` 固定到已授权 `dist`，
  不再要求 gate UID 写入只读源码目录
- 目标可信记录：以 `TrustedGateRegistryRecordV1 sequence=15` 推进 source commit、producer 与 registry；
  审批类型 `gate-trust-root-migration`
- 迁移状态：sequence=14 已部署；run `30059752064` attempt 2 暴露隔离 TMP 路径预算，
  Harness 修复已通过 50 项 Controller 测试，待 sequence=15 绑定新 producer 与候选

生产切换必须在精确 SHA/摘要获得明确批准后执行，并在切换后对同一主仓库候选 SHA
重新验证 child evidence、Controller umbrella、ruleset 与 monitor freshness。下方历史成功运行不能证明
本节候选已经上线；run `30059752064` attempt 2 仅证明路径预算漂移会安全阻断并保留 artifact。

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
| `basic-security` | `security` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#basic-security` | `005f8fe2c3d89c9dfcb887742585323ae96dfcc395cdaa84a53606b52d4a2b37` |
| `build` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#build` | `e575cad0bf0a2fbb2734fbc78667613c3ef1f1dd7b50ab7293f0fcc4ee9712fa` |
| `contract` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#contract` | `5198730c45c427406e6ec3bd62d08e1ec513941df50aed7d4d8987917f467b23` |
| `dependency-boundary` | `architecture` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#dependency-boundary` | `88ca94c829a867b3cd6d65a2659ac203aab0ad4e251f08c2fefec30d3d4917ec` |
| `lint` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#lint` | `53744114cddedb0fd0dc5c3f8bf093e6fd9889aeaab4f577413871669aa06947` |
| `planning-traceability` | `architecture-po` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#planning-traceability` | `c18f238f19f7b956d3260b5cd3aae5620d484177661588be8ebb3cda87f97842` |
| `repository-contract-preflight` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#repository-contract-preflight` | `13bd9855acc4e73a96c64412fa4d70773163ae1f53484db6fa950fcef86fb6d5` |
| `type` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#type` | `2743a4dd9a2f27e651c60700e3a4ae058325b2a0afd3837c93d1c1111627aabf` |
| `unit` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@48a9ee8b1034f4b656a209bc6f1138dcd3755311#unit` | `e87a5c9e8f4655cf9e77cc2dd4b3ecd36b4186cb990083d3e40a3c2fff43be18` |

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
| child run `30058268244` | `c07840f3f343e79a4c8ae82d2662dcda341fd88f` | raw/final artifact 与 attestation 成功；preflight 通过，八项 pnpm gate 因默认二次 install 写只读候选根而失败 |
| Controller run `30058315791` | 同上 | App `4372284` 发布 `architecture-required=failure`，check run `89374586128`；PR #5 保持 `BLOCKED` |
| child run `30059173968` attempt 2 | `eb4665fe3f65ca172f3a38506976e8424c759612` | basic-security、dependency-boundary、lint、planning-traceability、preflight 通过；type/build 因相对 `npm_execpath` 失败，contract/unit 级联失败 |
| final artifact `8583944858` | 同上 | archive digest `sha256:5f63005f4586bfe6e7dee10087dd6ff2f54e53794c0eeafda2dad130b6f2dd6b`；attested evidence digest `0a3c2326247ac39d03b641fb2564ee3e0a2261100a82fff9f920d4f157d2d8d8` |
| child run `30059752064` attempt 2 | `6dcb03d93046b7c739fd5017d5587d5fb052c55d` | basic-security、build、dependency-boundary、lint、planning-traceability、preflight、type 通过；contract/unit 因 Harness TMP 路径超过 Unix socket 100-byte 上限失败 |
| final artifact `8584151519` | 同上 | archive digest `sha256:79bb858e1879c3cb5c14da475aa87f73f6173d78ff9b4ff6577887599185a69d`；`gate-evidence.json` digest `ba7543e3bed0452fbd42f411fc53df5470713aafac279967c675eefccde571d1` |

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
| monitor `30059860309` | sequence=14 路径失败后重新验证 active/strict、App identity 与无 bypass 状态并通过 |
| Controller `30059874721` | fresh monitor 完成事件触发后成功执行控制面检查 |

Drift Monitor 使用 REST 验证 ruleset 内容，并使用同一只读 App 的 GraphQL
`bypassActors.totalCount` 验证 bypass 空集合，避免因 REST 对只读 token 隐藏 `bypass_actors`
而降低权限。monitor 保留五分钟 schedule；Controller 改为在 monitor 完成时直接触发，并在两分钟后
保留错开的 schedule 兜底。失败、缺失或超过 15 分钟的新鲜度仍使 Controller fail closed；
GitHub cron 不提供调度 SLA，因此外部可靠触发证据仍是 Story 完成阻塞项。

## 最终验证

- 外部 Controller 审查修复分支 tests：50/50 通过
- `pnpm install --frozen-lockfile`：通过
- `pnpm architecture-required`：九项全部通过
- 历史生产候选 child evidence、Controller umbrella、ruleset 与 drift monitor：全部通过
- sequence=14 候选已验证七项通过且路径预算 fail closed；短运行目录候选仍需 sequence=15 与同一 SHA Hosted 复验
- Story 1.1/1.2 provider 文档保持历史只读证据，未用旧运行替代本 Story 结果
