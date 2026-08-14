---
title: '修复 Controller drift monitor 租约被 GitHub cron 延迟耗尽'
type: 'bugfix'
created: '2026-07-27'
status: 'done'
review_loop_iteration: 0
baseline_commit: '3b4ef9bcd8bb6c68fa02c0e423694f5f6d10cb53'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/1-3-强化-provider-阻断与规划双向追踪门禁.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `architecture-drift-monitor` 的五分钟 cron 实际可延迟 30～210 分钟；证据超过 15 分钟后 guardian 会按设计 fail closed，导致后续 `code-graph` PR 的 `architecture-required` 被撤销或无法转绿。

**Approach:** 保留 15 分钟硬过期，由 Controller 在成功证据满 6 分钟且没有可信 active run 时，使用本仓库 `GITHUB_TOKEN` 无输入触发 `drift-monitor.yml@main`。monitor 仍由独立 App 执行；dispatch 失败不提前作废未过期证据，过期后仍 fail closed。

## Boundaries & Constraints

**Always:** 保留每分钟 guardian、50/55 分钟 runtime/timeout、`cancel-in-progress: false` 和 15 分钟硬过期；仅采信 `push/schedule/workflow_dispatch` 中固定仓库/path、`main`、当前 trusted SHA、`completed/success` 且时间合法的结果；dispatch 无输入；可信 queued/in-progress run 抑制重复触发；Controller/Monitor App 身份分离，monitor 保持 provider 只读；新增 JS 使用必要的中文注释与 JSDoc。

**Ask First:** 修改 branch protection/ruleset；扩大 App、secret 或生产权限（本 workflow 最小 `actions: write` 除外）；放宽仓库/branch/path/SHA/状态/15 分钟边界；改变 refresh、guardian、timeout 或身份边界。

**Never:** 延长租约到 50/60 分钟、吞掉 stale 错误、改成功退出码、复用 Controller App token、内联 monitor、停用 guardian，或接受错误 branch/SHA/path/未完成结果来“修绿”。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|---------------|----------------------------|----------------|
| 新鲜 | success 未到预刷新阈值 | 复用，不 dispatch | API 失败则 fail closed |
| 预刷新 | success 在 6～15 分钟间，无可信 active run | dispatch 固定 `ref: main` 一次，复用当前 success | dispatch 失败只记录 |
| 刷新中 | 存在可信 queued/in-progress run | 不重复 dispatch；active 不替代 completed success | 继续按旧 success 年龄判断 |
| 已失效 | success 缺失、失败、未来或满 15 分钟 | 撤销旧绿色；无可信 active 时 best-effort dispatch | dispatch 成功也不能让本轮转绿 |
| 非可信 | repo/path/branch/SHA/status 不匹配 | 忽略，不能抑制可信刷新 | 按无可信 run 处理 |

</frozen-after-approval>

## Code Map

- `../code-graph-gate-controller/.github/workflows/drift-monitor.yml`、`.github/workflows/controller.yml` -- 自刷新入口、最小权限与触发分支。
- `../code-graph-gate-controller/lib/controller-policy.mjs` -- 可信 success/active run 与刷新决策。
- `../code-graph-gate-controller/bin/run-controller.mjs` -- 去重 dispatch、日志和 fail-closed 编排。
- `../code-graph-gate-controller/tests/controller-policy.test.mjs`、`tests/controller-cycle.test.mjs`、`tests/workflow-contract.test.mjs` -- 策略、编排和 workflow 合同回归。
- `_bmad-output/implementation-artifacts/1-3-强化-provider-阻断与规划双向追踪门禁.md` -- 记录受控入口的安全合同迁移。

## Tasks & Acceptance

**Execution:**
- [x] `../code-graph-gate-controller/lib/controller-policy.mjs`、`bin/run-controller.mjs` -- 实现可信分类、6 分钟预刷新、active 去重与 best-effort dispatch。
- [x] `../code-graph-gate-controller/.github/workflows/drift-monitor.yml`、`.github/workflows/controller.yml` -- 增加无输入入口、最小 `actions: write`、`workflow_run.branches: [main]`，保留身份/并发/时限。
- [x] `../code-graph-gate-controller/tests/controller-policy.test.mjs`、`tests/controller-cycle.test.mjs`、`tests/workflow-contract.test.mjs` -- 覆盖矩阵并迁移旧入口合同。
- [x] `_bmad-output/implementation-artifacts/1-3-强化-provider-阻断与规划双向追踪门禁.md` -- 记录 cron 无 SLA 与新安全约束。

