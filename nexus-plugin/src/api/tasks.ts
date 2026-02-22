import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { TaskService } from '../services/task.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-tasks' });

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
      const projectId = req.query.projectId as string;
      if (!projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'projectId query parameter is required' },
        });
        return;
      }

      const tasks = await taskService.listTaskDefinitions(
        req.user!.organizationId,
        projectId
      );

      res.json({
        success: true,
        data: tasks,
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
