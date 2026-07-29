# Story 1.5 TypeScript 模块分析门禁证据

## Blocking gate

- gateId/checkId：`typescript-module-analysis-v1`
- registry：`ci/quality-gates.v1.yaml`
- verifier：`scripts/ci/verify-typescript-module-analysis-v1.mjs`
- blocking：`true`
- owner：`qa`

该 verifier 先构建 `packages/application`、真实
`packages/adapters/analyzer-typescript/dist/analyzer-worker.js`、SQLite adapter 与 graph-service，
再按导出的 `TYPESCRIPT_MODULE_ANALYSIS_VERIFIER_MANIFEST` 运行固定、不可由命令行参数缩小的
Story 1.5 回归集。unit 清单必须包含 `index-read-set` 与 `sqlite-graph-store`，随后使用
`vitest.contract.config.ts` 单独运行真实 `graph-service-process`；contract 回归会锁定该清单，防止静默缩小。
覆盖范围包括：

- TypeScript 6.0.3 Worker 启动、异常响应、超时、取消与幂等关闭；
- Analyzer 配置两阶段封口、受控解析元数据 broker、RFC 8785/SHA-256 digest、事务外流式 hash
  与事务内身份栅栏；
- AD-24 语法映射、Node built-in、内部文件、外部 npm purl 与 unresolved 诊断；
- source FactBatch、AD-21 Evidence ID、多个 ownership slice 的确定性 composite patch；
- SQLite v3 迁移、精确 index/CHECK 合同、Evidence 唯一 ownership、canonical payload、故障回滚、
  重启摘要回验与 `detectedAt` no-op；
- graph-service 在一次 logical rebuild 中原子提交 hierarchy 与全部模块事实，并在 import 移除后执行
  complete replacement。

## 当前证据状态

本地证据由上述 verifier 与根级 `type/lint/unit/build/contract/dependency-boundary/basic-security/
planning-trace/architecture-required` 共同生成。Provider child evidence、attestation 与 Controller App
结论必须绑定最终提交并推送后的同一完整 SHA；在候选 SHA 冻结前不得把本地通过表述为 Hosted 证据。

本 Story 未修改 `initialize`、`job/start`、`service/status`、`service/shutdown` 或 contracts 导出的公共
Schema 表面，因此 `ci/public-capability-gates.v1.json` 不新增能力映射；最终以固定 base/head OID 的公共能力
差异验证结果为准。
