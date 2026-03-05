import { DatabaseService } from '../database-service';

export interface RunLog {
  logId: string;
  runId: string;
  organizationId: string;
  taskIdentifier: string;
  level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  data: Record<string, any> | null;
  timestamp: Date;
}

export interface CreateLogData {
  runId: string;
  organizationId: string;
  taskIdentifier?: string;
  level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  data?: Record<string, any>;
  timestamp?: Date;
}

export interface LogFilters {
  level?: string;
  taskIdentifier?: string;
  runId?: string;
  search?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export class LogRepository {
  constructor(private db: DatabaseService) {}

  async create(data: CreateLogData): Promise<RunLog> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.run_logs (run_id, organization_id, task_identifier, level, message, data, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.runId,
        data.organizationId,
        data.taskIdentifier || null,
        data.level,
        data.message,
        data.data ? JSON.stringify(data.data) : null,
        data.timestamp || new Date(),
      ]
    );
    return this.mapRow(row!);
  }

  async createMany(entries: CreateLogData[]): Promise<void> {
    if (entries.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const entry of entries) {
      placeholders.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
      );
      values.push(
        entry.runId,
        entry.organizationId,
        entry.taskIdentifier || null,
        entry.level,
        entry.message,
        entry.data ? JSON.stringify(entry.data) : null,
        entry.timestamp || new Date()
      );
    }

    await this.db.query(
      `INSERT INTO trigger.run_logs (run_id, organization_id, task_identifier, level, message, data, timestamp)
       VALUES ${placeholders.join(', ')}`,
      values
    );
  }

  async findByRunId(runId: string, orgId: string): Promise<RunLog[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.run_logs
       WHERE run_id = $1 AND organization_id = $2
       ORDER BY timestamp ASC`,
      [runId, orgId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  async search(orgId: string, filters: LogFilters = {}): Promise<{ logs: RunLog[]; total: number }> {
    const conditions: string[] = ['organization_id = $1'];
    const values: any[] = [orgId];
    let paramIdx = 2;

    if (filters.level) {
      conditions.push(`level = $${paramIdx++}`);
      values.push(filters.level);
    }
    if (filters.taskIdentifier) {
      conditions.push(`task_identifier = $${paramIdx++}`);
      values.push(filters.taskIdentifier);
    }
    if (filters.runId) {
      conditions.push(`run_id = $${paramIdx++}`);
      values.push(filters.runId);
    }
    if (filters.search) {
      conditions.push(`to_tsvector('english', message) @@ plainto_tsquery('english', $${paramIdx++})`);
      values.push(filters.search);
    }
    if (filters.from) {
      conditions.push(`timestamp >= $${paramIdx++}`);
      values.push(filters.from);
    }
    if (filters.to) {
      conditions.push(`timestamp <= $${paramIdx++}`);
      values.push(filters.to);
    }

    const where = conditions.join(' AND ');

    const countRow = await this.db.queryOne<any>(
      `SELECT COUNT(*) AS total FROM trigger.run_logs WHERE ${where}`,
      values
    );
    const total = parseInt(countRow?.total || '0', 10);

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    values.push(limit, offset);

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.run_logs
       WHERE ${where}
       ORDER BY timestamp DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      values
    );

    return {
      logs: rows.map((row) => this.mapRow(row)),
      total,
    };
  }

  private mapRow(row: any): RunLog {
    return {
      logId: row.log_id,
      runId: row.run_id,
      organizationId: row.organization_id,
      taskIdentifier: row.task_identifier,
      level: row.level,
      message: row.message,
      data: row.data,
      timestamp: row.timestamp,
    };
  }
}
