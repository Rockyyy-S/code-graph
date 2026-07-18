---
title: Sprint Change Proposal 2026-07-16 UX 对齐记录
date: 2026-07-16
status: complete
verdict: PASS
remainingGaps: 0
---

# Sprint Change Proposal 2026-07-16 UX 对齐记录

- 日期：2026-07-16
- 输入：`../../sprint-change-proposal-2026-07-16.md`
- 产物：`DESIGN.md`、`EXPERIENCE.md`
- 结论：已批准提案 §6 的 UX 变更已全部写入当前 spine；IA 主路径、surface 职责、组件集合和视觉系统保持不变。

`reconcile-sprint-change-proposal.md` 保留为 2026-07-15 历史证据；其中关于可访问性、快捷键和断点的旧非阻塞表述已由本记录覆盖，不回写历史正文。

| 变更决定 | 原 UX 状态 | 当前契约 |
|---|---|---|
| 只有完整不可变 artifact 可复制或写出 | `ExportPreview` 只描述预览内容，未约束可操作状态和身份字段 | 仅 `artifactStatus=complete` 且具有 `artifactId`、revision、`requestedPolicy`、`effectivePolicy`、`containsSource`、`contentDigest` 的 artifact 可操作；`DESIGN.md` 与 `EXPERIENCE.md` 同步约束 |
| 区分生成失败与目标操作失败 | 单一 `Export failed` 状态允许保留预览、重试或复制，可能暴露部分内容 | 拆分 `Export generation failed` 与 `Export target failed`；生成失败不创建或暴露部分 artifact，目标失败保留同一完整 artifact 供重试或切换目标 |
| 上一份完整 artifact 必须与本次失败分离 | 未定义旧结果身份与视觉边界 | 标记“上一份有效结果”、生成时间、revision 与 policy；只允许明确复制旧结果或重新生成 |
| WCAG 2.2 AA 与 24×24 CSS px 为强制要求 | 两项要求带 `[ASSUMPTION]`，开放项把要求本身视为待定 | 删除假设标签并写为 NFR-18/NFR-19 强制要求；待闭合项仅是实现证据 |
| 候选快捷键采用分平台、有限版本冲突矩阵 | 仅有 Windows/Linux 风格候选，检查范围未固定 | 增加 macOS 候选；固定 VS Code 1.125.0、最新稳定版、前一稳定版及宿主默认、Accessibility Help、产品命令和系统保留组合；冲突平台不注册默认绑定，Command Palette 保持等价 |
| 候选断点必须通过真实 Webview 矩阵校准 | 900px / 600px / 360px 仅为笼统假设 | 保留为候选阈值，覆盖 1024/900/899/600/599/360/359 CSS px，并固定主题、100%/200% 字号、键盘、NVDA/VoiceOver/Orca 与证据字段 |
| module 与 Overview 投影采用权威术语 | “目录/模块”可能被理解为独立实体，Overview 未固定正式排名条件 | module 只作为 directory 投影叶或 recognized workspace package 的可见称谓；directory 投影叶明确为视觉节点类别而非持久实体；界面与导出显示 `groupBy` 和规范 ID；只有 `current + complete` 可给正式排名 |
| Overview 指标与稳定聚合对齐 FR-6 / FR-7 | 指标只用自然语言描述，未固定稳定排序与 query identity | 显示 `dependencyStrength`、`internalDependencyStrength`、`cycleMemberCount`；完整候选稳定排序后截断，以规范 ID tie-break，展开创建新的局部查询 |
| UJ-4 / UJ-5 承接版本化验证的用户可感知结果 | UJ-4 允许直接粘贴但未限定结构性重分析；UJ-5 缺少允许范围、禁止边界与 check/impact 闭环 | UJ-4 最多允许措辞或格式调整；UJ-5 使用完整 structure-only artifact 约束 AI，并在修改后运行 check/impact |

## 保留的非阻塞验证项

- Finding 首版是否扩展到 UI 内忽略、豁免审批或历史趋势。
- 首个真实 Webview 切片和 Story 5.5 仍需产出规定的可访问性、焦点、溢出与宿主矩阵证据；这不降低对应强制要求。

## 丢弃项

无。所有已批准的 UX 变更均已进入 spine；未把纯架构、CI、产品验证 manifest 或 Story 拆分细节重复写入 UX 主干。
