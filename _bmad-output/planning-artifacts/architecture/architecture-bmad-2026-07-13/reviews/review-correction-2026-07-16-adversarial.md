# Reviewer Gate — 2026-07-16 纠偏后的对抗一致性审查

## 审查结论

**FAIL / NEEDS WORK。** `ARCHITECTURE-SPINE.md` 的机械 lint 为 0 finding，但 AD-18、AD-28、AD-30 仍没有封闭跨实现共享身份、摘要输入域、唯一所有权和状态推进路径。下面两个下一层实现单元可以逐字遵守全部 AD，却无法交换 artifact、验证证据或 CI 门禁状态；在更坏情况下，它们会对同一发布候选给出相反的 Go/No-Go 结论。

审查对象：`../ARCHITECTURE-SPINE.md`  
纠偏依据：`../../../sprint-change-proposal-2026-07-16.md`  
伴随核对：`../IMPLEMENTATION-GUIDE.md`  
限制：本次只审查并写本报告，未修改上述两份架构文档。

## 两个逐字合规但不兼容的下一层实现单元

| 决策点 | 实现单元 A：仓库侧 Build / Export Orchestrator | 实现单元 B：外部 Validation / Release Controller | 为什么都没有违反现有 AD |
| --- | --- | --- | --- |
| `architecture-required` | 始终运行的唯一 provider required check；读取 `quality-gates.v1.yaml`，聚合所有适用 gate 后发布一个结论 | 保留 Story 1.1 的最小 `architecture-required`；把 manifest 中每个 `blocking=true` 的 `checkId` 同步成额外 provider required check | AD-28 既要求 provider 强制 `architecture-required`，又称 manifest 是 blocking gate 唯一清单，但没有规定 manifest gate 必须只由 umbrella 聚合，还是必须逐项成为 provider required check |
| gate 适用性 | `triggerPaths` 使用 minimatch，比较 PR merge-base 到 head 的最终路径；不适用 gate 记 success | `triggerPaths` 使用 gitignore/pathspec，比较 base/head 两棵树并同时匹配 rename 的旧/新路径；不适用 gate 不发布 check | 两者都使用 manifest 的“触发路径”并让适用 gate 阻断；AD-28 未固定 glob 方言、diff 基线、rename/delete 语义及“不适用”状态 |
| `candidateRef` | 采用 AD-29 的 `ReleaseSetManifestV1.releaseSetId` | 采用 AD-29 的 `sourceCommit` 完整 OID | 两者都是稳定候选引用；AD-30 和 Release evidence convention 只要求“绑定/匹配 candidateRef”，未规定候选的规范身份、类型或与 AD-29 哪个 digest/ID 等价 |
| Plan / Manifest digest | 删除自身 digest 字段后，对 RFC 8785 JCS bytes 做 SHA-256；`planRef/evidenceRefs` 同时携带被引用对象 digest | 对仓库中原始 UTF-8 JSON/YAML bytes（规范 LF）做 SHA-256；`planRef/evidenceRefs` 只携带稳定 ID 和 version | AD-30 只写 `digest`、`manifestDigest` 和稳定 ID，没有固定算法、规范化、排除字段、输入域，也没有要求引用必须携带内容 digest |
| Export identity | `contentDigest` 覆盖 StructureContextExportV1 的 JCS payload，`artifactId=export:<contentDigest>` | `contentDigest` 覆盖最终 Markdown/JSON 输出原始 bytes，`artifactId` 为随机 UUID | AD-18 只要求这些字段存在且目标重试不改变内容/身份；没有固定 digest 的算法/输入域、artifactId 公式、同输入重生成是否同 ID |
| Export 与候选绑定 | 以外部映射把 artifact 绑定到 `releaseSetId` | Evidence 直接声明 `candidateRef=sourceCommit` 并引用 artifactId | ExportArtifactV1 本身没有 candidateRef、sourceCommit、releaseSetId、producer/toolchain digest；AD-30 只校验 Evidence/Result 自己的 candidateRef，无法证明 artifact 来自该候选 |

合并时会发生三类确定性冲突：A 的 manifest/evidence 会因 B 的 candidateRef 与 digest 规则被判 invalid；B 同步出的逐项 required checks 在 A 的“不适用 gate 记 success”模型外可能永久 pending；同一 ExportArtifactV1 在两套 digest/identity 规则下无法复核，且可被重新标注为另一候选的证据。所有冲突都来自架构未决定的共享语义，而不是实现违反 AD。

## 最高优先级发现

### 1. `candidateRef` 不是规范身份，AD-29 与 AD-30 之间存在断链

AD-29 同时提供 `sourceCommit`、`payloadRootDigest`、`releaseSetId` 等候选身份材料；AD-30 只要求 Plan、Manifest、Evidence、Result “具有/匹配 candidateRef”，未规定其封闭形状和唯一取值。实现 A 选择 releaseSetId、实现 B 选择 sourceCommit 均合规，但对象无法 join；更严重的是，只要 Evidence 内部字符串自洽，旧 artifact 或旧证据就能被标注到新候选。`ARCHITECTURE-SPINE.md:261` 的“ReleaseArtifactManifestV1 绑定 candidateRef”也没有给出可机器执行的绑定公式。

需要收紧为一个唯一 `CandidateRefV1`：明确它引用 `releaseSetId`、`sourceCommit` 还是带二者和 artifact root 的封闭对象；规定生成 owner、规范编码、比较规则，并要求 Plan/Manifest/Evidence/Result/Export 或其 provenance 全部携带同一不可转述引用。

