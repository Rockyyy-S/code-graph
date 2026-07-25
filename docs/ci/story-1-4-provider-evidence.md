# Story 1.4 Provider 与门禁证据

> 当前结论：Story 1.4 的 8 个变化公共能力已完成一能力一 gate、本地专属 verification、
> repository preflight 与基线差异验证；当前工作树尚未形成候选 commit，因此同 SHA Hosted child
> evidence、外部可信 GateRegistry proposal、Controller App `architecture-required=success`、fresh
> drift monitor 与无 bypass ruleset 复验仍待执行。本地全绿不替代这些 provider 结论。

## 候选与 Registry 状态

- 比较基线：`cb60d0039507da4c1629cd478e0bd43f287eb663`
- 候选 SHA：待生成；当前 Story 1.4 工作树未提交
- 当前本地 blocking gate 数：22
- 当前本地 `gateRegistryDigest`：`39eaaa920a87948a9cd563c5f76498e6bf1e31a74cd8e724e7c9a5331633a885`
- 固定 producer commit：`c01e7c0550b9d9150df26c20cebb10aaefdf648d`
- Hosted child run/attempt：待候选 SHA 与外部 registry proposal 批准后执行
- Controller App umbrella check：待执行
- fresh drift monitor / active strict ruleset / bypass 空集合：待当前候选复验

## 变化公共能力交付表

下列 gate 均为 `blocking:true`，`capabilityOwner=qa`，命令、fixture、测试、evidenceId 与能力一一独占。

| capabilityId | checkId | evidenceProducerId | gateDefinitionDigest | 本地 verification |
| --- | --- | --- | --- | --- |
| `rpc:job/start` | `graph-bootstrap-rpc-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-rpc-v1` | `3594adfe8f65d2066e9528e0c8528b3ba4552b7340c361005554d75267a71d62` | 通过；`verificationDigest=9d6c93452f473770102641b566ad73056da7b8cbba513dd491c02df2ab3d7ceb` |
| `schema:errorV1Schema` | `graph-bootstrap-error-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-error-v1` | `2138d90ca2955e7bf8f3ff2dc140dbadc74d1a08f46620c554112082aebf0b10` | 通过；`verificationDigest=dc80a88964a6b5ba8d852611fa4fd154c71b179361b0c628ebda403bb5fe58db` |
| `schema:initializeResultCompatibleSchema` | `graph-bootstrap-initialize-compatible-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-initialize-compatible-v1` | `3d73f9b28de866247d59eec867ef4fe6f66c32b04e43354e895223fb6976be85` | 通过；`verificationDigest=bd4dbabf10f01a545034a0e02e195b75b2d184daf5df8df5bdb2a1e9e3be7355` |
| `schema:initializeResultSchema` | `graph-bootstrap-initialize-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-initialize-v1` | `e43e1d319eae0afac6a689ad86a4696335b0dce477491c6066a88bcdff4b0090` | 通过；`verificationDigest=2a25dce8f1b0cfd9e7c9821b4e0055fded2c4f8461fb176b7794272b35dafba2` |
| `schema:jobStartRequestV1Schema` | `graph-bootstrap-job-request-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-job-request-v1` | `ae695f172d007c08e4500287008df4a36b0feaf26d0750aedbbb47a9a60dfd63` | 通过；`verificationDigest=ab8c51e772fd06ba7be8733f2d3441a2e9be79c61745d4fe1aa5ddfc23015850` |
| `schema:jobStartResultV1Schema` | `graph-bootstrap-job-result-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-job-result-v1` | `ae415b6cc3b8b5874e9c2030bf046ccdca08cc708cfe1ddced7972ffae05a26e` | 通过；`verificationDigest=fe7a217f3ce1389188ae4fca6272b1274ffc31dc4b07b8892cfe209c9aeab6f8` |
| `schema:serviceStatusV1CompatibleSchema` | `graph-bootstrap-status-compatible-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-status-compatible-v1` | `8ad0f2cacbb083788281dcf7530b803632ccfd801194b4cfb830e4a214a9aeed` | 通过；`verificationDigest=12e968cde6db74e69e9a79cd3e34b52bd1383ad71cfc3421171c895abb64afcd` |
| `schema:serviceStatusV1Schema` | `graph-bootstrap-status-v1` | `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@c01e7c0550b9d9150df26c20cebb10aaefdf648d#graph-bootstrap-status-v1` | `ad2b59698dac4fc90c516ed8da092ace5d169639a6822684318ed49400cc128d` | 通过；`verificationDigest=efeee0cb3ffcb42cfcb26468fd3eafc9a8a275adc8b4943a6b9a84f9e558d7fd` |

## 本地差异与验证结果

- base/worktree 公共能力差异：精确为上述 8 项；`violations=[]`
- 8 个专属 verification entry：全部通过
- `node scripts/contracts/validate-repository-contract.mjs`：通过
- `tests/unit/public-capability-gate.test.ts`：36/36 通过
- SQLite：精确八表、WAL、foreign keys、NORMAL、5000 ms busy timeout、迁移幂等、未知高版本拒绝、
  故障副本、事务回滚与真实 `SQLITE_BUSY` 竞争均通过
- 真实进程：Named Pipe/UDS 上完成 initialize → `job/start` → status；共享状态、Builtin 排除、
  `.codegraphignore` fail closed 与外部 symlink 不入库均通过

完整根级质量命令结果在 Story 文件的 Dev Agent Record 中记录；本文件只保留 provider 与公共能力
治理所需的可审计摘要。

## 外部完成条件

形成候选 commit 后，必须按 Story 1.3 的受信任流程完成以下全部条件，才能把 Story 1.4 推进到
`review`：

1. 以候选完整 SHA 提交并批准新的可信 GateRegistry proposal，摘要必须与本仓库候选一致。
2. Hosted child 使用固定 producer 运行 22 项 gate，产出同 SHA artifact 与 GitHub attestation。
3. Controller App 验证 producer、registry/context/evidence digest 后发布
   `architecture-required=success`。
4. fresh drift monitor 再次确认 ruleset active、strict、required context 绑定 Controller App 且无 bypass。
5. 文档回填候选 SHA、proposal sequence、Hosted run/attempt、artifact/attestation、Controller check 与
   monitor 结果；不得用 Story 1.3 或其他旧候选证据替代。
