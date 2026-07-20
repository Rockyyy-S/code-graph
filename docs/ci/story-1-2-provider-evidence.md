# Story 1.2 Provider 证据

> 2026-07-20 状态：第三轮复审最终候选
> `56f4e6385ee2d54f4b31f07c02c07969bc571e54` 已取得同 SHA 的 Hosted
> `architecture-required` 成功结果。本文是 Story 1.2 当前实现候选的合并证据。

## 候选提交

- 实施基线：`40acc281ee492f86f8dcdedcdd66926d37810e7e`
- 第三轮复审实现提交：`3c6bf8cfe4278e3608ed72cd83307e22af98640e`
- 最终候选完整提交：`56f4e6385ee2d54f4b31f07c02c07969bc571e54`
- 稳定 required check：`architecture-required`

最终候选包含 Story 1.2 产品实现、三轮代码审查修复、跨平台生命周期修复与真实测试。
本文没有复用 Story 1.1 或旧候选的运行结果替代当前候选证据。

## 本地验收

- 运行时：Node.js `24.18.0`、pnpm `11.12.0`
- 冻结安装：`pnpm install --frozen-lockfile` 通过
- `pnpm architecture-required`：通过
- `type`：通过
- `lint`：通过
- `unit`：74/74 通过
- `build`：通过
- `contract`：78/78 通过
- `dependency-boundary`：通过
- `basic-security`：通过
- Windows Named Pipe：两个独立客户端进程复用同一 PID、serviceInstanceId、statusEpoch
  与唯一 writer；第三客户端复用后完成受控 shutdown。

## GitHub Provider 运行

- Repository：`Rockyyy-S/code-graph`
- 第三轮首次候选：`3c6bf8cfe4278e3608ed72cd83307e22af98640e`
- 阻断运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29723702957>
- 阻断结论：`FAILED`；Ubuntu unit 暴露 POSIX 测试夹具未先创建 endpoint 父目录，
  后续 build、contract、dependency-boundary 与 basic-security 均被跳过。
- 最终候选：`56f4e6385ee2d54f4b31f07c02c07969bc571e54`
- 最终候选运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29724059158>
- 最终结论：`PASSED`；type、lint、unit、build、contract、dependency-boundary 和
  basic-security 全部成功。

本轮首次 Hosted 运行真实验证了 required check 的阻断语义；修复后的最终候选获得同名
Hosted check 成功结果。证据回填提交仍受 pull request 当前 HEAD 上同一 required check
约束，不通过不得合并。