**Acceptance Criteria:**
- Given schedule 延迟且可信 success 进入预刷新窗口，when 无可信 active run，then Controller 只触发一次固定 main monitor。
- Given dispatch 失败但 success 未满 15 分钟，when 校验租约，then 继续本轮并记录错误。
- Given success 已满 15 分钟且新 run 未成功，when 校验租约，then 撤销旧绿色并失败。
- Given run 的 repo/path/branch/SHA/status/conclusion 不可信，when 分类历史，then 它既不是 evidence，也不抑制刷新。
- Given 修复完成，when 执行测试，then 原 100 项与新增回归全通过，`git diff --check` 无错误。

## Spec Change Log

## Verification

**Commands:**
- `pnpm test`（`../code-graph-gate-controller`）-- expected: 原有与新增测试全部通过。
- `git diff --check`（两个仓库）-- expected: 无格式错误。

**Results:**
- `pnpm test` -- 审查补丁后 113/113 通过；此前仅既有 Windows `<100ms` guardian 墙钟断言偶发失败，单文件与完整复跑均全绿。
- `git diff --check` -- 两个仓库均 exit 0，仅提示工作树 LF/CRLF 转换，无 whitespace error。

## Suggested Review Order

**租约编排**

- 先看刷新、冷却、异步恢复与 fail-closed 的核心入口。
  [`run-controller.mjs:731`](../../../code-graph-gate-controller/bin/run-controller.mjs#L731)

- 固定 main 历史查询与受控 dispatch，隔离 Controller 仓库 token。
  [`run-controller.mjs:779`](../../../code-graph-gate-controller/bin/run-controller.mjs#L779)

- 进程级状态覆盖相邻 guardian cycle 的最终一致性窗口。
  [`run-controller.mjs:923`](../../../code-graph-gate-controller/bin/run-controller.mjs#L923)

**信任与时间策略**

- 单一策略同时决定 fresh evidence、active 去重与刷新需求。
  [`controller-policy.mjs:186`](../../../code-graph-gate-controller/lib/controller-policy.mjs#L186)

- active 状态必须可信、时间合法且未超过硬租约。
  [`controller-policy.mjs:242`](../../../code-graph-gate-controller/lib/controller-policy.mjs#L242)

- 失败自刷新使用六分钟退避，阻止快速 Actions 重试环。
  [`controller-policy.mjs:255`](../../../code-graph-gate-controller/lib/controller-policy.mjs#L255)

- 同秒结果按 run ID/attempt 排序，拒绝输入顺序歧义。
  [`controller-policy.mjs:266`](../../../code-graph-gate-controller/lib/controller-policy.mjs#L266)

**Workflow 接线**

- monitor 仅增加无输入自刷新入口，独立 App 执行不变。
  [`drift-monitor.yml:6`](../../../code-graph-gate-controller/.github/workflows/drift-monitor.yml#L6)

- Controller 限定 main 完成事件并取得最小 actions 写权限。
  [`controller.yml:6`](../../../code-graph-gate-controller/.github/workflows/controller.yml#L6)

**回归与合同**

- 编排测试覆盖跨 cycle 冷却、日志失败与 stale 撤销。
  [`controller-cycle.test.mjs:299`](../../../code-graph-gate-controller/tests/controller-cycle.test.mjs#L299)

- 策略测试锁定 6/15 分钟、active 状态和排序边界。
  [`controller-policy.test.mjs:281`](../../../code-graph-gate-controller/tests/controller-policy.test.mjs#L281)

- Workflow 合同固定入口、权限、分支、超时和状态共享。
  [`workflow-contract.test.mjs:182`](../../../code-graph-gate-controller/tests/workflow-contract.test.mjs#L182)

- Story Patch 记录安全合同迁移与审查加固项。
  [`1-3-强化-provider-阻断与规划双向追踪门禁.md:305`](./1-3-强化-provider-阻断与规划双向追踪门禁.md#L305)
