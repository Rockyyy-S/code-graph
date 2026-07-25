import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  CommitHierarchyInput,
  GraphStoreBootstrapState,
  GraphStorePort,
  StoredIndexJob,
  StoredIndexSummary,
} from "@codegraph/application";
import {
  assertBootstrapSchemaSupported,
  applyBootstrapMigration,
  BOOTSTRAP_TABLE_NAMES,
} from "./migrations/001-bootstrap.js";

/** SQLite 锁竞争等待的固定上限。 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** 故障诊断副本最多保留三组，避免用户缓存无限增长。 */
export const MAX_SQLITE_FAILURE_BACKUP_SETS = 3;

/** 故障诊断副本总预算为 64 MiB；超限时保留原始打开错误而跳过复制。 */
export const MAX_SQLITE_FAILURE_BACKUP_BYTES = 64 * 1024 * 1024;

let failureBackupSequence = 0;

/** meta 表中用于把提交摘要强绑定到实际 succeeded Job 的私有键前缀。 */
const COMMITTED_JOB_META_KEY_PREFIX = "bootstrap-committed-job:";

/** Story 1.4 运行时允许持久化到 failed Job 的稳定错误码。 */
const PERSISTED_INDEX_JOB_ERROR_CODES = new Set([
  "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
  "GRAPH_SCAN_FAILED",
  "GRAPH_SCAN_LIMIT_EXCEEDED",
  "GRAPH_WRITE_FAILED",
]);

/** 首次事务故障注入上下文，仅用于真实回滚测试。 */
export interface SqliteGraphStoreFaultContext {
  entityIndex: number;
  stage: "edge" | "node";
}

/** SQLite 适配器构造参数。 */
export interface OpenSqliteGraphStoreOptions {
  databasePath: string;
  faultInjector?: (context: SqliteGraphStoreFaultContext) => void;
  workspaceKey: string;
}

/** 当前连接已回验的关键 PRAGMA。 */
export interface SqlitePragmaDiagnostics {
  busyTimeoutMs: number;
  foreignKeys: boolean;
  journalMode: "wal";
  synchronous: "normal";
}

/** better-sqlite3 实现的同步最小图谱存储。 */
export class SqliteGraphStore implements GraphStorePort {
  readonly #database: Database.Database;
  readonly #faultInjector: ((context: SqliteGraphStoreFaultContext) => void) | undefined;
  readonly #workspaceKey: string;
  #closed = false;

  public constructor(
    database: Database.Database,
    workspaceKey: string,
    faultInjector?: (context: SqliteGraphStoreFaultContext) => void,
  ) {
    this.#database = database;
    this.#workspaceKey = workspaceKey;
    this.#faultInjector = faultInjector;
  }

