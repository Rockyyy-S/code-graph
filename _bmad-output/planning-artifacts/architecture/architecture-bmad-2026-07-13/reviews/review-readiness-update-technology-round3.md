---
type: architecture-review
lens: technology-reality-readiness-update-round3
date: 2026-07-15
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# Implementation Readiness 更新：技术现实复审（Round 3）

## Verdict

**PASS。未发现 critical/high/medium 技术现实问题。** Round 2 唯一残余的 BenchmarkPlanV1 p95 oracle 歧义已经关闭；新增的封闭 ReleaseArtifactManifestV1、ReleaseSetManifestV1 与 ReleaseSignatureV1 profile 可由当前 Node 24、JSON Schema 2020-12、Ajv、RFC 8785 JCS 和 SHA-256/Ed25519 能力实现，不需要替换现有主栈或依赖尚不存在的 API。

本轮在结论前重新读取了当前 `ARCHITECTURE-SPINE.md`、`IMPLEMENTATION-GUIDE.md` 和 memlog，并在线核验 Node 24 crypto 文档中的 Ed25519、SPKI DER、sign/verify 能力以及 Ajv 8.20.0 精确版本。

## BenchmarkPlanV1 复核

### Reference runner preflight

**通过。** 当前合同要求发布 benchmark 开始前核对：

- 分配的 8 vCPU、16 GB RAM、SSD reference environment。
- fixture digest。
- toolchain digest。
- 任一不匹配产出 `invalid` 并使 gate 失败。

CPU/内存可由 Node OS API 和 runner metadata 读取；SSD 可由固定 reference runner image/hardware label 或各平台只读系统信息适配器确认。Benchmark 仅运行在受控发布 runner，不要求普通用户机器提供统一的跨平台磁盘类型 API，因此当前 Node 工具链足够。

### 单一 harness 与单调时钟

**通过。** 单一 harness 使用 `process.hrtime.bigint()` 从动作发起计时，到同一 harness 观察到对应完成事件：

- 首次概览：clean cache 下动作发起到结果可见。
- 缓存邻域：已提交 warm cache 下查询发起到结果可见。
- 保存更新：宿主 save 动作到对应 graph/Findings revision 可见。

所有时间差都在同一进程的 monotonic clock 上计算，跨进程只传递 requestId/jobId/revision 作为事件关联，不比较 wall-clock 或不同进程时钟。Node 24 的 `process.hrtime.bigint()` 正好满足这一模型。

### Nearest-rank p95

**通过。** p95 已固定为 nearest-rank order statistic `x[ceil(0.95*n)]`，且 `n >= 20`。实现只需：

1. 将有效测量升序排序。
2. 计算 1-based `k = ceil(0.95 * n)`。
3. 取第 `k` 个样本作为 p95。

这消除了 nearest-rank 与线性插值等不同 percentile 实现造成的 gate 分歧。2 次 warm-up 不进入测量集合；reference preflight invalid 会直接失败而不是污染样本。

## 封闭 Manifest Profile 复核

### ReleaseArtifactManifestV1

**通过。** 合同已固定：

- JSON Schema 2020-12，`additionalProperties:false`。
- 明确字段、artifact/platform/arch 枚举和封闭 payload entry `{path,mode,size,sha256}`。
- payload entries 按相对 POSIX path 升序。
- payloadRootDigest 对 payloadEntries 执行 RFC 8785 JCS → UTF-8 → SHA-256。
- 输入域排除 artifact/set manifest 自身、签名、时间戳和 provenance attestation。
- SbomInventoryV1 是无 timestamp、serial、绝对路径的 JCS payload entry。

自哈希、字段顺序、换行、绝对 checkout 路径和 SBOM volatile metadata 均已从可复现 oracle 中排除。Node fs/crypto 与 Ajv 8.20.0 足以生成和校验该合同。

### ReleaseSetManifestV1

**通过。** ReleaseSetManifestV1 固定同版本 CLI/全部目标 VSIX 的公共 product/source/lockfile/protocol/schema 字段，并按 artifactId/platform/arch 排序绑定 artifactManifestDigest 与 payloadRootDigest。`releaseSetId` 对省略自身字段的其余对象执行 JCS SHA-256，因此不存在自引用。

AD-12 已固定目标集合：CLI npm 包以及 Windows x64、macOS arm64/x64、Linux x64 VSIX。release orchestrator 可以在发布前检查集合完整性与公共字段一致性，不依赖制品平台的私有聚合能力。

### ReleaseSignatureV1 / `ed25519-sha256-v1`

**通过。** Node 24 官方 `node:crypto` 支持当前 profile 所需全部能力：

- 对精确 JCS manifest bytes 计算 SHA-256。
- 使用 Ed25519 对 32-byte digest 执行 sign/verify。
- 将公钥导出为 SPKI DER。
- 对 SPKI DER 计算 SHA-256 形成稳定 keyId。
- Base64 编解码签名。

ReleaseSignatureV1 已封闭 subjectKind、subjectDigest、keyId、signatureBase64；artifact/set 使用相同 profile，避免两个发布单元自行选择 RSA/ECDSA、DER/PEM 或“签原文/签摘要”。时间戳和 provenance 在签名后附加并引用已签 subject/root，不破坏 payload 复现。

### Trust root 与 key rotation

**通过。** `release/trusted-keys.v1.json` 固定允许 keyId 与有效期；新 trust record 必须由当前 active key 签署并经过 release-owner 审批。初始 trust root 是仓库发布配置的显式 seed，后续轮换形成连续签名链。私钥可由 CI secret store/HSM 提供给 Node crypto key handle；架构没有要求把密钥写入仓库，也没有绑定某个云 KMS，因此与现有 provider-neutral 边界相容。

紧急密钥吊销和长期可信时间戳属于发布运维策略，可在具体 provider/组织安全策略中实现；当前合同没有依赖它们才能计算或验证 artifact/set signature，故不构成 MVP 技术阻塞。

## 其他回归

- `architecture-required` 仍由仓库外 provider ruleset 强制，管理员 bypass 禁用；仓库 PR 不能移除保护边界。
- 仓库内 sync/verify 只做快速反馈，外部 drift monitor 独立验证 ruleset/check ID，职责与技术边界清晰。
- LastValidIgnoreRecordV1、ProjectionMembershipV1、FindingAttributionKernelV1 和 Release SBOM/payload oracle 未因本轮收紧引入新依赖。
- 当前精确 Stack pins 与 Round 2 现实核验一致，没有版本漂移阻塞。

## Critical / High / Medium Findings

无。

## 残余观察

无技术阻塞。实施阶段需要提供具体 JSON Schema、fixture、reference runner image/labels、provider ruleset adapter 和密钥保管配置，但这些都是当前架构已明确边界内的实现制品，不需要新增架构决定。

## 证据来源

- 当前架构：`../ARCHITECTURE-SPINE.md`
- 当前实施指南：`../IMPLEMENTATION-GUIDE.md`
- 当前 memlog：`../.memlog.md`
- Node 24 process.hrtime：`https://nodejs.org/docs/latest-v24.x/api/process.html#processhrtimebigint`
- Node 24 crypto：`https://nodejs.org/docs/latest-v24.x/api/crypto.html`
- Ajv 8.20.0：`https://registry.npmjs.org/ajv/8.20.0`
- RFC 8785 JCS：`https://www.rfc-editor.org/rfc/rfc8785`
- Reproducible Builds：`https://reproducible-builds.org/docs/source-date-epoch/`
