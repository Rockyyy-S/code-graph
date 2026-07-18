---
workflowStatus: 'completed'
totalSteps: 2
stepsCompleted: ['step-01-assess', 'step-02-apply-edit']
lastStep: 'step-02-apply-edit'
nextStep: ''
lastSaved: '2026-07-16T17:15:33.5318471+08:00'
workflowType: 'testarch-test-design'
editMode: true
inputDocuments:
  - '_bmad-output/test-artifacts/test-design-progress.md'
  - '_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md'
  - '_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/DESIGN.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md'
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/planning-artifacts/implementation-readiness-report-2026-07-16-rerun-3.md'
---

# 架构测试设计：项目代码图谱 MVP

**Purpose:** 记录生产架构风险、可测试性依赖与 NFR 证据责任，作为 Architecture、Dev、Release 与 QA 的实施合同；原子测试场景、执行频率和工具策略见 `test-design-qa.md`。

**Date:** 2026-07-16  
**Author:** Shiqw  
**Status:** 规划基线 READY；实现证据待产生  
**Project:** bmad  
**PRD Reference:** [prd.md](../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md)  
**ADR Reference:** [ARCHITECTURE-SPINE.md](../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md)  
**Readiness Reference:** [implementation-readiness-report-2026-07-16-rerun-3.md](../planning-artifacts/implementation-readiness-report-2026-07-16-rerun-3.md)

## Executive Summary

当前权威规划基线包含 FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8、AD-1～AD-30、UX-DR1～UX-DR37，以及 5 个 Epic、61 个 Story。`StoryDependencyDagV1` 是 Story 调度的唯一依赖权威；Implementation Readiness 结论为 **READY**，但该结论只代表规划可实施，不代表任何产品、性能、安全、可访问性或发布门禁已经通过。

**Scope:** VS Code Extension、CLI、每 indexing root 唯一的 graph-service、SQLite、TS/JS 分析、Webview、规则/Findings、Git impact、结构导出、渐进式 CI、跨平台离线发布、可复现 release set、签名信任链和版本化产品验证。

**Architecture spine:** 六边形模块化单体；graph-service 是唯一组合根和共享状态写入者；所有共享状态只经 snapshot mutation channel 原子提交；Named Pipe/UDS 承载 JSON-RPC 2.0，不监听 TCP；客户端只消费已提交、版本化、运行时校验的合同。

**Acceptance envelope:** 8 逻辑 CPU、16 GiB RAM、SSD；最多 5,000 源码文件、500,000 LOC、50 workspace package；clean-cache 首次 Overview p95 ≤60s，warm-cache 邻域 p95 ≤300ms，保存到 graph/Findings revision 可见 p95 ≤2s；规范依赖边 micro-F1 ≥0.80、high-confidence precision ≥0.90。

**Risk summary:** 共 18 项风险；8 项阻断级 9 分，10 项高风险 6 分，无中低风险。R-001、R-002、R-003、R-004、R-011、R-016、R-017、R-018 必须在对应里程碑以真实证据关闭，不能用规划 READY 或人工解释替代。

## Quick Guide

### BLOCKERS — 必须在能力首次公开或候选判定前关闭

1. **R-001 快照原子性：** GraphPatch、Findings、三组 revision、bootstrap generation 与配置 CAS 必须只有一条 mutation channel，任何客户端不得看到半提交或过期提交。
2. **R-002 性能与资源：** `BenchmarkPlanV1` 必须固定 fixture/digest、环境、起止事件、2 次 warm-up、至少 20 次测量和 nearest-rank p95；同时验证 4 GiB/75%、空闲 1%/1.5 GiB、2 GiB/100 MiB 与 8 小时资源增长门槛。
3. **R-003 真实平台交付：** 四目标平台、VS Code 版本矩阵、Node 24 LTS、SQLite ABI、离线安装和升级/降级必须使用候选产物验证。
4. **R-004 结构事实可信度：** AD-24/25/27 的语法映射、BasicSymbolV1、ProjectionMembershipV1、CycleProjectionKernelV1 与准确率口径必须由唯一实现生产。
5. **R-011 渐进式 CI：** `architecture-required`、GateRegistryV1、GateEvidenceV1、provider required check、禁用 bypass 和外部 drift monitor 必须 fail closed；禁止空测试、永久 skip 或始终成功脚本。
6. **R-016 发布信任链：** payload root、SBOM、release set、trust bundle 和 detached signature 必须可复现、可追溯且候选完整一致。
7. **R-017 验证适用性：** ProductValidationPlan/Policy/Manifest/Evidence/Result 与 CandidateRef 的 schema、版本、digest 和引用链任一不匹配必须为 invalid。
8. **R-018 规划追踪与 DAG：** 61 个 Story、FR/NFR/AR/UX-DR 双向追踪和唯一 DAG 必须由自动门禁保护，文档顺序不得成为隐式依赖。

