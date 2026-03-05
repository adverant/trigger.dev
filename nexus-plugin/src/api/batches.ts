import { Router, Request, Response } from 'express';
import { BatchRepository } from '../database/repositories/batch.repository';
import { RunService } from '../services/run.service';
import { TaskService } from '../services/task.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-batches' });

export function createBatchRouter(
  batchRepo: BatchRepository,
  taskService: TaskService,
  runService: RunService
): Router {
  const router = Router();

  // POST /trigger - Trigger a batch of tasks
  router.post(
    '/trigger',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const userId = req.user!.userId || 'system';
      const { items, name } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'items[] is required and must not be empty' },
        });
        return;
      }

      if (items.length > 500) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Maximum 500 items per batch' },
        });
        return;
      }

      // Create batch record
      const batch = await batchRepo.create(orgId, name);

      // Trigger all tasks and link runs to batch
      const results: { taskIdentifier: string; runId?: string; error?: string }[] = [];

      for (const item of items) {
        try {
          // Get first project for this org
          const run = await taskService.triggerTask(
            orgId,
            userId,
            undefined as any, // projectId - service will resolve
            item.taskIdentifier,
            item.payload || {}
          );
          if (run?.runId) {
            await batchRepo.linkRun(run.runId, batch.batchId);
          }
          results.push({ taskIdentifier: item.taskIdentifier, runId: run?.runId });
        } catch (err: any) {
          results.push({ taskIdentifier: item.taskIdentifier, error: err.message });
        }
      }

      // Update batch counts
      const updatedBatch = await batchRepo.updateCounts(batch.batchId);

      logger.info('Batch triggered', {
        batchId: batch.batchId,
        orgId,
        total: items.length,
        succeeded: results.filter(r => !r.error).length,
        failed: results.filter(r => r.error).length,
      });

      res.status(201).json({
        success: true,
        data: {
          ...updatedBatch,
          results,
        },
      });
    })
  );

  // GET / - List batches
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

      const result = await batchRepo.findByOrgId(orgId, limit, offset);

      res.json({
        success: true,
        data: result.batches,
        meta: { total: result.total },
      });
    })
  );

  // GET /:batchId - Get batch detail
  router.get(
    '/:batchId',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { batchId } = req.params;

      const batch = await batchRepo.findById(batchId, orgId);
      if (!batch) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Batch not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: batch,
      });
    })
  );

  return router;
}
