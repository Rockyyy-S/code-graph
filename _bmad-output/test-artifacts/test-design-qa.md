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
  - '_bmad/tea/config.yaml'
  - '_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md'
  - '_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md'
  - '_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/DESIGN.md'
  - '_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md'
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/planning-artifacts/implementation-readiness-report-2026-07-16-rerun-3.md'
---

# bmad 系统级 QA 测试设计

**Purpose:** 定义当前修正规划基线下的系统级测试覆盖、门禁、执行频率、证据格式与 QA/SDET 实施依赖。

**Date:** 2026-07-16  
**Author:** Shiqw  
**Status:** Updated / Completed  
**Project:** bmad

**Related:** 架构风险、生产侧缓解和 testability seam 见 [test-design-architecture.md](test-design-architecture.md)。

## Executive Summary

本计划以当前 final/READY 规划为唯一基线：FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8、AD-1～AD-30、UX-DR1～UX-DR37、5 个 Epic、61 个 Story。Story 调度只读取 `StoryDependencyDagV1`；规划文档顺序没有依赖语义。

**Risk summary:** 18 项风险，其中 8 项 9 分阻断风险、10 项 6 分高风险。风险 ID 与架构测试设计一致。

**Coverage summary:** 64 个原子规划场景，分配为 P0 7 个阻断主题组/28 个原子场景、P1 33 个、P2 3 个、P3 0 个。覆盖功能、架构、UX、NFR、发布完整性、渐进式 CI、产品验证和需求追踪。

旧版计划中的 4 Epic/29 Story、AD-1～AD-24、54 个场景、`准确率 ≥80%` 单一口径、WCAG/资源/采样 UNKNOWN、全局覆盖率 ≥80% 等表述不再作为当前门禁。正确性现使用 micro-F1/precision 双门槛；资源、WCAG 和基准方法已量化；代码覆盖率若需数值门槛，必须由版本化 gate registry 明确，QA 不自行补造。

## Dependencies & Test Blockers

| 依赖 | QA 需要的能力 | Owner | 首次阻塞点 |
| --- | --- | --- | --- |
| 最小真实 CI 与外部强制 | always-run `architecture-required`；可真实失败；provider required check、禁用 bypass | Dev Enablement/Release | Story 1.1～1.3 |
| 确定性时间与事件 | Clock/scheduler、watcher/reconciliation/bootstrap 可重放序列 | Core/graph-service | Story 1.19、2.8 |
| 故障注入 | SQLite busy/损坏/迁移、IPC、崩溃、stale metadata、ABI/Schema、目标写出失败 | Adapters/Release | 相关能力首次公开 |
| Worker 隔离 | 独立 workspace/cache/endpoint/token/workspace-key/SQLite 与幂等 teardown | Core + QA | Story 1.2 起 |
| 合同与 digest helper | JSON Schema 2020-12、RFC 8785 JCS、稳定 ID/digest、golden 与 unknown-field 行为 | Contracts | Story 1.2 起 |
| 证据存储 | append-only Gate/Product Validation/Release evidence；原子 binding；不可变 artifact | Application/Release | Story 1.3、4.6、5.8 起 |
| 真实平台与宿主 | 四平台 runner、VS Code 三版本、暗/亮/高对比、宽度/字号、辅助技术 | Release/UX QA | 首个 Webview 与 Story 5.5 |
| 产品研究 | 合格参与者、真实仓库/团队、预声明剔除规则与 ground truth | Product/UX Research | Beta/Beta+ gate |

## Test Infrastructure Setup

1. Vitest 承担纯核心、属性/模型、Schema、digest 和算法测试；Playwright 承担组件、VS Code Electron、CLI/进程编排与宿主证据。
2. 为 Named Pipe/UDS 提供 test-only API driver；测试桥不得进入产品产物、不得使产品监听 TCP。
3. 建立临时工作区、固定 Git 历史、SQLite 故障库、平台安装沙箱、进程生命周期和自动清理 fixture。
4. 建立版本化 TS/JS 正确性 corpus（≥500 标注声明）、RulesValidationFixtureV1（≥30 案例）、标准规模生成器和 8 小时资源会话。
5. 建立 GateRegistry/GateEvidence、ProductValidationPlan/Evidence/Result、ReleaseArtifact/ReleaseSet/Signature 的 Schema corpus、digest golden、断链与冲突样本。
6. 所有等待使用事件、revision、状态或有界轮询；禁止硬等待验证 quiet window、reconciliation、空闲退出或取消。
7. 证据统一归档到 `_bmad-output/test-artifacts/evidence/`，按 `ci/`、`contracts/`、`security/`、`performance/`、`resources/`、`ux/`、`packaging/`、`release/`、`product-validation/` 分类。

