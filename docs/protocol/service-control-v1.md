# Service Control V1

## Owner 与范围

- `packages/contracts`：版本、DTO、JSON Schema 2020-12、Ajv validator 与稳定错误注册表。
- `packages/service-client`：workspace 身份、发现、按需启动、连接与兼容响应解析。
- `apps/graph-service`：唯一运行时组合根、实例所有权、本机 IPC 与权威状态。

V1 是控制面薄切片，实现 `initialize`、最小公共 `job/start`、`service/status` 与
`service/shutdown`。
`initialize` 是必需方法，不属于可选 capability。服务只声明按字面量排序的：

1. `job/start`
2. `service/shutdown`
3. `service/status`

`job/start` 当前只接受封闭的 rebuild 请求；服务根据是否已有持久提交把实际 Job 记录为
`initial-index` 或 `rebuild`。图谱查询、取消/恢复、增量索引、规则检查、完整缓存治理与 UI
仍不在本合同范围内。

## 独立版本

`protocolVersion`、`graphSchemaVersion`、`rulesSchemaVersion`、`cliSchemaVersion` 独立演进。
当前四者均为整数 `1`，但不得合并为单一字段。协议只用主版本判断兼容性；同一主版本的
可选扩展通过 capabilities 和客户端兼容解析处理，不编码未定义的 minor 数字。

## Workspace 身份与发现

客户端先对 indexing root 执行 realpath。稳定 Git 身份由受信任宿主注入，并规范化为
去凭据 remote 与 Unicode NFC 的相对 POSIX subroot；没有稳定 Git 身份时使用规范 file
URI。完整 `WorkspaceIdentityInputV1` 经 RFC 8785 JCS、UTF-8、SHA-256 生成小写十六进制
workspace-key。

metadata、32-byte 随机 token、owner lock、日志与 UDS 位于当前用户 OS 缓存，不写入
workspace。metadata 不含 token，并包含 workspace-key、PID、endpoint、实例 ID、epoch、
创建时间与完整性摘要。未知版本、符号链接、非普通文件、不安全 POSIX 权限、身份或摘要
不匹配均 fail-closed。

公共 `connectToGraphService` 不接受缓存根覆盖；隔离缓存根只通过未从包根导出的仓库测试
入口注入。显式测试缓存根必须是绝对路径；无效的相对 `XDG_CACHE_HOME` 或
`LOCALAPPDATA` 会被忽略并回退到当前用户标准缓存目录。

发现顺序固定为 connect-first，再按需启动。只有成功以独占创建取得 owner lock 的进程
可以创建 token 和 bind endpoint。启动顺序为：

1. 取得排他所有权；
2. 创建 token；
3. bind Named Pipe/UDS；
4. 生成 `serviceInstanceId` 与 `statusEpoch`；
5. 原子发布 metadata；
6. 完成 SQLite、ignore 与共享 runtime 启动屏障；
7. 开放 initialize 握手。

疑似 stale 证据不会在 V1 回收；完整崩溃恢复属于 Story 1.17。

### 旧版缓存恢复

当客户端返回 `SERVICE_LEGACY_CACHE_MIGRATION_REQUIRED` 时，当前版本不会自动迁移或删除旧图谱，
以免把只按公共 workspace-key 建立的缓存错误归属到另一个物理 clone。按以下顺序恢复：

1. 停止仍在运行的旧版 `graph-service`，确认旧目录中的 `owner.lock` 不再由活动进程持有。
2. 在当前用户缓存根的 `codegraph/w/` 下找到旧 workspace-key 目录；Windows 缓存根默认为
   `%LOCALAPPDATA%`，macOS 为 `$HOME/Library/Caches`，Linux 为 `${XDG_CACHE_HOME:-$HOME/.cache}`。
3. 将整个旧目录移动到 `codegraph-backup/` 等独立备份位置，不要只移动 `graph.sqlite`，并同时保留
   WAL/SHM、metadata、token 与日志，避免留下可被误发现的半套状态。
4. 重新连接当前工作区后，显式调用公共 `job/start` rebuild API，并轮询 `service/status`，直到 Job
   进入 `succeeded` 再验证新图谱。空基线下该 rebuild 请求会按合同记录为 `initial-index`，连接本身
   不会自动启动索引。

旧缓存只用于人工诊断或后续迁移工具输入。确认新图谱可用前不要删除备份，也不要把旧目录复制到
新的 root-bound 缓存位置。

## IPC 与 Windows 风险边界

- Windows：`\\.\pipe\codegraph-<workspace-prefix>-<random-suffix>` Named Pipe。
- macOS/Linux：用户缓存内长度受控的 Unix Domain Socket，socket 权限 `0600`。
- 禁止 TCP、host/port API、TCP fallback 与全局 daemon。

Node/libuv 公共 API 无法承诺 current-SID-only Pipe DACL。V1 明确接受默认 Pipe DACL 的
剩余风险，并以当前用户缓存 ACL、随机 endpoint、独立 32-byte token、token-first
`timingSafeEqual` 握手、5 秒握手超时和单次失败即断开共同收敛风险。

