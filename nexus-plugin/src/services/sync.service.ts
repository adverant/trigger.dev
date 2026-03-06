import { TriggerProxyService } from './trigger-proxy.service';
import { RunRepository, RunStatus } from '../database/repositories/run.repository';
import { LogRepository } from '../database/repositories/log.repository';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'sync-service' });

const TERMINAL_STATUSES = new Set([
  'COMPLETED', 'CANCELED', 'FAILED', 'CRASHED',
  'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT', 'INTERRUPTED',
]);

const ERROR_STATUSES = new Set([
  'FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'EXPIRED', 'TIMED_OUT', 'INTERRUPTED',
]);

export class SyncService {
  private syncInterval: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(
    private proxy: TriggerProxyService,
    private runRepo: RunRepository,
    private logRepo?: LogRepository
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

              // Write log entry for terminal status transitions
              if (TERMINAL_STATUSES.has(triggerRun.status) && this.logRepo) {
                const taskId = existing.taskIdentifier || 'unknown';
                const isError = ERROR_STATUSES.has(triggerRun.status);
                this.logRepo.create({
                  runId: existing.runId,
                  organizationId: orgId,
                  taskIdentifier: taskId,
                  level: isError ? 'ERROR' : 'INFO',
                  message: isError
                    ? `Run ${triggerRun.status}: ${triggerRun.error?.message || 'No error message'}`
                    : `Run ${triggerRun.status}`,
                  data: { previousStatus: existing.status, durationMs: triggerRun.durationMs },
                }).catch(() => {});
              }

              synced++;
            }
          } else {
            // Create new local record
            const taskId = triggerRun.taskIdentifier || triggerRun.task || 'unknown';
            await this.runRepo.create({
              triggerRunId,
              projectId,
              organizationId: orgId,
              taskIdentifier: taskId,
              status: triggerRun.status as RunStatus,
              payload: triggerRun.payload,
              output: triggerRun.output,
              errorMessage: triggerRun.error?.message,
              startedAt: triggerRun.startedAt ? new Date(triggerRun.startedAt) : undefined,
              completedAt: triggerRun.completedAt ? new Date(triggerRun.completedAt) : undefined,
              durationMs: triggerRun.durationMs,
              tags: triggerRun.tags || [],
            });

            // Write log for newly discovered runs already in terminal state
            if (TERMINAL_STATUSES.has(triggerRun.status) && this.logRepo) {
              const isError = ERROR_STATUSES.has(triggerRun.status);
              this.logRepo.create({
                runId: triggerRunId,
                organizationId: orgId,
                taskIdentifier: taskId,
                level: isError ? 'ERROR' : 'INFO',
                message: isError
                  ? `Run ${triggerRun.status}: ${triggerRun.error?.message || 'No error message'}`
                  : `Run ${triggerRun.status}`,
                data: { syncDiscovered: true, durationMs: triggerRun.durationMs },
              }).catch(() => {});
            }

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
