---
type: architecture-review
lens: correction-2026-07-16-technology-reality-round4
date: 2026-07-16
artifact: ../ARCHITECTURE-SPINE.md
previous-review: review-correction-2026-07-16-technology-round3.md
verdict: pass
critical: 0
high: 0
medium: 2
blocking: 0
---

# 2026-07-16 纠偏更新：技术现实性最终确认（Round 4）

## 结论

**PASS。0 Critical、0 High、0 阻塞。** 最新新增的 GateRegistryV1、GateEvaluationContextV1、GateEvidenceV1、ReadinessGatePolicyV1、ReadinessGateManifestV1 与 ValidationArtifactBindingV1 均可由现有 Git CLI、Node 24、JSON Schema 2020-12、RFC 8785 JCS、SHA-256、provider app/service 身份认证及支持原子事务/CAS 的证据存储实现。

这些合同已经关闭此前的关键技术分叉：registry、context、producer、candidate、policy、manifest、evidence 和 artifact binding 均有稳定身份；旧 base/head、旧 registry、错误 producer、冲突 evidence、继承环、孤儿 binding/evidence 均进入 invalid 或 fail closed。未发现需要新增框架、升级版本或依赖某个尚未选定 provider 私有 API 才能成立的断言。

## 合同逐项验证

### 1. GateRegistryV1 与 GateDefinitionV1

**通过。** Registry 固定 schemaVersion、按 gateId 排序的 gates 和 gateRegistryDigest；GateDefinitionV1 固定 gate/check、triggerPaths、argv command、owner、blocking 与 evidenceProducerId，完整定义进入 gateDefinitionDigest。该模型可由 YAML 解析后生成封闭 JSON 对象，再使用共享 JCS/hash helper 计算，避免 YAML 键顺序、shell quoting 和 producer 选择漂移。

### 2. GateEvaluationContextV1

**通过。** Context 绑定 providerRepositoryId、Git objectFormat、完整 base/head OID、确定性的 comparisonBaseOid 与 gateRegistryDigest；evaluationContextDigest 覆盖完整 context。`git merge-base --all` 多结果按完整 OID 字典序取最小值，无结果 invalid；affected paths 使用固定 OID 和 `git diff --name-status -z --no-renames`。该流程可在 SHA-1/SHA-256 repository 上执行，并对 criss-cross history、特殊文件名、删除和重命名得到唯一结果。

Controller umbrella CAS 已从未限定的 manifestDigest 收紧为 `{providerRepositoryId,headOid,evaluationContextDigest}`，发布前重新核对 provider 当前 base/head，变化即废弃并重算。旧 context 无法复用。

### 3. GateEvidenceV1 与 producer 身份

**通过。** Child evidence 是封闭合同，绑定 gateId、gateDefinitionDigest、evidenceProducerId、evaluationContextDigest、headOid、terminal status 与 outputDigest。Controller 只接受 provider-authenticated 且与 GateDefinition 匹配的 producer；同 context 相同证据重放幂等，冲突证据 invalid。仓库 workflow 只能提交 child evidence，不能发布 umbrella 结论，技术上可由 provider App identity、独立 Controller credential 和 required-check source binding实现。

required gate 缺证据、producer 不匹配、context 过期或证据冲突都不能退化为 not-applicable，符合 fail-closed 要求。

### 4. ReadinessGatePolicyV1 / Manifest / Evaluator 分权

**通过。** Policy 先于候选存在，继承链固定为 alpha → beta → beta-plus → v1.1 并要求无环。Compiler 只读取 policy、gate registry 与 CandidateRef，不能读取运行证据；Manifest 是 immutable 确定性输出。Evaluator 只能消费 finalized Manifest/Evidence 并生成 Result，不能改变 applicability。

普通 PR 明确不选择 releaseSlice/gatePhase，也不编译 Readiness manifest，只执行 registry trigger applicability；entry/exit/release 才使用 policy 闭包。缺失/重复规则、继承环或同 gateId 解析到不同 gateDefinitionDigest 均 invalid。该职责分离可通过独立模块、Schema contract tests 和权限隔离实现，不要求独立微服务。

