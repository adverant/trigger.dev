import { DatabaseService } from '../database-service';

export type RunStatus =
  | 'QUEUED'
  | 'EXECUTING'
  | 'REATTEMPTING'
  | 'FROZEN'
  | 'COMPLETED'
  | 'CANCELED'
  | 'FAILED'
  | 'CRASHED'
  | 'INTERRUPTED'
  | 'SYSTEM_FAILURE'
  | 'EXPIRED'
  | 'DELAYED'
  | 'WAITING_FOR_DEPLOY'
  | 'TIMED_OUT'
  | 'PENDING';

export interface Run {
  runId: string;
  triggerRunId: string;
  projectId: string;
  organizationId: string;
  taskIdentifier: string;
  status: RunStatus;
  payload: Record<string, any> | null;
  output: Record<string, any> | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  idempotencyKey: string | null;
  metadata: Record<string, any>;
  tags: string[];
  isTest: boolean;
  graphragStored: boolean;
  createdAt: Date;
}

export interface CreateRunData {
  triggerRunId: string;
  projectId: string;
  organizationId: string;
  taskIdentifier: string;
  status: RunStatus;
  payload?: Record<string, any>;
  output?: Record<string, any>;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
  tags?: string[];
  isTest?: boolean;
}

export interface RunFilters {
  status?: RunStatus;
  taskIdentifier?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  startDate?: Date;
  endDate?: Date;
}

export interface RunStats {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  successRatePct: number;
}

export interface PaginatedRuns {
  runs: Run[];
  total: number;
}

