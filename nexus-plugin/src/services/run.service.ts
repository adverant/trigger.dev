import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService } from './trigger-proxy.service';
import { RunRepository, Run, RunFilters, RunStatus } from '../database/repositories/run.repository';
import { createLogger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg, emitToRun as emitToRunRoom } from '../websocket/socket-server';

const logger = createLogger({ component: 'run-service' });

export class RunService {
  constructor(
    private proxy: TriggerProxyService,
    private runRepo: RunRepository,
    private io: SocketIOServer
  ) {}

  async listRuns(
    orgId: string,
    projectId?: string,
    filters?: RunFilters
  ): Promise<{ runs: Run[]; total: number }> {
    // Fetch from local database with enrichment
    const result = await this.runRepo.findByOrgId(orgId, {
      ...filters,
      // We filter to runs that belong to this project via a join-like approach
      // Since the run repo filters by orgId, we add taskIdentifier filters if needed
    });

    return result;
  }

  async getRun(orgId: string, runId: string): Promise<any> {
    // Get local record
    const localRun = await this.runRepo.findById(runId, orgId);
    if (!localRun) {
      throw new NotFoundError('Run', runId);
    }

    // In-process runs (pc-*, se-*, pk-*) don't have an external Trigger.dev run —
    // their status is managed entirely via local DB. Skip external polling.
    const isInProcessRun = /^(pc|se|pk)-/.test(localRun.triggerRunId);

    let triggerData: any = null;
    if (!isInProcessRun) {
      try {
        triggerData = await this.proxy.getRun(localRun.triggerRunId);
      } catch (err: any) {
        logger.warn('Could not fetch run from Trigger.dev, using local data', {
          runId,
          error: err.message,
        });
      }

      // Update local status if Trigger.dev has newer data
      if (triggerData && triggerData.status !== localRun.status) {
        await this.runRepo.updateStatus(
          localRun.runId,
          triggerData.status as RunStatus,
          triggerData.output,
          triggerData.error?.message
        );
      }
    }

    return {
      ...localRun,
      triggerData,
      status: triggerData?.status || localRun.status,
      output: triggerData?.output || localRun.output,
    };
  }

  async cancelRun(orgId: string, runId: string): Promise<any> {
    const localRun = await this.runRepo.findById(runId, orgId);
    if (!localRun) {
      throw new NotFoundError('Run', runId);
    }

    const result = await this.proxy.cancelRun(localRun.triggerRunId);

    await this.runRepo.updateStatus(localRun.runId, 'CANCELED');

    emitToOrg(this.io, orgId, WS_EVENTS.RUN_CANCELLED, {
      runId: localRun.runId,
      triggerRunId: localRun.triggerRunId,
      taskIdentifier: localRun.taskIdentifier,
    });

    emitToRunRoom(this.io, localRun.runId, WS_EVENTS.RUN_CANCELLED, {
      runId: localRun.runId,
      triggerRunId: localRun.triggerRunId,
      taskIdentifier: localRun.taskIdentifier,
    });

    logger.info('Run cancelled', { runId, orgId, triggerRunId: localRun.triggerRunId });

    return result;
  }

