---
type: architecture-review
lens: technology-reality-readiness-update-round2
date: 2026-07-15
artifact: ../ARCHITECTURE-SPINE.md
verdict: pass
critical: 0
high: 0
medium: 1
---

# Implementation Readiness 更新：技术现实复审（Round 2）

## Verdict

**PASS，带 1 个 medium 收紧项。** 当前最终候选已消除 ReleaseArtifactManifestV1 自哈希，固定 SbomInventoryV1 的可复现输入，建立 `architecture-required` aggregator 与 provider sync/verify，并用 ReleaseSetManifestV1 闭合同版本 CLI/全平台 VSIX 的集合一致性。LastValidIgnoreRecordV1、AD-25 最新叶子 membership/外部边计数、quality-gates manifest 和可复现 payload oracle 均可由当前 Node 24 / TypeScript / YAML / Ajv / Vitest / SQLite / VS Code 打包栈实现。

唯一剩余问题是 BenchmarkPlanV1 自称性能发布门禁的“唯一 oracle”，但没有固定 p95 estimator、单调时钟和 reference runner 环境不匹配的处置；这不会迫使更换技术栈，但会使两个合规 runner 在门槛附近作出不同判定。

本轮在最终判断前重新读取了当前 `ARCHITECTURE-SPINE.md`、`IMPLEMENTATION-GUIDE.md` 和 memlog。AD-25 已包含 directory/package 叶子 membership 映射，并规定 external edge Finding 只对实际存在的内部端点聚合计数。

## 当前技术与版本现实

当前仓库仍是绿地规划制品，没有实现级 `package.json`、锁文件、CI provider 配置或 release scripts；外部现实依据来自官方/registry 与既有 Gate 记录。精确版本回归未发现新问题：

| 绑定项 | 现实核验 | 结果 |
| --- | --- | --- |
| Node.js 24.18.0 | 官方发布存在，Krypton LTS，ABI 137；提供 SHA-256、JCS 输入所需 UTF-8、单调高精度计时、文件/进程 API | 通过 |
| TypeScript 6.0.3 | npm 精确版本存在，稳定 Compiler API 未变化 | 通过 |
| yaml 2.9.0 / Ajv 8.20.0 | 可解析并严格校验 Benchmark、quality-gates、release manifests | 通过 |
| Vitest 4.1.10 | Node 24 兼容，可承载 unit/property/contract/gate tests | 通过 |
| @vscode/vsce 3.9.2 | 精确版本存在，适配 platform-specific VSIX；payload root 比较基于规范文件 tuples，不依赖 ZIP 字节完全相同 | 通过 |
| better-sqlite3 12.11.1 | Node ABI 137 目标资产此前已核验，AD-29 可把资产 hash/ABI 写入 artifact manifest | 通过 |

## Medium Finding

### TR2-1 — [MEDIUM] BenchmarkPlanV1 尚不足以成为唯一 p95 oracle

AD-19 已固定 fixture/digest、参考环境、SLA 起止事件、cold/warm cache、2 次 warm-up、至少 20 次测量和 p95。技术上完全可行：Node 24 可使用 `process.hrtime.bigint()` 或等价 monotonic clock 记录事件，BenchmarkResultV1 可由 JSON/JCS 输出，VS Code save → graph/Findings revision visible 也可通过既有 Job/revision/status 合同关联。

但“p95”仍有多个常见实现：nearest-rank、线性插值等。在 20 个样本上，它们可能选第 19 个值、在第 19/20 个值间插值或采用其他约定；门槛附近会给出不同 pass/fail。参考环境写入 manifest 也尚未规定 preflight 不匹配时 fail、skip 还是降级记录；共享 CI runner 的 CPU 抢占、SSD/缓存条件不能自动等价于 8 CPU/16 GB/SSD 参考环境。

**建议收紧但不阻塞当前技术选型：**

- 固定 percentile 为 nearest-rank：排序后取 `ceil(0.95 * n)` 的 1-based 样本。
- 固定 monotonic clock 与统一时间单位；跨进程事件使用 requestId/jobId/revision 关联，不比较各进程 wall-clock。
- BenchmarkPlanV1 固定 reference runner image/hardware label 和环境 preflight；发布门禁环境不匹配直接 fail。
- 明确进程崩溃/超时样本计入 gate failure，不能从 20 次测量中静默剔除。

## 已通过的重点核验

### LastValidIgnoreRecordV1

**通过。** 当前栈可用 SQLite transaction，或同目录临时文件 + flush/close + rename，原子保存 last-valid record；使用 JCS/UTF-8/SHA-256 校验 workspaceKey、grammarVersion、builtinRulesVersion、user/effective rules、acceptedContentHash 与 checksum。恢复结果进入 bootstrap read-set、bootstrapGeneration 和 snapshot CAS，符合既有服务模型。

checksum 提供损坏检测而非同用户攻击者下的认证；当前安全模型没有承诺抵御已取得同一用户权限的恶意进程，因此不存在技术现实冲突。实施时应沿用其他 digest 的规则，明确 checksum 不覆盖自身。