  /** 关闭 SQLite 与其 WAL/SHM 句柄；重复调用保持幂等。 */
  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#database.close();
    this.#closed = true;
  }

  /** 启动时把上次进程中断遗留的 queued/running Job 收敛为可查询失败终态。 */
  public reconcileInterruptedJobs(completedAt: string): void {
    this.#ensureOpen();
    if (!isCanonicalUtcTimestamp(completedAt)) {
      throw new TypeError("中断 Job 恢复时间必须是真实 UTC 时间。");
    }
    this.#database.transaction(() => {
      const rows = this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at,
               completed_at, error_code, error_log_id
        FROM jobs
        WHERE workspace_key = ? AND state IN ('queued', 'running')
        ORDER BY rowid
      `).all(this.#workspaceKey) as ActiveJobRow[];
      rows.forEach(validateStoredActiveJob);
      /** 旧 schema v1 缺少绑定键时，只在全部旧状态无歧义合法后回填。 */
      this.#backfillLegacyCommittedJobBinding();
      this.readBootstrapState();
      const update = this.#database.prepare(`
        UPDATE jobs
        SET state = 'failed', started_at = ?, completed_at = ?,
            error_code = 'GRAPH_SCAN_FAILED', error_log_id = ?
        WHERE id = ? AND workspace_key = ? AND state IN ('queued', 'running')
      `);
      const recoveries = rows.map((row) => {
        const startedAt = row.started_at ?? row.requested_at;
        return {
          completedAt: timestampAtOrAfter(completedAt, startedAt),
          errorCode: "GRAPH_SCAN_FAILED",
          errorLogId: randomUUID(),
          id: row.id,
          kind: row.kind,
          requestedAt: row.requested_at,
          startedAt,
          state: "failed",
        } as const satisfies StoredIndexJob;
      });
      for (const recovery of recoveries) {
        requireSingleChange(
          update.run(
            recovery.startedAt,
            recovery.completedAt,
            recovery.errorLogId,
            recovery.id,
            this.#workspaceKey,
          ).changes,
          "中断 Job 未能收敛。",
        );
      }
      const readRecovered = this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id
        FROM jobs
        WHERE id = ? AND workspace_key = ? AND state = 'failed'
      `);
      for (const recovery of recoveries) {
        const recovered = readRecovered.get(
          recovery.id,
          this.#workspaceKey,
        ) as JobRow | undefined;
        if (recovered === undefined) {
          throw new Error("中断 Job 未能收敛。");
        }
        const recoveredJob = mapJob(recovered);
        validateStoredTerminalJob(recoveredJob);
        if (!matchesRecoveredJob(recoveredJob, recovery)) {
          throw new Error("中断 Job 未能收敛。");
        }
      }
      const remainingActive = this.#database.prepare(`
        SELECT COUNT(*) AS count
        FROM jobs
        WHERE workspace_key = ? AND state IN ('queued', 'running')
      `).get(this.#workspaceKey) as { count: number };
      if (remainingActive.count !== 0) {
        throw new Error("中断 Job 未能收敛。");
      }
      /** 回验与更新共享事务；任何不变量失败都会回滚并保留原始损坏行。 */
      this.readBootstrapState();
    })();
  }

  /** 创建持久化 queued Job。 */
  public createJob(job: Pick<StoredIndexJob, "id" | "kind" | "requestedAt">): void {
    this.#ensureOpen();
    this.#database.prepare(`
      INSERT INTO jobs(id, workspace_key, kind, state, requested_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(job.id, this.#workspaceKey, job.kind, job.requestedAt);
  }

  /** 将指定 Job 推进到 running。 */
  public markJobRunning(jobId: string, startedAt: string): void {
    this.#ensureOpen();
    const result = this.#database.prepare(`
      UPDATE jobs
      SET state = 'running', started_at = ?
      WHERE id = ? AND workspace_key = ? AND state = 'queued'
    `).run(startedAt, jobId, this.#workspaceKey);
    requireSingleChange(result.changes, "Job 无法进入 running。");
  }

  /** 在独立小事务中记录 terminal failed，不提交任何 hierarchy 行。 */
  public markJobFailed(
    jobId: string,
    completedAt: string,
    errorCode: string,
    errorLogId: string,
  ): void {
    this.#ensureOpen();
    const result = this.#database.prepare(`
      UPDATE jobs
      SET state = 'failed', started_at = COALESCE(started_at, ?), completed_at = ?,
          error_code = ?, error_log_id = ?
      WHERE id = ? AND workspace_key = ? AND state IN ('queued', 'running')
    `).run(completedAt, completedAt, errorCode, errorLogId, jobId, this.#workspaceKey);
    requireSingleChange(result.changes, "Job 无法进入 failed。");
  }

  /**
   * 在一个同步事务中替换当前 hierarchy、更新提交摘要并完成 Job。
   *
   * 任一节点、边或 Job 更新失败时，better-sqlite3 会回滚整个回调。
   */
  public commitHierarchy(input: CommitHierarchyInput): void {
    this.#ensureOpen();
    validateCommitInput(input, this.#workspaceKey);
    this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM edges WHERE workspace_key = ?").run(this.#workspaceKey);
      this.#database.prepare("DELETE FROM nodes WHERE workspace_key = ?").run(this.#workspaceKey);
      const insertNode = this.#database.prepare(`
        INSERT INTO nodes(id, workspace_key, kind, relative_path)
        VALUES (?, ?, ?, ?)
      `);
      input.graph.nodes.forEach((node, entityIndex) => {
        this.#faultInjector?.({ entityIndex, stage: "node" });
        insertNode.run(node.id, this.#workspaceKey, node.kind, node.relativePath);
      });
      const insertEdge = this.#database.prepare(`
        INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      input.graph.edges.forEach((edge, entityIndex) => {
        this.#faultInjector?.({ entityIndex, stage: "edge" });
        insertEdge.run(
          edge.id,
          this.#workspaceKey,
          edge.fromId,
          edge.relationType,
          edge.toId,
          edge.qualifier,
        );
      });
      const workspaceResult = this.#database.prepare(`
        UPDATE workspace
        SET committed_at = ?, indexed_file_count = ?, node_count = ?, edge_count = ?,
            excluded_path_count = ?, builtin_rules_version = ?
        WHERE workspace_key = ?
      `).run(
        input.summary.generatedAt,
        input.summary.indexedFileCount,
        input.summary.nodeCount,
        input.summary.edgeCount,
        input.summary.excludedPathCount,
        input.summary.builtinRulesVersion,
        this.#workspaceKey,
      );
      requireSingleChange(workspaceResult.changes, "workspace 提交摘要更新失败。");
      const jobResult = this.#database.prepare(`
        UPDATE jobs
        SET state = 'succeeded', completed_at = ?, error_code = NULL, error_log_id = NULL
        WHERE id = ? AND workspace_key = ? AND state = 'running'
      `).run(input.completedAt, input.jobId, this.#workspaceKey);
      requireSingleChange(jobResult.changes, "Job 无法进入 succeeded。");
      this.#database.prepare(`
        INSERT INTO meta(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(committedJobMetaKey(this.#workspaceKey), input.jobId);
    })();
  }

  /** 读取服务重启时需要恢复的提交摘要与最后 terminal Job。 */
  public readBootstrapState(): GraphStoreBootstrapState {
    this.#ensureOpen();
    const workspace = this.#database.prepare(`
      SELECT committed_at, indexed_file_count, node_count, edge_count,
             excluded_path_count, builtin_rules_version
      FROM workspace
      WHERE workspace_key = ?
    `).get(this.#workspaceKey) as WorkspaceRow | undefined;
    const terminalJobs = readStoredTerminalJobs(this.#database, this.#workspaceKey);
    const lastJob = terminalJobs.at(-1) ?? null;
    const latestSucceededJob = terminalJobs.findLast((job) => job.state === "succeeded") ?? null;
    const committedJobMeta = this.#database.prepare(`
      SELECT value
      FROM meta
      WHERE key = ?
    `).get(committedJobMetaKey(this.#workspaceKey)) as { value: string } | undefined;
    const committedJob = committedJobMeta === undefined
      ? undefined
      : this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id
        FROM jobs
        WHERE workspace_key = ? AND id = ? AND state = 'succeeded'
      `).get(this.#workspaceKey, committedJobMeta.value) as JobRow | undefined;
    const state = {
      committed: workspace?.committed_at === null || workspace === undefined
        ? null
        : mapWorkspaceSummary(workspace),
      lastJob,
    };
    validateBootstrapState(
      state,
      readPersistedGraphCounts(this.#database, this.#workspaceKey),
      committedJob === undefined ? null : mapJob(committedJob),
      committedJobMeta?.value ?? null,
      latestSucceededJob,
    );
    return state;
  }

  /** 测试与启动诊断使用的精确用户表名列表。 */
  public listUserTables(): readonly string[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[];
    return rows.map((row) => row.name);
  }

  /** 回验实际连接上的 WAL、外键、NORMAL 与 busy timeout。 */
  public inspectPragmas(): SqlitePragmaDiagnostics {
    this.#ensureOpen();
    return readAndValidatePragmas(this.#database);
  }

  /** 测试事务失败后确认没有半写节点或边。 */
  public readGraphCounts(): { edgeCount: number; nodeCount: number } {
    this.#ensureOpen();
    const node = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM nodes WHERE workspace_key = ?",
    ).get(this.#workspaceKey) as { count: number };
    const edge = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM edges WHERE workspace_key = ?",
    ).get(this.#workspaceKey) as { count: number };
    return { edgeCount: edge.count, nodeCount: node.count };
  }

  /** 测试持久化边界时读取相对 POSIX 路径，绝不返回数据库主键或绝对 root。 */
  public listNodePaths(): readonly string[] {
    this.#ensureOpen();
    const rows = this.#database.prepare(`
      SELECT relative_path
      FROM nodes
      WHERE workspace_key = ?
      ORDER BY relative_path
    `).all(this.#workspaceKey) as { relative_path: string }[];
    return rows.map((row) => row.relative_path);
  }

  /** 为修复前已提交的合法 schema v1 数据回填私有 committed Job 绑定。 */
  #backfillLegacyCommittedJobBinding(): void {
    const metaKey = committedJobMetaKey(this.#workspaceKey);
    const existingBinding = this.#database.prepare(`
      SELECT value FROM meta WHERE key = ?
    `).get(metaKey) as { value: string } | undefined;
    if (existingBinding !== undefined) {
      return;
    }
    const workspace = this.#database.prepare(`
      SELECT committed_at, indexed_file_count, node_count, edge_count,
             excluded_path_count, builtin_rules_version
      FROM workspace
      WHERE workspace_key = ?
    `).get(this.#workspaceKey) as WorkspaceRow | undefined;
    if (workspace === undefined || workspace.committed_at === null) {
      return;
    }
    const terminalJobs = readStoredTerminalJobs(this.#database, this.#workspaceKey);
    const latestSucceededJob = terminalJobs.findLast((job) => job.state === "succeeded") ?? null;
    const bindingCandidates = terminalJobs.filter(
      (job) => job.state === "succeeded" && job.completedAt === workspace.committed_at,
    );
    if (
      latestSucceededJob === null ||
      bindingCandidates.length !== 1 ||
      bindingCandidates[0]?.id !== latestSucceededJob.id
    ) {
      throw new Error("旧版持久提交的 succeeded Job 绑定无法唯一恢复。");
    }
    const state = {
      committed: mapWorkspaceSummary(workspace),
      lastJob: terminalJobs.at(-1) ?? null,
    };
    validateBootstrapState(
      state,
      readPersistedGraphCounts(this.#database, this.#workspaceKey),
      latestSucceededJob,
      latestSucceededJob.id,
      latestSucceededJob,
    );
    this.#database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
    `).run(metaKey, latestSucceededJob.id);
  }

  /** 防止关闭后的 SQLite 句柄继续被调用。 */
  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("SQLite 图谱存储已经关闭。");
    }
  }
}

