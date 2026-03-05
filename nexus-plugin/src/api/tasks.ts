import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { TaskService } from '../services/task.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-tasks' });

/**
 * Transform backend TaskDefinition to the format the UI expects.
 */
function toUITask(task: any): Record<string, any> {
  return {
    id: task.taskDefId || task.id,
    slug: task.taskIdentifier || task.slug,
    filePath: task.filePath || '',
    exportName: task.exportName || task.taskIdentifier || '',
    version: task.taskVersion || task.version || '1',
    queue: task.queueName || task.queue || 'default',
    machinePreset: task.machinePreset,
    triggerSource: task.isNexusIntegration ? 'nexus' : 'trigger',
    retry: task.retryConfig
      ? {
          maxAttempts: task.retryConfig.maxAttempts,
          minTimeout: task.retryConfig.minTimeoutInMs ?? task.retryConfig.minTimeout,
          maxTimeout: task.retryConfig.maxTimeoutInMs ?? task.retryConfig.maxTimeout,
          factor: task.retryConfig.factor,
        }
      : undefined,
    schema: task.inputSchema || undefined,
    description: task.description || undefined,
    nexusIntegration: task.nexusService || undefined,
    lastRunStatus: task.lastRunStatus || undefined,
    lastRunAt: task.lastRunAt ? (task.lastRunAt.toISOString?.() ?? String(task.lastRunAt)) : undefined,
    createdAt: task.createdAt ? (task.createdAt.toISOString?.() ?? String(task.createdAt)) : new Date().toISOString(),
    updatedAt: task.updatedAt ? (task.updatedAt.toISOString?.() ?? String(task.updatedAt)) : new Date().toISOString(),
  };
}

const triggerTaskSchema = Joi.object({
  projectId: Joi.string().uuid().required(),
  payload: Joi.any().required(),
  options: Joi.object({
    idempotencyKey: Joi.string().optional(),
    delay: Joi.string().optional(),
    ttl: Joi.string().optional(),
    tags: Joi.array().items(Joi.string()).optional(),
    metadata: Joi.object().optional(),
    queue: Joi.object({
      name: Joi.string().required(),
      concurrencyKey: Joi.string().optional(),
    }).optional(),
  }).optional(),
});

const batchTriggerSchema = Joi.object({
  projectId: Joi.string().uuid().required(),
  items: Joi.array()
    .items(
      Joi.object({
        taskIdentifier: Joi.string().required(),
        payload: Joi.any().required(),
        options: Joi.object({
          idempotencyKey: Joi.string().optional(),
          delay: Joi.string().optional(),
          ttl: Joi.string().optional(),
          tags: Joi.array().items(Joi.string()).optional(),
          metadata: Joi.object().optional(),
          queue: Joi.object({
            name: Joi.string().required(),
            concurrencyKey: Joi.string().optional(),
          }).optional(),
        }).optional(),
      })
    )
    .min(1)
    .required(),
});

export function createTaskRouter(
  taskService: TaskService,
  io: SocketIOServer
): Router {
  const router = Router();

  // GET / - List task definitions (from local cache)
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = req.query.projectId as string | undefined;

      const tasks = await taskService.listTaskDefinitions(
        req.user!.organizationId,
        projectId || undefined
      );

      res.json({
        success: true,
        data: tasks.map(toUITask),
      });
    })
  );

  // POST /sync - Sync task definitions from Trigger.dev
  router.post(
    '/sync',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = req.body.projectId || (req.query.projectId as string);
      if (!projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'projectId is required' },
        });
        return;
      }

      const synced = await taskService.syncTaskDefinitions(
        req.user!.organizationId,
        projectId
      );

      res.json({
        success: true,
        data: {
          synced: synced.length,
          tasks: synced,
        },
      });
    })
  );

  // GET /:taskId - Get a single task definition
  router.get(
    '/:taskId',
    asyncHandler(async (req: Request, res: Response) => {
      const task = await taskService.getTaskById(
        req.user!.organizationId,
        req.params.taskId
      );

      if (!task) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Task not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: toUITask(task),
      });
    })
  );

  // POST /:taskId/trigger - Trigger a task
  router.post(
    '/:taskId/trigger',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = triggerTaskSchema.validate(req.body, { abortEarly: false });
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

      const result = await taskService.triggerTask(
        req.user!.organizationId,
        req.user!.userId,
        value.projectId,
        req.params.taskId,
        value.payload,
        value.options
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    })
  );

  // POST /batch - Batch trigger tasks
  router.post(
    '/batch',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = batchTriggerSchema.validate(req.body, { abortEarly: false });
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

      const result = await taskService.batchTrigger(
        req.user!.organizationId,
        value.projectId,
        value.items
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    })
  );

  return router;
}
