import axios from 'axios';
import { randomUUID } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService, TriggerTaskOptions, BatchTriggerItem } from './trigger-proxy.service';
import { SkillsEngineTaskHandler } from './skills-engine-task-handler';
import { ProseCreatorTaskHandler } from './prosecreator-task-handler';
import { syncPlatformKnowledge } from '../task-definitions/platform-knowledge-tasks';
import { runPlatformHealthCheck, shouldTriggerRemediation, runPlatformHealthRemediation } from '../task-definitions/platform-health-tasks';
import { UserEventEmailService, WebhookEventPayload } from './user-event-email.service';
import { UserEventDigestService } from './user-event-digest.service';
import { ProjectRepository, Project } from '../database/repositories/project.repository';
import { RunRepository, CreateRunData } from '../database/repositories/run.repository';
import { TaskDefinitionRepository, UpsertTaskDefinitionData } from '../database/repositories/task-definition.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { LogRepository } from '../database/repositories/log.repository';
import { NexusConfig } from '../config';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { RunStreamManager } from '../websocket/run-stream';
import { createLogger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';
import { classifyError } from '../utils/structured-error';
import { triggerTasksTriggered } from '../utils/metrics';

const logger = createLogger({ component: 'task-service' });

export class TaskService {
  constructor(
    private proxy: TriggerProxyService,
    private projectRepo: ProjectRepository,
    private runRepo: RunRepository,
    private taskDefRepo: TaskDefinitionRepository,
    private usageRepo: UsageRepository,
    private nexusConfig: NexusConfig,
    private io: SocketIOServer,
    private runStreamManager: RunStreamManager,
    private logRepo?: LogRepository,
    private dbPool?: any,
    private redis?: any,
  ) {}

  /** Write a structured log entry (fire-and-forget, never blocks callers). */
  private writeLog(
    orgId: string,
    runId: string,
    taskIdentifier: string,
    level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    message: string,
    data?: Record<string, any>
  ): void {
    if (!this.logRepo) return;
    this.logRepo.create({ runId, organizationId: orgId, taskIdentifier, level, message, data }).catch((err) => {
      logger.warn('Failed to write run log', { runId, error: err.message });
    });
  }

  async triggerTask(
    orgId: string,
    userId: string,
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    // ProseCreator tasks run in-process — projectId is a ProseCreator UUID,
    // not a Nexus Workflows project, so skip the project lookup.
    if (taskId.startsWith('prosecreator-')) {
      return this.handleProseCreatorTask(orgId, userId, projectId, taskId, payload, options);
    }

    const project = await this.projectRepo.findById(projectId, orgId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    // Check for explicit execution target override (not prefix-derived)
    const taskDef = await this.taskDefRepo.findByIdentifier(projectId, taskId);
    if (taskDef && taskDef.executionType && taskDef.executionType !== 'prefix-derived') {
      const target = taskDef.executionTarget || {};
      if (taskDef.executionType === 'skill' && target.skillId) {
        // Route to Skills Engine with the configured skillId
        const skillPayload = { ...payload, skill_id: target.skillId };
        return this.handleSkillsEngineTask(orgId, userId, projectId, taskId, skillPayload, options);
      }
      if (taskDef.executionType === 'n8n-workflow' && target.workflowId) {
        // Route to n8n — for now, fall through to proxy (n8n handler TBD)
        logger.info('n8n-workflow execution target configured but handler not yet implemented, falling through to proxy', {
          taskId, workflowId: target.workflowId,
        });
      }
      if (taskDef.executionType === 'mageagent-prompt') {
        // MageAgent routing — fall through to proxy for now
        logger.info('mageagent-prompt execution target configured but handler not yet implemented, falling through to proxy', {
          taskId,
        });
      }
      // Other types (code-handler, external-webhook) fall through to existing routing
    }

    // Skills Engine tasks are handled directly (not proxied to cloud workers)
    if (taskId.startsWith('skills-engine-')) {
      return this.handleSkillsEngineTask(orgId, userId, projectId, taskId, payload, options);
    }

    // Platform Knowledge tasks run locally
    if (taskId.startsWith('platform-knowledge-')) {
      return this.handlePlatformKnowledgeTask(orgId, userId, projectId, taskId, payload, options);
    }

    // Platform Health Monitor tasks run locally
    if (taskId.startsWith('platform-health-')) {
      return this.handlePlatformHealthTask(orgId, userId, projectId, taskId, payload, options);
    }

    // User Event Notification tasks run locally
    if (taskId.startsWith('user-event-')) {
      return this.handleUserEventTask(orgId, userId, projectId, taskId, payload, options);
    }

    const result = await this.proxy.triggerTask(taskId, payload, options);

    const triggerRunId = result.id || result.runId;

    const run = await this.runRepo.create({
      triggerRunId,
      projectId,
      organizationId: orgId,
      taskIdentifier: taskId,
      status: result.status || 'QUEUED',
      payload,
      idempotencyKey: options?.idempotencyKey,
      metadata: options?.metadata || {},
      tags: options?.tags || [],
    });

    await this.usageRepo.record(orgId, 'task_trigger', {
      taskId,
      projectId,
      runId: run.runId,
    });

    triggerTasksTriggered.inc({ task_id: taskId, organization_id: orgId });

    // Track for real-time WebSocket updates
    this.runStreamManager.trackRun(triggerRunId, run.runId, orgId, taskId);

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId,
      runId: run.runId,
      triggerRunId,
      status: run.status,
    });

    // Optionally store in GraphRAG for semantic search
    this.storeInGraphRAG(orgId, userId, taskId, payload, result).catch((err) => {
      logger.warn('GraphRAG storage failed (non-blocking)', { error: err.message });
    });

    this.writeLog(orgId, run.runId, taskId, 'INFO', `Task triggered: ${taskId}`, { triggerRunId, projectId });

    logger.info('Task triggered', {
      taskId,
      runId: run.runId,
      triggerRunId,
      orgId,
      projectId,
    });

    return {
      ...result,
      localRunId: run.runId,
    };
  }

  /**
   * Handle Skills Engine tasks directly — creates a run record, synchronously
   * gets jobId/operationId from Skills Engine, then polls async for completion.
   * Returns immediately with runId + jobId + operationId so the dashboard can
   * track progress via both Workflows and Skills Engine WebSocket/polling.
   */
  private async handleSkillsEngineTask(
    orgId: string,
    userId: string,
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    const triggerRunId = `se-${randomUUID()}`;
    const startedAt = new Date();

    // Create run record immediately (status: EXECUTING)
    const run = await this.runRepo.create({
      triggerRunId,
      projectId,
      organizationId: orgId,
      taskIdentifier: taskId,
      status: 'EXECUTING',
      payload,
      startedAt,
      idempotencyKey: options?.idempotencyKey,
      metadata: { ...options?.metadata, source: 'skills-engine', userId, promptPreview: typeof payload?.prompt === 'string' ? payload.prompt.slice(0, 120) : undefined },
      tags: options?.tags || ['skills-engine'],
    });

    await this.usageRepo.record(orgId, 'task_trigger', {
      taskId,
      projectId,
      runId: run.runId,
    });

    triggerTasksTriggered.inc({ task_id: taskId, organization_id: orgId });

    // NOTE: Do NOT call runStreamManager.trackRun() for se-* runs.
    // Skills Engine runs have dedicated polling via pollSkillsEngineAsync().
    // RunStreamManager would try to poll trigger-dev-webapp (which doesn't exist).

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId,
      runId: run.runId,
      triggerRunId,
      status: 'EXECUTING',
    });

    this.writeLog(orgId, run.runId, taskId, 'INFO', `Skills Engine task triggered: ${taskId}`, { triggerRunId });

    logger.info('Skills Engine task triggered', { taskId, runId: run.runId, triggerRunId, orgId });

    const handler = new SkillsEngineTaskHandler(orgId, userId);
    let jobId: string | undefined;
    let operationId: string | undefined;

    // SYNC: Get jobId/operationId from Skills Engine before returning HTTP response.
    // Skills Engine POST /generate and /regenerate return quickly (<1s) with a jobId;
    // actual generation runs async on the Skills Engine side.
    try {
      if (taskId === 'skills-engine-generate') {
        const init = await handler.startGeneration(payload);
        jobId = init.jobId;
        operationId = init.operationId;
      } else if (taskId === 'skills-engine-regenerate') {
        const init = await handler.startRegeneration(payload);
        jobId = init.jobId;
        operationId = init.operationId;
      }
    } catch (err: any) {
      // If the sync start call fails, update run to FAILED and return error
      logger.error('Skills Engine start failed', { taskId, error: err.message, runId: run.runId });
      await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, err.message);
      this.writeLog(orgId, run.runId, taskId, 'ERROR', `Skills Engine start failed: ${err.message}`);

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId: run.runId,
        triggerRunId,
        status: 'FAILED',
        error: err.message,
      });

      return {
        id: triggerRunId,
        runId: triggerRunId,
        status: 'FAILED',
        localRunId: run.runId,
        error: err.message,
      };
    }

    // Persist jobId/operationId in metadata so startup recovery can resume polling
    if (jobId) {
      this.runRepo.mergeMetadata(run.runId, { jobId, operationId }).catch(() => {});
    }

    // ASYNC: Poll Skills Engine for completion (don't block HTTP response)
    if (jobId) {
      this.pollSkillsEngineAsync(handler, taskId, jobId, operationId!, run.runId, triggerRunId, orgId, userId)
        .catch((err) => {
          logger.error('Skills Engine polling failed', { error: err.message, runId: run.runId });
        });
    } else if (taskId === 'skills-engine-batch-regenerate') {
      // Batch regeneration: fire-and-forget, Skills Engine handles it
      this.executeBatchRegenerate(handler, payload, run.runId, triggerRunId, orgId, userId, taskId)
        .catch((err) => {
          logger.error('Skills Engine batch regeneration failed', { error: err.message, runId: run.runId });
        });
    }

    return {
      id: triggerRunId,
      runId: triggerRunId,
      status: 'EXECUTING',
      localRunId: run.runId,
      jobId,
      operationId,
      taskId,
    };
  }

  /**
   * Async polling for Skills Engine job completion.
   * Called after startGeneration/startRegeneration returns jobId.
   * Updates run record and emits WebSocket events on completion/failure.
   */
  private async pollSkillsEngineAsync(
    handler: SkillsEngineTaskHandler,
    taskId: string,
    jobId: string,
    operationId: string,
    runId: string,
    triggerRunId: string,
    orgId: string,
    userId: string
  ): Promise<void> {
    try {
      const onProgress = (update: { jobId: string; status: string; phase?: string }) => {
        emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
          taskId,
          runId,
          triggerRunId,
          status: 'EXECUTING',
          metadata: { jobId: update.jobId, phase: update.phase },
        });
      };

      const result = await handler.pollJobUntilDone(jobId, operationId, onProgress);

      // Update run as COMPLETED
      await this.runRepo.updateStatus(runId, 'COMPLETED', {
        jobId: result.jobId,
        operationId: result.operationId,
        skillEntityId: result.skillEntityId,
        phases: result.phases,
      });

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'COMPLETED',
        output: {
          jobId: result.jobId,
          skillEntityId: result.skillEntityId,
        },
      });

      this.storeInGraphRAG(orgId, userId, taskId, { jobId, operationId }, result).catch(() => {});

      this.writeLog(orgId, runId, taskId, 'INFO', `Skills Engine task completed`, { skillEntityId: result.skillEntityId, jobId: result.jobId });

      logger.info('Skills Engine task completed', { taskId, runId, skillEntityId: result.skillEntityId });
    } catch (error: any) {
      await this.runRepo.updateStatus(runId, 'FAILED', undefined, error.message);
      this.writeLog(orgId, runId, taskId, 'ERROR', `Skills Engine task failed: ${error.message}`);

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'FAILED',
        error: error.message,
      });

      logger.error('Skills Engine task failed', { taskId, runId, error: error.message });
    }
  }

  /**
   * Execute batch regeneration asynchronously.
   */
  private async executeBatchRegenerate(
    handler: SkillsEngineTaskHandler,
    payload: any,
    runId: string,
    triggerRunId: string,
    orgId: string,
    userId: string,
    taskId: string
  ): Promise<void> {
    try {
      const onProgress = (update: { jobId: string; status: string; phase?: string }) => {
        emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
          taskId,
          runId,
          triggerRunId,
          status: 'EXECUTING',
          metadata: { phase: update.phase },
        });
      };

      const result = await handler.handleBatchRegenerate(payload, onProgress);

      await this.runRepo.updateStatus(runId, 'COMPLETED', {
        jobIds: result.jobIds,
        total: result.total,
        skipped: result.skipped,
      });

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'COMPLETED',
        output: { total: result.total, skipped: result.skipped.length },
      });

      this.writeLog(orgId, runId, taskId, 'INFO', `Batch regeneration completed`, { total: result.total, skipped: result.skipped.length });

      logger.info('Skills Engine batch regeneration completed', { taskId, runId, total: result.total });
    } catch (error: any) {
      await this.runRepo.updateStatus(runId, 'FAILED', undefined, error.message);
      this.writeLog(orgId, runId, taskId, 'ERROR', `Batch regeneration failed: ${error.message}`);

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'FAILED',
        error: error.message,
      });

      logger.error('Skills Engine batch regeneration failed', { taskId, runId, error: error.message });
    }
  }

  /**
   * Handle Platform Knowledge tasks directly — runs syncPlatformKnowledge()
   * in-process without proxying to Trigger.dev cloud.
   */
  private async handlePlatformKnowledgeTask(
    orgId: string,
    userId: string,
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    const triggerRunId = `pk-${randomUUID()}`;
    const startedAt = new Date();

    const run = await this.runRepo.create({
      triggerRunId,
      projectId,
      organizationId: orgId,
      taskIdentifier: taskId,
      status: 'EXECUTING',
      payload,
      startedAt,
      idempotencyKey: options?.idempotencyKey,
      metadata: { ...options?.metadata, source: 'platform-knowledge' },
      tags: options?.tags || ['platform-knowledge'],
    });

    await this.usageRepo.record(orgId, 'task_trigger', {
      taskId,
      projectId,
      runId: run.runId,
    });

    triggerTasksTriggered.inc({ task_id: taskId, organization_id: orgId });

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId,
      runId: run.runId,
      triggerRunId,
      status: 'EXECUTING',
    });

    // Run async — don't block the HTTP response
    syncPlatformKnowledge(orgId, payload?.reason || 'api-trigger')
      .then(async (result) => {
        await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
          pluginsCatalogued: result.pluginsCatalogued,
          skillsCatalogued: result.skillsCatalogued,
          documentId: result.documentId,
          memoryId: result.memoryId,
          durationMs: result.durationMs,
          errors: result.errors,
        });

        emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
          taskId,
          runId: run.runId,
          triggerRunId,
          status: 'COMPLETED',
          output: {
            pluginsCatalogued: result.pluginsCatalogued,
            skillsCatalogued: result.skillsCatalogued,
          },
        });

        this.writeLog(orgId, run.runId, taskId, 'INFO', `Platform knowledge sync completed`, { plugins: result.pluginsCatalogued, skills: result.skillsCatalogued, durationMs: result.durationMs });

        logger.info('Platform knowledge sync completed', {
          taskId,
          runId: run.runId,
          plugins: result.pluginsCatalogued,
          skills: result.skillsCatalogued,
          durationMs: result.durationMs,
        });
      })
      .catch(async (err) => {
        await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, err.message);
        this.writeLog(orgId, run.runId, taskId, 'ERROR', `Platform knowledge sync failed: ${err.message}`);

        emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
          taskId,
          runId: run.runId,
          triggerRunId,
          status: 'FAILED',
          error: err.message,
        });

        logger.error('Platform knowledge sync failed', { taskId, runId: run.runId, error: err.message });
      });

    return {
      id: triggerRunId,
      runId: triggerRunId,
      status: 'EXECUTING',
      localRunId: run.runId,
      taskId,
    };
  }

  /**
   * Handle Platform Health tasks in-process — runs health checks locally
   * and optionally triggers AI remediation via Gemini 2.5 Pro.
   */
  private async handlePlatformHealthTask(
    orgId: string,
    userId: string,
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    const triggerRunId = `ph-${randomUUID()}`;
    const startedAt = new Date();

    const run = await this.runRepo.create({
      triggerRunId,
      projectId,
      organizationId: orgId,
      taskIdentifier: taskId,
      status: 'EXECUTING',
      payload,
      startedAt,
      idempotencyKey: options?.idempotencyKey,
      metadata: { ...options?.metadata, source: 'platform-health' },
      tags: options?.tags || ['platform-health'],
    });

    await this.usageRepo.record(orgId, 'task_trigger', {
      taskId,
      projectId,
      runId: run.runId,
    });

    triggerTasksTriggered.inc({ task_id: taskId, organization_id: orgId });

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId,
      runId: run.runId,
      triggerRunId,
      status: 'EXECUTING',
    });

    if (taskId === 'platform-health-monitor') {
      // Run health check async — don't block the HTTP response
      runPlatformHealthCheck(this.dbPool, this.redis)
        .then(async (report) => {
          await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
            overallStatus: report.overallStatus,
            summary: report.summary,
            durationMs: report.durationMs,
            issueCount: report.issuesExceedingBaseline.length,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId: run.runId,
            triggerRunId,
            status: 'COMPLETED',
            output: { overallStatus: report.overallStatus, summary: report.summary },
          });

          this.writeLog(orgId, run.runId, taskId, 'INFO', `Health check: ${report.overallStatus}`, {
            ...report.summary,
            durationMs: report.durationMs,
          });

          logger.info('Platform health check completed', {
            taskId,
            runId: run.runId,
            overallStatus: report.overallStatus,
            healthy: report.summary.healthy,
            degraded: report.summary.degraded,
            unhealthy: report.summary.unhealthy,
            durationMs: report.durationMs,
          });

          // Trigger remediation if issues exceed baseline
          const shouldRemediate = await shouldTriggerRemediation(this.dbPool, this.redis, report);
          if (shouldRemediate) {
            logger.info('Triggering platform health remediation', {
              issueCount: report.issuesExceedingBaseline.length,
            });
            this.triggerTask(orgId, userId, projectId, 'platform-health-remediation', {
              healthReport: report,
            }).catch((err) => {
              logger.error('Failed to trigger remediation', { error: err.message });
            });
          }
        })
        .catch(async (err) => {
          await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, err.message);
          this.writeLog(orgId, run.runId, taskId, 'ERROR', `Health check failed: ${err.message}`);

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId: run.runId,
            triggerRunId,
            status: 'FAILED',
            error: err.message,
          });

          logger.error('Platform health check failed', { taskId, runId: run.runId, error: err.message });
        });
    } else if (taskId === 'platform-health-remediation') {
      // Run AI remediation async
      const healthReport = payload?.healthReport;
      if (!healthReport) {
        await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, 'Missing healthReport in payload');
        return { id: triggerRunId, runId: triggerRunId, status: 'FAILED', error: 'Missing healthReport' };
      }

      runPlatformHealthRemediation(this.dbPool, healthReport)
        .then(async (report) => {
          await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
            reportId: report.reportId,
            issueCount: report.issueCount,
            modelUsed: report.modelUsed,
            durationMs: report.durationMs,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId: run.runId,
            triggerRunId,
            status: 'COMPLETED',
            output: { reportId: report.reportId, issueCount: report.issueCount },
          });

          this.writeLog(orgId, run.runId, taskId, 'INFO', `Remediation complete: ${report.issueCount} issues`, {
            reportId: report.reportId,
            modelUsed: report.modelUsed,
            durationMs: report.durationMs,
          });

          logger.info('Platform health remediation completed', {
            taskId,
            runId: run.runId,
            reportId: report.reportId,
            issueCount: report.issueCount,
            modelUsed: report.modelUsed,
            durationMs: report.durationMs,
          });
        })
        .catch(async (err) => {
          await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, err.message);
          this.writeLog(orgId, run.runId, taskId, 'ERROR', `Remediation failed: ${err.message}`);

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId: run.runId,
            triggerRunId,
            status: 'FAILED',
            error: err.message,
          });

          logger.error('Platform health remediation failed', { taskId, runId: run.runId, error: err.message });
        });
    }

    return {
      id: triggerRunId,
      runId: triggerRunId,
      status: 'EXECUTING',
      localRunId: run.runId,
      taskId,
    };
  }

  /**
   * Handle User Event tasks in-process — processes webhook events and sends
   * notification emails via Resend, or runs the daily digest.
   */
  private async handleUserEventTask(
    orgId: string,
    userId: string,
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    const triggerRunId = `ue-${randomUUID()}`;
    const startedAt = new Date();

    const run = await this.runRepo.create({
      triggerRunId,
      projectId,
      organizationId: orgId,
      taskIdentifier: taskId,
      status: 'EXECUTING',
      payload,
      startedAt,
      idempotencyKey: options?.idempotencyKey,
      metadata: { ...options?.metadata, source: 'user-event' },
      tags: options?.tags || ['user-event'],
    });

    await this.usageRepo.record(orgId, 'task_trigger', {
      taskId,
      projectId,
      runId: run.runId,
    });

    triggerTasksTriggered.inc({ task_id: taskId, organization_id: orgId });

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId,
      runId: run.runId,
      triggerRunId,
      status: 'EXECUTING',
    });

    const pool = this.dbPool;

    if (taskId === 'user-event-notification' && pool) {
      // Process a single event notification
      const emailService = new UserEventEmailService(pool);
      emailService.processEvent(payload as WebhookEventPayload)
        .then(async () => {
          await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
            eventType: payload?.event_type,
            email: payload?.user?.email,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId, runId: run.runId, triggerRunId, status: 'COMPLETED',
          });

          this.writeLog(orgId, run.runId, taskId, 'INFO', `User event processed: ${payload?.event_type}`);
          logger.info('User event task completed', { taskId, runId: run.runId, eventType: payload?.event_type });
        })
        .catch(async (err: any) => {
          await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, err.message);
          this.writeLog(orgId, run.runId, taskId, 'ERROR', `User event task failed: ${err.message}`);

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId, runId: run.runId, triggerRunId, status: 'FAILED', error: err.message,
          });

          logger.error('User event task failed', { taskId, runId: run.runId, error: err.message });
        });
    } else if (taskId === 'user-event-daily-digest' && pool) {
      // Run the daily digest
      const digestService = new UserEventDigestService(pool);
      digestService.runDailyDigest()
        .then(async (result) => {
          await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
            eventCount: result.eventCount,
            emailSent: result.emailSent,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId, runId: run.runId, triggerRunId, status: 'COMPLETED',
            output: { eventCount: result.eventCount, emailSent: result.emailSent },
          });

          this.writeLog(orgId, run.runId, taskId, 'INFO', `Daily digest completed: ${result.eventCount} events`);
          logger.info('Daily digest completed', { taskId, runId: run.runId, ...result });
        })
        .catch(async (err: any) => {
          await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, err.message);
          this.writeLog(orgId, run.runId, taskId, 'ERROR', `Daily digest failed: ${err.message}`);

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId, runId: run.runId, triggerRunId, status: 'FAILED', error: err.message,
          });

          logger.error('Daily digest failed', { taskId, runId: run.runId, error: err.message });
        });
    } else {
      await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, `Unknown user-event task: ${taskId}`);
    }

    return {
      id: triggerRunId,
      runId: triggerRunId,
      status: 'EXECUTING',
      localRunId: run.runId,
      taskId,
    };
  }

  /**
   * Handle ProseCreator tasks in-process — calls Claude Max Proxy directly.
   * No external routing. Blueprint generation uses skill instructions + project data.
   */
  private async handleProseCreatorTask(
    orgId: string,
    userId: string,
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    // Auto-provision a project record if needed (run_history FK requires it).
    // Insert with the ProseCreator project UUID so the FK matches.
    const existingProject = await this.projectRepo.findById(projectId, orgId);
    if (!existingProject) {
      await this.projectRepo.createWithId(projectId, {
        organizationId: orgId,
        userId,
        triggerProjectRef: `prosecreator-${projectId}`,
        triggerProjectName: 'ProseCreator',
        environment: 'production',
        mode: 'self-hosted',
      });
      logger.info('Auto-provisioned Nexus Workflows project for ProseCreator', { projectId, orgId });
    }

    const triggerRunId = `pc-${randomUUID()}`;
    const startedAt = new Date();

    const run = await this.runRepo.create({
      triggerRunId,
      projectId,
      organizationId: orgId,
      taskIdentifier: taskId,
      status: 'EXECUTING',
      payload,
      startedAt,
      idempotencyKey: options?.idempotencyKey,
      metadata: {
        ...options?.metadata,
        source: 'prosecreator',
        userId,
        projectId,
        skillId: payload?.inputData?.skill_id || payload?.payload?.inputData?.skill_id,
      },
      tags: options?.tags || ['prosecreator'],
    });

    await this.usageRepo.record(orgId, 'task_trigger', {
      taskId,
      projectId,
      runId: run.runId,
    });

    triggerTasksTriggered.inc({ task_id: taskId, organization_id: orgId });

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
      taskId,
      runId: run.runId,
      triggerRunId,
      status: 'EXECUTING',
    });

    this.writeLog(orgId, run.runId, taskId, 'INFO', `ProseCreator task triggered: ${taskId}`, { triggerRunId });

    logger.info('ProseCreator task triggered (in-process)', {
      taskId, runId: run.runId, triggerRunId, orgId,
    });

    // Extract the actual payload (may be nested under .payload from ProseCreator)
    const taskPayload = payload?.payload || payload;

    // Run async — don't block the HTTP response
    if (taskId === 'prosecreator-document-ingest') {
      // Document ingestion routes to FileProcess SmartRouter (not Claude proxy)
      this.handleDocumentIngestTask(run.runId, triggerRunId, taskId, taskPayload, orgId)
        .catch((err) => {
          logger.error('Document ingest async handler error', { taskId, runId: run.runId, error: String(err) });
        });
    } else if (
      taskId === 'prosecreator-panel-analysis' ||
      taskId === 'prosecreator-novel-import' ||
      taskId === 'prosecreator-world-building' ||
      taskId === 'prosecreator-document-to-research' ||
      taskId.startsWith('prosecreator-full-ingest-') ||
      // Tier 1: LLM-only tasks (job queue migration Phase 1)
      taskId === 'prosecreator-research-generate' ||
      taskId === 'prosecreator-research-refine' ||
      taskId === 'prosecreator-claim-validation' ||
      taskId === 'prosecreator-index-generation' ||
      taskId.startsWith('prosecreator-publication-') ||
      taskId.startsWith('prosecreator-constitution-') ||
      taskId === 'prosecreator-character-evolution' ||
      taskId === 'prosecreator-tts-voice-profile'
    ) {
      // Panel analysis, novel import, world-building, document-to-research,
      // full-ingest pipeline stages, and all Tier 1 LLM-only tasks.
      // Route directly through Claude Max Proxy instead of the blueprint handler.
      this.handlePanelAnalysisTask(run.runId, triggerRunId, taskId, taskPayload, orgId)
        .catch((err) => {
          logger.error('Panel analysis async handler error', { taskId, runId: run.runId, error: String(err) });
        });
    } else if (
      // Tier 2: Callback tasks (job queue migration Phase 2)
      // These call back to ProseCreator's internal execute endpoint
      // for full ServiceContainer access (generation, analysis, canvas, audiobook, forge).
      taskId === 'prosecreator-beat-generation' ||
      taskId === 'prosecreator-chapter-generation' ||
      taskId === 'prosecreator-blueprint-generation' ||
      taskId === 'prosecreator-analysis' ||
      taskId === 'prosecreator-critique' ||
      taskId === 'prosecreator-room-persona' ||
      taskId === 'prosecreator-character-bible' ||
      taskId === 'prosecreator-character-bible-section' ||
      taskId.startsWith('prosecreator-canvas-') ||
      taskId.startsWith('prosecreator-audiobook-') ||
      taskId.startsWith('prosecreator-forge-') ||
      taskId === 'prosecreator-github-scaffold-callback'
    ) {
      this.handleCallbackTask(run.runId, triggerRunId, taskId, taskPayload, orgId)
        .catch((err) => {
          logger.error('Callback task async handler error', { taskId, runId: run.runId, error: String(err) });
        });
    } else {
      // All other prosecreator tasks use the blueprint handler
      const handler = new ProseCreatorTaskHandler(orgId, userId);
      handler.generateBlueprint(taskPayload)
        .then(async (result) => {
          await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
            blueprint: result.blueprint,
            durationMs: result.durationMs,
            model: result.model,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId: run.runId,
            triggerRunId,
            status: 'COMPLETED',
            output: result.blueprint,
          });

          this.writeLog(orgId, run.runId, taskId, 'INFO', `ProseCreator task completed`, { durationMs: result.durationMs, model: result.model });

          logger.info('ProseCreator task completed', {
            taskId, runId: run.runId, durationMs: result.durationMs,
            contentSize: JSON.stringify(result.blueprint).length,
          });
        })
        .catch(async (err) => {
          const structured = (err as any).structuredError || classifyError(err, 'prosecreator');
          const errMsg = structured.message;

          await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, errMsg);
          await this.runRepo.mergeMetadata(run.runId, { structuredError: structured }).catch(() => {});

          this.writeLog(orgId, run.runId, taskId, 'ERROR', `ProseCreator task failed: ${errMsg}`, {
            errorCode: structured.code,
            errorCategory: structured.category,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId: run.runId,
            triggerRunId,
            status: 'FAILED',
            error: errMsg,
            structuredError: structured,
          });

          logger.error('ProseCreator task failed', {
            taskId, runId: run.runId,
            error: errMsg,
            errorCode: structured.code,
            errorCategory: structured.category,
          });
        });
    }

    return {
      id: triggerRunId,
      runId: triggerRunId,
      status: 'EXECUTING',
      localRunId: run.runId,
      taskId,
    };
  }

  /**
   * Handle panel analysis tasks by calling Claude Max Proxy directly with
   * the caller-supplied system message and prompt. Stores result with
   * `content` key (not `blueprint`) so the prosecreator polling code can
   * extract it via `output.content`.
   */
  private async handlePanelAnalysisTask(
    runId: string,
    triggerRunId: string,
    taskId: string,
    payload: any,
    orgId: string,
  ): Promise<void> {
    const startTime = Date.now();
    const proxyUrl = process.env.CLAUDE_CODE_PROXY_URL
      || process.env.LLM_CLAUDE_CODE_PROXY_URL
      || 'http://claude-code-proxy.nexus.svc.cluster.local:3100';
    const model = process.env.CLAUDE_BLUEPRINT_MODEL || 'claude-opus-4-6';

    const systemMessage = payload.systemMessage || '';
    const prompt = payload.prompt || '';
    const maxTokens = payload.maxTokens || 8000;
    const temperature = payload.temperature ?? 0.3;

    logger.info('Panel analysis task starting', {
      taskId, runId, orgId,
      analysisType: payload.analysisType,
      promptLen: prompt.length,
      maxTokens,
    });

    try {
      const controller = new AbortController();
      const fetchTimeoutMs = maxTokens > 16000 ? 480000 : 150000;
      const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);

      let res: any;
      try {
        const fetchRes = await fetch(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemMessage },
              { role: 'user', content: prompt },
            ],
            max_tokens: maxTokens,
            temperature,
          }),
          signal: controller.signal,
        });

        if (!fetchRes.ok) {
          const errText = await fetchRes.text().catch(() => '');
          throw new Error(`Claude proxy error ${fetchRes.status}: ${errText.slice(0, 300)}`);
        }

        res = await fetchRes.json();
      } finally {
        clearTimeout(timeout);
      }

      const content = res.choices?.[0]?.message?.content || '';
      const durationMs = Date.now() - startTime;

      logger.info('Panel analysis task completed', {
        taskId, runId, orgId,
        analysisType: payload.analysisType,
        durationMs,
        contentLen: content.length,
        finishReason: res.choices?.[0]?.finish_reason,
        model: res.model,
      });

      await this.runRepo.updateStatus(runId, 'COMPLETED', {
        content,
        model: res.model || model,
        usage: res.usage || {},
        analysisType: payload.analysisType,
        durationMs,
      });

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'COMPLETED',
      });

      this.writeLog(orgId, runId, taskId, 'INFO', `Panel analysis completed`, {
        durationMs,
        contentLen: content.length,
        analysisType: payload.analysisType,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      logger.error('Panel analysis task failed', {
        taskId, runId, orgId,
        analysisType: payload.analysisType,
        error: errMsg,
        durationMs,
      });

      await this.runRepo.updateStatus(runId, 'FAILED', undefined, errMsg);

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'FAILED',
        error: errMsg,
      });

      this.writeLog(orgId, runId, taskId, 'ERROR', `Panel analysis failed: ${errMsg}`);
    }
  }

  /**
   * Handle document ingestion tasks by calling FileProcess SmartRouter.
   * This is NOT an LLM task \u2014 it calls FileProcess for OCR/extraction,
   * which routes through MageAgent for real document processing.
   *
   * Payload shape:
   *   { file_url: string, filename: string, document_id: string, project_id: string, user_id: string }
   *
   * For URL-based processing (Google Drive, HTTP):
   *   Calls POST /api/process/url on nexus-fileprocess
   *
   * Returns extracted content, entities, and GraphRAG document ID in the run output.
   */
  private async handleDocumentIngestTask(
    runId: string,
    triggerRunId: string,
    taskId: string,
    payload: any,
    orgId: string,
  ): Promise<void> {
    const startTime = Date.now();
    const fileprocessUrl = process.env.FILEPROCESS_ENDPOINT
      || 'http://nexus-fileprocess.nexus.svc.cluster.local:9109';

    const fileUrl = payload.file_url || payload.fileUrl;
    const filename = payload.filename || 'document';
    const documentId = payload.document_id || payload.documentId;
    const projectId = payload.project_id || payload.projectId;
    const userId = payload.user_id || payload.userId;

    logger.info('Document ingest task starting', {
      taskId, runId, orgId,
      documentId, filename,
      hasUrl: !!fileUrl,
    });

    try {
      if (!fileUrl) {
        throw new Error('file_url is required for document ingestion');
      }

      // Step 1: Submit to FileProcess SmartRouter via URL endpoint
      const submitRes = await fetch(`${fileprocessUrl}/api/process/url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Company-ID': orgId || 'adverant',
          'X-App-ID': 'prosecreator',
          'X-User-ID': userId || 'system',
        },
        body: JSON.stringify({
          fileUrl,
          filename,
          metadata: {
            source: 'prosecreator-document-ingest',
            documentId,
            projectId,
            userId,
          },
        }),
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text().catch(() => '');
        throw new Error(`FileProcess submit error ${submitRes.status}: ${errText.slice(0, 500)}`);
      }

      const submitData: any = await submitRes.json();
      const jobId = submitData.jobId || submitData.job_id || submitData.id;

      if (!jobId) {
        throw new Error(`FileProcess returned no jobId: ${JSON.stringify(submitData).slice(0, 500)}`);
      }

      logger.info('Document submitted to FileProcess', {
        taskId, runId, jobId, documentId,
      });

      // Step 2: Poll FileProcess job until completion
      const pollIntervalMs = 5000;
      const maxPollTimeMs = 270000; // 4.5 minutes (leave buffer before 5min task timeout)
      let elapsed = 0;

      while (elapsed < maxPollTimeMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        elapsed += pollIntervalMs;

        const statusRes = await fetch(`${fileprocessUrl}/api/jobs/${jobId}`, {
          headers: {
            'X-Company-ID': orgId || 'adverant',
            'X-App-ID': 'prosecreator',
            'X-User-ID': userId || 'system',
          },
        });

        if (!statusRes.ok) {
          logger.warn('FileProcess job poll failed', { jobId, status: statusRes.status });
          continue;
        }

        const statusData: any = await statusRes.json();
        const jobStatus = statusData.job?.status || statusData.status;

        if (jobStatus === 'completed' || jobStatus === 'finished' || jobStatus === 'success') {
          const job = statusData.job || statusData;
          const extractedContent = job.extractedContent || job.content || job.text || '';
          const entities = job.metadata?.entities || [];
          const documentDnaId = job.documentDnaId || null;
          const graphragDocId = job.graphragDocumentId || null;
          const pageCount = job.metadata?.pageCount || 0;
          const wordCount = job.metadata?.wordCount || 0;
          const durationMs = Date.now() - startTime;

          logger.info('Document ingest task completed', {
            taskId, runId, orgId, documentId, jobId,
            durationMs,
            contentLen: extractedContent.length,
            entityCount: entities.length,
            pageCount, wordCount,
          });

          await this.runRepo.updateStatus(runId, 'COMPLETED', {
            content: extractedContent,
            document_id: documentId,
            fileprocess_job_id: jobId,
            document_dna_id: documentDnaId,
            graphrag_document_id: graphragDocId,
            entities,
            page_count: pageCount,
            word_count: wordCount,
            durationMs,
          });

          emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
            taskId,
            runId,
            triggerRunId,
            status: 'COMPLETED',
          });

          this.writeLog(orgId, runId, taskId, 'INFO', `Document ingest completed`, {
            durationMs, documentId, jobId,
            contentLen: extractedContent.length,
            entityCount: entities.length,
          });

          return;
        }

        if (jobStatus === 'failed' || jobStatus === 'error') {
          const errMsg = statusData.job?.errorMessage || statusData.errorMessage || 'FileProcess extraction failed';
          throw new Error(errMsg);
        }

        // Still processing \u2014 continue polling
        logger.debug('Document ingest polling', {
          taskId, runId, jobId, jobStatus, elapsed,
        });
      }

      // Timeout
      throw new Error(`FileProcess job ${jobId} did not complete within ${maxPollTimeMs / 1000}s`);

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errMsg = err.message || String(err);

      const structured = classifyError(err, 'prosecreator');

      await this.runRepo.updateStatus(runId, 'FAILED', undefined, errMsg);
      await this.runRepo.mergeMetadata(runId, {
        structuredError: structured,
        document_id: documentId,
        durationMs,
      }).catch(() => {});

      this.writeLog(orgId, runId, taskId, 'ERROR', `Document ingest failed: ${errMsg}`, {
        errorCode: structured.code,
        errorCategory: structured.category,
        documentId,
      });

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId,
        runId,
        triggerRunId,
        status: 'FAILED',
        error: errMsg,
        structuredError: structured,
      });

      logger.error('Document ingest task failed', {
        taskId, runId, orgId, documentId,
        error: errMsg,
        durationMs,
      });
    }
  }

  /**
   * Handle Tier 2 callback tasks by calling ProseCreator's internal execute endpoint.
   *
   * Flow:
   *   1. POST to ProseCreator /prosecreator/api/internal/execute with job_type + input_params
   *   2. Poll /prosecreator/api/internal/execute/:executionId/status until completion
   *   3. Update run status with result or error
   *
   * This enables Nexus Workflows to orchestrate jobs that require ProseCreator's full
   * ServiceContainer (14 repositories, ProseGenerator, BlueprintManager, etc.).
   */
  private async handleCallbackTask(
    runId: string,
    triggerRunId: string,
    taskId: string,
    payload: any,
    orgId: string,
  ): Promise<void> {
    const startTime = Date.now();
    const prosecreatorUrl = process.env.PROSECREATOR_ENDPOINT
      || 'http://nexus-prosecreator.nexus.svc.cluster.local:3000';
    const serviceKey = process.env.NEXUS_TRIGGER_SERVICE_KEY
      || process.env.INTERNAL_SERVICE_KEY
      || '';

    // Map task ID to ProseCreator job_type
    const jobType = this.resolveCallbackJobType(taskId);

    logger.info('Callback task starting', {
      taskId, runId, orgId, jobType,
      hasInputParams: !!payload?.inputParams,
    });

    try {
      // Step 1: Submit execution request to ProseCreator
      const submitRes = await fetch(`${prosecreatorUrl}/prosecreator/api/internal/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': serviceKey,
        },
        body: JSON.stringify({
          job_type: jobType,
          input_params: payload?.inputParams || payload?.input_params || payload || {},
          run_id: `trigger-${taskId}-${Date.now()}`,
          user_id: payload?.userId || payload?.user_id,
          project_id: payload?.projectId || payload?.project_id,
        }),
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text().catch(() => '');
        throw new Error(`ProseCreator execute failed (${submitRes.status}): ${errText.slice(0, 500)}`);
      }

      const submitData: any = await submitRes.json();
      const executionId = submitData.execution_id || submitData.executionId || submitData.id;

      if (!executionId) {
        throw new Error(`ProseCreator returned no execution_id: ${JSON.stringify(submitData).slice(0, 500)}`);
      }

      logger.info('Callback task accepted by ProseCreator', {
        taskId, runId, executionId, jobType,
      });

      await this.runRepo.mergeMetadata(runId, {
        executionId,
        jobType,
        prosecreatorUrl,
      }).catch(() => {});

      // Step 2: Poll for completion
      const timeoutMs = this.resolveCallbackTimeout(taskId);
      const pollIntervalMs = timeoutMs > 900000 ? 10000 : 5000; // Longer poll for long-running tasks
      const pollStart = Date.now();

      while (Date.now() - pollStart < timeoutMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs));

        try {
          const statusRes = await fetch(
            `${prosecreatorUrl}/prosecreator/api/internal/execute/${executionId}/status`,
            {
              headers: { 'x-service-key': serviceKey },
            }
          );

          if (!statusRes.ok) {
            logger.warn('Callback task status poll failed', {
              taskId, runId, executionId, status: statusRes.status,
            });
            continue;
          }

          const statusData: any = await statusRes.json();
          const jobStatus = statusData.status;

          if (jobStatus === 'completed') {
            const durationMs = Date.now() - startTime;

            logger.info('Callback task completed', {
              taskId, runId, orgId, executionId, jobType, durationMs,
            });

            await this.runRepo.updateStatus(runId, 'COMPLETED', {
              content: statusData.result || statusData.output,
              executionId,
              jobType,
              durationMs,
            });

            emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
              taskId, runId, triggerRunId, status: 'COMPLETED',
            });

            this.writeLog(orgId, runId, taskId, 'INFO', `Callback task completed`, {
              durationMs, executionId, jobType,
            });

            return;
          }

          if (jobStatus === 'failed' || jobStatus === 'error') {
            const errMsg = statusData.error || statusData.message || 'Job failed on ProseCreator';
            throw new Error(errMsg);
          }

          // Still processing — log progress if available
          if (statusData.progress !== undefined) {
            logger.debug('Callback task polling', {
              taskId, runId, executionId, jobStatus,
              progress: statusData.progress,
              elapsed: Date.now() - pollStart,
            });
          }
        } catch (err) {
          // Re-throw if this is a definitive failure (not a transient poll error)
          if (err instanceof Error && (
            err.message.includes('Job failed on ProseCreator') ||
            err.message.includes('failed:')
          )) {
            throw err;
          }
          logger.warn('Callback task poll error, retrying', {
            taskId, runId, executionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Timeout
      throw new Error(`Callback task timed out after ${timeoutMs}ms (executionId=${executionId})`);

    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const errMsg = err.message || String(err);
      const structured = classifyError(err, 'prosecreator');

      logger.error('Callback task failed', {
        taskId, runId, orgId, jobType,
        error: errMsg,
        durationMs,
      });

      await this.runRepo.updateStatus(runId, 'FAILED', undefined, errMsg);
      await this.runRepo.mergeMetadata(runId, {
        structuredError: structured,
        jobType,
        durationMs,
      }).catch(() => {});

      this.writeLog(orgId, runId, taskId, 'ERROR', `Callback task failed: ${errMsg}`, {
        errorCode: structured.code,
        errorCategory: structured.category,
        jobType,
      });

      emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
        taskId, runId, triggerRunId,
        status: 'FAILED',
        error: errMsg,
        structuredError: structured,
      });
    }
  }

  /**
   * Map a Tier 2 task ID to the corresponding ProseCreator job_type string.
   * The job_type is what ProseCreator's internal execute endpoint expects.
   */
  private resolveCallbackJobType(taskId: string): string {
    // Direct mappings
    const directMap: Record<string, string> = {
      'prosecreator-beat-generation': 'beat',
      'prosecreator-chapter-generation': 'chapter',
      'prosecreator-blueprint-generation': 'blueprint',
      'prosecreator-analysis': 'analysis',
      'prosecreator-critique': 'critique',
      'prosecreator-room-persona': 'room_persona',
      'prosecreator-character-bible': 'character_bible',
      'prosecreator-character-bible-section': 'character_bible_section',
      'prosecreator-github-scaffold-callback': 'github_repo_scaffold',
    };

    if (directMap[taskId]) return directMap[taskId];

    // Prefix-based mappings: prosecreator-canvas-brainstorm -> canvas_brainstorm
    if (taskId.startsWith('prosecreator-canvas-')) {
      return 'canvas_' + taskId.replace('prosecreator-canvas-', '');
    }
    if (taskId.startsWith('prosecreator-audiobook-')) {
      return 'audiobook_' + taskId.replace('prosecreator-audiobook-', '');
    }
    if (taskId.startsWith('prosecreator-forge-')) {
      return 'forge_' + taskId.replace('prosecreator-forge-', '');
    }

    // Fallback: strip prosecreator- prefix and replace dashes with underscores
    return taskId.replace('prosecreator-', '').replace(/-/g, '_');
  }

  /**
   * Resolve the appropriate poll timeout for a Tier 2 callback task.
   * Longer timeouts for generation-heavy tasks.
   */
  private resolveCallbackTimeout(taskId: string): number {
    const timeouts: Record<string, number> = {
      'prosecreator-beat-generation': 600000,        // 10 min
      'prosecreator-chapter-generation': 1500000,    // 25 min
      'prosecreator-blueprint-generation': 900000,   // 15 min
      'prosecreator-character-bible': 1800000,       // 30 min
      'prosecreator-character-bible-section': 1500000, // 25 min
      'prosecreator-audiobook-full': 1800000,        // 30 min
      'prosecreator-audiobook-chapter': 1500000,     // 25 min
      'prosecreator-audiobook-assemble': 900000,     // 15 min
      'prosecreator-audiobook-export': 900000,       // 15 min
    };

    if (timeouts[taskId]) return timeouts[taskId];

    // Forge tasks: 15 min
    if (taskId.startsWith('prosecreator-forge-')) return 900000;
    // Canvas tasks: 5 min
    if (taskId.startsWith('prosecreator-canvas-')) return 300000;
    // GitHub scaffold: 15 min
    if (taskId === 'prosecreator-github-scaffold-callback') return 900000;

    // Default: 5 min
    return 300000;
  }

  async batchTrigger(
    orgId: string,
    projectId: string,
    items: BatchTriggerItem[]
  ): Promise<any> {
    const project = await this.projectRepo.findById(projectId, orgId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    const result = await this.proxy.batchTrigger(items);

    const runs = result.runs || result.items || [];
    for (const runData of runs) {
      const triggerRunId = runData.id || runData.runId;
      const taskIdentifier = runData.taskIdentifier || runData.task;

      await this.runRepo.create({
        triggerRunId,
        projectId,
        organizationId: orgId,
        taskIdentifier,
        status: runData.status || 'QUEUED',
        payload: runData.payload,
      });

      this.runStreamManager.trackRun(triggerRunId, triggerRunId, orgId, taskIdentifier);
    }

    await this.usageRepo.record(orgId, 'batch_trigger', {
      projectId,
      count: items.length,
    });

    emitToOrg(this.io, orgId, WS_EVENTS.TASK_BATCH_TRIGGERED, {
      count: items.length,
      batchId: result.batchId || result.id,
      taskIdentifiers: items.map((i) => i.taskIdentifier),
    });

    this.writeLog(orgId, result.batchId || 'batch', items[0]?.taskIdentifier || 'batch', 'INFO', `Batch triggered: ${items.length} items`, { projectId, taskIdentifiers: items.map(i => i.taskIdentifier) });

    logger.info('Batch triggered', {
      orgId,
      projectId,
      count: items.length,
    });

    return result;
  }

  async updateExecutionTarget(
    orgId: string,
    taskDefId: string,
    executionType: string,
    executionTarget: Record<string, unknown>
  ): Promise<any> {
    return this.taskDefRepo.updateExecutionTarget(orgId, taskDefId, executionType, executionTarget);
  }

  async getTaskById(orgId: string, taskDefId: string): Promise<any | null> {
    // Try UUID lookup first, then fall back to slug (task_identifier) lookup
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(taskDefId)) {
      return this.taskDefRepo.findById(taskDefId, orgId);
    }
    // Not a UUID — treat as task_identifier slug
    return this.taskDefRepo.findBySlug(taskDefId, orgId);
  }

  async listTaskDefinitions(orgId: string, projectId?: string): Promise<any[]> {
    if (projectId) {
      return this.taskDefRepo.findByProject(projectId, orgId);
    }
    return this.taskDefRepo.findByOrg(orgId);
  }

  async syncTaskDefinitions(orgId: string, projectId: string): Promise<any[]> {
    const project = await this.projectRepo.findById(projectId, orgId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    // Trigger.dev v3 lists tasks via the runs endpoint (task identifiers from recent runs)
    // or via project metadata. We'll sync from recent run data.
    const runsResult = await this.proxy.listRuns({ limit: 100 });
    const runs = runsResult.data || runsResult.runs || [];

    const taskIdentifiers = new Set<string>();
    const synced: any[] = [];

    for (const run of runs) {
      const taskId = run.taskIdentifier || run.task;
      if (!taskId || taskIdentifiers.has(taskId)) continue;
      taskIdentifiers.add(taskId);

      const upsertData: UpsertTaskDefinitionData = {
        projectId,
        organizationId: orgId,
        taskIdentifier: taskId,
        taskVersion: run.version,
        queueName: run.queue,
      };

      const def = await this.taskDefRepo.upsert(upsertData);
      synced.push(def);
    }

    logger.info('Task definitions synced', {
      orgId,
      projectId,
      count: synced.length,
    });

    return synced;
  }

  /**
   * Recover Skills Engine runs orphaned by pod restarts.
   * Checks if the Skills Engine job completed while this pod was down
   * and updates the run record accordingly.
   */
  async recoverOrphanedSkillsEngineRuns(staleMinutes: number = 5): Promise<number> {
    const orphanedRuns = await this.runRepo.findOrphanedSkillsEngineRuns(staleMinutes);

    if (orphanedRuns.length === 0) return 0;

    logger.info('Found orphaned Skills Engine runs to recover', { count: orphanedRuns.length });

    let recovered = 0;
    for (const run of orphanedRuns) {
      try {
        const metadata = run.metadata || {};
        const jobId = metadata.jobId;

        if (!jobId) {
          // No jobId means startGeneration never returned — mark as failed
          logger.warn('Orphaned run has no jobId, marking as FAILED', { runId: run.runId });
          await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, 'Orphaned: no jobId (pod restarted before Skills Engine responded)');
          this.writeLog(run.organizationId, run.runId, run.taskIdentifier, 'ERROR', 'Orphaned run: no jobId (pod restarted)');
          recovered++;
          continue;
        }

        // Check the job status on Skills Engine
        const handler = new SkillsEngineTaskHandler(
          run.organizationId,
          metadata.userId || 'system'
        );

        const jobStatus = await handler.checkJobStatus(jobId);

        if (jobStatus.status === 'completed') {
          await this.runRepo.updateStatus(run.runId, 'COMPLETED', {
            jobId,
            skillEntityId: jobStatus.skillEntityId,
            phases: jobStatus.phases,
            recoveredOnStartup: true,
          });
          logger.info('Recovered completed Skills Engine run', {
            runId: run.runId,
            jobId,
            skillEntityId: jobStatus.skillEntityId,
          });
        } else if (['failed', 'error', 'cancelled', 'canceled'].includes(jobStatus.status)) {
          await this.runRepo.updateStatus(
            run.runId,
            'FAILED',
            undefined,
            jobStatus.error || `Job ended with status: ${jobStatus.status}`
          );
          logger.info('Recovered failed Skills Engine run', { runId: run.runId, jobId, status: jobStatus.status });
        } else {
          // Still running — resume polling
          const operationId = metadata.operationId || '';
          logger.info('Resuming polling for in-progress Skills Engine run', { runId: run.runId, jobId });
          this.pollSkillsEngineAsync(
            handler,
            run.taskIdentifier,
            jobId,
            operationId,
            run.runId,
            run.triggerRunId,
            run.organizationId,
            metadata.userId || 'system'
          ).catch((err) => {
            logger.error('Resumed polling failed', { runId: run.runId, error: err.message });
          });
        }

        recovered++;
      } catch (err: any) {
        logger.error('Failed to recover orphaned run', { runId: run.runId, error: err.message });
      }
    }

    return recovered;
  }

  async storeInGraphRAG(
    orgId: string,
    userId: string,
    taskId: string,
    payload: any,
    result: any
  ): Promise<void> {
    const graphragUrl = this.nexusConfig.services.graphrag;
    if (!graphragUrl) {
      logger.debug('GraphRAG URL not configured, skipping storage');
      return;
    }

    try {
      const document = {
        content: JSON.stringify({
          taskId,
          payload,
          result: {
            id: result.id,
            status: result.status,
            output: result.output,
          },
          timestamp: new Date().toISOString(),
        }),
        metadata: {
          source: 'trigger-dev',
          type: 'task_run',
          taskId,
          organizationId: orgId,
        },
      };

      await axios.post(`${graphragUrl}/api/v1/documents`, document, {
        headers: {
          'Content-Type': 'application/json',
          'X-Company-ID': orgId,
          'X-App-ID': 'nexus-trigger',
          'X-User-ID': userId,
        },
        timeout: 10000,
      });

      logger.debug('Stored task run in GraphRAG', { taskId, orgId });
    } catch (error: any) {
      logger.warn('Failed to store in GraphRAG', { error: error.message, taskId, orgId });
    }
  }
}
