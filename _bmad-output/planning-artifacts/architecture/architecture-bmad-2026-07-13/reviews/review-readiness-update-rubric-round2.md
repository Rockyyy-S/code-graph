---
review: good-spine-rubric-walker-round2
target: ../ARCHITECTURE-SPINE.md
companions:
  - ../IMPLEMENTATION-GUIDE.md
prior_review: review-readiness-update-rubric.md
date: 2026-07-15
verdict: changes-required
critical: 0
high: 3
medium: 4
low: 0
---

# Architecture Reviewer Gate — Good-Spine Rubric Walker Round 2

## Gate verdict

**CHANGES REQUIRED。** 首轮 H1～H4 均已按其原始关闭条件落入 AD-25～AD-29，机械 lint 仍为 0；但新增 AD-29 的 manifest 与签名合同本身尚未封闭到可由独立 packager/verifier 互操作，AD-28 的 required-check 漂移校验也无法在自身被移除时继续阻止合并。因此可以确认首轮架构修订有效，但当前候选仍不宜直接标记 Reviewer Gate 通过。

## 审查基线

- 当前目标版本：`../ARCHITECTURE-SPINE.md`，磁盘时间 2026-07-15 16:31:48。
- 伴随投影：`../IMPLEMENTATION-GUIDE.md`，磁盘时间 2026-07-15 16:31:48。
- 机械检查：`lint_spine.py` 通过，0 项发现。
- 驱动输入仍为实施就绪报告与已批准 Sprint Change Proposal；首轮核验过的精确技术版本仍可解析，未发现新的版本现实问题。

## 首轮 H1～H4 关闭确认

| 首轮 finding | 当前关闭证据 | Round 2 状态 |
| --- | --- | --- |
| H1：Overview Finding 计数归属不明 | AD-25 新增 ProjectionMembershipV1 与 FindingAttributionKernelV1；directory/package 叶子 membership、内部/外部 edge 端点、同聚合去重、SCC 相交归属和空 Rules 基线均已固定 | **Closed** |
| H2：新增循环与 canonical risk ID 不确定 | AD-26 新增 CycleDeltaV1；同 scope/kernelVersion 集合比较、split/merge、not-applicable、`finding:`/`cycle:` canonicalRiskId 均已固定 | **Closed** |
| H3：跨文件 declaration merging 与 file-scoped ID 冲突 | AD-27 将合并限制在同一 SourceFile；跨文件 interface/namespace 各自由对应 source slice 拥有，导航选择不依赖输入枚举顺序 | **Closed** |
| H4：可复现候选产物无发布 oracle | AD-29 新增 ReleaseArtifactManifestV1、payloadRootDigest、规范 SBOM、双 clean checkout oracle、ReleaseSetManifestV1 与 release set gate | **Closed；但 AD-29 派生出新的 H1/H2 与 M1** |

## Good-spine rubric

| 检查项 | 结果 | 说明 |
| --- | --- | --- |
| 固定下一层真实分歧点 | 不通过 | release CI、CLI packager、VSIX packager 与 verifier 对 manifest/signature 仍可选择不兼容实现 |
| 每个 AD Rule 可执行并阻止其 Prevents | 不通过 | AD-29 缺封闭 schema 与签名信任 profile；AD-28 的 in-band verifier 无法阻止自身 required 状态被删除 |
| Deferred 无 MVP 泄漏 | 通过 | Deferred 仍全部位于替代技术、额外平台/语言/渲染器、跨根/云/跨仓库能力；未承载当前发布或指标决策 |
| 命名技术已验证-current | 通过 | 未新增需要重新绑定的运行时或第三方库；JCS/SHA-256 属算法合同，不产生版本漂移 |
| 与代码现实一致 | 通过 | 绿地 build substrate；未发现与既有代码冲突的 ratification 声明 |
| 覆盖驱动输入 | 部分通过 | readiness 与批准提案的架构专项项均已落入；首轮遗留的 localization 跨宿主边界仍未进入 spine |
| 所有 initiative 维度有决定/Deferred/open | 部分通过 | 部署与运营维度不沉默，且 AD-29 显著补强；但签名信任、跨 registry 发布失败状态仍需闭合 |