### HIGH PRIORITY — 必须有负责人、期限与验证证据

- R-005：`.codegraphignore`、rules last-valid、partial/stale/cancel 下 Finding 生命周期。
- R-006/R-007：Workspace Trust、IPC、realpath、CSP、遥测和 structure-only 隐私边界。
- R-008/R-009：独立 Schema 版本、N/N-1 能力协商、单实例、重连、空闲退出和升级交接。
- R-010/R-015：预算内 Webview、原子 patch、空间记忆、WCAG 2.2 AA、响应阈值和辅助技术矩阵。
- R-012：确定性时间、故障注入、隔离 fixture、证据归档等测试基础设施必须与能力同时落地。
- R-013/R-014：workspace/投影/Overview 唯一语义，以及 canonical Git baseline/ImpactVerdict 唯一结论。

## Risk Assessment

评分为 Probability × Impact；9 分为阻断，6～8 分必须缓解。

| ID | 类别 | 风险 | P | I | 分数 | 生产侧缓解 | Owner / 时限 |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| R-001 | TECH | generation、配置快照、GraphPatch 与三组 revision 交错暴露半提交或过期快照 | 3 | 3 | **9** | 唯一 mutation channel、完整 CAS、原子事务、可控 scheduler | Core/graph-service；Story 1.19、2.8 前 |
| R-002 | PERF | 标准规模性能、CPU/RSS/磁盘或 8 小时资源趋势超出门槛 | 3 | 3 | **9** | BenchmarkPlanV1、资源 manifest、Worker 隔离和机器可读结果 | Analyzer/Performance；Story 5.6 |
| R-003 | OPS | Node/SQLite ABI、VSIX/npm 包或升级路径无法跨平台离线运行 | 3 | 3 | **9** | 平台产物、兼容握手、事务迁移、真实安装矩阵 | Release Engineering；Story 5.1～5.7 |
| R-004 | BUS | 依赖、符号、投影、循环或 Finding 语义不准，导致用户不信任 | 3 | 3 | **9** | 唯一语法/投影 Kernel、版本化 corpus、失败样本保留 | Analyzer/Rules/Product QA；Story 1.5～1.9、3.5～3.8 |
| R-005 | DATA | invalid ignore/rules、partial/stale/cancel 错误删除或解决 Finding | 2 | 3 | **6** | generation/last-valid、完整 scope 才允许 resolved、revision 绑定策略 | Config/Rules/Store；Story 1.10～1.13、3.1～3.8 |
| R-006 | SEC | Trust、IPC、路径、YAML 或 Webview 输入突破本地安全边界 | 2 | 3 | **6** | Trust 前零动作、token/workspace/protocol、realpath、CSP/Schema、资源硬限制 | Security/Extension；Story 2.1、3.4、5.5 |
| R-007 | SEC | 遥测、日志、CLI、PR/AI 导出或发布产物泄露敏感内容 | 2 | 3 | **6** | Noop telemetry、允许列表、structure-only、内容扫描和网络捕获 | Privacy/Export/Release；每阶段 |
| R-008 | TECH | protocol/graph/rules/CLI/validation/release Schema 漂移造成互操作失败 | 2 | 3 | **6** | 独立版本、JSON Schema、capability 协商、golden 与拒绝合同 | Contracts/service-client；Story 1.2 起 |
| R-009 | OPS | 单实例发现、stale metadata、重连、取消或升级交接产生双写者/孤儿事务 | 2 | 3 | **6** | OS 排他锁、原子 metadata、生命周期状态机、事务后交接 | graph-service/Release；Story 1.17、5.3 |
| R-010 | PERF | Webview 查询、布局或 patch 阻塞主线程或破坏空间记忆 | 2 | 3 | **6** | 服务端预算、Worker 布局、GraphViewPatchV1、失配全量重取 | Querying/Webview；Story 2.2～2.11 |
| R-011 | OPS | CI gate 被 path filter、伪证据、陈旧 head、provider bypass 或 drift 绕过 | 3 | 3 | **9** | always-run umbrella、外部 Controller、GateEvidence digest/CAS、drift monitor | Dev Enablement/Release；Story 1.1～1.3 |
| R-012 | TECH | 测试控制面和 fixture 建设滞后，使高风险只能靠不稳定 E2E 观察 | 2 | 3 | **6** | Clock/scheduler、故障注入、独立 cache/endpoint/DB、统一 teardown | Core + QA；能力首次公开同 PR |
| R-013 | TECH | workspace 识别、ProjectionMembership、OverviewMetric 或基础循环实现分叉 | 2 | 3 | **6** | 判别联合、唯一 application Kernel、稳定 membershipDigest/rankingVersion | Analyzer/Querying；Story 1.9、1.14、2.2/2.3 |
| R-014 | DATA | Git baseline、CycleDelta、ImpactVerdict 或风险排序被客户端重算或污染主 revision | 2 | 3 | **6** | canonical baseRef/baselineId、application/impact 唯一生产者 | Impact/Git；Story 4.1～4.4 |
| R-015 | BUS | 图/列表、键盘、辅助技术、本地化或响应式矩阵不满足核心任务等价 | 2 | 3 | **6** | WCAG 2.2 AA、真实 Webview 阻断矩阵、图/列表共享实体与状态 | UX/Extension/Webview；Story 2.x、5.5 |
| R-016 | OPS | payload、SBOM、manifest、release set 或签名链不一致但仍被发布 | 3 | 3 | **9** | 两次 clean checkout 可复现、完整 target matrix、trust anchor/bundle 验证 | Release Engineering/Security；Story 5.8～5.10 |
| R-017 | DATA | 产品验证任务、样本、阈值或 gate applicability 临场变化，错误放行候选 | 3 | 3 | **9** | ProductValidationPlanV1、ReadinessGatePolicy/Manifest、不可变 Evidence/Result | Product Validation/Release；Story 5.11/5.12 |
| R-018 | TECH | Story DAG、需求引用或 gate registry 漂移，导致错误调度或遗漏阻断门禁 | 3 | 3 | **9** | 61/61 DAG 校验、FR/NFR/AR/UX-DR/Story 双向追踪与 drift gate | Architecture/PO/Dev Enablement；Story 1.3、5.12 |

