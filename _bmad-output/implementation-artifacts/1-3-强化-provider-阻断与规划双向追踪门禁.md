---
baseline_commit: e29edc1f6cb06b1a8670a9b784a0adad7b7f6b42
created_at: 2026-07-23T09:44:09+08:00
provider_snapshot_at: 2026-07-23T09:35:00+08:00
---

# Story 1.3: 强化 provider 阻断与规划双向追踪门禁

Status: in-progress

<!-- 说明：本 Story 已完成需求、架构、现有代码、前序 Story、Git、provider 与技术版本分析；实现完成状态仍由 dev-story、真实外部门禁证据和独立代码审查流程决定。 -->

## Story

As a 项目维护者，
I want 将最小 CI 强化为 manifest 驱动、provider 强制且可检测漂移的完整架构门禁，
so that 地基完成后才能并行开发功能，后续能力和规划引用也不会绕过架构合同。

## Acceptance Criteria

1. **Given** Story 1.1 的最小 CI 和 Story 1.2 的空服务握手已经可执行  
   **When** `ci/quality-gates.v1.yaml` 被解析  
   **Then** type、lint、unit、build、contract、dependency-boundary、basic-security 和规划追踪均作为真实 blocking gate 执行  
   **And** 每个门禁具有稳定 checkId、触发路径、验收命令、capabilityOwner 和 blocking 标记  
   **And** `ci/quality-gates.v1.yaml` 是适用 gate 的唯一机器清单，不重复创建最小 CI。

2. **Given** Pull Request 触发 provider 侧规则  
   **When** always-run 聚合门禁执行  
   **Then** 使用稳定 check ID `architecture-required`  
   **And** 仓库内变更无法移除该必需检查或启用管理员 bypass  
   **And** 任一适用门禁失败都会阻止合并  
   **And** 仓库外 drift monitor 持续验证 required check 和 ruleset 未漂移。

3. **Given** 规划文档、Architecture AD、产品验证合同或 Story 引用发生漂移  
   **When** 执行规划追踪检查  
   **Then** FR、NFR、SM、AR、UX-DR、AD、Story 编号、相对文档链接和 ProductValidation plan/manifest 引用不一致会产生明确失败  
   **And** 诊断指出相对文件位置、缺失的双向引用和修复建议。

4. **Given** 某项能力首次由公共 CLI、RPC、extension 调用或公共 Schema 公开  
   **When** 对应变更提交  
   **Then** 同一 PR 必须把真实门禁加入 `ci/quality-gates.v1.yaml` 并由 `architecture-required` 执行  
   **And** Story 交付说明引用 checkId、能力 owner 和验证证据。

5. **Given** Story 1.3 的全部基线门禁尚未通过  
   **When** 尝试并行启动 Story 1.4 或其他功能 Story  
   **Then** 规划和 provider gate 明确阻止并行开放  
   **And** 只有基线通过后才允许后续功能切片并行实施。

## Tasks / Subtasks

- [x] Task 1：建立 Gate 合同与唯一 canonical digest 实现（AC: 1, 2, 4）
  - [x] 在 `packages/contracts` 定义并导出 `GateDefinitionV1`、`GateRegistryV1`、`GateEvaluationContextV1`、`GateEvidenceV1` 及严格 JSON Schema 2020-12；Schema 必须使用 `additionalProperties:false`，运行时校验复用 Ajv 8.20.0。
  - [x] `GateDefinitionV1` 最终必填字段为 `gateId`、`checkId`、argv 字符串数组 `command`、`capabilityOwner`、`blocking`、`evidenceProducerId`；`triggerPaths` 是唯一可选字段：字段缺失表示 always applicable，字段存在时必须为非空、排序去重的合法 glob。JCS 输入必须保留“字段缺失”语义，不能把它擅自改写为空数组或 `null`。`evidenceProducerId` 必须进入 `gateDefinitionDigest`，不得按早期简写遗漏。
  - [x] `GateRegistryV1` 的 YAML/JSON 形状固定为 `{schemaVersion:1,gates:[{gateDefinition,gateDefinitionDigest}]}`，gates 按 `gateDefinition.gateId` 升序且 ID 唯一。`gateRegistryDigest` 是对完整 GateRegistryV1 计算的旁路派生值，不写回 registry 根字段；定义摘要与注册表摘要均为 64 位小写十六进制且使用固定前缀规则的 validator。
  - [x] `GateEvaluationContextV1` 至少绑定 `providerRepositoryId`、Git `objectFormat`、完整 `baseOid`/`headOid`、`comparisonBaseOid`、`gateRegistryDigest` 与 `evaluationContextDigest`。
  - [x] `GateEvidenceV1` 固定绑定 `schemaVersion:1`、`gateId`、`gateDefinitionDigest`、`evidenceProducerId`、`evaluationContextDigest`、`headOid`、`status=pass|fail|invalid`、`outputDigest` 与 `gateEvidenceDigest`。
  - [x] 将 RFC 8785 JCS、UTF-8、SHA-256 小写十六进制 helper 收敛到 `packages/contracts` 的单一权威实现；迁移并复用 `packages/service-client/src/workspace-identity.ts` 与 `apps/graph-service/src/instance-owner.ts` 的现有 canonical/hash 调用，删除平行算法且保持 workspace-key、metadata integrity 回归结果不变。
  - [x] clean checkout 的唯一运行形态固定为 checked-in ESM runtime：`packages/contracts/runtime/canonical-json.mjs` 是 Node/CI 可直接加载的权威实现，`packages/contracts/runtime/canonical-json.d.mts` 提供类型，`packages/contracts/src/canonical-json.ts` 作为 TypeScript facade 并由 package index 导出；`scripts/ci` 直接导入该 runtime，禁止读取历史 `dist`、Node 临时 type stripping 或复制第二套算法。
  - [x] JCS/digest 测试覆盖键顺序、数组顺序、Unicode、数字、摘要字段排除、`undefined`、非有限数、BigInt、非法 Unicode 与已知固定向量；禁止以对象地址、时间戳、URL 或运行顺序参与 digest。

- [x] Task 2：创建唯一 Gate Registry 并消除平行门禁清单（AC: 1, 4）
  - [x] 新建 `ci/quality-gates.v1.yaml`，登记 Story 1.1 已有七个真实 gate、`planning-traceability` 与现有 `repository-contract-preflight`；preflight 作为明确的 blocking gate，不再是 registry 外的隐式步骤。
  - [x] 首版 registry 必须使用“Initial Gate Registry”表中的稳定 `gateId`/`checkId`/`command`/`capabilityOwner`；所有九项均 `blocking:true` 且省略 `triggerPaths`，保持 always applicable。`evidenceProducerId` 使用表中 URI grammar，并在外部 producer workflow 的不可变 SHA 确定后回填真实值，禁止以临时候选 workflow 路径代替。
  - [x] `triggerPaths` 缺失表示 always applicable；存在时必须为非空、排序去重的规范 POSIX glob，禁止 `!` 反选、绝对路径、反斜杠、仓库逃逸或平台相关匹配；空数组、`null` 和空字符串均 invalid。
  - [x] 更新 `package.json`，增加真实 `planning-trace` 命令，并使 `architecture-required` 从 registry 解析执行；不得改变现有 type/lint/unit/build/contract/dependency-boundary/basic-security 的真实实现语义。
  - [x] 更新 `scripts/contracts/validate-repository-contract.mjs`，从 registry 验证根脚本、命令与 owner/producer/digest，不再维护第二份 `requiredScripts` 门禁列表；未知、重复、乱序、非法命令、digest 漂移或 no-op 命令必须 fail closed。
  - [x] 更新 `scripts/security/check-basic-security.mjs`，将顶层 `ci/`、Gate 配置和 provider 证据纳入敏感内容与危险命令扫描；不得把真实 token、App private key、webhook secret 或 provider 凭据写入仓库。
  - [x] 不新增无责任边界的 `utils` 包；registry/parser/evaluator 各自放入 `scripts/ci`、规划检查放入 `scripts/planning`，共享公共合同由 `packages/contracts` 独占。