/** 打开、配置、迁移并回验 Story 1.4 SQLite 存储。 */
export async function openSqliteGraphStore(
  options: OpenSqliteGraphStoreOptions,
): Promise<SqliteGraphStore> {
  if (!path.isAbsolute(options.databasePath) || !/^[a-f0-9]{64}$/u.test(options.workspaceKey)) {
    throw new TypeError("SQLite 路径或 workspaceKey 不合法。");
  }
  const existedBeforeOpen = existsSync(options.databasePath);
  let database: Database.Database | null = null;
  try {
    database = new Database(options.databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
    /** 未知未来 Schema 必须在 WAL 等持久设置前只读拒绝。 */
    assertBootstrapSchemaSupported(database);
    configurePragmas(database);
    applyBootstrapMigration(database);
    database.prepare(`
      INSERT INTO workspace(workspace_key)
      VALUES (?)
      ON CONFLICT(workspace_key) DO NOTHING
    `).run(options.workspaceKey);
    readAndValidatePragmas(database);
    if (JSON.stringify(readTableNames(database)) !== JSON.stringify(BOOTSTRAP_TABLE_NAMES)) {
      throw new Error("SQLite migration 未保持精确八表。");
    }
    const store = new SqliteGraphStore(database, options.workspaceKey, options.faultInjector);
    /** 在单一事务内校验旧状态、兼容回填绑定并收敛上次中断 Job。 */
    store.reconcileInterruptedJobs(new Date().toISOString());
    return store;
  } catch (error) {
    try {
      database?.close();
    } catch {
      /** close 失败不能覆盖更早的打开或迁移根因，WAL/SHM 仍由备份组保留。 */
    }
    await preserveFailureCopy(options.databasePath, existedBeforeOpen);
    throw error;
  }
}

/** 在无活动事务时设置所有必需 PRAGMA。 */
function configurePragmas(database: Database.Database): void {
  const journal = database.pragma("journal_mode = WAL", { simple: true });
  if (String(journal).toLowerCase() !== "wal") {
    throw new Error("SQLite 无法启用 WAL。");
  }
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = NORMAL");
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}

/** 从真实连接读取并断言 PRAGMA 已生效。 */
function readAndValidatePragmas(database: Database.Database): SqlitePragmaDiagnostics {
  const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  const foreignKeys = Number(database.pragma("foreign_keys", { simple: true }));
  const synchronous = Number(database.pragma("synchronous", { simple: true }));
  const busyTimeoutMs = Number(database.pragma("busy_timeout", { simple: true }));
  if (
    journalMode !== "wal" ||
    foreignKeys !== 1 ||
    synchronous !== 1 ||
    busyTimeoutMs !== SQLITE_BUSY_TIMEOUT_MS
  ) {
    throw new Error("SQLite 关键 PRAGMA 未按合同生效。");
  }
  return {
    busyTimeoutMs,
    foreignKeys: true,
    journalMode: "wal",
    synchronous: "normal",
  };
}

/** 返回精确排序后的用户表名。 */
function readTableNames(database: Database.Database): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as { name: string }[]).map((row) => row.name);
}

