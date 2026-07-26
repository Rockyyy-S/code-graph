import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  buildHierarchyGraph,
  compareCanonicalGraphText,
  HIERARCHY_PRODUCER_KIND,
  HIERARCHY_PRODUCER_VERSION,
  type AtomicGraphCommitResult,
  type AtomicGraphUpdate,
  type CanonicalDigestPort,
  type CreateStoredIndexJobInput,
  type GraphStoreBootstrapState,
  type GraphStorePort,
  type StoredIndexJob,
  type StoredIndexSummary,
} from "@codegraph/application";
import {
  buildGraphEntityId,
  type CommittedGraphSnapshotV1,
  type CommittedReadSetV1,
  type GraphPatchV1,
  type HierarchyEdge,
  type HierarchyNode,
  type HierarchyReadSetV1,
} from "@codegraph/domain";
import {
  assertDeterministicSchemaSupported,
  applyDeterministicCommitMigration,
  DETERMINISTIC_COMMIT_TABLE_NAMES,
} from "./migrations/002-deterministic-commit.js";

/** SQLite 锁竞争等待的固定上限。 */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** 故障诊断副本最多保留三组，避免用户缓存无限增长。 */
export const MAX_SQLITE_FAILURE_BACKUP_SETS = 3;

/** 故障诊断副本总预算为 64 MiB；超限时保留原始打开错误而跳过复制。 */
export const MAX_SQLITE_FAILURE_BACKUP_BYTES = 64 * 1024 * 1024;

/** 公开状态只消费 last/current Job；终态总计最多 16 条，并为当前 committed Job 永久预留一槽。 */
const MAX_RETAINED_TERMINAL_JOBS = 16;

let failureBackupSequence = 0;

/** meta 表中用于把提交摘要强绑定到实际 succeeded Job 的私有键前缀。 */
const COMMITTED_JOB_META_KEY_PREFIX = "bootstrap-committed-job:";

/** 完整 CAS read-set 的规范摘要与私有 JSON 分列保存，重启时必须交叉匹配。 */
const COMMITTED_READ_SET_DIGEST_META_KEY_PREFIX = "bootstrap-committed-read-set-digest:";

/** Story 1.4 运行时允许持久化到 failed Job 的稳定错误码。 */
const PERSISTED_INDEX_JOB_ERROR_CODES = new Set([
  "GRAPH_INPUT_CHANGED_DURING_BUILD",
  "GRAPH_IGNORE_CONFIG_UNSUPPORTED",
  "GRAPH_SCAN_FAILED",
  "GRAPH_SCAN_LIMIT_EXCEEDED",
  "GRAPH_WRITE_FAILED",
]);

/** 首次事务故障注入上下文，仅用于真实回滚测试。 */
export interface SqliteGraphStoreFaultContext {
  entityIndex: number;
  stage: "edge" | "job" | "metadata" | "node" | "ownership";
}

/** SQLite 适配器构造参数。 */
export interface OpenSqliteGraphStoreOptions {
  databasePath: string;
  digestPort: CanonicalDigestPort;
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

/** mutation 已执行但后置 read-set 复核失败时，用内部异常强制回滚事务。 */
class FinalReadSetStaleError extends Error {
  public constructor() {
    super("最终 read-set 在原子 mutation 后失效。");
    this.name = "FinalReadSetStaleError";
  }
}

/** better-sqlite3 实现的同步最小图谱存储。 */
export class SqliteGraphStore implements GraphStorePort {
  readonly #database: Database.Database;
  readonly #digestPort: CanonicalDigestPort | undefined;
  readonly #faultInjector: ((context: SqliteGraphStoreFaultContext) => void) | undefined;
  readonly #workspaceKey: string;
  #closed = false;

