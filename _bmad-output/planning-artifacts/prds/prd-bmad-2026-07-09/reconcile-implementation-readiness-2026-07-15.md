---
title: Implementation Readiness 输入对账
date: 2026-07-15
status: complete
verdict: PASS
remainingGaps: 0
---

# Implementation Readiness 输入对账

## 1. 对账结论

PRD 与 Addendum 已完整吸收 implementation-readiness-report-2026-07-15.md 和已批准的 sprint-change-proposal-2026-07-15.md 中明确指向这两份制品的修改。

- 指定合同核验：11/11 通过。
- 愿景、MVP、UJ-1 至 UJ-5：未发现语义漂移。
- FR-1 至 FR-23：编号连续、唯一，能力范围未扩张或缩减；批准的修改仅形成边界澄清和可测试性补强。
- NFR：NFR-1 至 NFR-27 连续且唯一；原 NFR-1 至 NFR-23 已获得稳定编号，新增 NFR-24 至 NFR-27 承载报告要求的兼容性、资源和本地服务边界。
- 剩余 gaps：0。

本结论只覆盖 PRD 与 Addendum 的输入对账，不代表 Architecture、UX、Epics/Stories 和 CI 等其他源制品已经满足整体 READY 门禁。

## 2. 输入快照

| 输入 | 角色 | 最近修改时间 | SHA-256 |
| --- | --- | --- | --- |
| prd.md | 对账目标 | 2026-07-15 17:40:28 | 1052C1493829569EB9E420EC93593FE56533EA30036BB2F94986889EBDC76DEC |
| addendum.md | 对账目标 | 2026-07-15 17:42:15 | 0F8BCD25EE3ED37F9ABCF3E1C2B4EFFE99736792EB8DE178015238C5DC485CDE |
| ../../implementation-readiness-report-2026-07-15.md | 发现与验收来源 | 2026-07-15 15:27:22 | 144FC716C18AE60E56C7D3299AD00FF97607BC1CCBB187F154A3DC01D67B0493 |
| ../../sprint-change-proposal-2026-07-15.md | 已批准精确修改来源 | 2026-07-15 14:47:00 | AD20E45559676B4A4A99C3E706E35BD67D6D8DDA91362395CE509CD4C061E4C3 |

提案状态为“已批准”。当 readiness report 的概括与提案的精确合同同时出现时，本次以提案正文为准。

## 3. 指定合同逐项核验

### 3.1 FR-4：索引排除与首次 rebuild 前置合同

**状态：PASS**

证据：

- prd.md FR-4 明确以 Builtin 安全默认项和工作区根目录 .codegraphignore 控制索引范围。
- 首次 rebuild 和首次 Analyzer 运行前即应用内置排除；文件不存在时仍提供包含内置规则的 generation 0 有效快照。
- 命中有效索引排除的路径不产生节点、边或 Evidence，也不参与 workspace package 聚合、规则检查和成功指标。
- 重新纳入路径后沿用确定性 ID。
- addendum.md 4 节补充 BuiltinIgnoreV1、EffectiveIgnoreSnapshotV1、generation 0、last-valid、诊断与重新纳入的技术合同。

判定：已关闭 readiness report 的 EQ-C2 产品合同部分，并满足 proposal 4.10。

### 3.2 FR-12：rules.yaml ignore 与索引排除职责分离

**状态：PASS**

证据：

- prd.md FR-12 明确 rules.yaml 的 ignore 只裁剪规则评估范围。
- 被 rules ignore 命中的实体仍保留在规范图谱、普通查询、workspace package 聚合和索引规模统计中。
- 索引范围只能由内置默认项和 .codegraphignore 改变。
- PRD 明确同一路径在 rules ignore 下不得产生 finding，在 .codegraphignore 下不得进入图谱。
- addendum.md 4 节使用同一语义，不存在反向表述。

判定：FR-4 与 FR-12 的两种 ignore 已形成可独立测试的互斥职责。

### 3.3 BasicSymbolV1

**状态：PASS**

证据：

- prd.md FR-2 将 BasicSymbolV1 限定为 TypeScript/JavaScript SourceFile 顶层、具有稳定名称和可导航范围的 function、class、interface、type-alias、enum、variable、namespace。
- PRD 明确排除成员、参数、局部变量、import alias、匿名声明、调用图和 references，且这些对象不得进入符号导航、结构导出或成功指标。
- addendum.md 5.4 进一步规定稳定 symbol ID、kind、name、相对路径、范围、exported 状态及 file-scoped ownership。

判定：满足 proposal 4.10，且未演变为符号级规则、调用图或 references 的范围扩张。

### 3.4 SM-4 正确性验收合同

**状态：PASS**

证据：

