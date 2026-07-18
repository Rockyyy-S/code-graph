# PRD 对齐记录

本记录说明 final PRD（2026-07-13）对既有 UX spine 的受控修订。视觉系统、11 个组件名称和主信息架构 surface 均保持不变。

| PRD 决策 | 原 UX 状态 | 处置 |
|---|---|---|
| 首批用户为 5–15 人团队的一线开发者与 Tech Lead，以个人本地安装进入真实团队仓库 | 标为用户类型假设 | 写入 Foundation，并从开放假设删除 |
| 支持 workspace package、跨 package import 与 package 聚合；识别失败可退化为普通工作区 | 仅有文件、目录/模块、外部包 | 扩展 `GraphNode`、Project Overview、State Patterns 与 UJ-1，不新增 surface |
| `.codegraph/rules.yaml` v1 固定规则类型、稳定 ID、`warning` / `error`，无效配置必须定位并提示修复 | 规则字段与配置错误状态不完整 | 扩展 `FindingRow`、规则错误状态和 UJ-3 失败路径 |
| 标准基线为 5,000 文件、500,000 LOC、50 workspace packages、8 CPU/16 GB/SSD；目标 60s/300ms/2s | 仅部分性能目标；100 节点/200 边仍是假设 | 写入已确认基线、目标与固定图预算，并删除相关假设 |
| 超标准规模不承诺同等 SLA，但不得阻塞编辑器，索引可取消或重建 | 缺少取消和已取消状态 | 扩展 `StatusBanner`、`IndexSummary` 与 State Patterns；取消后保留缓存 |
| 遥测默认关闭，只能显式 opt-in，且可随时关闭 | IA 与状态未覆盖 | 在 Settings & Rules 增加关闭、opt-in 与再次关闭状态 |
| PR 摘要属于 Beta+，不阻塞首个可用版本 | 被假设为首个可用版本能力 | 修正 Changes / PR Summary 阶段，并从开放假设删除 |
| UJ-5 本地 AI 结构上下文导出属于已确认 MVP | 标为假设 | 删除 UJ-5 的 `[ASSUMPTION]` |

## 后续状态（2026-07-15）

`sprint-change-proposal-2026-07-15.md` 已通过后续 UX Update 关闭语言、`ContextLock`、Workspace Trust 和 Node built-in 契约，并正式采用 VS Code 混合容器职责。详见 `reconcile-sprint-change-proposal.md`。

当前只保留非阻塞实现验证项：Finding 忽略/豁免/趋势范围、候选快捷键、响应断点，以及 WCAG 2.2 AA 与最小可选区域的真实 Webview 验证。
