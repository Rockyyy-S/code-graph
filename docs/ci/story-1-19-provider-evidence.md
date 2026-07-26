# Story 1.19 Provider 与 Gate 证据

> 当前结论：确定性 rebuild、完整 read-set CAS、ownership replacement 与原子 graphRevision 已通过
> 本地全部 23 项 blocking gate。公共能力差异以隔离 Git candidate 对基线执行，结果为
> `violations=[]`。实现候选 `13e3bb7ff7ef7962c15fd16d65ec7394738d4355` 已完成 Hosted run、
> artifact attestation、Controller App umbrella check 与 ruleset freshness 闭环。本文回填本身会产生
> 新的 PR HEAD，因此最终合并仍以 PR #8 对最新精确 HEAD 发布的 required check 为唯一权威；不得把
> 下述实现候选 run 复用为后续 HEAD 的证据。

## 候选与注册表身份

- 基线 commit：`6d0c84c02b68b1f6fd6859e4f7e290ffad7693dc`
- 隔离候选 commit-tree：`224024e3b13adc13d46ddc3bed6fbd08a5ca4341`
- 公共能力差异：`violations=[]`
- Gate 数量：23，全部 `blocking:true`
- `gateRegistryDigest`：`d584077454968a04d37fc7357fb278990b5fc34f1692f1628db7b80812ea2893`
- 固定 producer commit：`0981130a71a3960aa374a82829d42aa9d9f15012`
- `evidenceProducerId` 公共前缀：
  `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@0981130a71a3960aa374a82829d42aa9d9f15012#`

候选 SHA 使用独立 `GIT_INDEX_FILE`、`git write-tree` 与 `git commit-tree` 生成，不切换分支、不修改
工作树，也不把 Story 外的临时目录或个人文档纳入候选。

## 变化公共能力

每项能力都绑定本次新增且唯一的 verifier、fixture、测试、evidenceId 与 blocking gate；
`schema:jobStartRequestV1Schema` 语义未变化，继续由 Story 1.4 的专属 gate 负责。

| capabilityId | checkId | gateDefinitionDigest | 本地 verification |
| --- | --- | --- | --- |
| `rpc:job/start` | `deterministic-rebuild-rpc-v1` | `72b0a8709361962e07932522745dad29cc373f16e3a78ca5e092d59ea02d6418` | pass |
| `schema:errorV1Schema` | `deterministic-rebuild-error-v1` | `02e92b6cc1075f2735eddbff575d67c637c22755a1d3296b31dd12734790436a` | pass |
| `schema:initializeResultCompatibleSchema` | `deterministic-rebuild-initialize-compatible-v1` | `fd78d06bd474f143e981a92716a29e771c50de7b870f974ffc3203239196680a` | pass |
| `schema:initializeResultSchema` | `deterministic-rebuild-initialize-v1` | `7d29242ec672ea8cab728eecaf5c5ef970add748b07cf1b20bc91631b5e4504b` | pass |
| `schema:jobStartResultV1Schema` | `deterministic-rebuild-job-result-v1` | `24692a6e12c0df9b60ff87cb1c8047362f8b662105b48ee9e56e168c7f7d074f` | pass |
| `schema:serviceStatusV1CompatibleSchema` | `deterministic-rebuild-status-compatible-v1` | `47d9a654bd884998b06d24bece39e4c02232e5804ec793c36afa70313e7f9a2e` | pass |
| `schema:serviceStatusV1Schema` | `deterministic-rebuild-status-v1` | `27e552776f796cc9aae3c93d39752923b7fc9f9d564dbe31c9f4103911ed9627` | pass |

## 原子提交专属 Gate

`deterministic-rebuild-atomic-v1` 使用受版本控制的
`scripts/ci/verify-deterministic-rebuild-v1.mjs`，固定运行 GraphPatch/read-set/scanner/SQLite/runtime/
state 回归集，不能通过 Gate 参数缩小范围。

- `checkId`：`deterministic-rebuild-atomic-v1`
- `capabilityOwner`：`qa`
- `gateDefinitionDigest`：`1db8518291245cfd3f5ec6cc86b6e60694d91d1e25923d441d7cf6678783dce7`
- 验证结果：7 个单元测试文件、121 个用例及 1 个真实进程合同文件、5 个用例全部通过
- 覆盖：确定性 patch/digest、ownership replacement、完整 read-set、manifest/hash、三次 stale 重排、
  partial/failed/cancelled 不提交、fault rollback、no-op/replay revision、WAL 第二读者半提交不可见

## 本地完整门禁结果

| 命令 | 结果 |
| --- | --- |
| `pnpm type` | pass |
| `pnpm lint` | pass |
| `pnpm unit` | 54 文件 / 380 用例 pass |
| `pnpm build` | pass |
| `pnpm contract` | 21 文件 / 181 用例 pass |
| `pnpm dependency-boundary` | pass |
| `pnpm basic-security` | pass |
| `pnpm planning-trace` | pass |
| `pnpm architecture-required` | 23/23 blocking gate pass |

真实进程合同在 build 后执行，覆盖 initialize → `job/start` → `service/status`；SQLite 测试使用真实
第二连接验证旧/新 revision 原子切换，并覆盖 WAL、busy timeout、迁移、ownership 与多阶段 fault
injection 全回滚。

## Hosted Provider 状态

- 实现候选 HEAD：`13e3bb7ff7ef7962c15fd16d65ec7394738d4355`
- Controller proposal：`Rockyyy-S/code-graph-gate-controller#16` 已合并，merge commit 为
  `c39610bc9d6d13774c30ef036bf9ab0a4ce2c1b5`
- Hosted run：`30204776057`；`gate-execution` 与 `gate-evidence` 均为 `success`
- Final artifact：`gate-evidence-30204776057-1-13e3bb7ff7ef7962c15fd16d65ec7394738d4355`，
  artifact 记录大小 20,389 bytes；其中 `gate-evidence.json` 为 22,444 bytes
- Evidence binding：`headOid=13e3bb7ff7ef7962c15fd16d65ec7394738d4355`、
  `gateRegistryDigest=d584077454968a04d37fc7357fb278990b5fc34f1692f1628db7b80812ea2893`、
  `gateImplementationDigest=09ada7713546528238c5ac6927026765e6100aa31a6ffdc2f28fa1b2dbdd0647`，
  23 项 evidence 全部为 `pass`
- Attestation：`gate-evidence.json` subject SHA-256 为
  `91c2cc2bcda9553434f4880b35b22906e814a9fe8ffc2660ca9b8efc6f345d12`；已使用 GitHub CLI
  验证 signer workflow 为固定 producer `produce-gate-evidence.yml@0981130a71a3960aa374a82829d42aa9d9f15012`、
  source ref 为 `refs/pull/8/merge` 且 runner 为 GitHub-hosted
- Drift monitor：run `30204738502` 在 Controller `main@c39610b` 上为 `success`
- Controller App：check run `89801143334` 由 App ID `4372284` 发布，精确绑定实现候选 HEAD，
  `architecture-required=success`
- Ruleset：ID `19603163` 为 `active`，启用 strict required status check，无 bypass actor，固定要求
  Controller App 的 `architecture-required`
- 最终 HEAD 规则：任何文档或代码提交都会使上述实现候选 evidence 失去“当前 HEAD”资格；合并前必须由
  同一 Provider 流程对 PR #8 最新 HEAD 重新生成 artifact、attestation 与 Controller success，PR
  `mergeStateStatus=CLEAN` 才视为最终闭环

私钥、installation token、webhook secret、工作区绝对路径、源码正文与文件读取缓冲均未写入证据、
日志或本文档。
