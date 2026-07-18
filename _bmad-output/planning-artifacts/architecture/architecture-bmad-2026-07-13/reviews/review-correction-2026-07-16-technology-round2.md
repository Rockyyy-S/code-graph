---
type: architecture-review
lens: correction-2026-07-16-technology-reality-round2
date: 2026-07-16
artifact: ../ARCHITECTURE-SPINE.md
previous-review: review-correction-2026-07-16-technology.md
verdict: pass-with-residual
critical: 0
high: 0
medium: 1
---

# 2026-07-16 纠偏更新：技术现实性复审（Round 2）

## 结论

**PASS WITH RESIDUAL。** 上轮 3 个 High 与 always-run/fail-closed 缺口的主体均已关闭：provider/platform 不再被假设为天然可用，而被定义为 Story 1.3 前必须取证、能力不足即阻塞的外部前置条件；AD-30 已固定 CandidateRefV1、JCS/UTF-8/SHA-256、digest 引用链和 release-set 绑定；`ci/quality-gates.v1.yaml` 已降为 gate 定义注册表，ReadinessGateManifestV1 只做候选/阶段适用性选择；`architecture-required` 已明确每个 PR 必跑、无 workflow path filter，并对 invalid/未知 gate/证据缺失/provider drift fail closed。

当前没有新增不存在的技术、版本或平台能力断言，也不需要更换 Node 24、TypeScript 6、Ajv 或现有 CI 架构。仅残留 1 个 Medium 级跨实现一致性问题：`gateDefinitionDigest` 的计算 profile 尚未固定。

## 上轮发现关闭情况

| 上轮发现 | Round 2 结果 | 证据 |
| --- | --- | --- |
| TR-H1 Provider ruleset/platform 未绑定 | **关闭** | AD-28 要求 Story 1.3 记录实际 provider、plan、权限与禁用 bypass 能力证据；不支持仓库外强制时 Story 阻塞。Deferred 同步要求 Story 1.3 前选择并验证 provider/plan。 |
| TR-H2 AD-30 digest 无规范 profile | **关闭** | AD-30 固定 CandidateRefV1；plan/manifest/evidence/result 使用省略自身 digest 字段后的 RFC 8785 JCS UTF-8 SHA-256；fixture/task digest 输入域和 Evidence/Result 引用链也已固定。 |
| TR-H3 两个 manifest 均声称唯一清单 | **关闭** | AD-28 将 quality-gates 定义为 gate 注册表；AD-30 将 ReadinessGateManifestV1 定义为选择器，只能引用 registry gateId、command 与 gateDefinitionDigest，不能重定义 gate。 |
| TR-M1 always-run/fail-closed 未闭合 | **关闭** | AD-28 明确 aggregator 无 path filter、每个 PR 运行；triggerPaths 只控制子 gate；状态仅 required/not-applicable/invalid，invalid、未知 gate、缺证据和 provider/drift 不一致均 fail closed。 |

## 残余发现

### TR2-M1 — Medium — `gateDefinitionDigest` 缺少唯一计算 profile

**位置：** `ARCHITECTURE-SPINE.md:223-227`、`ARCHITECTURE-SPINE.md:235-239`。

ReadinessGateManifestV1 必须携带与 `ci/quality-gates.v1.yaml` 匹配的 `gateDefinitionDigest`，这是两个 manifest 防漂移的关键连接点；但当前文档没有固定：

- digest 覆盖 gate 定义的哪些字段；
- 是否包含 gateId/checkId、triggerPaths、command、capabilityOwner、blocking；
- triggerPaths 的排序/去重规则；
- 是否先将 YAML 解析为封闭规范对象；
- 是否复用 RFC 8785 JCS UTF-8 lowercase SHA-256；
- schema version 或默认值是否进入摘要。

AD-30 对 plan/manifest/evidence/result 的 digest 已完整定义，但该规则不能自动推出 registry 内单个 gate definition 的摘要输入域。两个 runner 仍可能一个只 hash command，另一个 hash 全定义，并对同一 registry 产生不同 `gateDefinitionDigest`。

**建议关闭方式：** 定义 GateDefinitionV1 封闭对象，例如 `{schemaVersion,gateId,checkId,triggerPaths,command,capabilityOwner,blocking}`；默认值显式化、triggerPaths 按规范字符串排序去重后，对该对象执行 RFC 8785 JCS UTF-8 小写十六进制 SHA-256。Readiness manifest 只携带 gateId 与 gateDefinitionDigest，若为审计重复 command/owner/blocking，则必须逐字段与定义对象相等。

该问题不否定当前技术路线，也不要求选定特定 provider；但应在实现 quality-gates Schema/runner 前关闭，否则 manifest 防漂移保证仍依赖实现约定。

## 技术现实性回归

### Provider / platform

- 具体 provider/plan 现在是显式 Deferred，并有 Story 1.3 进入条件，不再从通用“provider”概念推断所有平台均支持 ruleset、无 bypass 与外部读取。
- release/platform owner、外部 ruleset、独立 drift monitor 与仓库内 sync/verify 的信任边界已分离。
- 能力不足时明确 fail closed/阻塞，符合 GitHub/GitLab/Azure DevOps 能力与套餐差异的现实。

### Digest / Candidate

- Source candidate 绑定 productVersion、完整 commit OID、lockfileDigest；release gate 只接受绑定 AD-29 releaseSetId 的 release-set candidate。
- Candidate、Plan、Manifest、Evidence、Result 的规范字节与摘要算法可由当前 Node crypto + RFC 8785 JCS helper 实现。
- JSON Schema 2020-12 与 `additionalProperties:false` 可继续由现有 Ajv 8.20.0 承担。

### CI always-run / fail-closed

- 禁止 aggregator workflow path filter，避免 required check 因 workflow 被过滤而永久 Pending。
- 子 gate applicability 使用 base-to-head 新旧路径并集，删除场景使用旧路径，避免删除敏感文件时 gate 被错误判为不适用。
- manifest/schema/definition/evidence/provider/drift 异常统一失败，不依赖“缺失即跳过”。
- 若最终采用 GitHub merge queue，仍需在 provider capability profile 中把 `merge_group` 事件列入实际证据；这是 provider 选择后的配置验证，不是当前架构缺口。

## Reviewer Gate 决定

- 上轮 3 个 High 与 1 个 Medium 主缺口已关闭。
- 当前无 Critical/High，不阻止架构更新继续收敛。
- 在实现 gate registry Schema/runner 前关闭 TR2-M1；关闭后本技术现实性 Gate 可无保留通过。

## 证据来源

- 当前架构：`../ARCHITECTURE-SPINE.md`
- 当前实施指南：`../IMPLEMENTATION-GUIDE.md`
- 上轮报告：`review-correction-2026-07-16-technology.md`
- RFC 8785：<https://www.rfc-editor.org/rfc/rfc8785>
- JSON Schema 2020-12：<https://json-schema.org/draft/2020-12>
- GitHub required status checks：<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks>
