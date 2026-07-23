# Story 1.3 Provider 证据

> 当前结论：外部 GateHarness、可信 registry、Hosted child evidence 与 GitHub attestation 已验证；
> Controller GitHub App、Drift Monitor GitHub App、仓库 Secrets 和生产 `main` ruleset 仍待激活。
> 在这些外部配置完成并完成阻断/漂移演练前，Story 1.3 必须保持 `in-progress`。

## 固定身份与可信根

- 候选仓库：`Rockyyy-S/code-graph`，provider repository ID `1303415307`
- 外部控制面：`Rockyyy-S/code-graph-gate-controller`
- 候选 head：`d54be3b34eddc55c3e7f65dafe8682718290904a`
- reusable producer SHA：`3a0b53163e91bf14d4a3d1e911292b267e1e968a`
- GateHarness SHA：`442b755a70109edfa1221a47bd15b896d62c68cc`
- TrustedGateRegistryRecordV1 sequence：`2`
- gate registry digest：`d1b9e3c2529514dfbe4a058ed4d17f86d4e24e05951a4391ddf09161eb113378`
- registry approval evidence digest：`3d629b2ab6ace56a23b343189bbc5cb6ac2d3c0b710b94737c3558648954e6a4`

候选 workflow 只传递 repository、base/head OID、object format、repository ID 与固定 producer SHA，
不继承 Controller secret。九项 `evidenceProducerId` 均绑定外部仓库路径、完整 producer SHA 和
对应 gate ID；候选提交不能替换 GateHarness、可信 registry 或 attestation 校验策略。

## Hosted child evidence

| 运行 | 候选 SHA | 结果 | 证明 |
| --- | --- | --- | --- |
| `29979204276` | `500120460fec6ed5471be091c5863b45e0d06503` | failure | reusable workflow 的 `github.workflow_sha` 实际解析为调用方 workflow SHA，GateHarness 因 producer identity 不匹配而 fail closed |
| `29979602524` attempt 1 | `d54be3b34eddc55c3e7f65dafe8682718290904a` | failure | producer SHA 已修复，但 sequence=1 仍未批准新 registry digest，GateHarness 因可信根不匹配而 fail closed |
| `29979602524` attempt 2 | `d54be3b34eddc55c3e7f65dafe8682718290904a` | success | sequence=2 生效后九项 gate 全部通过，artifact、attestation 与固定 OID 上下文上传成功 |

成功运行：[GitHub Actions run 29979602524](https://github.com/Rockyyy-S/code-graph/actions/runs/29979602524)

成功 artifact：

- artifact ID：`8552756188`
- artifact name：`gate-evidence-29979602524-2-d54be3b34eddc55c3e7f65dafe8682718290904a`
- provider archive digest：`sha256:297756d0d6c64b6ce78373029737e100d7c598a5ee65dd9f01e19a7a23a5c69f`
- attested `gate-evidence.json` digest：`1d0d0e573bb8fd5ece802335d89246f0caeaf4965bf59b99f0345f73ed529f44`
- evaluation context digest：`f5334d2d7c652ebbfda333061ed4663357b06fda83b41b7b96756349f5af6797`
- base/comparison OID：`e29edc1f6cb06b1a8670a9b784a0adad7b7f6b42`
- head OID：`d54be3b34eddc55c3e7f65dafe8682718290904a`

`basic-security`、`build`、`contract`、`dependency-boundary`、`lint`、
`planning-traceability`、`repository-contract-preflight`、`type` 与 `unit` 九项证据状态均为
`pass`。Controller policy 已用真实 provider 数据验证：

- OIDC issuer：`https://token.actions.githubusercontent.com`
- signer workflow：`Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml`
- signer digest：`3a0b53163e91bf14d4a3d1e911292b267e1e968a`
- source repository ID：`1303415307`
- source PR merge commit：`274d8786e29e53da2b68eed16bbea105af8cb637`
- provider run/attempt：`29979602524/2`
- provider gate job/check：`89118921608`，GitHub Actions App ID `15368`
- runner environment：GitHub-hosted

## 外部 Controller 与 drift monitor

外部仓库已提交：

- provider API run/job/check/artifact 拉取
- `gh attestation verify` 的 issuer、signer workflow、signer digest 与 hosted-runner 验证
- repository/event/run/attempt/merge-ref/artifact subject 的逐字段 policy
- GateEvidence definition/context/head/producer digest 校验与冲突重放拒绝
- umbrella CAS：`{providerRepositoryId,headOid,evaluationContextDigest}`
- ruleset enforcement、strict/current-head、required context、Controller App integration ID、
  bypass 空集合与 repository/default-branch 的独立 drift policy

外部仓库测试当前为 21/21 通过。私钥、installation token、webhook secret 均未写入源码、
artifact、日志或本文档。

## 待激活的 provider 配置

以下高权限外部操作待明确授权并由 GitHub 生成私钥后执行：

1. 创建并安装 Controller GitHub App，仅授予 Actions read、Checks read/write、Contents read、
   Pull requests read 与所需 repository metadata 权限。
2. 创建并安装独立 Drift Monitor GitHub App，仅授予读取 repository/ruleset 所需权限。
3. 将四项值写入外部仓库 Actions Secrets：`CONTROLLER_APP_ID`、
   `CONTROLLER_PRIVATE_KEY`、`DRIFT_MONITOR_APP_ID`、`DRIFT_MONITOR_PRIVATE_KEY`。
4. 先运行 shadow Controller/monitor，再为 `main` 原子启用 active、strict、无 bypass 的
   `architecture-required` ruleset，并把 required check source 绑定 Controller App integration ID。
5. 在同一最终候选 SHA 演练 child failure → umbrella failure → 不可合并 → 修复通过，以及
   ruleset/App/bypass 漂移 → Controller fail closed → 恢复。

当前 provider 基线仍是旧 GitHub Actions required check、`enforce_admins=false` 且 rulesets 为空；
它不是 Story 1.3 的完成证据。迁移期间允许短暂“阻塞窗口”，不允许“无保护窗口”。
