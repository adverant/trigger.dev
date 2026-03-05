import { DatabaseService } from '../database-service';

export interface BatchRow {
  batchId: string;
  organizationId: string;
  name: string | null;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  status: string;
  metadata: Record<string, any>;
  createdAt: Date;
  completedAt: Date | null;
}

export class BatchRepository {
  constructor(private db: DatabaseService) {}

  async create(orgId: string, name?: string): Promise<BatchRow> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.batches (organization_id, name)
       VALUES ($1, $2) RETURNING *`,
      [orgId, name || null]
    );
    return this.mapRow(row!);
  }

  async findById(batchId: string, orgId: string): Promise<BatchRow | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.batches WHERE batch_id = $1 AND organization_id = $2`,
      [batchId, orgId]
    );
    return row ? this.mapRow(row) : null;
  }

  async findByOrgId(orgId: string, limit: number = 25, offset: number = 0): Promise<{ batches: BatchRow[]; total: number }> {
    const countRow = await this.db.queryOne<any>(
      `SELECT COUNT(*) AS total FROM trigger.batches WHERE organization_id = $1`,
      [orgId]
    );
    const total = parseInt(countRow?.total || '0', 10);

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.batches WHERE organization_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [orgId, limit, offset]
    );

    return { batches: rows.map((r) => this.mapRow(r)), total };
  }

  async updateCounts(batchId: string): Promise<BatchRow> {
    const row = await this.db.queryOne<any>(
      `UPDATE trigger.batches b SET
         total_runs = (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id),
         completed_runs = (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status = 'COMPLETED'),
         failed_runs = (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT')),
         status = CASE
           WHEN (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status NOT IN ('COMPLETED', 'FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'CANCELED', 'EXPIRED')) > 0 THEN 'running'
           WHEN (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT')) > 0
             AND (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status = 'COMPLETED') > 0 THEN 'partial_failure'
           WHEN (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status IN ('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT')) = (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id) THEN 'failed'
           ELSE 'completed'
         END,
         completed_at = CASE
           WHEN (SELECT COUNT(*) FROM trigger.run_history WHERE batch_id = b.batch_id AND status NOT IN ('COMPLETED', 'FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'CANCELED', 'EXPIRED')) = 0 THEN NOW()
           ELSE NULL
         END
       WHERE batch_id = $1 RETURNING *`,
      [batchId]
    );
    return this.mapRow(row!);
  }

  async linkRun(runId: string, batchId: string): Promise<void> {
    await this.db.query(
      `UPDATE trigger.run_history SET batch_id = $1 WHERE run_id = $2`,
      [batchId, runId]
    );
  }

  private mapRow(row: any): BatchRow {
    return {
      batchId: row.batch_id,
      organizationId: row.organization_id,
      name: row.name,
      totalRuns: parseInt(row.total_runs || '0', 10),
      completedRuns: parseInt(row.completed_runs || '0', 10),
      failedRuns: parseInt(row.failed_runs || '0', 10),
      status: row.status,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
