# Story 1.4 Provider 与门禁证据

> 当前结论：Story 1.4 的最终候选必须以 PR #8 上当前不可变 HEAD 的外部 GitHub Checks
> 为权威；`architecture-required`、Hosted child evidence、attestation、Controller App、fresh
> drift monitor 与无 bypass ruleset 必须绑定同一 SHA。为避免“写回运行 ID → 产生新 SHA →
> 证据再次失效”的循环，最终运行 ID 与 artifact ID 只保存在外部检查中，不回写本提交。

## 最终 HEAD 闭环合同

- 最终候选 SHA：以包含本文档的冻结 Git commit 及 PR #8 当前 HEAD 为准。
- 本地前置：22/22 blocking gate、公共能力差异、repository preflight 与完整测试全部通过。
- 外部完成条件：同一 SHA 的 Provider child evidence、attestation、Controller App
  `architecture-required=success`、fresh monitor 与 active/strict/no-bypass ruleset 全部成功。
- 证据定位：从 PR #8 当前 HEAD 的 required check 进入，不依赖仓库内缓存的 run ID。
- 失败处理：任一外部条件失败都必须修复并冻结新 SHA，旧 SHA 的成功证据不得复用。

## 二次复审修复候选

- blocking gate 数：`22`
- `gateRegistryDigest`：`b91f8793a5edb4a1f8428c2aca88ba6ecd7b89e23a4a5af1ab72217979903a4f`
- `gateImplementationDigest`：`373c7a258c69095876b64330482ed54cb2e1bd1eb776cc4bd53a43049d58bf86`
- 固定 producer commit：`0981130a71a3960aa374a82829d42aa9d9f15012`
- 本地验证：`pnpm unit` 45 文件 / 279 用例、`pnpm contract` 21 文件 / 179 用例、
  `pnpm type`、`pnpm lint`、`pnpm build`、`pnpm dependency-boundary`、
  `pnpm basic-security`、`pnpm planning-trace` 与本地 `architecture-required` 22/22 全部通过。
- 本轮修复：兼容旧 v1 Job 字段缺失；校验真实 UTC 日历时间与 hierarchy 摘要计数；
  为 NFC/NFD 公共 identity 增加私有物理根隔离；扫描期间复验目录身份并支持 shutdown 取消；
  将 ignore/queued 预运行失败记录为可查询 failed Job；SQLite close 失败可重试，故障备份异步包含
  主文件、WAL、SHM，最多保留三组且总计不超过 64 MiB；rebuild 超时后关闭连接并清空待响应 ID。
- 修复后复核：未协商 `job/start` 的旧服务连接保持可用；root-bound discovery 对 legacy 缓存 fail closed；
  公共 Schema 可由标准严格 Ajv 直接编译；legacy `.bak` 纳入轮转；取消路径跳过同步失败写；
  声明 `job/start` 时强制 Job 状态字段；时间回拨保持 Job 生命周期单调；启动时交叉校验 SQLite
  摘要、实际 hierarchy 与 terminal Job。
- 外部状态：候选 SHA 尚未冻结；必须在提交并推送后，对新 HEAD 完整重跑 Provider child evidence、
  attestation、Controller App `architecture-required`、fresh drift monitor 与 ruleset 校验。

## 历史候选与可信 Registry（已被最终 HEAD 取代）

- 比较基线：`cb60d0039507da4c1629cd478e0bd43f287eb663`
- 候选 SHA：`754cc52177ae3ee42dff7a2a545b6faf7ab503d2`
- Provider repository ID：`1303415307`
- PR：`Rockyyy-S/code-graph#8`
- 可信 proposal sequence：`18`
- Controller proposal PR：`Rockyyy-S/code-graph-gate-controller#9`
- Controller proposal merge commit：`bedd8e6a83b3ba263d70ee47f53c59f7389fac2f`
- blocking gate 数：`22`
- `gateRegistryDigest`：`b91f8793a5edb4a1f8428c2aca88ba6ecd7b89e23a4a5af1ab72217979903a4f`
- `gateImplementationDigest`：`84665464a3cead64925ede02cad4d509442916e7ffa4fffa2a57d994dc1f5ce2`
- 固定 producer commit：`0981130a71a3960aa374a82829d42aa9d9f15012`

## 变化公共能力交付表

下列 gate 均为 `blocking:true`、`capabilityOwner=qa`，命令、fixture、测试与 evidenceId 一一独占。
`evidenceProducerId` 的共同前缀为
`gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@0981130a71a3960aa374a82829d42aa9d9f15012#`。

