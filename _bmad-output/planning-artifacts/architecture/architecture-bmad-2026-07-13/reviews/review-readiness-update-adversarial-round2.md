---
title: Reviewer Gate — Readiness Update Adversarial Divergence Round 2
date: 2026-07-15
review_type: adversarial-divergence-round2
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — Readiness Update Adversarial Divergence Round 2

## Verdict

**FAIL：首轮 1 Critical + 4 High 均已关闭；攻击 AD-29 后发现 2 个新的 High。** 当前候选已经为 BasicSymbol ownership、Projection/Finding attribution、ignore recovery/order、cycle baseline、benchmark/CI oracle 建立唯一结果；但 ReleaseArtifactManifestV1 的规范字节/信任边界和跨候选 release-set 一致性仍允许两个发布单元逐字合规却互不兼容。

## 首轮发现复核

| 首轮发现 | 当前结论 | 唯一结果证据 |
| --- | --- | --- |
| BasicSymbol 跨文件 ownership | PASS | AD-27 固定只在同一 SourceFile 内合并；跨文件 declaration merge 每个文件生成独立 BasicSymbol，由各自 source slice 唯一拥有与 tombstone。 |
| Projection/Finding attribution | PASS | AD-25 固定 application/querying 为 ProjectionMembershipV1 唯一 owner，directory/package 叶子映射、membership digest、禁止 ancestor 重复累计均已明确；FindingAttributionKernelV1 固定内部 edge 端点与 SCC 计数。 |
| ignore recovery/order | PASS | AD-6/14 固定 LastValidIgnoreRecordV1 的缓存位置、完整内容、恢复校验与“首次 invalid”含义；AD-9 固定 file graph 删除命中节点及 incident edges后才做规则与投影。 |
| cycle baseline/verdict | PASS | AD-26 固定同 scope、同 kernelVersion、显式 baselineId 的 projectionId 集合比较，split/merge、not-applicable 与 canonicalRiskId 均只有一个结果。 |
| benchmark/CI oracle | PASS | AD-19 固定 BenchmarkPlanV1 的 fixture/digest、起止事件、冷热状态、warm-up、样本量、p95 和单一 gate command；AD-28 固定唯一 quality-gates manifest、checkId、owner、trigger、command、blocking 和首次落地时点。 |

## 新的最高优先发现

| ID | 级别 | 涉及 AD | 结论 |
| --- | --- | --- | --- |
| ADV2-H1 | High | AD-29 | ReleaseArtifactManifestV1 的固定路径/编码/schema、manifest 自身是否进入 payload root、root canonicalization 及签名覆盖范围未定义，生成器和审计器可互相拒绝。 |
| ADV2-H2 | High | AD-12、AD-20、AD-29 | AD-29 只验收单个候选，没有 release-set identity；同一 productVersion 的 CLI/多平台 VSIX 可来自不同 commit/lockfile/schema 集合而仍分别通过。 |

## 对抗案例

### ADV2-H1 — Manifest/root/signature 没有唯一规范字节与信任边界

**涉及：** AD-29。

AD-29 要求候选携带可读取 ReleaseArtifactManifestV1，并列出 payload 文件/模式/SHA-256，再计算 payload manifest/root digest；但没有固定 manifest 的候选内路径、JSON/YAML 编码、schemaVersion、canonical serialization，也没有说明嵌入候选的 manifest 自身是否属于 payload。若 manifest 进入自己的文件哈希清单，会产生自引用；若排除，则必须明确排除规则及 root 如何绑定 manifest 元数据。

两个严格合规的下一级发布单元：

- **单元 A（packaging）**：把 `release-manifest.json` 视为 payload 外元数据；root digest 只哈希排序后的应用 payload entry，签名/attestation 仅引用该 root。
- **单元 B（release auditor）**：把候选中除签名/时间戳外的全部 entry 都视为 payload；计算 root 时将 manifest 的 `rootDigest` 字段置空后按自己的 canonical JSON 规则纳入，并要求签名覆盖 canonical manifest + root。