## Risk-to-Test Strategy

| Risk | QA 验证重点 |
| --- | --- |
| R-001 | 模型/属性测试、随机事件序列、完整 CAS、事务中断、三时钟 patch |
| R-002 | BenchmarkPlanV1、reference preflight、p95、CPU/RSS/磁盘和 8 小时资源趋势 |
| R-003 | 四平台 CLI/VSIX、VS Code 三版本、ABI、离线安装及升级/降级/卸载 |
| R-004 | ≥500 corpus、唯一语法映射、BasicSymbol 边界、投影/循环/Overview deterministic golden |
| R-005 | ignore/rules generation、last-valid、invalid/partial/stale/cancel、Finding lifecycle |
| R-006 | Trust、IPC、realpath/symlink、YAML、CSP、Webview Schema 与资源硬上限 fuzz |
| R-007 | 网络捕获、日志/CLI/IPC/导出/VSIX/SBOM 敏感信息扫描、telemetry 竞态 |
| R-008 | N/N-1、major 拒绝、Schema golden、unknown field、CLI/RPC/validation/release 合同 |
| R-009 | 双客户端、多进程、stale metadata、空闲退出、崩溃恢复和升级交接 |
| R-010 | query budget、Web Worker、long-task、patch/invalidate、空间记忆 |
| R-011 | GateRegistry、trigger applicability、merge-base、evidence producer、head CAS、provider drift |
| R-012 | fixture 健康检查、隔离、teardown、失败可复现性和 no-empty-test 检查 |
| R-013 | workspace 判别联合、membershipDigest、唯一 Kernel、热点/循环稳定排序 |
| R-014 | canonical Git baseline、CycleDelta、ImpactVerdict/Rank 和多入口一致性 |
| R-015 | WCAG 2.2 AA、键盘、200%、高对比、响应矩阵、NVDA/VoiceOver/Orca、zh-CN/en |
| R-016 | 两次 clean checkout、payload root、SBOM、target matrix、trust bundle、签名/撤销 |
| R-017 | plan/policy/manifest/evidence/result/candidateRef 完整引用链、invalid fail-closed |
| R-018 | 61/61 DAG、唯一根/无环、需求双向追踪、gate registry 与规划 drift |

## NFR & Product Gate Plan

