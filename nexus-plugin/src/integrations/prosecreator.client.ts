import { AxiosInstance, AxiosError } from 'axios';
import { createResilientClient } from './resilient-client';

// --- Interfaces ---

export interface ProseCreatorWorkflowTemplate {
  id: string;
  template_key: string;
  name: string;
  description: string | null;
  category: string;
  version: string;
  required_inputs: Array<{ name: string; type: string; required: boolean; description?: string }>;
  ui_trigger_locations: string[];
  estimated_duration: string | null;
  is_published: boolean;
}

export interface ProseCreatorWorkflowBinding {
  id: string;
  project_id: string;
  n8n_workflow_id: string;
  template_key: string;
  workflow_name: string;
  workflow_category: string;
  is_active: boolean;
  execution_count: number;
}

export interface ProseCreatorDeployRequest {
  projectId: string;
  n8nInstanceId: string;
}

export interface ProseCreatorDeployResponse {
  binding: ProseCreatorWorkflowBinding;
  n8nWorkflowId: string;
  activated: boolean;
}

export interface ProseCreatorExecuteRequest {
  bindingId: string;
  inputData?: Record<string, unknown>;
}

export interface ProseCreatorExecuteResponse {
  executionId: string;
  n8nExecutionId: string;
  status: string;
}

export interface ProseCreatorExecutionStatus {
  id: string;
  binding_id: string;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ProseCreatorJobStatus {
  job_id: string;
  status: string;
  progress?: number;
  result?: unknown;
  error?: string;
}

export interface ProseCreatorProject {
  id: string;
  title: string;
  genre: string;
  status: string;
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
}

// --- Client ---

export class ProseCreatorClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL =
      process.env.PROSECREATOR_ENDPOINT || 'http://nexus-prosecreator:3000';

    this.client = createResilientClient({
      serviceName: 'prosecreator',
      baseURL,
      timeout: 300000, // 5 min for generation tasks
      headers: {
        'Content-Type': 'application/json',
        'X-Organization-ID': organizationId,
      },
    });
  }

  // ── Templates ───────────────────────────────────────────────────────────

  async listTemplates(): Promise<ProseCreatorWorkflowTemplate[]> {
    try {
      const response = await this.client.get<{ data: ProseCreatorWorkflowTemplate[] }>(
        '/prosecreator/api/workflows/templates'
      );
      return response.data.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator listTemplates');
    }
  }

  async getAvailableWorkflows(
    projectId: string,
    context?: string
  ): Promise<Array<{ template: ProseCreatorWorkflowTemplate; binding: ProseCreatorWorkflowBinding | null }>> {
    try {
      const params: Record<string, string> = { project_id: projectId };
      if (context) params.context = context;
      const response = await this.client.get<{
        data: Array<{ template: ProseCreatorWorkflowTemplate; binding: ProseCreatorWorkflowBinding | null }>;
      }>('/prosecreator/api/workflows/available', { params });
      return response.data.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator getAvailableWorkflows');
    }
  }

  // ── Deploy ──────────────────────────────────────────────────────────────

  async deployTemplate(
    templateKey: string,
    request: ProseCreatorDeployRequest,
    userId: string
  ): Promise<ProseCreatorDeployResponse> {
    try {
      const response = await this.client.post<{ data: ProseCreatorDeployResponse }>(
        `/prosecreator/api/workflows/templates/${templateKey}/deploy`,
        {
          project_id: request.projectId,
          n8n_instance_id: request.n8nInstanceId,
        },
        {
          headers: { 'X-User-Id': userId },
        }
      );
      return response.data.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator deployTemplate');
    }
  }

  // ── Execute ─────────────────────────────────────────────────────────────

  async executeWorkflow(
    bindingId: string,
    inputData?: Record<string, unknown>,
    userId?: string
  ): Promise<ProseCreatorExecuteResponse> {
    try {
      const response = await this.client.post<{ data: ProseCreatorExecuteResponse }>(
        `/prosecreator/api/workflows/bindings/${bindingId}/execute`,
        { input_data: inputData || {} },
        {
          headers: userId ? { 'X-User-Id': userId } : {},
        }
      );
      return response.data.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator executeWorkflow');
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  async getRecentExecutions(
    userId: string,
    limit = 20
  ): Promise<ProseCreatorExecutionStatus[]> {
    try {
      const response = await this.client.get<{ data: ProseCreatorExecutionStatus[] }>(
        '/prosecreator/api/workflows/executions/recent',
        {
          params: { limit },
          headers: { 'X-User-Id': userId },
        }
      );
      return response.data.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator getRecentExecutions');
    }
  }

  async getJobStatus(jobId: string): Promise<ProseCreatorJobStatus> {
    try {
      const response = await this.client.get<ProseCreatorJobStatus>(
        `/prosecreator/api/generation/status/${jobId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator getJobStatus');
    }
  }

  // ── Bindings ────────────────────────────────────────────────────────────

  async getBindings(projectId: string): Promise<ProseCreatorWorkflowBinding[]> {
    try {
      const response = await this.client.get<{ data: ProseCreatorWorkflowBinding[] }>(
        '/prosecreator/api/workflows/bindings',
        { params: { project_id: projectId } }
      );
      return response.data.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator getBindings');
    }
  }

  async resolveBindingForTemplate(
    projectId: string,
    templateKey: string,
    n8nInstanceId: string,
    userId: string
  ): Promise<{ bindingId: string; wasDeployed: boolean }> {
    // Check if binding already exists
    const available = await this.getAvailableWorkflows(projectId);
    const match = available.find((w) => w.template.template_key === templateKey);

    if (match?.binding) {
      return { bindingId: match.binding.id, wasDeployed: false };
    }

    // Deploy if not bound
    const deployed = await this.deployTemplate(
      templateKey,
      { projectId, n8nInstanceId },
      userId
    );
    return { bindingId: deployed.binding.id, wasDeployed: true };
  }

  // ── Project data ────────────────────────────────────────────────────────

  async getProject(projectId: string): Promise<ProseCreatorProject> {
    try {
      const response = await this.client.get<ProseCreatorProject>(
        `/prosecreator/api/projects/${projectId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'ProseCreator getProject');
    }
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get('/prosecreator/health');
      const latency = Date.now() - start;
      return {
        status: response.data?.status === 'ok' ? 'healthy' : 'degraded',
        latency,
      };
    } catch {
      const latency = Date.now() - start;
      return { status: 'unhealthy', latency };
    }
  }

  // ── Error handling ──────────────────────────────────────────────────────

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