  public constructor(
    database: Database.Database,
    workspaceKey: string,
    faultInjector?: (context: SqliteGraphStoreFaultContext) => void,
    digestPort?: CanonicalDigestPort,
  ) {
    this.#database = database;
    this.#workspaceKey = workspaceKey;
    this.#faultInjector = faultInjector;
    this.#digestPort = digestPort;
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
      const totalChangesBefore = this.#readTotalChanges();
      let expectedChanges = 0;
      const rows = this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at,
               completed_at, error_code, error_log_id,
               base_graph_revision, result_graph_revision, legacy_schema_version
        FROM jobs
        WHERE workspace_key = ? AND state IN ('queued', 'running')
        ORDER BY rowid
      `).all(this.#workspaceKey) as ActiveJobRow[];
      rows.forEach(validateStoredActiveJob);
      /** 先绑定真实 committed Job，才能在不误删当前提交证据的前提下裁剪旧历史。 */
      expectedChanges += this.#backfillLegacyCommittedJobBinding();
      expectedChanges += this.#pruneTerminalJobHistory();
      validateStoredJobHistory(
        this.#database,
        this.#digestPort,
        this.#workspaceKey,
        this.#readWorkspaceRow().graph_revision,
      );
      this.readBootstrapState();
      let expectedWorkspaceAfterRecovery = this.#readWorkspaceRow();
      if (rows.length > 0) {
        // 中断发生时无法证明工作区输入未变化，活动 Job 与 stale workspace 必须同事务收敛。
        this.#markWorkspaceStale();
        expectedChanges += 1;
        expectedWorkspaceAfterRecovery = {
          ...expectedWorkspaceAfterRecovery,
          freshness: expectedWorkspaceAfterRecovery.committed_at === null ? null : "stale",
        };
      }
      const update = this.#database.prepare(`
        UPDATE jobs
        SET state = 'failed', started_at = ?, completed_at = ?,
            error_code = 'GRAPH_SCAN_FAILED', error_log_id = ?,
            result_graph_revision = base_graph_revision
        WHERE id = ? AND workspace_key = ? AND state IN ('queued', 'running')
      `);
      const recoveries = rows.map((row) => {
        const startedAt = row.started_at ?? row.requested_at;
        return {
          completedAt: timestampAtOrAfter(completedAt, startedAt),
          errorCode: "GRAPH_SCAN_FAILED",
          errorLogId: randomUUID(),
          baseGraphRevision: row.base_graph_revision,
          id: row.id,
          kind: row.kind,
          requestedAt: row.requested_at,
          resultGraphRevision: row.base_graph_revision,
          startedAt,
          state: "failed",
        } as const satisfies StoredIndexJob;
      });
      for (const recovery of recoveries) {
        const result = update.run(
          recovery.startedAt,
          recovery.completedAt,
          recovery.errorLogId,
          recovery.id,
          this.#workspaceKey,
        );
        requireSingleChange(result.changes, "中断 Job 未能收敛。");
        expectedChanges += result.changes;
      }
      const readRecovered = this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
               base_graph_revision, result_graph_revision, legacy_schema_version
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
        try {
          validateStoredTerminalJob(recoveredJob);
        } catch {
          throw new Error("中断 Job 未能收敛。");
        }
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
      expectedChanges += this.#pruneTerminalJobHistory();
      this.#assertWorkspaceEquals(
        expectedWorkspaceAfterRecovery,
        "中断 Job 恢复后的 workspace 状态不一致。",
      );
      this.#assertOnlyExpectedChanges(
        totalChangesBefore,
        expectedChanges,
        "中断 Job 恢复触发了旁路表变更。",
      );
      /** 回验与更新共享事务；任何不变量失败都会回滚并保留原始损坏行。 */
      this.readBootstrapState();
    }).immediate();
  }

  /** 创建持久化 queued Job。 */
  public createJob(job: CreateStoredIndexJobInput): void {
    this.#ensureOpen();
    this.#database.transaction(() => {
      const totalChangesBefore = this.#readTotalChanges();
      const result = this.#database.prepare(`
        INSERT INTO jobs(id, workspace_key, kind, state, requested_at, base_graph_revision)
        VALUES (?, ?, ?, 'queued', ?, ?)
      `).run(job.id, this.#workspaceKey, job.kind, job.requestedAt, job.baseGraphRevision);
      requireSingleChange(result.changes, "queued Job 未能持久化。");
      const inserted = this.#database.prepare(`
        SELECT rowid, id, kind, state, requested_at, started_at, completed_at,
               error_code, error_log_id, base_graph_revision, result_graph_revision,
               read_set_json, patch_digest, legacy_schema_version
        FROM jobs
        WHERE id = ? AND workspace_key = ?
      `).get(job.id, this.#workspaceKey) as JobEvidenceRow | undefined;
      if (
        inserted === undefined ||
        inserted.kind !== job.kind ||
        inserted.state !== "queued" ||
        inserted.requested_at !== job.requestedAt ||
        inserted.started_at !== null ||
        inserted.completed_at !== null ||
        inserted.error_code !== null ||
        inserted.error_log_id !== null ||
        inserted.base_graph_revision !== job.baseGraphRevision ||
        inserted.result_graph_revision !== null ||
        inserted.read_set_json !== null ||
        inserted.patch_digest !== null ||
        inserted.legacy_schema_version !== null
      ) {
        throw new Error("queued Job 后置状态不一致。");
      }
      validateStoredActiveJob(inserted);
      this.#assertOnlyExpectedChanges(
        totalChangesBefore,
        1,
        "queued Job 写入触发了旁路表变更。",
      );
    }).immediate();
  }

  /** 将指定 Job 推进到 running。 */
  public markJobRunning(jobId: string, startedAt: string): void {
    this.#ensureOpen();
    this.#database.transaction(() => {
      const totalChangesBefore = this.#readTotalChanges();
      const target = this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at, completed_at,
               error_code, error_log_id, base_graph_revision, result_graph_revision,
               read_set_json, patch_digest, legacy_schema_version
        FROM jobs
        WHERE id = ? AND workspace_key = ? AND state = 'queued'
      `).get(jobId, this.#workspaceKey) as ActiveJobEvidenceRow | undefined;
      if (target === undefined) {
        throw new Error("Job 无法进入 running。");
      }
      validateStoredActiveJob(target);
      const result = this.#database.prepare(`
        UPDATE jobs
        SET state = 'running', started_at = ?
        WHERE id = ? AND workspace_key = ? AND state = 'queued'
      `).run(startedAt, jobId, this.#workspaceKey);
      requireSingleChange(result.changes, "Job 无法进入 running。");
      const persisted = this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at, completed_at,
               error_code, error_log_id, base_graph_revision, result_graph_revision,
               read_set_json, patch_digest, legacy_schema_version
        FROM jobs
        WHERE id = ? AND workspace_key = ?
      `).get(jobId, this.#workspaceKey) as ActiveJobEvidenceRow | undefined;
      if (
        persisted === undefined ||
        persisted.state !== "running" ||
        persisted.started_at !== startedAt ||
        persisted.requested_at !== target.requested_at ||
        persisted.kind !== target.kind ||
        persisted.base_graph_revision !== target.base_graph_revision
      ) {
        throw new Error("running Job 后置状态不一致。");
      }
      validateStoredActiveJob(persisted);
      this.#assertOnlyExpectedChanges(
        totalChangesBefore,
        1,
        "running Job 写入触发了旁路表变更。",
      );
    }).immediate();
  }

  /** 在独立小事务中记录 terminal failed，不提交任何 hierarchy 行。 */
  public markJobFailed(
    jobId: string,
    completedAt: string,
    errorCode: string,
    errorLogId: string,
  ): void {
    this.#ensureOpen();
    this.#database.transaction(() => {
      this.#markUncommittedTerminal(jobId, "failed", completedAt, errorCode, errorLogId);
    }).immediate();
  }

  /** 扫描失败已破坏 current 证明时，把 failed Job 与 stale workspace 在同一事务落盘。 */
  public markJobFailedAndWorkspaceStale(
    jobId: string,
    completedAt: string,
    errorCode: string,
    errorLogId: string,
  ): void {
    this.#ensureOpen();
    this.#database.transaction(() => {
      this.#markUncommittedTerminal(jobId, "failed", completedAt, errorCode, errorLogId);
      this.#markWorkspaceStale();
    }).immediate();
  }

  /** 在独立小事务中记录 terminal cancelled，不修改已提交图谱。 */
  public markJobCancelled(jobId: string, completedAt: string): void {
    this.#ensureOpen();
    this.#database.transaction(() => {
      this.#markUncommittedTerminal(jobId, "cancelled", completedAt);
    }).immediate();
  }

  /** 已观察 stale 后的取消必须与 workspace stale 在同一事务持久化。 */
  public markJobCancelledAndWorkspaceStale(jobId: string, completedAt: string): void {
    this.#ensureOpen();
    this.#database.transaction(() => {
      this.#markUncommittedTerminal(jobId, "cancelled", completedAt);
      this.#markWorkspaceStale();
    }).immediate();
  }

  /** 在独立小事务中记录 terminal partial，不覆盖完整 ownership slice。 */
  public markJobPartial(jobId: string, completedAt: string): void {
    this.#database.transaction(() => {
      this.#markUncommittedTerminal(jobId, "partial", completedAt);
      const totalChangesBefore = this.#readTotalChanges();
      const beforeWorkspace = this.#readWorkspaceRow();
      const workspaceResult = this.#database.prepare(`
        UPDATE workspace
        SET completeness = 'partial',
            freshness = CASE WHEN committed_at IS NULL THEN NULL ELSE 'stale' END
        WHERE workspace_key = ?
      `).run(this.#workspaceKey);
      requireSingleChange(workspaceResult.changes, "partial Job 未能持久化 workspace 状态。");
      this.#assertWorkspaceEquals({
        ...beforeWorkspace,
        completeness: "partial",
        freshness: beforeWorkspace.committed_at === null ? null : "stale",
      }, "partial Job 的 workspace 后置状态不一致。");
      this.#assertOnlyExpectedChanges(
        totalChangesBefore,
        1,
        "partial workspace 更新触发了旁路表变更。",
      );
    }).immediate();
  }

  /** 已观察到输入差异时持久化 stale，重启不得恢复为虚假 current。 */
  public markWorkspaceStale(): void {
    this.#ensureOpen();
    this.#database.transaction(() => this.#markWorkspaceStale()).immediate();
  }

  /** 事务内将 workspace 收敛为 stale，并拒绝触发器静默忽略更新。 */
  #markWorkspaceStale(): void {
    const totalChangesBefore = this.#readTotalChanges();
    const beforeWorkspace = this.#readWorkspaceRow();
    const result = this.#database.prepare(`
      UPDATE workspace
      SET freshness = CASE WHEN committed_at IS NULL THEN NULL ELSE 'stale' END
      WHERE workspace_key = ?
    `).run(this.#workspaceKey);
    requireSingleChange(result.changes, "workspace stale 状态未能持久化。");
    this.#assertWorkspaceEquals({
      ...beforeWorkspace,
      freshness: beforeWorkspace.committed_at === null ? null : "stale",
    }, "workspace stale 后置状态不一致。");
    this.#assertOnlyExpectedChanges(
      totalChangesBefore,
      1,
      "workspace stale 更新触发了旁路表变更。",
    );
  }

  /**
   * 在一个同步事务中执行 base/read-set CAS、应用 ownership patch 并完成 Job。
   *
   * 任一节点、边、ownership、元数据或 Job 更新失败时全部回滚。
   */
  public commitAtomicGraphUpdate(input: AtomicGraphUpdate): AtomicGraphCommitResult {
    this.#ensureOpen();
    validateAtomicGraphUpdate(input, this.#workspaceKey);
    try {
      return this.#database.transaction(() => {
        let result: AtomicGraphCommitResult | undefined;
        let mutationCapabilityActive = true;
        let mutationFailed = false;
        let mutationError: unknown;
        let mutationInvoked = false;
        let mutationProtocolError: Error | undefined;
        let isCurrent: boolean;
        try {
          isCurrent = input.finalReadSetFence(() => {
            if (!mutationCapabilityActive) {
              throw new Error("最终 read-set mutation capability 已失效。");
            }
            if (mutationInvoked) {
              mutationProtocolError = new Error("最终 read-set fence 只能执行一次原子 mutation。");
              throw mutationProtocolError;
            }
            mutationInvoked = true;
            try {
              result = this.#commitAtomicGraphUpdate(input);
            } catch (error) {
              mutationFailed = true;
              mutationError = error;
              throw error;
            }
          });
        } finally {
          /** fence 返回或抛出后永久撤销 capability，禁止事务外逃逸调用。 */
          mutationCapabilityActive = false;
        }
        if (mutationFailed) {
          /** 独立失败哨兵覆盖 `throw undefined`，防止错误 fence 吞错后提交部分写。 */
          throw mutationError;
        }
        if (mutationProtocolError !== undefined) {
          /** fence 即使吞掉重复调用异常，事务也必须整体回滚。 */
          throw mutationProtocolError;
        }
        if (!isCurrent) {
          if (result !== undefined) {
            // mutation 后置栅栏失败必须通过异常让 better-sqlite3 回滚整个事务。
            throw new FinalReadSetStaleError();
          }
          return {
            graphRevision: this.#readWorkspaceRow().graph_revision,
            kind: "stale" as const,
          };
        }
        if (result === undefined) {
          throw new Error("最终 read-set 栅栏未执行原子 mutation。");
        }
        return result;
      }).immediate();
    } catch (error) {
      if (error instanceof FinalReadSetStaleError) {
        // rollback 完成后重新读取真实基线，不能返回事务内曾计算但未提交的 revision。
        return { graphRevision: this.#readWorkspaceRow().graph_revision, kind: "stale" };
      }
      throw error;
    }
  }

  /** 读取服务重启时需要恢复的提交摘要与最后 terminal Job。 */
  public readBootstrapState(): GraphStoreBootstrapState {
    this.#ensureOpen();
    const workspace = this.#database.prepare(`
      SELECT committed_at, indexed_file_count, node_count, edge_count,
             excluded_path_count, builtin_rules_version, graph_revision, freshness, completeness,
             manifest_digest, input_digest, config_digest, effective_ignore_digest, patch_digest
      FROM workspace
      WHERE workspace_key = ?
    `).get(this.#workspaceKey) as WorkspaceRow | undefined;
    const lastJobRow = readLatestTerminalJobRow(this.#database, this.#workspaceKey);
    const latestSucceededJobRow = readLatestSucceededJobRow(this.#database, this.#workspaceKey);
    const lastJob = lastJobRow === undefined
      ? null
      : mapValidatedTerminalJob(
          lastJobRow,
          this.#workspaceKey,
          this.#digestPort,
          workspace?.graph_revision ?? null,
        );
    const latestSucceededJob = latestSucceededJobRow === undefined
      ? null
      : mapValidatedTerminalJob(
          latestSucceededJobRow,
          this.#workspaceKey,
          this.#digestPort,
          workspace?.graph_revision ?? null,
        );
    const committedJobMeta = this.#database.prepare(`
      SELECT value
      FROM meta
      WHERE key = ?
    `).get(committedJobMetaKey(this.#workspaceKey)) as { value: string } | undefined;
    const committedReadSetDigestMeta = this.#database.prepare(`
      SELECT value
      FROM meta
      WHERE key = ?
    `).get(committedReadSetDigestMetaKey(this.#workspaceKey)) as { value: string } | undefined;
    const committedJob = committedJobMeta === undefined
      ? undefined
      : this.#database.prepare(`
        SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
               base_graph_revision, result_graph_revision, read_set_json, patch_digest,
               legacy_schema_version
        FROM jobs
        WHERE workspace_key = ? AND id = ? AND state = 'succeeded'
      `).get(this.#workspaceKey, committedJobMeta.value) as JobRow | undefined;
    const state = {
      committed: workspace?.committed_at === null || workspace === undefined
        ? null
        : mapWorkspaceSummary(workspace),
      completeness: mapWorkspaceCompleteness(workspace),
      freshness: workspace?.committed_at === null || workspace === undefined
        ? null
        : mapWorkspaceFreshness(workspace),
      lastJob,
    };
    validateCommittedJobEvidence(
      this.#database,
      this.#digestPort,
      this.#workspaceKey,
      workspace,
      committedJob,
      committedReadSetDigestMeta?.value ?? null,
    );
    validateBootstrapState(
      state,
      readPersistedGraphCounts(this.#database, this.#workspaceKey),
      committedJob === undefined ? null : mapJob(committedJob),
      committedJobMeta?.value ?? null,
      latestSucceededJob,
    );
    return state;
  }

  /** 读取 application 计算 patch 所需的当前 revision、read-set 与 ownership slice。 */
  public readCommittedSnapshot(): CommittedGraphSnapshotV1 {
    this.#ensureOpen();
    return this.#database.transaction(() => this.#readCommittedSnapshot())();
  }

  /** 同一只读事务内取得 revision、read-set 与完整 ownership slice。 */
  #readCommittedSnapshot(): CommittedGraphSnapshotV1 {
    const workspace = this.#database.prepare(`
      SELECT graph_revision, manifest_digest, input_digest, config_digest,
             effective_ignore_digest, patch_digest
      FROM workspace
      WHERE workspace_key = ?
    `).get(this.#workspaceKey) as SnapshotWorkspaceRow | undefined;
    const ownershipSliceId = hierarchyOwnershipSliceId(this.#workspaceKey);
    if (workspace === undefined || workspace.graph_revision === null) {
      return Object.freeze({
        committedReadSet: null,
        graphRevision: null,
        ownedEdges: Object.freeze([]),
        ownedNodes: Object.freeze([]),
        ownershipSliceId,
        patchDigest: null,
      });
    }
    const ownedNodes = this.#database.prepare(`
      SELECT node.id, node.kind, node.relative_path
      FROM facts_ownership AS ownership
      JOIN nodes AS node ON node.id = ownership.fact_id
      WHERE ownership.workspace_key = ? AND ownership.owner_key = ?
        AND ownership.fact_kind = 'node'
      ORDER BY node.id
    `).all(this.#workspaceKey, ownershipSliceId) as NodeRow[];
    const ownedEdges = this.#database.prepare(`
      SELECT edge.id, edge.from_id, edge.relation_type, edge.to_id, edge.qualifier
      FROM facts_ownership AS ownership
      JOIN edges AS edge ON edge.id = ownership.fact_id
      WHERE ownership.workspace_key = ? AND ownership.owner_key = ?
        AND ownership.fact_kind = 'edge'
      ORDER BY edge.id
    `).all(this.#workspaceKey, ownershipSliceId) as EdgeRow[];
    return Object.freeze({
      committedReadSet: mapCommittedReadSet(workspace),
      graphRevision: workspace.graph_revision,
      ownedEdges: Object.freeze(ownedEdges.map(mapHierarchyEdge)),
      ownedNodes: Object.freeze(ownedNodes.map(mapHierarchyNode)),
      ownershipSliceId,
      patchDigest: workspace.patch_digest,
    });
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

  /** 测试原子提交与幂等重放时读取稳定排序的 ownership。 */
  public listOwnership(): readonly { factId: string; factKind: "edge" | "node"; ownerKey: string }[] {
    this.#ensureOpen();
    return (this.#database.prepare(`
      SELECT fact_id, fact_kind, owner_key
      FROM facts_ownership
      WHERE workspace_key = ?
      ORDER BY fact_kind, fact_id, owner_key
    `).all(this.#workspaceKey) as OwnershipRow[]).map((row) => ({
      factId: row.fact_id,
      factKind: row.fact_kind,
      ownerKey: row.owner_key,
    }));
  }

  /** terminal 未提交 Job 只绑定 base/result revision，不触碰 workspace 或 ownership。 */
  #markUncommittedTerminal(
    jobId: string,
    state: "cancelled" | "failed" | "partial",
    completedAt: string,
    errorCode?: string,
    errorLogId?: string,
  ): void {
    this.#ensureOpen();
    const totalChangesBefore = this.#readTotalChanges();
    const before = this.#database.prepare(`
      SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
             base_graph_revision, result_graph_revision, read_set_json, patch_digest,
             legacy_schema_version
      FROM jobs
      WHERE id = ? AND workspace_key = ? AND state IN ('queued', 'running')
    `).get(jobId, this.#workspaceKey) as ActiveJobEvidenceRow | undefined;
    if (before === undefined) {
      throw new Error(`Job 无法进入 ${state}。`);
    }
    validateStoredActiveJob(before);
    if (before.read_set_json !== null || before.patch_digest !== null) {
      throw new Error("活动 Job 不得提前持久化提交证据。");
    }
    const expected: StoredIndexJob = {
      baseGraphRevision: before.base_graph_revision,
      completedAt,
      ...(state === "failed" ? { errorCode: errorCode!, errorLogId: errorLogId! } : {}),
      id: before.id,
      kind: before.kind,
      requestedAt: before.requested_at,
      resultGraphRevision: before.base_graph_revision,
      startedAt: before.started_at ?? completedAt,
      state,
    };
    const result = this.#database.prepare(`
      UPDATE jobs
      SET state = ?, started_at = COALESCE(started_at, ?), completed_at = ?,
          error_code = ?, error_log_id = ?, result_graph_revision = base_graph_revision
      WHERE id = ? AND workspace_key = ? AND state IN ('queued', 'running')
    `).run(
      state,
      completedAt,
      completedAt,
      errorCode ?? null,
      errorLogId ?? null,
      jobId,
      this.#workspaceKey,
    );
    requireSingleChange(result.changes, `Job 无法进入 ${state}。`);
    const persisted = this.#database.prepare(`
      SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
             base_graph_revision, result_graph_revision, read_set_json, patch_digest,
             legacy_schema_version
      FROM jobs
      WHERE id = ? AND workspace_key = ?
    `).get(jobId, this.#workspaceKey) as JobRow | undefined;
    if (
      persisted === undefined ||
      persisted.read_set_json !== null ||
      persisted.patch_digest !== null
    ) {
      throw new Error(`Job ${state} 后置状态不一致。`);
    }
    const persistedJob = mapJob(persisted);
    validateStoredTerminalJob(persistedJob);
    if (!matchesRecoveredJob(persistedJob, expected)) {
      throw new Error(`Job ${state} 后置状态不一致。`);
    }
    const prunedJobs = this.#pruneTerminalJobHistory();
    this.#assertOnlyExpectedChanges(
      totalChangesBefore,
      1 + prunedJobs,
      `Job ${state} 写入触发了旁路表变更。`,
    );
  }

  /** 读取唯一 workspace 行，供事务内精确后置条件比较。 */
  #readWorkspaceRow(): WorkspaceRow {
    const row = this.#database.prepare(`
      SELECT committed_at, indexed_file_count, node_count, edge_count,
             excluded_path_count, builtin_rules_version, graph_revision, freshness, completeness,
             manifest_digest, input_digest, config_digest, effective_ignore_digest, patch_digest
      FROM workspace
      WHERE workspace_key = ?
    `).get(this.#workspaceKey) as WorkspaceRow | undefined;
    if (row === undefined) {
      throw new Error("workspace 提交目标不存在。");
    }
    return row;
  }

  /** AFTER trigger 也必须留下唯一预期 workspace 行，否则当前事务整体回滚。 */
  #assertWorkspaceEquals(expected: WorkspaceRow, message: string): void {
    if (!sameWorkspaceRow(this.#readWorkspaceRow(), expected)) {
      throw new Error(message);
    }
  }

  /** SQLite total_changes 包含 trigger 与级联写入，可 O(1) 识别任何旁路表修改。 */
  #readTotalChanges(): number {
    return (this.#database.prepare("SELECT total_changes() AS count").get() as { count: number })
      .count;
  }

  /** 非图事务只能产生调用方声明的精确行变更数，否则整体回滚。 */
  #assertOnlyExpectedChanges(before: number, expected: number, message: string): void {
    const actual = this.#readTotalChanges() - before;
    if (actual !== expected) {
      throw new Error(`${message} 预期 ${expected} 次，实际 ${actual} 次。`);
    }
  }

  /** 删除超出公开 last/current 需求的旧终态，同时永久保护当前 committed Job。 */
  #pruneTerminalJobHistory(): number {
    const committedJobId = readMetaValue(
      this.#database,
      committedJobMetaKey(this.#workspaceKey),
    );
    const recentLimit = committedJobId === null
      ? MAX_RETAINED_TERMINAL_JOBS
      : MAX_RETAINED_TERMINAL_JOBS - 1;
    const changes = this.#database.prepare(`
      DELETE FROM jobs
      WHERE workspace_key = ?
        AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
        AND (? IS NULL OR id <> ?)
        AND rowid NOT IN (
          SELECT rowid
          FROM jobs
          WHERE workspace_key = ?
            AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
            AND (? IS NULL OR id <> ?)
          ORDER BY rowid DESC
          LIMIT ?
        )
    `).run(
      this.#workspaceKey,
      committedJobId,
      committedJobId,
      this.#workspaceKey,
      committedJobId,
      committedJobId,
      recentLimit,
    ).changes;
    const remainingPrunable = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE workspace_key = ?
        AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
        AND (? IS NULL OR id <> ?)
        AND rowid NOT IN (
          SELECT rowid
          FROM jobs
          WHERE workspace_key = ?
            AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
            AND (? IS NULL OR id <> ?)
          ORDER BY rowid DESC
          LIMIT ?
        )
    `).get(
      this.#workspaceKey,
      committedJobId,
      committedJobId,
      this.#workspaceKey,
      committedJobId,
      committedJobId,
      recentLimit,
    ) as { count: number };
    if (remainingPrunable.count !== 0) {
      throw new Error("terminal Job 历史裁剪未能收敛到有界集合。");
    }
    return changes;
  }

  /** 同步事务内部的 CAS、patch、metadata 与 Job 实际提交。 */
  #commitAtomicGraphUpdate(input: AtomicGraphUpdate): AtomicGraphCommitResult {
    const workspace = this.#readWorkspaceRow();
    if (!matchesExpectedSnapshot(workspace, input.expectedSnapshot)) {
      return { graphRevision: workspace.graph_revision, kind: "stale" };
    }
    const runningJob = this.#database.prepare(`
      SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
             base_graph_revision, result_graph_revision, read_set_json, patch_digest,
             legacy_schema_version
      FROM jobs
      WHERE id = ? AND workspace_key = ? AND state = 'running'
    `).get(input.jobId, this.#workspaceKey) as ActiveJobEvidenceRow | undefined;
    if (runningJob === undefined) {
      throw new Error("原子提交缺少对应的 running Job。");
    }
    validateStoredActiveJob(runningJob);
    if (
      runningJob.read_set_json !== null ||
      runningJob.patch_digest !== null ||
      runningJob.legacy_schema_version !== null
    ) {
      throw new Error("running Job 不得提前携带提交证据。");
    }
    if (this.#digestPort === undefined) {
      throw new Error("原子提交缺少规范 digest 实现。");
    }
    const totalChangesBefore = this.#readTotalChanges();
    let expectedChanges = 0;

    const patch = input.patch;
    const hasOperations = patch.nodeUpserts.length > 0 ||
      patch.nodeDeletes.length > 0 ||
      patch.edgeUpserts.length > 0 ||
      patch.edgeDeletes.length > 0;
    const graphChanged = hasOperations;
    if (graphChanged) {
      expectedChanges += this.#applyPatchDeletes(patch);
      expectedChanges += this.#applyPatchUpserts(patch);
    }

    const nextRevision = graphChanged
      ? (workspace.graph_revision ?? 0) + 1
      : workspace.graph_revision;
    if (nextRevision === null || !Number.isSafeInteger(nextRevision) || nextRevision < 1) {
      throw new Error("图谱提交未能生成真实 graphRevision。");
    }
    const counts = readPersistedGraphCounts(this.#database, this.#workspaceKey);
    if (
      counts.nodeCount !== input.summary.nodeCount ||
      counts.edgeCount !== input.summary.edgeCount ||
      counts.fileCount !== input.summary.indexedFileCount
    ) {
      throw new TypeError("GraphPatch 应用后的实际事实与摘要不一致。");
    }

    this.#faultInjector?.({ entityIndex: 0, stage: "metadata" });
    const readSet = toCommittedReadSet(patch);
    const serializedReadSet = JSON.stringify(patch.readSet);
    const readSetDigest = this.#digestPort.digest(patch.readSet);
    const expectedWorkspace: WorkspaceRow = {
      ...workspace,
      builtin_rules_version: input.summary.builtinRulesVersion,
      committed_at: input.summary.generatedAt,
      completeness: input.summary.indexedFileCount === 0 ? "empty" : "complete",
      config_digest: readSet.configDigest,
      edge_count: input.summary.edgeCount,
      effective_ignore_digest: readSet.effectiveIgnoreDigest,
      excluded_path_count: input.summary.excludedPathCount,
      freshness: "current",
      graph_revision: nextRevision,
      indexed_file_count: input.summary.indexedFileCount,
      input_digest: readSet.inputDigest,
      manifest_digest: readSet.manifestDigest,
      node_count: input.summary.nodeCount,
      patch_digest: patch.patchDigest,
    };
    const workspaceResult = this.#database.prepare(`
      UPDATE workspace
      SET committed_at = ?, indexed_file_count = ?, node_count = ?, edge_count = ?,
          excluded_path_count = ?, builtin_rules_version = ?, graph_revision = ?,
          freshness = 'current', completeness = ?, manifest_digest = ?, input_digest = ?, config_digest = ?,
          effective_ignore_digest = ?, patch_digest = ?
      WHERE workspace_key = ?
    `).run(
      input.summary.generatedAt,
      input.summary.indexedFileCount,
      input.summary.nodeCount,
      input.summary.edgeCount,
      input.summary.excludedPathCount,
      input.summary.builtinRulesVersion,
      nextRevision,
      input.summary.indexedFileCount === 0 ? "empty" : "complete",
      readSet.manifestDigest,
      readSet.inputDigest,
      readSet.configDigest,
      readSet.effectiveIgnoreDigest,
      patch.patchDigest,
      this.#workspaceKey,
    );
    requireSingleChange(workspaceResult.changes, "workspace 原子提交摘要更新失败。");
    expectedChanges += workspaceResult.changes;

    this.#faultInjector?.({ entityIndex: 0, stage: "job" });
    const jobResult = this.#database.prepare(`
      UPDATE jobs
      SET state = 'succeeded', completed_at = ?, error_code = NULL, error_log_id = NULL,
          result_graph_revision = ?, read_set_json = ?, patch_digest = ?
      WHERE id = ? AND workspace_key = ? AND state = 'running'
    `).run(
      input.completedAt,
      nextRevision,
      serializedReadSet,
      patch.patchDigest,
      input.jobId,
      this.#workspaceKey,
    );
    requireSingleChange(jobResult.changes, "Job 无法进入 succeeded。");
    expectedChanges += jobResult.changes;
    const upsertMeta = this.#database.prepare(`
      INSERT INTO meta(key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    expectedChanges += upsertMeta.run(
      committedJobMetaKey(this.#workspaceKey),
      input.jobId,
    ).changes;
    expectedChanges += upsertMeta.run(
      committedReadSetDigestMetaKey(this.#workspaceKey),
      readSetDigest,
    ).changes;
    expectedChanges += this.#pruneTerminalJobHistory();

    this.#assertWorkspaceEquals(expectedWorkspace, "原子提交的 workspace 后置状态不一致。");
    const finalJob = this.#database.prepare(`
      SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
             base_graph_revision, result_graph_revision, read_set_json, patch_digest,
             legacy_schema_version
      FROM jobs
      WHERE id = ? AND workspace_key = ?
    `).get(input.jobId, this.#workspaceKey) as JobRow | undefined;
    if (
      finalJob === undefined ||
      finalJob.state !== "succeeded" ||
      finalJob.requested_at !== runningJob.requested_at ||
      finalJob.started_at !== runningJob.started_at ||
      finalJob.completed_at !== input.completedAt ||
      finalJob.kind !== runningJob.kind ||
      finalJob.base_graph_revision !== runningJob.base_graph_revision ||
      finalJob.result_graph_revision !== nextRevision ||
      finalJob.error_code !== null ||
      finalJob.error_log_id !== null ||
      finalJob.read_set_json !== serializedReadSet ||
      finalJob.patch_digest !== patch.patchDigest ||
      finalJob.legacy_schema_version !== null
    ) {
      throw new Error("原子提交的 Job 后置状态不一致。");
    }
    if (
      readMetaValue(this.#database, committedJobMetaKey(this.#workspaceKey)) !== input.jobId ||
      readMetaValue(this.#database, committedReadSetDigestMetaKey(this.#workspaceKey)) !== readSetDigest
    ) {
      throw new Error("原子提交的 meta 后置状态不一致。");
    }
    this.#assertOnlyExpectedChanges(
      totalChangesBefore,
      expectedChanges,
      "原子提交触发了未声明的旁路表变更。",
    );
    // 最终公开前复用启动屏障，校验 topology、ownership、摘要及完整 read-set 绑定。
    this.readBootstrapState();

    const summary: StoredIndexSummary = Object.freeze({
      ...input.summary,
      graphRevision: nextRevision,
    });
    return {
      graphRevision: nextRevision,
      kind: graphChanged ? "committed" : "noop",
      summary,
    };
  }

  /** 按外键安全顺序移除 slice ownership，并只删除已无 owner 的事实。 */
  #applyPatchDeletes(patch: GraphPatchV1): number {
    let changes = 0;
    const deleteOwnership = this.#database.prepare(`
      DELETE FROM facts_ownership
      WHERE workspace_key = ? AND owner_key = ? AND fact_kind = ? AND fact_id = ?
    `);
    const deleteUnownedEdge = this.#database.prepare(`
      DELETE FROM edges
      WHERE workspace_key = ? AND id = ?
        AND NOT EXISTS (
          SELECT 1 FROM facts_ownership
          WHERE workspace_key = ? AND fact_kind = 'edge' AND fact_id = ?
        )
    `);
    patch.edgeDeletes.forEach((factId, entityIndex) => {
      this.#faultInjector?.({ entityIndex, stage: "ownership" });
      changes += deleteOwnership.run(
        this.#workspaceKey,
        patch.ownershipSliceId,
        "edge",
        factId,
      ).changes;
      changes += deleteUnownedEdge.run(
        this.#workspaceKey,
        factId,
        this.#workspaceKey,
        factId,
      ).changes;
    });
    const deleteUnownedNode = this.#database.prepare(`
      DELETE FROM nodes
      WHERE workspace_key = ? AND id = ?
        AND NOT EXISTS (
          SELECT 1 FROM facts_ownership
          WHERE workspace_key = ? AND fact_kind = 'node' AND fact_id = ?
        )
    `);
    patch.nodeDeletes.forEach((factId, entityIndex) => {
      this.#faultInjector?.({ entityIndex, stage: "ownership" });
      changes += deleteOwnership.run(
        this.#workspaceKey,
        patch.ownershipSliceId,
        "node",
        factId,
      ).changes;
      changes += deleteUnownedNode.run(
        this.#workspaceKey,
        factId,
        this.#workspaceKey,
        factId,
      ).changes;
    });
    return changes;
  }

  /** 先 upsert 节点再写边，并为每项事实补齐目标 ownership。 */
  #applyPatchUpserts(patch: GraphPatchV1): number {
    let changes = 0;
    const upsertNode = this.#database.prepare(`
      INSERT INTO nodes(id, workspace_key, kind, relative_path)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_key = excluded.workspace_key,
        kind = excluded.kind,
        relative_path = excluded.relative_path
    `);
    const upsertOwnership = this.#database.prepare(`
      INSERT INTO facts_ownership(fact_kind, fact_id, owner_key, workspace_key)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(fact_kind, fact_id, owner_key) DO NOTHING
    `);
    patch.nodeUpserts.forEach((node, entityIndex) => {
      this.#faultInjector?.({ entityIndex, stage: "node" });
      changes += upsertNode.run(
        node.id,
        this.#workspaceKey,
        node.kind,
        node.relativePath,
      ).changes;
      this.#faultInjector?.({ entityIndex, stage: "ownership" });
      changes += upsertOwnership.run(
        "node",
        node.id,
        patch.ownershipSliceId,
        this.#workspaceKey,
      ).changes;
    });
    const upsertEdge = this.#database.prepare(`
      INSERT INTO edges(id, workspace_key, from_id, relation_type, to_id, qualifier)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_key = excluded.workspace_key,
        from_id = excluded.from_id,
        relation_type = excluded.relation_type,
        to_id = excluded.to_id,
        qualifier = excluded.qualifier
    `);
    patch.edgeUpserts.forEach((edge, entityIndex) => {
      this.#faultInjector?.({ entityIndex, stage: "edge" });
      changes += upsertEdge.run(
        edge.id,
        this.#workspaceKey,
        edge.fromId,
        edge.relationType,
        edge.toId,
        edge.qualifier,
      ).changes;
      this.#faultInjector?.({ entityIndex, stage: "ownership" });
      changes += upsertOwnership.run(
        "edge",
        edge.id,
        patch.ownershipSliceId,
        this.#workspaceKey,
      ).changes;
    });
    return changes;
  }

  /** 为修复前已提交的合法 schema v1 数据回填私有 committed Job 绑定。 */
  #backfillLegacyCommittedJobBinding(): number {
    const metaKey = committedJobMetaKey(this.#workspaceKey);
    const existingBinding = this.#database.prepare(`
      SELECT value FROM meta WHERE key = ?
    `).get(metaKey) as { value: string } | undefined;
    if (existingBinding !== undefined) {
      return 0;
    }
    const workspace = this.#database.prepare(`
      SELECT committed_at, indexed_file_count, node_count, edge_count,
             excluded_path_count, builtin_rules_version, graph_revision, freshness, completeness,
             manifest_digest, input_digest, config_digest, effective_ignore_digest, patch_digest
      FROM workspace
      WHERE workspace_key = ?
    `).get(this.#workspaceKey) as WorkspaceRow | undefined;
    if (workspace === undefined || workspace.committed_at === null) {
      return 0;
    }
    const latestSucceededJobRow = readLatestSucceededJobRow(this.#database, this.#workspaceKey);
    const latestSucceededJob = latestSucceededJobRow === undefined
      ? null
      : mapValidatedTerminalJob(
          latestSucceededJobRow,
          this.#workspaceKey,
          this.#digestPort,
          workspace.graph_revision,
        );
    if (
      latestSucceededJob === null ||
      latestSucceededJob.completedAt !== workspace.committed_at
    ) {
      throw new Error("旧版持久提交的最新 succeeded Job 与 workspace 摘要不一致。");
    }
    const lastJobRow = readLatestTerminalJobRow(this.#database, this.#workspaceKey);
    const lastJob = lastJobRow === undefined
      ? null
      : mapValidatedTerminalJob(
          lastJobRow,
          this.#workspaceKey,
          this.#digestPort,
          workspace.graph_revision,
        );
    const state = {
      committed: mapWorkspaceSummary(workspace),
      completeness: mapWorkspaceCompleteness(workspace),
      freshness: mapWorkspaceFreshness(workspace),
      lastJob,
    };
    validateBootstrapState(
      state,
      readPersistedGraphCounts(this.#database, this.#workspaceKey),
      latestSucceededJob,
      latestSucceededJob.id,
      latestSucceededJob,
    );
    return this.#database.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
    `).run(metaKey, latestSucceededJob.id).changes;
  }

  /** 防止关闭后的 SQLite 句柄继续被调用。 */
  #ensureOpen(): void {
    if (this.#closed) {
      throw new Error("SQLite 图谱存储已经关闭。");
    }
  }
}

