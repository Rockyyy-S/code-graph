# Story 1.2 Provider 证据

> 2026-07-23 状态：最终候选
> `21c25f6c5381539910daba7a151f2d4cc121fc48` 的 Hosted `architecture-required`
> run 29908232554 已在同一 SHA 上通过全部七条门禁。本文是最新候选的合并证据。

## 候选提交

- 实施基线：`40acc281ee492f86f8dcdedcdd66926d37810e7e`
- 第三轮复审实现提交：`3c6bf8cfe4278e3608ed72cd83307e22af98640e`
- 第三轮历史候选：`56f4e6385ee2d54f4b31f07c02c07969bc571e54`
- 最终候选完整提交：`21c25f6c5381539910daba7a151f2d4cc121fc48`
- 稳定 required check：`architecture-required`

最终候选包含 Story 1.2 产品实现、十二轮代码审查修复、跨平台生命周期修复与真实测试。
本文使用最终候选自身的 Hosted 结果，没有复用 Story 1.1 或旧候选运行替代当前证据。

## 验收结果

- 运行时：Node.js `24.18.0`、pnpm `11.12.0`
- 冻结安装：最终候选 Hosted 运行通过
- `architecture-required`：最终候选同 SHA Hosted 运行通过
- `type`：通过
- `lint`：通过
- `unit`：100/100 通过
- `build`：通过
- `contract`：99/99 通过
- `dependency-boundary`：通过
- `basic-security`：通过
- 本地定向复验：POSIX endpoint 清理单元测试 10/10、共享客户端合同测试 22/22 通过；
  最终候选的完整跨平台权威结果以上述 Hosted 运行为准。
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
- 第十二轮候选：`01bcf2d5f8be0291a54654eff2e9a890d3af9883`
- Unit 阻断运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29903535137>
- 阻断结论：`FAILED`；Ubuntu Unit 发现 POSIX 测试夹具的 UDS 路径为 101 字节，
  build 及后续门禁被跳过，证明失败会阻止合并。
- 修复候选：`92d11e544b71a20e64e8f7d7c5d269e24a2d6e44`
- Contract 阻断运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29907355279>
- 阻断结论：`FAILED`；Unit 与 build 已通过，Repository contracts 发现第二处同类
  POSIX 测试夹具路径问题，后续门禁被跳过。
- 当前最终候选：`21c25f6c5381539910daba7a151f2d4cc121fc48`
- 当前最终运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29908232554>
- 当前最终结论：`PASSED`；type、lint、unit、build、contract、dependency-boundary 和
  basic-security 在同一候选 SHA 上全部成功。

两次失败运行真实验证了 required check 会在失败门禁处停止并阻止后续合并；最终候选获得
同名 Hosted check 成功结果。证据回填提交仍受 pull request 当前 HEAD 上同一 required
check 约束，不通过不得合并。
