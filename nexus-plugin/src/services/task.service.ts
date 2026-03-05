import axios from 'axios';
import { randomUUID } from 'crypto';
import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService, TriggerTaskOptions, BatchTriggerItem } from './trigger-proxy.service';
import { SkillsEngineTaskHandler } from './skills-engine-task-handler';
import { ProseCreatorTaskHandler } from './prosecreator-task-handler';
import { syncPlatformKnowledge } from '../task-definitions/platform-knowledge-tasks';
import { ProjectRepository, Project } from '../database/repositories/project.repository';
import { RunRepository, CreateRunData } from '../database/repositories/run.repository';
import { TaskDefinitionRepository, UpsertTaskDefinitionData } from '../database/repositories/task-definition.repository';
import { UsageRepository } from '../database/repositories/usage.repository';
import { NexusConfig } from '../config';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { RunStreamManager } from '../websocket/run-stream';
import { createLogger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';
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
    private runStreamManager: RunStreamManager
  ) {}

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

    // Skills Engine tasks are handled directly (not proxied to cloud workers)
    if (taskId.startsWith('skills-engine-')) {
      return this.handleSkillsEngineTask(orgId, userId, projectId, taskId, payload, options);
    }

    // Platform Knowledge tasks run locally
    if (taskId.startsWith('platform-knowledge-')) {
      return this.handlePlatformKnowledgeTask(orgId, userId, projectId, taskId, payload, options);
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

      logger.info('Skills Engine task completed', { taskId, runId, skillEntityId: result.skillEntityId });
    } catch (error: any) {
      await this.runRepo.updateStatus(runId, 'FAILED', undefined, error.message);

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

      logger.info('Skills Engine batch regeneration completed', { taskId, runId, total: result.total });
    } catch (error: any) {
      await this.runRepo.updateStatus(runId, 'FAILED', undefined, error.message);

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

    logger.info('ProseCreator task triggered (in-process)', {
      taskId, runId: run.runId, triggerRunId, orgId,
    });

    // Extract the actual payload (may be nested under .payload from ProseCreator)
    const taskPayload = payload?.payload || payload;

    // Run async — don't block the HTTP response
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

        logger.info('ProseCreator task completed', {
          taskId, runId: run.runId, durationMs: result.durationMs,
          contentSize: JSON.stringify(result.blueprint).length,
        });
      })
      .catch(async (err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.runRepo.updateStatus(run.runId, 'FAILED', undefined, errMsg);

        emitToOrg(this.io, orgId, WS_EVENTS.TASK_TRIGGERED, {
          taskId,
          runId: run.runId,
          triggerRunId,
          status: 'FAILED',
          error: errMsg,
        });

        logger.error('ProseCreator task failed', { taskId, runId: run.runId, error: errMsg });
      });

    return {
      id: triggerRunId,
      runId: triggerRunId,
      status: 'EXECUTING',
      localRunId: run.runId,
      taskId,
    };
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

    logger.info('Batch triggered', {
      orgId,
      projectId,
      count: items.length,
    });

    return result;
  }

  async getTaskById(orgId: string, taskDefId: string): Promise<any | null> {
    return this.taskDefRepo.findById(taskDefId, orgId);
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
