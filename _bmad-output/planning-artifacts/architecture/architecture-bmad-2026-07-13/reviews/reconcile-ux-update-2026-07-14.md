---
title: UX 更新 → Architecture 独立对账
date: 2026-07-14
review_type: input-reconciliation
verdict: pass
status: complete
revalidated: 2026-07-14
reviewed:
  - ../../../ux-designs/ux-bmad-2026-07-13/DESIGN.md
  - ../../../ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md
  - ../../../ux-designs/ux-bmad-2026-07-13/reconcile-prd.md
  - ../ARCHITECTURE-SPINE.md
  - ../IMPLEMENTATION-GUIDE.md
---

# UX 更新 → Architecture 独立对账

## 结论

**结论：PASS。** 四项原 high/medium 发现均已闭合，未发现剩余 high/medium UX → Architecture 跨边界差异。修订保持了 `GraphNode` 的四类 UX 实体，同时通过 `NavigationTargetV1` 支持 symbol 跳转，没有把 symbol 或 aggregate 扩充为第五种图节点。

当前架构已经为状态/索引摘要、Finding/配置诊断、导出预览和发布阶段提供了足以约束 `graph-service`、`contracts`、`extension`、`webview` 与 CLI 的公共语义。无需更换架构范式或技术栈。

## 重点覆盖矩阵

| 检查项 | 结果 | 对账结论 |
| --- | --- | --- |
| `GraphNode` 类型与跳转 | PASS | `AD-7` 与实施说明固定 `file / directory / workspace-package / external-package`；聚合是独立属性。`NavigationTargetV1` 以 `file / directory / symbol` 跳转目标支持 symbol range，不改变 UX 节点类型。 |
| workspace package / monorepo degraded | PASS | `AD-5`、`AD-7` 与 `WorkspaceDiscoverySummary` 固定 `single / recognized / degraded`；降级时不生成 package 节点和聚合结论，但继续文件/目录索引。 |
| `StatusBanner` cancelled / idle | PASS | `cancelled` 属于 Job、`idle` 为派生展示；`IndexStatusSummaryV1` 固定 current/last Job、phase、progress、完成范围、时间和取消原因。 |
| `IndexSummary` 缓存保留 | PASS | `CommittedIndexSummaryV1` 独立描述已提交缓存的双 revision、生成时间、计数、排除摘要、freshness 与 completeness；取消不清空缓存。 |
| `FindingRow` | PASS | `FindingSummaryV1` 与 `ConfigDiagnosticV1` 固定稳定身份、证据 subject、期望约束、位置、时间、比较状态及配置修复字段。 |
| Telemetry off/on | PASS | `AD-16`、`AD-22` 和实施说明明确 `on → off` 立即切 Noop、拒绝新事件、丢弃缓冲；`off → on` 只能显式 opt-in 并等待服务确认。 |
| 发布阶段 | PASS | 文档明确 Beta 是首个可用版本、Beta+ 是完整 MVP；PR 摘要与 UJ-5 本地结构导出均属于完整 MVP，但不阻塞 Beta。 |
| `ExportPreview` | PASS | `ExportPreviewModelV1` 分开可复用 artifact 与客户端 targetState，固定本地生成、源码策略、脱敏目标标签、写入状态和失败保留语义。 |

## 原发现处置

| ID | 原级别 | 状态 | 修订证据 |
| --- | --- | --- | --- |
| UX-01 | 高 | RESOLVED | `AD-7` 引入 `IndexStatusSummaryV1`；实施说明定义 `IndexJobSummaryV1`、`CommittedIndexSummaryV1`，并要求 `service/status`、`job/get`、GraphViewModel 复用。 |
| UX-02 | 高 | RESOLVED | `AD-9`/`AD-17` 固定 `ConfigDiagnosticV1`、`FindingSummaryV1`；实施说明给出字段和 SCC evidence path。 |
| UX-03 | 中 | RESOLVED | Release slice 与阶段 D 明确 Beta+ 为完整 MVP，正文明确 Beta 是首个可用版本，UJ-5 不阻塞 Beta。 |
| UX-04 | 中 | RESOLVED | `AD-18` 与实施说明固定 `ExportPreviewModelV1` 的 artifact/targetState 所有权、敏感内容标记和失败保留语义。 |

## 已充分承接且不建议继续膨胀的部分

- `GraphViewNodeKind` 与 `GraphViewAggregation` 已足够；不要新增 `aggregate` node kind。
- `NavigationTargetV1` 是导航目标，不是图实体类型；symbol 跳转不会改变 UX 的四类 `GraphNode`。
- degraded workspace 的诊断和恢复动作已经是公共语义；具体提示文案留给 UX。
- `cancelled` / `idle` 不应加入四维 WorkspaceStatus 枚举；当前拆分正确。
- 遥测 opt-out 的立即性已被 AD 与实施说明双重固定；无需新增状态枚举。
- 颜色、轮廓、间距、响应断点和中文文案不属于架构公共合同，继续由 `DESIGN.md` / `EXPERIENCE.md` 管理。

## 剩余 high/medium

无。
