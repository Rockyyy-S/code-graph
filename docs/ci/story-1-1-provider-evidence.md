# Story 1.1 Provider 阻断证据

## Provider 配置

- Provider：GitHub
- Repository：`Rockyyy-S/code-graph`
- 默认分支：`main`
- 稳定 required check：`architecture-required`
- 触发范围：所有 Pull Request，以及 `main` push；workflow 无 `paths`/`paths-ignore`
- 基线通过运行：<https://github.com/Rockyyy-S/code-graph/actions/runs/29549046642>
- 分支保护：`strict=true`，required context 为 `architecture-required`
- 管理员强制与外部 drift monitor 不在本 Story 启用，归属 Story 1.3。

## 七门禁受控失败

下表只记录真实托管运行。每个失败提交都在同一 Pull Request 上触发同名
`architecture-required`，并在记录后由独立修复提交恢复通过。

| 门禁 | 失败提交 | 失败运行 | Provider 阻断状态 |
| --- | --- | --- | --- |
| `type` | 待记录 | 待记录 | 待记录 |
| `lint` | 待记录 | 待记录 | 待记录 |
| `unit` | 待记录 | 待记录 | 待记录 |
| `build` | 待记录 | 待记录 | 待记录 |
| `contract` | 待记录 | 待记录 | 待记录 |
| `dependency-boundary` | 待记录 | 待记录 | 待记录 |
| `basic-security` | 待记录 | 待记录 | 待记录 |

## 最终恢复

- 最终通过提交：待记录
- 最终通过运行：待记录
- Pull Request：待记录
