/**
 * Nexus Workflows — API Routes
 *
 * CRUD for workflow definitions and execution management.
 * Powered by Trigger.dev (https://trigger.dev)
 */

import { Router, Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import Joi from 'joi';
import { WorkflowService } from '../services/workflow.service';
import { asyncHandler } from '../middleware/error-handler';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'api-workflows' });

const createWorkflowSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  description: Joi.string().allow('', null).optional(),
  definition: Joi.object().required(),
  projectId: Joi.string().uuid().optional(),
  isTemplate: Joi.boolean().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
});

const updateWorkflowSchema = Joi.object({
  name: Joi.string().min(1).max(255).optional(),
  description: Joi.string().allow('', null).optional(),
  definition: Joi.object().optional(),
  isTemplate: Joi.boolean().optional(),
  tags: Joi.array().items(Joi.string()).optional(),
  status: Joi.string().valid('draft', 'published', 'archived').optional(),
}).min(1);

const runWorkflowSchema = Joi.object({
  parameters: Joi.object().optional(),
  metadata: Joi.object().optional(),
});

function toUI(workflow: any): Record<string, any> {
  return {
    id: workflow.workflowId,
    organizationId: workflow.organizationId,
    userId: workflow.userId,
    projectId: workflow.projectId,
    name: workflow.name,
    description: workflow.description,
    definition: workflow.definition,
    version: workflow.version,
    isTemplate: workflow.isTemplate,
    tags: workflow.tags,
    status: workflow.status,
    createdAt: workflow.createdAt?.toISOString?.() ?? String(workflow.createdAt),
    updatedAt: workflow.updatedAt?.toISOString?.() ?? String(workflow.updatedAt),
  };
}

function runToUI(run: any): Record<string, any> {
  return {
    id: run.runId,
    workflowId: run.workflowId,
    organizationId: run.organizationId,
    userId: run.userId,
    status: run.status,
    progress: run.progress,
    nodeStates: run.nodeStates,
    output: run.output,
    errorMessage: run.errorMessage,
    parameters: run.parameters,
    triggerRunIds: run.triggerRunIds,
    mageagentJobIds: run.mageagentJobIds,
    skillJobIds: run.skillJobIds,
    n8nExecutionIds: run.n8nExecutionIds,
    startedAt: run.startedAt?.toISOString?.() ?? run.startedAt,
    completedAt: run.completedAt?.toISOString?.() ?? run.completedAt,
    durationMs: run.durationMs,
    metadata: run.metadata,
    tags: run.tags,
    createdAt: run.createdAt?.toISOString?.() ?? String(run.createdAt),
  };
}