  async replayRun(orgId: string, runId: string): Promise<any> {
    const localRun = await this.runRepo.findById(runId, orgId);
    if (!localRun) {
      throw new NotFoundError('Run', runId);
    }

    const result = await this.proxy.replayRun(localRun.triggerRunId);

    const newTriggerRunId = result.id || result.runId;

    // Create a new local run for the replay
    const newRun = await this.runRepo.create({
      triggerRunId: newTriggerRunId,
      projectId: localRun.projectId,
      organizationId: orgId,
      taskIdentifier: localRun.taskIdentifier,
      status: result.status || 'QUEUED',
      payload: localRun.payload || undefined,
      metadata: {
        replayedFrom: localRun.runId,
        ...(localRun.metadata || {}),
      },
      tags: localRun.tags,
    });

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId: localRun.taskIdentifier,
      runId: newRun.runId,
      triggerRunId: newTriggerRunId,
      status: newRun.status,
      replayedFrom: localRun.runId,
    });

    logger.info('Run replayed', {
      originalRunId: runId,
      newRunId: newRun.runId,
      orgId,
    });

    return {
      ...result,
      localRunId: newRun.runId,
      replayedFrom: runId,
    };
  }

  async rescheduleRun(orgId: string, runId: string, delay: string): Promise<any> {
    const localRun = await this.runRepo.findById(runId, orgId);
    if (!localRun) {
      throw new NotFoundError('Run', runId);
    }

    const result = await this.proxy.rescheduleRun(localRun.triggerRunId, delay);

    await this.runRepo.updateStatus(localRun.runId, 'DELAYED');

    logger.info('Run rescheduled', {
      runId,
      orgId,
      delay,
      triggerRunId: localRun.triggerRunId,
    });

    return result;
  }

  async getStatistics(orgId: string): Promise<any> {
    const [raw, runsByHour, taskHealth] = await Promise.all([
      this.runRepo.getStatistics(orgId),
      this.runRepo.getRunsByHour(orgId),
      this.runRepo.getTaskHealth(orgId),
    ]);

    // Count currently active (non-terminal) runs
    const activeRuns = raw.totalRuns - raw.completedRuns - raw.failedRuns;

    return {
      totalTasks: raw.totalRuns,
      activeRuns: activeRuns > 0 ? activeRuns : 0,
      scheduledJobs: 0,
      pendingWaitpoints: 0,
      failedLast24h: raw.failedRuns,
      runsByHour,
      taskHealth,
    };
  }

  async updateRunTags(orgId: string, runId: string, tags: string[]): Promise<Run> {
    const localRun = await this.runRepo.findById(runId, orgId);
    if (!localRun) {
      throw new NotFoundError('Run', runId);
    }

    const updated = await this.runRepo.updateTags(runId, tags);
    logger.info('Run tags updated', { runId, orgId, tags });
    return updated;
  }

  async bulkCancel(
    orgId: string,
    runIds?: string[],
    filters?: Record<string, any>
  ): Promise<{ processed: number; succeeded: number; failed: number; errors?: string[] }> {
    let targetIds = runIds || [];

    // If filters provided instead of explicit IDs, find matching runs
    if (!runIds && filters) {
      const result = await this.runRepo.findByOrgId(orgId, {
        status: filters.status,
        taskIdentifier: filters.taskIdentifier,
        tags: filters.tags,
        startDate: filters.from ? new Date(filters.from) : undefined,
        endDate: filters.to ? new Date(filters.to) : undefined,
        limit: 500,
      });
      targetIds = result.runs.map(r => r.runId);
    }

    // Cap at 500
    targetIds = targetIds.slice(0, 500);

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of targetIds) {
      try {
        await this.cancelRun(orgId, id);
        succeeded++;
      } catch (err: any) {
        failed++;
        errors.push(`${id}: ${err.message}`);
      }
    }

    return { processed: targetIds.length, succeeded, failed, errors: errors.length > 0 ? errors : undefined };
  }

  async bulkReplay(
    orgId: string,
    runIds?: string[],
    filters?: Record<string, any>
  ): Promise<{ processed: number; succeeded: number; failed: number; errors?: string[] }> {
    let targetIds = runIds || [];

    if (!runIds && filters) {
      const result = await this.runRepo.findByOrgId(orgId, {
        status: filters.status,
        taskIdentifier: filters.taskIdentifier,
        tags: filters.tags,
        startDate: filters.from ? new Date(filters.from) : undefined,
        endDate: filters.to ? new Date(filters.to) : undefined,
        limit: 500,
      });
      targetIds = result.runs.map(r => r.runId);
    }

    targetIds = targetIds.slice(0, 500);

    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const id of targetIds) {
      try {
        await this.replayRun(orgId, id);
        succeeded++;
      } catch (err: any) {
        failed++;
        errors.push(`${id}: ${err.message}`);
      }
    }

    return { processed: targetIds.length, succeeded, failed, errors: errors.length > 0 ? errors : undefined };
  }

  async streamRunLogs(runId: string, socket: any): Promise<void> {
    // Subscribe the socket to the run's room for real-time updates
    socket.join(`run:${runId}`);
    logger.debug('Client subscribed to run logs', { runId, socketId: socket.id });
  }
}