## NFR Testability Requirements

| 类别 | 权威门槛/合同 | 当前设计支持 | 实施前置与证据 |
| --- | --- | --- | --- |
| Performance | 60s/300ms/2s 均为 p95；2 warm-up、≥20 次、nearest-rank | Defined | BenchmarkPlanV1、BenchmarkResultV1、reference runner preflight |
| Resources | rebuild RSS ≤4 GiB、平均 CPU ≤75%；5 分钟空闲 CPU p95 ≤1%、RSS ≤1.5 GiB；缓存+元数据+日志 ≤2 GiB、日志 ≤100 MiB；8 小时 RSS 增长 ≤20% | Defined | 版本化资源 manifest、1 秒采样、句柄/队列/临时文件趋势 |
| Accuracy | ≥500 标注声明；micro-F1 ≥0.80；high-confidence precision ≥0.90 | Defined | corpus digest、争议复核、分类和失败样本 |
| Rules | ≥30 合同案例；预期 Finding recall/precision=1.00；error 漏报=0；负对照误报=0 | Defined | RulesValidationFixtureV1、IDE/CLI 一致性 |
| Security/Privacy | Trust 前零动作；IPC/路径/CSP/Schema/硬上限；默认本地与遥测关闭 | Defined | 负向/fuzz、网络捕获、敏感输出和产物扫描 |
| Accessibility | WCAG 2.2 AA；键盘全任务；24×24 CSS px；200% 字号；高对比与减少动态 | Defined | 真实 Webview 矩阵、axe、焦点/可访问性树、NVDA/VoiceOver/Orca |
| Portability | Win x64、macOS x64/arm64、Linux x64；VS Code 1.125.0/最新/前一稳定版；离线 | Defined | 真实 CLI/VSIX、安装/升级/降级/卸载与 ABI 证据 |
| Product validation | SM-1/6/7/8 与 UJ-5 的样本、任务、评分和阈值由 ProductValidationPlanV1 唯一定义 | Defined | CandidateRef 绑定的 Evidence/Result；失败和 invalid 不得剔除或人工放行 |
| Release integrity | ReleaseArtifactManifest、ReleaseSetManifest、SBOM、trust bundle/signature 完整一致 | Defined | 两次 clean checkout digest、一致 target matrix、签名和撤销验证 |