两者都能满足“排除签名与时间戳”“payload manifest/root digest 一致”“签名引用 root digest”，但 A 的候选无法通过 B 的审计，B 的候选也无法由 A 重算。更严重的是，按 A 的边界，仅签 payload root 不会认证 manifest 中的 productVersion、sourceCommit、lockfileDigest、licenseDigest 和 sbomDigest；修改这些字段仍可能保留有效 root 引用。

文件模式也有同类分叉：Windows 构建器可以记录宿主可见模式，POSIX 审计器可以按 npm/VSIX 解包后的 0644/0755 规范化；symlink 是哈希 link target 还是解引用内容也未固定。两次构建可能内容相同却 root 不同，或逻辑不同却被归为相同 payload。

**最小可执行收紧：** 固定 manifest schemaVersion、候选内路径、UTF-8 JSON + RFC 8785 JCS；明确 manifest/签名/attestation 不进入 payload entries，rootDigest 为 JCS `{version, platform, arch, sortedEntries}` 的 SHA-256，并固定 mode、symlink、Unicode/case 规范。签名与 provenance 必须覆盖 canonical manifest（其中包含 rootDigest 和全部追溯字段），不能只“引用”未绑定 manifest 的 payload root。

### ADV2-H2 — 缺少 release-set 级跨候选一致性

**涉及：** AD-12、AD-20、AD-29。

AD-29 对“每个 CLI 包与平台 VSIX 候选”逐个要求 manifest 和可复现 root，但没有定义一次发布包含哪些候选、它们共享哪些不可变字段，以及谁对整个集合做原子判定。

构造 productVersion=`1.0.0`：

- npm CLI 在 clean checkout commit `A` 构建，两次复现一致，manifest 内部全部匹配。
- Windows/macOS VSIX 在 clean checkout commit `B` 构建，也各自两次复现一致，协议 major 兼容但 graphSchemaVersion 或 lockfileDigest 已变化。

两个严格合规的下一级单元：

- **单元 A（artifact publisher）**：逐个验证候选内部 ABI/schema/license/SBOM/root 后发布；AD-29 没有要求不同 artifact 的 sourceCommit 或 lockfileDigest 相等。
- **单元 B（release orchestrator）**：按 productVersion 分组，要求所有候选共享 sourceCommit、lockfileDigest、protocol/schema versions 后才发布。

A 会发布一组可单独审计却不是同一源码状态的产品，B 会拒绝；两者都遵守当前单候选 Rule。这会让 CLI 与 VSIX 携带的 service/client 或缓存 schema 来自不同提交，正是 AD-12/20 想避免的交付漂移。

**最小可执行收紧：** 增加由 release CI 唯一生成的 ReleaseSetManifestV1，固定 releaseId/productVersion、必需 artifact matrix 与每个 artifact rootDigest；所有候选必须共享 sourceCommit、lockfileDigest、protocol/graph/rules/cli schema versions和许可/SBOM策略版本，允许差异的字段仅为 artifactKind/platform/arch、Node ABI 与明确的平台 toolchain digest。集合 gate 必须在任何候选发布前原子通过，禁止部分发布或混合不同 releaseId 的候选。

## 其他复核说明

- AD-25 最新文本已覆盖 directory 的 `scopeRoot + aggregationDepth` 最近祖先规则、workspace-package 的最深 recognized package root、非 package fallback 与等深 tie-break；external edge Finding 只对存在的内部端点叶子聚合计数，不再构成双实现分叉。
- AD-27 当前确实选择“跨文件不合并”而非共享 owner；该选择会让全局 declaration merge 显示为多个 BasicSymbol，但结果是显式且稳定的产品边界，不是 ownership 漏洞。
- AD-19/28 把 fixture/命令/check 列表的具体内容交给版本化仓库 manifest 所有；这属于代码存在后的 seed，只要唯一 manifest 与 blocking 规则被执行，不再需要脊柱枚举每条命令。

## Gate 结论

Round 2 adversarial divergence **FAIL**。首轮五类 critical/high 已闭合，无需重开；AD-29 还需要封闭候选 manifest/root/signature 的规范信任边界，以及一次发布内多个 CLI/VSIX 候选的 release-set 一致性。此报告未修改 Architecture Spine 或 Implementation Guide。