| 类别 | 门槛 | 验证与证据 | Priority |
| --- | --- | --- | --- |
| Performance | clean Overview p95 ≤60s；warm 邻域 p95 ≤300ms；save→revision p95 ≤2s | 2 warm-up、≥20 次、nearest-rank p95、`process.hrtime.bigint()`、BenchmarkResultV1 | P0 |
| Resources | rebuild RSS ≤4 GiB、平均 CPU ≤75%；空闲 CPU p95 ≤1%、RSS ≤1.5 GiB；总量 ≤2 GiB、日志 ≤100 MiB；8h RSS 增长 ≤20% | 1 秒采样、资源 manifest、队列/句柄/临时文件趋势 | P0 |
| Accuracy | ≥500 标注声明；micro-F1 ≥0.80；high-confidence precision ≥0.90 | corpus/digest、precision/recall/F1、分类和失败样本 | P0 |
| Rules | ≥30 案例；预期 Finding recall=1、precision=1；error 漏报=0；负对照误报=0 | RulesValidationFixtureV1、IDE/CLI ID/严重度/位置一致 | P1 |
| Security/Privacy | Trust 前零动作；IPC/路径/CSP/Schema/硬上限；默认零上传与遥测关闭 | fuzz、负向矩阵、网络捕获、敏感输出和产物扫描 | P0 |
| Reliability | 原子提交、stale/partial/cancel、≤5 分钟有界对账、5 分钟空闲退出、可恢复迁移 | 状态机、故障注入、soak、重连/升级日志 | P1 |
| Accessibility | WCAG 2.2 AA；键盘全任务；24×24；200%；高对比；减少动态 | axe、真实 Webview、可访问性树、焦点序列、三类辅助技术 spot check | P1 |
| Portability | Win x64、macOS x64/arm64、Linux x64；VS Code 最低/最新/前一版；离线 | 真实候选安装、ABI、自检、升级/降级/卸载 | P0 |
| SM-1 | ≥10 有效会话；≥80% 在 180s 内正确完成 UJ-2 task | ProductValidationPlanV1 与原始 task events | P1 |
| SM-6 | Rules 门禁达到 1.00/1.00 且 error 漏报/负对照误报均为 0 | 版本化 rules fixture 与失败样本 | P1 |
| SM-7 | ≥10 人、3 仓库、2 团队；≥70% 评分 4/5+ | 资格、剔除、计时、正确性与原始评分 | P1 |
| SM-8 | ≥5 Tech Lead、3 团队；≥80% 仅需 none/wording/format 编辑且无关键遗漏/错误 | TechLeadReviewEvidenceV1 与复测条件 | P1 |
| UJ-5 | ≥8 AI 重度用户、3 仓库、2 团队；≥75% 正确识别边界且评分 4/5+；零泄露 | UJ5ExportValueTaskV1；只控制 v1.1 候选启动 | P1 |
| Release integrity | release set 完整、payload/SBOM 可复现、签名链有效 | manifests、clean checkout digest、trust bundle/signature evidence | P0 |

## Entry Criteria

- [ ] Story 1.1/1.2/1.3 的最小 CI、完整 gate registry、provider 强制和 drift monitor 已按 DAG 完成。
- [ ] 当前能力所需 Clock/scheduler、故障注入、隔离 fixture、统一 teardown 和证据 Schema 已提供。
- [ ] `ci/quality-gates.v1.yaml` 中相关 gate 具有真实命令、owner、producer、triggerPaths 和 digest；无空测试或永久 skip。
- [ ] 测试输入绑定版本、fixture digest、toolchain digest、candidateRef；不满足 preflight 时结果为 invalid。
- [ ] 平台/VS Code runner、候选产物、产品研究样本或辅助技术证据在对应 gate 前可用。

## Exit Criteria

- [ ] 所有适用 P0 原子场景通过率 100%；任一 fail/invalid 阻断对应候选。
- [ ] P1 通过率 ≥95%；其余必须有风险接受人、期限、candidate-bound 缓解和复测条件。
- [ ] 无开放 9 分风险；6 分风险必须完成计划缓解或经过正式、可追踪的阶段性接受。
- [ ] FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8、适用 AD/AR/UX-DR 和 61 个 Story 均能追踪到 gate 与证据。
- [ ] 正确性、规则、性能、资源、安全、隐私、可访问性、平台、发布完整性和产品验证达到各自权威门槛。
- [ ] ReadinessGateManifestV1 中全部 blocking gate 为 pass；缺证据、断链或 schema/digest/candidate 不匹配均为 No-Go。
- [ ] Beta 不宣称完整 MVP；Beta+ 才执行完整 MVP Go/No-Go；UJ-5 只影响 v1.1/MCP 候选启动。

## Atomic Coverage Plan

### Architecture, Service & Delivery Contracts（12）