export function createWorkflowRouter(
  workflowService: WorkflowService,
  io: SocketIOServer
): Router {
  const router = Router();

  // ── List workflows ─────────────────────────────────────────────────
  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const { status, search, tags, isTemplate, limit, offset } = req.query;

      const result = await workflowService.listWorkflows(orgId, {
        status: status as string,
        search: search as string,
        tags: tags ? (tags as string).split(',') : undefined,
        isTemplate: isTemplate === 'true' ? true : isTemplate === 'false' ? false : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });

      res.json({
        success: true,
        data: result.workflows.map(toUI),
        meta: { total: result.total },
      });
    })
  );

  // ── Create workflow ────────────────────────────────────────────────
  router.post(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = createWorkflowSchema.validate(req.body);
      if (error) {
        res.status(400).json({ success: false, error: error.details[0].message });
        return;
      }

      const orgId = req.user!.organizationId;
      const userId = req.user!.userId;

      const workflow = await workflowService.createWorkflow(orgId, userId, value);
      res.status(201).json({ success: true, data: toUI(workflow) });
    })
  );

  // ── Get workflow ───────────────────────────────────────────────────
  router.get(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const workflow = await workflowService.getWorkflow(req.params.id);
      res.json({ success: true, data: toUI(workflow) });
    })
  );

  // ── Update workflow ────────────────────────────────────────────────
  router.put(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = updateWorkflowSchema.validate(req.body);
      if (error) {
        res.status(400).json({ success: false, error: error.details[0].message });
        return;
      }

      const workflow = await workflowService.updateWorkflow(req.params.id, value);
      res.json({ success: true, data: toUI(workflow) });
    })
  );

  // ── Delete workflow ────────────────────────────────────────────────
  router.delete(
    '/:id',
    asyncHandler(async (req: Request, res: Response) => {
      await workflowService.deleteWorkflow(req.params.id);
      res.json({ success: true });
    })
  );

  // ── Publish workflow ───────────────────────────────────────────────
  router.post(
    '/:id/publish',
    asyncHandler(async (req: Request, res: Response) => {
      const workflow = await workflowService.publishWorkflow(req.params.id);
      res.json({ success: true, data: toUI(workflow) });
    })
  );

  // ── Duplicate workflow ─────────────────────────────────────────────
  router.post(
    '/:id/duplicate',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = req.user!.userId;
      const { name } = req.body;
      const workflow = await workflowService.duplicateWorkflow(req.params.id, userId, name);
      res.json({ success: true, data: toUI(workflow) });
    })
  );

  // ── Run workflow ───────────────────────────────────────────────────
  router.post(
    '/:id/run',
    asyncHandler(async (req: Request, res: Response) => {
      const { error, value } = runWorkflowSchema.validate(req.body);
      if (error) {
        res.status(400).json({ success: false, error: error.details[0].message });
        return;
      }

      const orgId = req.user!.organizationId;
      const userId = req.user!.userId;

      const run = await workflowService.startRun(
        req.params.id,
        orgId,
        userId,
        value.parameters,
        value.metadata
      );

      res.status(201).json({ success: true, data: runToUI(run) });
    })
  );

  // ── List runs for a workflow ───────────────────────────────────────
  router.get(
    '/:id/runs',
    asyncHandler(async (req: Request, res: Response) => {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const runs = await workflowService.listRuns(req.params.id, limit, offset);
      res.json({ success: true, data: runs.map(runToUI) });
    })
  );

  // ── Templates ──────────────────────────────────────────────────────
  router.get(
    '/templates/browse',
    asyncHandler(async (req: Request, res: Response) => {
      const { search, tags, limit, offset } = req.query;
      const result = await workflowService.listTemplates({
        search: search as string,
        tags: tags ? (tags as string).split(',') : undefined,
        limit: limit ? parseInt(limit as string, 10) : undefined,
        offset: offset ? parseInt(offset as string, 10) : undefined,
      });
      res.json({
        success: true,
        data: result.workflows.map(toUI),
        meta: { total: result.total },
      });
    })
  );

  return router;
}

// ── Universal Job API ──────────────────────────────────────────────────

export function createJobRouter(workflowService: WorkflowService): Router {
  const router = Router();

  // GET /jobs/:nxjId — Full job status
  router.get(
    '/:nxjId',
    asyncHandler(async (req: Request, res: Response) => {
      const run = await workflowService.getRun(req.params.nxjId);
      res.json({ success: true, data: runToUI(run) });
    })
  );

  // GET /jobs/:nxjId/nodes — Per-node status
  router.get(
    '/:nxjId/nodes',
    asyncHandler(async (req: Request, res: Response) => {
      const run = await workflowService.getRun(req.params.nxjId);
      res.json({ success: true, data: run.nodeStates });
    })
  );

  // POST /jobs/:nxjId/cancel — Cancel running job
  router.post(
    '/:nxjId/cancel',
    asyncHandler(async (req: Request, res: Response) => {
      const orgId = req.user!.organizationId;
      const run = await workflowService.cancelRun(req.params.nxjId, orgId);
      res.json({ success: true, data: runToUI(run) });
    })
  );

  return router;
}
