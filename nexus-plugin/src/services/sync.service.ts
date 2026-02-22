import { TriggerProxyService } from './trigger-proxy.service';
import { RunRepository, RunStatus } from '../database/repositories/run.repository';
import { ScheduleRepository } from '../database/repositories/schedule.repository';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'sync-service' });

export class SyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(
    private proxy: TriggerProxyService,
    private runRepo: RunRepository,
    private scheduleRepo: ScheduleRepository
  ) {}

  async syncRuns(orgId: string, projectId: string): Promise<{ synced: number; errors: number }> {
    let synced = 0;
    let errors = 0;

    try {
      // Fetch recent runs from Trigger.dev
      const triggerRuns = await this.proxy.listRuns({ limit: 100 });
      const runs = triggerRuns.data || triggerRuns.runs || [];

      for (const triggerRun of runs) {
        try {
          const triggerRunId = triggerRun.id;
          const existing = await this.runRepo.findByTriggerRunId(triggerRunId, orgId);

          if (existing) {
            // Update status if changed
            if (existing.status !== triggerRun.status) {
              await this.runRepo.updateStatus(
                existing.runId,
                triggerRun.status as RunStatus,
                triggerRun.output,
                triggerRun.error?.message
              );
              synced++;
            }
          } else {
            // Create new local record
            await this.runRepo.create({
              triggerRunId,
              projectId,
              organizationId: orgId,
              taskIdentifier: triggerRun.taskIdentifier || triggerRun.task || 'unknown',
              status: triggerRun.status as RunStatus,
              payload: triggerRun.payload,
              output: triggerRun.output,
              errorMessage: triggerRun.error?.message,
              startedAt: triggerRun.startedAt ? new Date(triggerRun.startedAt) : undefined,
              completedAt: triggerRun.completedAt ? new Date(triggerRun.completedAt) : undefined,
              durationMs: triggerRun.durationMs,
              tags: triggerRun.tags || [],
            });
            synced++;
          }
        } catch (err: any) {
          errors++;
          logger.warn('Failed to sync individual run', {
            triggerRunId: triggerRun.id,
            error: err.message,
          });
        }
      }

      logger.info('Runs synced', { orgId, projectId, synced, errors, total: runs.length });
    } catch (err: any) {
      logger.error('Run sync failed', { orgId, projectId, error: err.message });
      throw err;
    }

    return { synced, errors };
  }

  async syncSchedules(orgId: string, projectId: string): Promise<{ synced: number; errors: number }> {
    let synced = 0;
    let errors = 0;

    try {
      const triggerSchedules = await this.proxy.listSchedules({ perPage: 100 });
      const schedules = triggerSchedules.data || triggerSchedules.schedules || [];

      for (const triggerSchedule of schedules) {
        try {
          const triggerScheduleId = triggerSchedule.id;
          const existingSchedules = await this.scheduleRepo.findByOrgId(orgId, {});
          const existing = existingSchedules.find(
            (s) => s.triggerScheduleId === triggerScheduleId
          );

          if (existing) {
            // Update state
            const updates: any = {};
            if (triggerSchedule.active !== undefined) {
              updates.enabled = triggerSchedule.active;
            }
            if (triggerSchedule.nextRunTimestamp) {
              updates.nextRunAt = new Date(triggerSchedule.nextRunTimestamp);
            }

            if (Object.keys(updates).length > 0) {
              await this.scheduleRepo.update(existing.scheduleId, orgId, updates);
              synced++;
            }
          }
        } catch (err: any) {
          errors++;
          logger.warn('Failed to sync individual schedule', {
            triggerScheduleId: triggerSchedule.id,
            error: err.message,
          });
        }
      }

      logger.info('Schedules synced', { orgId, projectId, synced, errors });
    } catch (err: any) {
      logger.error('Schedule sync failed', { orgId, projectId, error: err.message });
      throw err;
    }

    return { synced, errors };
  }

  startPeriodicSync(intervalMs: number = 30000): void {
    if (this.syncInterval) {
      logger.warn('Periodic sync already running');
      return;
    }

    this.syncInterval = setInterval(async () => {
      if (this.isSyncing) {
        logger.debug('Sync already in progress, skipping');
        return;
      }

      this.isSyncing = true;
      try {
        // Note: In production, this would iterate over all active projects.
        // For now, the sync is triggered per-project via the API.
        logger.debug('Periodic sync tick (no-op without project context)');
      } catch (err: any) {
        logger.error('Periodic sync error', { error: err.message });
      } finally {
        this.isSyncing = false;
      }
    }, intervalMs);

    logger.info('Periodic sync started', { intervalMs });
  }

  stopPeriodicSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      logger.info('Periodic sync stopped');
    }
  }
}
