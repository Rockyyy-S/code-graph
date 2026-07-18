---
type: architecture-review
lens: correction-2026-07-16-technology-reality
date: 2026-07-16
artifact: ../ARCHITECTURE-SPINE.md
driving-input: ../../../sprint-change-proposal-2026-07-16.md
verdict: changes-required
critical: 0
high: 3
medium: 1
---

# 2026-07-16 纠偏更新：技术现实性审查

## 结论

**CHANGES REQUIRED。** 本轮未新增框架、运行时或依赖版本；现有 Stack pin 经复核仍存在且与 Node 24 兼容，AD-30 采用 JSON Schema 2020-12 也可由现有 Ajv 8.20.0 实现。问题集中在新增合同的可执行边界：AD-28 把未选定的代码托管 provider 能力写成 Story 1.3 的硬完成条件，AD-30 的 digest/candidateRef 没有唯一字节与候选身份定义，且它与 `ci/quality-gates.v1.yaml` 形成两个未建立派生关系的“唯一清单”。这些不是换栈问题，但会让不同实现对同一候选产生不同门禁结论。

## 最高优先级发现

### TR-H1 — High — Provider ruleset 与外部 drift monitor 尚未绑定可用平台、套餐和权限

**位置：** `ARCHITECTURE-SPINE.md:223-227`（AD-28）。

AD-28 要求 Story 1.3 配置“代码仓库外 provider ruleset”、强制 `architecture-required`、禁用管理员 bypass，并由外部定时 drift monitor 独立校验。然而当前架构没有选定 GitHub、GitLab、Azure DevOps 等 provider，也没有固定所需套餐、组织/仓库权限、API、外部调度器、凭据保管和告警目标。

这使 Story 1.3 的完成条件尚不可现实判定。以 GitHub 为例，规则集能力、组织级规则集和 bypass 模型受产品套餐及规则集层级影响；官方文档明确规则集面向 Team/Enterprise 场景并由显式 bypass 列表控制。换用其他 provider 时 API 与“管理员不可绕过”的语义并不等价。仓库内 scheduled workflow 也不能自然满足“独立于仓库 PR 的外部 monitor”信任边界。

**需要补充：** 在进入 Story 1.3 前绑定 provider capability profile，至少固定 provider/plan、规则集作用域、无 bypass 的可验证语义、管理 API、外部 scheduler/identity、最小权限 token、告警与 fail-closed 行为；否则将该完成条件标为部署前置开放项，而不是已采用的无条件现实。

### TR-H2 — High — AD-30 的 digest 没有规范化算法和输入域，无法跨实现重复判定

**位置：** `ARCHITECTURE-SPINE.md:235-239`（AD-30）。

AD-30 以 `fixture/task digest`、`manifestDigest` 和“不匹配即 invalid”作为唯一判定依据，却没有固定 digest 算法、规范字节、字段排序、是否包含 digest 自身、路径/换行规范或引用文件的展开规则。JSON Schema 只校验结构，不提供规范序列化；同一个对象经 YAML、普通 JSON 或不同键顺序序列化会得到不同字节。

AD-29 已经为发布 manifest 使用 RFC 8785 JCS → UTF-8 → SHA-256 并明确排除自引用字段，证明现有 Node/Ajv/JCS 技术栈能够实现；AD-30 未复用该现实合同。两个团队可以都符合 AD-30，却对同一 plan/manifest 算出不同 digest。

**需要补充：** 为 ProductValidationPlanV1、ReadinessGateManifestV1、fixture/task manifest 固定规范对象、排序、路径规则、排除字段与 `RFC 8785 JCS → UTF-8 → SHA-256`（或同等唯一 profile），并固定 digest 的 lowercase/base64 编码。

### TR-H3 — High — AD-28 与 AD-30 各自声明“唯一清单”，但没有技术上的派生或一致性合同

**位置：** `ARCHITECTURE-SPINE.md:223-227`、`ARCHITECTURE-SPINE.md:235-239`。

AD-28 声明 `ci/quality-gates.v1.yaml` 是“适用 blocking gate 的唯一机器清单”；AD-30 又声明 ReadinessGateManifestV1 是 Alpha/Beta/Beta+/v1.1 “唯一适用性清单”。两者都携带 gate/command/owner/blocking 相关信息，却没有规定谁生成谁、gateId 如何一一引用、哪个 digest 被候选绑定、发生漂移时以谁为准。

