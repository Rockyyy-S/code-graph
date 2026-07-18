# Story 1.2 Provider 阻断证据

## 候选提交

- 实施基线：`40acc281ee492f86f8dcdedcdd66926d37810e7e`
- 候选完整提交：`PENDING_CANDIDATE_COMMIT`
- 稳定 required check：`architecture-required`

候选提交尚未创建。本文不会把未提交工作区或基线提交伪装为 Story 1.2 候选。

## 本地验收

- 运行时：Node.js `24.18.0`、pnpm `11.12.0`
- 冻结安装：`pnpm install --frozen-lockfile` 通过
- `pnpm architecture-required`：通过
- `type`：通过
- `lint`：通过
- `unit`：39/39 通过
- `build`：通过
- `contract`：73/73 通过
- `dependency-boundary`：通过
- `basic-security`：通过
- Windows Named Pipe：两个独立客户端进程复用同一 PID、serviceInstanceId、statusEpoch
  与唯一 writer；第三客户端复用后完成受控 shutdown。

## GitHub Provider 运行

- Repository：`Rockyyy-S/code-graph`
- architecture-required 运行链接：`PENDING_PROVIDER_RUN`
- 最终结论：`BLOCKED_PENDING_PROVIDER_EVIDENCE`

Story 1.1 已证明该 required check 的任一门禁失败都会阻止合并。Story 1.2 仍必须在包含
本实现的候选完整提交上获得同名 hosted check 成功结果，才能把本文件和 Story 状态更新为
可审查；不得使用 Story 1.1 的运行链接替代本 Story 候选证据。
