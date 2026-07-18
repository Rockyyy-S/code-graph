---
review: good-spine-rubric-targeted-round4
target: ../ARCHITECTURE-SPINE.md
prior_review: review-readiness-update-rubric-round3.md
date: 2026-07-15
verdict: changes-required
critical: 0
high: 1
medium: 0
low: 0
---

# Architecture Reviewer Gate — Round 4 定向复核

## Verdict

**CHANGES REQUIRED。** R3-M1 已关闭；R3-H1 的 repository-external anchor、单调序列、撤销和双签 root rotation 均已落入，但 ReleaseTrustBundleV1 的 digest/signature 输入域存在自引用，仍不能生成唯一可验证的签名。机械 lint 通过，0 项发现。

## R3-H1 / R3-M1 状态

| Finding | 当前证据 | 状态 |
| --- | --- | --- |
| R3-M1：artifactId 公式与 target 唯一性 | artifactId 已固定为 `codegraph-cli-npm` / `codegraph-vsix-<platform>-<arch>`；artifactId 与 tuple 分别唯一；targetMatrix 与 artifacts 一一相等且每目标恰有一个候选 | **Closed** |
| R3-H1：外部信任锚、单调 trust bundle、撤销与 root rotation | AD-29 已固定 repository-external ReleaseTrustAnchorV1、sequence/previousBundleDigest、delegated keys、revocations、旧/新 root 双签和最新 bundle 验证 | **Partially closed**：见 R4-H1 |

## Residual

### R4-H1 — ReleaseTrustBundleV1 的 bundleDigest/rootSignatures 形成签名自引用

- **证据：** ReleaseTrustBundleV1 的固定字段同时包含 `bundleDigest` 与 `rootSignatures`；ReleaseSignatureV1 又规定 trust-bundle 的 `subjectDigest` 是“精确 JCS bytes”的 SHA-256。当前没有定义计算 bundleDigest/subjectDigest 时排除 `bundleDigest` 和 `rootSignatures`，也没有说明 rootSignatures 是 bundle 外 envelope。
- **不可执行点：** 若 rootSignatures 位于被签对象内，必须先有签名才能得到精确 JCS bytes，又必须先得到 bytes digest 才能生成签名；bundleDigest 自身同样进入自己的输入，形成递归固定点问题。不同 verifier 若各自猜测排除字段，会产生不同 digest 与轮换链判断。
- **影响：** repository-external anchor、撤销和 root rotation 的治理语义已闭合，但 trust bundle 无法按当前文字生成唯一签名，R3-H1 尚未完全关闭。
- **最小关闭条件：** 定义不含 `bundleDigest/rootSignatures` 的 `ReleaseTrustBundlePayloadV1`，`bundleDigest=SHA-256(JCS(payload))`；`rootSignatures` 作为外层 envelope，仅签 32-byte bundleDigest。`previousBundleDigest` 指向上一 payload digest；普通更新要求当前 root 签名，root rotation 要求旧/新 root 分别对同一 bundleDigest 签名。

## Close condition

关闭 R4-H1 后，R3-H1 与 R3-M1 均可判定 Closed。本轮仅验证指定两项，未复扫其他 round2 Medium findings，也未修改架构或实施指南。
