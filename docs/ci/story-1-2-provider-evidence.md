# Story 1.2 Provider 阻断证据

## 候选提交

- 实施基线：`40acc281ee492f86f8dcdedcdd66926d37810e7e`
- 候选完整提交：`8ca4166925cae57aea25b957ce43929a05caf267`
- 稳定 required check：`architecture-required`

候选提交包含 Story 1.2 产品实现、跨平台修复与真实测试。本文没有复用 Story 1.1 的
运行结果替代本 Story 候选证据。

## 本地验收

- 运行时：Node.js `24.18.0`、pnpm `11.12.0`
- 冻结安装：`pnpm install --frozen-lockfile` 通过
- `pnpm architecture-required`：通过
- `type`：通过
- `lint`：通过
- `unit`：40/40 通过
- `build`：通过
- `contract`：73/73 通过
- `dependency-boundary`：通过
- `basic-security`：通过
- Windows Named Pipe：两个独立客户端进程复用同一 PID、serviceInstanceId、statusEpoch
  与唯一 writer；第三客户端复用后完成受控 shutdown。

## GitHub Provider 运行

- Repository：`Rockyyy-S/code-graph`
- 首次失败提交：`4b8e4cbde2eaf16f941cba8bbe5d5b3e51804152`
- 首次失败运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29635748123>
- 失败结论：Ubuntu unit 暴露 UDS 路径超限，required check exit 1 并阻止后续门禁。
- 最终候选运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29636223822>
- 最终结论：`PASSED`，稳定 check `architecture-required` 的全部七门禁成功。

Story 1.1 已证明该 required check 的任一门禁失败都会阻止合并。本 Story 的首次 hosted
运行也真实验证了该行为：unit 失败后 build、contract、dependency-boundary 与
basic-security 均未执行。修复后的候选完整提交获得同名 hosted check 成功结果，满足
进入独立代码审查的 Provider 证据要求。