export class RunRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async create(data: CreateRunData): Promise<Run> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.run_history (
        trigger_run_id, project_id, organization_id, task_identifier,
        status, payload, output, error_message, started_at, completed_at,
        duration_ms, idempotency_key, metadata, tags, is_test
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        data.triggerRunId,
        data.projectId,
        data.organizationId,
        data.taskIdentifier,
        data.status,
        data.payload ? JSON.stringify(data.payload) : null,
        data.output ? JSON.stringify(data.output) : null,
        data.errorMessage || null,
        data.startedAt || null,
        data.completedAt || null,
        data.durationMs || null,
        data.idempotencyKey || null,
        JSON.stringify(data.metadata || {}),
        data.tags || [],
        data.isTest || false,
      ]
    );

    if (!row) {
      throw new Error('Failed to create run');
    }

    return this.mapRow(row);
  }

  async findById(runId: string, orgId: string): Promise<Run | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.run_history WHERE run_id = $1 AND organization_id = $2`,
      [runId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findByTriggerRunId(triggerRunId: string, orgId: string): Promise<Run | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.run_history WHERE trigger_run_id = $1 AND organization_id = $2`,
      [triggerRunId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findByOrgId(orgId: string, filters: RunFilters = {}): Promise<PaginatedRuns> {
    const conditions: string[] = ['organization_id = $1'];
    const values: any[] = [orgId];
    let paramIndex = 2;

    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(filters.status);
    }

    if (filters.taskIdentifier) {
      conditions.push(`task_identifier = $${paramIndex++}`);
      values.push(filters.taskIdentifier);
    }

    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${paramIndex++}`);
      values.push(filters.tags);
    }

    if (filters.startDate) {
      conditions.push(`created_at >= $${paramIndex++}`);
      values.push(filters.startDate);
    }

    if (filters.endDate) {
      conditions.push(`created_at <= $${paramIndex++}`);
      values.push(filters.endDate);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countResult = await this.db.queryOne<any>(
      `SELECT COUNT(*) AS total FROM trigger.run_history ${whereClause}`,
      values
    );
    const total = parseInt(countResult?.total || '0', 10);

    // Get paginated results
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    values.push(limit, offset);

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.run_history ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      values
    );

    return {
      runs: rows.map((row) => this.mapRow(row)),
      total,
    };
  }

  async updateStatus(
    runId: string,
    status: RunStatus,
    output?: Record<string, any>,
    errorMessage?: string
  ): Promise<Run> {
    const setClauses: string[] = ['status = $1'];
    const values: any[] = [status];
    let paramIndex = 2;

    if (output !== undefined) {
      setClauses.push(`output = $${paramIndex++}`);
      values.push(JSON.stringify(output));
    }

    if (errorMessage !== undefined) {
      setClauses.push(`error_message = $${paramIndex++}`);
      values.push(errorMessage);
    }

    const terminalStatuses: RunStatus[] = [
      'COMPLETED', 'CANCELED', 'FAILED', 'CRASHED',
      'INTERRUPTED', 'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT',
    ];

    if (terminalStatuses.includes(status)) {
      setClauses.push(`completed_at = NOW()`);
      setClauses.push(`duration_ms = EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))) * 1000`);
    }

    if (status === 'EXECUTING') {
      setClauses.push(`started_at = COALESCE(started_at, NOW())`);
    }

    values.push(runId);

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.run_history SET ${setClauses.join(', ')}
       WHERE run_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (!row) {
      throw new Error('Run not found');
    }

    return this.mapRow(row);
  }

  /**
   * Merge additional key-value pairs into the run's metadata JSONB column.
   */
  async mergeMetadata(runId: string, extra: Record<string, any>): Promise<void> {
    await this.db.query(
      `UPDATE trigger.run_history SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE run_id = $2`,
      [JSON.stringify(extra), runId]
    );
  }

  async updateTags(runId: string, tags: string[]): Promise<Run> {
    const row = await this.db.queryOne<any>(
      `UPDATE trigger.run_history SET tags = $1 WHERE run_id = $2 RETURNING *`,
      [tags, runId]
    );
    if (!row) throw new Error('Run not found');
    return this.mapRow(row);
  }

  /**
   * Find Skills Engine runs stuck in EXECUTING for longer than the given threshold.
   * Used on startup to recover orphaned runs after pod restarts.
   */
  async findOrphanedSkillsEngineRuns(staleMinutes: number = 5): Promise<Run[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.run_history
       WHERE status = 'EXECUTING'
         AND task_identifier LIKE 'skills-engine-%'
         AND created_at < NOW() - INTERVAL '1 minute' * $1
       ORDER BY created_at ASC`,
      [staleMinutes]
    );

    return rows.map((row) => this.mapRow(row));
  }

  async markGraphRAGStored(runId: string): Promise<void> {
    await this.db.query(
      `UPDATE trigger.run_history SET graphrag_stored = TRUE WHERE run_id = $1`,
      [runId]
    );
  }

  async getStatistics(orgId: string): Promise<RunStats> {
    const row = await this.db.queryOne<any>(
      `SELECT
         COUNT(*) AS total_runs,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed_runs,
         COUNT(*) FILTER (WHERE status = 'FAILED') AS failed_runs,
         ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 2) AS avg_duration_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)
           FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms,
         CASE
           WHEN COUNT(*) = 0 THEN 0
           ELSE ROUND(
             COUNT(*) FILTER (WHERE status = 'COMPLETED')::NUMERIC / COUNT(*) * 100, 2
           )
         END AS success_rate_pct
       FROM trigger.run_history
       WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`,
      [orgId]
    );

    return {
      totalRuns: parseInt(row?.total_runs || '0', 10),
      completedRuns: parseInt(row?.completed_runs || '0', 10),
      failedRuns: parseInt(row?.failed_runs || '0', 10),
      avgDurationMs: row?.avg_duration_ms ? parseFloat(row.avg_duration_ms) : null,
      p95DurationMs: row?.p95_duration_ms ? parseFloat(row.p95_duration_ms) : null,
      successRatePct: parseFloat(row?.success_rate_pct || '0'),
    };
  }

  async getRunsByHour(orgId: string): Promise<Array<{ hour: string; count: number; failed: number }>> {
    const rows = await this.db.queryMany<any>(
      `WITH hours AS (
         SELECT generate_series(
           DATE_TRUNC('hour', NOW() - INTERVAL '23 hours'),
           DATE_TRUNC('hour', NOW()),
           '1 hour'
         ) AS hour_bucket
       )
       SELECT
         TO_CHAR(h.hour_bucket, 'HH24:00') AS hour,
         COALESCE(COUNT(r.run_id), 0)::int AS count,
         COALESCE(COUNT(r.run_id) FILTER (WHERE r.status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT')), 0)::int AS failed
       FROM hours h
       LEFT JOIN trigger.run_history r
         ON r.organization_id = $1
         AND r.created_at >= h.hour_bucket
         AND r.created_at < h.hour_bucket + INTERVAL '1 hour'
       GROUP BY h.hour_bucket
       ORDER BY h.hour_bucket ASC`,
      [orgId]
    );

    return rows.map((row) => ({
      hour: row.hour,
      count: parseInt(row.count || '0', 10),
      failed: parseInt(row.failed || '0', 10),
    }));
  }

  async getTaskHealth(orgId: string): Promise<Array<{ taskIdentifier: string; total: number; completed: number; failed: number; avgDurationMs: number | null }>> {
    const rows = await this.db.queryMany<any>(
      `SELECT
         task_identifier,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
         COUNT(*) FILTER (WHERE status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT')) AS failed,
         ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 2) AS avg_duration_ms
       FROM trigger.run_history
       WHERE organization_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY task_identifier
       ORDER BY COUNT(*) DESC
       LIMIT 20`,
      [orgId]
    );

    return rows.map((row) => ({
      taskIdentifier: row.task_identifier,
      total: parseInt(row.total || '0', 10),
      completed: parseInt(row.completed || '0', 10),
      failed: parseInt(row.failed || '0', 10),
      avgDurationMs: row.avg_duration_ms ? parseFloat(row.avg_duration_ms) : null,
    }));
  }

  private mapRow(row: any): Run {
    return {
      runId: row.run_id,
      triggerRunId: row.trigger_run_id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      taskIdentifier: row.task_identifier,
      status: row.status,
      payload: row.payload,
      output: row.output,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      idempotencyKey: row.idempotency_key,
      metadata: row.metadata || {},
      tags: row.tags || [],
      isTest: row.is_test,
      graphragStored: row.graphrag_stored,
      createdAt: row.created_at,
    };
  }
}