认证前输入单帧上限为 1 MiB，且只允许一个待处理帧；超限或在 initialize
完成前排队第二帧会立即关闭连接。客户端响应读取同样执行 1 MiB 单帧与 8 KiB 帧头
上限，每个在途请求只允许消费一个服务端响应，并拒绝服务端主动 request/notification、
无请求响应与截断帧；伪造 endpoint 无法在兼容校验前诱导无界缓冲。握手开放后服务最多保留 64 条
活跃连接，超限 socket 立即关闭。启动器与 graph-service 之间使用不对 workspace
暴露的父子 IPC channel 发送跨平台取消，优雅清理超时后才允许强制终止。

## 握手与状态

`InitializeRequest` 必填：`clientVersion`、`protocolVersion`、
`supportedSchemaVersions`、`workspaceKey`、`sessionToken`。服务先读取并固定时序校验 token，
再校验封闭请求形状、workspace-key、协议主版本与三套 Schema 版本交集。成功的 `InitializeResult` 返回四套独立
版本、服务版本、capabilities 与权威 `ServiceStatusV1`。客户端还会核对 initialize 状态中
的 `serviceInstanceId`、`statusEpoch` 与发现 metadata 一致。

从未构建且没有持久 terminal Job 时，初始状态固定为：

| 字段 | 值 |
| --- | --- |
| `lifecycle` | `running` |
| `availability` | `absent` |
| `freshness` | `null` |
| `completeness` | `empty` |
| `committed` | `null` |
| `currentIndexJob` / `lastIndexJob` | `null` / `null` |
| telemetry | requested/effective=`off`，pending=`false` |
| revisions | 合法单调起始值 `1` |

重启恢复或 `job/start` 状态转换后，`committed` 可包含生成时间、文件/节点/边/排除计数，
`currentIndexJob` 与 `lastIndexJob` 返回最小 queued/running/succeeded/failed 状态。成功但无受支持
文件仍是 `availability=available`、`completeness=empty` 的真实提交。响应不包含
graphRevision、findingsRevision、绝对 indexing root、缓存路径或 SQLite rowid。

服务端请求、canonical 响应、metadata 与 `ErrorV1` 使用封闭 Schema。兼容客户端仍校验
全部已知必填字段，但忽略同一协议主版本新增的可选响应字段和未知 capability。
`job/start` 只接受封闭 rebuild 请求；`service/status` 与 `service/shutdown` 只接受封闭空参数对象；
shutdown canonical 响应固定为 `{"accepted":true}`。连接、启动、initialize、job/start、status
与 shutdown 均受本地 deadline 约束；
RPC shutdown 的每次资源清理也有硬界限，重试耗尽后强制终止进程。

## 稳定错误

| code | category | 基线处理 |
| --- | --- | --- |
| `GRAPH_IGNORE_CONFIG_UNSUPPORTED` | `configuration` | 移除 `.codegraphignore` 并重启，或升级到支持该配置的版本 |
| `GRAPH_SCAN_FAILED` | `indexing` | 检查工作区读取权限与安全限制后重试 |
| `GRAPH_SCAN_LIMIT_EXCEEDED` | `indexing` | 缩小 indexing root 或排除生成目录后重试 |
| `GRAPH_STORE_OPEN_FAILED` | `storage` | 检查缓存空间与权限，保留故障副本后重试 |
| `GRAPH_WRITE_FAILED` | `storage` | 检查磁盘空间、占用和权限后重试首次构建 |
| `INDEX_JOB_ALREADY_RUNNING` | `lifecycle` | 等待当前 Job 结束后再次请求 rebuild |
| `SERVICE_INITIALIZE_REQUIRED` | `protocol` | 关闭连接并重新 initialize |
| `SERVICE_INVALID_REQUEST` | `protocol` | 移除未知字段并按控制面 Schema 重试 |
| `SERVICE_AUTH_FAILED` | `security` | 重新发现后重试 |
| `SERVICE_WORKSPACE_MISMATCH` | `security` | 重新计算工作区身份 |
| `SERVICE_WORKSPACE_UNTRUSTED` | `security` | 宿主授予 Workspace Trust 后重试 |
| `SERVICE_PROTOCOL_INCOMPATIBLE` | `compatibility` | 升级或降级客户端 |
| `SERVICE_METHOD_NOT_FOUND` | `protocol` | 只调用已声明控制方法 |
| `SERVICE_INSTANCE_CONFLICT` | `lifecycle` | 有界等待现有实例，禁止第二 writer |
| `SERVICE_LEGACY_CACHE_MIGRATION_REQUIRED` | `lifecycle` | 按“旧版缓存恢复”步骤停止旧服务、整体移出旧目录并保留备份 |
| `SERVICE_ENDPOINT_START_FAILED` | `transport` | 检查用户缓存权限 |
| `SERVICE_START_TIMEOUT` | `lifecycle` | 重新发现或查看本地日志 |

所有 JSON-RPC `error.data` 都是同一 `ErrorV1`。稳定 code/category 不本地化；message、
logId 与 suggestedAction 可供诊断，但不得回显 token、完整绝对路径、原始堆栈或其他秘密。
validator 除字段形状外还校验 code 对应的 category、retryable 与 suggestedAction 注册表
不变量。graph-service 子进程在 metadata 发布前失败时，启动器只解析严格 ErrorV1，忽略
任意 stderr，并保留原始安全 code 与 logId。