| ID | 原子场景 | Level | Priority |
| --- | --- | --- | --- |
| SYS-ARC-001 | domain/application 反向依赖、第二组合根和公共合同越界被 CI 拒绝 | Unit/CI | P1 |
| SYS-ARC-002 | CLI/Extension 对同一 indexing root 只发现一个服务，multi-root 保持独立 | Process Integration | P1 |
| SYS-ARC-003 | token、workspace-key、protocol/schema 或 endpoint 身份无效时 fail closed | Security/API | P0 |
| SYS-ARC-004 | ServiceStatus/IndexStatus/Job 判别联合的合法与非法组合 | Unit/Property | P1 |
| SYS-ARC-005 | queued→running→terminal、取消点、completedScope 与 committed cache 语义 | Unit + API | P1 |
| SYS-ARC-006 | GraphPatch/Findings/status revision 原子、连续且半提交不可见 | Property + SQLite | P0 |
| SYS-ARC-007 | bootstrap/watcher/config/manifest/ignore/rules 变化使过期 CAS 丢弃并重排 | Model + API | P0 |
| SYS-ARC-008 | protocol/graph/rules/CLI/validation/release Schema 兼容和未知字段行为 | Contract | P1 |
| SYS-ARC-009 | CLI 八命令 envelope、stdout/stderr、相对路径、无 ANSI、退出码 0/1/2/3/4/130 | CLI Integration | P0 |
| SYS-ARC-010 | SQLite migration/busy/损坏、故障副本与安全重建 | Integration | P1 |
| SYS-ARC-011 | GateRegistry/Context/Evidence、trigger applicability、provider producer、head CAS 与 drift fail closed | CI Contract | P0 |
| SYS-ARC-012 | Policy inheritance、phase closure、CandidateRef 与 ReadinessGateManifest 确定性编译 | Contract/Property | P0 |

### Indexing, Semantics & Querying（14）

| ID | 原子场景 | Level | Priority |
| --- | --- | --- | --- |
| SYS-IDX-001 | workspace/node/edge/symbol ID 跨重建与平台稳定 | Property | P1 |
| SYS-IDX-002 | 普通、空、仅排除文件工作区产生确定性初始化结果与摘要 | API | P0 |
| SYS-IDX-003 | ESM/CJS/re-export/type-only/literal require/dynamic import 的唯一规范关系 | Unit/Golden | P0 |
| SYS-IDX-004 | path alias、project references、Node built-in、内部文件、外部包、unresolved 解析优先级 | Unit/API | P0 |
| SYS-IDX-005 | high/medium/low Evidence、去重、冲突排除及规则只消费 high | Unit | P0 |
| SYS-IDX-006 | complete/partial/failed ownership slice 的 upsert/delete/tombstone 不越界 | Property | P0 |
| SYS-IDX-007 | npm/Yarn/pnpm recognized/single/degraded 语义与跨 package import | API | P1 |
| SYS-IDX-008 | BuiltinIgnoreV1、`.codegraphignore` grammar、generation 0、last-valid、重新纳入稳定 ID | Unit/API | P1 |
| SYS-IDX-009 | save、checkout、事件风暴、overflow、hash 未变与 reconciliation 收敛 | Process/API | P0 |
| SYS-IDX-010 | 新增/移动/删除/配置变化与完整 rebuild 的差分等价 | Integration | P1 |
| SYS-IDX-011 | 1 跳、方向、100/200 预算、3/500/1000 硬上限、聚合和 expand token 稳定 | Unit/API | P0 |
| SYS-IDX-012 | ≥500 corpus 达到 micro-F1 ≥0.80、high-confidence precision ≥0.90 | Benchmark | P0 |
| SYS-IDX-013 | BasicSymbolV1 只含允许的顶层稳定声明，明确排除成员/局部/import alias/references | Unit/Golden | P0 |
| SYS-IDX-014 | ProjectionMembership、CycleProjection、FindingAttribution、OverviewMetric 共用唯一 membership 与稳定排序 | Property/API | P0 |

### VS Code & Webview UX（10）

| ID | 原子场景 | Level | Priority |
| --- | --- | --- | --- |
| SYS-UI-001 | 未授予 Workspace Trust 时零项目读取、零服务、零 Git，仅提供管理 Trust 动作 | VS Code E2E | P0 |
| SYS-UI-002 | stopped/starting/running、absent/current/stale/partial/failed/cancelled 在各 surface 一致 | Component/E2E | P1 |
| SYS-UI-003 | Overview 列表/图使用权威 dependencyStrength、热点、循环和正式/非正式排名 | Component | P1 |
| SYS-UI-004 | Current Context 区分正向/反向/package/Node built-in，支持 180s 任务 | Component/E2E | P1 |
| SYS-UI-005 | 跟随编辑器、ContextLock、Webview reload 恢复及窗口/重启清除 | Component | P2 |
| SYS-UI-006 | 文件/目录/BasicSymbol 导航、Entity Details、缺失/越界恢复提示 | Component/E2E | P1 |
| SYS-UI-007 | 图/列表任务等价、固定键盘语义、读屏字段、24×24、高对比和减少动态 | Component/E2E/Manual | P1 |
| SYS-UI-008 | patch 三时钟/身份失配全量重取，刷新保留中心、选择、缩放、展开和滚动 | Component/API | P1 |
| SYS-UI-009 | 1024/900/899/600/599/360/359 px、200% 字号、主题下无裁切或水平溢出 | Visual/Component | P2 |
| SYS-UI-010 | zh-CN/en、Command Palette、候选快捷键冲突、Accessibility Help 与三平台辅助技术矩阵 | E2E/Manual | P1 |

