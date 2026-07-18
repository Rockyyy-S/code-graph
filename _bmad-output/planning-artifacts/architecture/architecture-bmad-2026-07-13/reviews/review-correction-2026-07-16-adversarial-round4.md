# Reviewer Gate Round 4 — 2026-07-16 最终对抗确认

## 结论

**FAIL / NEEDS WORK，仅剩 2 个下层实现阻塞。** 上一轮五项中，GateEvaluationContext CAS、普通 PR 与 readiness manifest 解耦、ValidationArtifactBinding 原子事务、多 merge-base 唯一化均已关闭；GateEvidence 的 producer/context 绑定也已建立。继续构造两个逐字合规实现后，只剩 policy 的 phase 闭包语义和 GateEvidence 重放 digest 两处仍可产生不同 gate 集或相反的冲突判定。

机械检查：`lint_spine.py` 返回 `ok=true, total_findings=0`。本次只生成本报告，未修改 Spine 或 Guide。

## 上一轮五项复核

| Round 3 阻塞 | Round 4 判定 | 关闭证据 / 残余 |
| --- | --- | --- |
| context CAS 未绑定 base/evaluation context | **关闭** | GateEvaluationContextV1 加入 gateRegistryDigest 并生成 evaluationContextDigest；umbrella CAS 改为绑定 repository/head/context，发布前重读 provider base/head |
| policy inheritance / 普通 PR target | **部分关闭** | slice 继承链与普通 PR 不编译 readiness manifest 已固定；但 phase 在闭包中的继承/累计规则未固定 |
| GateEvidence 缺少合同 | **部分关闭** | GateEvidenceV1、producer、context、状态与 outputDigest 已固定；但“相同 evidence digest”的字段与算法不存在 |
| binding CAS 非原子 / authority 不明 | **关闭** | 唯一 evidence-store service identity；Evidence+Binding 同一 append-only commit record 原子提交；孤儿记录 invalid |
| 多 merge-base 非唯一 | **关闭** | `git merge-base --all` 后按完整 OID 字典序取最小，空集 invalid |

## 两个仍可逐字合规但不兼容的实现

### 实现单元 A：Exact-Phase Compiler + Full-Record Controller

- 对调用目标 `beta/exit`，沿 beta→alpha 的 slice 继承链只收集各 slice 的 `exit` 规则。
- GateEvidence 重放身份取完整 GateEvidenceV1 的 RFC 8785 JCS SHA-256；status 或 producer 等任一字段变化均为冲突。

### 实现单元 B：Cumulative-Phase Compiler + Output-Digest Controller

- 对调用目标 `beta/exit`，收集 alpha/beta 的 entry+exit 规则，认为 exit 必须累计早期 phase。
- 将 GateEvidenceV1 中唯一名为 digest 的 `outputDigest` 解释为“evidence digest”；相同 outputDigest 视为幂等重放。

两个单元都遵守显式 slice 继承、唯一 releaseSlice/gatePhase 输入、compiler 独占 applicability、evaluator 不修改 applicability，以及 GateEvidence 封闭字段与 producer/context 校验。但对相同输入：

1. A 的 manifest gate 集可能为 `{alpha.exit,beta.exit}`，B 为 `{alpha.entry,alpha.exit,beta.entry,beta.exit}`。
2. 同 gate/context、相同 outputDigest、但 status 从 pass 变为 fail 时，A 判冲突 invalid，B 判幂等并保留首次结果。

因此仍存在由架构未决定的共享语义分叉。

## 仍会阻塞下层实现的发现

### 1. ReadinessGatePolicyV1 只固定 slice 继承，没有固定 phase 闭包

AD-30 固定 alpha←beta←beta-plus←v1.1，并要求 compiler 对显式 `releaseSlice/gatePhase` 计算传递闭包，但没有规定：

- slice 父级只继承同名 gatePhase；
- 还是 `exit` 累计 `entry+exit`、`release` 累计 `entry+exit+release`；
- 父 slice 的哪些 phase 进入子 slice；
- 同 gateId 跨 phase 重复时是去重、覆盖还是 invalid。

这不是内部数据结构细节，而是直接决定 Manifest 的 blocking gate 集。必须固定 phase 偏序和闭包算法，例如：Policy 节点明确为 `(releaseSlice,gatePhase)`，每个节点显式列出 parent node；或规定 slice closure 后只选择目标 phase，禁止隐式跨 phase 累计。最终规范对象与算法需进入 policyDigest/contract tests。

### 2. GateEvidenceV1 没有 `gateEvidenceDigest`，重放与冲突语义不可唯一实现

AD-28 规定“同 gate/evaluationContextDigest 的相同 evidence digest 重放幂等，冲突证据 invalid”，但 GateEvidenceV1 字段只有 `outputDigest`，没有 evidenceDigest；也没有规定 evidence digest 对完整对象还是某个子集计算。`outputDigest` 从命名上只绑定输出，不能唯一代表 status、producer、gateDefinition 或 head。

这会让 Controller 在同 output、不同 status 或 producer 的重复提交上产生不同结论。必须增加：

- `gateEvidenceDigest`：对省略自身字段的完整 GateEvidenceV1 执行 RFC 8785 JCS UTF-8 小写 SHA-256；
- `outputDigest` 的内容域和算法，或明确它仅为审计字段；
- 幂等必须要求完整 gateEvidenceDigest 相等，其他同 gate/context 提交一律 conflict→invalid。

## 已确认不再阻塞的场景

1. provider base 推进会改变 evaluationContextDigest，旧 umbrella success 不能复用。
2. 普通 PR 不选择 slice/phase、不生成 ReadinessGateManifestV1，只按 gate registry + trigger applicability 执行。
3. child evidence 必须来自 GateDefinitionV1 指定且 provider-authenticated 的 producer。
4. Evidence 与 ValidationArtifactBinding 同一原子 commit，局部崩溃不能留下可接受的半状态。
5. criss-cross merge 的多个 best merge base 被完整枚举并确定性选择同一 comparisonBaseOid。

## Gate 判定

Round 4 尚不能给出 PASS。剩余两项都直接决定下层组件交换的 gate 集或 Controller 状态转换，属于真实阻塞而非可延期实现细节。补齐 phase closure 与 gateEvidenceDigest 后，本轮重放模型预计可收敛。