因此 `architecture-required` 可以按 quality-gates manifest 全部通过，而发布 runner 按 ReadinessGateManifestV1 得到另一组 blocking gate；两边都能声称遵守“唯一清单”。这与 AD-30 的可重复判定目标直接冲突。

**需要补充：** 固定单向关系，例如 ReadinessGateManifestV1 只能引用 `ci/quality-gates.v1.yaml` 中已定义的稳定 gateId，并绑定 quality-gates manifest digest；CI aggregator 与 release runner 校验同一 digest/candidateRef，禁止复制 command/owner/blocking 后独立演化。

### TR-M1 — Medium — `architecture-required` 的 always-run 语义未在 AD-28 中闭合

**位置：** `ARCHITECTURE-SPINE.md:223-227`。

AD-28 固定稳定 check 名和各 gate 的触发路径，但没有明确 aggregator workflow 必须对所有受保护分支/PR 事件产生终态、内部按 manifest 判定 gate applicability，并在依赖 job 失败或跳过时仍汇总为失败。GitHub 官方说明：若整个 required-check workflow 因 path/branch filter 被跳过，check 会保持 Pending 并阻止合并；依赖 job 若未使用 always-run 汇总，还可能不报告预期失败。

Implementation Guide 已写“always-run `architecture-required`”，方向正确，但 Spine 的不变量仍允许实现者把 path filter 放到 workflow 级。建议把 always-run、事件矩阵（含 merge queue 如适用）和 fail-closed aggregator 语义提升到 AD-28。

## 未变技术栈复核与风险边界

| 项目 | 2026-07-16 复核 | 结论 |
| --- | --- | --- |
| Node.js 24.18.0 | 官方发布索引存在，LTS Krypton，Node ABI 137 | 通过；仍需按 AD-12 锁定捆绑运行时与原生 ABI |
| TypeScript 6.0.3 | npm 版本存在，Node engine 与 Node 24 兼容 | 通过；锁定稳定 Compiler API 是有意选择，不按 TS 7 latest 漂移 |
| pnpm 11.12.0、esbuild 0.28.1、better-sqlite3 12.11.1 | npm 版本均存在；better-sqlite3 声明支持 Node 24.x | 通过；跨平台原生资产仍必须由发布矩阵实际安装验证 |
| Ajv 8.20.0 | npm 版本存在，可使用 Ajv2020 验证 JSON Schema 2020-12 | 通过；Schema 不等同于规范序列化，不能替代 AD-30 digest profile |
| VS Code API types 1.125.0 | 版本存在；当前 stable 已推进到 1.129.x | 可接受的最低兼容 pin；必须持续执行 AD-12 的 1.125、最新、前一稳定版矩阵，不能只在最新 types 上编译 |

本轮没有发现需要替换 Node、TypeScript、SQLite、Ajv 或 JSON Schema 的证据，也没有发现新增不存在的库/API。风险来自 CI provider 和机器合同尚未绑定，而非主技术栈过时。

## 证据来源

- 当前架构：`../ARCHITECTURE-SPINE.md`
- 最新纠偏：`../../../sprint-change-proposal-2026-07-16.md`
- Node.js 官方发布索引：<https://nodejs.org/dist/index.json>
- npm Registry：TypeScript 6.0.3、pnpm 11.12.0、better-sqlite3 12.11.1、Ajv 8.20.0 及 Stack 表其余精确版本
- VS Code stable releases API：<https://update.code.visualstudio.com/api/releases/stable>
- GitHub About rulesets：<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets>
- GitHub Troubleshooting required status checks：<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks>
- JSON Schema Draft 2020-12：<https://json-schema.org/draft/2020-12>
- RFC 8785 JSON Canonicalization Scheme：<https://www.rfc-editor.org/rfc/rfc8785>

## Reviewer Gate 决定

- **阻断合并本轮架构更新：** TR-H1、TR-H2、TR-H3。
- **可随上述修订一并关闭：** TR-M1。
- **不要求换栈或升级版本：** 当前 Stack 可继续作为实施基线。