- [x] Task 3：实现固定 Git OID 的适用性与评估上下文（AC: 1, 2）
  - [x] 从 provider 可信事件输入读取 `providerRepositoryId`、Git `objectFormat`、完整 `baseOid` 与 `headOid`；拒绝短 SHA、隐式 HEAD、工作树状态、展示 ref、空值、OID 长度或字符与 objectFormat 不匹配。
  - [x] 执行 `git merge-base --all baseOid headOid`，对完整结果按字典序排序并选择最小 OID；空集合为 invalid，多 merge-base 必须确定性选择最小值而不是依赖 Git 输出顺序。
  - [x] affected paths 只能来自固定 OID 上的 `git diff --name-status -z --no-renames comparisonBaseOid headOid`；解析 NUL 数据，不做按行或空格切分。
  - [x] 重命名必须表现为 delete+add；删除项使用旧路径；所有路径转换为相对 POSIX 形式并在匹配前拒绝仓库逃逸、NUL、绝对路径和反斜杠。
  - [x] 使用 `gateRegistryDigest` 构造完整 `GateEvaluationContextV1` 并计算 `evaluationContextDigest`；普通 PR 只进行 registry applicability，不选择 releaseSlice/gatePhase，也不编译 `ReadinessGateManifestV1`。
  - [x] 子 gate 适用性只允许 `required|not-applicable|invalid`；未知 gate、非法 registry、无法计算 merge-base、glob 无效、context digest 不匹配均为 invalid。
  - [x] 本地运行必须使用显式 fixture OID 或清楚标记的 local context，不能伪造 provider repository identity；Hosted 完成证据只能使用 provider 提供的真实上下文。

- [x] Task 4：实现规划双向追踪与 Story 1.3 屏障检查（AC: 3, 5）
  - [x] 新建 `scripts/planning/check-planning-traceability.mjs`，只读取“Planning Trace Source Set”表列出的当前规范输入；dated readiness、sprint-change、reconcile 和 reviews 只作历史证据，不参与当前语义判定，自动 glob 扫描全部 planning Markdown 属于错误实现。
  - [x] 验证 PRD 中 FR-1..FR-23、NFR-1..NFR-27、SM-1..SM-8 的定义连续、唯一且引用存在；若文档引用 UJ，也必须解析并验证已定义 UJ，不得静默忽略。
  - [x] 验证 `epics.md` 中 AR-1..AR-32、UX-DR1..UX-DR37、61 个 Story、每个 Story 的关联需求与关键合同双向映射；引用解析必须遵循“Planning Reference Grammar”，未知前缀、越界编号、裸数字、反向范围或未声明缩写 invalid。
  - [x] 验证 Architecture AD-1..AD-30 唯一；机器追踪只使用各 AD 的 `Binds`，Capability Map 的 `Governed by` 仅作人工导航，禁止拿它补写或覆盖直接绑定。
  - [x] 验证 `StoryDependencyDagV1` 恰好覆盖 61 个 Story、每个只出现一次、引用存在、唯一根、无环；正文顺序和 Story 数字大小不得作为缺失依赖的回退。
  - [x] 验证 Markdown 相对链接解析到仓库内现有路径；诊断只输出工作区相对 POSIX 路径、章节或行、缺失/未知/单向引用、缺失反向引用与可直接执行的修复建议，不输出绝对路径。
  - [x] 当前只验证 `ProductValidationPlanV1`、`ReadinessGatePolicyV1`、`ReadinessGateManifestV1` 等已声明合同与引用名称/映射一致；Story 5.11 前不得伪造具体 plan、fixture、evidence 或 release manifest。未来真实资产首次加入时，同一 PR 必须扩展 registry 中的真实 gate。
  - [x] 读取 `sprint-status.yaml` 并验证 Story 1.3 未 `done` 时，Story 1.4 及其他尚未满足 DAG 的功能 Story 不能从 `backlog` 推进；Story 1.1/1.2 的 `done` 是本 Story 的直接前置。
  - [x] 为每类漂移建立独立负向 fixture：FR、NFR、SM、UJ、AR、UX-DR、AD Binds、Story 关联需求、DAG 缺失/重复/环、相对链接、ProductValidation 引用和 sprint 状态越权。

- [x] Task 5：把仓库 workflow 收敛为 child evidence producer（AC: 1, 2, 4）
  - [x] 升级 `scripts/ci/run-architecture-required.mjs`：解析 registry、计算 context/applicability、以 `shell:false` 和 argv 执行全部 required gate、收集每项结果并生成 `GateEvidenceV1`；任一 fail/invalid 或 required gate 缺证据时聚合进程必须非零退出。
  - [x] runner 可以继续执行其余 required gate 以形成完整诊断，但不得使用 workflow `continue-on-error`、`|| true` 或恒成功 wrapper；最终退出码必须真实反映 fail-closed 结论。
  - [x] `outputDigest` 固定为 `GateOutputV1` 的 JCS SHA-256。`GateOutputV1` 是封闭对象：`{schemaVersion:1,gateId,termination,stdoutDigest,stderrDigest,stdoutBytes,stderrBytes,stdoutTruncated,stderrTruncated}`；`termination` 是 `exit+code`、`signal+signalName` 或 `spawn-error+stableCode` 的封闭联合。stdout/stderr digest 对 runner 捕获的原始有界字节分别计算，不做启发式清洗、重排或日志文本再解释；原始日志是旁路诊断 artifact，不进入 GateEvidence。
  - [x] 更新 `.github/workflows/architecture-required.yml`：保持每个 PR 和 `main` push always-run、无 path filter、冻结安装、完整 40 字符 Action SHA、Node 24.18.0 与 pnpm 11.12.0；checkout 必须提供计算固定 merge-base 所需的 Git 对象。
  - [x] Hosted child evidence 的权威执行入口必须是 `<external-controller-repository>/.github/workflows/produce-gate-evidence.yml@<trusted-40-hex-sha>` reusable workflow；本仓库 workflow 只传递 repository/head/base 等非秘密输入并调用该固定 workflow。可信 workflow 自行 checkout 精确候选 OID、加载 Controller 已批准的 registry digest、运行外部固定 GateHarnessV1、请求专用 audience 的 OIDC token并上传 evidence/attestation；候选仓库不能替换 harness、签名逻辑或 artifact provenance。
  - [x] 仓库 workflow 最终只发布 child evidence 和独立 child check，不得继续以 GitHub Actions App `15368` 发布权威 `architecture-required` umbrella context；同名 umbrella 只能由仓库外 Controller App/service identity 发布。
  - [x] evidence artifact 必须绑定候选 `headOid`、`evaluationContextDigest`、producer identity 与 registry/definition digest；Controller 只通过 provider API 按 run ID/attempt 拉取 artifact，并验证 `GateEvidenceAttestationV1`，禁止接受用户提交的 JSON、手工上传文件、旧 workflow run 或仅凭 evidence 内字符串自证。
  - [x] 保持现有七门禁、仓库合同 preflight 与 planning trace 真实运行；不得用 mock-only、空测试、永久 skip、无断言或始终成功脚本替代。

