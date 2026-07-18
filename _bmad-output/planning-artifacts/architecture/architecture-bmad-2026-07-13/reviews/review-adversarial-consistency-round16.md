---
title: Reviewer Gate — 第十六轮 Adversarial Consistency 最终审查
date: 2026-07-14
review_type: adversarial-consistency-round16
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — 第十六轮 Adversarial Consistency 最终审查

## Verdict

**FAIL：机械 lint 为 0 finding；剩余 1 个 high，未发现 critical/medium。** Round15 的 epoch-bound GraphView patch 与启动规则扫描屏障均已写入 AD；本轮独立复核只在“启动扫描与 watcher 注册之间是否无丢失”这一 TOCTOU 接缝上构造出两个严格合规却不兼容的实现。

## Round15 闭环验证

| Round15 finding | 结果 | 验证结论 |
| --- | --- | --- |
| H1 GraphView epoch 绑定 | CLOSED | GraphViewModel、delta、invalidate 均携带 serviceInstanceId/statusEpoch；epoch 变化旋转 viewId、清空待处理 patch 并全量重取。 |
| H2 启动规则扫描屏障 | PARTIAL | starting 阶段已要求先读取 rules/ignore/manifests 并建立初始 RulesSnapshotRef，再进入 running；但 watcher 注册与扫描的相对顺序及扫描期间事件合并尚未固定，见 H1。 |

## High Finding

### H1 — 启动快照没有固定 watcher-first/reconciliation barrier，扫描窗口内的配置变化可永久丢失

AD-23 要求 lifecycle=starting 时先读取并校验 rules.yaml、codegraphignore 与 workspace manifests，建立启动快照后才进入 running；AD-8 规定 watcher 事件只是候选，服务恢复触发 reconciliation scan。两条规则都没有固定 watcher 注册发生在启动扫描之前还是之后，也没有要求扫描结束后合并扫描期间事件。

场景：仓库启动时 rules.yaml 为 R1。服务完成读取 R1 后、进入 running 前，用户将其改为 R2。

**实现 A：watcher-first bootstrap**

先注册 watcher，再执行全量启动扫描；扫描期间的 R1→R2 事件被缓存，扫描后合并并重新读取，初始可运行 RulesSnapshotRef 为 R2。

**实现 B：scan-first bootstrap**

先读取/校验 R1 并建立启动快照，然后注册 watcher并进入 running；R1→R2 发生在 watcher 注册前，不产生候选。首次 GraphPatch 对服务内“当前 manifest/RulesSnapshotRef”CAS 成功，可能长期按 R1 运行，直到另一次文件变化或手动 rebuild。

两者都逐字满足“starting 先建立快照再 running”、文件事件仅为候选、GraphPatch 提交前与服务当前 manifest/RulesSnapshotRef CAS；B 的问题是所谓“当前”状态已经漏掉文件系统变化。相同窗口也影响 codegraphignore 与 workspace manifests，可导致错误索引范围、错误 package 边界和错误 Findings，而不仅是短暂多一个 revision。

**处理：必须收紧 AD-8/AD-23，不可 Deferred。** 启动屏障固定为：取得锁/迁移后先注册 source/config/manifest watchers，再执行全量 reconciliation scan；扫描期间事件必须缓存、按路径合并并重新读取，直到 watcher generation 与扫描 manifest 在同一 bootstrapGeneration 上收敛。只有收敛后的 ManifestSnapshot、AnalyzerConfigSnapshot 和 RulesSnapshotRef 原子建立后才能进入 running/dequeue；首个 mutation Job及其提交 CAS 还必须绑定 bootstrapGeneration，任何新事件都会使其失效并重排。

## 其他对抗结果

以下接缝未再发现 critical/high/medium：

- RulesSnapshotRef 的空策略、首次无效配置、恢复有效配置与 GraphPatch CAS；
- graph/findings 唯一 snapshot mutation channel 及 terminal Job snapshot；
- ServiceStatus 总 revision、service epoch 与跨 epoch status/patch 丢弃；
- graph+Findings freshness/completeness 逐轴合成；
- telemetry requested/effective/latest-wins 与 idle 应用边界；
- WorkspaceDiscoverySummary、NavigationTarget、FindingSummary、external entity、ExportArtifact/Preview；
- Git baseline identity、CLI 双 revision 和物化 GraphView delta。

## Gate 结论

Round16 仅剩启动快照的 watcher/reconciliation 无丢失屏障。除该项外，当前脊柱已不能再构造出两个严格遵守全部 AD 却在共享数据、owner、mutation channel、epoch/patch 或规则快照上不兼容的实现。

