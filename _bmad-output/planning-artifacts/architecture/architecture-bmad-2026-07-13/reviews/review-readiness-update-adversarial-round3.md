---
title: Reviewer Gate — Readiness Update Adversarial Divergence Round 3
date: 2026-07-15
review_type: adversarial-divergence-round3
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — Readiness Update Adversarial Divergence Round 3

## Verdict

**PASS：Round 2 的两个 AD-29 High 均已关闭，未发现残余 Critical/High。** 当前合同对 artifact manifest 自引用、payload/root 规范字节、签名信任范围和 release-set 跨候选一致性都形成唯一判定；任一实现偏离只能触发 gate failure，不能再以另一种“同样合规”的结果发布。

## Round 2 发现复核

| Round 2 发现 | 结果 | 当前唯一结果 |
| --- | --- | --- |
| ADV2-H1 — manifest/root/signature 边界不唯一 | PASS | ReleaseArtifactManifestV1 明确不进入 payload root；root 输入固定为排序 tuple 的 JCS；manifest 自身使用精确 JCS bytes 并由 artifact 签名覆盖；timestamp/provenance 在后附加且同时引用 manifestDigest 与 payloadRootDigest。 |
| ADV2-H2 — 缺少 release-set 一致性 | PASS | ReleaseSetManifestV1 固定公共字段一致性、artifact tuple 排序、releaseSetId JCS digest 与 set 签名；CLI 和全部平台 VSIX 只能作为完整集合发布。 |

## 最终对抗案例

### 1. Artifact manifest 自引用

**实现 A** 尝试把 ReleaseArtifactManifestV1 本身加入 payload entry；**实现 B** 将其排除后计算 root。当前 Rule 已明确 manifest、签名、时间戳和 provenance 不属于 payloadRootDigest 输入域，因此 A 直接不合规，B 是唯一结果；不存在自哈希 fixed-point 或“置空 root 字段后再哈希”的第二合法算法。

**结论：PASS。**

### 2. 两个构建使用不同 root serialization

**实现 A** 按文件系统枚举顺序串接 hash；**实现 B** 按相对 POSIX path 升序生成 `{path,mode,size,sha256}` tuples，执行 RFC 8785 JCS → UTF-8 → SHA-256。只有 B 符合当前 Rule；SBOM 也被固定为移除 timestamp、serial、绝对路径的 SbomInventoryV1 JCS，并作为普通 payload 进入 root，不能通过“后附加 SBOM”绕过复现比较。

路径、mode 或 archive entry 的具体适配若被两个构建器实现得不一致，会使两个 clean checkout 的 payloadRootDigest 不同并阻止发布，而不会产生两个都能通过的候选。因此剩余适配细节属于 gate fixture/packaging 实现问题，不是 silent divergence。

**结论：PASS。**

### 3. 签名只覆盖 payload、不覆盖追溯字段

**实现 A** 只签 payloadRootDigest，允许 productVersion/sourceCommit/lockfileDigest 等 manifest 元数据被替换；**实现 B** 签 ReleaseArtifactManifestV1 的精确 JCS bytes。当前 Rule 明确要求 artifact 签名覆盖 manifest 精确字节，后续 timestamp/provenance 还必须同时引用 manifestDigest 与 payloadRootDigest，因此 A 不合规；payload 和追溯元数据被同一验证链绑定。

**结论：PASS。**

### 4. 混用不同 commit/lockfile/schema 的 CLI 与 VSIX

构造 productVersion 相同、各自可复现的 CLI(commit A) 和 VSIX(commit B)。逐 artifact 都可拥有有效 manifest/root，但 ReleaseSetManifestV1 要求同一版本集合的 productVersion、sourceCommit、lockfileDigest、protocol/schema 集合一致，并由 set 签名覆盖公共字段和按 artifactId/platform/arch 排序的全部 payloadRootDigest；混合集合无法生成合规 releaseSetId/signature。

替换一个候选 root、遗漏某个平台候选或把另一 release set 的 artifact 混入，都会改变 artifact tuples 或违反完整集合/公共字段检查，只能阻断发布。不存在“每件单独有效即可发布”的第二合规路径。

**结论：PASS。**

## 非阻塞实现注意项

以下内容可由 ReleaseArtifactManifestV1/ReleaseSetManifestV1 Schema、contract fixture 和平台 packaging adapter 固定，不构成新的架构决策缺口：

- manifest 在 npm/VSIX 内的具体文件路径或 sidecar 传输形式；
- npm tar mode 与 VSIX zip external attributes 到 tuple `mode` 的适配代码；
- 具体平台签名服务、证书轮换和 timestamp authority；
- artifactId 的展示命名，只要 Schema 生成的 tuple、排序和 set 签名保持唯一。

这些实现若不一致会 fail closed，不会形成两个都满足 AD-29 的发布结果。

## Gate 结论

Round 3 adversarial divergence **PASS**。Round 2 的 manifest/root/signature 与 release-set 两项 High 已闭合；本轮未发现残余 Critical/High，无需新增或继续收紧 AD。此报告未修改 Architecture Spine 或 Implementation Guide。