### 2. AD-30 只有“有 digest”，没有 digest 算法、输入域和不可变引用链

`manifestDigest`、fixture/task digest、Evidence/Result 的 `digest` 没有固定 RFC 8785/JCS、UTF-8、SHA-256、大小写、数组排序、是否删除自身字段、Schema/plan/fixture/ground-truth 哪些内容进入摘要。`planRef` 和 `evidenceRefs` 也未要求携带被引用对象 digest。于是同一个逻辑 manifest 可产生不同 digest；同一 `planId+planVersion` 下的对象还可被替换而不使既有 Evidence/Result 自动 invalid。

需要固定每类对象的 digest profile 与输入域，并建立不可变链：Manifest → 精确 Plan digest；Evidence → candidateRef + planDigest + task/fixture/groundTruth digests；Result → manifestDigest + 有序 evidence digests + runner/schema version。所有引用必须是 ID+digest，不能只靠可变 ID/version。

### 3. AD-18 的 ExportArtifactV1 不能被独立验证，也没有绑定生成候选

AD-18 没有规定 `contentDigest` 覆盖结构 payload、渲染后 bytes 还是整个 envelope，也没有规定序列化/哈希算法和 `artifactId` 公式；`complete` 还可同时容纳 `truncation`，但没有说明价值验证是否允许“完整生成的截断 artifact”。目标重试的不可变性只保护单次 artifact，不能让另一单元复核它，更不能证明 SM-8/UJ-5 Evidence 引用的 artifact 由当前 candidateRef、当前服务二进制和当前 graph/findings snapshot 生成。

需要固定 ExportArtifactV1 的封闭 Schema、payload/content 字段、digest profile、artifactId 派生与 complete/truncation 语义；再通过内嵌 `candidateRef` 或不可变 provenance digest 把 artifactId/contentDigest/revisions/policy 绑定到 AD-30 的证据链。

### 4. AD-28 没有指定 umbrella check、manifest 与 provider ruleset 的唯一所有权关系

Story 1.1 的稳定 check、Story 1.3 的 manifest、仓库内 sync/verify、外部 drift monitor 都能改变或判定“哪些 check 阻断合并”，但 AD-28 没有指定谁是 provider desired-state 的唯一生成者，`architecture-required` 是所有 gate 的唯一聚合结论还是仅最小基线，也没有规定 Story 1.1→1.3 切换时的原子迁移。A 只要求 umbrella，B 要求 umbrella+逐项 check 均合规；一旦 path-filtered check 未发布，B 会永久阻塞，而 A 会成功。

需要固定单写者和状态机：manifest 是唯一 desired-state；一个明确 owner 原子计算 provider ruleset；drift monitor 只读不修复；`architecture-required` 要么唯一聚合全部适用 gate，要么明确列出逐项 required-check 规则，禁止两种模型并存。

### 5. AD-28 的 `triggerPaths` 不足以产生唯一“适用 gate 集合”

Guide 增加了“触发路径”，但 Spine 未固定字段形状、glob 方言、base/head 或 merge-base、rename/delete、配置/Schema 变更、空匹配以及 skipped/pending/success 的语义。同一 PR 在 A 中适用并 success，在 B 中可能不适用且不发布 check；当 provider 要求该 check 时，CI 状态不可收敛。

需要定义版本化 `GateApplicabilityV1`，使输入 diff、路径规范化、pattern 语法、求值顺序和不适用结论唯一，并要求 umbrella/provider controller 消费同一求值结果。

## 其余对抗发现

1. AD-30 没有指定 Plan、Manifest、Evidence、Result 的唯一 owner、不可变发布点或 CAS；Release Owner 与 Test Owner 可以用同一稳定 ID/version 发布不同内容。
2. ProductValidationEvidenceV1 / ProductValidationResultV1 只被命名为“唯一格式”，但 Spine 没有固定最小共享字段、状态枚举、聚合输入和结果 ID；两个封闭 Schema 会直接互拒，`additionalProperties:false` 使兼容余地更小。
3. 没有规定同一 candidateRef 出现多份 Result 时选择哪一份，也没有 supersede/retest 状态转移；旧 pass 与新 fail 可同时存在。
4. `evidenceRefs` 没有固定排序、去重和负面/invalid 样本是否必须进入 Result digest，可能出现同证据集合不同结果身份，或通过省略失败证据得到 pass。
5. Story 1.1→1.3 没有“不降低保护”的迁移 CAS：manifest、workflow 与 provider ruleset 分步更新时，可短暂存在 provider 只要求旧最小 check、而完整 gate 尚未被聚合的窗口。
6. ExportArtifactV1 未明确生成 owner 对 `artifactStatus` 的状态机；服务只返回 complete 虽避免线协议 partial，但 CLI/extension 可各自建同名 wrapper 并对“上一份有效结果”与当前失败状态采用不同身份模型。

## Gate 判定

当前架构不能证明两个下一层单元会共享同一 candidate、同一 digest、同一 artifact 或同一 blocking gate 集合。上述前四项属于下游实现前的阻塞性架构缺口；在收紧前，不应把 AD-18/28/30 视为已经通过对抗一致性 Reviewer Gate。

机械检查：`lint_spine.py` 返回 `ok=true, total_findings=0`；这只证明格式完整，不改变本报告的语义 FAIL。
