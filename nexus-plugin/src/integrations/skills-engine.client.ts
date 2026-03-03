import axios, { AxiosInstance, AxiosError } from 'axios';

// --- Interfaces ---

export interface SkillListItem {
  id: string;
  name: string;
  description?: string;
  category?: string;
  version?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface SkillListResponse {
  skills: SkillListItem[];
  total: number;
}

export interface SkillInvokeRequest {
  skillId: string;
  input: Record<string, unknown>;
  options?: {
    timeout?: number;
    async?: boolean;
  };
}

export interface SkillInvokeResponse {
  executionId: string;
  status: 'completed' | 'running' | 'failed';
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface SkillExecutionStatus {
  executionId: string;
  skillId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
}

// --- Client ---

export class SkillsEngineClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.SKILLS_ENGINE_URL;
    if (!baseURL) {
      throw new Error('SKILLS_ENGINE_URL environment variable is not set');
    }

    this.client = axios.create({
      baseURL,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        'X-Organization-ID': organizationId,
      },
    });
  }

  async invoke(skillId: string, input: Record<string, unknown>): Promise<SkillInvokeResponse> {
    try {
      const response = await this.client.post<SkillInvokeResponse>(
        `/api/v1/skills/${skillId}/invoke`,
        { input }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'SkillsEngine invoke');
    }
  }

  async getExecutionStatus(executionId: string): Promise<SkillExecutionStatus> {
    try {
      const response = await this.client.get<SkillExecutionStatus>(
        `/api/v1/executions/${executionId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'SkillsEngine getExecutionStatus');
    }
  }

  async listSkills(params?: { category?: string; search?: string; limit?: number; offset?: number }): Promise<SkillListResponse> {
    try {
      const response = await this.client.get<SkillListResponse>('/api/v1/skills', { params });
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'SkillsEngine listSkills');
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get('/health');
      const latency = Date.now() - start;
      return {
        status: ['ok', 'healthy'].includes(response.data?.status) ? 'healthy' : 'degraded',
        latency,
      };
    } catch {
      const latency = Date.now() - start;
      return { status: 'unhealthy', latency };
    }
  }

  private handleError(error: unknown, operation: string): Error {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;
      return new Error(`${operation} failed (HTTP ${status}): ${message}`);
    }
    if (error instanceof Error) {
      return new Error(`${operation} failed: ${error.message}`);
    }
    return new Error(`${operation} failed: Unknown error`);
  }
}
