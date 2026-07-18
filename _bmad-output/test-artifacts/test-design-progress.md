---
workflowStatus: 'completed'
totalSteps: 2
stepsCompleted: ['step-01-assess', 'step-02-apply-edit']
lastStep: 'step-02-apply-edit'
nextStep: ''
lastSaved: '2026-07-16T17:15:33.5318471+08:00'
workflowType: 'testarch-test-design'
mode: 'edit'
editedOutputs:
  - '_bmad-output/test-artifacts/test-design-architecture.md'
  - '_bmad-output/test-artifacts/test-design-qa.md'
  - '_bmad-output/test-artifacts/test-design-progress.md'
  - '_bmad-output/test-artifacts/test-design/bmad-handoff.md'
inputDocuments:
  - '_bmad/tea/config.yaml'
  - '_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md'
  - '_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/DESIGN.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md'
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/planning-artifacts/implementation-readiness-report-2026-07-16-rerun-3.md'
  - '_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-16-rerun-2.md'
---

# 测试设计更新进度与差异记录

## 1. 编辑目标

用户确认更新全部四份测试产物。Edit 模式只同步测试设计与交接文档，不修改 PRD、Architecture、UX、Epics 或实现代码。

## 2. 当前权威规划基线

- Implementation Readiness：`READY`，Critical 0、Major 0、5 项非阻塞跟踪事项。
- 需求：FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8。
- 架构：AD-1～AD-30；新增重点为 AD-25 投影/循环/Overview 唯一 Kernel、AD-26 唯一 ImpactVerdict、AD-27 BasicSymbolV1、AD-28 渐进式 CI、AD-29 可复现发布信任链、AD-30 版本化产品验证与发布适用性。
- UX：UX-DR1～UX-DR37；包括 zh-CN/en、真实 Webview 响应矩阵、WCAG 2.2 AA、三平台辅助技术 spot check。
- Backlog：5 个 Epic、61 个 Story；`StoryDependencyDagV1` 覆盖 61/61、唯一根 Story 1.1、无环，正文顺序为 display-only。
- Release：Alpha → Beta → Beta+；Beta 不是完整 MVP；UJ-5 只控制 v1.1/MCP 候选启动。

## 3. 已关闭的旧文档偏差

| 旧表述 | 当前修正 |
| --- | --- |
| 4 个 Epic、29 个 Story | 5 个 Epic、61 个 Story，并按权威 DAG 映射 |
| AD-1～AD-24 | AD-1～AD-30 |
| 54 个原子场景 | 64 个原子场景 |
| 15 项风险 | 18 项风险，覆盖 CI、release trust、product validation、DAG/追踪 |
| 依赖准确率“≥80%” | ≥500 声明；micro-F1 ≥0.80；high-confidence precision ≥0.90 |
| 性能只写 60s/300ms/2s | 明确 p95、2 warm-up、≥20 次、nearest-rank、单 harness 计时 |
| 内存/磁盘/采样 UNKNOWN | NFR-26 已固定 4 GiB/75%、空闲 1%/1.5 GiB、2 GiB/100 MiB、8h ≤20% 增长 |
| WCAG 等级 UNKNOWN | WCAG 2.2 AA、24×24、200%、宽度矩阵与 NVDA/VoiceOver/Orca |
| 全局 coverage ≥80%、核心 ≥90% | 当前规划未规定统一数值；改由版本化 gate registry 决定，禁止自行补造 |
| 手工 PR/Nightly/Weekly 即主要门禁 | 加入 always-run `architecture-required`、GateRegistry/GateEvidence、provider 强制与 drift monitor |
| 普通平台安装检查 | 加入可复现 payload、SBOM、release set、trust bundle、signature/revocation |
| 泛化用户研究 | 加入 ProductValidationPlan/Evidence/Result、CandidateRef 与固定样本/剔除/阈值 |

## 4. 风险与覆盖结果

- 风险：18 项，其中 R-001、R-002、R-003、R-004、R-011、R-016、R-017、R-018 为 9 分阻断风险；其余 10 项为 6 分高风险。
- 原子场景：64 个，且每个只分配到一个最终优先级。
- P0：7 个主题组、28 个原子场景。
- P1：33 个原子场景。
- P2：3 个原子场景。
- P3：0 个。
- 场景域：Architecture/Service/Delivery 12、Indexing/Semantics 14、VS Code/UX 10、Rules 6、Impact/Export 7、NFR/CI/Release/Product Evidence 15。

## 5. 更新后的交付边界

- `test-design-architecture.md`：只维护生产架构风险、可测试性依赖、NFR 证据责任和不变量。
- `test-design-qa.md`：维护 64 个原子场景、优先级、执行频率、需求追踪、门禁和 QA 估算。
- `test-design/bmad-handoff.md`：维护 5 Epic/61 Story 的测试映射、DAG 约束和阶段转换门禁。
- 本文件：维护本次 Edit 运行的输入、差异、计数和验证结果，不再复制完整测试矩阵。

## 6. 当前未阻塞但必须在实施中落实的事项

1. Story 1.3 前选择并证明满足外部强制、禁用 bypass 和 drift monitor 的 provider/plan。
2. 首个真实 Webview 切片产生主题、宽度、字号、键盘和辅助技术阻断证据。
3. 真实四平台 runner、签名密钥治理、release trust anchor、候选产物和产品研究参与者尚未产生。
4. Story 4.6 规模位于合理上沿；若拆分，必须保持不可变 artifact 合同完整。
5. Story ID 非单调；调度和测试只读取 `StoryDependencyDagV1`，不得按数字或文档位置推断。

## 7. 编辑完成判定

- 四份目标文档均已更新到 2026-07-16 修正规划基线。
- 旧计数、旧 Epic/Story 映射、旧 UNKNOWN 和无依据覆盖率门槛已移除。
- 后续验证应检查 Markdown/frontmatter、风险 ID、场景唯一性、64 场景计数、5 Epic/61 Story 文字和关键门槛一致性。