- 使用版本化人工标注语料，至少 500 条依赖声明。
- 覆盖 ESM、CJS、re-export、type-only、literal require、literal dynamic import、path alias、跨 package、Node built-in 和负样本。
- 规范依赖边 micro-F1 不低于 0.80。
- 高置信度依赖边 precision 不低于 0.90。
- 验收报告输出 precision、recall、F1、分类结果和失败样本。
- 标注争议人工复核并留痕。
- addendum.md 5.4 与 PRD SM-4 的语料类别和阈值一致。

判定：已替换旧“准确率达到 80%”的不可执行口径，满足 proposal 4.11。

### 3.5 NFR 稳定编号

**状态：PASS**

机械核验结果：

- NFR 序列为 1 至 27，无缺号、无重号。
- 原报告临时分配的 NFR-1 至 NFR-23 已正式回写 PRD。
- NFR-24 至 NFR-27 为 readiness report 要求补充的新合同，没有改变原编号含义。
- PRD 文档目的明确 NFR-N 为稳定编号。

### 3.6 SM-7 与 SM-8

**状态：PASS**

SM-7 已明确：

- 至少 10 名有效试用者。
- 至少 3 个真实 TS/JS 仓库、2 个独立团队。
- 试用者必须是一线开发者或 Tech Lead、未参与产品实现，并完成固定 UJ-2 任务。
- 以完成有效会话者为分母，至少 70% 的评分达到 4/5 或以上。

SM-8 已明确：

- 至少 5 名 Tech Lead、至少 3 个独立团队。
- 使用真实变更完成一次 review。
- 至少 80% 可直接使用 PR Markdown 摘要启动风险讨论。
- 仅允许措辞或格式调整；若需补做结构分析，或遗漏/错误描述关键风险、关键路径、建议复查文件，则判定失败。

判定：样本、资格、分母、阈值和失败条件均可执行。

### 3.7 可访问性量化合同

**状态：PASS**

PRD NFR-17 至 NFR-20 已覆盖：

- 图与文本的任务等价。
- 屏幕阅读器可获得节点类型、边方向、数量、Finding、来源与置信度。
- WCAG 2.2 AA、高对比主题和非颜色唯一编码。
- 全键盘完成核心任务、可预测且可见的焦点。
- 最小 24×24 CSS px 交互目标。
- 200% 字号不丢失或重叠核心信息。
- 服从减少动态效果设置。

判定：已将 readiness report 指出的键盘、焦点、对比度和 WCAG 缺口量化。

### 3.8 平台、版本与安装迁移

**状态：PASS**

PRD NFR-24、NFR-25 与 addendum.md 5.5 一致定义：

- 支持 Windows x64、macOS x64、macOS arm64、Linux x64。
- 暂不支持 Windows arm64、Linux arm64。
- VS Code 最低 1.125.0，并验证最低版、最新稳定版和前一稳定版。
- CLI 使用 Node 24 LTS；VSIX 携带经验证的 Node 24 LTS 运行时。
- Addendum 锁定当前验证版本 Node 24.18.0 和 TypeScript 6.0.3。
- 支持组合必须经过新安装、离线启动、升级、降级、卸载、缓存保留/清理验收。
- 协议与 schema 不兼容安全拒绝；迁移事务化，失败保留故障副本并允许重建。

判定：支持矩阵、运行时、安装和数据迁移边界均已落盘。

### 3.9 资源基线

**状态：PASS**

PRD NFR-26 与 addendum.md 5.2 最新内容逐值一致：

| 指标 | PRD NFR-26 | Addendum 5.2 | 结果 |
| --- | --- | --- | --- |
| 首次 rebuild 峰值 RSS | 不超过 4 GiB | 不超过 4 GiB | 一致 |
| CPU 采样 | 1 秒间隔，整段平均不超过整机 75% | 同左 | 一致 |
| 空闲窗口 | 连续 5 分钟无活动 Job | 同左 | 一致 |
| 空闲 CPU | p95 不超过整机 1% | 同左 | 一致 |
| 空闲结束 RSS | 不超过 1.5 GiB | 同左 | 一致 |
| 单工作区缓存、元数据、日志 | 总量不超过 2 GiB | 同左 | 一致 |
| 轮转日志 | 不超过 100 MiB | 同左 | 一致 |
| 长时运行 | 固定 8 小时 fixture、操作序列、采样间隔和空闲窗口 | 同左 | 一致 |
| RSS 增长 | 同条件空闲 RSS 相对首小时基线不超过 20% | 同左 | 一致 |
| 泄漏信号 | Job 队列、句柄、临时文件不得持续单调增长 | 同左 | 一致 |

Addendum 另规定 BenchmarkPlanV1、至少 20 次测量、nearest-rank p95、BenchmarkResultV1、fixture/toolchain digest 和 invalid 结果判定，作为 PRD 指标的可重复采样合同。

判定：不存在 PRD/Addendum 口径漂移。

### 3.10 本地服务生命周期与威胁边界