### AD-25 最新 membership 与 external Finding 计数

**通过。**

- directory：scopeRoot 下最多 aggregationDepth 段的最近目录祖先；scopeRoot 直接文件归 scopeRoot。
- workspace-package：包含文件的最深 recognized package root；非 package 文件归 indexing-root；等深冲突按规范 root ID。
- edge Finding 只对存在的内部端点叶子聚合计数，external-only 端点不会被虚构成本地聚合。

这些都是规范 path/package discovery/graph edge 上的确定性 Map、排序和哈希，无需新数据库或图库；membership digest 可复用 RFC 8785 JCS + SHA-256。

### `ci/quality-gates.v1.yaml` 与 required-check enforcement

**通过，上一版 evidence gap 已关闭。**

- manifest 继续作为 blocking gate 唯一清单，yaml/Ajv 可解析、版本化和校验。
- CI provider 只要求稳定 always-run check `architecture-required`，避免动态 checkId 与 path filter 导致 required check 永久 pending。
- aggregator 读取 manifest 并执行所有适用 blocking gate；不适用 gate 可由 aggregator 内部显式记录，而 provider 只依赖总结果。
- 独立 sync/verify job 检查 branch protection 实际仍要求 `architecture-required`，能发现仓库外配置漂移。

实现层仍需为所选 provider 写一个很小的 adapter/API 校验脚本，但这不需要改变主栈，也不需要把 provider 固化为架构不变量。

### ReleaseArtifactManifestV1 payload oracle

**通过，上一版 high 已关闭。**

- payloadRootDigest 输入固定为相对 POSIX path 排序的 `{path,mode,size,sha256}` tuples。
- tuples 使用 RFC 8785 JCS → UTF-8 → SHA-256，消除了 JSON 格式、换行和字段顺序差异。
- 输入域明确排除 ReleaseArtifactManifestV1 自身，以及签名、时间戳和 provenance attestation，消除了不可求解的自哈希。
- manifest 本身使用精确 JCS bytes，并由 artifact signature 覆盖；时间戳/provenance 在复现校验后引用 manifestDigest 与 payloadRootDigest。

Node crypto/fs 足以生成文件 hash、size 和 JCS 输入。文件 mode 必须取规范 payload mode，而不是直接复制 Windows ACL；当前合同以 target artifact 为单位比较，同平台/架构 clean builds 可实现。

### SbomInventoryV1

**通过，上一版 medium 已关闭。**

SbomInventoryV1 固定为无 timestamp、serial、绝对路径的规范 JCS inventory，并作为普通 payload 文件纳入 root；manifest 同时记录其 digest。这样 SBOM 不再依赖 CycloneDX/SPDX 工具默认生成的时间/UUID/本机路径，也无需在主 Stack 中新增第三方生成器。package/版本/license 数据可从锁文件、package manifests 与打包清单生成并稳定排序。

若未来需要发布标准 CycloneDX/SPDX 作为外部 companion，可从 SbomInventoryV1 投影生成，并把含时间/provenance 的标准文档放到 payload root 之外；这不影响当前 MVP oracle。

### ReleaseSetManifestV1

**通过。** ReleaseSetManifestV1 解决了单 artifact manifest 无法证明“同版本 CLI 与全部目标 VSIX 属于同一源码/协议集合”的问题：

- 公共字段固定 productVersion、sourceCommit、lockfileDigest、protocol/schema 集合。
- artifact tuples 按 artifactId/platform/arch 排序并绑定 payloadRootDigest。
- releaseSetId 使用 JCS SHA-256，set 签名覆盖精确 manifest bytes。
- AD-12 的目标平台集合固定，因此 orchestrator 可判断 release set 是否完整，不能只发布部分成功产物。

该模型只需要 release orchestrator 聚合 JSON/JCS 与 hash，不依赖云制品系统的私有功能。

## 最高优先结论

1. ReleaseArtifactManifestV1 自哈希和 root canonicalization 已修复，发布 oracle 技术可执行。
2. SbomInventoryV1 与 ReleaseSetManifestV1 已闭合单 artifact 和跨 artifact 的可复现/一致性证据。
3. `architecture-required` aggregator + provider sync/verify 已使 quality-gates manifest 能真实阻止合并。
4. 唯一剩余 medium 是 BenchmarkPlanV1 的 p95 estimator、时钟与 reference runner preflight 未固定。

## 证据来源

- 当前架构：`../ARCHITECTURE-SPINE.md`
- 当前实施指南：`../IMPLEMENTATION-GUIDE.md`
- 当前 memlog：`../.memlog.md`
- Node 24 releases/API：`https://nodejs.org/dist/index.json`、`https://nodejs.org/docs/latest-v24.x/api/`
- npm Registry：`https://registry.npmjs.org/`
- RFC 8785 JCS：`https://www.rfc-editor.org/rfc/rfc8785`
- Reproducible Builds：`https://reproducible-builds.org/docs/source-date-epoch/`
- VS Code 扩展发布：`https://code.visualstudio.com/api/working-with-extensions/publishing-extension`
