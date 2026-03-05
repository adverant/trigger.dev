import { Server as SocketIOServer } from 'socket.io';
import { ScheduleRepository, Schedule, CreateScheduleData, UpdateScheduleData } from '../database/repositories/schedule.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { getNextCronRuns } from '../utils/cron-next-run';
import { createLogger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import type { ScheduleExecutorService } from './schedule-executor.service';

const logger = createLogger({ component: 'schedule-service' });

const CRON_REGEX = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/;

export class ScheduleService {
  private executor: ScheduleExecutorService | null = null;

  constructor(
    private scheduleRepo: ScheduleRepository,
    private usageRepo: UsageRepository,
    private io: SocketIOServer
  ) {}

  setExecutor(executor: ScheduleExecutorService): void {
    this.executor = executor;
  }

  async createSchedule(
    orgId: string,
    userId: string,
    projectId: string,
    data: {
      task: string;
      cron: string;
      externalId?: string;
      deduplicationKey?: string;
      timezone?: string;
      description?: string;
      payload?: Record<string, any>;
      environments?: string[];
    }
  ): Promise<Schedule> {
    if (!CRON_REGEX.test(data.cron)) {
      throw new ValidationError(`Invalid cron expression: ${data.cron}`);
    }

    // Calculate next run time using shared timezone-aware utility
    const nextRuns = getNextCronRuns(data.cron, data.timezone || 'UTC', 1);
    const nextRunAt = nextRuns.length > 0 ? nextRuns[0] : undefined;

    // Store in database (no cloud proxy needed)
    const schedule = await this.scheduleRepo.create({
      triggerScheduleId: null,
      projectId,
      organizationId: orgId,
      userId,
      taskIdentifier: data.task,
      cronExpression: data.cron,
      timezone: data.timezone || 'UTC',
      description: data.description,
      payload: data.payload,
      externalId: data.externalId,
      nextRunAt,
    });

    // Register with in-process cron executor
    if (this.executor) {
      this.executor.addSchedule(schedule);
    }

    await this.usageRepo.record(orgId, 'schedule_run', {
      action: 'create',
      scheduleId: schedule.scheduleId,
      taskIdentifier: data.task,
    });

    emitToOrg(this.io, orgId, WS_EVENTS.SCHEDULE_CREATED, {
      scheduleId: schedule.scheduleId,
      taskIdentifier: data.task,
      cronExpression: data.cron,
      timezone: data.timezone || 'UTC',
    });

    logger.info('Schedule created', {
      scheduleId: schedule.scheduleId,
      orgId,
      taskIdentifier: data.task,
      cron: data.cron,
    });

    return schedule;
  }

  async listSchedules(orgId: string, projectId?: string): Promise<Schedule[]> {
    return this.scheduleRepo.findByOrgId(orgId, {
      projectId: projectId || undefined,
    });
  }

  async updateSchedule(
    orgId: string,
    scheduleId: string,
    data: {
      cron?: string;
      externalId?: string;
      description?: string;
      timezone?: string;
      payload?: Record<string, any>;
    }
  ): Promise<Schedule> {
    const existing = await this.scheduleRepo.findById(scheduleId, orgId);
    if (!existing) {
      throw new NotFoundError('Schedule', scheduleId);
    }

    if (data.cron && !CRON_REGEX.test(data.cron)) {
      throw new ValidationError(`Invalid cron expression: ${data.cron}`);
    }

    // Update locally
    const updateData: UpdateScheduleData = {};
    if (data.cron) updateData.cronExpression = data.cron;
    if (data.externalId) updateData.externalId = data.externalId;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.timezone) updateData.timezone = data.timezone;
    if (data.payload !== undefined) updateData.payload = data.payload;

    // Recalculate next run if cron or timezone changed
    if (data.cron || data.timezone) {
      const cronExpr = data.cron || existing.cronExpression;
      const tz = data.timezone || existing.timezone;
      const nextRuns = getNextCronRuns(cronExpr, tz, 1);
      if (nextRuns.length > 0) {
        updateData.nextRunAt = nextRuns[0];
      }
    }

    const updated = await this.scheduleRepo.update(scheduleId, orgId, updateData);

    // Update in-process cron executor
    if (this.executor) {
      this.executor.updateSchedule(updated);
    }

    emitToOrg(this.io, orgId, WS_EVENTS.SCHEDULE_UPDATED, {
      scheduleId,
      taskIdentifier: updated.taskIdentifier,
      cronExpression: updated.cronExpression,
      timezone: updated.timezone,
    });

    logger.info('Schedule updated', { scheduleId, orgId });

    return updated;
  }

  async deleteSchedule(orgId: string, scheduleId: string): Promise<void> {
    const existing = await this.scheduleRepo.findById(scheduleId, orgId);
    if (!existing) {
      throw new NotFoundError('Schedule', scheduleId);
    }

    // Remove from in-process cron executor
    if (this.executor) {
      this.executor.removeSchedule(scheduleId);
    }

    // Delete from database
    await this.scheduleRepo.delete(scheduleId, orgId);

    emitToOrg(this.io, orgId, WS_EVENTS.SCHEDULE_DELETED, {
      scheduleId,
      taskIdentifier: existing.taskIdentifier,
    });

    logger.info('Schedule deleted', { scheduleId, orgId });
  }

  async toggleSchedule(
    orgId: string,
    scheduleId: string,
    enabled: boolean
  ): Promise<Schedule> {
    const existing = await this.scheduleRepo.findById(scheduleId, orgId);
    if (!existing) {
      throw new NotFoundError('Schedule', scheduleId);
    }

    const updated = await this.scheduleRepo.update(scheduleId, orgId, { enabled });

    // Add/remove from in-process cron executor
    if (this.executor) {
      if (enabled) {
        this.executor.addSchedule(updated);
      } else {
        this.executor.removeSchedule(scheduleId);
      }
    }

    emitToOrg(this.io, orgId, WS_EVENTS.SCHEDULE_UPDATED, {
      scheduleId,
      taskIdentifier: updated.taskIdentifier,
      enabled,
    });

    logger.info('Schedule toggled', { scheduleId, orgId, enabled });

    return updated;
  }

  /**
   * Public utility for the /next-executions API endpoint.
   * Uses the shared timezone-aware cron calculator.
   */
  getNextExecutions(
    cronExpression: string,
    timezone: string,
    count: number = 5
  ): Date[] {
    return getNextCronRuns(cronExpression, timezone, count);
  }
}
