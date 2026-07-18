# Sprint Change Proposal UX 对齐记录

- 日期：2026-07-15
- 输入：`../../sprint-change-proposal-2026-07-15.md`
- 产物：`DESIGN.md`、`EXPERIENCE.md`
- 结论：批准提案中的 UX 契约变更已全部写入当前 spine；未新增主 surface、顶层实体类型或组件名称。

| 变更决定 | 原 UX 状态 | 当前契约 |
|---|---|---|
| VS Code 人类可读界面支持 zh-CN 与 en，未知 locale 回退 en；机器合同不本地化 | 产品语言与国际化范围为开放假设 | `EXPERIENCE.md` 增加 Localization Contract；`DESIGN.md` 要求双语文案适配；开放假设已删除 |
| `ContextLock` 只持续当前 extension-host 会话 | “当前 VS Code 会话”边界不明确，且与 `workspaceState` 存储可能冲突 | Webview reload 可从扩展内存恢复；窗口 reload、重启或重新打开工作区后清除；`workspaceState` / `globalState` 不保存固定标记 |
| 未信任工作区必须有主状态和恢复动作 | 主状态表未覆盖 | State Patterns 增加 `Workspace untrusted`；不启动服务、不读取项目、不执行 Git 分析；唯一主动作是“管理 Workspace Trust”；UJ-1 补充失败路径 |
| Node built-in 具有独立视觉、文本和无障碍语义 | 仅明确外部 npm 包样式 | 保持 external-package 顶层类型和 `node-builtin` 子类型；使用 `node:` 前缀、“Node 内置模块”标签、`symbol-module` 图标、点线轮廓，并同步到图例、列表、详情和屏幕阅读器 |
| 首个 Webview 切片提供真实主题与布局证据 | 混合容器职责仍被标为假设，且无 mockup | MVP 正式采用 Activity Bar/TreeView、编辑器 Webview、Problems 与 Command Palette 的既定职责；真实 VS Code 验证进入首个实现切片，独立 mockup 不是前置条件 |

## 保留的非阻塞验证项

- Finding 首版是否扩展到忽略、豁免审批或历史趋势。
- 候选快捷键的 VS Code 冲突与可访问性检查。
- 900px / 600px / 360px 候选断点的内容溢出与字号缩放校准。
- WCAG 2.2 AA 与图节点 24×24 CSS px 最小可选区域的真实 Webview 验证。

## 丢弃项

无。所有批准的 UX 变更均已进入 spine；未采纳任何与既有架构实体边界冲突的第五种图节点类型。
