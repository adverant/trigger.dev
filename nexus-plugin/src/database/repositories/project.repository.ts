import { DatabaseService } from '../database-service';

export interface Project {
  projectId: string;
  organizationId: string;
  userId: string;
  triggerProjectRef: string;
  triggerProjectName: string | null;
  environment: 'dev' | 'staging' | 'production';
  apiKeyEncrypted: string | null;
  personalAccessTokenEncrypted: string | null;
  triggerApiUrl: string;
  mode: 'self-hosted' | 'external';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectData {
  organizationId: string;
  userId: string;
  triggerProjectRef: string;
  triggerProjectName?: string;
  environment: 'dev' | 'staging' | 'production';
  apiKeyEncrypted?: string;
  personalAccessTokenEncrypted?: string;
  triggerApiUrl?: string;
  mode: 'self-hosted' | 'external';
}

export interface UpdateProjectData {
  triggerProjectName?: string;
  environment?: 'dev' | 'staging' | 'production';
  apiKeyEncrypted?: string;
  personalAccessTokenEncrypted?: string;
  triggerApiUrl?: string;
  mode?: 'self-hosted' | 'external';
}

export class ProjectRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async create(data: CreateProjectData): Promise<Project> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.projects (
        organization_id, user_id, trigger_project_ref, trigger_project_name,
        environment, api_key_encrypted, personal_access_token_encrypted,
        trigger_api_url, mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        data.organizationId,
        data.userId,
        data.triggerProjectRef,
        data.triggerProjectName || null,
        data.environment,
        data.apiKeyEncrypted || null,
        data.personalAccessTokenEncrypted || null,
        data.triggerApiUrl || 'http://trigger-dev-webapp:3030',
        data.mode,
      ]
    );

    if (!row) {
      throw new Error('Failed to create project');
    }

    return this.mapRow(row);
  }

  /** Create with a specific project_id (for external services like ProseCreator). */
  async createWithId(projectId: string, data: CreateProjectData): Promise<Project> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.projects (
        project_id, organization_id, user_id, trigger_project_ref, trigger_project_name,
        environment, api_key_encrypted, personal_access_token_encrypted,
        trigger_api_url, mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (project_id) DO NOTHING
      RETURNING *`,
      [
        projectId,
        data.organizationId,
        data.userId,
        data.triggerProjectRef,
        data.triggerProjectName || null,
        data.environment,
        data.apiKeyEncrypted || null,
        data.personalAccessTokenEncrypted || null,
        data.triggerApiUrl || 'http://trigger-dev-webapp:3030',
        data.mode,
      ]
    );

    // ON CONFLICT DO NOTHING returns null if already exists
    if (!row) {
      const existing = await this.findById(projectId, data.organizationId);
      if (existing) return existing;
      throw new Error('Failed to create project with specific ID');
    }

    return this.mapRow(row);
  }

  async findById(projectId: string, orgId: string): Promise<Project | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.projects WHERE project_id = $1 AND organization_id = $2`,
      [projectId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findByOrgId(orgId: string): Promise<Project[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.projects WHERE organization_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );

    return rows.map((row) => this.mapRow(row));
  }

  async findByRef(orgId: string, ref: string): Promise<Project | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.projects WHERE organization_id = $1 AND trigger_project_ref = $2`,
      [orgId, ref]
    );

    return row ? this.mapRow(row) : null;
  }

  async update(projectId: string, orgId: string, data: UpdateProjectData): Promise<Project> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.triggerProjectName !== undefined) {
      setClauses.push(`trigger_project_name = $${paramIndex++}`);
      values.push(data.triggerProjectName);
    }
    if (data.environment !== undefined) {
      setClauses.push(`environment = $${paramIndex++}`);
      values.push(data.environment);
    }
    if (data.apiKeyEncrypted !== undefined) {
      setClauses.push(`api_key_encrypted = $${paramIndex++}`);
      values.push(data.apiKeyEncrypted);
    }
    if (data.personalAccessTokenEncrypted !== undefined) {
      setClauses.push(`personal_access_token_encrypted = $${paramIndex++}`);
      values.push(data.personalAccessTokenEncrypted);
    }
    if (data.triggerApiUrl !== undefined) {
      setClauses.push(`trigger_api_url = $${paramIndex++}`);
      values.push(data.triggerApiUrl);
    }
    if (data.mode !== undefined) {
      setClauses.push(`mode = $${paramIndex++}`);
      values.push(data.mode);
    }

    if (setClauses.length === 0) {
      const existing = await this.findById(projectId, orgId);
      if (!existing) {
        throw new Error('Project not found');
      }
      return existing;
    }

    values.push(projectId, orgId);

    const row = await this.db.queryOne<any>(
      `UPDATE trigger.projects SET ${setClauses.join(', ')}
       WHERE project_id = $${paramIndex++} AND organization_id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (!row) {
      throw new Error('Project not found');
    }

    return this.mapRow(row);
  }

  async delete(projectId: string, orgId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM trigger.projects WHERE project_id = $1 AND organization_id = $2`,
      [projectId, orgId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: any): Project {
    return {
      projectId: row.project_id,
      organizationId: row.organization_id,
      userId: row.user_id,
      triggerProjectRef: row.trigger_project_ref,
      triggerProjectName: row.trigger_project_name,
      environment: row.environment,
      apiKeyEncrypted: row.api_key_encrypted,
      personalAccessTokenEncrypted: row.personal_access_token_encrypted,
      triggerApiUrl: row.trigger_api_url,
      mode: row.mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