### Rules & Findings（6）

| ID | 原子场景 | Level | Priority |
| --- | --- | --- | --- |
| SYS-RULE-001 | rules v1 重复 ID、未知字段/type、缺失字段、非法枚举的精确 YAML 诊断 | Unit/Golden | P1 |
| SYS-RULE-002 | forbidden-dependency/layer-order 在 index exclude 与 rules ignore 差异下唯一 Finding | Unit | P1 |
| SYS-RULE-003 | file/directory/package no-cycle、自环、SCC 与确定性证据路径 | Property | P1 |
| SYS-RULE-004 | invalid/partial/stale/cancel/rebuild 下 active/resolved/stale/comparison 生命周期 | API/Model | P1 |
| SYS-RULE-005 | Problems/Findings/详情共享定位、actual/expected、severity、comparison 合同 | Component/E2E | P1 |
| SYS-RULE-006 | ≥30 案例达到 recall=precision=1.00、error 漏报=0、负对照误报=0，IDE/CLI 一致 | Benchmark/Contract | P1 |

### Git Impact & Export（7）

| ID | 原子场景 | Level | Priority |
| --- | --- | --- | --- |
| SYS-IMP-001 | working tree/staged/base ref/rename/delete 与无 Git 状态规范化 | Git Integration | P1 |
| SYS-IMP-002 | canonical baseRef/baselineId 与临时比较不推进主 graph/findings revision | API | P1 |
| SYS-IMP-003 | PR Markdown 固定字段、相对 POSIX 路径、完整不可变 artifact、默认无源码 | API/Review | P1 |
| SYS-IMP-004 | requested/effective policy、include-source 单请求授权、containsSource、失败无部分内容 | Security/API | P0 |
| SYS-IMP-005 | Changes/PR Summary 只呈现本次结构影响并可导航 | Component/E2E | P2 |
| SYS-IMP-006 | impact/export 文本、JSON、Markdown 复用同一 revision、artifactId 和 contentDigest | CLI/API | P1 |
| SYS-IMP-007 | CycleDelta/ImpactVerdict/ImpactRank 在 VS Code、CLI、Markdown 完全一致且客户端不重算 | Contract/Golden | P0 |

### NFR, CI, Release & Product Evidence（15）

