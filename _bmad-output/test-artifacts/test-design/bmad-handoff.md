---
title: 'TEA Test Design → BMAD Handoff Document'
version: '2.0'
workflowType: 'testarch-test-design-handoff'
inputDocuments:
  - '_bmad-output/test-artifacts/test-design-architecture.md'
  - '_bmad-output/test-artifacts/test-design-qa.md'
  - '_bmad-output/test-artifacts/test-design-progress.md'
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/planning-artifacts/implementation-readiness-report-2026-07-16-rerun-3.md'
sourceWorkflow: 'testarch-test-design'
generatedBy: 'TEA Master Test Architect'
generatedAt: '2026-07-16T17:15:33.5318471+08:00'
projectName: 'bmad'
planningBaseline: 'READY / 5 epics / 61 stories / StoryDependencyDagV1'
---

# TEA → BMAD 集成交接

## Purpose

本文把更新后的系统级风险、64 个原子测试场景、质量门禁和证据合同映射到当前 5 个 Epic、61 个 Story。实现与调度必须以 `_bmad-output/planning-artifacts/epics.md` 中的 `StoryDependencyDagV1` 为唯一依赖权威；正文顺序和 Story ID 数值不构成依赖。

## Artifact Inventory

| Artifact | Path | BMAD Integration Point |
| --- | --- | --- |
| 架构测试设计 | `_bmad-output/test-artifacts/test-design-architecture.md` | 风险、不变量、testability seam、架构/发布责任 |
| QA 测试设计 | `_bmad-output/test-artifacts/test-design-qa.md` | 64 场景、优先级、执行频率、证据和需求追踪 |
| 更新进度与差异 | `_bmad-output/test-artifacts/test-design-progress.md` | 修正来源、旧偏差关闭、计数与验证底稿 |
| Epic/Story 权威 | `_bmad-output/planning-artifacts/epics.md` | 5 Epic、61 Story、DAG 与验收条件 |

## Epic-Level Integration Guidance

| Epic | 主要风险 | 必须达到的质量结果 |
| --- | --- | --- |
| Epic 1：构建、查询并恢复可信的本地代码图谱 | R-001/004/005/008/009/011/012/013/018 | Story 1.1～1.3 建立真实 fail-closed CI；确定性 rebuild、原子快照、BasicSymbolV1、准确率、ignore、CLI、基础循环、状态/取消/恢复均有门禁 |
| Epic 2：在 VS Code 中快速理解项目与当前文件影响 | R-002/006/007/010/013/015 | Trust 前零动作；Overview/Current Context 消费权威 Kernel；300ms/2s；图/列表、键盘、响应式、主题、空间记忆和辅助技术证据 |
| Epic 3：在编码时发现并解释架构风险 | R-004/005/006/008/012 | rules v1、last-valid、三类规则、Finding 生命周期、IDE/CLI 一致；≥30 案例达到 recall/precision=1.00 |
| Epic 4：审查变更并导出可共享的结构上下文 | R-007/008/014/017 | canonical baseline；唯一 ImpactVerdict/Rank；完整不可变 artifact；structure-only 默认；多入口不重算 |
| Epic 5：可安装、可升级、可离线使用 | R-002/003/007/009/015/016/017/018 | 四平台/三 VS Code 版本、NFR-26、可复现 payload/SBOM/release set、签名信任链、固定产品验证与 Beta+ Go/No-Go |

## Epic Quality Gates

| Epic | Gate Criteria |
| --- | --- |
| Epic 1 | `architecture-required` 与适用子 gate 真实阻断；无半提交快照；≥500 corpus 达 micro-F1≥0.80、high-confidence precision≥0.90；CLI 合同稳定；无开放 R-001/R-004/R-011 |
| Epic 2 | warm 邻域 p95≤300ms、save→revision p95≤2s；Trust 前零动作；patch 失配全量恢复；真实 Webview 的主题/宽度/200%/键盘证据已产生 |
| Epic 3 | ≥30 rules 案例 recall=precision=1.00；error 漏报=0、负对照误报=0；invalid/partial/stale/cancel 不错误 resolved；CLI/IDE Finding 一致 |
| Epic 4 | Git baseline 不污染主 revision；VS Code/CLI/Markdown verdict 与排序一致；生成失败无部分 artifact；默认无源码和绝对路径 |
| Epic 5 | 性能与 NFR-26 通过；四目标平台离线矩阵通过；release set 可复现且签名链有效；固定 manifest 的全部 blocking gate pass，任一 fail/invalid 为 No-Go |

## Story-Level Test Integration

