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

| 门禁 | 失败命令/步骤 | 失败提交 | 失败运行 | Provider 阻断状态 |
| --- | --- | --- | --- | --- |
| `type` | `pnpm type` / Type check | [`3354ba7`](https://github.com/Rockyyy-S/code-graph/commit/3354ba7cf34ac444f1e7ba813a70b38427a2bca7) | [29549312757](https://github.com/Rockyyy-S/code-graph/actions/runs/29549312757) | PR `BLOCKED`，required check exit 1 |
| `lint` | `pnpm lint` / Lint | [`f6a9bb4`](https://github.com/Rockyyy-S/code-graph/commit/f6a9bb4fe939abda86b8f19784d8432090789141) | [29549379867](https://github.com/Rockyyy-S/code-graph/actions/runs/29549379867) | PR `BLOCKED`，required check exit 1 |
| `unit` | `pnpm unit` / Unit tests | [`fa4b4df`](https://github.com/Rockyyy-S/code-graph/commit/fa4b4df0d5a2eaa495a1ff75bd1ce10ab10ef488) | [29549453466](https://github.com/Rockyyy-S/code-graph/actions/runs/29549453466) | PR `BLOCKED`，required check exit 1 |
| `build` | `pnpm build` / Build | [`91cfc01`](https://github.com/Rockyyy-S/code-graph/commit/91cfc0154a9637e3d33280ac42450ec1edf52e84) | [29549535787](https://github.com/Rockyyy-S/code-graph/actions/runs/29549535787) | PR `BLOCKED`，required check exit 1 |
| `contract` | `pnpm contract` / Repository contracts | [`64c3647`](https://github.com/Rockyyy-S/code-graph/commit/64c3647934288cfe0826297bf040b62f61111c75) | [29549609022](https://github.com/Rockyyy-S/code-graph/actions/runs/29549609022) | PR `BLOCKED`，required check exit 1 |
| `dependency-boundary` | `pnpm dependency-boundary` / Dependency boundaries | [`fb0fc0c`](https://github.com/Rockyyy-S/code-graph/commit/fb0fc0c48a3a594d52d0c60a243b6f3537d85e9f) | [29549701349](https://github.com/Rockyyy-S/code-graph/actions/runs/29549701349) | PR `BLOCKED`，required check exit 1 |
| `basic-security` | `pnpm basic-security` / Basic security | [`a83c47b`](https://github.com/Rockyyy-S/code-graph/commit/a83c47b25a018f1c67dff5c7588fb98d1b052a83) | [29549786880](https://github.com/Rockyyy-S/code-graph/actions/runs/29549786880) | PR `BLOCKED`，required check exit 1 |

## 最终恢复

- 最终通过提交：[`bec62f2`](https://github.com/Rockyyy-S/code-graph/commit/bec62f2e5f7abaf242dcbc1d496765384d00a5f3)
- 最终通过运行：[29549830696](https://github.com/Rockyyy-S/code-graph/actions/runs/29549830696)
- Pull Request：[Rockyyy-S/code-graph#1](https://github.com/Rockyyy-S/code-graph/pull/1)
- 最终 Provider 状态：`mergeStateStatus=CLEAN`，required check exit 0
