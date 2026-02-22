import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { RunService } from '../services/run.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-runs' });

const listRunsSchema = Joi.object({
  projectId: Joi.string().uuid().optional(),
  status: Joi.alternatives()
    .try(Joi.string(), Joi.array().items(Joi.string()))
    .optional(),
  taskIdentifier: Joi.string().optional(),
  taskId: Joi.string().optional(),
  tags: Joi.alternatives()
    .try(Joi.string(), Joi.array().items(Joi.string()))
    .optional(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
  from: Joi.date().iso().optional(),
  to: Joi.date().iso().optional(),
  limit: Joi.number().integer().min(1).max(200).optional(),
  offset: Joi.number().integer().min(0).optional(),
});

const rescheduleSchema = Joi.object({
  delay: Joi.string().required(),
});

export function createRunRouter(
  runService: RunService,
  io: SocketIOServer
): Router {
  const router = Router();

  // GET / - List runs with filters
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = listRunsSchema.validate(req.query, { abortEarly: false });
      if (error) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: error.details.map((d) => d.message),
          },
        });
        return;
      }

      // Normalize status and tags to arrays
      let statusFilter: string[] | undefined;
      if (value.status) {
        statusFilter = Array.isArray(value.status) ? value.status : [value.status];
      }

      let tagsFilter: string[] | undefined;
      if (value.tags) {
        tagsFilter = Array.isArray(value.tags) ? value.tags : [value.tags];
      }

      const result = await runService.listRuns(
        req.user!.organizationId,
        value.projectId || undefined,
        {
          status: statusFilter ? statusFilter[0] as any : undefined,
          taskIdentifier: value.taskIdentifier || value.taskId,
          tags: tagsFilter,
          startDate: value.startDate || value.from,
          endDate: value.endDate || value.to,
          limit: value.limit,
          offset: value.offset,
        }
      );

      res.json({
        success: true,
        data: result.runs,
        pagination: {
          total: result.total,
          limit: value.limit || 50,
          offset: value.offset || 0,
        },
      });
    })
  );

  // GET /statistics - Get run statistics
  router.get(
    '/statistics',
    asyncHandler(async (req: Request, res: Response) => {
      const stats = await runService.getStatistics(req.user!.organizationId);

      res.json({
        success: true,
        data: stats,
      });
    })
  );

  // GET /:runId - Get run details
  router.get(
    '/:runId',
    asyncHandler(async (req: Request, res: Response) => {
      const run = await runService.getRun(
        req.user!.organizationId,
        req.params.runId
      );

      res.json({
        success: true,
        data: run,
      });
    })
  );

  // POST /:runId/cancel - Cancel run
  router.post(
    '/:runId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      const result = await runService.cancelRun(
        req.user!.organizationId,
        req.params.runId
      );

      res.json({
        success: true,
        data: result,
      });
    })
  );

  // POST /:runId/replay - Replay run
  router.post(
    '/:runId/replay',
    asyncHandler(async (req: Request, res: Response) => {
      const result = await runService.replayRun(
        req.user!.organizationId,
        req.params.runId
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    })
  );

  // POST /:runId/reschedule - Reschedule run
  router.post(
    '/:runId/reschedule',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = rescheduleSchema.validate(req.body, { abortEarly: false });
      if (error) {
        res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request body',
            details: error.details.map((d) => d.message),
          },
        });
        return;
      }

      const result = await runService.rescheduleRun(
        req.user!.organizationId,
        req.params.runId,
        value.delay
      );

      res.json({
        success: true,
        data: result,
      });
    })
  );

  return router;
}
