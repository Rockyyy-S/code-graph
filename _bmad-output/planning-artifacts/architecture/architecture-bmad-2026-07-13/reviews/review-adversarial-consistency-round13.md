---
title: Reviewer Gate — 第十三轮对抗性一致性最终复核
date: 2026-07-14
review_type: adversarial-consistency-round13
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十三轮对抗性一致性最终复核

## Verdict

**FAIL：机械 lint 为 0 finding；Round12 的 2 High/2 Medium 全部闭合，异常路径复测仍剩 1 个 high、1 个 medium。** 主状态机、patch、双 revision、telemetry 和 Job 语义已经收敛；剩余问题仅为“无效 rules generation 是否阻塞图谱提交”以及服务重启后的内存 revision epoch。

## Round12 闭环验证

| Round12 finding | 结果 | 验证结论 |
| --- | --- | --- |
| H1 stale/complete 逐轴合成 | CLOSED | freshness 与 completeness 已分别 worst-of；stale 不再推出 partial，首次提交前取消可唯一得到 stale/原 completeness。 |
| H2 所有 findingsRevision 事务的 rules CAS | CLOSED | GraphPatch 与 findings-only transaction 均绑定 baseGraphRevision、effectiveRulesDigest、rulesConfigGeneration，旧 generation 结果失效。 |
| M1 ServiceStatus 总排序 | CLOSED | ServiceStatusV1 已有 serviceStatusRevision；全部组件变化推进，statusChanged 为原子全量快照，客户端只接收更高 revision。 |
| M2 idle 配置应用 | CLOSED | 无 currentIndexJob 立即应用；有活动 Job 则在 terminal 后、下一 dequeue 前应用，requested/applied 保持分离。 |

## High Finding

### H1 — 无效 rules generation 下，GraphPatch transaction 没有唯一可提交的规则快照

AD-3 要求任何推进 findingsRevision 的事务 CAS `effectiveRulesDigest + rulesConfigGeneration`；rules.yaml 变化立即推进 desired generation。AD-9 又规定配置无效时保留上一有效 Findings 并标记 stale，但没有说明图谱更新是否继续。

场景：有效规则 R1/generation 7；用户保存无效 rules.yaml，desired generation 变为 8，没有新的有效 digest；随后源码变化产生 GraphPatch。

**独立单元 A：strict-generation implementation**

认为 generation 8 没有可用 effectiveRulesDigest，所有同时推进 findingsRevision 的 GraphPatch 都 CAS 失败；在规则修复前图谱不能提交。

**独立单元 B：last-valid implementation**

使用 `effectiveRulesDigest=R1 + rulesConfigGeneration=8 + validity=invalid` 提交图谱，推进 findingsRevision并把上一有效 Findings 继续标记 stale；图谱索引不被规则语法错误阻断。

两者都能满足“旧 generation 结果失效”和“无效配置保留 stale Findings”，但一个会令普通 TS/JS 图谱无限 stale，另一个继续更新 graphRevision。当前合同没有表示 invalid generation 与 last-valid effective digest 的组合，CAS 语义不唯一。

**处理：必须收紧 AD-3/AD-9，不可 Deferred。** 定义 `RulesSnapshotRef={generation,validity:valid|invalid,effectiveRulesDigest,lastValidRulesDigest}`；无效配置推进 generation，但 effective/lastValid digest 保持最后有效值。无效 generation 不得阻塞 GraphPatch：图谱事务 CAS 当前 RulesSnapshotRef 后可提交 graphRevision，同时推进 findingsRevision、保留旧 Findings 为 stale且禁止 resolve；恢复有效配置后再完整重评估。

## Medium Finding

### M1 — serviceStatusRevision/statusRevision 缺少服务实例 epoch，重启后可永久被旧客户端拒绝

serviceStatusRevision 与 statusRevision 被定义为单调，但没有规定它们持久化到 SQLite，还是每个 graph-service 进程从 0 重启。

**独立单元 A：ephemeral counters**

旧服务最后状态 revision=120；新服务重启后从 1 开始。重连客户端遵守“只接受更高 revision”，因此拒绝新 service/status。

**独立单元 B：persistent counters**

把状态 counters 写入缓存并从 121 继续，客户端接受。两者都符合“单调”常见解释，却导致不同持久化成本和重连行为；随机 IPC token 能认证实例，但当前没有作为公共状态 revision namespace 使用。

**处理：收紧 AD-7/AD-23。** ServiceStatusV1 与 initialize handshake 增加非秘密 `serviceInstanceId/statusEpoch`，每次 graph-service 启动生成新值；serviceStatusRevision/statusRevision 只要求在同一 epoch 内单调。客户端发现 epoch 改变时无条件替换本地状态并重取 GraphViewModel，不比较旧 epoch 的计数；无需持久化这两个内存状态 counters。

## 已通过的最终攻击

- GraphPatch 与 findings-only evaluation 已不能合法越过 graph/rules generation CAS。
- stale/complete、stale/partial 与 current/complete 的转换现在正交且唯一。
- ServiceStatus 消息乱序不能再回滚 index 或 telemetry/config 状态。
- 空闲服务上的 pending reconfigure 不能再无限等待未来 Job。
- Job terminal result、Git baseline identity、源码导出授权和 node-builtin 投影保持闭合。

## 建议收敛顺序

1. 给 rules snapshot 增加 validity 与 lastValid digest，明确 invalid config 不阻塞 GraphPatch。
2. 给内存状态 revisions 增加 service instance epoch，完成重启语义。

