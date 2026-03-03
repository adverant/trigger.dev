import { DatabaseService } from '../database-service';

export type ServiceName =
  | 'graphrag'
  | 'mageagent'
  | 'fileprocess'
  | 'learningagent'
  | 'geoagent'
  | 'jupyter'
  | 'cvat'
  | 'gpu-bridge'
  | 'sandbox'
  | 'n8n'
  | 'skills-engine';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface IntegrationConfig {
  configId: string;
  organizationId: string;
  serviceName: ServiceName;
  enabled: boolean;
  serviceUrl: string | null;
  config: Record<string, any>;
  lastHealthCheck: Date | null;
  healthStatus: HealthStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertIntegrationConfigData {
  enabled?: boolean;
  serviceUrl?: string;
  config?: Record<string, any>;
}

export class IntegrationConfigRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async upsert(
    orgId: string,
    serviceName: ServiceName,
    data: UpsertIntegrationConfigData
  ): Promise<IntegrationConfig> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.integration_configs (
        organization_id, service_name, enabled, service_url, config
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (organization_id, service_name)
      DO UPDATE SET
        enabled = COALESCE($3, trigger.integration_configs.enabled),
        service_url = COALESCE($4, trigger.integration_configs.service_url),
        config = COALESCE($5, trigger.integration_configs.config)
      RETURNING *`,
      [
        orgId,
        serviceName,
        data.enabled !== undefined ? data.enabled : false,
        data.serviceUrl || null,
        data.config ? JSON.stringify(data.config) : '{}',
      ]
    );

    if (!row) {
      throw new Error('Failed to upsert integration config');
    }

    return this.mapRow(row);
  }

  async findByOrgId(orgId: string): Promise<IntegrationConfig[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.integration_configs
       WHERE organization_id = $1
       ORDER BY service_name ASC`,
      [orgId]
    );

    return rows.map((row) => this.mapRow(row));
  }

  async findByService(orgId: string, serviceName: ServiceName): Promise<IntegrationConfig | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.integration_configs
       WHERE organization_id = $1 AND service_name = $2`,
      [orgId, serviceName]
    );

    return row ? this.mapRow(row) : null;
  }

  async updateHealthStatus(
    orgId: string,
    serviceName: ServiceName,
    status: HealthStatus,
    checkTime: Date
  ): Promise<void> {
    await this.db.query(
      `UPDATE trigger.integration_configs
       SET health_status = $1, last_health_check = $2
       WHERE organization_id = $3 AND service_name = $4`,
      [status, checkTime, orgId, serviceName]
    );
  }

  /**
   * Update health status for a service across ALL organizations.
   * Used by the background health worker.
   */
  async updateHealthStatusAll(
    serviceName: ServiceName,
    status: HealthStatus,
    checkTime: Date
  ): Promise<void> {
    await this.db.query(
      `UPDATE trigger.integration_configs
       SET health_status = $1, last_health_check = $2
       WHERE service_name = $3`,
      [status, checkTime, serviceName]
    );
  }

  async getEnabled(orgId: string): Promise<IntegrationConfig[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.integration_configs
       WHERE organization_id = $1 AND enabled = TRUE
       ORDER BY service_name ASC`,
      [orgId]
    );

    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: any): IntegrationConfig {
    return {
      configId: row.config_id,
      organizationId: row.organization_id,
      serviceName: row.service_name,
      enabled: row.enabled,
      serviceUrl: row.service_url,
      config: row.config || {},
      lastHealthCheck: row.last_health_check,
      healthStatus: row.health_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