/** migration/open 失败时异步保留主文件与 WAL/SHM，并执行数量和总大小治理。 */
async function preserveFailureCopy(
  databasePath: string,
  existedBeforeOpen: boolean,
): Promise<void> {
  const sources = [
    { path: databasePath, suffix: "" },
    { path: `${databasePath}-wal`, suffix: "-wal" },
    { path: `${databasePath}-shm`, suffix: "-shm" },
  ];
  try {
    const existingSources = [];
    let sourceBytes = 0;
    for (const source of sources) {
      try {
        const sourceStat = await stat(source.path);
        if (!sourceStat.isFile()) {
          continue;
        }
        sourceBytes += sourceStat.size;
        existingSources.push(source);
      } catch {
        /** WAL/SHM 可能在连接关闭后已被 checkpoint 清理，缺失 sidecar 不算备份失败。 */
      }
    }
    if (
      existingSources.length === 0 ||
      sourceBytes > MAX_SQLITE_FAILURE_BACKUP_BYTES
    ) {
      return;
    }

    const kind = existedBeforeOpen ? "existing" : "new";
    const backupId = `${Date.now()}-${failureBackupSequence++}`;
    const backupBase = `${databasePath}.failed-${kind}-${backupId}.bak`;
    const copiedPaths: string[] = [];
    try {
      for (const source of existingSources) {
        const target = `${backupBase}${source.suffix}`;
        await copyFile(source.path, target);
        copiedPaths.push(target);
      }
      await pruneFailureBackups(databasePath);
    } catch {
      await Promise.all(copiedPaths.map((target) => rm(target, { force: true })));
    }
  } catch {
    /** 备份失败不能覆盖原始 SQLite 打开/迁移错误。 */
  }
}

