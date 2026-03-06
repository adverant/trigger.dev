import { Server as SocketIOServer } from 'socket.io';
import axios, { AxiosInstance } from 'axios';
import { WS_EVENTS } from './events';
import { emitToOrg, emitToRun } from './socket-server';
import { LogRepository } from '../database/repositories/log.repository';
import { createLogger } from '../utils/logger';

const logger = createLogger({ service: 'nexus-trigger', component: 'run-stream' });

interface RunStreamConfig {
  triggerApiUrl: string;
  triggerSecretKey: string;
  pollIntervalMs: number;
  logRepo?: LogRepository;
}

interface TrackedRun {
  triggerRunId: string;
  runId: string;
  orgId: string;
  taskIdentifier: string;
  lastStatus: string;
  startedAt: number;
}

/**
 * RunStreamManager handles real-time streaming of run status updates
 * from Trigger.dev to connected WebSocket clients.
 *
 * It polls the Trigger.dev API for status changes and emits events
 * to the appropriate organization and run-specific Socket.IO rooms.
 */
export class RunStreamManager {
  private io: SocketIOServer;
  private apiClient: AxiosInstance;
  private trackedRuns: Map<string, TrackedRun> = new Map();
  private pollInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;
  private isRunning = false;
  private logRepo?: LogRepository;