- [x] Task 6：部署仓库外 Controller、provider ruleset 与独立 drift monitor（AC: 2, 5）
  - [x] 在 `<external-controller-repository>` 或等价仓库外受控部署中实现 `ArchitectureGateController`；该组件不能从候选提交加载可执行策略，必须由独立 GitHub App/service identity 持有最小权限并成为 `architecture-required` 的唯一发布者。
  - [x] Controller 只接受 provider-authenticated 且与 `GateDefinitionV1.evidenceProducerId` 匹配的 child evidence；producer 使用外部仓库中按完整 commit SHA 固定的 reusable workflow，并以 GitHub Actions OIDC attestation 证明身份。Controller 必须核对 OIDC issuer/audience、repository ID `1303415307`、event、run ID/attempt、候选 head SHA、`job_workflow_ref` 的外部仓库/路径/不可变 SHA、gate job ID、GitHub Actions App 来源与 artifact digest；相同 gate/context 的相同 `gateEvidenceDigest` 重放幂等，不同 digest 冲突为 invalid。
  - [x] `evidenceProducerId` 的 V1 grammar 固定为 `gha-oidc://<repository-id>/<external-owner>/<external-repository>/.github/workflows/<workflow-file>@<40-hex-sha>#<gate-id>`；registry 中的字符串必须与受认证 claims 逐字段一致。fork PR 只能在 provider 明确批准并产生相同受信任 reusable workflow attestation 后提交 evidence，不能获得或使用 Controller secret。
  - [x] Controller 在仓库外维护单调的 `TrustedGateRegistryRecordV1`，至少绑定 repository ID、sequence、当前 `gateRegistryDigest`、来源 commit、批准证据 digest 与生效时间；普通 PR 的 registry digest 必须等于该可信根，不能由候选自证。
  - [x] registry 变更采用两阶段迁移：Controller 先把候选 registry 作为 data 解析并与可信根比较 → 外部 owner 审批新增/修改/删除及 producer/command/trigger/blocking 差异 → Controller 将批准的 proposed digest CAS 绑定到该 PR head 并允许同一 PR 的新 gate 产生证据 → 合并后再把可信根从旧 digest CAS 推进到新 digest。未批准的删除、`blocking:true→false`、trigger 收窄、command/owner/producer 改写或 digest 回退一律 invalid。
  - [x] umbrella CAS 使用最终 refinement：`{providerRepositoryId,headOid,evaluationContextDigest}`；发布前重新读取 provider 当前 base/head，任一变化立即废弃旧结论并重算，禁止复用陈旧 head 或旧 registry 结果。
  - [x] 为 `Rockyyy-S/code-graph` 的 `main` 建立 active GitHub ruleset，required status check 绑定稳定 context `architecture-required` 与 Controller GitHub App identity；规则不允许管理员、角色、团队或 App bypass，不允许仓库 PR 修改规则来源。
  - [x] 独立 drift monitor 必须位于仓库 workflow 之外，使用与 Controller 分离的运行路径和最小只读 provider 权限，持续核验 repository ID、目标分支、ruleset enforcement、required context、App identity、strict/current-head 语义、bypass actor 空集合与 Controller 配置；任一漂移使 Controller fail closed。
  - [x] 当前 provider 快照为 public GitHub 仓库 ID `1303415307`、默认分支 `main`、required context `architecture-required`、`strict=true`、发布者 app_id `15368`、`enforce_admins=false`、rulesets 空数组；实施必须显式从该不合规基线迁移，不能把当前状态当作完成证据。
  - [x] 推荐安全切换顺序：外部 Controller 先以 shadow context 处理真实 child evidence → monitor 验证预期配置 → 原子启用无 bypass ruleset 并绑定 Controller App → Controller 在同一候选 head 发布正式 `architecture-required` → 验证失败阻断与恢复 → 移除 GitHub Actions 同名发布者。迁移期间不得出现保护空窗。
  - [x] Controller 故障、证据缺失或 provider API 不可验证时暂停合并；回滚只能恢复已验证的外部 Controller/ruleset，不能重新启用管理员 bypass 或退回仓库 workflow 自证。
  - [x] provider 配置、App 创建、凭据、外部部署和受控漂移演练涉及外部/生产状态；执行前必须取得明确授权。若未提供外部仓库、部署目标或所需权限，完成仓库内工作后 HALT，Story 保持 `in-progress`，不得标记 review/done。

- [ ] Task 7：建立合同、Git、规划与 provider 的真实负向测试（AC: 1-5）
  - [x] Contract 测试覆盖所有 Gate Schema、未知字段、缺字段、非法枚举、非法 argv、重复 gateId、gate 顺序、triggerPaths 顺序/重复/反选、owner/producer 和各级 digest 不匹配。
  - [x] Unit/Integration 测试覆盖 SHA-1/SHA-256 OID、空/多 merge-base、Git 输出乱序、NUL diff、删除、rename delete+add、POSIX glob、always applicable 与 not-applicable。
  - [x] Evidence/CAS 测试覆盖 producer 不匹配、definition/context/head 不匹配、相同 digest 幂等、冲突 digest invalid、base/head 变化、旧 registry、required gate 缺证据与陈旧结论拒绝。
  - [x] 规划测试逐类破坏 FR/NFR/SM/UJ/AR/UX-DR/AD/Story/DAG/链接/ProductValidation/sprint 状态，并断言稳定相对路径、位置与修复建议；历史 reviews 中保留的旧编号不得污染当前规范检查。
  - [x] 重写 `tests/contract/ci-workflow.test.ts`、`failure-propagation.test.ts`、`quality-command-contract.test.ts` 等既有测试，从 registry 派生预期，不再复制静态七门禁列表；补充 `ci/` 安全扫描和仓库文档合同测试。
  - [ ] 真实 Hosted PR 中至少制造一次 child gate 失败，证明外部 `architecture-required` 失败且管理员也无法合并；审查修复后的 sequence=3 信任根仍需在同一候选 SHA 上复验 baseline gate、planning trace、Controller 与 drift 状态。
  - [x] 在隔离 provider 测试仓库或经批准的受控窗口演练 required check、App identity、bypass 或 ruleset 漂移；monitor 必须检测并使结论 invalid/fail，恢复后才允许重新发布 pass。
  - [x] 完整回归至少执行 `pnpm install --frozen-lockfile` 与 `pnpm architecture-required`；Story 1.2 的 graph-service 控制面、workspace-key、100 个 unit 和 99 个 contract 基线行为继续通过，但测试数量只作历史参考，不写成永久数量断言。

