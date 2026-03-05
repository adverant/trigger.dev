import { Router, Request, Response } from 'express';
import { LogRepository } from '../database/repositories/log.repository';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-logs' });

export function createLogRouter(logRepo: LogRepository): Router {
  const router = Router();

  // GET / - Search logs with filters
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;

      const filters: Record<string, any> = {};
      if (req.query.level) filters.level = req.query.level;
      if (req.query.taskIdentifier) filters.taskIdentifier = req.query.taskIdentifier;
      if (req.query.runId) filters.runId = req.query.runId;
      if (req.query.search) filters.search = req.query.search;
      if (req.query.from) filters.from = new Date(req.query.from as string);
      if (req.query.to) filters.to = new Date(req.query.to as string);
      if (req.query.limit) filters.limit = parseInt(req.query.limit as string, 10);
      if (req.query.offset) filters.offset = parseInt(req.query.offset as string, 10);

      const result = await logRepo.search(orgId, filters);

      res.json({
        success: true,
        data: result.logs,
        meta: { total: result.total },
      });
    })
  );

  return router;
}
