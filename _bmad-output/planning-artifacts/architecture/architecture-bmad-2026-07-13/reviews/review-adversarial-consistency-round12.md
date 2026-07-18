---
title: Reviewer Gate — 第十二轮对抗性一致性最终复核
date: 2026-07-14
review_type: adversarial-consistency-round12
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十二轮对抗性一致性最终复核

## Verdict

**FAIL：机械 lint 为 0 finding；Round11 的 4 High/1 Medium 直接反例全部闭合，但交叉规则仍留下 2 个 high、2 个 medium。** 其中一项是 AD-7 与 AD-8 的明确状态冲突，另一项是 graph transaction 推进 findingsRevision 时仍未绑定 rules snapshot；其余是 ServiceStatus 多时钟排序和“空闲时的 Job 边界”语义。

## Round11 闭环验证

| Round11 finding | 结果 | 验证结论 |
| --- | --- | --- |
| H1 graph/findings mutation channel | CLOSED | AD-3/AD-8 已固定唯一 snapshot mutation channel、唯一 currentIndexJob，并为 findings-only evaluation 增加 baseGraphRevision 与 rules/config CAS。 |
| H2 graph+Findings 合成状态 | PARTIAL | 已选择 whole-snapshot 合成语义，但 freshness 与 completeness 被联动降级，和 AD-8 的 stale/complete 场景冲突，见 H1。 |
| H3 ServiceStatus telemetry | CLOSED | ServiceStatusV1、TelemetryStatusV1、service/status/statusChanged 权威和重连读取均已固定。 |
| H4 Job result revision | CLOSED | queued/running=null；terminal 指向结束时最新已提交 snapshot；只读 Job 指向实际目标 snapshot。 |
| M1 Git canonical commit ID | CLOSED | baseline identity 已固定 workspace/subroot、Git object-format 与完整 commit OID，别名只作显示。 |

## High Findings

### H1 — whole-snapshot 合成规则错误地把 stale 与 partial 绑定，直接冲突 AD-8

AD-7 当前规定：“任一 stale 或未完整评估即整体 stale/partial”；AD-8 同时规定，变更 Job 首次提交前取消保留旧 completeness，但已检测差异后不得恢复 current。

场景：旧 committed snapshot 为 `current/complete`；文件发生变化，freshness 立即 stale；增量 Job 在首次提交前取消。

**独立单元 A：AD-7 优先实现**

任何 stale 都强制 overall `stale/partial`。

**独立单元 B：AD-8 优先实现**

没有提交任何混合覆盖，旧 snapshot 的覆盖仍完整，因此返回 `stale/complete`。

两种状态都在 AD-7 的合法枚举/组合内，但没有实现能同时逐字满足两条转换规则。freshness 表示“是否对应当前输入”，completeness 表示“该 snapshot 的覆盖是否完整”，两者正交；旧完整快照过期正是 stale/complete 的必要场景。

**处理：必须收紧 AD-7/AD-8，不可 Deferred。** whole-snapshot 合成必须逐轴 worst-of：仅当 graph 与 Findings 均 current 时 overall freshness=current，否则 stale；仅当两者覆盖均 complete 时 overall completeness=complete，否则 partial。stale 不得自动推出 partial；保留 stale/complete，并明确 AD-8 首次提交前取消产生 stale/原 completeness，首次提交后未完成 reconciliation 才产生 stale/partial。

### H2 — graph transaction 推进 findingsRevision 时没有 rules/config snapshot CAS

AD-3 只要求 findings-only evaluation 绑定 `baseGraphRevision + rules/config digest`；普通 GraphPatch transaction 同时推进 graphRevision 与 findingsRevision，却只对分析 input manifest 做 CAS，AnalyzerConfigSnapshot 还明确排除 rules.yaml。

场景：长时间 indexing Job 使用 rules digest R1 计算 GraphPatch 与 Findings；运行期间 rules.yaml 改为 R2。

**独立单元 A：deferred-rules implementation**

