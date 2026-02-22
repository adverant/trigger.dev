import { DatabaseService } from '../database-service';

export interface TaskTemplate {
  templateId: string;
  serviceName: string;
  name: string;
  description: string | null;
  taskIdentifier: string;
  defaultPayload: Record<string, any>;
  schema: Record<string, any>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskTemplateData {
  serviceName: string;
  name: string;
  description?: string;
  taskIdentifier: string;
  defaultPayload?: Record<string, any>;
  schema?: Record<string, any>;
}

export interface UpdateTaskTemplateData {
  name?: string;
  description?: string;
  taskIdentifier?: string;
  defaultPayload?: Record<string, any>;
  schema?: Record<string, any>;
  enabled?: boolean;
}

export class TaskTemplateRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async findByService(serviceName: string): Promise<TaskTemplate[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.task_templates
       WHERE service_name = $1 AND enabled = TRUE
       ORDER BY name ASC`,
      [serviceName]
    );
    return rows.map((row) => this.mapRow(row));
  }

  async findAll(): Promise<TaskTemplate[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.task_templates
       ORDER BY service_name ASC, name ASC`
    );
    return rows.map((row) => this.mapRow(row));
  }

  async findById(templateId: string): Promise<TaskTemplate | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.task_templates WHERE template_id = $1`,
      [templateId]
    );
    return row ? this.mapRow(row) : null;
  }

  async create(data: CreateTaskTemplateData): Promise<TaskTemplate> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.task_templates (
        service_name, name, description, task_identifier, default_payload, schema
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        data.serviceName,
        data.name,
        data.description || null,
        data.taskIdentifier,
        JSON.stringify(data.defaultPayload || {}),
        JSON.stringify(data.schema || {}),
      ]
    );

    if (!row) {
      throw new Error('Failed to create task template');
    }

    return this.mapRow(row);
  }

  async update(templateId: string, data: UpdateTaskTemplateData): Promise<TaskTemplate> {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      sets.push(`name = $${idx++}`);
      params.push(data.name);
    }
    if (data.description !== undefined) {
      sets.push(`description = $${idx++}`);
      params.push(data.description);
    }
    if (data.taskIdentifier !== undefined) {
      sets.push(`task_identifier = $${idx++}`);
      params.push(data.taskIdentifier);
    }
    if (data.defaultPayload !== undefined) {
      sets.push(`default_payload = $${idx++}`);
      params.push(JSON.stringify(data.defaultPayload));
    }
    if (data.schema !== undefined) {
      sets.push(`schema = $${idx++}`);
      params.push(JSON.stringify(data.schema));
    }
    if (data.enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      params.push(data.enabled);
    }

    sets.push(`updated_at = NOW()`);
    params.push(templateId);

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.task_templates
       SET ${sets.join(', ')}
       WHERE template_id = $${idx}
       RETURNING *`,
      params
    );

    if (!row) {
      throw new Error('Task template not found');
    }

    return this.mapRow(row);
  }

  async delete(templateId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM trigger.task_templates WHERE template_id = $1`,
      [templateId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Get all templates grouped by service for efficient bulk loading.
   */
  async findAllGroupedByService(): Promise<Map<string, TaskTemplate[]>> {
    const all = await this.findAll();
    const map = new Map<string, TaskTemplate[]>();
    for (const t of all) {
      const list = map.get(t.serviceName) || [];
      list.push(t);
      map.set(t.serviceName, list);
    }
    return map;
  }

  private mapRow(row: any): TaskTemplate {
    return {
      templateId: row.template_id,
      serviceName: row.service_name,
      name: row.name,
      description: row.description,
      taskIdentifier: row.task_identifier,
      defaultPayload: row.default_payload || {},
      schema: row.schema || {},
      enabled: row.enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
