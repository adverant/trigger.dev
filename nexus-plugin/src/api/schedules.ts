import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { ScheduleService } from '../services/schedule.service';
import { ProjectRepository } from '../database/repositories/project.repository';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-schedules' });

/**
 * Transform backend Schedule to the format the UI expects.
 */
function toUISchedule(schedule: any): Record<string, any> {
  return {
    id: schedule.scheduleId,
    taskId: schedule.taskIdentifier,
    cron: schedule.cronExpression || '',
    timezone: schedule.timezone || 'UTC',
    enabled: schedule.enabled,
    payload: schedule.payload,
    lastRunId: null,
    lastRunAt: schedule.lastRunAt
      ? (schedule.lastRunAt.toISOString?.() ?? String(schedule.lastRunAt))
      : null,
    nextRunAt: schedule.nextRunAt
      ? (schedule.nextRunAt.toISOString?.() ?? String(schedule.nextRunAt))
      : null,
    health: schedule.enabled
      ? (schedule.lastStatus === 'FAILED' ? 'unhealthy' : 'healthy')
      : 'unknown',
    createdAt: schedule.createdAt
      ? (schedule.createdAt.toISOString?.() ?? String(schedule.createdAt))
      : new Date().toISOString(),
    updatedAt: schedule.updatedAt
      ? (schedule.updatedAt.toISOString?.() ?? String(schedule.updatedAt))
      : new Date().toISOString(),
  };
}

const createScheduleSchema = Joi.object({
  projectId: Joi.string().uuid().optional(),
  task: Joi.string().optional(),
  taskId: Joi.string().optional(),
  cron: Joi.string().required(),
  externalId: Joi.string().optional(),
  deduplicationKey: Joi.string().optional(),
  timezone: Joi.string().optional().default('UTC'),
  description: Joi.string().optional(),
  payload: Joi.object().optional(),
  environments: Joi.array().items(Joi.string()).optional(),
}).or('task', 'taskId');

const updateScheduleSchema = Joi.object({
  cron: Joi.string().optional(),
  externalId: Joi.string().optional(),
  description: Joi.string().allow('').optional(),
  timezone: Joi.string().optional(),
  payload: Joi.object().optional(),
}).min(1);

export function createScheduleRouter(
  scheduleService: ScheduleService,
  io: SocketIOServer,
  projectRepo?: ProjectRepository
): Router {
  const router = Router();

  // POST / - Create schedule
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = createScheduleSchema.validate(req.body, { abortEarly: false });
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

      // Auto-resolve projectId if not provided
      let projectId = value.projectId;
      if (!projectId && projectRepo) {
        const projects = await projectRepo.findByOrgId(req.user!.organizationId);
        if (projects.length > 0) {
          projectId = projects[0].projectId;
        }
      }
      if (!projectId) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'No project found for this organization' },
        });
        return;
      }

      const schedule = await scheduleService.createSchedule(
        req.user!.organizationId,
        req.user!.userId,
        projectId,
        {
          task: value.task || value.taskId,
          cron: value.cron,
          externalId: value.externalId,
          deduplicationKey: value.deduplicationKey,
          timezone: value.timezone,
          description: value.description,
          payload: value.payload,
          environments: value.environments,
        }
      );

      res.status(201).json({
        success: true,
        data: schedule,
      });
    })
  );

  // GET / - List schedules
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const projectId = (req.query.projectId as string) || undefined;

      const schedules = await scheduleService.listSchedules(
        req.user!.organizationId,
        projectId
      );

      res.json({
        success: true,
        data: schedules.map(toUISchedule),
      });
    })
  );

  // GET /timezones - Get supported timezones
  router.get(
    '/timezones',
    asyncHandler(async (req: Request, res: Response) => {
      // Return IANA timezone list from Intl API
      const timezones = Intl.supportedValuesOf('timeZone');

      res.json({
        success: true,
        data: timezones,
      });
    })
  );

  // GET /next-executions - Get next execution times for a cron expression
  router.get(
    '/next-executions',
    asyncHandler(async (req: Request, res: Response) => {
      const cron = req.query.cron as string;
      const timezone = (req.query.timezone as string) || 'UTC';
      const count = parseInt((req.query.count as string) || '5', 10);

      if (!cron) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'cron query parameter is required' },
        });
        return;
      }

      const executions = scheduleService.getNextExecutions(cron, timezone, count);

      res.json({
        success: true,
        data: executions.map((d) => d.toISOString()),
      });
    })
  );

  // GET /:scheduleId - Get schedule (must be defined after /timezones and /next-executions)
  router.get(
    '/:scheduleId',
    asyncHandler(async (req: Request, res: Response) => {
      // We fetch from the local repo
      const schedules = await scheduleService.listSchedules(
        req.user!.organizationId,
        '' // all projects
      );

      const schedule = schedules.find((s) => s.scheduleId === req.params.scheduleId);
      if (!schedule) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Schedule not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: schedule,
      });
    })
  );

  // PUT /:scheduleId - Update schedule
  router.put(
    '/:scheduleId',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = updateScheduleSchema.validate(req.body, { abortEarly: false });
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

      const schedule = await scheduleService.updateSchedule(
        req.user!.organizationId,
        req.params.scheduleId,
        value
      );

      res.json({
        success: true,
        data: schedule,
      });
    })
  );

  // DELETE /:scheduleId - Delete schedule
  router.delete(
    '/:scheduleId',
    asyncHandler(async (req: Request, res: Response) => {
      await scheduleService.deleteSchedule(
        req.user!.organizationId,
        req.params.scheduleId
      );

      res.json({
        success: true,
        data: { deleted: true },
      });
    })
  );

  // POST /:scheduleId/activate - Activate schedule
  router.post(
    '/:scheduleId/activate',
    asyncHandler(async (req: Request, res: Response) => {
      const schedule = await scheduleService.toggleSchedule(
        req.user!.organizationId,
        req.params.scheduleId,
        true
      );

      res.json({
        success: true,
        data: schedule,
      });
    })
  );

  // POST /:scheduleId/deactivate - Deactivate schedule
  router.post(
    '/:scheduleId/deactivate',
    asyncHandler(async (req: Request, res: Response) => {
      const schedule = await scheduleService.toggleSchedule(
        req.user!.organizationId,
        req.params.scheduleId,
        false
      );

      res.json({
        success: true,
        data: schedule,
      });
    })
  );

  return router;
}