/** 按备份组淘汰最旧副本，WAL/SHM 与对应主文件始终一起删除。 */
async function pruneFailureBackups(databasePath: string): Promise<void> {
  const directory = path.dirname(databasePath);
  const basename = path.basename(databasePath);
  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^${escapedBasename}\\.failed-(existing|new)-(\\d+)(?:-(\\d+))?\\.bak(?:-(?:wal|shm))?$`,
    "u",
  );
  const groups = new Map<string, { bytes: number; paths: string[]; sequence: number; timestamp: number }>();
  for (const entry of await readdir(directory)) {
    const match = pattern.exec(entry);
    if (match === null) {
      continue;
    }
    const kind = match[1];
    const timestamp = Number(match[2]);
    /** 修复前的 legacy 备份没有 sequence；使用 -1 保证同时间戳下优先淘汰旧格式。 */
    const sequence = match[3] === undefined ? -1 : Number(match[3]);
    const key = `${kind}-${timestamp}-${sequence}`;
    const entryPath = path.join(directory, entry);
    const entryStat = await stat(entryPath);
    const group = groups.get(key) ?? { bytes: 0, paths: [], sequence, timestamp };
    group.bytes += entryStat.size;
    group.paths.push(entryPath);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort(
    (left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence,
  );
  let totalBytes = ordered.reduce((total, group) => total + group.bytes, 0);
  while (
    ordered.length > MAX_SQLITE_FAILURE_BACKUP_SETS ||
    totalBytes > MAX_SQLITE_FAILURE_BACKUP_BYTES
  ) {
    const oldest = ordered.shift();
    if (oldest === undefined) {
      return;
    }
    await Promise.all(oldest.paths.map((target) => rm(target, { force: true })));
    totalBytes -= oldest.bytes;
  }
}

/** 校验业务摘要与 hierarchy 实际计数精确一致。 */
function validateCommitInput(input: CommitHierarchyInput, workspaceKey: string): void {
  const fileCount = input.graph.nodes.filter((node) => node.kind === "file").length;
  if (
    input.graph.workspaceKey !== workspaceKey ||
    input.summary.indexedFileCount !== fileCount ||
    input.summary.nodeCount !== input.graph.nodes.length ||
    input.summary.edgeCount !== input.graph.edges.length ||
    input.completedAt !== input.summary.generatedAt
  ) {
    throw new TypeError("hierarchy 提交摘要与实际事实不一致。");
  }
}

/** SQLite UPDATE 必须精确命中一个预期状态行。 */
function requireSingleChange(changes: number, message: string): void {
  if (changes !== 1) {
    throw new Error(message);
  }
}

interface WorkspaceRow {
  builtin_rules_version: string | null;
  committed_at: string | null;
  edge_count: number | null;
  excluded_path_count: number | null;
  indexed_file_count: number | null;
  node_count: number | null;
}

interface JobRow {
  completed_at: string | null;
  error_code: string | null;
  error_log_id: string | null;
  id: string;
  kind: "initial-index" | "rebuild";
  requested_at: string;
  started_at: string | null;
  state: "failed" | "succeeded";
}

interface ActiveJobRow {
  completed_at: string | null;
  error_code: string | null;
  error_log_id: string | null;
  id: string;
  kind: "initial-index" | "rebuild";
  requested_at: string;
  started_at: string | null;
  state: "queued" | "running";
}

interface PersistedGraphCounts {
  edgeCount: number;
  fileCount: number;
  nodeCount: number;
}

/** 按持久插入顺序读取并完整校验当前 workspace 的全部 terminal Job。 */
function readStoredTerminalJobs(
  database: Database.Database,
  workspaceKey: string,
): StoredIndexJob[] {
  const rows = database.prepare(`
    SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id
    FROM jobs
    WHERE workspace_key = ? AND state IN ('succeeded', 'failed')
    ORDER BY rowid
  `).all(workspaceKey) as JobRow[];
  const jobs = rows.map(mapJob);
  jobs.forEach(validateStoredTerminalJob);
  return jobs;
}

/** 读取 hierarchy 的实际节点、文件和边计数，供启动屏障与摘要交叉校验。 */
function readPersistedGraphCounts(
  database: Database.Database,
  workspaceKey: string,
): PersistedGraphCounts {
  const nodes = database.prepare(`
    SELECT COUNT(*) AS node_count,
           COALESCE(SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END), 0) AS file_count
    FROM nodes
    WHERE workspace_key = ?
  `).get(workspaceKey) as { file_count: number; node_count: number };
  const edges = database.prepare(`
    SELECT COUNT(*) AS edge_count
    FROM edges
    WHERE workspace_key = ?
  `).get(workspaceKey) as { edge_count: number };
  return {
    edgeCount: edges.edge_count,
    fileCount: nodes.file_count,
    nodeCount: nodes.node_count,
  };
}

/** 拒绝持久摘要、实际 hierarchy 与 terminal Job 之间的任何不一致。 */
function validateBootstrapState(
  state: GraphStoreBootstrapState,
  counts: PersistedGraphCounts,
  committedJob: StoredIndexJob | null,
  committedJobId: string | null,
  latestSucceededJob: StoredIndexJob | null,
): void {
  const summary = state.committed;
  if (summary === null) {
    if (counts.nodeCount !== 0 || counts.edgeCount !== 0 || counts.fileCount !== 0) {
      throw new Error("无提交基线时不允许残留 hierarchy 行。");
    }
    if (committedJobId !== null || latestSucceededJob !== null) {
      throw new Error("成功 Job 缺少对应的持久提交摘要。");
    }
  } else {
    if (
      !isNonNegativeSafeInteger(summary.indexedFileCount) ||
      !isNonNegativeSafeInteger(summary.nodeCount) ||
      !isNonNegativeSafeInteger(summary.edgeCount) ||
      !isNonNegativeSafeInteger(summary.excludedPathCount) ||
      summary.nodeCount < summary.indexedFileCount + 1 ||
      summary.edgeCount !== summary.nodeCount - 1 ||
      summary.nodeCount !== counts.nodeCount ||
      summary.edgeCount !== counts.edgeCount ||
      summary.indexedFileCount !== counts.fileCount ||
      !isCanonicalUtcTimestamp(summary.generatedAt)
    ) {
      throw new Error("持久化 workspace 摘要与实际 hierarchy 不一致。");
    }
    if (committedJobId === null || committedJobId.length === 0 || committedJob === null) {
      throw new Error("持久提交缺少对应的 succeeded Job。");
    }
    if (
      committedJob.id !== committedJobId ||
      committedJob.completedAt !== summary.generatedAt ||
      latestSucceededJob?.id !== committedJobId
    ) {
      throw new Error("成功 Job 与持久提交时间不一致。");
    }
  }
}

/** terminal Job 必须具备单调、真实的 UTC 时间及与状态一致的错误字段。 */
function validateStoredTerminalJob(job: StoredIndexJob): void {
  if (
    job.id.length === 0 ||
    !isIndexJobKind(job.kind) ||
    job.startedAt === undefined ||
    job.completedAt === undefined ||
    !isCanonicalUtcTimestamp(job.requestedAt) ||
    !isCanonicalUtcTimestamp(job.startedAt) ||
    !isCanonicalUtcTimestamp(job.completedAt) ||
    Date.parse(job.requestedAt) > Date.parse(job.startedAt) ||
    Date.parse(job.startedAt) > Date.parse(job.completedAt) ||
    (job.state === "failed" &&
      (job.errorCode === undefined ||
        job.errorCode.length === 0 ||
        !PERSISTED_INDEX_JOB_ERROR_CODES.has(job.errorCode) ||
        job.errorLogId === undefined ||
        job.errorLogId.length === 0)) ||
    (job.state === "succeeded" &&
      (job.errorCode !== undefined || job.errorLogId !== undefined))
  ) {
    throw new Error("持久化 terminal Job 合同不完整或时间不单调。");
  }
}

/** 恢复后的 failed Job 必须逐字段等于本事务计算出的唯一预期终态。 */
function matchesRecoveredJob(actual: StoredIndexJob, expected: StoredIndexJob): boolean {
  return actual.id === expected.id &&
    actual.kind === expected.kind &&
    actual.state === expected.state &&
    actual.requestedAt === expected.requestedAt &&
    actual.startedAt === expected.startedAt &&
    actual.completedAt === expected.completedAt &&
    actual.errorCode === expected.errorCode &&
    actual.errorLogId === expected.errorLogId;
}

/** queued/running Job 必须在恢复写入前满足可安全收敛的持久化合同。 */
function validateStoredActiveJob(job: ActiveJobRow): void {
  const hasValidBase =
    job.id.length > 0 &&
    isIndexJobKind(job.kind) &&
    isCanonicalUtcTimestamp(job.requested_at) &&
    job.completed_at === null &&
    job.error_code === null &&
    job.error_log_id === null;
  const hasValidStage = job.state === "queued"
    ? job.started_at === null
    : job.started_at !== null &&
      isCanonicalUtcTimestamp(job.started_at) &&
      Date.parse(job.requested_at) <= Date.parse(job.started_at);
  if (!hasValidBase || !hasValidStage) {
    throw new Error("持久化活动 Job 合同不完整或时间不单调。");
  }
}

/** 当前切片只持久化 initial-index 与 rebuild 两种 Job。 */
function isIndexJobKind(value: string): value is StoredIndexJob["kind"] {
  return value === "initial-index" || value === "rebuild";
}

/** 为每个 workspace 生成不暴露到公共合同的提交 Job 绑定键。 */
function committedJobMetaKey(workspaceKey: string): string {
  return `${COMMITTED_JOB_META_KEY_PREFIX}${workspaceKey}`;
}

/** 系统时钟回拨时不让恢复完成时间早于已持久化的 Job 阶段。 */
function timestampAtOrAfter(candidate: string, floor: string): string {
  const candidateTime = Date.parse(candidate);
  const floorTime = Date.parse(floor);
  if (Number.isFinite(candidateTime) && Number.isFinite(floorTime) && candidateTime < floorTime) {
    return floor;
  }
  return candidate;
}

/** SQLite 数值摘要只接受非负安全整数。 */
function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 接受秒或毫秒精度的真实 UTC 时间，拒绝日期溢出。 */
function isCanonicalUtcTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{3})?Z$/u.exec(value);
  if (match === null) {
    return false;
  }
  const canonical = match[2] === undefined ? `${match[1]}.000Z` : value;
  const parsed = new Date(canonical);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === canonical;
}

/** 将非空 workspace 行映射为 application 摘要。 */
function mapWorkspaceSummary(row: WorkspaceRow): StoredIndexSummary {
  if (
    row.committed_at === null ||
    row.builtin_rules_version !== "builtin-ignore-v1" ||
    row.edge_count === null ||
    row.excluded_path_count === null ||
    row.indexed_file_count === null ||
    row.node_count === null
  ) {
    throw new Error("持久化 workspace 摘要不完整。");
  }
  return {
    builtinRulesVersion: "builtin-ignore-v1",
    edgeCount: row.edge_count,
    excludedPathCount: row.excluded_path_count,
    generatedAt: row.committed_at,
    indexedFileCount: row.indexed_file_count,
    nodeCount: row.node_count,
  };
}

/** 将 SQLite Job 行映射为不暴露 rowid 的 application 记录。 */
function mapJob(row: JobRow): StoredIndexJob {
  return {
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_log_id === null ? {} : { errorLogId: row.error_log_id }),
    id: row.id,
    kind: row.kind,
    requestedAt: row.requested_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    state: row.state,
  };
}
