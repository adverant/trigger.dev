import { DatabaseService } from '../database-service';

export interface TaskDefinition {
  taskDefId: string;
  projectId: string;
  organizationId: string;
  taskIdentifier: string;
  taskVersion: string | null;
  description: string | null;
  inputSchema: any;
  retryConfig: any;
  queueName: string | null;
  machinePreset: string | null;
  isNexusIntegration: boolean;
  nexusService: string | null;
  executionType: string;
  executionTarget: Record<string, unknown>;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertTaskDefinitionData {
  projectId: string;
  organizationId: string;
  taskIdentifier: string;
  taskVersion?: string;
  description?: string;
  inputSchema?: any;
  retryConfig?: any;
  queueName?: string;
  machinePreset?: string;
  isNexusIntegration?: boolean;
  nexusService?: string;
}

export class TaskDefinitionRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async upsert(data: UpsertTaskDefinitionData): Promise<TaskDefinition> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.task_definitions
        (project_id, organization_id, task_identifier, task_version,
         description, input_schema, retry_config, queue_name, machine_preset,
         is_nexus_integration, nexus_service)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (project_id, task_identifier, task_version)
       DO UPDATE SET
         description = EXCLUDED.description,
         input_schema = EXCLUDED.input_schema,
         retry_config = EXCLUDED.retry_config,
         queue_name = EXCLUDED.queue_name,
         machine_preset = EXCLUDED.machine_preset,
         is_nexus_integration = EXCLUDED.is_nexus_integration,
         nexus_service = EXCLUDED.nexus_service
       RETURNING *`,
      [
        data.projectId,
        data.organizationId,
        data.taskIdentifier,
        data.taskVersion || null,
        data.description || null,
        data.inputSchema ? JSON.stringify(data.inputSchema) : null,
        data.retryConfig ? JSON.stringify(data.retryConfig) : null,
        data.queueName || null,
        data.machinePreset || null,
        data.isNexusIntegration || false,
        data.nexusService || null,
      ]
    );

    if (!row) {
      throw new Error('Failed to upsert task definition');
    }

    return this.mapRow(row);
  }

  async findByProject(projectId: string, organizationId: string): Promise<TaskDefinition[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT td.*, lr.status AS last_run_status, lr.created_at AS last_run_at
       FROM trigger.task_definitions td
       LEFT JOIN LATERAL (
         SELECT status, created_at FROM trigger.run_history rh
         WHERE rh.task_identifier = td.task_identifier
           AND rh.organization_id = td.organization_id
         ORDER BY rh.created_at DESC LIMIT 1
       ) lr ON true
       WHERE td.project_id = $1 AND td.organization_id = $2
       ORDER BY td.task_identifier ASC`,
      [projectId, organizationId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  async findByOrg(organizationId: string): Promise<TaskDefinition[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT td.*, lr.status AS last_run_status, lr.created_at AS last_run_at
       FROM trigger.task_definitions td
       LEFT JOIN LATERAL (
         SELECT status, created_at FROM trigger.run_history rh
         WHERE rh.task_identifier = td.task_identifier
           AND rh.organization_id = td.organization_id
         ORDER BY rh.created_at DESC LIMIT 1
       ) lr ON true
       WHERE td.organization_id = $1
       ORDER BY td.task_identifier ASC`,
      [organizationId]
    );
    return rows.map((row) => this.mapRow(row));
  }

  async findById(taskDefId: string, organizationId: string): Promise<TaskDefinition | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.task_definitions
       WHERE task_def_id = $1 AND organization_id = $2`,
      [taskDefId, organizationId]
    );
    return row ? this.mapRow(row) : null;
  }

  async findByIdentifier(
    projectId: string,
    taskIdentifier: string
  ): Promise<TaskDefinition | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.task_definitions
       WHERE project_id = $1 AND task_identifier = $2
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, taskIdentifier]
    );
    return row ? this.mapRow(row) : null;
  }

  async findBySlug(taskIdentifier: string, organizationId: string): Promise<TaskDefinition | null> {
    const row = await this.db.queryOne<any>(
      `SELECT td.*, lr.status AS last_run_status, lr.created_at AS last_run_at
       FROM trigger.task_definitions td
       LEFT JOIN LATERAL (
         SELECT status, created_at FROM trigger.run_history rh
         WHERE rh.task_identifier = td.task_identifier
           AND rh.organization_id = td.organization_id
         ORDER BY rh.created_at DESC LIMIT 1
       ) lr ON true
       WHERE td.task_identifier = $1 AND td.organization_id = $2
       ORDER BY td.created_at DESC LIMIT 1`,
      [taskIdentifier, organizationId]
    );
    return row ? this.mapRow(row) : null;
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM trigger.task_definitions WHERE project_id = $1`,
      [projectId]
    );
    return result.rowCount || 0;
  }

  private mapRow(row: any): TaskDefinition {
    return {
      taskDefId: row.task_def_id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      taskIdentifier: row.task_identifier,
      taskVersion: row.task_version,
      description: row.description,
      inputSchema: row.input_schema,
      retryConfig: row.retry_config,
      queueName: row.queue_name,
      machinePreset: row.machine_preset,
      isNexusIntegration: row.is_nexus_integration,
      nexusService: row.nexus_service,
      executionType: row.execution_type || 'prefix-derived',
      executionTarget: row.execution_target || {},
      lastRunStatus: row.last_run_status || null,
      lastRunAt: row.last_run_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async updateExecutionTarget(
    orgId: string,
    taskDefId: string,
    executionType: string,
    executionTarget: Record<string, unknown>
  ): Promise<TaskDefinition | null> {
    const row = await this.db.queryOne<any>(
      `UPDATE trigger.task_definitions
       SET execution_type = $1, execution_target = $2, updated_at = NOW()
       WHERE task_def_id = $3 AND organization_id = $4
       RETURNING *`,
      [executionType, JSON.stringify(executionTarget), taskDefId, orgId]
    );
    return row ? this.mapRow(row) : null;
  }
}