| Stories | 必须进入验收或同 PR 门禁的测试内容 |
| --- | --- |
| 1.1、1.2、1.3 | always-run `architecture-required`、真实失败阻断、GateRegistry/Context/Evidence、provider required check、禁用 bypass、drift monitor、61 Story DAG 和需求双向追踪 |
| 1.4、1.19 | generation 0 ignore 基线、bootstrap barrier、确定性 rebuild、完整 CAS、GraphPatch/Findings/status 原子提交和过期重排 |
| 1.5、1.6、1.7、1.8、1.9 | 唯一 TS/JS 关系、BasicSymbolV1 边界、Evidence ownership、≥500 corpus 双准确率门槛、workspace recognized/degraded |
| 1.10～1.13 | BuiltinIgnoreV1、grammar、last-valid、invalid 恢复、配置竞争、恶意输入和安全限制 |
| 1.14、1.15、1.16、1.17、1.18 | CLI query/status/doctor/cache、BaseCycleProjectionV1、取消、缓存损坏/服务中断恢复、默认离线和 telemetry 状态 |
| 2.1、2.10 | Workspace Trust、CSP、消息 Schema、Getting Started、Index Status、状态/空态/失败恢复和首个 Webview 阻断矩阵 |
| 2.2、2.3 | ProjectionMembership、dependencyStrength、cycleMemberCount、热点排序、current+complete 正式排名、图/列表等价 |
| 2.4～2.7 | Current Context 预算、Node built-in、ContextLock、Entity Details、BasicSymbol 导航、键盘和空间记忆 |
| 2.8、2.11、2.9 | save 增量 mutation、三时钟 GraphViewPatch、失配全量重取、非模态刷新、telemetry 立即关闭 |
| 3.1～3.4 | rules Schema、CST/range、last-valid、generation/CAS、精确 ConfigDiagnostic 和 YAML 安全限制 |
| 3.5～3.8 | forbidden/layer/no-cycle、唯一 Kernel、Finding ID/lifecycle/comparison、增量重评原子性、RulesValidationFixtureV1 |
| 3.9、3.10 | Problems/Findings/详情/CLI 共享 actual/expected/severity/status/location；退出码与 JSON 稳定 |
| 4.1～4.4 | canonical Git ChangeSet/baseRef/baselineId、CycleDelta、ImpactVerdict/Rank 唯一生产者与稳定排序 |
| 4.5、4.6、4.7 | Changes、PR Markdown、结构导出；完整不可变 artifact；默认 structure-only；失败无部分内容；本地目标重试不改身份 |
| 4.8、4.9 | CLI impact/export 与 VS Code/Markdown 复用同一 verdict/revision/artifact 合同 |
| 5.1～5.7 | CLI/VSIX 离线安装、平台/ABI/VS Code 矩阵、升级降级、性能与 NFR-26、缓存恢复 |
| 5.8、5.9、5.10 | 两次 clean checkout 可复现 payload、规范 SBOM、完整 release set、trust bundle、签名/撤销和 trust anchor |
| 5.11 | 冻结 ProductValidationPlanV1、ReadinessGatePolicy/Manifest、CandidateRef、Evidence/Result Schema 与 digest 引用链 |
| 5.12 | 逐项执行 FR-1～FR-23、NFR-1～NFR-27、SM-1～SM-8、适用 AR/UX-DR 与发布完整性；任一 fail/invalid/缺证据为 No-Go |

## P0 Themes → Story Ownership

| P0 Group | Primary Stories |
| --- | --- |
| P0-G01 快照正确性 | 1.4、1.19、1.7、1.12、2.8、2.11、3.8 |
| P0-G02 性能与资源 | 1.8、2.3～2.5、2.8/2.11、5.6 |
| P0-G03 结构事实准确性 | 1.5～1.9、1.14、2.2/2.3、3.6 |
| P0-G04 安全与隐私 | 1.13、1.18、2.1、2.9、3.4、4.6/4.7、5.2/5.5 |
| P0-G05 平台与发布信任 | 5.1～5.10 |
| P0-G06 CI 与候选适用性 | 1.1～1.3、5.11、5.12 |
| P0-G07 核心自动化合同 | 1.4、1.14、3.10、4.4、4.8/4.9 |

## Risk-to-Story Mapping