| ID | 原子场景 | Level | Priority |
| --- | --- | --- | --- |
| SYS-NFR-SEC-001 | 路径、symlink、token、恶意 YAML、Webview 消息与安全硬上限负向/fuzz | Security | P0 |
| SYS-NFR-PRIV-001 | 默认零远程连接；日志/CLI/IPC/导出/VSIX/SBOM 无敏感字段 | E2E/Scan | P0 |
| SYS-NFR-PERF-001 | clean cache 首次 Overview p95 ≤60s | Benchmark | P0 |
| SYS-NFR-PERF-002 | warm 邻域 p95 ≤300ms；save→revision p95 ≤2s | Benchmark/E2E | P0 |
| SYS-NFR-PERF-003 | 索引/查询/规则/布局/取消期间 extension host 与 Webview 无不可接受长任务 | Profiler | P1 |
| SYS-NFR-REL-001 | 长时保存、分支切换、断连、重连、取消、重启无死锁或 revision 漂移 | Soak/Chaos | P1 |
| SYS-NFR-CAP-001 | 20k 文件、1k rules、64 Jobs、3/500/1000 上限友好拒绝或降级 | Capacity | P1 |
| SYS-NFR-PKG-001 | 四平台与 VS Code 三版本真实候选离线安装/启动/升级/降级/卸载 | Platform E2E | P0 |
| SYS-NFR-MAINT-001 | architecture-required、适用子 gate、无空测试/永久 skip、依赖边界与 Schema diff | CI/Static | P1 |
| SYS-NFR-A11Y-001 | WCAG 2.2 AA、axe、键盘、主题、200%、NVDA/VoiceOver/Orca 证据 | E2E/Manual | P1 |
| SYS-NFR-PROD-001 | SM-1/6/7/8 与 UJ-5 的样本、剔除、评分、ground truth 和失败样本 | Product Research | P1 |
| SYS-NFR-RES-001 | 4 GiB/75%、空闲 1%/1.5 GiB、2 GiB/100 MiB、8h RSS 增长 ≤20% | Resource/Soak | P0 |
| SYS-NFR-RELSET-001 | 两次 clean checkout payload 一致、target matrix 完整、SBOM/trust/signature 有效 | Release Security | P0 |
| SYS-NFR-VAL-001 | plan/policy/manifest/evidence/result/candidateRef 断链、冲突和错误 phase 均 invalid | Contract/Property | P0 |
| SYS-NFR-TRACE-001 | 61/61 DAG 唯一、无环、唯一根；FR/NFR/AR/UX-DR/Story/gate 双向追踪无漂移 | CI/Graph | P0 |

## Priority Allocation

### P0 — 7 个阻断主题组 / 28 个原子场景

| Group | 原子场景 | 阻断理由 |
| --- | --- | --- |
| P0-G01 快照正确性 | SYS-ARC-006、SYS-ARC-007、SYS-IDX-006、SYS-IDX-009 | 所有后续能力依赖已提交快照可信 |
| P0-G02 性能与资源 | SYS-NFR-PERF-001、SYS-NFR-PERF-002、SYS-NFR-RES-001 | PRD/NFR 明确 blocking 门槛 |
| P0-G03 结构事实准确性 | SYS-IDX-003、SYS-IDX-004、SYS-IDX-005、SYS-IDX-012、SYS-IDX-013、SYS-IDX-014 | 产品事实、投影与成功指标的唯一 oracle |
| P0-G04 安全与隐私 | SYS-ARC-003、SYS-UI-001、SYS-IMP-004、SYS-NFR-SEC-001、SYS-NFR-PRIV-001 | 无安全绕行和泄露容忍度 |
| P0-G05 平台与发布信任 | SYS-NFR-PKG-001、SYS-NFR-RELSET-001 | 候选必须完整、离线、可复现、可验证 |
| P0-G06 CI 与候选适用性 | SYS-ARC-011、SYS-ARC-012、SYS-NFR-VAL-001、SYS-NFR-TRACE-001 | 任一 invalid 或追踪漂移必须 No-Go |
| P0-G07 核心自动化合同 | SYS-ARC-009、SYS-IDX-002、SYS-IDX-011、SYS-IMP-007 | Alpha CLI、预算内查询和唯一影响结论 |

### P1 — 33 个原子场景

SYS-ARC-001、SYS-ARC-002、SYS-ARC-004、SYS-ARC-005、SYS-ARC-008、SYS-ARC-010；SYS-IDX-001、SYS-IDX-007、SYS-IDX-008、SYS-IDX-010；SYS-UI-002、SYS-UI-003、SYS-UI-004、SYS-UI-006、SYS-UI-007、SYS-UI-008、SYS-UI-010；SYS-RULE-001、SYS-RULE-002、SYS-RULE-003、SYS-RULE-004、SYS-RULE-005、SYS-RULE-006；SYS-IMP-001、SYS-IMP-002、SYS-IMP-003、SYS-IMP-006；SYS-NFR-PERF-003、SYS-NFR-REL-001、SYS-NFR-CAP-001、SYS-NFR-MAINT-001、SYS-NFR-A11Y-001、SYS-NFR-PROD-001。

### P2 — 3 个原子场景

SYS-UI-005、SYS-UI-009、SYS-IMP-005。

### P3 — 0

当前没有以 P3 承载的发布义务；探索性测试可追加，但不能替代上述 64 个规划场景。

