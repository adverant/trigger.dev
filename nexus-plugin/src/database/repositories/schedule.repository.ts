import { DatabaseService } from '../database-service';

export interface Schedule {
  scheduleId: string;
  triggerScheduleId: string | null;
  projectId: string;
  organizationId: string;
  userId: string;
  taskIdentifier: string;
  cronExpression: string;
  timezone: string;
  description: string | null;
  enabled: boolean;
  payload: Record<string, any> | null;
  externalId: string | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  nextRunAt: Date | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateScheduleData {
  triggerScheduleId?: string;
  projectId: string;
  organizationId: string;
  userId: string;
  taskIdentifier: string;
  cronExpression: string;
  timezone?: string;
  description?: string;
  enabled?: boolean;
  payload?: Record<string, any>;
  externalId?: string;
  nextRunAt?: Date;
}

export interface UpdateScheduleData {
  triggerScheduleId?: string;
  cronExpression?: string;
  timezone?: string;
  description?: string;
  enabled?: boolean;
  payload?: Record<string, any>;
  externalId?: string;
  lastRunAt?: Date;
  lastStatus?: string;
  nextRunAt?: Date;
}

export interface ScheduleFilters {
  taskIdentifier?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export class ScheduleRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async create(data: CreateScheduleData): Promise<Schedule> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.schedule_configs (
        trigger_schedule_id, project_id, organization_id, user_id,
        task_identifier, cron_expression, timezone, description,
        enabled, payload, external_id, next_run_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        data.triggerScheduleId || null,
        data.projectId,
        data.organizationId,
        data.userId,
        data.taskIdentifier,
        data.cronExpression,
        data.timezone || 'UTC',
        data.description || null,
        data.enabled !== undefined ? data.enabled : true,
        data.payload ? JSON.stringify(data.payload) : null,
        data.externalId || null,
        data.nextRunAt || null,
      ]
    );

    if (!row) {
      throw new Error('Failed to create schedule');
    }

    return this.mapRow(row);
  }

  async findById(scheduleId: string, orgId: string): Promise<Schedule | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.schedule_configs WHERE schedule_id = $1 AND organization_id = $2`,
      [scheduleId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findByOrgId(orgId: string, filters: ScheduleFilters = {}): Promise<Schedule[]> {
    const conditions: string[] = ['organization_id = $1'];
    const values: any[] = [orgId];
    let paramIndex = 2;

    if (filters.taskIdentifier) {
      conditions.push(`task_identifier = $${paramIndex++}`);
      values.push(filters.taskIdentifier);
    }

    if (filters.enabled !== undefined) {
      conditions.push(`enabled = $${paramIndex++}`);
      values.push(filters.enabled);
    }

    const limit = filters.limit || 100;
    const offset = filters.offset || 0;
    values.push(limit, offset);

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.schedule_configs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      values
    );

    return rows.map((row) => this.mapRow(row));
  }

  async update(scheduleId: string, orgId: string, data: UpdateScheduleData): Promise<Schedule> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.triggerScheduleId !== undefined) {
      setClauses.push(`trigger_schedule_id = $${paramIndex++}`);
      values.push(data.triggerScheduleId);
    }
    if (data.cronExpression !== undefined) {
      setClauses.push(`cron_expression = $${paramIndex++}`);
      values.push(data.cronExpression);
    }
    if (data.timezone !== undefined) {
      setClauses.push(`timezone = $${paramIndex++}`);
      values.push(data.timezone);
    }
    if (data.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(data.description);
    }
    if (data.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      values.push(data.enabled);
    }
    if (data.payload !== undefined) {
      setClauses.push(`payload = $${paramIndex++}`);
      values.push(JSON.stringify(data.payload));
    }
    if (data.externalId !== undefined) {
      setClauses.push(`external_id = $${paramIndex++}`);
      values.push(data.externalId);
    }
    if (data.lastRunAt !== undefined) {
      setClauses.push(`last_run_at = $${paramIndex++}`);
      values.push(data.lastRunAt);
    }
    if (data.lastStatus !== undefined) {
      setClauses.push(`last_status = $${paramIndex++}`);
      values.push(data.lastStatus);
    }
    if (data.nextRunAt !== undefined) {
      setClauses.push(`next_run_at = $${paramIndex++}`);
      values.push(data.nextRunAt);
    }

    if (setClauses.length === 0) {
      const existing = await this.findById(scheduleId, orgId);
      if (!existing) {
        throw new Error('Schedule not found');
      }
      return existing;
    }

    values.push(scheduleId, orgId);

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.schedule_configs SET ${setClauses.join(', ')}
       WHERE schedule_id = $${paramIndex++} AND organization_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (!row) {
      throw new Error('Schedule not found');
    }

    return this.mapRow(row);
  }

  async delete(scheduleId: string, orgId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM trigger.schedule_configs WHERE schedule_id = $1 AND organization_id = $2`,
      [scheduleId, orgId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async incrementRunCount(scheduleId: string, success: boolean): Promise<void> {
    if (success) {
      await this.db.query(
        `UPDATE trigger.schedule_configs
         SET run_count = run_count + 1,
             success_count = success_count + 1,
             last_run_at = NOW(),
             last_status = 'COMPLETED'
         WHERE schedule_id = $1`,
        [scheduleId]
      );
    } else {
      await this.db.query(
        `UPDATE trigger.schedule_configs
         SET run_count = run_count + 1,
             failure_count = failure_count + 1,
             last_run_at = NOW(),
             last_status = 'FAILED'
         WHERE schedule_id = $1`,
        [scheduleId]
      );
    }
  }

  async findEnabled(): Promise<Schedule[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.schedule_configs WHERE enabled = TRUE ORDER BY next_run_at ASC NULLS LAST`
    );

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): Schedule {
    return {
      scheduleId: row.schedule_id,
      triggerScheduleId: row.trigger_schedule_id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      taskIdentifier: row.task_identifier,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
      description: row.description,
      enabled: row.enabled,
      payload: row.payload,
      externalId: row.external_id,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      nextRunAt: row.next_run_at,
      runCount: row.run_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
