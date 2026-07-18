---
title: Reviewer Gate — 第十四轮最终对抗一致性确认
date: 2026-07-14
review_type: adversarial-consistency-round14
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十四轮最终对抗一致性确认

## Verdict

**PASS：机械 lint 为 0 finding；未发现剩余 critical/high/medium。** Round13 的无效 rules generation 与 service instance epoch 已闭合；再次针对规则恢复、跨实例旧消息、逐轴状态、Job terminal snapshot、telemetry pending 和物化视图 patch 构造反例，均无法得到两个同时合规而结果不兼容的实现。

## Round13 闭环验证

| Round13 finding | 结果 | 验证结论 |
| --- | --- | --- |
| H1 无效 rules generation 阻塞 GraphPatch | CLOSED | RulesSnapshotRef 明确 generation/validity/effective/last-valid digest；无效 generation 可提交图谱但只能携带 stale Findings，禁止 resolved。 |
| M1 状态 revision 缺少实例 epoch | CLOSED | initialize、metadata 与 ServiceStatusV1 共享 serviceInstanceId/statusEpoch；计数仅在 epoch 内单调，epoch 改变强制替换状态并全量重取。 |

## 最终对抗矩阵

### 1. 无效规则期间源码继续变化

- GraphPatch 必须 CAS 完整 RulesSnapshotRef。
- invalid generation 保留最后有效 digest，允许 graphRevision 提交，同时推进 findingsRevision 并把旧 Findings 保持 stale。
- 阻塞图谱、按无效规则评估或把缺失 Finding 标记 resolved 均直接违反 AD-3/AD-9。

**结论：唯一。**

### 2. GraphPatch 计算期间规则从 invalid 恢复 valid

- rules.yaml 任意变化推进 generation。
- 使用旧 invalid generation 的待提交结果 CAS 失败并重排。
- 新事务只能绑定恢复后的完整 RulesSnapshotRef，成功完整评估后才可 resolved。

**结论：唯一。**

### 3. 服务重启后旧 ServiceStatus 延迟到达

- 新 initialize 返回不同 serviceInstanceId/statusEpoch。
- 客户端无条件替换旧 epoch 状态，不比较跨 epoch revision。
- 旧 epoch statusChanged 不能进入新 epoch 的单调序列；客户端只接受当前 epoch。

**结论：唯一。**

### 4. 服务重启后旧 GraphViewPatch 延迟到达

- epoch 改变已要求全量重取 GraphViewModel。
- 旧 patch 的 view/status 基线无法与新模型连续匹配，必须再次 invalidate/full-refetch，不能局部应用。
- graph/findings 持久 revision 即使相同，也不能绕过新的 view/status 身份。

**结论：唯一且故障安全。**

### 5. 旧完整快照已过期但没有任何部分提交

- graph freshness 因 manifest/input digest 不同而 stale。
- graph completeness 仍 complete；Findings 按其覆盖独立取值。
- 逐轴合成允许并要求 overall stale/complete；只有实际覆盖不完整才 partial。

**结论：唯一。**

### 6. 配置无效但上一有效 Findings 覆盖完整

- validity 变化使 Findings stale，不自动改变其历史覆盖 completeness。
- AD-9 要求保留全部上一有效 Findings；AD-7 明令 stale 不推出 partial。
- 因此上一评估完整时是 stale/complete，上一评估原本不完整时才 stale/partial。

**结论：唯一。**

### 7. telemetry pending-on、空闲/活动 Job 与后续 off

- idle 时配置立即应用；活动 Job 时在 terminal 后、下一 dequeue 前应用。
- pending-on 仅在 requestedConfigRevision 仍最新时启用。
- 任意 off 都立即取消旧 pending-on、切 Noop、清缓冲并广播新 config/service status revision。

**结论：唯一且隐私安全。**

### 8. Job 部分提交后 cancelled/failed

- queued/running result pair 必须 null。
- terminal result 固定为结束时最新已提交 snapshot；无提交才等于 base。
- state 表达成功性，result revision 不得被解释为“只有 succeeded 才存在”。

**结论：唯一。**

### 9. GraphViewModel 在预算/ranking 变化后更新

- queryFingerprint 绑定全部结果形状参数与 viewConfigRevision。
- delta 是两个物化视图的精确差量并原子应用；无法精确生成只能 invalidate。
- graph/findings/status 任一基线断档均全量重取，不能投递底层 GraphPatch 摘要替代视图 delta。

**结论：唯一。**

### 10. Git branch/tag/短 SHA 指向同一 commit

- baseline identity 只使用 workspace/subroot、object-format 和完整 commit OID。
- 用户输入 ref 仅为显示元数据，不进入 baselineId。
- IDE、CLI 和导出对同一 commit 得到同一 baseline identity。

**结论：唯一。**

## 可留给代码权威的细节

以下内容不会再让下一级单元作出语义不兼容选择，可由 `packages/contracts`、`packages/domain` 和契约测试成为权威，无需继续膨胀脊柱：

- serviceInstanceId/statusEpoch 的具体 UUID/随机字节编码；
- status/config/rules generation 的整数位宽与数据库列名；
- DTO 属性的排列顺序和 TypeScript 文件名；
- stale Finding 的具体文案、图标及诊断排序；
- delta 操作数组的内部编码，只要满足精确物化差量与原子应用合同。

## Gate 结论

Round14 对抗一致性 lens **PASS**。当前 ARCHITECTURE-SPINE.md 已能阻止所审查接缝上的两个独立实现产生不兼容共享状态或结果；无需新增 AD、改变范式或更换技术栈。

