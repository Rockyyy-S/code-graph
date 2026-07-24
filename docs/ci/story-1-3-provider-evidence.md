# Story 1.3 Provider 证据

> 当前结论：生产 Provider 控制面、active/strict/无 bypass ruleset 与真实失败阻断均已激活；
> sequence=16 已绑定候选 `b853937a…`。Hosted run `30063231289` attempt 2 的九项 gate 全部
> 通过，final artifact、attestation、fresh monitor、Controller App success 与 PR `CLEAN` 已闭合；
> `/g` cleanup ownership、drift failure 撤销、历史 check 全分页及 Controller 并发竞态均已接入
> 生产可信链。实际 GitHub
> account/repository plan、具备 SLA 的外部调度和 PR opened/reopened/synchronize 可信事件源仍缺
> 独立证据，因此 Story 保持 `in-progress`。

## Provider 与控制面身份

- Provider：GitHub.com public repository
- 候选仓库：`Rockyyy-S/code-graph`
- repository ID：`1303415307`
- visibility：`public`
- default branch：`main`
- billing plan API 字段：当前授权令牌返回 `null`；不以 ruleset 能力替代实际 plan 证据，此项仍阻塞验收
- 外部控制面仓库：`Rockyyy-S/code-graph-gate-controller`
- 当前生产可信记录：sequence `16`，source commit `b853937a2aae3a78a8e2b6b7ac05be4a7d7c93bf`
- 当前生产 reusable producer：`78e84adecc7ef1b73a881dbd4bb6224ce7a7a769`
- 当前生产 gate registry digest：`779bc1d3fd9a35b7f8fe15180d9f542ca7497cade97daff434f4bc91477f6e34`
- 当前生产 gate implementation digest：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`
- 当前生产 approval evidence digest：`3967706832096969d6469cfb41a7f1bbc9009890afe05745826348f3a9a82328`

## 最新审查修复生产迁移

- GateHarness 实现提交：`da694bce36baf82a5e839ab72fe24139f4d0a25d`
- reusable producer 提交：`78e84adecc7ef1b73a881dbd4bb6224ce7a7a769`
- 已批准 `gateRegistryDigest`：`779bc1d3fd9a35b7f8fe15180d9f542ca7497cade97daff434f4bc91477f6e34`
- 已批准 `gateImplementationDigest`：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`
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
- `/g` cleanup ownership：仅当当前 job 成功创建 `/g` 并写入环境标记后才执行递归清理；预存
  `/g` 会在创建前 fail closed，且不会被 `always()` cleanup 误删
- Controller drift 撤销：运行串行排队且不取消活跃批次；任何发布或保留的 success 都在动作前
  重新读取 fresh monitor；开放 PR、workflow runs、jobs、artifacts 与 `filter=all` check history 完整
  分页，分页瞬态失败重试，drift failure 在历史读取失败时仍直接追加 App-owned failure，并对所有
  已读取 PR best-effort 撤销后汇总错误
- workspace pnpm 启动：相对 `npm_execpath=pnpm` 只允许从受控 PATH 解析；绝对 JS launcher 由
  当前 Node 执行，绝对 native launcher 直接执行，其他相对值 fail closed
- TypeScript 增量状态：11 个 composite 配置均把 `tsconfig*.tsbuildinfo` 固定到已授权 `dist`，
  不再要求 gate UID 写入只读源码目录
- 生产可信记录：`TrustedGateRegistryRecordV1 sequence=16` 已绑定 source commit、producer 与 registry；
  审批类型 `gate-trust-root-migration`
- 迁移状态：sequence=16 已部署；Controller 最新修复通过 60 项测试，Hosted run
  `30063231289` attempt 2、monitor `30063386894` 与 Controller `30063500387` 均成功

生产切换必须在精确 SHA/摘要获得明确批准后执行，并在切换后对同一主仓库候选 SHA
重新验证 child evidence、Controller umbrella、ruleset 与 monitor freshness。下方历史成功运行不能证明
本节生产链已经上线；sequence=15 与 sequence=16 的全绿运行分别保留为迁移前后证据。

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

## 历史生产 Gate Registry 交付表（sequence=15）

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

## 当前生产 Gate Registry 交付表（sequence=16）

| checkId | capabilityOwner | evidenceProducerId | gateDefinitionDigest |
| --- | --- | --- | --- |
| `basic-security` | `security` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#basic-security` | `6d16906911285fe03fa14523f0f9567c9f8998688e5cc29935ddcb06dc90c4cd` |
| `build` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#build` | `d5f333fe1e08c6310486d1b988312c16708ed4f0991a5bb512941b4141e58f2e` |
| `contract` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#contract` | `8c1fc7ce2088eaf3ae9861ef2942f14faba3289181feedd63a0112a3d886c28f` |
| `dependency-boundary` | `architecture` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#dependency-boundary` | `a2e1822f19745a3db0060597dbe3e9cedc3d93e7ab5623c42e304d7f176bdb9e` |
| `lint` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#lint` | `0190974db9788560e1f6056f94a3491f82c60737da64ad1ebb82626c5f8f0b6d` |
| `planning-traceability` | `architecture-po` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#planning-traceability` | `114bc7655edae5c9a8e9bc37ed9d6541a276ec3b4a9c15614a1a764587c74843` |
| `repository-contract-preflight` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#repository-contract-preflight` | `d2a4f6862828c941e2a4b882f69bf2739d386fcc0615192cb9b817683a46e1d5` |
| `type` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#type` | `6d921ad0d00ef8852d170ab9b5d16770510478ac4218c283aeb226c57a8279f4` |
| `unit` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@78e84adecc7ef1b73a881dbd4bb6224ce7a7a769#unit` | `d847c32668076fb1c28da9dac29ddd1b2b5a1705fbd242d58e413d211162d28a` |

