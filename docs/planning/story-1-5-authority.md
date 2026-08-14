# Story 1.5 规划权威说明

`implementation-readiness-report-2026-07-15.md` 等历史 readiness 报告把 Story 1.5 描述为 ignore 配置交付，这是当时规划的只读快照，不再代表当前实施范围。

当前实现只以以下规划源为权威：

- `_bmad-output/planning-artifacts/epics.md` 中的 Story 1.5 定义；
- Architecture Spine 的 AD-3、AD-4、AD-5、AD-21 与 AD-24；
- `StoryDependencyDagV1` 中 `"1.5": { dependsOn: ["1.19"] }` 的唯一直接依赖。

`.codegraphignore` 的完整配置、last-valid、监听与诊断生命周期已经迁移到 Story 1.10–1.13。本 Story 只消费已有 `EffectiveIgnoreSnapshotV1`，不重新实现上述职责。