### 5. Product validation evidence digest 链

**通过。** Plan、Policy、Manifest、Candidate、Evidence 和 Result 的 JCS/SHA-256 引用链闭合；Manifest 只预声明执行前已知的 evidence slot，不包含尚未生成的 evidenceDigest，避免摘要循环。Evidence 引用 plan/policy/manifest/candidate/task/fixture，Result 引用排序后的 evidenceId/evidenceDigest。任一断链 invalid。

### 6. ValidationArtifactBindingV1

**通过。** ExportArtifact 只有完整生成后才有稳定 artifactId/contentDigest；evidence recorder 是 binding 唯一写入者，并使用发布证据存储的唯一 service identity。ProductValidationEvidenceV1 与 Binding 在同一个 append-only commit record 中原子提交，artifactId/evidenceId 分别唯一；恢复时孤儿 binding 或孤儿 evidence 直接 invalid，禁止补写。

这可由 SQLite 单事务、支持条件写入的关系数据库，或带事务/compare-and-set 的外部 evidence store 实现。架构没有绑定不存在的通用“分布式事务”能力；原子性范围明确限定在同一证据存储的 commit record。

## 非阻塞观察

### TR4-M1 — Medium — GateEvidence `outputDigest` profile 可进一步明文化

GateEvidenceV1 已包含 outputDigest，但没有像 contentDigest 一样明确输出字节的规范化方式与摘要编码。由于每个 gate 只允许一个 evidenceProducerId，且 Controller 校验定义与 producer，该缺口不会形成当前 High 或绕过 fail-closed；producer/controller 可共享实现并把不匹配判 invalid。

实施 GateEvidence Schema 时建议固定 OutputArtifactV1 或明确：结构化输出使用 JCS UTF-8，文本使用无 BOM/LF UTF-8，outputDigest 使用 lowercase SHA-256。这样可以减少重试时因日志时间戳或换行变化导致的冲突 evidence。

### TR4-M2 — Medium — Binding 幂等比较可明确为“完整绑定相等”

当前合同同时规定 artifactId CAS、相同候选重放幂等、artifactId/evidenceId 唯一和原子 commit。技术上可安全实现，但“相同候选、不同 evidenceId/evidenceDigest”的重放应在 Schema/存储测试中明确为 conflict/invalid，而不是返回首个 binding。

建议实现规则固定为：只有 ValidationArtifactBindingV1 全字段相等才幂等；artifactId 相同但 candidateRefDigest、evidenceId、evidenceDigest 或 contentDigest 任一不同均 invalid。该建议是行为精化，不影响现有原子写入方案的技术可执行性。

## High 风险扫描

- 未发现未认证 producer 可提交权威 child evidence 的路径。
- 未发现旧 base/head、旧 registry 或旧 context 结论可复用的路径。
- 未发现 compiler 可读取 evidence 后反向修改 applicability 的路径。
- 未发现 Evidence/Binding 跨存储分布式事务的隐含要求。
- 未发现 orphan record 能被人工补写为通过的路径。
- 未发现必须依赖尚未选择的 provider 特定 API 才可表达的合同；provider 能力不足时仍由 Story 1.3 阻塞。

## 阻塞项

无。

## Reviewer Gate 决定

- Critical：0
- High：0
- Medium：2（非阻塞明文化建议）
- Blocking：0
- **技术现实性 Gate：PASS**

## 证据来源

- 当前架构：`../ARCHITECTURE-SPINE.md`
- 当前实施指南：`../IMPLEMENTATION-GUIDE.md`
- Round 3 报告：`review-correction-2026-07-16-technology-round3.md`
- Git merge-base：<https://git-scm.com/docs/git-merge-base>
- Git diff：<https://git-scm.com/docs/git-diff>
- RFC 8785：<https://www.rfc-editor.org/rfc/rfc8785>
- JSON Schema 2020-12：<https://json-schema.org/draft/2020-12>
