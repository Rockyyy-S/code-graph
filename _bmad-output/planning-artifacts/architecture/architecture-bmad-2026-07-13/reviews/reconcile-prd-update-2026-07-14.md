---
title: PRD / Addendum 更新后架构独立对账
date: 2026-07-14
rechecked: 2026-07-14
review_scope: 项目代码图谱 MVP
verdict: pass
review_status: closed
sources:
  - ../../../prds/prd-bmad-2026-07-09/prd.md
  - ../../../prds/prd-bmad-2026-07-09/addendum.md
  - ../ARCHITECTURE-SPINE.md
  - ../IMPLEMENTATION-GUIDE.md
---

# PRD / Addendum 更新后架构独立对账

## 最终结论

**Verdict：PASS — 无剩余 HIGH/MEDIUM。**

更新后的架构脊柱与实施说明已完整承载本轮 PRD/Addendum 变化；未发现新的反向约束或公共契约分歧。既有架构范式、AD 编号、技术栈和发布切片无需调整。

## 重点要求最终对账

| PRD / Addendum 要求 | 判定 | 最终架构落点 |
| --- | --- | --- |
| monorepo 无法可靠识别时降级而非失败 | PASS | AD-5；`WorkspaceDiscoverySummary` 的 `single/recognized/degraded`；degraded 禁止 package 聚合结论但继续文件/目录/源码索引。 |
| workspace package 与跨 package import | PASS | AD-4、AD-5、AD-7、AD-19；稳定 package 身份、跨包 Evidence、聚合投影和 UI 合同连通。 |
| 取消保留最新已提交缓存 | PASS | AD-8；取消只在事务外安全点生效，保留已提交 revision，未完成 reconciliation 显示 partial/stale。 |
| 遥测可随时关闭并查看生效状态 | PASS | AD-16、AD-22；`on → off` 先切 Noop、拒绝新事件并清空缓冲，再确认有效状态。 |
| Beta+ PR 摘要 | PASS | Release slice、AD-18、实施阶段 D；`PrReviewSummaryV1` 固定 majorRisks、keyPaths、双 revision 和两个时间字段。 |
| UJ-5 / FR-23 结构上下文导出 | PASS | AD-18；`StructureContextExportV1` 固定 scope、双 revision、更新时间、生成时间、实体/关系/规则/Findings/截断。 |
| FR-9 符号导航 | PASS | AD-7；`NavigationTargetV1` 以 symbolId、relativePath、`SourceRangeV1` 承载符号跳转，不增加第五种图节点。 |
| FR-2 Evidence 元数据 | PASS | AD-21；固定 language 枚举、UTC ISO 8601 detectedAt、provenance、confidence 和统一 SourceRange。 |
| SM-1..SM-8 发布与真实团队验证 | PASS | AD-19、实施阶段 E、验证矩阵；SM-7 的 70% / 4-of-5 与 SM-8 Tech Lead 门禁已恢复。 |

## 发现关闭记录

| Finding | 最终状态 | 复核证据 |
| --- | --- | --- |
| F-01 GraphViewNodeKind 排除 symbol | CLOSED | 节点通过 `NavigationTargetV1` 提供 symbol 跳转；公共范围统一为 0-based UTF-16、`[start,end)`。 |
| F-02 PR/AI 导出字段不足 | CLOSED | `PrReviewSummaryV1` 与 `StructureContextExportV1` 已补齐 PRD 最小字段。 |
| F-03 Evidence 缺 language/detectedAt | CLOSED | AD-21 与实施说明已固定字段与格式。 |
| F-04 SM-7/SM-8 门禁遗漏 | CLOSED | 阶段 E 已执行 SM-1..SM-8，验证矩阵恢复量化门槛。 |
| F-05 external entity 无合法 relativePath | CLOSED | 导出 entity 改为按 nodeType 判别的联合：内部实体必填 relativePath；external-package/node-builtin 必填 externalId/displayName 并省略 relativePath。 |

## 最终一致性检查

- `StructureContextExportV1` 的外部实体使用规范 purl 或 `node:<module>` 身份，不伪造工作区路径，不违反相对路径与路径边界约定。
- `NavigationTargetV1`、`SourceRangeV1`、Finding、CLI 与导出使用同一位置坐标体系。
- PR/AI 导出继续默认无源码；复制或写入失败保留已生成 artifact。
- monorepo degraded、原子 GraphPatch、双 revision、取消保留缓存和 telemetry 立即 opt-out 语义未被本轮修复削弱。
- Alpha/Beta/Beta+ 与完整 MVP 范围保持一致；MCP、云协作和 hosted PR app 仍在 MVP 外。

本轮 PRD/Addendum 对账完成，可进入最终 Reviewer Gate 或下游规格/史诗拆解。
