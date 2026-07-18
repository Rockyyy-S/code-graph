---
type: architecture-review
lens: correction-2026-07-16-technology-reality-round3
date: 2026-07-16
artifact: ../ARCHITECTURE-SPINE.md
previous-review: review-correction-2026-07-16-technology-round2.md
verdict: pass
critical: 0
high: 0
medium: 0
---

# 2026-07-16 纠偏更新：技术现实性终审（Round 3）

## 结论

**PASS。无残余技术阻塞。** Round 2 唯一残余的 `gateDefinitionDigest` 已关闭；本轮新增的 LockfileDigestV1、ArchitectureGateController、GateEvaluationContextV1、固定 OID diff 与 fail-closed 规则均可由现有 Git、Node 24、provider app/service API、RFC 8785 JCS 和 SHA-256 技术栈实现，没有引入不存在的技术或未经现实检查的平台承诺。

具体 provider/plan 仍是 Story 1.3 前的显式选择，但架构已经把“支持仓库外强制、禁用 bypass、绑定 Controller 身份、允许独立 drift monitor 读取”定义为进入条件；不满足即阻塞，不再假定所有 provider 都等价支持。因此该 Deferred 不构成技术现实性缺口。

## 终审验证

### 1. GateDefinitionV1 / gateDefinitionDigest

**通过。** AD-28 已固定 GateDefinitionV1 的完整摘要输入：

- `gateId`
- `checkId`
- 排序去重后的 `triggerPaths`
- argv 字符串数组 `command`
- `capabilityOwner`
- `blocking`

`gateDefinitionDigest` 明确为该对象 RFC 8785 JCS → UTF-8 → lowercase hexadecimal SHA-256。YAML 键顺序、普通 JSON 序列化差异和 shell command quoting 不再影响摘要；command 使用 argv 数组也避免同一命令在 shell 字符串转义上的歧义。ReadinessGateManifestV1 只能引用匹配 gateId、digest 与 command，不能重定义 gate。

### 2. LockfileDigestV1

**通过。** AD-29 已把 lockfile identity 唯一固定为 Git 已提交 `pnpm-lock.yaml` 的：

1. 无 BOM；
2. LF 规范化；
3. UTF-8 字节；
4. lowercase hexadecimal SHA-256。

ReleaseArtifactManifestV1、ReleaseSetManifestV1 与 source CandidateRefV1 只能使用同一 LockfileDigestV1，消除了工作树 CRLF、编辑器 BOM、包管理器输出格式之外的摘要分叉。实施时必须从 CandidateRefV1.sourceCommit 对应的已提交 tree 读取 lockfile；若该 commit 不存在 lockfile、无法读取、UTF-8/规范化失败或摘要不匹配，则 CandidateRef/Evidence 无法形成有效引用并 fail closed。

### 3. Provider / ArchitectureGateController 权威边界

**通过。** Story 1.3 后：

- 仓库外 ArchitectureGateController app/service identity 是 `architecture-required` umbrella 结论的唯一发布者；
- 仓库 workflow 只能提交 child evidence，不能发布最终结论；
- Controller 结论 CAS 绑定 `providerRepositoryId`、完整 `headOid` 与 `manifestDigest`；
- release/platform owner 持有 provider ruleset、Controller 与独立 drift monitor；
- Story 1.3 必须记录实际 provider、plan、规则权限、禁用 bypass 与 monitor 读取权限的能力证据；
- provider 不具备仓库外强制能力时 Story 1.3 阻塞，禁止退化为仓库内自检。

该模型可由支持 required-check source/app identity、ruleset/branch-policy API 和外部 app/service credential 的 provider 实现。具体 API 留给 Story 1.3 的 provider capability profile，不影响架构技术可行性。实施证据必须证明 required check 实际绑定 Controller identity，而不只是同名 check context；否则不满足“唯一发布者”不变量并应 fail closed。

### 4. Base OID、merge-base 与 affected paths

**通过。** GateEvaluationContextV1 已固定：

- `providerRepositoryId`
- Git `objectFormat`
- provider 提供的完整 `baseOid` / `headOid`
- `comparisonBaseOid = git merge-base(baseOid, headOid)`
- `git diff --name-status -z --no-renames comparisonBaseOid headOid`

路径集合只来自固定 OID；NUL 分隔避免特殊文件名解析错误；`--no-renames` 把重命名稳定解释为 delete+add；删除使用旧路径；triggerPaths 基于 AD-14 的 POSIX glob 且禁止反选。不同 runner 不再自行选择 working tree、当前 base branch、两点 diff、三点 diff或 rename threshold。

Git SHA-1 与 SHA-256 repository 可通过 `objectFormat` 与完整 OID 区分。provider OID 不可获取、本地 object 缺失、merge-base 不存在或 Git diff 非零失败时，GateEvaluationContext/Evidence 无法有效生成；required gate 因无有效证据进入 fail closed。

### 5. Always-run 与 fail-closed 可执行性

**通过。** `architecture-required` workflow 自身禁止 path filter、每个 PR 都运行；triggerPaths 只影响子 gate applicability。子 gate 状态封闭为 `required | not-applicable | invalid`，并明确以下情况失败：

- manifest 无效；
- 未知 gate；
- definition/command digest 不匹配；
- required gate 无有效证据；
- provider ruleset 不一致；
- drift monitor 不一致；
- Controller CAS 的 head/manifest 已陈旧。

因此 Git/OID、CandidateRef、lockfile、registry、policy、manifest、evidence、provider controller 任一前置数据无法验证时，都不能被解释为 not-applicable 或通过。当前规则可由 Controller 在发布最终 check conclusion 前统一执行，不依赖仓库 workflow 自证保护边界。

## 未变技术栈回归

- Node.js 24.18.0、TypeScript 6.0.3、pnpm 11.12.0、better-sqlite3 12.11.1、Ajv 8.20.0 等版本未被本轮改变。
- JCS/SHA-256、Git merge-base/diff、provider app/service CAS 均属于现有稳定能力。
- 本轮没有要求某个尚未选定的 provider 必然支持；能力取证和不满足时阻塞已写入 AD-28 与 Deferred。

## 残余阻塞

无。

## Reviewer Gate 决定

- Critical：0
- High：0
- Medium：0
- **技术现实性 Gate：PASS**

## 证据来源

- 当前架构：`../ARCHITECTURE-SPINE.md`
- 当前实施指南：`../IMPLEMENTATION-GUIDE.md`
- Round 2 报告：`review-correction-2026-07-16-technology-round2.md`
- Git merge-base：<https://git-scm.com/docs/git-merge-base>
- Git diff：<https://git-scm.com/docs/git-diff>
- RFC 8785：<https://www.rfc-editor.org/rfc/rfc8785>
- Node.js crypto：<https://nodejs.org/docs/latest-v24.x/api/crypto.html>
