# Reviewer Gate Round 5 — 2026-07-16 最终确认

## 结论

**PASS。** 本轮仅重放 Round 4 的两个阻塞反例：ReadinessGatePolicyV1 phase 闭包与 GateEvidenceV1 重放 digest。最新 `ARCHITECTURE-SPINE.md` 已使两个独立下层实现得到唯一结果，未发现残余阻塞。

机械检查：`lint_spine.py` 返回 `ok=true, total_findings=0`。本次未修改 Spine 或 Guide。

## 1. Phase 闭包复核

### Round 4 反例

- 实现 A：`beta/exit` 仅继承祖先 slice 的同名 exit phase。
- 实现 B：`beta/exit` 累计祖先全部 phase，并累计当前 slice 的 entry+exit。

### 最新约束

AD-30 现已固定：

1. phase 严格排序为 `entry < exit < release`。
2. 目标 slice 只纳入自身小于等于目标 phase 的规则。
3. 每个 inherits 祖先 slice 纳入其全部已声明 phase。
4. gate 集按 gateId 排序去重。
5. 同 gateId 对应不同 gateDefinitionDigest 时为 invalid。
6. `beta/exit` 的规范示例明确为 alpha 全部 phase + beta entry/exit。

因此实现 A 已不再合规；任意合规 compiler 对相同 policy、registry、candidate、releaseSlice/gatePhase 必须产生相同 gate 集和 manifestDigest。该阻塞已关闭。

## 2. GateEvidence digest 复核

### Round 4 反例

- 实现 A：对完整 GateEvidenceV1 计算 evidence digest，status/producer 等字段变化构成冲突。
- 实现 B：把 outputDigest 当作 evidence digest，相同输出即视为幂等，即使 status 不同。

### 最新约束

AD-28 现已固定：

1. GateEvidenceV1 必须包含 `gateEvidenceDigest`。
2. digest 输入是省略 `gateEvidenceDigest` 字段后的完整 GateEvidenceV1。
3. 算法为 RFC 8785 JCS → UTF-8 → SHA-256 小写十六进制。
4. Controller 的幂等重放、冲突判定和缓存键只允许使用 gateEvidenceDigest。
5. 禁止使用对象地址、时间戳、provider check URL 或仅使用 outputDigest 代替。

因此实现 B 已不再合规；status、producer、gate definition、context 或 head 任一变化都会改变 gateEvidenceDigest，同 digest 才能幂等，不同 digest 必须按冲突处理。该阻塞已关闭。

## 两实现最终重放

| 输入 | 实现单元 A | 实现单元 B | 结果 |
| --- | --- | --- | --- |
| 同一 policy + `beta/exit` | alpha 全 phase + beta entry/exit | alpha 全 phase + beta entry/exit | gateId 集与 manifestDigest 相同 |
| 同 gate/context，完整 Evidence 相同 | 相同 gateEvidenceDigest，幂等 | 相同 gateEvidenceDigest，幂等 | 状态相同 |
| 同 gate/context，output 相同但 status 不同 | gateEvidenceDigest 不同，冲突 invalid | gateEvidenceDigest 不同，冲突 invalid | 状态相同 |

## 阻塞项

无。

## Gate 判定

Round 5 对指定两项的 Reviewer Gate 结论为 **PASS**。phase applicability 与 child evidence identity 已从禁止性描述收敛为可机器执行的唯一合同，两个逐字合规实现不再能产生不兼容结果。
