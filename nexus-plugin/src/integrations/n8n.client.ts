import { AxiosInstance, AxiosError } from "axios";
import { createResilientClient } from "./resilient-client";

// --- Interfaces ---

export interface N8NTriggerWorkflowRequest {
  workflowId: string;
  data?: Record<string, unknown>;
}

export interface N8NTriggerWorkflowResponse {
  executionId: string;
  status: string;
  startedAt: string;
}

export interface N8NExecution {
  executionId: string;
  workflowId: string;
  status: string;
  data?: unknown;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface N8NWorkflowNode {
  type: string;
  name: string;
  parameters: Record<string, unknown>;
}

export interface N8NWorkflowListItem {
  id: string;
  name: string;
  active: boolean;
  nodes: N8NWorkflowNode[];
  createdAt: string;
  updatedAt: string;
}

export interface N8NListWorkflowsResponse {
  workflows: N8NWorkflowListItem[];
}

export interface N8NWorkflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8NWorkflowNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export interface N8NActivateWorkflowResponse {
  id: string;
  name: string;
  active: boolean;
}

export interface N8NListExecutionsParams {
  workflowId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface N8NListExecutionsResponse {
  executions: N8NExecution[];
  total: number;
}

export interface N8NWebhookUrlResponse {
  webhookUrl: string;
  method: string;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class N8NClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.N8N_URL || "http://nexus-n8n:5678";
    const apiKey = process.env.N8N_API_KEY || "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Organization-ID": organizationId,
    };
    if (apiKey) {
      headers["X-N8N-API-KEY"] = apiKey;
    }

    this.client = createResilientClient({
      serviceName: 'n8n',
      baseURL,
      timeout: 30000,
      headers,
    });
  }

  async triggerWorkflow(
    request: N8NTriggerWorkflowRequest
  ): Promise<N8NTriggerWorkflowResponse> {
    try {
      const response = await this.client.post<N8NTriggerWorkflowResponse>(
        `/api/v1/workflows/${request.workflowId}/trigger`,
        { data: request.data }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "N8N triggerWorkflow");
    }
  }

  async getExecution(executionId: string): Promise<N8NExecution> {
    try {
      const response = await this.client.get<N8NExecution>(
        `/api/v1/executions/${executionId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "N8N getExecution");
    }
  }

  async listWorkflows(): Promise<N8NListWorkflowsResponse> {
    try {
      const response = await this.client.get("/api/v1/workflows");
      const body = response.data;
      // n8n API returns { data: [...], nextCursor: null }
      const workflows = Array.isArray(body?.data)
        ? body.data
        : body?.workflows || [];
      return { workflows };
    } catch (error) {
      throw this.handleError(error, "N8N listWorkflows");
    }
  }

  async getWorkflow(workflowId: string): Promise<N8NWorkflow> {
    try {
      const response = await this.client.get<N8NWorkflow>(
        `/api/v1/workflows/${workflowId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "N8N getWorkflow");
    }
  }

  async activateWorkflow(
    workflowId: string
  ): Promise<N8NActivateWorkflowResponse> {
    try {
      const response = await this.client.patch<N8NActivateWorkflowResponse>(
        `/api/v1/workflows/${workflowId}`,
        { active: true }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "N8N activateWorkflow");
    }
  }

  async deactivateWorkflow(
    workflowId: string
  ): Promise<N8NActivateWorkflowResponse> {
    try {
      const response = await this.client.patch<N8NActivateWorkflowResponse>(
        `/api/v1/workflows/${workflowId}`,
        { active: false }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "N8N deactivateWorkflow");
    }
  }

  async listExecutions(
    params?: N8NListExecutionsParams
  ): Promise<N8NListExecutionsResponse> {
    try {
      const response = await this.client.get("/api/v1/executions", { params });
      const body = response.data;
      // n8n API returns { data: [...], nextCursor: null }
      const executions = Array.isArray(body?.data)
        ? body.data
        : body?.executions || [];
      return { executions, total: executions.length };
    } catch (error) {
      throw this.handleError(error, "N8N listExecutions");
    }
  }

  async getWebhookUrl(workflowId: string): Promise<N8NWebhookUrlResponse> {
    try {
      const response = await this.client.get<N8NWebhookUrlResponse>(
        `/api/v1/workflows/${workflowId}/webhook`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "N8N getWebhookUrl");
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get("/healthz");
      const latency = Date.now() - start;
      return {
        status: ["ok", "healthy"].includes(response.data?.status) ? "healthy" : "degraded",
        latency,
      };
    } catch (error) {
      const latency = Date.now() - start;
      return { status: "unhealthy", latency };
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
