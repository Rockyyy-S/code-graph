---
title: Architecture Spine Good-spine Rubric Review — Round 2
date: 2026-07-13
reviewer: rubric-walker-round2
verdict: fail-revise
scope: ../ARCHITECTURE-SPINE.md
---

# Good-spine Rubric Review — Round 2

## Verdict

**FAIL — 首轮 5 项 High 中 4 项已在 High 等级闭合，但稳定身份仅部分闭合；本轮仍发现 3 项 High，均会让遵守现有 AD 的下一级单元产生数据删除、revision 或公开 ID 不兼容。**

确定性 lint 再次通过，0 个机械问题。本报告只列仍达到 Critical/High 的发现；未发现 Critical。

## 首轮 High 闭合检查

| 首轮 finding | 结果 | 第二轮证据 |
| --- | --- | --- |
| H-01 indexing root / multi-root 服务所有权冲突 | **Closed** | AD-2 已把唯一所有权单位固定为 `indexing root`，multi-root 明确为多个独立服务。图示仍使用“工作区”旧措辞，但不足以维持 High。 |
| H-02 Edge / Finding 稳定身份不完整 | **Partially closed** | AD-4 已补 canonical edge tuple，AD-17 已补单边与有向循环 canonicalization；external package 身份仍未闭合，见 R2-H3。 |
| H-03 多客户端共享配置无所有者 | **Closed** | AD-22 固定服务持有 `EffectiveServiceConfig/configRevision`，显式 reconfigure、Job 边界原子应用、请求级与会话级偏好分离。 |
| H-04 生命周期、升级交接、缓存权限与资源护栏缺失 | **Closed** | AD-11 固定缓存权限和资源硬限制；AD-23 固定锁、stale metadata、空闲退出、控制协议和优雅升级交接。 |
| H-05 SM / Beta gate / 范围覆盖缺口 | **Closed at High** | AD-19 已绑定 SM-1..SM-8、Beta monorepo 边界和真实团队验证。Capability Map 的 `SM-1..SM-6` 旧行属于较低级追踪残留，不再构成 High。 |

## Remaining High Findings

### R2-H1 — `ownershipSliceId` 没有 canonical owner boundary，`complete` 批次可合法误删其他事实

**位置：** AD-3、AD-5、AD-21。

AD-3 通过 `ownershipSliceId + coverage` 决定删除语义：`complete` 批次中缺失的旧事实会被删除。这一机制要阻止“跨来源误删”，前提是所有分析器对 slice 的边界有同一理解，但脊柱没有规定 `ownershipSliceId` 的组成、粒度和跨 analyzer version 的稳定性。

两个实现都可遵守 AD-3：

- 实现 A 使用 `analyzer family + source file` 作为 slice；
- 实现 B 使用 `tsconfig/project` 作为 slice，并在单文件增量分析后标记 complete。

实现 B 会把同一 project 中未出现在当前 FactBatch 的其他文件事实合法删除。若把 `analyzerVersion` 纳入 slice，又会在升级后留下旧版本事实无法回收。事务原子性只能保证“完整地误删”，不能修复所有权错误。

**处置：autofix。** 固定 slice canonical form 与签发者：至少包含稳定 analyzer family、indexingRoot、fact domain 和逻辑输入单元；明确 analyzerVersion 不改变 owner identity；project-global facts 与 file-local facts必须使用不同 slice kind。只有持有该 slice 的 AnalyzerPort 实现可以发布 complete/tombstone。

### R2-H2 — 引入 `findingsRevision` 后，CLI、导出、Job、约定和 ERD 仍使用单一 `revision`

**位置：** AD-3、AD-7、AD-8、AD-13、AD-17、AD-18、Consistency Conventions、ERD。

AD-3 正确地允许规则配置变化只推进 `findingsRevision`、不推进 `graphRevision`；AD-7 的 ViewModel/patch 也同时携带两者。但其他公共契约未同步：

- AD-13 的 CLI envelope 只要求 `graphRevision`；
- AD-18 的 PR/AI 导出只写未定名的 `revision`；
- AD-8 仍使用单一 Job base revision 表述；
- Time and revisions 约定仍称所有结果携带一个 `revision`；
- ERD 只有 `GRAPH_REVISION → FINDING`，没有 findings revision；
- AD-17 依赖 `base findings revision`，但 Job/CLI 合同没有提供它。

因此规则配置改变、图谱未改变时，CLI check、PR 导出和 IDE 可以共享相同 graphRevision，却观察到不同 Findings；缓存、幂等和“新增/既有”比较将产生不兼容结果。

**处置：autofix。** 所有携带 Findings 或规则评估结果的 DTO、Job、CLI envelope、导出和缓存键必须同时携带 `graphRevision` 与 `findingsRevision`；纯图查询可只依赖 graphRevision。更新 ERD 与通用 revision 约定，禁止未限定的裸 `revision`。

### R2-H3 — external package 的稳定 ID 仍无规范，pnpm/npm 解析可产生不同公共图谱

**位置：** AD-4、AD-5、AD-19、Structural Seed。

AD-4 规定“package ID 由类型与路径确定”，适用于 workspace package，但没有定义外部 npm package 的“路径”是什么。外部依赖可能被实现为：

- import specifier / package name；
- 解析后的 `node_modules` 真实路径；
- pnpm store/symlink 物理路径；
- `name@resolvedVersion`；
- workspace 内一次安装实例。

这些方案都会遵守当前文字，却在 pnpm、hoisting、多版本依赖和 lockfile 变化时产生不同节点、Edge ID、聚合依赖和导出 ID。FR-2/SM-4 所需的外部包依赖是 MVP 主路径，因此不能留给各 adapter 自行选择。

**处置：discuss / tighten AD-4。** 区分 `workspace-package` 与 `external-package` ID。固定 external package 是否以规范包名、resolved version 和 package-manager resolution identity 组成；明确 scoped package、subpath import、同包多版本和未解析 bare specifier 的降级身份。物理 store 路径不得成为跨重建稳定身份。

## Good-spine Checklist — Round 2

| Checklist item | Result | High-level judgment |
| --- | --- | --- |
| 固定 initiative 下一级真实分叉点 | **Fail** | 服务与配置所有权已闭合；Fact ownership slice 与 external package identity 仍可分叉。 |
| 每个 AD Rule 可执行并实现 Prevents | **Fail** | AD-3 的删除安全依赖未定义 slice；AD-4 仍不能为全部 MVP package 生成一致 ID。 |
| Deferred 不产生兼容性分叉 | **Pass at High** | 本轮未发现 Deferred 中仍达到 High 的兼容性分叉。 |
| 覆盖 FR/NFR/能力 | **Pass at High** | AD-19 已补主要性能、SM 与 Beta 边界；残余追踪问题未达 High。 |
| 部署、环境、运维、安全 | **Pass at High** | AD-11/12/23 已形成可执行的本地运行 envelope。 |
| 数据、状态、版本、发布 | **Fail** | 双 revision 未贯穿公共合同；external package identity 未闭合。 |
| 技术证据 | **Pass at High** | 栈声明了核对日期与稳定版本选择；可审计引用不足未达到本轮 High。 |
| 过度设计 | **Pass at High** | 未发现会阻塞实施或造成架构伤害的 High 级过度设计。 |

