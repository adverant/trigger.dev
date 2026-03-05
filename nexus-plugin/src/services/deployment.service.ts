import { TriggerProxyService } from './trigger-proxy.service';
import { DatabaseService } from '../database/database.service';
import { DeploymentRepository, DeploymentRow } from '../database/repositories/deployment.repository';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'deployment-service' });

export interface Deployment {
  id: string;
  version: string;
  status: string;
  taskCount: number;
  deployedAt: string;
  deployedBy?: string;
  promotedAt?: string;
  environment?: string;
  changelog?: string;
}

export class DeploymentService {
  private repo: DeploymentRepository;

  constructor(
    private proxy: TriggerProxyService,
    private db: DatabaseService
  ) {
    this.repo = new DeploymentRepository(db);
  }

  /**
   * Get the latest (active) deployment for an organization.
   */
  async getLatestDeployment(orgId: string, projectId?: string): Promise<Deployment | null> {
    const row = await this.repo.findActive(orgId);

    if (row) {
      logger.debug('Fetched latest deployment from database', {
        orgId,
        projectId,
        deploymentId: row.deploymentId,
        version: row.version,
      });
      return this.toApiDeployment(row);
    }

    // Fallback: try Trigger.dev API if no local record exists
    logger.debug('No local deployment found, falling back to Trigger.dev API', { orgId });
    const triggerResult = await this.proxy.getLatestDeployment().catch(() => null);
    return triggerResult;
  }

  /**
   * List all deployments for an organization, newest first.
   */
  async listDeployments(orgId: string, projectId?: string): Promise<Deployment[]> {
    const rows = await this.repo.findByOrgId(orgId);

    if (rows.length > 0) {
      logger.debug('Listed deployments from database', {
        orgId,
        projectId,
        count: rows.length,
      });
      return rows.map((row) => this.toApiDeployment(row));
    }

    // Fallback: try Trigger.dev API if no local records exist
    logger.debug('No local deployments, falling back to Trigger.dev API', { orgId });
    const triggerLatest = await this.proxy.getLatestDeployment().catch(() => null);

    if (triggerLatest) {
      return [
        {
          ...triggerLatest,
          source: 'trigger-dev',
          isLatest: true,
        } as any,
      ];
    }

    return [];
  }

  /**
   * Promote a deployment to active status (supersedes the current active one).
   */
  async promoteDeployment(deploymentId: string, orgId: string): Promise<Deployment> {
    const promoted = await this.repo.promote(deploymentId, orgId);

    logger.info('Deployment promoted', {
      orgId,
      deploymentId,
      version: promoted.version,
    });

    return this.toApiDeployment(promoted);
  }

  /**
   * Get a single deployment by ID.
   */
  async getDeployment(deploymentId: string, orgId: string): Promise<Deployment | null> {
    const row = await this.repo.findById(deploymentId, orgId);
    return row ? this.toApiDeployment(row) : null;
  }

  /**
   * Cancel an in-progress deployment.
   */
  async cancelDeployment(deploymentId: string, orgId: string): Promise<Deployment> {
    const row = await this.repo.findById(deploymentId, orgId);
    if (!row) {
      throw new Error('Deployment not found');
    }
    if (row.status !== 'deploying') {
      throw new Error(`Cannot cancel deployment with status '${row.status}'`);
    }

    // Update status to canceled
    await this.db.query(
      `UPDATE trigger.deployments SET status = 'canceled', updated_at = NOW()
       WHERE deployment_id = $1 AND organization_id = $2`,
      [deploymentId, orgId]
    );

    logger.info('Deployment canceled', { deploymentId, orgId });

    return this.toApiDeployment({ ...row, status: 'canceled' });
  }

  /**
   * Map a database row to the API-facing Deployment shape.
   */
  private toApiDeployment(row: DeploymentRow): Deployment {
    return {
      id: row.deploymentId,
      version: row.version,
      status: row.status,
      taskCount: row.taskCount,
      deployedAt: row.deployedAt.toISOString(),
      deployedBy: row.deployedBy || undefined,
      promotedAt: row.promotedAt ? row.promotedAt.toISOString() : undefined,
      environment: row.environment,
      changelog: row.changelog || undefined,
    };
  }
}