**状态：PASS**

PRD NFR-27 定义产品级结果：

- 每个 indexing root 最多一个按需服务。
- Windows 命名管道，macOS/Linux Unix Domain Socket。
- 业务请求校验随机令牌、workspace-key 和协议版本。
- 端点冲突、伪造客户端和版本不兼容安全失败，不误连第二实例。
- 未授予 Workspace Trust 时不启动服务、不读取项目文件、不运行 Git。
- realpath 后必须位于 indexing root 内。
- 无客户端且无活动 Job 5 分钟后优雅退出，并覆盖崩溃、重连、升级和 stale metadata 恢复。

addendum.md 5.6 补充 JSON-RPC 2.0、禁止 TCP、POSIX 权限、Windows ACL、随机 endpoint、symlink/路径穿越防护、Webview CSP/nonce/Schema、bootstrap barrier、stale metadata 回收和安全硬限制。

判定：readiness report 指出的进程生命周期、传输协议、端点冲突、本机访问控制和威胁模型均已闭合。

### 3.11 Addendum 八项架构处置

**状态：PASS（8/8）**

addendum.md 已将“待架构确认”改为“架构处置结果”，并逐项标记“已关闭”：

1. 图谱位置、命名、清理与 .gitignore：已关闭，引用 AD-6、AD-14、AD-23。
2. 核心端口与适配器边界：已关闭，引用 AD-1、AD-7、Guide 2/4。
3. 稳定 ID 规范：已关闭，引用 AD-4、AD-24、AD-27。
4. rules.yaml 解析、诊断与 schema：已关闭，引用 AD-9、AD-14、Guide 10。
5. CLI 命令、I/O 与退出码：已关闭，引用 AD-13、AD-20、Guide 12。
6. VS Code surface 边界：已关闭，引用 AD-10、AD-15、Guide 11。
7. PR Markdown 摘要模板：已关闭，引用 AD-18、AD-26、Guide 12。
8. AI 结构上下文格式：已关闭，引用 AD-18、Guide 12。

判定：八项均有状态、处置文本和架构引用，没有残留未分配的架构待确认项。

## 4. 愿景、MVP、用户旅程与 FR 稳定性

### 4.1 愿景

**状态：PASS**

愿景仍聚焦 IDE 内代码结构感知与影响分析，以本地、可解释、可查询的结构事实回答当前代码位置、依赖关系、反向影响和边界破坏问题。首阶段仍为 VS Code + TypeScript/JavaScript 中大型项目。未引入云端协作、组织治理或 AI 自动修改等新的 MVP 承诺。

### 4.2 MVP 范围与发布切片

**状态：PASS**

- 首个可用版本仍优先验证 Project Overview、Current Context 和保存后增量更新。
- Beta+ 仍加入基础架构规则和本地 PR 结构影响摘要。
- PR Markdown 摘要仍属于完整 MVP，但不阻塞首个可用版本。
- MCP server、云端团队协作、hosted PR app、全语言、CPG/数据流、AI 自动重构、跨仓库全局图谱等仍在 MVP 外。
- 平台/版本、资源和安全条款属于实现与验收边界补强，没有改变产品功能范围。

### 4.3 用户旅程

**状态：PASS**

UJ-1 至 UJ-5 全部保留，编号连续且角色、核心任务和完成结果未改变：

- UJ-1：理解项目结构。
- UJ-2：判断当前文件影响。
- UJ-3：保存后发现结构违规。
- UJ-4：Tech Lead 审查 PR 结构影响。
- UJ-5：导出 AI 使用的局部结构上下文。

### 4.4 FR-1 至 FR-23

**状态：PASS**

机械核验：

- FR 数量：23。
- 序列：FR-1 至 FR-23。
- 唯一数量：23。
- 缺号：0。
- 重号：0。

语义核验：

- FR-2 新增 BasicSymbolV1 是批准的范围封口，不是新增调用图或 references 能力。
- FR-4 与 FR-12 是批准的 ignore 职责澄清和首次 rebuild 前置合同。
- FR-19 的缓存位置与清理表述同步已关闭的架构处置，仍保持默认本地、默认不上传的原能力。
- 其余 FR 保持原用户能力、旅程映射和 MVP 边界。

## 5. 剩余差距与结案

剩余 gaps：**0**。

本次未发现：

- 批准提案要求但未进入 PRD/Addendum 的条目。
- PRD 与 Addendum 在 FR-4、FR-12、BasicSymbolV1、SM-4、平台、资源或服务安全上的相互矛盾。
- NFR、SM、UJ 或 FR 的缺号与重号。
- 愿景、MVP、发布切片或用户旅程的非授权漂移。

PRD/Addendum 输入对账可以结案。整体 Implementation Readiness 是否达到 READY，仍需在 Architecture、UX、Epics/Stories、CI 与交叉引用全部同步后重新评估。
