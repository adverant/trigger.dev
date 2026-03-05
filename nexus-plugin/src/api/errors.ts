import { Router, Request, Response } from 'express';
import { ErrorRepository } from '../database/repositories/error.repository';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-errors' });

export function createErrorRouter(errorRepo: ErrorRepository): Router {
  const router = Router();

  // GET / - Get grouped errors
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const taskIdentifier = req.query.taskIdentifier as string | undefined;
      const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = await errorRepo.getGroupedErrors(orgId, {
        taskIdentifier,
        hours,
        limit,
        offset,
      });

      res.json({
        success: true,
        data: result.groups,
        meta: { total: result.total },
      });
    })
  );

  // GET /timeline - Get error timeline (hourly counts)
  router.get(
    '/timeline',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const hours = req.query.hours ? parseInt(req.query.hours as string, 10) : undefined;

      const timeline = await errorRepo.getErrorTimeline(orgId, hours);

      res.json({
        success: true,
        data: timeline,
      });
    })
  );

  // GET /:fingerprint - Get individual runs for an error fingerprint
  router.get(
    '/:fingerprint',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { fingerprint } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = await errorRepo.getErrorRuns(orgId, fingerprint, limit, offset);

      res.json({
        success: true,
        data: result.rows,
        meta: { total: result.total },
      });
    })
  );

  return router;
}
