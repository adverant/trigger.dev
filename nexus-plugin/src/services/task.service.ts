import axios from 'axios';
import { Server as SocketIOServer } from 'socket.io';
import { TriggerProxyService, TriggerTaskOptions, BatchTriggerItem } from './trigger-proxy.service';
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
    projectId: string,
    taskId: string,
    payload: any,
    options?: TriggerTaskOptions
  ): Promise<any> {
    const project = await this.projectRepo.findById(projectId, orgId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
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
    this.storeInGraphRAG(orgId, taskId, payload, result).catch((err) => {
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

  async storeInGraphRAG(
    orgId: string,
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
          'X-Organization-ID': orgId,
        },
        timeout: 10000,
      });

      logger.debug('Stored task run in GraphRAG', { taskId, orgId });
    } catch (error: any) {
      logger.warn('Failed to store in GraphRAG', { error: error.message, taskId, orgId });
    }
  }
}
