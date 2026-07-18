# Reviewer Gate Round 3 — 2026-07-16 纠偏架构终审

## 结论

**FAIL / NEEDS WORK。** Round 3 已关闭 CandidateRef/lockfile digest、GateDefinition digest、基本 Git diff 算法、Controller 唯一发布者以及 artifact binding 逻辑 owner 等 Round 2 直接分叉，但仍存在四个阻塞性状态/执行缺口。两个下一层实现可以逐字遵守全部 AD，却在同一 PR 的适用 gate 集、base 更新后的 umbrella 结论、child evidence 有效性，以及 artifact binding 崩溃恢复结果上产生不同结论。

机械检查：`lint_spine.py` 返回 `ok=true, total_findings=0`。本次只生成审查报告，未修改 `ARCHITECTURE-SPINE.md` 或 `IMPLEMENTATION-GUIDE.md`。

## Round 2 攻击面复核

| 攻击面 | Round 3 判定 | 依据 |
| --- | --- | --- |
| CandidateRef / lockfile | **关闭** | AD-29 固定 LockfileDigestV1 为已提交 `pnpm-lock.yaml` 的无 BOM、LF 规范化 UTF-8 bytes 的小写 SHA-256；source CandidateRef 必须复用该值 |
| GateDefinition digest | **关闭** | GateDefinitionV1 字段、triggerPaths 排序去重、argv command、RFC 8785 JCS SHA-256 均已固定 |
| base diff 输入 | **部分关闭** | base/head full OID、merge-base、`--no-renames`、old/new 路径语义已固定；但 CAS 未绑定该上下文，且多 merge-base 未定义 |
| Controller owner | **部分关闭** | ArchitectureGateController 是唯一 umbrella 发布者；但 child evidence 格式与 producer provenance 未固定 |
| artifact binding CAS | **部分关闭** | evidence recorder 成为唯一逻辑 writer，artifactId CAS 与跨 candidate 冲突语义已固定；但 CAS authority scope、持久化及与 Evidence 的原子提交路径未固定 |
| policy compiler / evaluator | **部分关闭** | compiler 独占 applicability、evaluator 不得修改；但 Policy 语义和普通 PR 使用哪个 slice/phase Manifest 仍未确定 |

## 两个逐字合规但仍不兼容的实现单元

| 决策点 | 实现单元 A：Repository Policy / Evidence Worker | 实现单元 B：External Controller / Release Evaluator | 为什么二者仍可逐字合规 |
| --- | --- | --- | --- |
| PR Manifest 的 slice/phase | 对普通 PR 按当前里程碑编译 `beta/entry`，Policy 中每个 slice/phase 的 gate 列表是精确集合 | 对普通 PR 按最终交付目标编译 `beta-plus/release`，并累计继承更早 slice/phase gate | CandidateRefV1 不含 releaseSlice/gatePhase；compiler 又“只能读取 policy、registry、candidate”，AD-30 未固定 Policy 字段/继承语义，也未规定每个 PR 应编译哪个 slice/phase |
| base branch 推进后的 umbrella 结论 | 严格按 AD-28 CAS key `{repositoryId,headOid,manifestDigest}` 复用旧 success | 每次 provider baseOid 改变都重算 merge-base、affected paths 和 child gates | 两者都遵守现有 CAS 文本；现有 key 未含 baseOid、comparisonBaseOid 或 GateEvaluationContext digest |
| child evidence | 接受 `{gateId,headOid,conclusion,logRef}`，只要 command 成功即有效 | 要求 `{repositoryId,baseOid,headOid,comparisonBaseOid,manifestDigest,gateDefinitionDigest,producerRef,conclusion,evidenceDigest}` 且 producer 受信 | AD-28 只说 workflow 提交 child evidence、required gate 无有效证据时失败，没有定义 GateEvidenceV1、摘要、producer、freshness 和重放规则 |
| artifact binding 存储 | 每个 CI worker 在本地事务库对 artifactId 做 CAS；先写 Evidence，再写 binding | release evaluator 在共享数据库做 CAS；先写 binding，再写 Evidence | 两者都由 `packages/application/validation` evidence recorder 执行 append-only CAS；AD-18 未固定 CAS 的全局 authority/store，也未规定 binding 与 Evidence 必须同事务提交 |
| 相同 candidate 重放 | artifactId+candidateRefDigest 相同即幂等，保留首个 evidenceId/evidenceDigest | 只有完整 ValidationArtifactBindingV1 相等才算幂等；相同 candidate 但不同 evidenceId 视为冲突 | “相同候选重放幂等”没有说明比较键是否只到 candidate，还是包含 evidence identity |

### 可复现的不兼容轨迹

#### 轨迹 A：base 更新复用旧 success

1. PR headOid=H，provider baseOid=B1；merge-base=M1，Policy/Manifest=M，只有 gate G1 required。
2. Controller 发布 success，CAS key 为 `{repo,H,M}`。
3. 目标分支推进至 B2；新的 merge-base=M2，affected paths 增加命中 G2 的路径，但 headOid 和 manifestDigest 未变。
4. 实现 A 按既定 CAS key复用 success；实现 B 按新 GateEvaluationContext 重算并要求 G2。两个实现都逐字遵守 AD-28，却产生相反合并结论。

#### 轨迹 B：artifact binding 崩溃窗口