| Risk | P×I | Story / Epic | Test Level |
| --- | ---: | --- | --- |
| R-001 | 9 | 1.4、1.19、1.7、1.12、2.8、2.11、3.8 | Property + API/SQLite |
| R-002 | 9 | 1.8、2.2～2.5、2.8、5.6 | Benchmark + Profiler/Soak |
| R-003 | 9 | 5.1～5.7 | Platform E2E |
| R-004 | 9 | 1.5～1.9、1.14、2.2/2.3、3.5/3.6 | Unit/Golden + Benchmark |
| R-005 | 6 | 1.10～1.13、3.1～3.8 | Model + API |
| R-006 | 6 | 1.13、2.1、3.4、5.5 | Security/Fuzz + E2E |
| R-007 | 6 | 1.18、2.9、4.6/4.7/4.9、5.1/5.2/5.8 | Scan + Network + E2E |
| R-008 | 6 | 1.2、1.14、3.10、4.8/4.9、5.3/5.11 | Contract + Compatibility |
| R-009 | 6 | 1.2、1.15～1.17、2.1、5.3/5.7 | Multi-process/Recovery |
| R-010 | 6 | 2.2～2.8、2.11 | Component + Profiler |
| R-011 | 9 | 1.1～1.3 | CI Contract + Provider Integration |
| R-012 | 6 | 1.1、1.19 及各能力首次公开 Story | Fixture/CI Health |
| R-013 | 6 | 1.9、1.14、2.2/2.3、3.6 | Property + API |
| R-014 | 6 | 4.1～4.5、4.8 | Git/API + Golden |
| R-015 | 6 | 2.1～2.7、2.10、2.11、5.5 | Component/E2E + Manual |
| R-016 | 9 | 5.8～5.10、5.12 | Reproducibility + Signature Verification |
| R-017 | 9 | 4.6/4.7、5.11/5.12 | Contract/Property + Product Evidence |
| R-018 | 9 | 1.3、5.11、5.12 | DAG/Trace/Drift Gate |

## Data-TestId & Evidence Identity Guidance

- 优先使用可访问 role/name；canvas、复合列表和宿主无稳定语义位置才增加 `data-testid`。
- 建议固定标识：`codegraph-getting-started`、`codegraph-status`、`codegraph-progress`、`codegraph-overview-graph`、`codegraph-structure-list`、`codegraph-current-context`、`codegraph-findings`、`codegraph-pin-toggle`、`codegraph-changes`、`codegraph-export-preview`、`codegraph-retry`。
- 动态实体使用 `data-node-id` / `data-edge-id` / `data-finding-id`，值为稳定领域 ID；禁止写入源码、绝对路径、token、candidateRef digest 或签名材料。
- 证据主键使用合同规定的 gateEvidenceDigest、artifactId/contentDigest、evidenceId/evidenceDigest、candidateRefDigest、releaseSetId；不得使用时间戳、UI 文本或运行时对象地址代替身份。

## Workflow Sequence

1. **Story 1.1 → 1.2 → 1.3：** 建真实最小 CI、通过最小 CI、再建立完整 gate registry/外部强制/追踪；1.3 完成前不开放功能并行。
2. **Story 实施：** 能力首次通过公共入口或 Schema 暴露时，同一 PR 加入真实适用 gate。
3. **TEA ATDD：** 为 Story P0/P1 AC 创建失败测试或证据型红阶段任务。
4. **TEA Automate：** 扩展 Unit/Property/API/Component/E2E/NFR/Release automation。
5. **TEA Trace：** 验证 FR/NFR/AR/UX-DR/Story/gate/evidence 双向追踪。
6. **Story 5.11 → 5.12：** 冻结验证合同，再对固定候选执行 Go/No-Go；不得在 5.12 临场修改适用性或阈值。

## Phase Transition Quality Gates

| From | To | Gate |
| --- | --- | --- |
| Planning READY | Story 1.1 | 5 Epic/61 Story/DAG 与输入文档版本已确认；不得把 READY 当作产品通过 |
| Story 1.1 | Story 1.2 | 最小 `architecture-required` 已配置、always-run、可真实失败且证据不依赖 1.2 |
| Story 1.2 | Story 1.3 | 同一最小 CI 对真实 Story 1.2 提交通过 |
| Story 1.3 | Functional Stories | gate registry、provider 强制、禁用 bypass、drift monitor、需求追踪全部通过 |
| Story | Implementation Complete | P0/P1 AC 有真实测试/证据；生产代码未绕过唯一核心/合同/门禁 |
| Alpha | Beta | CLI/图谱正确性、基础循环、性能基础、真实 VS Code 首切片和 Beta entry manifest 通过 |
| Beta | Beta+ | SM-1/SM-7 与全部功能/规则/影响/导出/平台能力完成；Beta 不宣称完整 MVP |
| Beta+ Candidate | Release | 固定 ReadinessGateManifest 的全部 blocking gate pass；release set/签名/产品验证完整；任一 fail/invalid 为 No-Go |
| Beta+ | v1.1 Candidate | UJ-5 价值门禁通过；仅解锁后续候选，不改变已发布 MVP 定义 |

## Handoff Completion

- 当前交接已从旧版 4 Epic/29 Story 更新到 5 Epic/61 Story。
- 所有旧 Story 映射已替换；新增覆盖 AD-25～30、NFR-26/27、UX-DR36/37、渐进式 CI、release trust、product validation 和 DAG/追踪。
- 实现代理、测试代理和发布代理应共同引用本文件、两份测试设计以及 `StoryDependencyDagV1`，不得从旧交接或文档顺序推断范围。
