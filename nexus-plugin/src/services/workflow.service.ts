/**
 * Workflow Service
 *
 * CRUD and execution management for Nexus Workflows.
 * Powered by Trigger.dev (https://trigger.dev)
 */

import { Server as SocketIOServer } from 'socket.io';
import {
  WorkflowRepository,
  Workflow,
  WorkflowRun,
  CreateWorkflowData,
  UpdateWorkflowData,
  WorkflowFilters,
} from '../database/repositories/workflow.repository';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';

const logger = createLogger({ component: 'workflow-service' });

/**
 * Generate a universal job ID: nxj_<ulid-like>
 * Uses timestamp + random for sortability and uniqueness.
 */
function generateJobId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36)
  )
    .join('')
    .toUpperCase();
  return `nxj_${timestamp}${random}`;
}

export class WorkflowService {
  constructor(
    private workflowRepo: WorkflowRepository,
    private io: SocketIOServer
  ) {}

  // ── Workflow CRUD ──────────────────────────────────────────────────

  async createWorkflow(
    orgId: string,
    userId: string,
    data: {
      name: string;
      description?: string;
      definition: Record<string, any>;
      projectId?: string;
      isTemplate?: boolean;
      tags?: string[];
    }
  ): Promise<Workflow> {
    if (!data.name?.trim()) {
      throw new ValidationError('Workflow name is required');
    }

    const workflow = await this.workflowRepo.create({
      organizationId: orgId,
      userId,
      projectId: data.projectId,
      name: data.name.trim(),
      description: data.description?.trim(),
      definition: data.definition,
      isTemplate: data.isTemplate,
      tags: data.tags,
      status: 'draft',
    });

    logger.info('Workflow created', {
      workflowId: workflow.workflowId,
      name: workflow.name,
      orgId,
    });

    emitToOrg(this.io, orgId, WS_EVENTS.WORKFLOW_CREATED, {
      workflowId: workflow.workflowId,
      name: workflow.name,
    });

    return workflow;
  }

  async getWorkflow(workflowId: string): Promise<Workflow> {
    const workflow = await this.workflowRepo.findById(workflowId);
    if (!workflow) throw new NotFoundError(`Workflow ${workflowId} not found`);
    return workflow;
  }

  async listWorkflows(
    orgId: string,
    filters: WorkflowFilters = {}
  ): Promise<{ workflows: Workflow[]; total: number }> {
    return this.workflowRepo.findByOrg(orgId, filters);
  }

  async updateWorkflow(
    workflowId: string,
    data: UpdateWorkflowData
  ): Promise<Workflow> {
    const workflow = await this.workflowRepo.update(workflowId, data);
    if (!workflow) throw new NotFoundError(`Workflow ${workflowId} not found`);

    logger.info('Workflow updated', { workflowId, fields: Object.keys(data) });
    return workflow;
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const deleted = await this.workflowRepo.delete(workflowId);
    if (!deleted) throw new NotFoundError(`Workflow ${workflowId} not found`);
    logger.info('Workflow deleted', { workflowId });
  }

  async publishWorkflow(workflowId: string): Promise<Workflow> {
    return this.updateWorkflow(workflowId, { status: 'published' });
  }

  async duplicateWorkflow(
    workflowId: string,
    userId: string,
    newName?: string
  ): Promise<Workflow> {
    const original = await this.getWorkflow(workflowId);
    const name = newName || `${original.name} (copy)`;
    const duplicate = await this.workflowRepo.duplicate(workflowId, userId, name);
    if (!duplicate) throw new NotFoundError(`Workflow ${workflowId} not found`);
    logger.info('Workflow duplicated', { originalId: workflowId, newId: duplicate.workflowId });
    return duplicate;
  }

  async listTemplates(
    filters: WorkflowFilters = {}
  ): Promise<{ workflows: Workflow[]; total: number }> {
    return this.workflowRepo.findTemplates(filters);
  }

  // ── Workflow Runs ──────────────────────────────────────────────────

  async startRun(
    workflowId: string,
    orgId: string,
    userId: string,
    parameters: Record<string, any> = {},
    metadata: Record<string, any> = {}
  ): Promise<WorkflowRun> {
    const workflow = await this.getWorkflow(workflowId);

    const runId = generateJobId();

    const run = await this.workflowRepo.createRun({
      runId,
      workflowId,
      organizationId: orgId,
      userId,
      definitionSnapshot: workflow.definition,
      parameters,
      metadata,
      tags: workflow.tags,
    });

    logger.info('Workflow run started', { runId, workflowId, orgId });

    emitToOrg(this.io, orgId, WS_EVENTS.WORKFLOW_RUN_STARTED, {
      runId,
      workflowId,
      name: workflow.name,
    });

    // TODO: Phase 3 — dispatch workflow execution engine here
    // For now, the run is created in 'queued' status

    return run;
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    const run = await this.workflowRepo.findRunById(runId);
    if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
    return run;
  }

  async listRuns(
    workflowId: string,
    limit = 20,
    offset = 0
  ): Promise<WorkflowRun[]> {
    return this.workflowRepo.findRunsByWorkflow(workflowId, limit, offset);
  }

  async cancelRun(runId: string, orgId: string): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (!['queued', 'running', 'paused', 'waiting_approval'].includes(run.status)) {
      throw new ValidationError(`Cannot cancel run in status: ${run.status}`);
    }

    const updated = await this.workflowRepo.updateRunStatus(runId, 'cancelled', {
      completedAt: new Date(),
      durationMs: run.startedAt
        ? Date.now() - new Date(run.startedAt).getTime()
        : 0,
    });

    if (updated) {
      emitToOrg(this.io, orgId, WS_EVENTS.WORKFLOW_RUN_CANCELLED, { runId });
    }

    return updated!;
  }
}