1. Evidence recorder 为 artifact X、candidate C 计算 Evidence E 和 Binding B。
2. A 先持久化 E，写 B 前崩溃；恢复后存在无 binding 的 Evidence。
3. B 先 CAS B，写 E 前崩溃；恢复后存在指向缺失 Evidence 的 binding。
4. AD-18 只有 append-only 与 artifactId CAS，没有同事务/prepare-commit/recovery 规则；A 可重试并接受，B 可把 artifact 永久占用并拒绝重试。

#### 轨迹 C：同一 Policy 的 slice 继承分歧

1. Policy 分别列出 alpha、beta、beta-plus 的 gate。
2. A 把每个列表解释为该 phase 的精确集合；B 把后续 slice 解释为累计超集。
3. 两个 compiler 都只读 Policy、registry、CandidateRef 并确定性生成 immutable Manifest；evaluator 都不改变 applicability。
4. 因 Spine 未固定 Policy 形状、继承/覆盖和普通 PR 的 phase 选择，两份 Manifest 均自洽但 gate 集不同。

## 残余阻塞发现

### 1. Controller CAS 未绑定 GateEvaluationContext，base 更新可复用陈旧结论

AD-28 已精确定义 GateEvaluationContextV1，却把 umbrella conclusion CAS 仅绑定 `{providerRepositoryId,headOid,manifestDigest}`。baseOid 或 comparisonBaseOid 改变时，affected paths 和 required gates 可以改变，而 CAS key 不变；“陈旧 head 不可复用”未覆盖“相同 head、陈旧 base”。

必须生成 `gateEvaluationContextDigest`，至少覆盖 providerRepositoryId、objectFormat、baseOid、headOid、comparisonBaseOid，并把它纳入 child evidence、Controller CAS key、umbrella conclusion 和 drift/retry 判定。

### 2. ReadinessGatePolicyV1 与 PR slice/phase 选择语义未固定

AD-30 赋予 compiler 唯一 applicability 权，却没有固定 Policy 的最小语义：slice/phase 列表是精确集还是继承集、冲突/重复如何处理、candidate kind/productVersion 如何选择 slice/phase。更直接的是，AD-28 要求每个 PR 的 Controller CAS 绑定 manifestDigest，但 CandidateRef 不携带 releaseSlice/gatePhase，compiler 的允许输入中也没有调用方选择参数。

必须固定 ReadinessGatePolicyV1 的封闭选择模型、继承/覆盖规则和 invalid 条件，并规定普通 PR 唯一使用的 policy target；或者把显式 `PolicyTargetV1={releaseSlice,gatePhase}` 纳入 compiler 输入、Manifest digest 和 GateEvaluationContext。

### 3. child evidence 没有共享合同，Controller 无法唯一判断“有效证据”

Repository workflow 只能提交 child evidence，但不存在 GateEvidenceV1 的封闭形状、digest、producer identity、command/gateDefinition binding、evaluation-context binding或 terminal 状态。Controller 唯一发布 umbrella 不能弥补输入证据可被不同实现解释的问题；旧 head/base 的成功记录或同名非权威 workflow 结果仍可能被聚合。

必须定义 ArchitectureGateEvidenceV1，并绑定 gateId/gateDefinitionDigest/command、GateEvaluationContext digest、manifestDigest、producerRef、conclusion、log/artifact digest 与 evidenceDigest；Controller 只接受注册 producer 对当前上下文生成的 terminal evidence。

### 4. ValidationArtifactBinding CAS 缺少全局 authority 与原子提交路径

“`packages/application/validation` 是唯一写入者”约束了代码模块，却没有约束多 CI 进程实例共享哪个线性一致 CAS authority。binding 又包含 evidenceId/evidenceDigest，但 AD-18 没有规定 Binding 与 Evidence 原子写入、崩溃恢复、孤儿记录处理及“同 candidate 重放”的精确等价键。两个 recorder 实例可以各自在本地 CAS 成功，或因写入顺序不同留下相反的不可恢复状态。

必须指定按 product/repository 作用域唯一的 durable binding store，由 recorder 通过单事务写入 Evidence+Binding；若基础设施不支持跨对象事务，则定义 prepare/committed 状态、幂等 requestId、恢复 owner 和 orphan 回收规则。幂等比较必须明确为完整 binding 相等，或规定 evidence replacement/supersede 状态机。

### 5. `git merge-base` 在多最佳共同祖先时不是唯一值

criss-cross merge 可产生多个 best merge bases。`git merge-base base head` 未使用 `--all`，不同 Git 实现/遍历顺序可能选择不同 OID，进而改变 diff 和 applicability。

必须规定多 merge-base 为 invalid/fail closed，或定义唯一虚拟 merge base 的构造和 digest；该结果同样进入 GateEvaluationContext digest。

## 非阻塞尾项

1. artifactId 的 SHA-256 文本编码仍未像 contentDigest/candidateRefDigest 一样显式限定为小写十六进制；建议统一。
2. LF normalization 对孤立 CR 的处理可由公共 canonical helper/contract test 固定，避免跨语言实现差异。
3. 同一 candidate/manifest 出现多份 ProductValidationResultV1 时的 supersede/final selection 仍建议显式状态化，但唯一 evaluator 已降低当前冲突风险。

## Gate 判定

CandidateRef/LockfileDigestV1 与 GateDefinitionV1 的直接身份分叉已关闭，Controller、compiler/evaluator 和 artifact binding 的职责方向也正确；但状态键、输入合同和原子 mutation path 尚未闭合。上述前四项仍允许两个逐字合规实现产生相反门禁结果或不一致持久状态，因此 Round 3 维持 **FAIL / NEEDS WORK**。