旧文档中的“内存、磁盘、WCAG、采样方法仍为 UNKNOWN”已经失效。当前主要缺口不是门槛未知，而是实现、runner、候选产物和真实参与者证据尚未产生。

## Testability Concerns and Required Seams

| Concern | Architecture/Dev 必须提供 | Owner / 首次需要时间 |
| --- | --- | --- |
| C-01 确定性时间与事件 | `ClockPort`/scheduler、可重放 watcher/reconciliation/bootstrap 序列 | Core；Story 1.19 前 |
| C-02 故障注入 | SQLite busy/损坏/迁移、IPC 断线、进程崩溃、ABI/Schema 不兼容、目标写出失败 | Adapters/Release；相关能力首次公开 |
| C-03 运行隔离 | 每 worker 独立 indexing root、cache、endpoint、token、workspace-key、SQLite 和幂等 teardown | graph-service + QA；Story 1.2 起 |
| C-04 证据身份 | request/job/revision 事件、Benchmark/Resource/Gate/Product Validation/Release 证据 Schema 与 digest helper | Contracts/Application；Story 1.3 起 |
| C-05 真实宿主与平台 | 四平台 runner、VS Code 三版本、主题/宽度/字号矩阵和辅助技术 spot check | Release/UX QA；Story 2 首切片与 5.5 |
| C-06 外部强制控制面 | provider ruleset、外部 ArchitectureGateController、禁用 bypass 和 drift monitor | Release/Platform Owner；Story 1.3 |

## Architectural Invariants to Preserve

1. 客户端、Analyzer、Webview 和 CLI 不写共享状态，也不重算 Overview、CycleDelta、ImpactVerdict、Finding comparison 或发布适用性。
2. 任何 identity、revision、digest、candidateRef、schema 或 epoch 不匹配都 fail closed；不能用人工解释把 invalid 当作 pass。
3. `StoryDependencyDagV1` 是唯一 Story 依赖来源；正文顺序与 Story 数字大小没有调度语义。
4. 能力首次由公共 CLI/RPC/extension 或公共 Schema 暴露时，同一 PR 必须启用真实可失败门禁。
5. Beta 不是完整 MVP；Beta+ release 必须消费固定 `ReadinessGateManifestV1` 并通过所有 blocking gate；UJ-5 只决定 v1.1/MCP 候选是否启动。

## Assumptions and Dependencies

- 当前仓库仍处于规划完成、实现未落地阶段；因此所有风险状态均为 Planned/Open，尚无运行证据可降低评分。
- Node 24.18.0、TypeScript 6.0.3、pnpm 11.12.0 和 VS Code 1.125.0 是本轮锁定基线。
- Story 1.1 → 1.2 → 1.3 是实施地基顺序；Story 1.3 完成前不得启动 Story 1.4 或其他功能 Story。
- 真实平台 runner、provider/plan、签名密钥治理、候选产物和产品研究参与者需要在对应 Story 中落实；缺失时门禁应阻断，不得降级。

**End of Architecture Test Design**