候选九项仍为 `blocking:true`、always applicable；旁路 registry digest 为
`779bc1d3fd9a35b7f8fe15180d9f542ca7497cade97daff434f4bc91477f6e34`。

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
| child run `30061084230` attempt 2 | `7d600fd8f0f5752c8cbd3ec6aac1a61b97e01733` | sequence=15 生效后九项 gate 全部 `pass`，raw/final artifact 与 attestation 全部成功 |
| Controller run `30061381372` | 同上 | App `4372284` 发布 `architecture-required=success`；结果 `accepted`，九项无 failed/invalid/missing evidence |
| PR #5 | 同上 | `mergeStateStatus=CLEAN`；ruleset `19603163` 仍为 active/strict、无 bypass、`current_user_can_bypass=never` |
| child run `30063231289` attempt 2 | `b853937a2aae3a78a8e2b6b7ac05be4a7d7c93bf` | sequence=16 生效后九项 gate 全部 `pass`，`evidenceCount=9, passed=true`，raw/final artifact 与 attestation 全部成功 |
| Controller run `30063500387` | 同上 | App `4372284` 发布 check `89389784122` 为 `architecture-required=success`；结果 `accepted`，trusted sequence `16` |
| PR #5 | 同上 | `mergeStateStatus=CLEAN`；required check 仅由 Controller App `4372284` 满足 |

sequence=15 最终恢复 artifact：

- artifact ID：`8584643225`
- artifact name：`gate-evidence-30061084230-2-7d600fd8f0f5752c8cbd3ec6aac1a61b97e01733`
- provider archive digest：`sha256:ef0d72129376452f388ccc7cf5392ac5c2b7fbf74e5e638a4cbb92038634cb83`
- attested `gate-evidence.json` digest：`cc832223880665648d536131c4eb82d65b170a1ea221aa6094740c2de1a032b7`
- attestation ID：`36877829`
- gate registry digest：`ee24d8e953625d32ab6a11f12678dff0bf86e3a62115b1272f3c2f3cf10f050b`
- gate implementation digest：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`

sequence=16 最终恢复 artifact：

- raw artifact ID：`8585360068`
- final artifact ID：`8585366355`
- artifact name：`gate-evidence-30063231289-2-b853937a2aae3a78a8e2b6b7ac05be4a7d7c93bf`
- final archive digest：`sha256:9caf4b28a767e4ee0efac1c812783fa3af4ad15c17fcf6960dbbc5d18bb1bed6`
- attested `gate-evidence.json` digest：`310e95b6485bdd1e9d284d2bfb2d307ac2a15007f20b1e3c21d23e8faaeba54b`
- attestation ID：`36881454`
- evaluation context digest：`110c4e1a074e31870932138f02b6ee45460a6a4b2ed72ff6050d622c63c5ae85`
- replay digest：`cb4bee1c40eb142091129ce71b32d9eb1934b16bc175714d8d3180fbfec125aa`
- gate registry digest：`779bc1d3fd9a35b7f8fe15180d9f542ca7497cade97daff434f4bc91477f6e34`
- gate implementation digest：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`

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
| monitor `30061322093` | sequence=15 上返回 `{"issues":[],"status":"valid"}`，为 Controller success 提供 fresh monitor |
| Controller `30061381372` | sequence=15 可信根验证通过并发布 App-owned success |
| monitor `30063386894` | sequence=16 Controller commit `6bf1bde…` 上返回 `{"issues":[],"status":"valid"}` |
| Controller `30063500387` | sequence=16 验证 producer/registry/artifact/attestation 后发布 check `89389784122` success |

Drift Monitor 使用 REST 验证 ruleset 内容，并使用同一只读 App 的 GraphQL
`bypassActors.totalCount` 验证 bypass 空集合，避免因 REST 对只读 token 隐藏 `bypass_actors`
而降低权限。monitor 保留五分钟 schedule；Controller 改为在 monitor 完成时直接触发，并在两分钟后
保留错开的 schedule 兜底。失败、缺失或超过 15 分钟的新鲜度仍使 Controller fail closed；
GitHub cron 不提供调度 SLA，线上 schedule 也曾出现约 55–90 分钟延迟，因此外部可靠触发证据仍是
Story 完成阻塞项。Controller 仓库也无法直接监听目标仓库 PR 的 opened/reopened/synchronize 或 child
workflow 完成事件；在缺少 Controller App webhook、可信跨仓库 dispatch 或等价外部服务时，轮询快照
无法消除 PR 在撤销循环后 force-push/重开到旧 success SHA 的竞态。

## 最终验证

- 外部 Controller 审查修复分支 tests：60/60 通过
- `pnpm install --frozen-lockfile`：通过
- `pnpm architecture-required`：九项全部通过
- sequence=15 候选 child evidence、artifact、attestation、Controller umbrella、ruleset 与 fresh monitor：全部通过
- sequence=16 候选已完成可信记录、同 SHA Hosted 九项、artifact/attestation、fresh monitor、Controller App success 与 PR `CLEAN` 复验
- 真实 success→drift failure→App failure→恢复演练尚未针对 sequence=16 新撤销路径执行；外部可靠调度/PR webhook 与实际 plan 仍阻塞 Story 完成
- Story 1.1/1.2 provider 文档保持历史只读证据，未用旧运行替代本 Story 结果
