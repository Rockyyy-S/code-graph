# Story 1.19 Provider 与 Gate 证据

> 当前结论：确定性 rebuild、完整 read-set CAS、ownership replacement 与原子 graphRevision 已通过
> 本地全部 23 项 blocking gate。公共能力差异以隔离 Git candidate 对基线执行，结果为
> `violations=[]`。本任务未创建或推送正式提交，因此没有伪造 Hosted run、artifact 或 attestation；
> 合并前仍须由 Provider 对最终不可变 commit SHA 运行同一 registry。

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

- Hosted run：未触发
- 原因：当前任务未获授权创建提交、推送分支或创建 PR；Provider 只能可信绑定不可变远端 commit SHA
- 当前结论：本地 registry、公共能力 diff、全部 blocking gate 与独立代码审查均已闭合，Story 已完成本地交付
- 合并前要求：对最终正式候选 SHA 运行 `child-gate-evidence`，核对 artifact、attestation、Controller
  `architecture-required` 与 ruleset freshness；不得把本文的本地 pass 冒充 Hosted 证据

私钥、installation token、webhook secret、工作区绝对路径、源码正文与文件读取缓冲均未写入证据、
日志或本文档。