/** 打开、配置、迁移并回验 Story 1.19 SQLite 存储。 */
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
    assertDeterministicSchemaSupported(database);
    configurePragmas(database);
    applyDeterministicCommitMigration(database);
    database.prepare(`
      INSERT INTO workspace(workspace_key, completeness)
      VALUES (?, 'empty')
      ON CONFLICT(workspace_key) DO NOTHING
    `).run(options.workspaceKey);
    readAndValidatePragmas(database);
    if (
      JSON.stringify(readTableNames(database)) !==
      JSON.stringify(DETERMINISTIC_COMMIT_TABLE_NAMES)
    ) {
      throw new Error("SQLite migration 未保持精确八表。");
    }
    const store = new SqliteGraphStore(
      database,
      options.workspaceKey,
      options.faultInjector,
      options.digestPort,
    );
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

/** 校验原子更新只接受 hierarchy complete patch 与一致的摘要/read-set。 */
function validateAtomicGraphUpdate(input: AtomicGraphUpdate, workspaceKey: string): void {
  const patch = input.patch;
  if (
    patch.coverage !== "complete" ||
    patch.ownershipSliceId !== hierarchyOwnershipSliceId(workspaceKey) ||
    patch.ownershipSliceId !== input.expectedSnapshot.ownershipSliceId ||
    patch.baseGraphRevision !== input.expectedSnapshot.graphRevision ||
    patch.baseGraphRevision !== patch.readSet.baseGraphRevision ||
    input.completedAt !== input.summary.generatedAt ||
    typeof input.finalReadSetFence !== "function" ||
    !/^[a-f0-9]{64}$/u.test(patch.patchDigest)
  ) {
    throw new TypeError("原子 GraphPatch 输入与 hierarchy 提交合同不一致。");
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
  completeness: string | null;
  config_digest: string | null;
  edge_count: number | null;
  effective_ignore_digest: string | null;
  excluded_path_count: number | null;
  freshness: string | null;
  graph_revision: number | null;
  input_digest: string | null;
  indexed_file_count: number | null;
  manifest_digest: string | null;
  node_count: number | null;
  patch_digest: string | null;
}

interface JobRow {
  base_graph_revision: number | null;
  completed_at: string | null;
  error_code: string | null;
  error_log_id: string | null;
  id: string;
  kind: "initial-index" | "rebuild";
  legacy_schema_version: 1 | null;
  patch_digest: string | null;
  read_set_json: string | null;
  requested_at: string;
  started_at: string | null;
  result_graph_revision: number | null;
  state: "cancelled" | "failed" | "partial" | "succeeded";
}

/** 单个 Job 的完整私有列与 rowid，用于目标行后置校验。 */
interface JobEvidenceRow {
  base_graph_revision: number | null;
  completed_at: string | null;
  error_code: string | null;
  error_log_id: string | null;
  id: string;
  kind: "initial-index" | "rebuild";
  legacy_schema_version: 1 | null;
  patch_digest: string | null;
  read_set_json: string | null;
  requested_at: string;
  result_graph_revision: number | null;
  rowid: number;
  started_at: string | null;
  state: "cancelled" | "failed" | "partial" | "queued" | "running" | "succeeded";
}

interface ActiveJobRow {
  base_graph_revision: number | null;
  completed_at: string | null;
  error_code: string | null;
  error_log_id: string | null;
  id: string;
  kind: "initial-index" | "rebuild";
  legacy_schema_version: 1 | null;
  requested_at: string;
  started_at: string | null;
  result_graph_revision: null;
  state: "queued" | "running";
}

/** 活动 Job 的完整私有证据列，提交或 terminal 前不得提前出现。 */
interface ActiveJobEvidenceRow extends ActiveJobRow {
  patch_digest: string | null;
  read_set_json: string | null;
}

interface SnapshotWorkspaceRow {
  config_digest: string | null;
  effective_ignore_digest: string | null;
  graph_revision: number | null;
  input_digest: string | null;
  manifest_digest: string | null;
  patch_digest: string | null;
}

interface NodeRow {
  id: string;
  kind: HierarchyNode["kind"];
  relative_path: string;
}

interface EdgeRow {
  from_id: string;
  id: string;
  qualifier: string;
  relation_type: "contains";
  to_id: string;
}

interface OwnershipRow {
  fact_id: string;
  fact_kind: "edge" | "node";
  owner_key: string;
}

interface PersistedGraphCounts {
  edgeCount: number;
  fileCount: number;
  hierarchyOwnedEdgeCount: number;
  hierarchyOwnedNodeCount: number;
  invalidOwnershipCount: number;
  nodeCount: number;
  unknownOwnershipCount: number;
}

/** 打开边界以 O(1) 内存流式校验全部历史 Job，避免长期使用时物化整个表。 */
function validateStoredJobHistory(
  database: Database.Database,
  digestPort: CanonicalDigestPort | undefined,
  workspaceKey: string,
  graphRevision: number | null,
): void {
  const rows = database.prepare(`
    SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
           base_graph_revision, result_graph_revision, read_set_json, patch_digest,
           legacy_schema_version
    FROM jobs
    WHERE workspace_key = ? AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
    ORDER BY rowid
  `).iterate(workspaceKey) as IterableIterator<JobRow>;
  for (const row of rows) {
    mapValidatedTerminalJob(row, workspaceKey, digestPort, graphRevision);
  }
}

/** 只读取公开状态所需的最后 terminal Job，历史完整性由打开边界流式校验。 */
function readLatestTerminalJobRow(
  database: Database.Database,
  workspaceKey: string,
): JobRow | undefined {
  return database.prepare(`
    SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
           base_graph_revision, result_graph_revision, read_set_json, patch_digest,
           legacy_schema_version
    FROM jobs
    WHERE workspace_key = ? AND state IN ('succeeded', 'failed', 'partial', 'cancelled')
    ORDER BY rowid DESC
    LIMIT 1
  `).get(workspaceKey) as JobRow | undefined;
}

/** 按持久 rowid 读取最新 succeeded；毫秒时间相等不影响确定性绑定。 */
function readLatestSucceededJobRow(
  database: Database.Database,
  workspaceKey: string,
): JobRow | undefined {
  return database.prepare(`
    SELECT id, kind, state, requested_at, started_at, completed_at, error_code, error_log_id,
           base_graph_revision, result_graph_revision, read_set_json, patch_digest,
           legacy_schema_version
    FROM jobs
    WHERE workspace_key = ? AND state = 'succeeded'
    ORDER BY rowid DESC
    LIMIT 1
  `).get(workspaceKey) as JobRow | undefined;
}

/** 校验并映射单个 terminal Job，供流式打开验证和 O(1) 状态恢复复用。 */
function mapValidatedTerminalJob(
  row: JobRow,
  workspaceKey: string,
  digestPort: CanonicalDigestPort | undefined,
  graphRevision: number | null,
): StoredIndexJob {
  validatePersistedSucceededAttempt(row, workspaceKey, digestPort);
  const job = mapJob(row);
  validateStoredTerminalJob(job);
  validateTerminalJobAgainstWorkspace(job, graphRevision);
  return job;
}

/** 仅 migration 明确标记的 schema v1 Job 可缺少证据，其余成功 attempt 必须完整可派生。 */
function validatePersistedSucceededAttempt(
  row: JobRow,
  workspaceKey: string,
  digestPort: CanonicalDigestPort | undefined,
): void {
  if (row.state !== "succeeded") {
    return;
  }
  const hasReadSet = row.read_set_json !== null;
  const hasPatchDigest = row.patch_digest !== null;
  if (hasReadSet !== hasPatchDigest) {
    throw new Error("历史 succeeded Job 的 patch/read-set 证据不完整。");
  }
  if (row.legacy_schema_version === 1) {
    if (hasReadSet || row.result_graph_revision !== 1) {
      throw new Error("schema v1 succeeded Job 的迁移来源与提交证据不一致。");
    }
    return;
  }
  if (!hasReadSet) {
    throw new Error("非 legacy succeeded Job 不得缺少 patch/read-set 证据。");
  }
  if (!isSha256Digest(row.patch_digest!)) {
    throw new Error("历史 succeeded Job 的 patch digest 不合法。");
  }
  const readSet = parsePersistedHierarchyReadSet(row.read_set_json!);
  if (digestPort === undefined) {
    throw new Error("历史 succeeded Job 的完整证据校验缺少规范 digest 实现。");
  }
  const derivedEvidence = deriveHierarchyEvidenceDigests(workspaceKey, readSet, digestPort);
  if (
    derivedEvidence.manifestDigest !== readSet.manifestDigest ||
    derivedEvidence.inputDigest !== readSet.inputDigest ||
    derivedEvidence.configDigest !== readSet.configDigest ||
    derivedEvidence.patchDigest !== row.patch_digest
  ) {
    throw new Error("历史 succeeded Job 的 read-set 或 patch digest 无法从规范语义重新派生。");
  }
  const resultRevision = row.result_graph_revision;
  const attemptBase = readSet.baseGraphRevision;
  const kindMatchesAttempt = row.kind === "initial-index"
    ? attemptBase === null && resultRevision === 1
    : attemptBase !== null;
  const logicalBasePrecedesAttempt = row.base_graph_revision === null
    ? row.kind === "initial-index" && attemptBase === null
    : attemptBase !== null && row.base_graph_revision <= attemptBase;
  const resultMatchesAttempt = resultRevision !== null && (
    attemptBase === null
      ? resultRevision === 1
      : resultRevision === attemptBase || resultRevision === attemptBase + 1
  );
  if (!kindMatchesAttempt || !logicalBasePrecedesAttempt || !resultMatchesAttempt) {
    throw new Error("历史 succeeded Job 与最终 CAS read-set revision 不一致。");
  }
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
  const ownershipSliceId = hierarchyOwnershipSliceId(workspaceKey);
  const hierarchyOwnership = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN fact_kind = 'node' THEN 1 ELSE 0 END), 0) AS node_count,
      COALESCE(SUM(CASE WHEN fact_kind = 'edge' THEN 1 ELSE 0 END), 0) AS edge_count
    FROM facts_ownership
    WHERE workspace_key = ? AND owner_key = ?
  `).get(workspaceKey, ownershipSliceId) as { edge_count: number; node_count: number };
  const invalidOwnership = database.prepare(`
    SELECT COUNT(*) AS count
    FROM facts_ownership AS ownership
    WHERE ownership.workspace_key = ? AND (
      (ownership.fact_kind = 'node' AND NOT EXISTS (
        SELECT 1 FROM nodes
        WHERE workspace_key = ownership.workspace_key AND id = ownership.fact_id
      )) OR
      (ownership.fact_kind = 'edge' AND NOT EXISTS (
        SELECT 1 FROM edges
        WHERE workspace_key = ownership.workspace_key AND id = ownership.fact_id
      ))
    )
  `).get(workspaceKey) as { count: number };
  const unknownOwnership = database.prepare(`
    SELECT COUNT(*) AS count
    FROM facts_ownership
    WHERE workspace_key = ? AND owner_key <> ?
  `).get(workspaceKey, ownershipSliceId) as { count: number };
  return {
    edgeCount: edges.edge_count,
    fileCount: nodes.file_count,
    hierarchyOwnedEdgeCount: hierarchyOwnership.edge_count,
    hierarchyOwnedNodeCount: hierarchyOwnership.node_count,
    invalidOwnershipCount: invalidOwnership.count,
    nodeCount: nodes.node_count,
    unknownOwnershipCount: unknownOwnership.count,
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
    if (
      counts.nodeCount !== 0 ||
      counts.edgeCount !== 0 ||
      counts.fileCount !== 0 ||
      counts.hierarchyOwnedNodeCount !== 0 ||
      counts.hierarchyOwnedEdgeCount !== 0 ||
      counts.invalidOwnershipCount !== 0 ||
      counts.unknownOwnershipCount !== 0
    ) {
      throw new Error("无提交基线时不允许残留 hierarchy 行。");
    }
    if (committedJobId !== null || latestSucceededJob !== null) {
      throw new Error("成功 Job 缺少对应的持久提交摘要。");
    }
    if (state.freshness !== null) {
      throw new Error("无提交基线时不得持久化 freshness。");
    }
    if (state.completeness !== "empty" && state.completeness !== "partial") {
      throw new Error("无提交基线时 completeness 不合法。");
    }
  } else {
    if (
      !isNonNegativeSafeInteger(summary.indexedFileCount) ||
      !isNonNegativeSafeInteger(summary.nodeCount) ||
      !isNonNegativeSafeInteger(summary.edgeCount) ||
      !isNonNegativeSafeInteger(summary.excludedPathCount) ||
      !Number.isSafeInteger(summary.graphRevision) ||
      summary.graphRevision < 1 ||
      summary.nodeCount < summary.indexedFileCount + 1 ||
      summary.edgeCount !== summary.nodeCount - 1 ||
      summary.nodeCount !== counts.nodeCount ||
      summary.edgeCount !== counts.edgeCount ||
      summary.indexedFileCount !== counts.fileCount ||
      counts.hierarchyOwnedNodeCount !== counts.nodeCount ||
      counts.hierarchyOwnedEdgeCount !== counts.edgeCount ||
      counts.invalidOwnershipCount !== 0 ||
      counts.unknownOwnershipCount !== 0 ||
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
      committedJob.resultGraphRevision !== summary.graphRevision ||
      latestSucceededJob?.id !== committedJobId
    ) {
      throw new Error("成功 Job 与持久提交时间不一致。");
    }
    if (state.freshness !== "current" && state.freshness !== "stale") {
      throw new Error("持久提交缺少合法 freshness。");
    }
    if (
      state.completeness !== "partial" &&
      state.completeness !== (summary.indexedFileCount === 0 ? "empty" : "complete")
    ) {
      throw new Error("持久提交 completeness 与摘要不一致。");
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
    (job.baseGraphRevision !== null && !isPositiveSafeInteger(job.baseGraphRevision)) ||
    (job.resultGraphRevision !== null && !isPositiveSafeInteger(job.resultGraphRevision)) ||
    (job.kind === "initial-index" && job.baseGraphRevision !== null) ||
    (job.kind === "rebuild" && job.baseGraphRevision === null) ||
    (job.state === "failed" &&
      (job.errorCode === undefined ||
        job.errorCode.length === 0 ||
        !PERSISTED_INDEX_JOB_ERROR_CODES.has(job.errorCode) ||
        job.errorLogId === undefined ||
        job.errorLogId.length === 0)) ||
    (job.state !== "failed" &&
      (job.errorCode !== undefined || job.errorLogId !== undefined)) ||
    ((job.state === "cancelled" || job.state === "failed" || job.state === "partial") &&
      job.resultGraphRevision !== job.baseGraphRevision) ||
    (job.state === "succeeded" &&
      (job.resultGraphRevision === null ||
        job.resultGraphRevision < 1 ||
        (job.baseGraphRevision !== null && job.baseGraphRevision > job.resultGraphRevision)))
  ) {
    throw new Error("持久化 terminal Job 合同不完整或时间不单调。");
  }
}

/** terminal logical base 不得指向当前持久 graphRevision 之后的未来状态。 */
function validateTerminalJobAgainstWorkspace(
  job: StoredIndexJob,
  graphRevision: number | null,
): void {
  if (
    job.baseGraphRevision !== null &&
    (graphRevision === null || job.baseGraphRevision > graphRevision)
  ) {
    throw new Error("持久化 terminal Job 的 baseGraphRevision 超出当前图谱。");
  }
  if (
    job.resultGraphRevision !== null &&
    (graphRevision === null || job.resultGraphRevision > graphRevision)
  ) {
    throw new Error("持久化 terminal Job 的 resultGraphRevision 超出当前图谱。");
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
    actual.baseGraphRevision === expected.baseGraphRevision &&
    actual.resultGraphRevision === expected.resultGraphRevision &&
    actual.errorCode === expected.errorCode &&
    actual.errorLogId === expected.errorLogId;
}

/** queued/running Job 必须在恢复写入前满足可安全收敛的持久化合同。 */
function validateStoredActiveJob(job: ActiveJobRow | JobEvidenceRow): void {
  const hasValidBase =
    job.id.length > 0 &&
    isIndexJobKind(job.kind) &&
    (job.state === "queued" || job.state === "running") &&
    isCanonicalUtcTimestamp(job.requested_at) &&
    job.completed_at === null &&
    job.error_code === null &&
    job.error_log_id === null;
  const hasValidStage = job.state === "queued"
    ? job.started_at === null
    : job.state === "running" &&
      job.started_at !== null &&
      isCanonicalUtcTimestamp(job.started_at) &&
      Date.parse(job.requested_at) <= Date.parse(job.started_at);
  const hasValidRevision =
    (job.base_graph_revision === null || isPositiveSafeInteger(job.base_graph_revision)) &&
    ((job.kind === "initial-index" && job.base_graph_revision === null) ||
      (job.kind === "rebuild" && job.base_graph_revision !== null)) &&
    job.result_graph_revision === null;
  if (!hasValidBase || !hasValidStage || !hasValidRevision) {
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

/** 为完整 read-set 规范摘要生成 workspace 私有 meta 键。 */
function committedReadSetDigestMetaKey(workspaceKey: string): string {
  return `${COMMITTED_READ_SET_DIGEST_META_KEY_PREFIX}${workspaceKey}`;
}

/** 读取单个私有 meta 标量；缺失与空字符串均由调用方按合同处理。 */
function readMetaValue(database: Database.Database, key: string): string | null {
  const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
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
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 已提交 graph revision 从 1 开始，只接受正安全整数。 */
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** workspace 行是封闭标量集合，逐字段比较避免触发器留下另一组仍合法的值。 */
function sameWorkspaceRow(left: WorkspaceRow, right: WorkspaceRow): boolean {
  return left.builtin_rules_version === right.builtin_rules_version &&
    left.committed_at === right.committed_at &&
    left.completeness === right.completeness &&
    left.config_digest === right.config_digest &&
    left.edge_count === right.edge_count &&
    left.effective_ignore_digest === right.effective_ignore_digest &&
    left.excluded_path_count === right.excluded_path_count &&
    left.freshness === right.freshness &&
    left.graph_revision === right.graph_revision &&
    left.input_digest === right.input_digest &&
    left.indexed_file_count === right.indexed_file_count &&
    left.manifest_digest === right.manifest_digest &&
    left.node_count === right.node_count &&
    left.patch_digest === right.patch_digest;
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
    row.node_count === null ||
    row.graph_revision === null
  ) {
    throw new Error("持久化 workspace 摘要不完整。");
  }
  return {
    builtinRulesVersion: "builtin-ignore-v1",
    edgeCount: row.edge_count,
    excludedPathCount: row.excluded_path_count,
    generatedAt: row.committed_at,
    graphRevision: row.graph_revision,
    indexedFileCount: row.indexed_file_count,
    nodeCount: row.node_count,
  };
}

/** 将持久 freshness 收敛到公开允许的 current/stale。 */
function mapWorkspaceFreshness(row: WorkspaceRow): "current" | "stale" {
  if (row.freshness !== "current" && row.freshness !== "stale") {
    throw new Error("持久化 workspace freshness 不合法。");
  }
  return row.freshness;
}

/** 将持久 completeness 收敛到公开允许的 empty/partial/complete。 */
function mapWorkspaceCompleteness(
  row: WorkspaceRow | undefined,
): GraphStoreBootstrapState["completeness"] {
  if (row === undefined) {
    return "empty";
  }
  if (
    row.completeness !== "empty" &&
    row.completeness !== "partial" &&
    row.completeness !== "complete"
  ) {
    throw new Error("持久化 workspace completeness 不合法。");
  }
  return row.completeness;
}

/** 从 workspace 语义列恢复 read-set；v1 migration 的全 null 表示不可证明。 */
function mapCommittedReadSet(row: SnapshotWorkspaceRow): CommittedReadSetV1 | null {
  const values = [
    row.config_digest,
    row.effective_ignore_digest,
    row.input_digest,
    row.manifest_digest,
  ];
  if (values.every((value) => value === null)) {
    return null;
  }
  if (values.some((value) => value === null)) {
    throw new Error("持久化 committed read-set 元数据不完整。");
  }
  return {
    configDigest: row.config_digest!,
    effectiveIgnoreDigest: row.effective_ignore_digest!,
    inputDigest: row.input_digest!,
    manifestDigest: row.manifest_digest!,
  };
}

/** 新提交必须把完整 read-set 与 patch digest 精确绑定到 committed Job。 */
function validateCommittedJobEvidence(
  database: Database.Database,
  digestPort: CanonicalDigestPort | undefined,
  workspaceKey: string,
  workspace: WorkspaceRow | undefined,
  committedJob: JobRow | undefined,
  committedReadSetDigest: string | null,
): void {
  if (workspace === undefined || workspace.committed_at === null || committedJob === undefined) {
    return;
  }
  const committedReadSet = mapCommittedReadSet(workspace);
  if (committedReadSet === null) {
    if (
      committedJob.legacy_schema_version !== 1 ||
      workspace.patch_digest !== null ||
      committedJob.patch_digest !== null ||
      committedJob.read_set_json !== null ||
      committedReadSetDigest !== null
    ) {
      throw new Error("旧版 stale 提交不得伪造 patch/read-set 证据。");
    }
    const legacyFiles = (database.prepare(`
      SELECT relative_path
      FROM nodes
      WHERE workspace_key = ? AND kind = 'file'
      ORDER BY relative_path
    `).all(workspaceKey) as Array<{ relative_path: string }>).map((row) => row.relative_path);
    // v1 没有内容 read-set，但仍必须证明层级 ID、父子边和 ownership 是确定性 hierarchy。
    validatePersistedHierarchyTopology(
      database,
      workspaceKey,
      buildHierarchyGraph(workspaceKey, legacyFiles),
    );
    return;
  }
  if (
    committedJob.legacy_schema_version !== null ||
    workspace.patch_digest === null ||
    committedJob.patch_digest !== workspace.patch_digest ||
    committedJob.read_set_json === null ||
    committedReadSetDigest === null ||
    !isSha256Digest(committedReadSetDigest) ||
    !isSha256Digest(workspace.patch_digest)
  ) {
    throw new Error("持久提交与 succeeded Job 的 patch 证据不一致。");
  }
  const readSet = parsePersistedHierarchyReadSet(committedJob.read_set_json);
  if (
    readSet.manifestDigest !== committedReadSet.manifestDigest ||
    readSet.inputDigest !== committedReadSet.inputDigest ||
    readSet.configDigest !== committedReadSet.configDigest ||
    readSet.effectiveIgnoreSnapshot.effectiveDigest !== committedReadSet.effectiveIgnoreDigest
  ) {
    throw new Error("持久提交与 succeeded Job 的 read-set 证据不一致。");
  }
  if (digestPort === undefined) {
    throw new Error("完整 committed 证据恢复缺少规范 digest 实现。");
  }
  const derivedReadSetDigest = digestPort.digest(readSet);
  const committedResultRevision = committedJob.result_graph_revision;
  const logicalBasePrecedesAttempt = committedJob.base_graph_revision === null || (
    readSet.baseGraphRevision !== null &&
    committedJob.base_graph_revision <= readSet.baseGraphRevision
  );
  const attemptBaseIsConsistent = committedResultRevision !== null && (
    readSet.baseGraphRevision === null
      ? committedResultRevision === 1
      : committedResultRevision === readSet.baseGraphRevision ||
        committedResultRevision === readSet.baseGraphRevision + 1
  );
  if (
    derivedReadSetDigest !== committedReadSetDigest ||
    committedResultRevision !== workspace.graph_revision ||
    !logicalBasePrecedesAttempt ||
    !attemptBaseIsConsistent
  ) {
    throw new Error("持久提交与完整 CAS read-set 栅栏不一致。");
  }
  const expectedGraph = buildHierarchyGraph(
    workspaceKey,
    readSet.manifest.map((entry) => entry.path),
  );
  const derivedEvidence = deriveHierarchyEvidenceDigests(workspaceKey, readSet, digestPort);
  if (
    derivedEvidence.manifestDigest !== readSet.manifestDigest ||
    derivedEvidence.inputDigest !== readSet.inputDigest ||
    derivedEvidence.configDigest !== readSet.configDigest ||
    derivedEvidence.patchDigest !== workspace.patch_digest
  ) {
    throw new Error("持久提交的 read-set 或 patch digest 无法从规范语义重新派生。");
  }
  validatePersistedHierarchyTopology(database, workspaceKey, expectedGraph);
}

/** 从 succeeded Job 的完整 read-set 独立重建全部语义摘要，不依赖当前 workspace 行。 */
function deriveHierarchyEvidenceDigests(
  workspaceKey: string,
  readSet: HierarchyReadSetV1,
  digestPort: CanonicalDigestPort,
): {
  configDigest: string;
  inputDigest: string;
  manifestDigest: string;
  patchDigest: string;
} {
  const expectedGraph = buildHierarchyGraph(
    workspaceKey,
    readSet.manifest.map((entry) => entry.path),
  );
  const targetNodes = [...expectedGraph.nodes]
    .sort((left, right) => compareCanonicalGraphText(left.id, right.id));
  const targetEdges = [...expectedGraph.edges]
    .sort((left, right) => compareCanonicalGraphText(left.id, right.id));
  const manifestDigest = digestPort.digest(readSet.manifest);
  const inputDigest = digestPort.digest({ manifest: readSet.manifest });
  const configDigest = digestPort.digest({
    ignore: {
      effectiveDigest: readSet.effectiveIgnoreSnapshot.effectiveDigest,
      version: readSet.effectiveIgnoreSnapshot.version,
    },
    producer: {
      kind: HIERARCHY_PRODUCER_KIND,
      version: HIERARCHY_PRODUCER_VERSION,
    },
  });
  return {
    configDigest,
    inputDigest,
    manifestDigest,
    patchDigest: digestPort.digest({
      configDigest: readSet.configDigest,
      coverage: "complete",
      edges: targetEdges,
      inputDigest: readSet.inputDigest,
      manifestDigest: readSet.manifestDigest,
      nodes: targetNodes,
      ownershipSliceId: hierarchyOwnershipSliceId(workspaceKey),
      producerKind: HIERARCHY_PRODUCER_KIND,
      producerVersion: HIERARCHY_PRODUCER_VERSION,
    }),
  };
}

/** 用 committed Job 的规范 manifest 重建期望 hierarchy，拒绝同计数但拓扑或 ownership 被替换。 */
function validatePersistedHierarchyTopology(
  database: Database.Database,
  workspaceKey: string,
  expected: ReturnType<typeof buildHierarchyGraph>,
): void {
  const actualNodes = database.prepare(`
    SELECT id, kind, relative_path
    FROM nodes
    WHERE workspace_key = ?
    ORDER BY id
  `).all(workspaceKey) as NodeRow[];
  const actualEdges = database.prepare(`
    SELECT id, from_id, relation_type, to_id, qualifier
    FROM edges
    WHERE workspace_key = ?
    ORDER BY id
  `).all(workspaceKey) as EdgeRow[];
  const actualOwnership = database.prepare(`
    SELECT fact_id, fact_kind, owner_key
    FROM facts_ownership
    WHERE workspace_key = ?
    ORDER BY fact_kind, fact_id, owner_key
  `).all(workspaceKey) as OwnershipRow[];
  const expectedNodes = [...expected.nodes]
    .sort((left, right) => compareCanonicalGraphText(left.id, right.id))
    .map((node) => ({ id: node.id, kind: node.kind, relative_path: node.relativePath }));
  const expectedEdges = [...expected.edges]
    .sort((left, right) => compareCanonicalGraphText(left.id, right.id))
    .map((edge) => ({
      id: edge.id,
      from_id: edge.fromId,
      relation_type: edge.relationType,
      to_id: edge.toId,
      qualifier: edge.qualifier,
    }));
  const ownerKey = hierarchyOwnershipSliceId(workspaceKey);
  const expectedOwnership = [
    ...expected.edges.map((edge) => ({
      fact_id: edge.id,
      fact_kind: "edge" as const,
      owner_key: ownerKey,
    })),
    ...expected.nodes.map((node) => ({
      fact_id: node.id,
      fact_kind: "node" as const,
      owner_key: ownerKey,
    })),
  ].sort((left, right) =>
    compareCanonicalGraphText(left.fact_kind, right.fact_kind) ||
    compareCanonicalGraphText(left.fact_id, right.fact_id) ||
    compareCanonicalGraphText(left.owner_key, right.owner_key));
  if (
    JSON.stringify(actualNodes) !== JSON.stringify(expectedNodes) ||
    JSON.stringify(actualEdges) !== JSON.stringify(expectedEdges) ||
    JSON.stringify(actualOwnership) !== JSON.stringify(expectedOwnership)
  ) {
    throw new Error("持久化 hierarchy 拓扑或 ownership 与 committed read-set 不一致。");
  }
}

/** 解析私有审计 JSON，并拒绝不完整 digest、未排序 manifest 或非法 generation。 */
function parsePersistedHierarchyReadSet(serialized: string): HierarchyReadSetV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error("持久化 Job read-set JSON 无法解析。", { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.manifest) || !isRecord(value.effectiveIgnoreSnapshot)) {
    throw new Error("持久化 Job read-set 形状不完整。");
  }
  const ignore = value.effectiveIgnoreSnapshot;
  const manifest = value.manifest;
  if (
    (value.baseGraphRevision !== null && !isPositiveSafeInteger(value.baseGraphRevision)) ||
    !isNonNegativeSafeInteger(value.bootstrapGeneration) ||
    !isSha256Digest(value.configDigest) ||
    !isSha256Digest(value.inputDigest) ||
    !isSha256Digest(value.manifestDigest) ||
    typeof value.statusEpoch !== "string" ||
    value.statusEpoch.length === 0 ||
    ignore.builtinRulesVersion !== "builtin-ignore-v1" ||
    (ignore.contentHash !== null && !isSha256Digest(ignore.contentHash)) ||
    !isSha256Digest(ignore.effectiveDigest) ||
    !Array.isArray(ignore.effectiveRules) ||
    !ignore.effectiveRules.every((rule) => typeof rule === "string") ||
    !isNonNegativeSafeInteger(ignore.generation) ||
    !isSha256Digest(ignore.lastValidDigest) ||
    !Array.isArray(ignore.userRules) ||
    !ignore.userRules.every((rule) => typeof rule === "string") ||
    ignore.validity !== "valid" ||
    ignore.version !== 1
  ) {
    throw new Error("持久化 Job read-set 字段不合法。");
  }
  let previousPath: string | null = null;
  for (const entry of manifest) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      !isSha256Digest(entry.contentHash) ||
      (previousPath !== null && previousPath >= entry.path)
    ) {
      throw new Error("持久化 Job manifest 未按规范路径唯一排序。");
    }
    previousPath = entry.path;
  }
  return value as unknown as HierarchyReadSetV1;
}

/** SQLite 私有 JSON 只接受普通非空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 当前语义与证据 digest 均使用 SHA-256 小写十六进制。 */
function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** SQLite 事务内同时比较 base revision、已提交 read-set 与 patch 身份。 */
function matchesExpectedSnapshot(
  row: WorkspaceRow,
  expected: CommittedGraphSnapshotV1,
): boolean {
  return row.graph_revision === expected.graphRevision &&
    row.patch_digest === expected.patchDigest &&
    JSON.stringify(mapCommittedReadSet(row)) === JSON.stringify(expected.committedReadSet);
}

/** 当前 Job 的语义 read-set 会成为下一次 CAS 的持久基线。 */
function toCommittedReadSet(patch: GraphPatchV1): CommittedReadSetV1 {
  return {
    configDigest: patch.readSet.configDigest,
    effectiveIgnoreDigest: patch.readSet.effectiveIgnoreSnapshot.effectiveDigest,
    inputDigest: patch.readSet.inputDigest,
    manifestDigest: patch.readSet.manifestDigest,
  };
}

/** hierarchy ownership 固定复用确定性 workspace 根实体 ID。 */
function hierarchyOwnershipSliceId(workspaceKey: string): string {
  return `hierarchy:${buildGraphEntityId(workspaceKey, "workspace", "")}`;
}

/** SQLite 节点行映射为不暴露 rowid 的领域事实。 */
function mapHierarchyNode(row: NodeRow): HierarchyNode {
  return Object.freeze({ id: row.id, kind: row.kind, relativePath: row.relative_path });
}

/** SQLite 边行映射为确定性 contains 领域事实。 */
function mapHierarchyEdge(row: EdgeRow): HierarchyEdge {
  return Object.freeze({
    fromId: row.from_id,
    id: row.id,
    qualifier: row.qualifier,
    relationType: row.relation_type,
    toId: row.to_id,
  });
}

/** 将 SQLite Job 行映射为不暴露 rowid 的 application 记录。 */
function mapJob(row: JobRow): StoredIndexJob {
  return {
    baseGraphRevision: row.base_graph_revision,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_log_id === null ? {} : { errorLogId: row.error_log_id }),
    id: row.id,
    kind: row.kind,
    requestedAt: row.requested_at,
    resultGraphRevision: row.result_graph_revision,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    state: row.state,
  };
}
