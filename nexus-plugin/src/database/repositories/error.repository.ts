import { DatabaseService } from '../database-service';

export interface ErrorGroup {
  fingerprint: string;
  message: string;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  taskIdentifier: string;
  statuses: string[];
}

export interface ErrorTimelineEntry {
  hour: string;
  count: number;
}

const ERROR_STATUSES = `('FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT')`;

export class ErrorRepository {
  constructor(private db: DatabaseService) {}

  async getGroupedErrors(
    orgId: string,
    filters: { taskIdentifier?: string; hours?: number; limit?: number; offset?: number } = {}
  ): Promise<{ groups: ErrorGroup[]; total: number }> {
    const hours = filters.hours || 24;
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    const conditions: string[] = [
      'organization_id = $1',
      `status IN ${ERROR_STATUSES}`,
      `created_at >= NOW() - INTERVAL '1 hour' * $2`,
    ];
    const values: any[] = [orgId, hours];
    let paramIdx = 3;

    if (filters.taskIdentifier) {
      conditions.push(`task_identifier = $${paramIdx++}`);
      values.push(filters.taskIdentifier);
    }

    const where = conditions.join(' AND ');

    const countRow = await this.db.queryOne<any>(
      `SELECT COUNT(DISTINCT md5(COALESCE(error_message, ''))) AS total
       FROM trigger.run_history WHERE ${where}`,
      values
    );
    const total = parseInt(countRow?.total || '0', 10);

    values.push(limit, offset);
    const rows = await this.db.queryMany<any>(
      `SELECT
         md5(COALESCE(error_message, '')) AS fingerprint,
         LEFT(COALESCE(error_message, 'Unknown error'), 200) AS message,
         COUNT(*) AS count,
         MIN(created_at) AS first_seen,
         MAX(created_at) AS last_seen,
         MODE() WITHIN GROUP (ORDER BY task_identifier) AS task_identifier,
         ARRAY_AGG(DISTINCT status) AS statuses
       FROM trigger.run_history
       WHERE ${where}
       GROUP BY md5(COALESCE(error_message, '')), LEFT(COALESCE(error_message, 'Unknown error'), 200)
       ORDER BY MAX(created_at) DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      values
    );

    return {
      groups: rows.map((row) => ({
        fingerprint: row.fingerprint,
        message: row.message,
        count: parseInt(row.count, 10),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        taskIdentifier: row.task_identifier,
        statuses: row.statuses || [],
      })),
      total,
    };
  }

  async getErrorRuns(
    orgId: string,
    fingerprint: string,
    limit: number = 25,
    offset: number = 0
  ): Promise<{ rows: any[]; total: number }> {
    const countRow = await this.db.queryOne<any>(
      `SELECT COUNT(*) AS total FROM trigger.run_history
       WHERE organization_id = $1
         AND status IN ${ERROR_STATUSES}
         AND md5(COALESCE(error_message, '')) = $2`,
      [orgId, fingerprint]
    );

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.run_history
       WHERE organization_id = $1
         AND status IN ${ERROR_STATUSES}
         AND md5(COALESCE(error_message, '')) = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [orgId, fingerprint, limit, offset]
    );

    return {
      rows,
      total: parseInt(countRow?.total || '0', 10),
    };
  }

  async getErrorTimeline(orgId: string, hours: number = 24): Promise<ErrorTimelineEntry[]> {
    const rows = await this.db.queryMany<any>(
      `WITH hours AS (
         SELECT generate_series(
           DATE_TRUNC('hour', NOW() - INTERVAL '1 hour' * ($2 - 1)),
           DATE_TRUNC('hour', NOW()),
           '1 hour'
         ) AS hour_bucket
       )
       SELECT
         TO_CHAR(h.hour_bucket, 'HH24:00') AS hour,
         COALESCE(COUNT(r.run_id), 0)::int AS count
       FROM hours h
       LEFT JOIN trigger.run_history r
         ON r.organization_id = $1
         AND r.status IN ${ERROR_STATUSES}
         AND r.created_at >= h.hour_bucket
         AND r.created_at < h.hour_bucket + INTERVAL '1 hour'
       GROUP BY h.hour_bucket
       ORDER BY h.hour_bucket ASC`,
      [orgId, hours]
    );

    return rows.map((row) => ({
      hour: row.hour,
      count: parseInt(row.count || '0', 10),
    }));
  }
}
