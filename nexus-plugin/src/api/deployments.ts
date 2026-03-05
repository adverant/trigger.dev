import { Router, Request, Response } from 'express';
import { DeploymentService } from '../services/deployment.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-deployments' });

export function createDeploymentRouter(
  deploymentService: DeploymentService
): Router {
  const router = Router();

  // GET / - List deployments (projectId optional — defaults to all for the org)
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = (req.query.projectId as string) || undefined;

      const deployments = await deploymentService.listDeployments(
        req.user!.organizationId,
        projectId
      );

      res.json({
        success: true,
        data: deployments,
      });
    })
  );

  // GET /latest - Get latest deployment
  router.get(
    '/latest',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = (req.query.projectId as string) || undefined;

      const deployment = await deploymentService.getLatestDeployment(
        req.user!.organizationId,
        projectId
      );

      res.json({
        success: true,
        data: deployment,
      });
    })
  );

  // POST /:deploymentId/promote - Promote a deployment to active
  router.post(
    '/:deploymentId/promote',
    asyncHandler(async (req: Request, res: Response) => {
      const { deploymentId } = req.params;

      const promoted = await deploymentService.promoteDeployment(
        deploymentId,
        req.user!.organizationId
      );

      logger.info('Deployment promoted via API', {
        deploymentId,
        orgId: req.user!.organizationId,
        version: promoted.version,
      });

      res.json({
        success: true,
        data: promoted,
      });
    })
  );

  return router;
}
