---
title: Reviewer Gate — Readiness Update Adversarial Divergence
date: 2026-07-15
review_type: adversarial-divergence
status: complete
target: ../ARCHITECTURE-SPINE.md
---

# Reviewer Gate — Readiness Update Adversarial Divergence

## Verdict

**FAIL：发现 1 个 critical、4 个 high。** AD-25..AD-28 已把 readiness 报告要求的能力名称、基本判定和交付时点写入脊柱，AD-23 也已明确首次 Job 必须绑定与 `.codegraphignore` 实际存在状态一致的 snapshot；但仍能构造多个下一级实现单元，各自逐字遵守现有 AD，却在共享实体所有权、循环与指标投影、ignore 生效范围、Impact verdict、性能验收和 CI 阻断结果上产生不兼容输出。

## 最高优先发现

| ID | 级别 | 涉及 AD | 结论 |
| --- | --- | --- | --- |
| ADV-C1 | Critical | AD-3、AD-4、AD-27 | 跨文件 TypeScript declaration merge 没有唯一 ownership，增量删除可误删仍由另一文件声明的 BasicSymbol。 |
| ADV-H1 | High | AD-7、AD-9、AD-17、AD-25 | directory 投影成员关系和 Finding→Overview 节点归属未固定，SCC、strength 与热点排名仍可分叉。 |
| ADV-H2 | High | AD-3、AD-9、AD-14、AD-23、AD-25 | ignore 的跨重启 last-valid 权威来源及 rules ignore 的投影前过滤语义未闭合。 |
| ADV-H3 | High | AD-17、AD-25、AD-26 | “新增基础循环”没有基线比较合同，完全相同的变更可得到 pass 或 review。 |
| ADV-H4 | High | AD-19、AD-28 | 性能与 CI 只有门禁名称，没有唯一可执行判定协议，两个门禁实现可对同一提交给出相反结论。 |

## 对抗案例与证据

### ADV-C1 — BasicSymbol 跨文件合并与 per-file ownership 冲突

**涉及：** AD-3（第 71 行）、AD-4（第 77 行）、AD-27（第 215 行）。

构造两个顶层全局脚本文件：

```ts
// a.ts
namespace Tools { export function a() {} }

// b.ts
namespace Tools { export function b() {} }
```

TypeScript 权威 symbol 会把两个 `Tools` 声明合并。AD-27 要求“多声明绑定”合并为一个 `symbolId`；同时 AD-3 又规定 `source:<analyzerKind>:<fileId>` ownership slice 拥有“该文件声明的 symbol”。现有合同没有规定跨文件 merged symbol 的唯一 owner，也没有规定其 singular `kind`、qualified name/signature digest 应从哪个声明集合计算。

两个严格合规的下一级单元：

- **单元 A（全量 Analyzer）**：按 AD-27 合并为一个 BasicSymbol，使用首个可导航声明 `a.ts` 作为记录与 ownership owner。
- **单元 B（增量 slice/GraphPatch）**：按 AD-3 认为 `b.ts` 的 source slice 拥有其声明的同一 merged symbol，因此在 `b.ts` 的 complete FactBatch 中 upsert 同一个 `symbolId`。

两者都遵守“TS symbol 合并”和“文件 slice 拥有该文件声明的 symbol”，但删除或重分析任一文件时，store 可以删除另一文件仍在声明的共享 symbol、出现重复 owner，或在导航 `relativePath/range` 上 latest-wins。下游 symbol-centered query、NavigationTargetV1 和导出因此不稳定。

**必须收紧：** 二选一固定为架构合同：V1 排除跨文件 ambient/global declaration merge；或引入 canonical merged-symbol owner/声明 Evidence（例如一个稳定 aggregate slice，文件 slice 只拥有 declaration evidence），并固定 merged `kind`、`exported`、signature digest 与导航声明选择顺序。仅靠合同测试无法替代 owner 决策。

### ADV-H1 — Cycle/Overview 没有共享的聚合成员与 Finding 归属

**涉及：** AD-7、AD-9、AD-17、AD-25。

给定嵌套目录中的两条 high-confidence imports：

