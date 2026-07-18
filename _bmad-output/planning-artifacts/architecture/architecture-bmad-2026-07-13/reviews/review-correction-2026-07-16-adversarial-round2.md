# Reviewer Gate Round 2 — 2026-07-16 纠偏架构对抗复审

## 结论

**FAIL / NEEDS WORK，但 Round 1 的主要分叉已大幅关闭。** 更新后的 AD-18、AD-28、AD-30 已固定 CandidateRefV1 联合、Plan/Manifest/Evidence/Result 的 JCS digest 链、Export content/artifact 哈希公式、umbrella always-run、子 gate applicability 和 provider ruleset owner。机械 lint 仍为 0 finding。

复审继续构造两个下一层实现单元后，仍找到四个可逐字遵守现有 AD、却会产生不同 candidate、gate definition、check identity 或 artifact-candidate 绑定结果的场景。因此尚不能给出语义 PASS。

审查对象：`../ARCHITECTURE-SPINE.md`  
伴随核对：`../IMPLEMENTATION-GUIDE.md`  
Round 1：`review-correction-2026-07-16-adversarial.md`  
限制：只审查并生成本报告，未修改 Spine 或 Guide。

## Round 1 问题关闭情况

| Round 1 攻击面 | Round 2 判定 | 已新增的收敛约束 |
| --- | --- | --- |
| sourceCommit 与 releaseSetId 任意充当 candidateRef | 基本关闭 | CandidateRefV1 成为 source/release-set 封闭联合，release phase 只接受 release-set，candidateRefDigest 使用 JCS SHA-256 |
| Plan→Manifest→Evidence→Result 只有名称、没有 digest 链 | 基本关闭 | 四类对象均定义自省略 digest 的 JCS SHA-256；planRef 和 evidence digest 集合被逐段绑定 |
| Export contentDigest / artifactId 任意实现 | 基本关闭 | JSON 与 Markdown/text 字节规范、contentDigest 和 artifactId 输入域均已固定 |
| umbrella 与逐项 provider required check 并存 | 关闭 | provider 只强制 always-run `architecture-required`；子 gate 只产生 required/not-applicable/invalid |
| triggerPaths 方言、rename/delete、不适用状态任意 | 基本关闭 | 复用 AD-14 POSIX glob、禁止反选、新旧路径并集、删除取旧路径、缺省 always applicable、异常 fail closed |
| provider ruleset 无唯一 owner | 基本关闭 | release/platform owner 持有仓库外 ruleset 与 drift monitor，仓库内 sync/verify 只快速检测 |

## 两个仍可逐字合规但不兼容的实现单元

| 决策点 | 实现单元 A：Repository Actions / Export Producer | 实现单元 B：External CI / Release Validator | 为什么二者仍可声称遵守全部 AD |
| --- | --- | --- | --- |
| source CandidateRef 的 `lockfileDigest` | 对锁文件原始 bytes 做 SHA-256 | 解析锁文件后，对规范 dependency tuples 做 JCS SHA-256 | AD-30 固定 CandidateRefV1 包含 lockfileDigest，却未固定该 digest 的算法、输入域和多 lockfile 选择；AD-29 也只列字段 |
| `gateDefinitionDigest` | 对解析并默认值显式化后的单个 gate 对象做 JCS SHA-256 | 对 `quality-gates.v1.yaml` 中该 gate 的规范 LF 原始片段做 SHA-256 | AD-28/30 要求 digest 匹配，但未定义 gateDefinitionDigest profile、输入字段、默认值、排序和自身版本 |
| required check 身份 | provider ruleset 绑定 check name=`architecture-required` 与仓库 Actions app；repo workflow 是唯一结论发布者 | provider ruleset 只绑定同名 check；外部 CI app 也可发布该 check，drift monitor 认为名称存在即一致 | AD-28 固定了 ruleset owner，但没有固定 umbrella conclusion 的唯一 producer、provider app/workflow identity 或 provenance digest |
| artifact→candidate 唯一绑定 | Export producer 维护 artifactId→candidateRefDigest 首写不可改注册表 | Validation runner 只验证单份 Evidence 同时含 artifactId/contentDigest/candidateRefDigest；不同 runner 可分别接受同一 artifactId 对应不同 candidate | AD-18 规定“禁止重新标注”，但 artifactId 公式不含 candidateRefDigest，也未指定绑定记录的唯一 owner、持久化位置、CAS 或跨 runner 查询协议 |
| PR diff 的 `base` | 使用 PR merge-base 与 head | 使用 provider event 的当前 base SHA 与 head | AD-28 写的是 base-to-head diff，但未把 base 固定为 merge-base、事件 base SHA 或目标分支 tip；目标分支推进后两者可得到不同 affected paths |

### 不兼容结果