## Critical / High findings

### R2-H1 — AD-29 的两个 V1 manifest 仍不是封闭、可互操作的公共合同

- **证据：** ReleaseArtifactManifestV1 使用“至少包含”，未固定 `schemaVersion`、`artifactId/artifactKind`、digest/`mode` 的规范类型、license/SBOM 文件定位字段或 unknown-field 行为；ReleaseSetManifestV1 却使用未在 artifact manifest 中定义的 `artifactId` 排序。ReleaseSet 的“artifact tuples”精确字段也没有封闭定义。
- **可构造分叉：** CLI packager 使用 `artifactId=cli`、八进制字符串 mode 与额外构建字段；VSIX packager 使用包名、十进制 mode 和另一组扩展字段。二者都满足“至少包含”，但 release orchestrator 无法用单一 Schema 验证，JCS manifestDigest 也不可跨实现复算。
- **影响：** AD-29 已能发现同一 packager 的非确定构建，却仍不能保证多个发布单元和独立 verifier 对同一 V1 互操作；“ReleaseSetManifestV1 完整集合”无法成为稳定 oracle。
- **处置：** **tighten AD-29。** 固定两个 JSON Schema V1（required、封闭字段、`additionalProperties:false` 或明确 extension namespace），加入 `schemaVersion:1`、封闭 artifactKind、稳定 artifactId 公式、mode 表示、lowercase hex digest、license/SBOM path+digest，并精确定义 release-set artifact tuple 与 releaseSetId 输入域。

### R2-H2 — AD-29 要求签名，却没有定义可验证的签名与信任 profile

- **证据：** Rule 规定 artifact/set 签名覆盖精确 manifest bytes，并提到 timestamp/provenance；但未固定签名 envelope、算法、keyId/issuer、信任根、密钥轮换、撤销或 verifier 的验收规则。
- **可构造分叉：** 一个 packager 附加自签名 JSON，另一个使用 registry/cosign 风格签名；两者都“覆盖精确 bytes”，但 verifier 无法判断哪一个受信，也无法审计同一 productVersion 是否由授权发布者产生。
- **影响：** 当前合同能验证 payload 未变，却不能兑现 AD-29 Prevents 中“签名可审计”；任意自签名也能形式合规。
- **处置：** **discuss / tighten AD-29。** 绑定一个版本化 SignatureProfileV1（或明确委托的生态签名标准），固定 envelope、允许算法、key identity/issuer、trust policy、rotation/revocation 与离线验证命令；artifact 与 release-set verifier 必须作为 blocking 发布 oracle。

### R2-H3 — AD-28 的 required-check 漂移校验不能阻止自身被移除

- **证据：** CI provider 只要求 `architecture-required`，独立 sync/verify job 检查 provider 是否仍要求该 ID。若管理员或配置漂移移除了 `architecture-required`，sync/verify 即使失败也不再是合并阻断条件。
- **可构造分叉：** 仓库 manifest 和所有 gate 保持正确，但 provider ruleset 删除唯一 required ID；PR 可在 verifier 报错的同时合并，仍逐字满足“存在独立 sync/verify job”。
- **影响：** AD-28 对普通 gate 漂移已经可执行，但其 provider binding 是自指的，无法实现“持续阻止后续合并”。
- **处置：** **discuss / tighten AD-28。** 把 required workflow/ruleset 作为仓库外受保护的 config-as-code 或组织级策略管理，明确独立 owner 与 drift alarm；若 provider 支持 immutable required workflow，直接绑定该机制。至少要求 sync/verify 成为 aggregator 的前置并规定 provider binding 的外部审计 oracle，而不是仅有一个可忽略 job。