```text
src/features/cart/ui/a.ts -> src/shared/state/b.ts
src/shared/state/b.ts     -> src/features/cart/ui/a.ts
```

两个严格合规的下一级单元：

- **单元 A（application/cycles）**：directory scope 把文件折叠到直接父目录 `src/features/cart/ui` 与 `src/shared/state`。
- **单元 B（application/querying/Overview）**：directory scope 把文件折叠到当前 scope root 下的第一层目录 `src/features` 与 `src/shared`。

两者都使用规范 directory node、先折叠端点、去重并移除聚合自边，符合 AD-25；但 `projectionId`、SCC 成员、`cycleMemberCount`、`dependencyStrength` 与排名均不同。AD-25 没有给出 `scope root + fileId -> aggregateNodeId` 的唯一成员函数。

即使聚合层级碰巧一致，热点的 `active error/warning 数` 仍没有 Finding 到聚合节点的归属规则。单边 Finding 可以只计 source、同时计 source/target，或向所有 ancestor 汇总；SCC Finding 可以每个 member 计一次或整个 SCC 只计一次。每种实现都复用同一 Finding，却会产生不同热点排序。

**必须收紧：** 固定版本化的 `ProjectionMembershipV1`（scope、scopeRoot、端点到 aggregate node 的唯一映射）并由 CycleProjectionKernel 与 OverviewMetric 共用；固定 edge/SCC Finding 对 file、directory、workspace-package 节点的计数归属和 ancestor roll-up 规则。

### ADV-H2 — ignore 在跨重启 fallback 和规则投影顺序上仍可分叉

**涉及：** AD-3、AD-9、AD-14、AD-23、AD-25。

#### 案例 A：服务停止期间 valid → invalid

1. 上一服务实例最后有效 `.codegraphignore` 排除了 `generated/**`。
2. 服务退出后，文件被改为非法 UTF-8。
3. 新服务发现“文件存在且 invalid”。

两个严格合规的 bootstrap 单元：

- **单元 A**：从缓存恢复上一实例的完整 last-valid `userRules/effectiveRules`，继续排除 `generated/**`。
- **单元 B**：把新 `statusEpoch` 中第一次读到 invalid 解释为 AD-14 的“首次 invalid”，使用空用户规则 + BuiltinIgnoreV1。

AD-23 现在已正确要求 snapshot 与文件实际存在状态一致，但 AD-14 没有规定“首次”的跨 epoch 含义、last-valid 完整规则的持久化位置/owner，以及只存 `lastValidDigest` 时如何恢复可执行规则。A/B 会索引不同文件，继而产生不同节点、边、成功指标和 Findings。

#### 案例 B：rules.yaml ignore 与 no-cycle 聚合

规则 ignore 为 `**/*.test.ts`，测试文件参与一条跨目录回边。单元 A 在 file graph 上先移除命中节点及 incident edges，再做 directory SCC；单元 B 先折叠 directory，再用 glob 匹配聚合目录实体。两者都可以声称“应用 rules ignore 后复用 Kernel”，但一个无循环、一个有循环。

**必须收紧：** 指定跨进程 last-valid snapshot 的权威存储与恢复规则；明确首次 invalid 是“历史上没有任何可恢复的 valid snapshot”而非“当前 epoch 第一次 invalid”。另外固定 `RulesEvaluationScopeV1`：glob 匹配的实体层级、edge 任一端命中时的处理、以及必须在 file graph 过滤后再进行 directory/package projection 的顺序（或选择另一唯一顺序）。

### ADV-H3 — “新增基础循环”没有唯一 baseline/delta 身份

**涉及：** AD-17、AD-25、AD-26。

基线图的循环 SCC 为 `{A,B,C}`，当前变更后为 `{A,B}`。AD-25 的 `projectionId` 哈希 scope 与 SCC node IDs，因此 ID 必然变化；但 AD-26 只说“新增基础循环”触发 review，没有规定 SCC 分裂、合并、缩小、扩大时 new/existing/resolved 的比较规则。

两个严格合规的 application/impact 单元：

