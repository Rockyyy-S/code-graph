# PRD 文字审校 — 2026-07-16

| Original Text | Revised Text | Changes |
| --- | --- | --- |
| 如果邻域节点超过预算，系统折叠为目录/模块聚合节点 | 如果邻域节点超过预算，系统折叠为 directory 或 recognized workspace-package 聚合节点 | 与 §3 权威术语和 FR-7 聚合合同对齐，消除“模块”可被误解为第三种实体的风险。 |
| 文件级和目录/模块级循环依赖 | file、directory 和 workspace-package 投影循环依赖 | 明确三种验收范围，避免“模块级”与 `no-cycle` scope 漂移。 |
| 受影响目录/模块 | 受影响 directory 或 workspace package | 与项目结构概览和 `ProjectionMembershipV1` 的唯一聚合术语一致。 |

上述修改已应用。未发现其他影响理解的文字问题。