把 R2 作为下一 snapshot mutation Job，允许当前 GraphPatch 以 R1 提交 `(graph=21,findings=31)`，随后再用 R2 重评估。

**独立单元 B：desired-rules CAS implementation**

规则文件变化立即更新 desired rules digest；当前 GraphPatch 在提交时因 R1≠R2 被丢弃并重新排队，只发布与 R2 一致的 revision。

两者都遵守唯一 mutation channel，因为分叉发生在 active Job 之外的文件变化何时成为“当前 rules snapshot”。A 会短暂发布已经不是当前仓库策略的 Findings；B 不会。当前 status/finding 合同也没有标明 revision 绑定 R1 还是 R2。

**处理：必须收紧 AD-3/AD-8/AD-9，不可 Deferred。** 任何推进 findingsRevision 的事务——包括 GraphPatch transaction——都必须携带并 CAS `baseGraphRevision/effectiveRulesDigest/rulesConfigGeneration`；rules.yaml 变化立即推进 desired generation、令整体 freshness stale，并使旧 generation 的待提交结果失效。事务提交后 Finding revision 必须记录实际 rules digest；CAS 失败则丢弃 findings/GraphPatch 并重排，不能发布旧策略的 current revision。

## Medium Findings

### M1 — ServiceStatusV1 有 statusRevision 与 configRevision 两个时钟，但未固定乱序合并规则

ServiceStatusV1 同时包含 `indexStatus.statusRevision` 与 `configRevision`。生成顺序为 S1=(status 11, config 5)，随后 S2=(status 11, config 6)；网络可能先交付 S2，再交付 S1。

**客户端 A** 采用 last-message-wins，会把 telemetry/config 从 revision 6 回滚到 5；**客户端 B** 独立比较两个 revision 并拒绝旧 component。两者都“直接消费”权威 ServiceStatusV1，但当前没有规定 whole-envelope ordering 或 component merge。

**处理：收紧 AD-7/AD-22。** 最小做法是在 ServiceStatusV1 增加每 indexing root 单调 `serviceStatusRevision`，任何 index、telemetry、config 或 viewConfig 可观察变化均推进；statusChanged 携带完整原子 snapshot，客户端只接受更高 revision，断档或重连调用 service/status。保留 component revisions 供审计，不再由客户端自行合并。

### M2 — “在 Job 边界应用”没有定义空闲服务是否已处于边界

当 effective telemetry=off 且没有 currentIndexJob 时收到 off→on：

**服务 A** 把 idle 视为立即可用边界，立刻启用；**服务 B** 等待下一个 mutation Job 结束后才启用，可能长期保持 pending。两者都符合“只有在 Job 边界实际启用”，但 UI 和自动化观察不同。

同样分叉适用于其他共享 reconfigure：一个实现空闲时立即应用，另一个等未来 Job。

**处理：收紧 AD-22。** Job 边界固定为“无 currentIndexJob 时立即；有 currentIndexJob 时在其 terminal 后、下一 Job dequeue 前”。在等待期间 requested/applied revision 保持分离；latest-wins 仍可取消 pending 变更。

## 已通过的新增攻击

- graph 与 findings-only Job 已不能合法并发推进共享 snapshot；currentIndexJob 唯一。
- Job cancelled/failed 的 result revision 已不能再在 base、null 与 latest committed 之间自行选择。
- 重连客户端已有 ServiceStatusV1 可读取 telemetry requested/effective/pending，不必从本地 setting 推断。
- Git branch/tag/短 SHA 已不能进入 baseline identity；完整 commit OID 唯一。
- include-source 仍受当前请求显式授权约束，没有被本轮修订削弱。

## 建议收敛顺序

1. 先把 freshness/completeness 改为逐轴合成，消除 AD-7/AD-8 的直接冲突。
2. 将 rules digest/generation CAS 扩展到所有推进 findingsRevision 的事务。
3. 给 ServiceStatusV1 增加单一 envelope revision。
4. 明确 idle 即 Job boundary，消除 pending reconfigure 的无限等待。

