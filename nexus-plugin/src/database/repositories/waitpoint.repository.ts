import { DatabaseService } from '../database-service';

export type WaitpointStatus = 'pending' | 'completed' | 'expired' | 'cancelled';

export interface Waitpoint {
  waitpointId: string;
  tokenId: string;
  runId: string | null;
  triggerRunId: string | null;
  projectId: string;
  organizationId: string;
  taskIdentifier: string | null;
  description: string | null;
  status: WaitpointStatus;
  input: Record<string, any> | null;
  output: Record<string, any> | null;
  requestedBy: string | null;
  completedBy: string | null;
  expiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CreateWaitpointData {
  tokenId: string;
  runId?: string;
  triggerRunId?: string;
  projectId: string;
  organizationId: string;
  taskIdentifier?: string;
  description?: string;
  status?: WaitpointStatus;
  input?: Record<string, any>;
  requestedBy?: string;
  expiresAt?: Date;
}

export class WaitpointRepository {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  async create(data: CreateWaitpointData): Promise<Waitpoint> {
    const row = await this.db.queryOne<any>(
      `INSERT INTO trigger.waitpoints (
        token_id, run_id, trigger_run_id, project_id, organization_id,
        task_identifier, description, status, input, requested_by, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        data.tokenId,
        data.runId || null,
        data.triggerRunId || null,
        data.projectId,
        data.organizationId,
        data.taskIdentifier || null,
        data.description || null,
        data.status || 'pending',
        data.input ? JSON.stringify(data.input) : null,
        data.requestedBy || null,
        data.expiresAt || null,
      ]
    );

    if (!row) {
      throw new Error('Failed to create waitpoint');
    }

    return this.mapRow(row);
  }

  async findById(waitpointId: string, orgId: string): Promise<Waitpoint | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.waitpoints WHERE waitpoint_id = $1 AND organization_id = $2`,
      [waitpointId, orgId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findByTokenId(tokenId: string): Promise<Waitpoint | null> {
    const row = await this.db.queryOne<any>(
      `SELECT * FROM trigger.waitpoints WHERE token_id = $1`,
      [tokenId]
    );

    return row ? this.mapRow(row) : null;
  }

  async findPending(orgId: string): Promise<Waitpoint[]> {
    const rows = await this.db.queryMany<any>(
      `SELECT * FROM trigger.waitpoints
       WHERE organization_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [orgId]
    );

    return rows.map((row) => this.mapRow(row));
  }

  async complete(
    tokenId: string,
    orgId: string,
    output: Record<string, any>,
    completedBy: string
  ): Promise<Waitpoint> {
    const row = await this.db.queryOne<any>(
      `UPDATE trigger.waitpoints
       SET status = 'completed',
           output = $1,
           completed_by = $2,
           completed_at = NOW()
       WHERE token_id = $3 AND organization_id = $4 AND status = 'pending'
       RETURNING *`,
      [JSON.stringify(output), completedBy, tokenId, orgId]
    );

    if (!row) {
      throw new Error('Waitpoint not found or not in pending state');
    }

    return this.mapRow(row);
  }

  async expire(tokenId: string): Promise<void> {
    await this.db.query(
      `UPDATE trigger.waitpoints
       SET status = 'expired', completed_at = NOW()
       WHERE token_id = $1 AND status = 'pending'`,
      [tokenId]
    );
  }

  private mapRow(row: any): Waitpoint {
    return {
      waitpointId: row.waitpoint_id,
      tokenId: row.token_id,
      runId: row.run_id,
      triggerRunId: row.trigger_run_id,
      projectId: row.project_id,
      organizationId: row.organization_id,
      taskIdentifier: row.task_identifier,
      description: row.description,
      status: row.status,
      input: row.input,
      output: row.output,
      requestedBy: row.requested_by,
      completedBy: row.completed_by,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }
}
