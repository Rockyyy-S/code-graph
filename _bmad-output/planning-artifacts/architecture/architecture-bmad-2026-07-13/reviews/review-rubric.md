---
title: Architecture Spine Good-spine Rubric Review
date: 2026-07-13
reviewer: rubric-walker
verdict: fail-revise
scope: ../ARCHITECTURE-SPINE.md
---

# Good-spine Rubric Review

## Gate Verdict

**FAIL — 机械结构合格，但仍存在 5 项 High 级一致性缺口；两个 initiative 下一级实现单元即使逐字遵守当前 AD，仍可能在服务所有权、身份、配置、运维和发布边界上产生不兼容实现。**

确定性 lint 已通过：0 个占位符、重复 AD ID、缺失 Binds/Prevents/Rule 或未固定版本问题。本报告只评判语义质量。

## High Findings

### H-01 — “每工作区一个服务”与“multi-root 每根一个服务”定义冲突

**位置：** AD-2、AD-4、AD-6、Structural Seed。

AD-2 规定“每个工作区最多一个 graph-service”，服务独占图谱、Job、迁移和 revision；AD-4 又规定 VS Code multi-root 的每个根独立运行服务和图谱。脊柱没有定义 `workspace` 在服务、workspace-key、缓存目录、CLI 参数和 VS Code multi-root 中究竟指 VS Code Workspace、WorkspaceFolder 还是 IndexingRoot。

因此两个客户端都可声称遵守规则，却分别实现为“一窗口一服务”和“一根目录一服务”；它们会生成不同 workspace-key、锁、缓存、revision 和状态汇总，直接破坏 AD-2 的 Prevents。

**处置：discuss / tighten AD。** 固定唯一术语和所有权单位，例如 `IndexingRoot` 是服务、缓存和 revision 的唯一边界；VS Code Workspace 只是聚合多个客户端会话。随后统一 AD-2、AD-4、AD-6 和图示。

### H-02 — 稳定身份 AD 没有定义 Edge ID，Finding ID 也无法按现有规则确定性实现

**位置：** AD-4、AD-17、AD-21、ERD。

AD-4 详细规定 workspace、文件、目录、package 和 symbol ID，却遗漏了 PRD 要求的稳定 Edge ID；AD-21 的 Evidence 去重键直接依赖 `edgeId`，但其生成规则不存在。外部 npm package 的身份也未说明按包名、解析版本、workspace 实例还是安装路径确定。

AD-17 又用未定义的“规范证据签名”生成 Finding ID。循环 Finding 若不固定节点轮转、方向、重复边和聚合 scope 的 canonicalization，同一循环可以产生多个合法签名。两个 rules/impact 实现可得到不同 Finding ID、firstSeenRevision 和“新增”判断，AD-17 的 Prevents 实际未成立。

**处置：autofix。** 在 AD-4 固定 Edge ID 的 canonical tuple；区分 workspace package 与 external package ID；在 AD-17 固定普通违规和 cycle Finding 的 canonical evidence signature。AD-21 应引用同一 canonicalization，而不是引入第二套键语义。

### H-03 — 单服务共享状态与多客户端运行偏好之间没有所有者

**位置：** AD-2、AD-7、AD-8、AD-14。

AD-2 规定 VS Code 与 CLI 共享一个服务；AD-14 又规定运行偏好优先级为 `CLI > workspace settings > user settings > defaults`。但运行偏好混合了两类状态：

- 请求级：查询预算、是否等待最新 revision、输出格式；
- 服务级：索引并发度、settle window、日志级别、监听行为和缓存策略。

当已有 VS Code 服务以用户设置运行，而 CLI 带显式参数接入时，脊柱没有说明 CLI 参数只影响当前请求、临时改变服务，还是重配置整个工作区服务。多个 VS Code 窗口拥有不同 workspace/user settings 时同样无解。两个 service-client 都可遵守 AD-14，却让同一服务产生不同全局状态。

**处置：discuss / new or tightened AD。** 把配置分为 repository policy、service-owned workspace runtime、request-scoped preference、client UI preference；分别固定解析者、生命周期、持久化位置和冲突处理。CLI 显式参数不得隐式改变其他客户端可见的服务级状态。

### H-04 — 本地交付已有打包决策，但运行与安全运维 envelope 仍留整维空白

**位置：** AD-2、AD-6、AD-11、AD-12、AD-20、Deferred。

当前已决定平台 VSIX、捆绑 Node、原生 SQLite ABI、握手和 schema 迁移，但以下相互依赖的运行边界既未决定，也未 Deferred：

- 服务发现锁的获取、过期锁/orphan PID 恢复、空闲退出与强制终止时序；
- 发现不兼容旧服务后，如何 drain、交接、升级或回滚；AD-12 只禁止第二实例，会留下永久拒绝连接状态；
- 扩展更新、CLI 降级与 graph schema 不可降级写之间的恢复流程；
- macOS/Windows 产物签名、原生模块完整性和发布制品 provenance；
- 缓存目录与 SQLite 文件的当前用户权限；AD-11 只保护 IPC，没有保护落盘图谱；
- CLI 不受 Workspace Trust 保护时的文件大小、YAML alias、glob、解析深度、CPU/内存等资源上限。