1. A 与 B 对同一 source commit 生成不同 lockfileDigest，继而得到不同 candidateRefDigest；Plan、Manifest、Evidence、Result 会互判 invalid。
2. A 生成的 gateDefinitionDigest 无法被 B 的 release manifest 或 gate runner匹配，同一 gate 在一侧 required、另一侧 invalid/fail closed。
3. 同名 `architecture-required` 可由不同 producer 发布；一套 provider 配置接受外部成功结论，另一套只接受仓库 Actions app，drift 判定与合并结果相反。
4. 两个 runner 可各自在本地首次观察同一 artifactId，并分别绑定不同 candidateRefDigest；每个 runner 都没有执行“重新标注”，但合并证据集违反全局唯一绑定。
5. base 分歧使 rename、目标分支新增提交或长寿命 PR 的 affected paths 不同，子 gate 可在 A 为 required、在 B 为 not-applicable。

## 残余最高优先级发现

### 1. `lockfileDigest` 未规范化，CandidateRefV1 仍可分叉

CandidateRefV1 的外层 JCS/hash 已唯一，但 source 分支把一个未定义的 `lockfileDigest` 字符串纳入身份；releaseSetId 同样继承 AD-29 的 lockfileDigest。原始文件 digest、规范依赖图 digest、单一根 lockfile、多 workspace lockfiles 都是合理实现。外层 candidateRefDigest 只会稳定地放大该分歧。

需要固定 LockfileSnapshotV1：选择规则、相对路径、每文件 bytes digest、排序、多锁文件与缺失状态，再对封闭对象执行统一 JCS SHA-256。

### 2. `gateDefinitionDigest` 没有 digest profile，AD-28 与 AD-30 的 gate join 仍不唯一

注册表 gate 与 ReadinessGateManifestV1 必须靠 gateId、command、gateDefinitionDigest 相等才能 join，但 gateDefinitionDigest 的输入域、默认值、触发路径排序、command 表示、Schema/version 和 hash 编码没有定义。这正是两个独立 CI 单元最容易各自实现的共享形状。

需要定义 GateDefinitionV1 的封闭对象和唯一 canonical digest helper，并明确 digest 是否包含 gateId/checkId、triggerPaths、command、capabilityOwner、blocking、schemaVersion 及默认值。

### 3. CI owner 只覆盖 provider ruleset，没有覆盖 `architecture-required` 结论发布权

release/platform owner 已独占外部 ruleset，但 AD-28 未规定哪个 app/workflow 是 umbrella check 的唯一 producer，也未要求 provider 绑定 producer identity。只凭同名 check 可被另一 workflow/app 发布成功结论；不同 provider/plan 对“同名但不同 producer”的 required check 匹配规则也可能不同。

需要固定 CheckProducerRefV1（provider、repository、app/integration ID、workflow identity/version）并进入 ruleset desired-state、drift evidence 和 umbrella check provenance；只有该 producer 的结论可满足 required check。

### 4. ExportArtifactV1 的候选绑定是禁止性语句，不是可执行的单写者状态

Export 的 contentDigest 和 artifactId 已唯一，但 artifactId 明确不包含 candidateRefDigest。Evidence 同时引用三者只能证明一份 Evidence 内字段齐全，不能证明此前没有其他 Evidence 把同一 artifactId 绑定到不同候选。缺少唯一 owner/注册表/CAS 时，两个 runner 各自首次绑定都能逐字自证“没有重新标注”。

需要由唯一 owner 生成不可变 ArtifactCandidateBindingV1，键为 artifactId、值为 candidateRefDigest/contentDigest/provenanceDigest；首次创建使用 create-if-absent CAS，冲突 fail closed。另一选择是把 candidateRefDigest 纳入 artifact identity，但必须先解决 source→release-set 阶段转换语义。

### 5. `base-to-head` 的 base 未定义为规范 Git 身份

现有文本已固定 old/new path union，但没有固定 base 是 merge-base、PR 事件 base SHA 还是目标分支当前 tip。长寿命 PR 或 base branch 推进后，三个值可不同，直接改变 triggerPaths 适用集合。

需要定义 GateDiffRefV1，至少包含 repository identity、object format、完整 base/head OID，并明确 base 的求法及重算时机；所有 applicability、evidence 和 check conclusion 引用其 digest。

## 其他残余风险

1. Manifest 先包含 evidenceRefs，而 Evidence 又必须引用 manifestDigest；需要明确 evidenceId 是预分配稳定 ID，并固定 Manifest freeze → Evidence collect → Result aggregate 的唯一状态机，否则实现可能以草稿回写或反复重发 Manifest。
2. 同一 candidateRef/manifestDigest 出现多个 ProductValidationResultV1 时，没有固定 latest、supersedes、retest 或最终结果选择规则；唯一生成者降低了冲突概率，但未定义 release gate 应消费哪一份。
3. artifactId 的 SHA-256 输出表示未像 contentDigest/candidateRefDigest 一样显式写“小写十六进制”；实现若选择 base64url 或大写 hex，仍可能产生线协议差异。

## Gate 判定

Round 1 的核心设计方向正确，约束覆盖明显增强；但上述前四项仍能让两个下一层单元在完全不绕过 AD 的情况下互判 invalid、接受不同 required check，或形成冲突 artifact binding。Round 2 维持 **FAIL / NEEDS WORK**，建议再收紧 LockfileSnapshotV1、GateDefinitionV1、CheckProducerRefV1 和 ArtifactCandidateBindingV1 后复审。

机械检查：`lint_spine.py` 返回 `ok=true, total_findings=0`；主文档未被本审查修改。
