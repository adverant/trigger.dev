import { DatabaseService } from '../database-service';

export interface AlertRuleRow {
  alertRuleId: string;
  organizationId: string;
  name: string;
  eventType: string;
  condition: Record<string, any>;
  channel: 'webhook' | 'email';
  target: string;
  enabled: boolean;
  lastFiredAt: Date | null;
  fireCount: number;
  cooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export class AlertRuleRepository {
  constructor(private db: DatabaseService) {}

  async findByOrgId(orgId: string): Promise<AlertRuleRow[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.alert_rules WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );
    return rows.map((r) => this.mapRow(r));
  }

  async findEnabledByEvent(orgId: string, eventType: string): Promise<AlertRuleRow[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.alert_rules
       WHERE organization_id = $1 AND event_type = $2 AND enabled = TRUE`,
      [orgId, eventType]
    );
    return rows.map((r) => this.mapRow(r));
  }

  async create(orgId: string, data: {
    name: string;
    eventType: string;
    condition?: Record<string, any>;
    channel: 'webhook' | 'email';
    target: string;
    cooldownMinutes?: number;
  }): Promise<AlertRuleRow> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.alert_rules (organization_id, name, event_type, condition, channel, target, cooldown_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [orgId, data.name, data.eventType, JSON.stringify(data.condition || {}), data.channel, data.target, data.cooldownMinutes || 5]
    );
    return this.mapRow(row!);
  }

  async update(ruleId: string, orgId: string, data: Partial<{
    name: string;
    eventType: string;
    condition: Record<string, any>;
    channel: string;
    target: string;
    enabled: boolean;
    cooldownMinutes: number;
  }>): Promise<AlertRuleRow> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let paramIdx = 1;

    if (data.name !== undefined) { setClauses.push(`name = $${paramIdx++}`); values.push(data.name); }
    if (data.eventType !== undefined) { setClauses.push(`event_type = $${paramIdx++}`); values.push(data.eventType); }
    if (data.condition !== undefined) { setClauses.push(`condition = $${paramIdx++}`); values.push(JSON.stringify(data.condition)); }
    if (data.channel !== undefined) { setClauses.push(`channel = $${paramIdx++}`); values.push(data.channel); }
    if (data.target !== undefined) { setClauses.push(`target = $${paramIdx++}`); values.push(data.target); }
    if (data.enabled !== undefined) { setClauses.push(`enabled = $${paramIdx++}`); values.push(data.enabled); }
    if (data.cooldownMinutes !== undefined) { setClauses.push(`cooldown_minutes = $${paramIdx++}`); values.push(data.cooldownMinutes); }

    values.push(ruleId, orgId);

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.alert_rules SET ${setClauses.join(', ')}
       WHERE alert_rule_id = $${paramIdx++} AND organization_id = $${paramIdx}
       RETURNING *`,
      values
    );

    if (!row) throw new Error('Alert rule not found');
    return this.mapRow(row);
  }

  async delete(ruleId: string, orgId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM trigger.alert_rules WHERE alert_rule_id = $1 AND organization_id = $2`,
      [ruleId, orgId]
    );
  }

  async recordFired(ruleId: string): Promise<void> {
    await this.db.query(
      `UPDATE trigger.alert_rules SET last_fired_at = NOW(), fire_count = fire_count + 1 WHERE alert_rule_id = $1`,
      [ruleId]
    );
  }

  private mapRow(row: any): AlertRuleRow {
    return {
      alertRuleId: row.alert_rule_id,
      organizationId: row.organization_id,
      name: row.name,
      eventType: row.event_type,
      condition: row.condition || {},
      channel: row.channel,
      target: row.target,
      enabled: row.enabled,
      lastFiredAt: row.last_fired_at,
      fireCount: parseInt(row.fire_count || '0', 10),
      cooldownMinutes: parseInt(row.cooldown_minutes || '5', 10),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
