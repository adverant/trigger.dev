import cron from 'node-cron';
import { Server as SocketIOServer } from 'socket.io';
import { ScheduleRepository, Schedule } from '../database/repositories/schedule.repository';
import { TaskService } from './task.service';
import { DatabaseService } from '../database/database-service';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'schedule-executor' });

export class ScheduleExecutorService {
  private jobs: Map<string, cron.ScheduledTask> = new Map();
  private running = false;

  constructor(
    private scheduleRepo: ScheduleRepository,
    private taskService: TaskService,
    private io: SocketIOServer,
    private db: DatabaseService
  ) {}

  async start(): Promise<void> {
    const schedules = await this.scheduleRepo.findEnabled();
    for (const schedule of schedules) {
      this.registerJob(schedule);
    }
    this.running = true;
    logger.info(`Schedule executor started with ${schedules.length} active jobs`);
  }

  registerJob(schedule: Schedule): void {
    if (this.jobs.has(schedule.scheduleId)) {
      this.jobs.get(schedule.scheduleId)!.stop();
      this.jobs.delete(schedule.scheduleId);
    }

    if (!cron.validate(schedule.cronExpression)) {
      logger.warn('Invalid cron expression, skipping schedule', {
        scheduleId: schedule.scheduleId,
        cron: schedule.cronExpression,
      });
      return;
    }

    const task = cron.schedule(
      schedule.cronExpression,
      async () => {
        await this.executeSchedule(schedule);
      },
      { timezone: schedule.timezone || 'UTC' }
    );

    this.jobs.set(schedule.scheduleId, task);

    // Calculate and store next_run_at
    this.updateNextRunAt(schedule).catch((err) => {
      logger.warn('Failed to update next_run_at', { scheduleId: schedule.scheduleId, error: err.message });
    });

    logger.info('Registered cron job', {
      scheduleId: schedule.scheduleId,
      task: schedule.taskIdentifier,
      cron: schedule.cronExpression,
      timezone: schedule.timezone,
    });
  }

  addSchedule(schedule: Schedule): void {
    if (schedule.enabled) {
      this.registerJob(schedule);
    }
  }

  removeSchedule(scheduleId: string): void {
    const job = this.jobs.get(scheduleId);
    if (job) {
      job.stop();
      this.jobs.delete(scheduleId);
      logger.info('Removed cron job', { scheduleId });
    }
  }

  updateSchedule(schedule: Schedule): void {
    this.removeSchedule(schedule.scheduleId);
    if (schedule.enabled) {
      this.registerJob(schedule);
    }
  }

  stop(): void {
    for (const [scheduleId, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    this.running = false;
    logger.info('Schedule executor stopped');
  }

  getActiveJobCount(): number {
    return this.jobs.size;
  }

  private async executeSchedule(schedule: Schedule): Promise<void> {
    const startTime = Date.now();
    logger.info('Cron firing — executing scheduled task', {
      scheduleId: schedule.scheduleId,
      task: schedule.taskIdentifier,
      cron: schedule.cronExpression,
    });

    try {
      // Get project context for task execution
      const projects = await this.db.getPool().query(
        'SELECT project_id, organization_id FROM trigger.projects WHERE organization_id = $1 LIMIT 1',
        [schedule.organizationId]
      );

      // Fall back to any project if org-specific one not found
      const projectRow = projects.rows[0] || (await this.db.getPool().query(
        'SELECT project_id, organization_id FROM trigger.projects LIMIT 1'
      )).rows[0];

      if (!projectRow) {
        logger.error('No projects found — cannot execute scheduled task', {
          scheduleId: schedule.scheduleId,
        });
        await this.scheduleRepo.incrementRunCount(schedule.scheduleId, false, schedule.organizationId);
        return;
      }

      const result = await this.taskService.triggerTask(
        projectRow.organization_id,
        schedule.userId || 'system',
        projectRow.project_id,
        schedule.taskIdentifier,
        { ...(schedule.payload || {}), _scheduledAt: new Date().toISOString(), _scheduleId: schedule.scheduleId }
      );

      const durationMs = Date.now() - startTime;
      await this.scheduleRepo.incrementRunCount(schedule.scheduleId, true, schedule.organizationId);
      await this.updateNextRunAt(schedule);

      emitToOrg(this.io, schedule.organizationId, WS_EVENTS.SCHEDULE_UPDATED, {
        scheduleId: schedule.scheduleId,
        taskIdentifier: schedule.taskIdentifier,
        lastRunAt: new Date().toISOString(),
        lastStatus: 'COMPLETED',
      });

      logger.info('Scheduled task triggered successfully', {
        scheduleId: schedule.scheduleId,
        task: schedule.taskIdentifier,
        runId: result?.localRunId || result?.id,
        durationMs,
      });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      await this.scheduleRepo.incrementRunCount(schedule.scheduleId, false, schedule.organizationId);
      await this.updateNextRunAt(schedule);

      emitToOrg(this.io, schedule.organizationId, WS_EVENTS.SCHEDULE_UPDATED, {
        scheduleId: schedule.scheduleId,
        taskIdentifier: schedule.taskIdentifier,
        lastRunAt: new Date().toISOString(),
        lastStatus: 'FAILED',
      });

      logger.error('Scheduled task execution failed', {
        scheduleId: schedule.scheduleId,
        task: schedule.taskIdentifier,
        error: err.message,
        durationMs,
      });
    }
  }

  private async updateNextRunAt(schedule: Schedule): Promise<void> {
    // Use simple next-execution calculation
    const nextRuns = this.getNextExecution(schedule.cronExpression);
    if (nextRuns) {
      await this.scheduleRepo.update(schedule.scheduleId, schedule.organizationId, {
        nextRunAt: nextRuns,
      });
    }
  }

  private getNextExecution(cronExpression: string): Date | null {
    const parts = cronExpression.split(/\s+/);
    if (parts.length !== 5) return null;

    const now = new Date();
    let current = new Date(now.getTime());

    // Iterate minute-by-minute to find next match (max 48 hours)
    const maxIterations = 2880;
    for (let i = 0; i < maxIterations; i++) {
      current = new Date(current.getTime() + 60000);
      if (this.matchesCron(current, parts)) {
        return current;
      }
    }

    return null;
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