## Requirement Traceability

### FR Coverage

| FR | Planned Scenarios |
| --- | --- |
| FR-1 | SYS-IDX-002、SYS-IDX-007、SYS-IDX-008、SYS-ARC-005 |
| FR-2 | SYS-IDX-003～007、SYS-IDX-012、SYS-IDX-013 |
| FR-3 | SYS-ARC-006/007、SYS-IDX-009/010、SYS-UI-008、SYS-NFR-PERF-002 |
| FR-4 | SYS-IDX-008、SYS-RULE-002、SYS-NFR-SEC-001 |
| FR-5 | SYS-ARC-006/008/010、SYS-IDX-001/005/006、SYS-NFR-REL-001 |
| FR-6 | SYS-IDX-014、SYS-UI-003、SYS-NFR-PROD-001 |
| FR-7 | SYS-IDX-011/014、SYS-UI-004、SYS-NFR-PERF-002 |
| FR-8 | SYS-UI-005/008 |
| FR-9 | SYS-IDX-013、SYS-UI-006、SYS-RULE-005 |
| FR-10 | SYS-UI-003/004/007/009、SYS-IMP-005、SYS-NFR-A11Y-001 |
| FR-11 | SYS-IDX-014、SYS-RULE-003/006、SYS-IMP-007 |
| FR-12 | SYS-RULE-001～006、SYS-IDX-008 |
| FR-13 | SYS-RULE-004/005、SYS-NFR-PERF-002 |
| FR-14 | SYS-IDX-005/014、SYS-RULE-002～005、SYS-IMP-007 |
| FR-15 | SYS-ARC-009、SYS-RULE-006 |
| FR-16 | SYS-IMP-001/002/007 |
| FR-17 | SYS-IMP-002/005/007 |
| FR-18 | SYS-IMP-003/004/007、SYS-NFR-PROD-001 |
| FR-19 | SYS-UI-001、SYS-IMP-004、SYS-NFR-PRIV-001 |
| FR-20 | SYS-ARC-009、SYS-IMP-006/007、SYS-NFR-PKG-001 |
| FR-21 | SYS-ARC-002/008、SYS-IDX-011/014、SYS-UI-008 |
| FR-22 | SYS-ARC-004/005/010、SYS-UI-002、SYS-NFR-REL-001 |
| FR-23 | SYS-IMP-003/004/006、SYS-NFR-PROD-001 |

### Grouped Cross-Reference

| Planning IDs | Primary Scenarios |
| --- | --- |
| NFR-1～7、26 | SYS-NFR-PERF-001/002、SYS-NFR-RES-001、SYS-NFR-CAP-001 |
| NFR-8～11、27 | SYS-ARC-002/004～007/010、SYS-NFR-REL-001 |
| NFR-12～16 | SYS-ARC-003、SYS-UI-001、SYS-IMP-004、SYS-NFR-SEC-001/PRIV-001 |
| NFR-17～20 | SYS-UI-007/009/010、SYS-NFR-A11Y-001 |
| NFR-21～25 | SYS-ARC-001/008、SYS-NFR-PKG-001/RELSET-001 |
| AD-1～24 | SYS-ARC-001～010、SYS-IDX-001～011、SYS-RULE-001～005、SYS-IMP-001～006 |
| AD-25～27 | SYS-IDX-013/014、SYS-IMP-007 |
| AD-28 | SYS-ARC-011、SYS-NFR-MAINT-001、SYS-NFR-TRACE-001 |
| AD-29 | SYS-NFR-PKG-001、SYS-NFR-RELSET-001 |
| AD-30 | SYS-ARC-012、SYS-NFR-VAL-001、SYS-NFR-PROD-001 |
| UX-DR1～18 | SYS-UI-003～010、SYS-IMP-003～007 |
| UX-DR19～37 | SYS-UI-001～010、SYS-NFR-A11Y-001、SYS-NFR-PERF-002/003 |
| SM-1～SM-8、UJ-5 | SYS-IDX-012、SYS-RULE-006、SYS-NFR-PROD-001、SYS-NFR-VAL-001 |
| Story DAG / 双向追踪 | SYS-NFR-TRACE-001、SYS-ARC-011/012 |

