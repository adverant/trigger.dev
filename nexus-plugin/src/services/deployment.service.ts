import { TriggerProxyService } from './trigger-proxy.service';
import { DatabaseService } from '../database/database.service';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'deployment-service' });

export interface Deployment {
  deploymentId: string;
  triggerDeploymentId: string;
  projectId: string;
  organizationId: string;
  version: string;
  status: string;
  environment: string;
  taskCount: number;
  deployedAt: Date;
  metadata: Record<string, any>;
}

export class DeploymentService {
  constructor(
    private proxy: TriggerProxyService,
    private db: DatabaseService
  ) {}

  async getLatestDeployment(orgId: string, projectId: string): Promise<any> {
    const triggerResult = await this.proxy.getLatestDeployment();

    logger.debug('Fetched latest deployment from Trigger.dev', {
      orgId,
      projectId,
      deploymentId: triggerResult?.id,
    });

    return triggerResult;
  }

  async listDeployments(
    orgId: string,
    projectId: string
  ): Promise<any[]> {
    // Deployments are tracked from Trigger.dev webhook events or polling.
    // For now, we return the latest deployment from the API and any locally tracked ones.
    const triggerLatest = await this.proxy.getLatestDeployment().catch(() => null);

    const results: any[] = [];
    if (triggerLatest) {
      results.push({
        ...triggerLatest,
        source: 'trigger-dev',
        isLatest: true,
      });
    }

    logger.debug('Listed deployments', {
      orgId,
      projectId,
      count: results.length,
    });

    return results;
  }
}