- [ ] Task 8：更新文档、交付证据与完成状态（AC: 2, 4, 5）
  - [x] 更新 `docs/repository-layout.md`，说明 Gate Registry、contracts、planning trace、child evidence、外部 Controller、ruleset 和 drift monitor 的 owner、数据流、失败语义与范围边界。
  - [ ] 新增 `docs/ci/story-1-3-provider-evidence.md`，记录候选完整 SHA、repository ID/visibility/实际 plan、ruleset ID/enforcement、required context 与 Controller App ID、无 bypass 证据、Controller/monitor 权限摘要、失败阻断 run、恢复 run、最终同 SHA 结论；当前仍缺实际 plan 与审查修复候选的最终 Hosted 同 SHA 证据。
  - [x] 保留 `docs/ci/story-1-1-provider-evidence.md` 与 `story-1-2-provider-evidence.md` 为历史证据，不回写旧运行冒充本 Story；本地全绿、旧候选或 shadow context 都不能替代最终候选正式 provider 结果。
  - [x] Story 交付说明逐项列出新增/变更 gate 的 `checkId`、`capabilityOwner`、`evidenceProducerId`、definition/registry digest 与验证证据。
  - [x] 只有仓库内门禁、外部 Controller、无 bypass ruleset、独立 drift monitor、真实失败阻断与最终同 SHA 通过全部成立后，才可把 Story 置为 `review`；独立代码审查完成后才可置为 `done`。
  - [x] Story 1.3 未 `done` 前，`sprint-status.yaml` 中 Story 1.4 及其他受其阻断的功能 Story 必须保持 `backlog`；不得提前创建其实现 Story 文件或并行开发。

### Review Findings

- [ ] [Review][Patch] [High] 让外部 GateHarness 校验经批准的 gate 实现摘要 — 代码与 43 项 Controller 测试已完成；候选 `gateImplementationDigest=3294b01c…` 已覆盖根命令、质量工具链和 47 个受保护文件，但 sequence=3 批准记录、推送与生产切换尚未执行。
- [ ] [Review][Patch] [High] 补充独立的 GitHub account/repository plan 证据 — 已选择保留严格验收要求；当前授权下 user 与 repository API 的 `plan` 均返回 `null`，不得以 ruleset 能力证明替代实际 plan。
- [ ] [Review][Patch] [High] Provider 证据文档已记录审查修复迁移候选，但生产仍运行旧信任根；需切换后为最终主仓库候选 SHA 补录 child/umbrella/monitor 同 SHA 证据 [docs/ci/story-1-3-provider-evidence.md]
- [x] [Review][Patch] [High] planning trace 未解析“关键合同与 Story 双向映射”，ProductValidation/Readiness 仅做全文名称包含检查，删除或改错映射仍返回零违规 [scripts/planning/check-planning-traceability.mjs:356]
- [x] [Review][Patch] [High] planning trace 未固定 61 个稳定 Story ID，协同修改标题、DAG、追踪表和 sprint key 可把 `5.12` 重编号为 `9.9` 并继续通过 [scripts/planning/check-planning-traceability.mjs:121]
- [x] [Review][Patch] [Medium] sprint 状态未限制为声明枚举，根 Story 或前置已满足 Story 的任意状态字符串可通过 [scripts/planning/check-planning-traceability.mjs:516]
- [x] [Review][Patch] [Medium] 相对链接检查错误限制到八个 source-set 文件，并对非法百分号编码抛出未处理的 `URIError`，无法提供稳定诊断 [scripts/planning/check-planning-traceability.mjs:419]
- [x] [Review][Patch] [Medium] Planning Reference Grammar 接受规格禁止的分号、删除括号内引用、未限制范围上界，且未拒绝重复 Binds/关联需求行 [scripts/planning/check-planning-traceability.mjs:187]
- [x] [Review][Patch] [Medium] trigger glob 的 `**/` 不匹配零级目录，Git 非 UTF-8 路径又会被替换字符静默解码，未来路径门禁可能被错误判为 not-applicable [scripts/ci/evaluate-gate-applicability.mjs:31]
- [x] [Review][Patch] [Medium] gate 与 Git 子进程缺少内部绝对 deadline 和终止清理；Hosted 仅依赖外层 30 分钟 job timeout，本地聚合可无限等待 [scripts/ci/run-architecture-required.mjs:123]
- [x] [Review][Patch] [Medium] GateOutputV1 缺少公共封闭 Schema/validator，`validateGateEvidenceBinding` 可接受错误 schemaVersion、非法 outputDigest 和未知字段 [scripts/ci/create-gate-evidence.mjs:55]
- [x] [Review][Patch] [Medium] GateDefinition 的公共 validator 与 registry loader 对 no-op 命令结论不一致，registry 也未拒绝重复 checkId，合同边界存在双重语义 [packages/contracts/src/runtime-validation.ts:175]
- [x] [Review][Patch] [High] 外部 producer 在同一 job/runner 中执行候选 lifecycle、gate 与 OIDC attestation，候选可改写可信 Harness 或待签名 artifact；已拆分执行/签名 job、使用非特权 UID/GID、禁用 lifecycle，并隔离 trusted/artifact 所有权 [../code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml:25]
- [x] [Review][Patch] [High] GateHarness 只在全部 gate 前校验一次实现摘要，候选后台进程可在执行期改写后续 gate；候选工作树现对 gate UID 只读，并在每项 gate 前及全部 gate 后复验摘要 [../code-graph-gate-controller/lib/harness.mjs:35]
- [x] [Review][Patch] [High] 正常退出的 gate 不清理存活后代，后台进程可继续影响后续执行；成功、失败和超时路径现均清理进程组并具备后代回归测试 [../code-graph-gate-controller/lib/run-process-with-deadline.mjs:59]
- [x] [Review][Patch] [High] Controller 对同一 CAS 的跨 run 不同 artifact/evidence digest 未判冲突；现持久比较 replay digest，不同摘要 fail closed，相同冲突幂等 [../code-graph-gate-controller/bin/run-controller.mjs:206]
- [x] [Review][Patch] [High] 可信 registry 批准未绑定真实 previous record/approval；现校验 `previous + 1`、前序 registry/producer/implementation 与固定未绑定摘要 sentinel [../code-graph-gate-controller/lib/registry.mjs:94]
- [x] [Review][Patch] [Medium] 外部 Harness 每 gate 10 分钟但 job 仅 30 分钟，没有总 deadline；现使用 2 分钟逐 gate 与 20 分钟总 deadline，耗尽后生成稳定 invalid artifact [../code-graph-gate-controller/lib/harness.mjs:15]
- [x] [Review][Patch] [High] 主仓库 CLI 接受任意 `--provider-context` 本地 JSON并生成 `provider-event` evidence；CLI 现禁止 provider 模式，仅允许外部可信 Harness 生成 Hosted evidence [scripts/ci/run-architecture-required.mjs:180]
- [x] [Review][Patch] [Medium] 主仓库与外部 Harness 会让适用但 `blocking:false` 的 gate 失败阻断聚合结果；现仅 required blocking gate 影响最终结论 [scripts/ci/run-architecture-required.mjs:97]
- [x] [Review][Patch] [Medium] `runArchitectureRequired` 注入 registry 时仍报告模块加载时 registry digest；现按实际执行 registry 重算摘要并校验 provider context 绑定 [scripts/ci/run-architecture-required.mjs:120]
- [x] [Review][Patch] [High] workflow 固定旧 producer/Harness SHA；现已按两提交顺序固定 GateHarness `c90a2ce…` 与 producer `4d3650e1…` [.github/workflows/architecture-required.yml:18]
- [x] [Review][Patch] [High] 外部 producer 通过 `pnpm/action-setup` 的 `standalone: true` 执行无锁 registry 安装、lifecycle 与浮动传递依赖，可在可信 checkout 后污染 Harness/registry/candidate；现改为 checkout 前下载 pnpm v11.12.0 官方 Linux x64 release asset、校验固定 SHA-256、限定提取 `pnpm` 与 `dist` runtime 并 root-owned 安装 [../code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml:53]
- [x] [Review][Patch] [Medium] producer workflow 合同测试未覆盖关键 pnpm 来源完整性与安装时序，删除 checksum、checkout 前安装或 root 权限约束后仍可能全绿；现固定断言官方 URL、SHA-256、HTTPS 限制、严格校验、限定成员提取、checkout 前时序与 UID 20001 实际执行 [../code-graph-gate-controller/tests/workflow-contract.test.mjs:42]
- [x] [Review][Patch] [High] pnpm v11 SEA 顶层二进制仍从 `dirname(process.execPath)/dist/pnpm.mjs` 加载 runtime，仅提取 `pnpm` 会导致 Hosted 版本验证失败；现从同一校验归档提取 `pnpm` 与 `dist`，逐个约束 canonical path/符号链接边界并整体安装为 root-owned、非组/其他用户可写 runtime [../code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml:64]