这些不是 story 级实现细节：它们决定同一工作区能否持续启动、升级和保护本地源码结构数据。两个平台实现可以完全不同并导致不可恢复或越权读取。

**处置：discuss。** 增加最小 Local Operations/Security AD，固定服务生命周期状态机、锁恢复、版本交接、缓存权限与资源护栏；签名/供应链若不在当前范围，必须带触发条件进入 Deferred。

### H-05 — `binds` 宣称的能力和发布覆盖仍有可验证缺口

**位置：** frontmatter、AD-19、Release Slice、Capability Map、Deferred。

脊柱 frontmatter 绑定 `SM-1..SM-8`，但 Capability Map 只落 `SM-1..SM-6`；SM-7 的“理解更快而非图更好看”和 SM-8 的 PR 摘要可直接用于 review 没有验证所有者。PRD 的可演进性 NFR 也未进入 frontmatter binds，虽然部分 AD 有实质支撑。

Release Slice 已补 Alpha/Beta/Beta+，但 Beta 仍未固定常见 npm/Yarn/pnpm workspace/package 边界识别这一发布门槛；Alpha 是否允许 monorepo 退化也不明确。这样 analyzer 团队与发布团队可对 Beta 完成条件作不同判断。

Deferred 仍未显式处理 hosted PR app、AI 自动重构、可视化规则编辑器和独立 Web dashboard；其中可视化规则编辑器完全可以在现有 VS Code/Webview 边界内被实现，因而“未写”不能阻止范围分叉。

**处置：autofix。** 补齐 SM-7/SM-8 的验证归属、NFR-evolvability 追踪、Alpha/Beta monorepo gate，并把其余 MVP Out-of-Scope 明确列入 Deferred 或 Scope Exclusions。

## Rubric Summary

| Rubric item | Result | Judgment |
| --- | --- | --- |
| 固定 initiative 下一级真实分叉点 | **Fail** | 大多数主干已固定，但服务所有权和配置所有权仍可分叉（H-01、H-03）。 |
| 每个 AD 的 Rule 可执行且实现 Prevents | **Fail** | AD-4/17/21 的身份链不闭合；AD-12 的不兼容拒绝缺少可恢复交接。 |
| Deferred 不允许兼容性分叉 | **Partial** | 技术升级触发较清楚；产品 Out-of-Scope 和运维/供应链维度仍沉默。 |
| 覆盖全部 FR/NFR/能力 | **Partial** | FR 大类已映射；SM-7/8、可演进性追踪和 Beta monorepo gate 缺失。 |
| 部署、环境、运维、安全 | **Fail** | 本地部署明确；生命周期、升级回滚、缓存权限、资源护栏和供应链不足。 |
| 数据、状态、版本、发布 | **Partial** | GraphPatch、revision、状态、独立 schema 版本较强；身份与服务级状态仍有洞。 |
| 技术有证据 | **Partial** | Stack 声称于 2026-07-13 经官方源核对，但脊柱未提供可审计引用、查询记录或 starter reality-check；只能证明“已声明验证”，不能独立复核。 |
| 无过度设计 | **Mostly pass** | 大部分细节直接防止跨模块漂移；少量键盘映射、预览失败保留等更接近 UX/story 规则，但尚未造成主干伤害。 |

## Medium / Low Tail

- **AD-9 enforceability：** JSON Schema/Ajv 本身不能直接保证数组中对象的 `id` 属性全局唯一；需明确应用级语义校验或自定义 keyword。
- **AD-19 measurement：** 60s/300ms/2s 已固定，但冷/热缓存、计时起止、基准仓库和 80% 准确率 oracle 未定义，发布 gate 仍可能被不同基准解释。
- **Deferred trigger：** “TypeScript 分析达不到 2 秒就重评分析器”把端到端 2 秒 SLA 直接归因于分析器；应要求 profiling 证明 analyzer 是主瓶颈。
- **Evidence contract：** AD-21 固定置信度和去重键，但 Evidence 的时间、语言、生命周期及“最后一个 evidence 消失才删除边”没有完整闭合。
- **潜在过度设计：** AD-15 的具体按键映射和 AD-18 的预览失败保留/原子文件替换可考虑下沉到 UX/实现契约；若保留，应确认它们确属 initiative 下跨 feature 的共同不变量。

## Positive Signals

- 六边形模块化单体、唯一组合根、GraphPatch 原子提交和单调 revision 构成了清晰主干。
- GraphViewModel、workspace freshness、Job、Finding baseline 和独立 schema version 已显著减少客户端/服务漂移。
- 本地 IPC、Workspace Trust、Webview CSP、Telemetry Noop 和结构化日志为安全与隐私建立了可执行默认值。
- Release Slice、性能 gate 和导出合同已从泛化能力名称提升为可实施约束。

