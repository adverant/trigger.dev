import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService, CreateScheduleData as TriggerCreateScheduleData } from './trigger-proxy.service';
import { ScheduleRepository, Schedule, CreateScheduleData, UpdateScheduleData } from '../database/repositories/schedule.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';

const logger = createLogger({ component: 'schedule-service' });

const CRON_REGEX = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/;

export class ScheduleService {
  constructor(
    private proxy: TriggerProxyService,
    private scheduleRepo: ScheduleRepository,
    private usageRepo: UsageRepository,
    private io: SocketIOServer
  ) {}

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

    // Create schedule in Trigger.dev
    const triggerData: TriggerCreateScheduleData = {
      task: data.task,
      cron: data.cron,
      externalId: data.externalId,
      deduplicationKey: data.deduplicationKey,
      timezone: data.timezone,
      environments: data.environments,
    };

    const triggerResult = await this.proxy.createSchedule(triggerData);

    // Store locally with enrichment
    const schedule = await this.scheduleRepo.create({
      triggerScheduleId: triggerResult.id,
      projectId,
      organizationId: orgId,
      userId,
      taskIdentifier: data.task,
      cronExpression: data.cron,
      timezone: data.timezone || 'UTC',
      description: data.description,
      payload: data.payload,
      externalId: data.externalId,
      nextRunAt: triggerResult.nextRunTimestamp
        ? new Date(triggerResult.nextRunTimestamp)
        : undefined,
    });

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
    return this.scheduleRepo.findByOrgId(orgId, {});
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

    // Update in Trigger.dev
    if (existing.triggerScheduleId && (data.cron || data.externalId)) {
      const triggerUpdate: any = {};
      if (data.cron) {
        if (!CRON_REGEX.test(data.cron)) {
          throw new ValidationError(`Invalid cron expression: ${data.cron}`);
        }
        triggerUpdate.cron = data.cron;
      }
      if (data.externalId) triggerUpdate.externalId = data.externalId;

      await this.proxy.updateSchedule(existing.triggerScheduleId, triggerUpdate);
    }

    // Update locally
    const updateData: UpdateScheduleData = {};
    if (data.cron) updateData.cronExpression = data.cron;
    if (data.externalId) updateData.externalId = data.externalId;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.timezone) updateData.timezone = data.timezone;
    if (data.payload !== undefined) updateData.payload = data.payload;

    const updated = await this.scheduleRepo.update(scheduleId, orgId, updateData);

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

    // Delete from Trigger.dev
    if (existing.triggerScheduleId) {
      await this.proxy.deleteSchedule(existing.triggerScheduleId);
    }

    // Delete locally
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

    // Activate/deactivate in Trigger.dev
    if (existing.triggerScheduleId) {
      if (enabled) {
        await this.proxy.activateSchedule(existing.triggerScheduleId);
      } else {
        await this.proxy.deactivateSchedule(existing.triggerScheduleId);
      }
    }

    const updated = await this.scheduleRepo.update(scheduleId, orgId, { enabled });

    emitToOrg(this.io, orgId, WS_EVENTS.SCHEDULE_UPDATED, {
      scheduleId,
      taskIdentifier: updated.taskIdentifier,
      enabled,
    });

    logger.info('Schedule toggled', { scheduleId, orgId, enabled });

    return updated;
  }

  getNextExecutions(
    cronExpression: string,
    timezone: string,
    count: number = 5
  ): Date[] {
    // Simple cron next-execution calculator
    // For production, a full cron parser library like `cron-parser` would be used.
    // Since `node-cron` is in dependencies, we parse manually.
    const results: Date[] = [];
    const parts = cronExpression.split(/\s+/);
    if (parts.length !== 5) return results;

    const now = new Date();
    let current = new Date(now.getTime());

    // Basic approach: iterate minute-by-minute up to count matches (max 365 days)
    const maxIterations = 525600; // 1 year of minutes
    for (let i = 0; i < maxIterations && results.length < count; i++) {
      current = new Date(current.getTime() + 60000);
      if (this.matchesCron(current, parts)) {
        results.push(new Date(current));
      }
    }

    return results;
  }

  private matchesCron(date: Date, parts: string[]): boolean {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const dayOfMonth = date.getDate();
    const month = date.getMonth() + 1;
    const dayOfWeek = date.getDay();

    return (
      this.matchesCronField(minute, parts[0], 0, 59) &&
      this.matchesCronField(hour, parts[1], 0, 23) &&
      this.matchesCronField(dayOfMonth, parts[2], 1, 31) &&
      this.matchesCronField(month, parts[3], 1, 12) &&
      this.matchesCronField(dayOfWeek, parts[4], 0, 6)
    );
  }

  private matchesCronField(value: number, field: string, min: number, max: number): boolean {
    if (field === '*') return true;

    const segments = field.split(',');
    for (const segment of segments) {
      if (segment.includes('/')) {
        const [rangeStr, stepStr] = segment.split('/');
        const step = parseInt(stepStr, 10);
        const start = rangeStr === '*' ? min : parseInt(rangeStr, 10);
        if ((value - start) >= 0 && (value - start) % step === 0) return true;
      } else if (segment.includes('-')) {
        const [startStr, endStr] = segment.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (value >= start && value <= end) return true;
      } else {
        if (parseInt(segment, 10) === value) return true;
      }
    }

    return false;
  }
}