  constructor(io: SocketIOServer, config: RunStreamConfig) {
    this.io = io;
    this.pollIntervalMs = config.pollIntervalMs || 3000;
    this.logRepo = config.logRepo;
    this.apiClient = axios.create({
      baseURL: config.triggerApiUrl,
      headers: {
        Authorization: `Bearer ${config.triggerSecretKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
  }

  /** Set the log repository (called after DB init). */
  setLogRepo(repo: LogRepository): void {
    this.logRepo = repo;
  }

  /**
   * Start tracking a run for real-time status updates.
   */
  trackRun(
    triggerRunId: string,
    runId: string,
    orgId: string,
    taskIdentifier: string
  ): void {
    this.trackedRuns.set(triggerRunId, {
      triggerRunId,
      runId,
      orgId,
      taskIdentifier,
      lastStatus: 'QUEUED',
      startedAt: Date.now(),
    });

    logger.debug('Now tracking run', { triggerRunId, runId, orgId, taskIdentifier });

    // Emit initial status
    emitToOrg(this.io, orgId, WS_EVENTS.RUN_STARTED, {
      runId,
      triggerRunId,
      taskIdentifier,
      status: 'QUEUED',
    });

    emitToRun(this.io, runId, WS_EVENTS.RUN_STARTED, {
      runId,
      triggerRunId,
      taskIdentifier,
      status: 'QUEUED',
    });
  }

  /**
   * Stop tracking a run.
   */
  untrackRun(triggerRunId: string): void {
    this.trackedRuns.delete(triggerRunId);
    logger.debug('Stopped tracking run', { triggerRunId });
  }

  /**
   * Start the polling loop for tracked run status updates.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.pollInterval = setInterval(() => {
      this.pollRunStatuses().catch((err) => {
        logger.error('Run status poll error', { error: err.message });
      });
    }, this.pollIntervalMs);

    logger.info('Run stream manager started', { pollIntervalMs: this.pollIntervalMs });
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info('Run stream manager stopped');
  }

  /**
   * Poll Trigger.dev for status updates on all tracked runs.
   */
  private async pollRunStatuses(): Promise<void> {
    if (this.trackedRuns.size === 0) return;

    const terminalStatuses = new Set([
      'COMPLETED',
      'CANCELED',
      'FAILED',
      'CRASHED',
      'SYSTEM_FAILURE',
      'EXPIRED',
      'TIMED_OUT',
    ]);

    const runsToRemove: string[] = [];

    for (const [triggerRunId, tracked] of this.trackedRuns) {
      try {
        const response = await this.apiClient.get(`/api/v3/runs/${triggerRunId}`);
        const runData = response.data;
        const newStatus = runData.status;

        // Only emit if status changed
        if (newStatus !== tracked.lastStatus) {
          const durationMs = Date.now() - tracked.startedAt;

          // Emit status change to org room
          emitToOrg(this.io, tracked.orgId, WS_EVENTS.RUN_STATUS, {
            runId: tracked.runId,
            triggerRunId,
            taskIdentifier: tracked.taskIdentifier,
            previousStatus: tracked.lastStatus,
            status: newStatus,
            durationMs,
          });

          // Emit to run-specific room
          emitToRun(this.io, tracked.runId, WS_EVENTS.RUN_STATUS, {
            runId: tracked.runId,
            triggerRunId,
            taskIdentifier: tracked.taskIdentifier,
            previousStatus: tracked.lastStatus,
            status: newStatus,
            durationMs,
          });

          // Emit terminal events
          if (newStatus === 'COMPLETED') {
            const completedEvent = {
              runId: tracked.runId,
              triggerRunId,
              taskIdentifier: tracked.taskIdentifier,
              status: 'COMPLETED',
              durationMs,
              output: runData.output,
            };
            emitToOrg(this.io, tracked.orgId, WS_EVENTS.RUN_COMPLETED, completedEvent);
            emitToRun(this.io, tracked.runId, WS_EVENTS.RUN_COMPLETED, completedEvent);
          } else if (terminalStatuses.has(newStatus) && newStatus !== 'COMPLETED') {
            const failedEvent = {
              runId: tracked.runId,
              triggerRunId,
              taskIdentifier: tracked.taskIdentifier,
              status: newStatus,
              errorMessage: runData.error?.message,
              durationMs,
            };
            emitToOrg(this.io, tracked.orgId, WS_EVENTS.RUN_FAILED, failedEvent);
            emitToRun(this.io, tracked.runId, WS_EVENTS.RUN_FAILED, failedEvent);
          }

          tracked.lastStatus = newStatus;

          // Write structured log for terminal status changes
          if (terminalStatuses.has(newStatus) && this.logRepo) {
            const isError = newStatus !== 'COMPLETED' && newStatus !== 'CANCELED';
            this.logRepo.create({
              runId: tracked.runId,
              organizationId: tracked.orgId,
              taskIdentifier: tracked.taskIdentifier,
              level: isError ? 'ERROR' : 'INFO',
              message: isError
                ? `Run ${newStatus}: ${runData.error?.message || 'No error details'}`
                : `Run ${newStatus}`,
              data: { durationMs, triggerRunId },
            }).catch(() => {});
          }

          logger.debug('Run status changed', {
            triggerRunId,
            previousStatus: tracked.lastStatus,
            newStatus,
          });
        }

        // Stop tracking terminal runs (with small delay to ensure clients receive events)
        if (terminalStatuses.has(newStatus)) {
          runsToRemove.push(triggerRunId);
        }

        // Auto-cleanup stale runs (older than 24 hours)
        if (Date.now() - tracked.startedAt > 24 * 60 * 60 * 1000) {
          runsToRemove.push(triggerRunId);
          logger.warn('Removing stale tracked run', { triggerRunId, age: '24h+' });
        }
      } catch (err: any) {
        // If run not found (404), stop tracking
        if (err.response?.status === 404) {
          runsToRemove.push(triggerRunId);
          logger.warn('Run not found, removing from tracking', { triggerRunId });
        } else {
          logger.error('Failed to poll run status', {
            triggerRunId,
            error: err.message,
            status: err.response?.status,
          });
        }
      }
    }

    // Remove terminal/stale runs
    for (const id of runsToRemove) {
      this.trackedRuns.delete(id);
    }
  }

  /**
   * Get the number of currently tracked runs.
   */
  getTrackedRunCount(): number {
    return this.trackedRuns.size;
  }

  /**
   * Get list of tracked run IDs.
   */
  getTrackedRuns(): string[] {
    return Array.from(this.trackedRuns.keys());
  }
}
