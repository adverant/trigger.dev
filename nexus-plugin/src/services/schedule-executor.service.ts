import cron from 'node-cron';
import { Server as SocketIOServer } from 'socket.io';
import { ScheduleRepository, Schedule } from '../database/repositories/schedule.repository';
import { TaskService } from './task.service';
import { DatabaseService } from '../database/database-service';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { getNextCronRuns } from '../utils/cron-next-run';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'schedule-executor' });

const EXECUTION_TIMEOUT_MS = 60_000; // 1 minute for triggering (not task completion)

export class ScheduleExecutorService {
  private jobs: Map<string, cron.ScheduledTask> = new Map();
  private running = false;

  constructor(
    private scheduleRepo: ScheduleRepository,
    private taskService: TaskService,
    private io: SocketIOServer,
    private db: DatabaseService,
    private redis?: any
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

    // Calculate and store next_run_at using shared timezone-aware utility
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

    // Distributed lock — prevent duplicate execution across pods
    let lockKey: string | undefined;
    if (this.redis) {
      lockKey = `trigger:schedule:${schedule.scheduleId}:lock`;
      try {
        const lockAcquired = await this.redis.set(lockKey, process.env.HOSTNAME || 'default', 'EX', 300, 'NX');
        if (!lockAcquired) {
          logger.info('Schedule execution skipped — another pod holds the lock', {
            scheduleId: schedule.scheduleId,
          });
          return;
        }
      } catch (err: any) {
        logger.warn('Redis lock acquisition failed, proceeding anyway', {
          scheduleId: schedule.scheduleId,
          error: err.message,
        });
        lockKey = undefined; // Don't try to release
      }
    }

    try {
      // Get project context for task execution (org-scoped only — no global fallback)
      const projects = await this.db.getPool().query(
        'SELECT project_id, organization_id, user_id FROM trigger.projects WHERE organization_id = $1 LIMIT 1',
        [schedule.organizationId]
      );

      if (projects.rows.length === 0) {
        logger.error('No project found for organization — cannot execute scheduled task', {
          scheduleId: schedule.scheduleId,
          organizationId: schedule.organizationId,
        });
        await this.scheduleRepo.incrementRunCount(schedule.scheduleId, false, schedule.organizationId);
        return;
      }

      const projectRow = projects.rows[0];

      // Use project's user_id as fallback if schedule userId is non-UUID
      const userId = schedule.userId && schedule.userId.match(/^[0-9a-f-]{36}$/i)
        ? schedule.userId
        : projectRow.user_id || schedule.userId;

      // Trigger with timeout — prevents hanging cron callbacks
      const result = await Promise.race([
        this.taskService.triggerTask(
          projectRow.organization_id,
          userId,
          projectRow.project_id,
          schedule.taskIdentifier,
          { ...(schedule.payload || {}), _scheduledAt: new Date().toISOString(), _scheduleId: schedule.scheduleId }
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Schedule execution timed out after ${EXECUTION_TIMEOUT_MS}ms`)), EXECUTION_TIMEOUT_MS)
        ),
      ]);

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
        runId: (result as any)?.localRunId || (result as any)?.id,
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
    } finally {
      // Release distributed lock
      if (this.redis && lockKey) {
        try {
          await this.redis.del(lockKey);
        } catch (err: any) {
          logger.warn('Failed to release Redis lock', { lockKey, error: err.message });
        }
      }
    }
  }

  private async updateNextRunAt(schedule: Schedule): Promise<void> {
    const nextRuns = getNextCronRuns(schedule.cronExpression, schedule.timezone || 'UTC', 1);
    if (nextRuns.length > 0) {
      await this.scheduleRepo.update(schedule.scheduleId, schedule.organizationId, {
        nextRunAt: nextRuns[0],
      });
    }
  }
}
