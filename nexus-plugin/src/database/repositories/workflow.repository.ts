/**
 * Workflow Repository
 *
 * CRUD operations for trigger.workflows and trigger.workflow_runs tables.
 * Powered by Trigger.dev (https://trigger.dev)
 */

import { DatabaseService } from '../database-service';

export interface Workflow {
  workflowId: string;
  organizationId: string;
  userId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  definition: Record<string, any>;
  version: number;
  isTemplate: boolean;
  tags: string[];
  status: 'draft' | 'published' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkflowData {
  organizationId: string;
  userId: string;
  projectId?: string;
  name: string;
  description?: string;
  definition: Record<string, any>;
  isTemplate?: boolean;
  tags?: string[];
  status?: 'draft' | 'published' | 'archived';
}

export interface UpdateWorkflowData {
  name?: string;
  description?: string;
  definition?: Record<string, any>;
  isTemplate?: boolean;
  tags?: string[];
  status?: 'draft' | 'published' | 'archived';
}

export interface WorkflowFilters {
  status?: string;
  isTemplate?: boolean;
  search?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  organizationId: string;
  userId: string;
  definitionSnapshot: Record<string, any>;
  parameters: Record<string, any>;
  status: string;
  progress: number;
  nodeStates: Record<string, any>;
  output: Record<string, any> | null;
  errorMessage: string | null;
  triggerRunIds: string[];
  mageagentJobIds: string[];
  skillJobIds: string[];
  n8nExecutionIds: string[];
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, any>;
  tags: string[];
  createdAt: Date;
}

export interface CreateWorkflowRunData {
  runId: string;
  workflowId: string;
  organizationId: string;
  userId: string;
  definitionSnapshot: Record<string, any>;
  parameters?: Record<string, any>;
  metadata?: Record<string, any>;
  tags?: string[];
}

function rowToWorkflow(row: any): Workflow {
  return {
    workflowId: row.workflow_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    definition: row.definition,
    version: row.version,
    isTemplate: row.is_template,
    tags: row.tags || [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToWorkflowRun(row: any): WorkflowRun {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    organizationId: row.organization_id,
    userId: row.user_id,
    definitionSnapshot: row.definition_snapshot,
    parameters: row.parameters || {},
    status: row.status,
    progress: row.progress,
    nodeStates: row.node_states || {},
    output: row.output,
    errorMessage: row.error_message,
    triggerRunIds: row.trigger_run_ids || [],
    mageagentJobIds: row.mageagent_job_ids || [],
    skillJobIds: row.skill_job_ids || [],
    n8nExecutionIds: row.n8n_execution_ids || [],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    metadata: row.metadata || {},
    tags: row.tags || [],
    createdAt: row.created_at,
  };
}

export class WorkflowRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  // ── Workflows ──────────────────────────────────────────────────────

  async create(data: CreateWorkflowData): Promise<Workflow> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.workflows (
        organization_id, user_id, project_id, name, description,
        definition, is_template, tags, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        data.organizationId,
        data.userId,
        data.projectId || null,
        data.name,
        data.description || null,
        JSON.stringify(data.definition),
        data.isTemplate || false,
        data.tags || [],
        data.status || 'draft',
      ]
    );
    return rowToWorkflow(row);
  }

