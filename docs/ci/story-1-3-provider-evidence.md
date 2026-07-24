# Story 1.3 Provider 证据

> 当前结论：生产 Provider 控制面、active/strict/无 bypass ruleset 与历史失败阻断均已激活；
> sequence=13 已绑定候选 `eb4665fe…`。Hosted run `30059173968` attempt 2 已证明 pnpm 不再
> 二次安装，五项 gate 通过；但 workspace runner 把 SEA 提供的相对 `npm_execpath=pnpm` 当作
> Node 脚本路径，导致 type/build 失败并使 contract/unit 缺少先行 dist。runner 修复正在迁移到
> sequence=14，尚未取得最终候选同 SHA 的全绿证据。实际 GitHub
> account/repository plan 和外部调度 SLA 仍缺独立证据，因此 Story 保持 `in-progress`。

## Provider 与控制面身份

- Provider：GitHub.com public repository
- 候选仓库：`Rockyyy-S/code-graph`
- repository ID：`1303415307`
- visibility：`public`
- default branch：`main`
- billing plan API 字段：当前授权令牌返回 `null`；不以 ruleset 能力替代实际 plan 证据，此项仍阻塞验收
- 外部控制面仓库：`Rockyyy-S/code-graph-gate-controller`
- 当前生产可信记录：sequence `13`，source commit `eb4665fe3f65ca172f3a38506976e8424c759612`
- 当前生产 reusable producer：`d49aec5544cbfece9451c92a1c0de91a9fdb6ceb`
- 当前生产 gate registry digest：`21b35a8408468c1c71800dcf2408497047a3aab429bed3a0bfc515077c4c56fe`
- 当前生产 gate implementation digest：`3411b9c742fea63cc11211d10cef615b97c570936b8f886e923ddf34849e8fed`
- 当前生产 approval evidence digest：`4624b3fe32c4000428f7fadc20b4f0fbbca456684b48fe0130a35e72cdb12eae`

## 最新审查修复迁移候选

- GateHarness 实现提交：`9b76436d1e7cbb7e81b348f503f481fb00c06933`
- reusable producer 提交：`d49aec5544cbfece9451c92a1c0de91a9fdb6ceb`
- 待批准 `gateRegistryDigest`：`21b35a8408468c1c71800dcf2408497047a3aab429bed3a0bfc515077c4c56fe`
- 待批准 `gateImplementationDigest`：`c6544b7d924c347e04e7dade8cacc908d463b2a164d015faf6f247ba4d223cec`
- 实现摘要投影：九项根命令、根质量工具链，以及 47 个 gate runner、工作区发现器、
  TypeScript/esbuild/ESLint/Vitest 配置、八个受保护目录、依赖锁定与直接 Node 入口；
  本地忽略的 `scripts/architecture/graphify-out` 生成缓存明确排除；受保护文本的 CRLF 统一
  规范化为 LF，确保 Windows 与 Linux checkout 产生相同摘要
- producer 隔离：候选执行 job 无 OIDC/attestation 权限，候选 lifecycle 被禁用并使用专用
  UID/GID；候选工作树对 gate 只读，artifact 由不同用户持有，attestation 在第二个干净 runner 完成
- pnpm 只读执行：隔离安装阶段已执行 frozen install；gate 阶段固定
  `verify-deps-before-run=false`，并向嵌套 pnpm 传递同一约束，禁止 pnpm 11 默认再次执行 install
- workspace pnpm 启动：相对 `npm_execpath=pnpm` 只允许从受控 PATH 解析；绝对 JS launcher 由
  当前 Node 执行，绝对 native launcher 直接执行，其他相对值 fail closed
- TypeScript 增量状态：11 个 composite 配置均把 `tsconfig*.tsbuildinfo` 固定到已授权 `dist`，
  不再要求 gate UID 写入只读源码目录
- 目标可信记录：以 `TrustedGateRegistryRecordV1 sequence=14` 仅推进 source commit 与实现摘要；
  审批类型 `gate-trust-root-migration`
- 迁移状态：sequence=13 已部署；run `30059173968` attempt 2 暴露 SEA 相对 `npm_execpath`，
  修复已通过 5 项定向测试、相对路径 type/build 实跑，待 sequence=14 绑定新候选

生产切换必须在精确 SHA/摘要获得明确批准后执行，并在切换后对同一主仓库候选 SHA
重新验证 child evidence、Controller umbrella、ruleset 与 monitor freshness。下方历史成功运行不能证明
本节候选已经上线；run `30059173968` attempt 2 仅证明嵌套 launcher 漂移会安全阻断并保留 artifact。

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
| `basic-security` | `security` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#basic-security` | `85382994782e290d2cdb25342bfddf86a1dcedad3f8556bed28b4595e6a5581c` |
| `build` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#build` | `93b57b2bfde538cdbdae1230d603c780129c2d0e2278be35e1e30f75c0eb0ee4` |
| `contract` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#contract` | `c50d7c943297366d7a1d4654d0f8c0dd4e55b9742a044a4d8c845eda01e0036b` |
| `dependency-boundary` | `architecture` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#dependency-boundary` | `e4b95b6077f3aeb275ef10240207183bf9301e9b2a1c3fbee90920f2125704ca` |
| `lint` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#lint` | `2be4e8f6b1996f58341e33a94f37fc2018a011731096c7f81df081e74e351ec0` |
| `planning-traceability` | `architecture-po` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#planning-traceability` | `0390e90e059d2da0fd0bb13f42c9a82233b3274c65157782e198800c3f9a57e1` |
| `repository-contract-preflight` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#repository-contract-preflight` | `37442f1eeb334739a04fd619b3d8e9f267bc073f434e8569d096b8a0dfce6b11` |
| `type` | `dev-enablement` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#type` | `c680e8a00a584d12af98ba34e94288674b7d0f103cb61815be79194b5491a825` |
| `unit` | `qa` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@d49aec5544cbfece9451c92a1c0de91a9fdb6ceb#unit` | `d6656a139b8c87b71a4d015b4d4b1ab5b019afbbb18061de4ca98b605924ea49` |

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
- sequence=13 候选已验证 fail closed；workspace runner 修复候选仍需 sequence=14 与同一 SHA Hosted 复验
- Story 1.1/1.2 provider 文档保持历史只读证据，未用旧运行替代本 Story 结果
