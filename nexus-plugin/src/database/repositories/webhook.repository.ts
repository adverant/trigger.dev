import { DatabaseService } from '../database-service';

export interface Webhook {
  webhookId: string;
  projectId: string;
  organizationId: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  lastTriggeredAt: Date | null;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWebhookData {
  projectId: string;
  organizationId: string;
  url: string;
  secret: string;
  events: string[];
  active?: boolean;
}

export interface UpdateWebhookData {
  url?: string;
  secret?: string;
  events?: string[];
  active?: boolean;
}

export class WebhookRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async create(data: CreateWebhookData): Promise<Webhook> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.webhooks (
        project_id, organization_id, url, secret, events, active
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        data.projectId,
        data.organizationId,
        data.url,
        data.secret,
        data.events,
        data.active !== undefined ? data.active : true,
      ]
    );

    if (!row) {
      throw new Error('Failed to create webhook');
    }

    return this.mapRow(row);
  }

  async findById(webhookId: string, orgId: string): Promise<Webhook | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.webhooks WHERE webhook_id = $1 AND organization_id = $2`,
      [webhookId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findByOrgId(orgId: string): Promise<Webhook[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.webhooks
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [orgId]
    );

    return rows.map((row) => this.mapRow(row));
  }

  async update(webhookId: string, orgId: string, data: UpdateWebhookData): Promise<Webhook> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.url !== undefined) {
      setClauses.push(`url = $${paramIndex++}`);
      values.push(data.url);
    }
    if (data.secret !== undefined) {
      setClauses.push(`secret = $${paramIndex++}`);
      values.push(data.secret);
    }
    if (data.events !== undefined) {
      setClauses.push(`events = $${paramIndex++}`);
      values.push(data.events);
    }
    if (data.active !== undefined) {
      setClauses.push(`active = $${paramIndex++}`);
      values.push(data.active);
    }

    if (setClauses.length === 0) {
      const existing = await this.findById(webhookId, orgId);
      if (!existing) {
        throw new Error('Webhook not found');
      }
      return existing;
    }

    values.push(webhookId, orgId);

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.webhooks SET ${setClauses.join(', ')}
       WHERE webhook_id = $${paramIndex++} AND organization_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (!row) {
      throw new Error('Webhook not found');
    }

    return this.mapRow(row);
  }

  async delete(webhookId: string, orgId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM trigger.webhooks WHERE webhook_id = $1 AND organization_id = $2`,
      [webhookId, orgId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async incrementFailureCount(webhookId: string): Promise<void> {
    await this.db.query(
      `UPDATE trigger.webhooks SET failure_count = failure_count + 1 WHERE webhook_id = $1`,
      [webhookId]
    );
  }

  async findActiveByEvent(orgId: string, event: string): Promise<Webhook[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.webhooks
       WHERE organization_id = $1 AND active = TRUE AND $2 = ANY(events)
       ORDER BY created_at ASC`,
      [orgId, event]
    );

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): Webhook {
    return {
      webhookId: row.webhook_id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      url: row.url,
      secret: row.secret,
      events: row.events || [],
      active: row.active,
      lastTriggeredAt: row.last_triggered_at,
      failureCount: row.failure_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
