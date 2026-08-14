# Graph Edge Identity Protocol v1

## Authority

- `protocol_id`: `graph-edge-id-ad4-v1`
- `version`: `1`
- canonical builder: `buildGraphEdgeId`
- output: `cg://{workspaceKey}/edge/v1/{digest}`

`workspaceKey` 必须直接使用 `deriveWorkspaceIdentity` 已产生的 64 位 SHA-256 小写十六进制；不得重 hash，也不得以宿主路径替代。

## Canonical preimage

关系身份的唯一预像是以下七元数组：

```json
["codegraph.graph-edge-id",1,"workspaceKey","relationType","fromId","toId","qualifier"]
```

实现必须按 RFC 8785 JCS 序列化、编码为 UTF-8，并计算 SHA-256 小写十六进制。所有字符串必须在调用前已经是 Unicode NFC，且不得包含不成对 UTF-16 代理项；实现遇到非规范输入必须拒绝，禁止静默 normalize。

qualifier 词汇：

- `contains`: `""`
- `imports`: `value | type | dynamic`
- `exports`: `star:value | star:type | reexport:{canonical-exported-name}:{canonical-imported-name}:value|type`

`reexport` 的 exported/imported 两个 `ModuleExportName` 段分别使用既有解码语义读取，再由规范 serializer 重新编码；重新编码结果必须与输入逐字节相同。这是 edge 身份唯一性边界，不是普通格式检查：不可解码输入、非规范 percent 大小写、无必要 percent encoding、截断 percent 和内部 `%u` 退避表示全部 fail-closed。字面包含 `%u` 的合法名称使用标准 percent-encoding `%25u`，不与内部表示混淆。

同一 tuple 重放只产生同一 ID；若同一 ID 对应不同 tuple，必须抛出稳定错误 `GRAPH_EDGE_ID_COLLISION`。禁止 salt、覆盖或 fallback。

## Legacy compatibility

`buildLegacyGraphEdgeIdV0` 只允许在 SQLite v1-v3 migration、历史 succeeded Job 验证及显式严格 normalization/import 边界使用。接受旧 ID 时必须 decode 后 byte-for-byte re-encode；旧编码永不成为 canonical 写入或输出，也不得建立永久 alias table 或 dual-read。

## SQLite v4 migration

`sqlite-v4-eager-transactional-ad4-rekey` 保持精确八张应用表。在取得 IMMEDIATE 锁并重检版本后，同一事务必须完成：

1. 严格验证 v3 legacy 身份、外键、拓扑、ownership 与 Job 证据。
2. 重键 `edges.id`、`evidence.edge_id`、Evidence ID，以及 edge/evidence `facts_ownership.fact_id`。
3. 重算 current committed `targetGraphDigest`、`read_set_json`/digest、workspace `patch_digest`、succeeded Job `patch_digest` 和相关 meta。
4. 交叉验证 schema、FK、身份、拓扑、ownership、Job、read-set、meta 与 digest 后提交。

迁移不得改变 graphRevision、节点、workspace、端点、qualifier、语义字段或时间戳，也不得伪造 rebuild Job。hierarchy-only legacy schema-v1 current Job 只重键 contains edge，不补造不存在的 read-set；历史非 current succeeded Job 保留历史证据。v4 reopen 只执行验证。
