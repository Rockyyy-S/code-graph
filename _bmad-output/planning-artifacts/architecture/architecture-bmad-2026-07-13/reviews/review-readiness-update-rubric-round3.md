---
review: good-spine-rubric-targeted-round3
target: ../ARCHITECTURE-SPINE.md
prior_review: review-readiness-update-rubric-round2.md
date: 2026-07-15
verdict: changes-required
critical: 0
high: 1
medium: 1
low: 0
---

# Architecture Reviewer Gate — Round 3 定向复核

## Verdict

**CHANGES REQUIRED。** R2-H3 已关闭；R2-H1、R2-H2 的主体结构已经完成，但仍分别遗留 artifact identity 与 trust bootstrap/revocation 两个可执行性缺口。机械 lint 通过，0 项发现。

## R2-H1～H3 关闭状态

| Round 2 finding | 当前证据 | 状态 |
| --- | --- | --- |
| R2-H1：Artifact/Set manifest 非封闭合同 | AD-29 已固定 JSON Schema 2020-12、`additionalProperties:false`、三个 V1 字段集合、payload tuple、JCS digest 输入域和 ReleaseSet tuple | **Partially closed**：见 R3-M1 |
| R2-H2：签名与信任 profile 未定义 | AD-29 已固定 ReleaseSignatureV1、`ed25519-sha256-v1`、subject digest、SPKI keyId、有效期、轮换签名和 release-owner 审批 | **Partially closed**：见 R3-H1 |
| R2-H3：required-check verifier 无法自我保护 | AD-28 已把强制 ruleset 移到代码仓库外，禁用仓库 PR 移除与管理员 bypass，并由外部 drift monitor 独立校验、阻断发布和告警 | **Closed** |

## Residual findings

### R3-H1 — trusted-keys 缺少仓库外 bootstrap anchor 与紧急撤销语义

- **证据：** `release/trusted-keys.v1.json` 位于代码仓库内；Rule 要求新 trust record 由当前 active key 签名，但没有固定首个 trust record 的仓库外 pinned root、验证链起点，也没有定义 compromised key 的 revoked 状态、生效时间与“不得再为新 manifest/rotation 签名”的规则。
- **可构造分叉：** verifier A 直接信任当前 checkout 中的 trusted-keys 文件；verifier B 要求从上一已发布 trust record 验证轮换链。仓库被替换为新自签根时，两者会给出相反结论；发生密钥泄露时也没有唯一的撤销结果。
- **影响：** Ed25519 算法与 envelope 已确定，但“签名信任不匹配阻止发布”仍缺可独立验证的信任起点和应急失效规则，R2-H2 尚未完全关闭。
- **最小关闭条件：** 固定一个仓库外 pinned bootstrap key/trust-record digest（由 provider secret/ruleset 或 release system 持有）；TrustedKeyRecordV1 增加 `status=active|revoked`、`notBefore/notAfter/revokedAt/reason`，撤销由独立 recovery key 或明确的双人 release-owner quorum 签署。verifier 必须验证从 pinned anchor 到当前 record 的完整链，并拒绝在签名时间无效或已撤销的 key。

### R3-M1 — artifactId 已成为字段，但身份公式与唯一性仍未固定

- **证据：** ReleaseArtifactManifestV1 要求 `artifactId`，ReleaseSetManifestV1 用它参与排序和 releaseSetId；但 Rule 没有定义 CLI/VSIX 的稳定取值、字符规范或 `(artifactId,platform,arch)` 唯一约束。
- **可构造分叉：** CLI packager 使用 `cli`，另一实现使用 npm package name；两个实现都符合封闭 Schema，但会生成不同 releaseSetId，并可能让同一平台候选重复进入集合。
- **影响：** R2-H1 的 Schema 结构已关闭，剩余是 identity invariant，不影响 payload 可复现性，但影响 release-set 的跨实现一致性。
- **最小关闭条件：** 固定 `artifactId` 公式，例如 CLI 为规范 npm package name，VSIX 为规范 extension identifier；ReleaseSet artifacts 对 `(artifactId,platform,arch)` 建唯一约束，并要求 artifactKind 与 platform/arch 合法组合。

## Close condition

关闭 R3-H1 与 R3-M1 后，R2-H1～H3 可全部判定 Closed。本轮未复扫 round2 的其他 Medium 项，也未对架构或实施指南做任何修改。
