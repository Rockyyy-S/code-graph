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
- `exports`: `star:value | star:type | reexport:{canonical-exported-name}:{canonical-imported-name}:value|type | local:{canonical-exported-name}:value|type | default:value|type`

`reexport` 的 exported/imported 两个 `ModuleExportName` 段分别使用既有解码语义读取，再由规范 serializer 重新编码；重新编码结果必须与输入逐字节相同。这是 edge 身份唯一性边界，不是普通格式检查：不可解码输入、非规范 percent 大小写、无必要 percent encoding、截断 percent 和内部 `%u` 退避表示全部 fail-closed。字面包含 `%u` 的合法名称使用标准 percent-encoding `%25u`，不与内部表示混淆。

### ModuleExportName ASCII escape

为使合法 TypeScript `ModuleExportName` 在 `reexport` qualifier 中保持可逆且满足 AD-4 的 canonical ASCII 边界，规范 serializer 只对以下两类输入使用 ASCII 逃逸：

- 空名称编码为唯一的 `` `~e` ``，解码后恰为空字符串。
- 含孤立 UTF-16 代理项的合法 AST 名称编码为 `` `~uXXXX...` ``：`~u` 后是一个或多个四位大写十六进制 UTF-16 code unit，按原始顺序完整保留名称；解码后必须逐 code unit 恢复原值。

上述逃逸仅适用于已由 TypeScript 语法确认的合法 `ModuleExportName`，不是任意 qualifier 或普通字符串的通用转义。普通名称仍使用规范 percent-encoding，其中字面 `~` 必须编码为 `%7E`；`~e` 与匹配 `` `~u[0-9A-F]{4}+` `` 的文本因此不会与普通名称混淆。消费者必须执行 decode → canonical re-encode，并要求结果与输入逐字节相同；持久化 qualifier 本身始终为 ASCII，不包含 lone surrogate。真正非规范的内部 `%u` 退避仍按 AD-4 fail-closed 拒绝。

同一 tuple 重放只产生同一 ID；若同一 ID 对应不同 tuple，必须抛出稳定错误 `GRAPH_EDGE_ID_COLLISION`。禁止 salt、覆盖或 fallback。

`local` 与 `default` qualifier 仅用于 file→symbol 的 source-derived exports 边。`local` 的名称段复用上述 `ModuleExportName` 规范编码；`default` 不携带名称段。无法解析到受支持 `BasicSymbolV1` 的本地导出不生成 placeholder symbol，也不生成 file→file 假边。

## BasicSymbol identity v1

`buildBasicSymbolId` 的输出形式为 `cg://{workspaceKey}/symbol/v1/{digest}`，唯一预像为：

```json
["codegraph.basic-symbol-id",1,"workspaceKey","fileId","language","kind","qualifiedName","signatureDigest"]
```

`fileId` 必须是工作区作用域的 file ID；`qualifiedName` 与签名语义必须 Unicode NFC 规范化。range、`exported`、`detectedAt`、Worker 枚举顺序与宿主绝对路径不得进入身份。函数实现体不属于签名；参数、返回类型等签名语义变化则会产生新 ID。同名声明只在同一 `SourceFile` 内归并，跨文件 interface/namespace 因 `fileId` 不同必须保持独立身份与 ownership。

## Legacy compatibility

`buildLegacyGraphEdgeIdV0` 只允许在 SQLite v1-v3 migration、历史 succeeded Job 验证及显式严格 normalization/import 边界使用。接受旧 ID 时必须 decode 后 byte-for-byte re-encode；旧编码永不成为 canonical 写入或输出，也不得建立永久 alias table 或 dual-read。

## SQLite v4 migration

`sqlite-v4-eager-transactional-ad4-rekey` 保持精确八张应用表。在取得 IMMEDIATE 锁并重检版本后，同一事务必须完成：

1. 严格验证 v3 legacy 身份、外键、拓扑、ownership 与 Job 证据。
2. 重键 `edges.id`、`evidence.edge_id`、Evidence ID，以及 edge/evidence `facts_ownership.fact_id`。
3. 重算 current committed `targetGraphDigest`、`read_set_json`/digest、workspace `patch_digest`、succeeded Job `patch_digest` 和相关 meta。
4. 交叉验证 schema、FK、身份、拓扑、ownership、Job、read-set、meta 与 digest 后提交。

迁移不得改变 graphRevision、节点、workspace、端点、qualifier、语义字段或时间戳，也不得伪造 rebuild Job。hierarchy-only legacy schema-v1 current Job 只重键 contains edge，不补造不存在的 read-set；历史非 current succeeded Job 保留历史证据。v4 reopen 只执行验证。