| capabilityId | checkId | evidenceProducerId 后缀 | gateDefinitionDigest | Hosted |
| --- | --- | --- | --- | --- |
| `rpc:job/start` | `graph-bootstrap-rpc-v1` | `graph-bootstrap-rpc-v1` | `14e024a8f6edf1ae95672340031ea9556b4c600fe946c2c4bd1122eaa71770e0` | pass |
| `schema:errorV1Schema` | `graph-bootstrap-error-v1` | `graph-bootstrap-error-v1` | `68496d099135d1b21823957ca56c2156bb62619d9c72ff463680a10c97172f2e` | pass |
| `schema:initializeResultCompatibleSchema` | `graph-bootstrap-initialize-compatible-v1` | `graph-bootstrap-initialize-compatible-v1` | `f4487e9987753b674830ea05b43b411909dac8de8a11ccc6a9ad6e4da830fd66` | pass |
| `schema:initializeResultSchema` | `graph-bootstrap-initialize-v1` | `graph-bootstrap-initialize-v1` | `eb2000ec5b5ae296c7b809b4c2c8358d6e0ea7041f099735d2960a75f64715b6` | pass |
| `schema:jobStartRequestV1Schema` | `graph-bootstrap-job-request-v1` | `graph-bootstrap-job-request-v1` | `5147390e95fa9f7ace2b46d7b95516fcdfddd3b1425e88b5d5a02bcc4fc69f3c` | pass |
| `schema:jobStartResultV1Schema` | `graph-bootstrap-job-result-v1` | `graph-bootstrap-job-result-v1` | `9fe406f0886eb3bb4e715a96aee8bdf923f8798d6f9b7afe238acc119630db76` | pass |
| `schema:serviceStatusV1CompatibleSchema` | `graph-bootstrap-status-compatible-v1` | `graph-bootstrap-status-compatible-v1` | `d355ac69c6e628db69c5e6367d40d157bc1e8c26a0d66ecf0403974945d47858` | pass |
| `schema:serviceStatusV1Schema` | `graph-bootstrap-status-v1` | `graph-bootstrap-status-v1` | `581e789825bb14d45a836bd5e94c66fd0a64089f357053149ff333a91f89da51` | pass |

## 历史 Hosted artifact、attestation 与 Controller 结论

- child workflow：`child-gate-evidence`
- run / attempt：`30152595619` / `2`
- gate execution job：`89665747084`
- evidence signing job：`89665866589`
- 结果：22/22 gate `pass`，`evidenceCount=22`，`passed=true`
- raw artifact ID：`8618127556`
- raw artifact name：`gate-evidence-raw-30152595619-2-754cc52177ae3ee42dff7a2a545b6faf7ab503d2`
- raw archive digest：`sha256:f18413861efe6079cd081cfa6ffa855f884ecb26bdf847e28fb152668cd1680c`
- final artifact ID：`8618128971`
- final artifact name：`gate-evidence-30152595619-2-754cc52177ae3ee42dff7a2a545b6faf7ab503d2`
- final archive digest：`sha256:a911579aa317e7e61900e940f1cc8839f94a164c6f54cc883a660eea2c553549`
- attested `gate-evidence.json` digest：`fbb2a4172220940180f580056d60790ef3f7cd1dbeb439384acd97e3fdd61568`
- attestation ID：`37075065`
- evaluation context digest：`901dd4d778b3136c89b4e11022d835c24d85e356b2d97306a3bbe79f61319725`
- replay digest：`ed35b03aa20f642822d7cea034a01b7f8e2fac56eaf24fd68ca997f1199db65a`
- Controller run：`30152720833`
- Controller App check：`89665917352`
- Controller App integration：`4372284`（`rockyyy-code-graph-controller`）
- Controller 结果：`status=accepted`、`trustedSequence=18`、`failedGateIds=[]`、
  `invalidGateIds=[]`、`missingEvidenceGateIds=[]`

## 历史 Drift monitor 与 ruleset

- fresh monitor run：`30152715265`
- monitor head：`bedd8e6a83b3ba263d70ee47f53c59f7389fac2f`
- monitor event / conclusion：`push` / `success`
- ruleset ID：`19603163`
- enforcement：`active`
- branch：`refs/heads/main`
- required context：`architecture-required`
- required integration：Controller App `4372284`
- strict current-head：`strict_required_status_checks_policy=true`
- bypass：`bypass_actors=[]`、`current_user_can_bypass=never`
- PR #8：`mergeStateStatus=CLEAN`

## 本地与真实进程验证

- base/head 公共能力差异精确为上述 8 项；`violations=[]`
- 8 个专属 verification entry 全部通过
- repository contract preflight 通过
- `pnpm unit`：45 文件 / 269 用例通过
- `pnpm contract`：21 文件 / 174 用例通过
- 本地 `architecture-required`：22/22 通过
- SQLite：精确八表、WAL、foreign keys、NORMAL、5000 ms busy timeout、迁移幂等、未知高版本拒绝、
  故障副本、事务回滚与真实 `SQLITE_BUSY` 竞争通过
- 真实 Named Pipe/UDS：initialize → `job/start` → status 通过；共享状态、Builtin 排除、
  `.codegraphignore` fail closed、外部 symlink 不入库与 100-byte Hosted socket 路径预算通过

私钥、installation token、webhook secret、工作区绝对路径与源码正文均未写入 artifact、公开日志或本文档。