## Execution Strategy

### Every PR

- `architecture-required` 必须 always-run，执行 type、lint、unit、build、contract、dependency-boundary、basic-security，并聚合 GateRegistry 判定为 required 的真实子 gate。
- 快速 Unit/Property/Contract/CLI/API/Component 测试均进入 PR；P0 失败快速终止，但证据仍需归档。
- provider base/head、`git merge-base --all`、gateRegistryDigest、evaluationContextDigest 和 GateEvidence producer 必须匹配；陈旧 head 证据不可复用。
- 尚未实现的能力返回 not-applicable；不得创建空测试、永久 skip、无断言或固定成功脚本假装 pass。

### Nightly

- 全量 API/Process/VS Code Electron、随机事件、故障注入、安全 fuzz、敏感信息扫描、中型性能与资源趋势。
- 运行多平台最小安装、Schema N/N-1/invalid corpus、DAG/追踪 drift 和 release contract property tests。

### Weekly / Release Candidate

- 标准规模完整 BenchmarkPlan、8 小时资源会话、准确率全 corpus、RulesValidationFixture、soak/chaos。
- 四平台离线安装/升级矩阵、两次 clean checkout 可复现构建、SBOM/release set/trust/signature 审计。
- 真实 Webview 三版本/主题/宽度/字号/辅助技术证据；产品研究按冻结的 ProductValidationPlan 执行。

### Release Slice Gates

- **Alpha:** 可信 CLI rebuild/query/status/doctor/cache、基础循环、正确性和真实 CI。
- **Beta:** VS Code Overview/Current Context、SM-1、SM-7、真实 Webview 阻断矩阵；Beta 不得表述为完整 MVP。
- **Beta+:** 固定 ReadinessGateManifestV1 展开 FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8、适用 AR/UX-DR 与发布完整性；全部 blocking gate pass 才能 Go。
- **v1.1 entry:** 仅在 UJ-5 价值门禁通过后允许启动 MCP/后续候选；不反向扩大 MVP。

## QA/SDET Effort Estimate

仅估算测试设计、fixture、自动化、证据流水线和稳定化，不包含产品实现、runner 采购、签名密钥治理或参与者招募等待。

| Priority | Count | Estimate |
| --- | ---: | --- |
| P0 | 7 组 / 28 原子场景 | 约 300～460 小时 |
| P1 | 33 原子场景 | 约 220～360 小时 |
| P2 | 3 原子场景 | 约 24～56 小时 |
| P3 | 0 | 0 |
| **Total** | **64 原子场景** | **约 544～876 小时，约 14～22 QA/SDET 人周** |

该区间较旧版增加，主要来自 AD-28～30、NFR-26/27、UX-DR36/37、可复现 release set、签名信任链、版本化产品验证和 61 Story 追踪门禁。

## Implementation Planning Handoff

| Work Item | Owner | 依赖 |
| --- | --- | --- |
| GateRegistry/Context/Evidence property corpus 与 provider drift harness | QA + Dev Enablement | Story 1.1～1.3 |
| scheduler/watcher/SQLite/IPC/进程故障注入和隔离 fixture | QA + Core | Story 1.19 前 |
| TS/JS ≥500 标注 corpus、Rules ≥30 fixture、统计器 | QA + Analyzer/Rules | Story 1.8、3.6 |
| BenchmarkPlan、资源 manifest、标准规模/8h harness | QA + Performance | Story 5.6 |
| Webview 三版本/主题/宽度/字号/辅助技术矩阵 | QA + UX/Extension | 首个 Webview、Story 5.5 |
| 平台安装、可复现 payload、SBOM、trust/signature 验证 | QA + Release/Security | Story 5.1～5.10 |
| ProductValidationPlan/Evidence/Result 与 readiness compiler corpus | QA + Product Validation | Story 5.11/5.12 |
| 61 Story DAG 和 FR/NFR/AR/UX-DR 双向追踪门禁 | QA + Architecture/PO | Story 1.3 起 |

---

**Generated by:** BMad TEA Master Test Architect  
**Workflow:** `bmad-testarch-test-design` Edit Mode  
**Version:** 5.0 — 2026-07-16 corrected planning baseline