## Dev Notes

### Developer Context

- Story 1.3 是阶段 A 的最后一道地基屏障，直接依赖 Story 1.1 与 1.2；二者均已 `done`。`StoryDependencyDagV1` 明确 `1.4 -> 1.3`，Story 1.3 未完成时不得开放功能切片。
- Story 1.1 已建立七个真实、可失败、可阻断的根命令和 always-run GitHub Actions check；Story 1.2 已通过同一最小 CI，并交付每 indexing root 单实例 graph-service 控制面。
- 本 Story 的核心不是“增加 YAML 文件”，而是把 gate 定义、适用性、证据、provider 强制和规划追踪收敛为可验证的完整链路。
- 仓库内 workflow 不能证明自己不可被仓库 PR 修改。最终 `architecture-required` 必须由仓库外 Controller identity 发布；仓库 workflow 只能生成 child evidence。
- 当前 provider 已具备最小 required check，但发布者仍是 GitHub Actions App、管理员 bypass 未禁用且没有 ruleset/monitor，因此 AC2/AC5 当前明确未满足。

### Scope Boundaries

本 Story 明确不实现：

- SQLite、`graph.sqlite`、首次 rebuild、BuiltinIgnoreV1、GraphPatch、CAS 或图谱 revision；由 Story 1.4 与 1.19 负责。
- Analyzer、模块依赖、BasicSymbolV1、workspace package、规则、Findings、Impact 或 export；由后续 Story 负责。
- `ReadinessGatePolicyV1` compiler、真实 `ReadinessGateManifestV1` 候选编译、ProductValidation plan/task/fixture/evidence/result；由 Story 5.11/5.12 负责。本 Story 只定义其引用必须可追踪，普通 PR 不编译 release manifest。
- 发布签名、SBOM、四平台候选与 Go/No-Go；属于 Epic 5。
- 依赖升级或架构迁移。Node、pnpm、TypeScript 和现有测试库继续使用架构锁定版本。
- 在本仓库中保存 Controller/monitor 凭据、GitHub App private key、webhook secret 或 provider 管理 token。

### Architecture Compliance