- **单元 A**：按 `projectionId` 精确相等比较，当前 `{A,B}` 是新增循环，verdict=`review`，canonical risk ID 使用新 projectionId。
- **单元 B**：按 SCC 节点重叠/包含关系比较，把 `{A,B}` 视为既有 `{A,B,C}` 的延续；若无 warning/error，verdict=`pass`，risk 归入 existing 或不进入主要风险。

两者均不重算 Finding、均复用 CycleProjectionKernelV1，仍对相同变更给出相反 verdict；`majorRisks` 与 `keyPaths` 的排序也会因“循环 canonical risk ID”未定义而不同。

**必须收紧：** 增加 `CycleComparisonV1/CycleDeltaV1`，固定 baseline 来源、SCC exact/split/merge/overlap 的 new/existing/resolved 规则，以及循环 risk 的 canonical ID。ImpactVerdictV1 只能消费该 delta，不能由 impact 实现自行解释。

### ADV-H4 — AD-19/28 的门禁没有唯一测试 oracle

**涉及：** AD-19、AD-28。

#### 性能

- **单元 A（graph-service benchmark）**：使用 500 文件、50 package 的 fixture，计时从 RPC dispatch 到 cached response，报告多轮平均值 280ms。
- **单元 B（VS Code E2E）**：使用 5000 文件、1 package 的 fixture，计时从文件打开事件到等价列表首次可交互，报告 p95 420ms。

两者都在“最多 5000 文件/50 package”的标准范围内，也都测试“缓存邻域”，但对 300ms 门禁结论相反。60s 首次概览和 2s 保存更新同样没有固定 start/end、warm/cold 条件、重复次数/分位数及唯一版本化 workload。AD-19 的 Prevents 声称避免各模块用不同口径，但 Rule 尚不能做到。

#### CI

- **单元 A（contracts Story）**：把“能力首次落地”定义为 DTO/Schema 首次提交，此时加入 package contract test。
- **单元 B（入口 Story）**：把“能力首次落地”定义为首个可调用 RPC/CLI surface，之后才加入端到端 gate。

两者都能引用 AD-28。与此同时，`contract`、`basic-security`、规划引用一致性等 gate 没有固定检查清单、输入范围、required-check identity 或 owner；两个 workflow 即使都存在，也可能因 path filter/branch protection 只让其中一个真正阻止合并。

**必须收紧：** 为 AD-19 绑定版本化 fixture/workload 与 timing protocol（起止点、冷暖状态、统计量、重复次数、硬件校准）；为 AD-28 绑定单一 CI gate manifest/owner、稳定 required check IDs、触发范围，以及每类能力“首次落地”的可判定事件。否则“提交真实门禁”和“失败阻止合并”仍是不可验证陈述。

## 已复核且本轮未形成 critical/high 的收紧

- **AD-23 首次 Job 屏障：** 当前文本已明确 `.codegraphignore` 缺失才可建立 generation=0，存在文件必须按 valid/invalid/last-valid 建 snapshot；“提前切片把存在文件当缺失基线”的原分歧已关闭。ADV-H2 只针对跨实例 last-valid 的权威恢复来源，不否定该收紧。
- **AD-10 ContextLock：** extension-host 会话内持有、Webview reload 可恢复、窗口/宿主重启清除的边界已经可形成唯一结果。本轮未把筛选/范围持久化的 owner 措辞列为 high；实现时仍应由扩展持有影响 queryFingerprint 的语义状态。
- **AD-14 原文件唯一解释者：** scanner/analyzer/doctor/CLI/UI 不得二次解析 `.codegraphignore` 已关闭多 owner；剩余问题是服务自身在跨 epoch fallback 时选择哪份可执行 last-valid 规则。

## Gate 结论

本轮 adversarial divergence **FAIL**。在 ADV-C1、ADV-H1、ADV-H2、ADV-H3、ADV-H4 收紧前，两个下一级实现单元仍可逐字遵守全部现有 AD，却产生不兼容的图谱状态、循环/排名、ignore 范围、Impact verdict 与合并门禁。此报告未修改 Architecture Spine 或 Implementation Guide。
