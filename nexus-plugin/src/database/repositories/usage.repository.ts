import { DatabaseService } from '../database-service';

export type MetricType =
  | 'task_trigger'
  | 'batch_trigger'
  | 'schedule_run'
  | 'waitpoint_resolution'
  | 'api_call'
  | 'ws_connection';

export interface UsageMetric {
  metricId: string;
  organizationId: string;
  metricType: MetricType;
  count: number;
  metadata: Record<string, any>;
  recordedAt: Date;
}

export interface AggregatedUsage {
  organizationId: string;
  startDate: Date;
  endDate: Date;
  totalEvents: number;
  byType: Record<MetricType, number>;
  dailyBreakdown: Array<{
    date: string;
    count: number;
  }>;
}

export class UsageRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async record(
    orgId: string,
    metricType: MetricType,
    metadata?: Record<string, any>
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO trigger.usage_metrics (organization_id, metric_type, metadata)
       VALUES ($1, $2, $3)`,
      [orgId, metricType, metadata ? JSON.stringify(metadata) : '{}']
    );
  }

  async getUsage(
    orgId: string,
    metricType: MetricType,
    startDate: Date,
    endDate: Date
  ): Promise<UsageMetric[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.usage_metrics
       WHERE organization_id = $1
         AND metric_type = $2
         AND recorded_at >= $3
         AND recorded_at <= $4
       ORDER BY recorded_at DESC`,
      [orgId, metricType, startDate, endDate]
    );

    return rows.map((row) => this.mapRow(row));
  }

  async getAggregated(
    orgId: string,
    startDate: Date,
    endDate: Date
  ): Promise<AggregatedUsage> {
    // Get totals by type
    const byTypeRows = await this.db.queryMany<any>(
      `SELECT metric_type, SUM(count) AS total
       FROM trigger.usage_metrics
       WHERE organization_id = $1
         AND recorded_at >= $2
         AND recorded_at <= $3
       GROUP BY metric_type`,
      [orgId, startDate, endDate]
    );

    const byType: Record<string, number> = {};
    let totalEvents = 0;
    for (const row of byTypeRows) {
      const count = parseInt(row.total, 10);
      byType[row.metric_type] = count;
      totalEvents += count;
    }

    // Get daily breakdown
    const dailyRows = await this.db.queryMany<any>(
      `SELECT
         DATE(recorded_at) AS date,
         SUM(count) AS count
       FROM trigger.usage_metrics
       WHERE organization_id = $1
         AND recorded_at >= $2
         AND recorded_at <= $3
       GROUP BY DATE(recorded_at)
       ORDER BY DATE(recorded_at) ASC`,
      [orgId, startDate, endDate]
    );

    const dailyBreakdown = dailyRows.map((row) => ({
      date: row.date instanceof Date
        ? row.date.toISOString().split('T')[0]
        : String(row.date),
      count: parseInt(row.count, 10),
    }));

    return {
      organizationId: orgId,
      startDate,
      endDate,
      totalEvents,
      byType: byType as Record<MetricType, number>,
      dailyBreakdown,
    };
  }

  async getCurrentMinuteCount(orgId: string, metricType: MetricType): Promise<number> {
    const row = await this.db.queryOne<any>(
      `SELECT COALESCE(SUM(count), 0) AS total
       FROM trigger.usage_metrics
       WHERE organization_id = $1
         AND metric_type = $2
         AND recorded_at >= DATE_TRUNC('minute', NOW())`,
      [orgId, metricType]
    );

    return parseInt(row?.total || '0', 10);
  }

  private mapRow(row: any): UsageMetric {
    return {
      metricId: row.metric_id,
      organizationId: row.organization_id,
      metricType: row.metric_type,
      count: row.count,
      metadata: row.metadata || {},
      recordedAt: row.recorded_at,
    };
  }
}
