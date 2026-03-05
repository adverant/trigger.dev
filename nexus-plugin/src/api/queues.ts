import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { QueueService } from '../services/queue.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-queues' });

export function createQueueRouter(
  queueService: QueueService,
  io: SocketIOServer
): Router {
  const router = Router();

  // GET / - List queues
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = (req.query.projectId as string) || 'default';

      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const perPage = req.query.perPage ? parseInt(req.query.perPage as string, 10) : undefined;

      try {
        const result = await queueService.listQueues(
          req.user!.organizationId,
          projectId,
          { page, perPage }
        );

        res.json({
          success: true,
          data: result,
        });
      } catch (err) {
        logger.warn('listQueues proxy failed, returning empty list', { error: (err as Error).message });
        res.json({ success: true, data: [] });
      }
    })
  );

  // POST /:queueId/pause - Pause queue
  router.post(
    '/:queueId/pause',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await queueService.pauseQueue(
          req.user!.organizationId,
          req.params.queueId
        );

        res.json({
          success: true,
          data: result,
        });
      } catch (err) {
        logger.warn('pauseQueue proxy failed', { error: (err as Error).message });
        res.status(503).json({ success: false, error: { code: 'PROXY_UNAVAILABLE', message: 'Trigger.dev proxy not configured' } });
      }
    })
  );

  // POST /:queueId/resume - Resume queue
  router.post(
    '/:queueId/resume',
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const result = await queueService.resumeQueue(
          req.user!.organizationId,
          req.params.queueId
        );

        res.json({
          success: true,
          data: result,
        });
      } catch (err) {
        logger.warn('resumeQueue proxy failed', { error: (err as Error).message });
        res.status(503).json({ success: false, error: { code: 'PROXY_UNAVAILABLE', message: 'Trigger.dev proxy not configured' } });
      }
    })
  );

  return router;
}