  async findById(workflowId: string): Promise<Workflow | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.workflows WHERE workflow_id = $1`,
      [workflowId]
    );
    return row ? rowToWorkflow(row) : null;
  }

  async findByOrg(
    organizationId: string,
    filters: WorkflowFilters = {}
  ): Promise<{ workflows: Workflow[]; total: number }> {
    const conditions = ['organization_id = $1'];
    const params: any[] = [organizationId];
    let paramIdx = 2;

    if (filters.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(filters.status);
    }
    if (filters.isTemplate !== undefined) {
      conditions.push(`is_template = $${paramIdx++}`);
      params.push(filters.isTemplate);
    }
    if (filters.search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      params.push(`%${filters.search}%`);
      paramIdx++;
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${paramIdx++}`);
      params.push(filters.tags);
    }

    const where = conditions.join(' AND ');

    const countRow = await this.db.queryOne<any>(
      `SELECT COUNT(*) as total FROM trigger.workflows WHERE ${where}`,
      params
    );
    const total = parseInt(countRow?.total || '0', 10);

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    params.push(limit, offset);

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.workflows WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      params
    );

    return { workflows: rows.map(rowToWorkflow), total };
  }

  async update(workflowId: string, data: UpdateWorkflowData): Promise<Workflow | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${paramIdx++}`);
      params.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${paramIdx++}`);
      params.push(data.description);
    }
    if (data.definition !== undefined) {
      sets.push(`definition = $${paramIdx++}`);
      params.push(JSON.stringify(data.definition));
    }
    if (data.isTemplate !== undefined) {
      sets.push(`is_template = $${paramIdx++}`);
      params.push(data.isTemplate);
    }
    if (data.tags !== undefined) {
      sets.push(`tags = $${paramIdx++}`);
      params.push(data.tags);
    }
    if (data.status !== undefined) {
      sets.push(`status = $${paramIdx++}`);
      params.push(data.status);
    }

    if (sets.length === 0) return this.findById(workflowId);

    params.push(workflowId);
    const row = await this.db.queryOne<any>(
      `UPDATE trigger.workflows SET ${sets.join(', ')} WHERE workflow_id = $${paramIdx} RETURNING *`,
      params
    );
    return row ? rowToWorkflow(row) : null;
  }

  async delete(workflowId: string): Promise<boolean> {
    const result = await this.db.queryOne<any>(
      `DELETE FROM trigger.workflows WHERE workflow_id = $1 RETURNING workflow_id`,
      [workflowId]
    );
    return !!result;
  }

  async duplicate(workflowId: string, userId: string, newName: string): Promise<Workflow | null> {
    const original = await this.findById(workflowId);
    if (!original) return null;

    return this.create({
      organizationId: original.organizationId,
      userId,
      projectId: original.projectId || undefined,
      name: newName,
      description: original.description || undefined,
      definition: original.definition,
      tags: original.tags,
      status: 'draft',
    });
  }

  async findTemplates(
    filters: WorkflowFilters = {}
  ): Promise<{ workflows: Workflow[]; total: number }> {
    const conditions = ['is_template = TRUE', "status = 'published'"];
    const params: any[] = [];
    let paramIdx = 1;

    if (filters.search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      params.push(`%${filters.search}%`);
      paramIdx++;
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(`tags && $${paramIdx++}`);
      params.push(filters.tags);
    }

    const where = conditions.join(' AND ');

    const countRow = await this.db.queryOne<any>(
      `SELECT COUNT(*) as total FROM trigger.workflows WHERE ${where}`,
      params
    );
    const total = parseInt(countRow?.total || '0', 10);

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    params.push(limit, offset);

    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.workflows WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      params
    );

    return { workflows: rows.map(rowToWorkflow), total };
  }

  // ── Workflow Runs ──────────────────────────────────────────────────

  async createRun(data: CreateWorkflowRunData): Promise<WorkflowRun> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.workflow_runs (
        run_id, workflow_id, organization_id, user_id,
        definition_snapshot, parameters, metadata, tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        data.runId,
        data.workflowId,
        data.organizationId,
        data.userId,
        JSON.stringify(data.definitionSnapshot),
        JSON.stringify(data.parameters || {}),
        JSON.stringify(data.metadata || {}),
        data.tags || [],
      ]
    );
    return rowToWorkflowRun(row);
  }

  async findRunById(runId: string): Promise<WorkflowRun | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.workflow_runs WHERE run_id = $1`,
      [runId]
    );
    return row ? rowToWorkflowRun(row) : null;
  }

  async findRunsByWorkflow(
    workflowId: string,
    limit = 20,
    offset = 0
  ): Promise<WorkflowRun[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.workflow_runs WHERE workflow_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [workflowId, limit, offset]
    );
    return rows.map(rowToWorkflowRun);
  }

  async updateRunStatus(
    runId: string,
    status: string,
    updates: {
      progress?: number;
      nodeStates?: Record<string, any>;
      output?: Record<string, any>;
      errorMessage?: string;
      startedAt?: Date;
      completedAt?: Date;
      durationMs?: number;
      triggerRunIds?: string[];
      mageagentJobIds?: string[];
      skillJobIds?: string[];
      n8nExecutionIds?: string[];
    } = {}
  ): Promise<WorkflowRun | null> {
    const sets = ['status = $2'];
    const params: any[] = [runId, status];
    let paramIdx = 3;

    if (updates.progress !== undefined) {
      sets.push(`progress = $${paramIdx++}`);
      params.push(updates.progress);
    }
    if (updates.nodeStates !== undefined) {
      sets.push(`node_states = $${paramIdx++}`);
      params.push(JSON.stringify(updates.nodeStates));
    }
    if (updates.output !== undefined) {
      sets.push(`output = $${paramIdx++}`);
      params.push(JSON.stringify(updates.output));
    }
    if (updates.errorMessage !== undefined) {
      sets.push(`error_message = $${paramIdx++}`);
      params.push(updates.errorMessage);
    }
    if (updates.startedAt !== undefined) {
      sets.push(`started_at = $${paramIdx++}`);
      params.push(updates.startedAt);
    }
    if (updates.completedAt !== undefined) {
      sets.push(`completed_at = $${paramIdx++}`);
      params.push(updates.completedAt);
    }
    if (updates.durationMs !== undefined) {
      sets.push(`duration_ms = $${paramIdx++}`);
      params.push(updates.durationMs);
    }
    if (updates.triggerRunIds !== undefined) {
      sets.push(`trigger_run_ids = $${paramIdx++}`);
      params.push(updates.triggerRunIds);
    }
    if (updates.mageagentJobIds !== undefined) {
      sets.push(`mageagent_job_ids = $${paramIdx++}`);
      params.push(updates.mageagentJobIds);
    }
    if (updates.skillJobIds !== undefined) {
      sets.push(`skill_job_ids = $${paramIdx++}`);
      params.push(updates.skillJobIds);
    }
    if (updates.n8nExecutionIds !== undefined) {
      sets.push(`n8n_execution_ids = $${paramIdx++}`);
      params.push(updates.n8nExecutionIds);
    }

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.workflow_runs SET ${sets.join(', ')} WHERE run_id = $1 RETURNING *`,
      params
    );
    return row ? rowToWorkflowRun(row) : null;
  }
}