- **AD-28 最终 refinement 优先。** `GateDefinitionV1.evidenceProducerId`、`gateRegistryDigest`、`evaluationContextDigest`、`gateEvidenceDigest`、`merge-base --all` 最小 OID 与 CAS `{providerRepositoryId,headOid,evaluationContextDigest}` 均是必需项；Implementation Guide 中较早的 `manifestDigest` 简写不得覆盖 Spine refinement。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-28能力首次落地即进入渐进式-CI]
- **职责分离。** `ci/quality-gates.v1.yaml` 是 gate 定义注册表；普通 PR 只做 trigger applicability；Readiness manifest 由后续 readiness compiler 按 policy/候选/阶段选择，不能重定义 gate。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#CI-与发布门禁]
- **追踪权威。** AD 的 `Binds` 是需求直接追踪唯一规范来源；Capability Map 的 `Governed by` 只是人工导航。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#Capability--Architecture-Map]
- **Provider fail closed。** 未知 gate、definition/command digest 不匹配、required gate 缺证据、错误 producer、旧 context、ruleset 或 drift 不一致均失败；provider 不具备仓库外强制能力时 Story 阻塞，不能降级为仓库内自检。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#CI-与发布门禁]
- **依赖边界。** 公共 Schema 与 canonical helper 归 `packages/contracts`；脚本只编排，不能复制公共合同；若外部 Controller 源码被放入本仓库，必须成为明确 deployable entry 并同步角色/边界测试，不能塞入通用脚本目录。[Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#Structural-Seed]

### Initial Gate Registry

首版 V1 值表是实现合同，不允许开发者自由改名。所有项 `blocking:true`、省略 `triggerPaths`，`evidenceProducerId` 固定为 `gha-oidc://1303415307/<external-owner>/<external-repository>/.github/workflows/produce-gate-evidence.yml@<trusted-40-hex-sha>#<gate-id>`；尖括号必须在 Task 6 外部 producer 确定后替换，带占位符的 registry 不能通过验证。

| gateId | checkId | command | capabilityOwner |
| --- | --- | --- | --- |
| `repository-contract-preflight` | `repository-contract-preflight` | `["node","scripts/contracts/validate-repository-contract.mjs"]` | `dev-enablement` |
| `type` | `type` | `["pnpm","type"]` | `dev-enablement` |
| `lint` | `lint` | `["pnpm","lint"]` | `dev-enablement` |
| `unit` | `unit` | `["pnpm","unit"]` | `qa` |
| `build` | `build` | `["pnpm","build"]` | `dev-enablement` |
| `contract` | `contract` | `["pnpm","contract"]` | `qa` |
| `dependency-boundary` | `dependency-boundary` | `["pnpm","dependency-boundary"]` | `architecture` |
| `basic-security` | `basic-security` | `["pnpm","basic-security"]` | `security` |
| `planning-traceability` | `planning-traceability` | `["pnpm","planning-trace"]` | `architecture-po` |

owner V1 枚举固定为 `dev-enablement|qa|architecture|security|architecture-po`。新增 owner 属于 registry 合同变更，必须走 `TrustedGateRegistryRecordV1` 两阶段批准，不能由候选 YAML自行扩展。

### Gate Registry and Producer Trust Protocol

- `ci/quality-gates.v1.yaml` 是候选仓库中 gate 定义的唯一机器清单，但不是自己的信任根。外部 Controller 持有 `TrustedGateRegistryRecordV1`，候选不能修改、覆盖或回滚该记录。
- 首次 bootstrap 由 release/platform owner 对首版九 gate 的完整 registry/digest 做外部批准并写入可信根；在这一步完成前，Controller 只能发布 shadow 结论，不能宣称 AC2 完成。
- 无 registry 变化的普通 PR 必须精确匹配可信 digest。registry 变化 PR 必须先通过差异策略与外部批准，再由 Controller 把 proposed digest CAS 绑定到该 head；批准只对该 repository/head/digest 有效。
- 允许在同一 PR 首次公开能力与新增真实 gate：先批准 proposed registry，再由可信外部 reusable workflow 按 proposed digest 运行新 gate，最后 Controller 聚合；不能先合并能力、后补 gate。
- 删除 gate、关闭 blocking、收窄 trigger、替换命令/owner/producer、降序回退或用语义等价字符串规避 digest 都视为弱化变更；未取得显式外部批准时 fail closed。
- Controller 解析 registry 仅作为 data，不执行候选命令；命令只在受信任 reusable workflow 的隔离 job 中以 `shell:false` argv 执行。Controller 的 App 只读取证据和发布结论。

`GateEvidenceAttestationV1` 是 GateEvidence 外层的 provider provenance 封闭合同，至少包含：`schemaVersion:1`、`providerRepositoryId`、`providerRunId`、`runAttempt`、`eventName`、`headOid`、`workflowRef`、`jobWorkflowRef`、`jobId`、`githubActionsAppId`、`artifactDigest`、`gateEvidenceDigest` 与 OIDC token digest/verification result。Controller 必须从 provider API 和验证后的 OIDC claims 重建这些字段，不能信任 artifact 自报值。

### Planning Trace Source Set

| 角色 | 规范路径 |
| --- | --- |
| PRD | `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/prd.md` |
| PRD Addendum | `_bmad-output/planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md` |
| Architecture | `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md` |
| Implementation Guide | `_bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md` |
| UX Experience | `_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/EXPERIENCE.md` |
| UX Design | `_bmad-output/planning-artifacts/ux-designs/ux-bmad-2026-07-13/DESIGN.md` |
| Epics / Stories / DAG | `_bmad-output/planning-artifacts/epics.md` |
| Sprint state | `_bmad-output/implementation-artifacts/sprint-status.yaml` |

路径集合必须在脚本中以版本化常量声明并由 contract test 精确验证；任一路径迁移必须与规划文档变更同 PR 更新。不得通过递归 glob 把 dated review/reconcile/report 纳入规范语义。

### Planning Reference Grammar

- 规范 ID：`FR-<1..23>`、`NFR-<1..27>`、`SM-<1..8>`、`UJ-<已定义范围>`、`AR-<1..32>`、`UX-DR<1..37>`、`AD-<1..30>`、`Story <epic>.<story>`；`UX-DR-1`、裸 `DR1`、前导零和越界编号 invalid。
- 列表分隔只接受中文顿号 `、`、中文逗号 `，`、英文逗号 `,` 与 Markdown 单元格分隔；每个 token 必须保留或从同一 range 左端继承明确前缀。
- range 只接受同前缀升序的 `PREFIX-a 至 PREFIX-b`、`PREFIX-a–PREFIX-b` 或 `PREFIX-a–b`；右端裸数字只允许在同一 token 中继承左端前缀。反向、跨前缀、开区间、`+`、`etc.` 或无法展开的自然语言 invalid。
- `N/A` 只允许出现在明确声明“不适用”的导航矩阵单元格，不生成引用边；Architecture `Binds` 中仅白名单 symbolic tokens `all|deployment|traceability` 可不解析为需求 ID，其他未知词 invalid。
- 双向检查按边类型分别计算：Story→Requirement 来自 Story `关联需求`；AD→Requirement 只来自 AD `Binds`；Contract→Story 来自关键合同映射；DAG→Story 来自 `StoryDependencyDagV1`。每条目标必须存在，人工维护的反向表若存在必须与计算结果相等，不能用一个边类型替代另一个。
- Story 5.11 前，ProductValidation 合同名与 Story/Architecture/PRD 映射必须存在且一致，但允许具体 plan/manifest 文件尚不存在；一旦出现具体相对路径、planVersion 或 digest 引用，路径必须存在且所有已声明引用一致，不能使用“未来补充”绕过。

### Current Repository State and Required Updates

- `package.json`：当前定义七个真实质量脚本与 `architecture-required`，缺少 planning trace。应保留七命令语义并新增 registry 驱动入口。
- `scripts/ci/run-architecture-required.mjs`：当前硬编码 `QUALITY_GATES`、串行首败退出，不读取 registry、不计算 context/applicability、不生成 evidence。应改为 registry 驱动并保留真实非零传播。
- `.github/workflows/architecture-required.yml`：当前 PR/main always-run、无 path filter、Action SHA 已锁定，但 job 直接发布 `architecture-required`。最终应只产 child evidence，由外部 Controller 发布 umbrella。
- `scripts/contracts/validate-repository-contract.mjs`：当前再次硬编码七条命令；应从 registry 派生并验证新增 planning trace、producer/owner/digest。
- `scripts/security/check-basic-security.mjs`：当前扫描 apps/packages/scripts/workflow 与根配置，尚未覆盖顶层 `ci/`；应扩展且继续拒绝凭据。
- `packages/contracts/src/service-control-schema.ts`、`runtime-validation.ts`、`index.ts`：已建立封闭 Schema、Ajv validator 与统一出口模式；Gate 合同按相同模式新增。
- `packages/service-client/src/workspace-identity.ts` 与 `apps/graph-service/src/instance-owner.ts`：已有两处 canonical/hash 实现；应迁移到 contracts 单一 helper，并用回归测试证明身份与完整性不漂移。
- `tests/contract/ci-workflow.test.ts`、`failure-propagation.test.ts`、`quality-command-contract.test.ts`：当前复制静态门禁假设；应从 registry 派生并验证 Controller/evidence 边界。
- `docs/repository-layout.md`：当前描述 GitHub Actions 直接发布 required check；应更新为完整控制面。

### Expected File Structure

高置信度新增：

- `ci/quality-gates.v1.yaml`
- `packages/contracts/src/quality-gate.ts`
- `packages/contracts/src/quality-gate-schema.ts`
- `packages/contracts/runtime/canonical-json.mjs`
- `packages/contracts/runtime/canonical-json.d.mts`
- `packages/contracts/src/canonical-json.ts`
- `scripts/ci/load-quality-gates.mjs`
- `scripts/ci/evaluate-gate-applicability.mjs`
- `scripts/ci/create-gate-evidence.mjs`
- `scripts/planning/check-planning-traceability.mjs`
- `tests/unit/quality-gate-registry.test.ts`
- `tests/unit/gate-applicability.test.ts`
- `tests/unit/gate-evidence.test.ts`
- `tests/unit/planning-traceability.test.ts`
- `tests/contract/quality-gates-manifest.test.ts`
- `tests/contract/planning-traceability.test.ts`
- `tests/fixtures/planning-*` 与固定 Git 图 fixture
- `docs/ci/story-1-3-provider-evidence.md`

高置信度更新：

- `package.json`
- `.github/workflows/architecture-required.yml`
- `scripts/ci/run-architecture-required.mjs`
- `scripts/contracts/validate-repository-contract.mjs`
- `scripts/security/check-basic-security.mjs`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/runtime-validation.ts` 或独立 Gate validator 出口
- `packages/service-client/src/workspace-identity.ts`
- `apps/graph-service/src/instance-owner.ts`
- `tests/contract/ci-workflow.test.ts`
- `tests/contract/failure-propagation.test.ts`
- `tests/contract/quality-command-contract.test.ts`
- `tests/contract/root-toolchain.test.ts`
- `tests/contract/basic-security-coverage.test.ts`
- `tests/contract/repository-documentation.test.ts`
- `tests/unit/workspace-identity.test.ts`
- `docs/repository-layout.md`

`pnpm-lock.yaml` 只有新增依赖时更新；现有 `yaml`、Ajv 与 `node:crypto` 足以实现本 Story，优先不增加依赖。若新增 provider SDK 或 JCS 包，必须同步依赖角色 allowlist 与负向边界测试，不能静默放宽。

### Provider Snapshot and Rollout Guardrails

2026-07-23 只读核验：

| 项目 | 当前值 | Story 1.3 目标 |
| --- | --- | --- |
| Provider | GitHub，public repository | 继续使用 GitHub |
| Repository | `Rockyyy-S/code-graph`，ID `1303415307` | Controller/monitor 固定校验该 ID |
| Default branch | `main` | active ruleset 精确覆盖 `main` |
| Required context | `architecture-required`，strict | 名称保持，来源改为外部 Controller App |
| 当前 App | `15368`（GitHub Actions） | 外部 GitHub App/service identity |
| Admin enforcement | `enforce_admins=false` | 无管理员 bypass |
| Rulesets | 空数组 | active、无 bypass、绑定 Controller check source |
| Drift monitor | 不存在 | 仓库外独立 monitor 持续验证 |

GitHub 当前文档说明 public repository 可在 GitHub Free 使用 repository rulesets；最终证据仍必须记录实际 account/repository plan 与可用权限。Checks API 的外部发布应使用 GitHub App 最小权限；个人 token 或仓库 `GITHUB_TOKEN` 不能作为仓库外唯一 publisher 的替代。

### Previous Story Intelligence

- Story 1.1 证明了真实失败传播、隔离负向 fixture、完整 Action SHA、无 path filter、无 skip/no-op 和 provider required check；同时明确把管理员强制、完整 registry、Controller 与 drift monitor留给本 Story。[Source: 1-1-建立仓库模板-依赖边界与最小真实-ci.md#Dev-Notes]
- Story 1.2 的十二轮复审显示：边界输入必须先校验再产生副作用，所有外部/异步流程要有绝对 deadline 与可恢复清理，Schema 必须运行时校验，旧证据和本地全绿不能替代当前候选同 SHA Hosted 结果。[Source: 1-2-启动空-graph-service-并完成协议握手.md#Previous-Story-Intelligence]
- Story 1.2 最终 Hosted run `29908232554` 在候选 `21c25f6c5381539910daba7a151f2d4cc121fc48` 上通过七门禁；此前两次 Linux 失败证明跨平台 Git/路径/进程行为不能只靠 Windows 本地结果。[Source: ../../docs/ci/story-1-2-provider-evidence.md#GitHub-Provider-运行]
- Provider 证据与状态转换应分离：只有最终候选同 SHA 的 Hosted 证据存在后才能关闭任务并推进 Story 状态。

### Git Intelligence

- `e29edc1`：合并 Story 1.2，当前 main 基线。
- `612fc1e`：只回填最终 Hosted 证据与状态，体现“先证据、后 done”。
- `21c25f6`、`92d11e5`：Hosted Linux 分别暴露合同/单元 fixture 的 UDS 路径预算问题，采用最小修复并保留中文 JSDoc。
- `01bcf2d`：集中强化 deadline、有界 JSON-RPC、回收、日志安全与 canonical 校验；实现与真实负向测试同行。
- 延续模式：Red → Green → Refactor；实现与测试同提交；provider 失败样本保留；旧运行不替代新候选；不触碰无关用户文件。

### Latest Technical Information

- 项目继续锁定 Node 24.18.0、pnpm 11.12.0、TypeScript 6.0.3、Vitest 4.1.10、YAML 2.9.0、Ajv 8.20.0。
- 2026-07-23 registry 核验：TypeScript 最新为 7.0.2、pnpm 最新为 11.16.0；Vitest 4.1.10、YAML 2.9.0、Ajv 8.20.0 与当前锁定一致。架构仍明确锁定 TypeScript 6.0.3 与 pnpm 11.12.0，本 Story 禁止顺手升级；升级需独立架构决策和兼容性验证。
- GitHub rulesets 可用于 public GitHub Free repository；ruleset 支持显式 bypass actors，因此完成证据必须证明 bypass actor 空集合，而不是只证明规则存在。[GitHub Docs: About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- GitHub 外部 check publisher 应使用 GitHub App Checks API；Controller 需最小权限、provider authentication、head/context CAS 和重新核对当前 base/head。[GitHub REST: Check runs](https://docs.github.com/en/rest/checks/runs)

### Testing Standards

- 使用 Vitest 4.1.10；unit 与 contract 配置保持 `passWithNoTests:false`，继续由 marker checker 阻断 skip/todo/only。
- 测试优先使用真实子进程、临时 Git repository、固定 commit graph、真实 NUL diff 与隔离 provider test repository；不能只 mock `git` 输出或 provider 结论。
- Provider 变更测试不得在未授权情况下弱化生产 `main` 保护；优先在隔离仓库演练，生产切换使用明确窗口并保持无保护空窗。
- 所有新增 TypeScript/JavaScript 接口、类、方法与复杂逻辑使用中文 JSDoc；诊断和文档注释使用中文，稳定 machine code/ID 不本地化。
- 验证输出不得包含 token、GitHub App key、webhook secret、绝对本机路径、用户凭据或候选源码内容。

### References

- [Source: ../planning-artifacts/epics.md#Story-13强化-provider-阻断与规划双向追踪门禁]
- [Source: ../planning-artifacts/epics.md#StoryDependencyDagV1权威]
- [Source: ../planning-artifacts/epics.md#关键合同与-Story-双向映射]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-21本地图谱查询服务]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#FR-22图谱状态与故障恢复]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/prd.md#非功能需求]
- [Source: ../planning-artifacts/prds/prd-bmad-2026-07-09/addendum.md#57-产品验证与发布适用性合同]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#AD-28能力首次落地即进入渐进式-CI]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md#Capability--Architecture-Map]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#13-验证与门禁]
- [Source: ../planning-artifacts/architecture/architecture-bmad-2026-07-13/IMPLEMENTATION-GUIDE.md#15-开发完成定义]
- [Source: ../test-artifacts/test-design-qa.md#Entry-Criteria]
- [Source: ../test-artifacts/test-design-qa.md#Atomic-Coverage-Plan]
- [Source: 1-1-建立仓库模板-依赖边界与最小真实-ci.md]
- [Source: 1-2-启动空-graph-service-并完成协议握手.md]
- [Source: ../../docs/ci/story-1-1-provider-evidence.md]
- [Source: ../../docs/ci/story-1-2-provider-evidence.md]

## Dev Agent Record

### Agent Model Used

GPT-5 Codex

### Implementation Plan

- 严格按 Task 1→8 顺序执行；每项遵循 Red→Green→Refactor，并在勾选前运行相关测试与完整 unit/contract 回归。
- 仓库内实现完成后再进入外部 Controller、ruleset 与 drift monitor；未取得外部授权时按 Task 6 规定保持 `in-progress`。

### Debug Log References

- Task 1 RED：新增 canonical/Gate 合同测试后，因实现与导出缺失按预期失败。
- Task 1 GREEN：定向 33 tests、完整 117 unit tests、99 contract tests 通过；type 与 lint 通过。
- Task 2 HALT：只读核验未发现外部 Controller 仓库或已批准的 immutable producer workflow SHA；按 Story 禁止写入占位 producer URI 或使用候选仓库 workflow 冒充信任根。
- Task 2 RESUME：获授权后创建 `Rockyyy-S/code-graph-gate-controller`，固定 producer workflow SHA `616633c1e594174e4964672f1d04e94718995940` 并回填九项真实 producer URI。
- Task 2 GREEN：29 个定向 contract tests、完整 117 unit tests、108 contract tests 通过；type、lint、dependency-boundary、basic-security、planning-trace 通过。
- Task 3 RED/GREEN：真实 SHA-1/SHA-256 临时仓库、NUL diff、delete+add rename、provider/local-fixture 与 applicability 测试先失败后通过。
- Task 3 回归：完整 123 unit tests、108 contract tests 通过；type 与 lint 通过。
- Task 4 RED/GREEN：16 类规划漂移测试先失败后通过；修正 Architecture Binds 的未声明缩写/旧 range grammar，并使 epics 人工反向追踪表与 Story 关联需求完全一致。
- Task 4 回归：完整 139 unit tests、110 contract tests 通过；type、lint、planning-trace 通过。
- Task 5 RED/GREEN：GateOutput/Evidence 与全门禁失败传播测试先失败后通过；候选 workflow 已仅调用外部 producer SHA `616633c1e594174e4964672f1d04e94718995940`。
- Task 5 真实聚合：首轮九项中既有 launcher 时序测试瞬态失败，runner 正确阻断并保留旁路日志；单独复跑 unit 147/147 通过，第二轮九项 `architecture-required` 全部通过。
- 外部 Controller policy、provider API poller、GitHub attestation 验证和 drift policy 已在 `Rockyyy-S/code-graph-gate-controller` 提交并推送至 `10487d2`。
- Task 6 RED/GREEN：真实 Hosted run 暴露 reusable workflow SHA 错绑与互斥 attestation CLI 参数；新增合同测试后修复为显式 `producer_workflow_sha`，Controller 再逐字段验证 issuer、repository、run/attempt、merge ref、signer SHA、artifact digest、gate job 与 GitHub Actions App `15368`。
- Task 6 Hosted child：run `29979602524` attempt 1 因 sequence=1 未批准新 registry 正确失败；sequence=2 生效后 attempt 2 在候选 `d54be3b34eddc55c3e7f65dafe8682718290904a` 九项 gate 全部通过，attested evidence digest 为 `1d0d0e573bb8fd5ece802335d89246f0caeaf4965bf59b99f0345f73ed529f44`。
- Task 6 Provider 激活：创建并安装 Controller App `4372284` 与只读 Drift Monitor App `4372296`，配置四项 Secrets；ruleset `19603163` 为 active/strict、bypass 空集合、`current_user_can_bypass=never`，旧 Actions required check 已安全移除。
- Task 7 真实阻断：候选 `b2c2e540e89d6a8fb2fa53a41c97a741c031430f` 的 child run `29987139754` 与 Controller check `89141740442` 失败，PR 显示 `BLOCKED`；revert 后候选 `e416735c0d42d84324dd3c6dacd4235ae44cd3df` 的 child run `29987370737` 与 Controller check `89142452033` 恢复通过。
- Task 7 漂移演练：monitor `29987529815` 检出错误 integration ID 的 `required-check-drift`，Controller `29987576544` fail closed；恢复后 monitor `29987637959` 与 Controller `29987688733` 通过。
- 最终完整回归：`pnpm install --frozen-lockfile` 成功；已知顺序测试的 CI 并行目录同步预算由 500ms 调整为 2s，25ms deadline 负向语义保持；`pnpm architecture-required` 九项全部通过，外部 Controller tests 23/23 通过。
- Review 修复：planning trace、GateOutput/Evidence、no-op/checkId、glob/UTF-8 与绝对 deadline 的 9 项仓库内 finding 已闭合；完整 `type`、`lint`、160 unit、113 contract 与九项 `architecture-required` 通过。
- Review 外部迁移：GateHarness `c90a2ceaea134228ce81e1045d27e32de1f4937f`、producer `4d3650e1698afe83dbb347a3f9115dcc40b6d352`、registry `0a4937d9…`、implementation `3294b01c…` 与 43 项 Controller 测试已就绪；未推送、未生成 sequence=3 owner 批准记录、未切换生产。

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Task 1：交付 checked-in JCS/SHA-256 runtime、四类 Gate V1 合同/Schema/Ajv 校验，并移除 workspace identity 与 metadata integrity 的平行 canonical/hash 实现。
- Task 2：交付唯一九项 Gate Registry、registry loader、真实 planning-trace 入口、registry 派生 runner/仓库合同及 `ci/`/provider evidence 安全扫描。
- Task 3：交付固定 Git OID evaluator、确定性 merge-base、NUL name-status parser、受限 POSIX glob 与明确不可生成 Hosted evidence 的 local-fixture 模式。
- Task 4：交付固定八文件 source set、Planning Reference Grammar、定义/Story/AD/DAG/反向表/链接/ProductValidation/sprint 屏障检查及稳定相对诊断。
- Task 5：交付全量继续执行但最终 fail-closed 的 registry runner、GateOutput/GateEvidence、旁路原始日志、外部固定 child workflow 与 provider API/attestation Controller policy。
- Task 6：已交付独立 App 身份、immutable producer、sequence=2 可信 registry、provider attestation/CAS、active/strict/无 bypass ruleset 与独立只读 drift monitor。
- Task 7：已交付合同/Git/规划/provider 全量负向测试、真实 umbrella 失败阻断、最终恢复和 App identity 漂移演练。
- Task 8：已更新九项 gate owner/producer/digest 候选表与迁移说明；实际 plan、sequence=3 生产信任根和最终 Hosted 同 SHA 证据仍阻塞完成。

### File List

- apps/graph-service/src/instance-owner.ts
- packages/contracts/runtime/canonical-json.d.mts
- packages/contracts/runtime/canonical-json.mjs
- packages/contracts/src/canonical-json.ts
- packages/contracts/src/index.ts
- packages/contracts/src/quality-gate-schema.ts
- packages/contracts/src/quality-gate.ts
- packages/contracts/src/runtime-validation.ts
- packages/service-client/src/workspace-identity.ts
- tests/unit/canonical-json.test.ts
- tests/unit/quality-gate-registry.test.ts
- ci/quality-gates.v1.yaml
- package.json
- scripts/ci/load-quality-gates.mjs
- scripts/ci/run-architecture-required.mjs
- scripts/ci/run-process-with-deadline.mjs
- scripts/contracts/validate-repository-contract.mjs
- scripts/planning/check-planning-traceability.mjs
- scripts/security/check-basic-security.mjs
- tests/contract/basic-security-coverage.test.ts
- tests/contract/quality-command-contract.test.ts
- tests/contract/quality-gates-manifest.test.ts
- tests/contract/repository-contract-negative.test.ts
- scripts/ci/evaluate-gate-applicability.mjs
- tests/unit/gate-applicability.test.ts
- _bmad-output/planning-artifacts/architecture/architecture-bmad-2026-07-13/ARCHITECTURE-SPINE.md
- _bmad-output/planning-artifacts/epics.md
- tests/contract/planning-traceability.test.ts
- tests/unit/planning-traceability.test.ts
- .github/workflows/architecture-required.yml
- .gitignore
- scripts/ci/create-gate-evidence.mjs
- tests/contract/ci-workflow.test.ts
- tests/contract/failure-propagation.test.ts
- tests/unit/gate-evidence.test.ts
- docs/repository-layout.md
- docs/ci/story-1-3-provider-evidence.md
- _bmad-output/implementation-artifacts/sprint-status.yaml
- tests/contract/repository-documentation.test.ts
- tests/unit/connect-first-discovery.test.ts

### Change Log

- 2026-07-23：完成 Story 1.3 全部 Task 1–8、生产 Provider 激活、真实失败阻断、漂移恢复与最终回归；状态更新为 `review`。
- 2026-07-23：代码审查修复 8 项仓库内缺陷并准备 sequence=3 外部信任根迁移；因实际 plan、生产切换与最终 Hosted 同 SHA 证据未完成，状态恢复为 `in-progress`。
