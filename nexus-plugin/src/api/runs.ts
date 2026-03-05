import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { RunService } from '../services/run.service';
import { Run } from '../database/repositories/run.repository';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-runs' });

/**
 * Transform backend Run to the format the UI expects.
 */
function toUIRun(run: Run): Record<string, any> {
  return {
    id: run.runId,
    taskId: run.taskIdentifier,
    taskSlug: run.taskIdentifier,
    status: run.status,
    payload: run.payload,
    output: run.output,
    error: run.errorMessage,
    startedAt: run.startedAt ? run.startedAt.toISOString?.() ?? String(run.startedAt) : null,
    completedAt: run.completedAt ? run.completedAt.toISOString?.() ?? String(run.completedAt) : null,
    duration: run.durationMs,
    tags: run.tags || [],
    createdAt: run.createdAt ? run.createdAt.toISOString?.() ?? String(run.createdAt) : new Date().toISOString(),
    updatedAt: run.createdAt ? run.createdAt.toISOString?.() ?? String(run.createdAt) : new Date().toISOString(),
    isTest: run.isTest || false,
    idempotencyKey: run.idempotencyKey,
    version: undefined,
  };
}

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
        data: result.runs.map(toUIRun),
        meta: {
          total: result.total,
          limit: value.limit || 50,
          offset: value.offset || 0,
        },
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

      // Normalize to UI format (same shape as list endpoint)
      const uiRun = toUIRun(run as Run);
      // Merge any extra fields from Trigger.dev proxy
      if (run.triggerData) {
        uiRun.triggerData = run.triggerData;
      }

      res.json({
        success: true,
        data: uiRun,
      });
    })
  );

  // GET /:runId/logs - Get run log entries
  router.get(
    '/:runId/logs',
    asyncHandler(async (req: Request, res: Response) => {
      const run = await runService.getRun(
        req.user!.organizationId,
        req.params.runId
      );

      // Synthesize log entries from the run's lifecycle events
      const logs: Array<{ level: string; message: string; timestamp: string; data?: any }> = [];

      if (run.createdAt) {
        logs.push({
          level: 'info',
          message: `Run created for task ${run.taskIdentifier}`,
          timestamp: typeof run.createdAt === 'string' ? run.createdAt : run.createdAt.toISOString?.() ?? String(run.createdAt),
        });
      }

      if (run.startedAt) {
        logs.push({
          level: 'info',
          message: 'Execution started',
          timestamp: typeof run.startedAt === 'string' ? run.startedAt : run.startedAt.toISOString?.() ?? String(run.startedAt),
        });
      }

      if (run.completedAt) {
        const isError = ['FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT'].includes(run.status);
        logs.push({
          level: isError ? 'error' : 'info',
          message: `Run ${run.status.toLowerCase()}${run.errorMessage ? `: ${run.errorMessage}` : ''}`,
          timestamp: typeof run.completedAt === 'string' ? run.completedAt : run.completedAt.toISOString?.() ?? String(run.completedAt),
        });
      }

      res.json({
        success: true,
        data: logs,
      });
    })
  );

  // GET /:runId/trace - Get run trace/span data
  router.get(
    '/:runId/trace',
    asyncHandler(async (req: Request, res: Response) => {
      const run = await runService.getRun(
        req.user!.organizationId,
        req.params.runId
      );

      // Synthesize a basic trace from the run's lifecycle
      const spans: any[] = [];

      if (run.startedAt && run.completedAt) {
        const startMs = new Date(run.startedAt).getTime();
        const endMs = new Date(run.completedAt).getTime();
        spans.push({
          spanId: run.runId,
          operationName: run.taskIdentifier,
          startTime: typeof run.startedAt === 'string' ? run.startedAt : run.startedAt.toISOString?.() ?? String(run.startedAt),
          endTime: typeof run.completedAt === 'string' ? run.completedAt : run.completedAt.toISOString?.() ?? String(run.completedAt),
          durationMs: endMs - startMs,
          status: run.status,
        });
      }

      res.json({
        success: true,
        data: { spans },
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

  // PATCH /:runId/tags - Update run tags
  router.patch(
    '/:runId/tags',
    asyncHandler(async (req: Request, res: Response) => {
      const { tags } = req.body;
      if (!Array.isArray(tags)) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'tags[] is required' },
        });
        return;
      }

      const run = await runService.updateRunTags(
        req.user!.organizationId,
        req.params.runId,
        tags
      );

      res.json({
        success: true,
        data: toUIRun(run as Run),
      });
    })
  );

  // POST /bulk/cancel - Bulk cancel runs
  router.post(
    '/bulk/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { runIds, filters } = req.body;

      if (!runIds && !filters) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'runIds[] or filters required' },
        });
        return;
      }

      const result = await runService.bulkCancel(orgId, runIds, filters);

      logger.info('Bulk cancel completed', { orgId, ...result });

      res.json({
        success: true,
        data: result,
      });
    })
  );

  // POST /bulk/replay - Bulk replay runs
  router.post(
    '/bulk/replay',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { runIds, filters } = req.body;

      if (!runIds && !filters) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'runIds[] or filters required' },
        });
        return;
      }

      const result = await runService.bulkReplay(orgId, runIds, filters);

      logger.info('Bulk replay completed', { orgId, ...result });

      res.json({
        success: true,
        data: result,
      });
    })
  );

  return router;
}