## Medium findings

### R2-M1 — “完整 release set 发布”缺少跨 registry 失败状态与恢复协议

- **证据：** AD-29 规定候选只能作为完整 release set 发布，但 CLI npm 包与 VSIX 通常进入不同发布面，无法依赖单一原子事务。
- **影响：** 一个 registry 成功、另一个失败时，系统没有 prepared/publishing/complete/invalid 状态、重试幂等键、撤回/yank 或对外标记规则；“只能整套发布”在最后一步仍可能被外部失败打破。
- **处置：** **tighten AD-29 或 Deferred 明确发布编排。** 定义以 releaseSetId 为幂等键的 staged→publish→verify 状态机，以及 partial failure 的停止、重试、撤回和公告规则；若 MVP 只保证“完整候选集形成后才开始发布”，应把措辞收窄到该可兑现边界。

### R2-M2 — AD-25 要求 Kernel 消费 membership，但 file scope 不在 ProjectionMembershipV1 的 groupBy 联合中

- **证据：** ProjectionMembershipV1 的 groupBy 只有 directory/workspace-package；同一 Rule 又要求 CycleProjectionKernelV1 消费该 membership，并定义 file scope。
- **影响：** 实现者可能让 file scope 忽略 membership，或私自引入 groupBy=file；二者对 queryFingerprint 与 projection identity 的处理会不同。该项不重新打开首轮 H1，因为 Overview 的 directory/package 计数已闭合，但 wording 仍有内部缝隙。
- **处置：** **autofix candidate。** 增加 `groupBy:file` 的 identity membership，或明确“只有 directory/workspace-package scope 必须消费 ProjectionMembershipV1；file scope 直接使用规范 file IDs，并以等价 identity membership digest 进入 fingerprint”。

### R2-M3 — 已批准的 localization 边界仍未进入 spine

- **证据：** 批准提案要求 zh-CN/en、未知 locale 回退 en，机器 JSON/error code/status enum/Schema 不本地化；当前 AD 与 Consistency Conventions 仍无对应规则。
- **影响：** extension、Webview、CLI 与服务的人类/机器文案边界可以独立解释。
- **处置：** **autofix candidate。** 增加一条 localization convention：机器合同不本地化；宿主用资源 key 管理 zh-CN/en；未知 locale 回退 en；服务只返回稳定 code+参数。

### R2-M4 — Implementation Guide 的匿名符号说明仍与 AD-27 漂移

- **证据：** 指南身份规范仍写“匿名符号标记低稳定性”，而 AD-27 与指南 BasicSymbolV1 小节均明确匿名声明不进入 MVP。
- **影响：** companion 仍可能诱导 analyzer/store 提前保存匿名 symbol。
- **处置：** **autofix candidate。** 删除该句，或明确标为 Deferred 的未来 symbol 模型，不得作用于 BasicSymbolV1。

## 无发现项

- 首轮 H1～H4 的原始 gate close condition 已全部满足；本轮 findings 是修订后暴露的下一层合同问题，不是对关闭状态的反复否定。
- AD-29 已正确解决 manifest 自引用：payloadRootDigest 排除 ReleaseArtifactManifestV1、签名、时间戳和 provenance；规范 SBOM 作为普通 payload 纳入 root。
- AD-29 已正确解决跨平台集合漂移：ReleaseSetManifestV1 绑定同版本 CLI 与全部 VSIX 的 source/lockfile/protocol/schema 公共字段。
- Deferred、技术版本、部署/运营整体覆盖、ignore runtime snapshot 与新增指标合同未发现新的 Critical。

## Gate close condition

至少关闭 R2-H1～R2-H3 后再运行一次 Reviewer Gate。R2-M1 应在发布 Epic 开始前决定可兑现的发布边界；R2-M2～M4 可作为同一轮文档清理直接收紧。
