import { DatabaseService } from '../database-service';

export type DeploymentStatus = 'active' | 'superseded' | 'failed' | 'deploying' | 'rolled_back';

export interface DeploymentRow {
  deploymentId: string;
  organizationId: string;
  projectId: string | null;
  version: string;
  status: DeploymentStatus;
  environment: string;
  taskCount: number;
  deployedBy: string | null;
  changelog: string | null;
  promotedAt: Date | null;
  metadata: Record<string, any>;
  deployedAt: Date;
  createdAt: Date;
}

export interface CreateDeploymentData {
  organizationId: string;
  projectId?: string;
  version: string;
  status?: DeploymentStatus;
  environment?: string;
  taskCount: number;
  deployedBy?: string;
  changelog?: string;
  metadata?: Record<string, any>;
}

export class DeploymentRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * List deployments for an organization, newest first.
   */
  async findByOrgId(orgId: string, limit = 50): Promise<DeploymentRow[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.deployments
       WHERE organization_id = $1
       ORDER BY deployed_at DESC
       LIMIT $2`,
      [orgId, limit]
    );

    return rows.map((row) => this.mapRow(row));
  }

  /**
   * Get the currently active deployment for an organization.
   */
  async findActive(orgId: string): Promise<DeploymentRow | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.deployments
       WHERE organization_id = $1 AND status = 'active'
       ORDER BY deployed_at DESC
       LIMIT 1`,
      [orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  /**
   * Get a single deployment by ID.
   */
  async findById(deploymentId: string, orgId: string): Promise<DeploymentRow | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.deployments
       WHERE deployment_id = $1 AND organization_id = $2`,
      [deploymentId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  /**
   * Create a new deployment record.
   */
  async create(data: CreateDeploymentData): Promise<DeploymentRow> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.deployments (
        organization_id, project_id, version, status, environment,
        task_count, deployed_by, changelog, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        data.organizationId,
        data.projectId || null,
        data.version,
        data.status || 'deploying',
        data.environment || 'production',
        data.taskCount,
        data.deployedBy || null,
        data.changelog || null,
        JSON.stringify(data.metadata || {}),
      ]
    );

    if (!row) {
      throw new Error('Failed to create deployment');
    }

    return this.mapRow(row);
  }

  /**
   * Promote a deployment: set it as active and supersede the current active one.
   */
  async promote(deploymentId: string, orgId: string): Promise<DeploymentRow> {
    // Use a transaction to atomically swap active status
    return this.db.transaction(async (client) => {
      // Supersede the current active deployment
      await client.query(
        `UPDATE trigger.deployments
         SET status = 'superseded'
         WHERE organization_id = $1 AND status = 'active'`,
        [orgId]
      );

      // Promote the target deployment
      const result = await client.query(
        `UPDATE trigger.deployments
         SET status = 'active', promoted_at = NOW()
         WHERE deployment_id = $1 AND organization_id = $2
         RETURNING *`,
        [deploymentId, orgId]
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error('Deployment not found');
      }

      return this.mapRow(row);
    });
  }

  /**
   * Update deployment status.
   */
  async updateStatus(deploymentId: string, status: DeploymentStatus): Promise<DeploymentRow> {
    const row = await this.db.queryOne<any>(
      `UPDATE trigger.deployments SET status = $1 WHERE deployment_id = $2 RETURNING *`,
      [status, deploymentId]
    );

    if (!row) {
      throw new Error('Deployment not found');
    }

    return this.mapRow(row);
  }

  private mapRow(row: any): DeploymentRow {
    return {
      deploymentId: row.deployment_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      version: row.version,
      status: row.status,
      environment: row.environment,
      taskCount: parseInt(row.task_count, 10),
      deployedBy: row.deployed_by,
      changelog: row.changelog,
      promotedAt: row.promoted_at,
      metadata: row.metadata || {},
      deployedAt: row.deployed_at,
      createdAt: row.created_at,
    };
  }
}
