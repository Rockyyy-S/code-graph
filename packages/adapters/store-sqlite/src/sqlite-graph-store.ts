import { copyFileSync, existsSync } from "node:fs";
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
  applyBootstrapMigration,
  BOOTSTRAP_TABLE_NAMES,
} from "./migrations/001-bootstrap.js";

/** SQLite 锁竞争等待的固定上限。 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

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
    this.#closed = true;
    this.#database.close();
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
    const job = this.#database.prepare(`
      SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id
      FROM jobs
      WHERE workspace_key = ? AND state IN ('succeeded', 'failed')
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(this.#workspaceKey) as JobRow | undefined;
    return {
      committed: workspace?.committed_at === null || workspace === undefined
        ? null
        : mapWorkspaceSummary(workspace),
      lastJob: job === undefined ? null : mapJob(job),
    };
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

  /** 防止关闭后的 SQLite 句柄继续被调用。 */
  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("SQLite 图谱存储已经关闭。");
    }
  }
}

/** 打开、配置、迁移并回验 Story 1.4 SQLite 存储。 */
export function openSqliteGraphStore(options: OpenSqliteGraphStoreOptions): SqliteGraphStore {
  if (!path.isAbsolute(options.databasePath) || !/^[a-f0-9]{64}$/u.test(options.workspaceKey)) {
    throw new TypeError("SQLite 路径或 workspaceKey 不合法。");
  }
  const existedBeforeOpen = existsSync(options.databasePath);
  let database: Database.Database | null = null;
  try {
    database = new Database(options.databasePath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
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
    return new SqliteGraphStore(database, options.workspaceKey, options.faultInjector);
  } catch (error) {
    database?.close();
    preserveFailureCopy(options.databasePath, existedBeforeOpen);
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

/** migration/open 失败时保留原数据库或新建故障数据库的只读诊断副本。 */
function preserveFailureCopy(databasePath: string, existedBeforeOpen: boolean): void {
  if (!existsSync(databasePath)) {
    return;
  }
  const suffix = existedBeforeOpen ? "existing" : "new";
  const backupPath = `${databasePath}.failed-${suffix}-${Date.now()}.bak`;
  try {
    copyFileSync(databasePath, backupPath);
  } catch {
    /** 备份失败不能覆盖原始 SQLite 打开/迁移错误。 */
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
