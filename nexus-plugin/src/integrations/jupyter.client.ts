import axios, { AxiosInstance, AxiosError } from "axios";

// --- Interfaces ---

export interface JupyterNotebook {
  name: string;
  path: string;
  type: "notebook";
  lastModified: string;
  size: number;
  kernel?: string;
}

export interface JupyterListNotebooksRequest {
  path?: string;
  recursive?: boolean;
}

export interface JupyterListNotebooksResponse {
  notebooks: JupyterNotebook[];
  totalCount: number;
}

export interface JupyterExecuteNotebookRequest {
  notebookPath: string;
  kernel?: string;
  parameters?: Record<string, unknown>;
  timeout?: number;
  outputPath?: string;
}

export interface JupyterExecuteNotebookResponse {
  executionId: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: string;
}

export interface JupyterExecutionResult {
  executionId: string;
  status: "running" | "completed" | "failed";
  notebookPath: string;
  outputPath?: string;
  cells: JupyterCellResult[];
  duration?: number;
  error?: string;
  completedAt?: string;
}

export interface JupyterCellResult {
  cellIndex: number;
  cellType: "code" | "markdown" | "raw";
  source: string;
  outputs: JupyterCellOutput[];
  executionCount?: number;
  status: "ok" | "error" | "skipped";
  error?: { name: string; value: string; traceback: string[] };
}

export interface JupyterCellOutput {
  outputType: "stream" | "display_data" | "execute_result" | "error";
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface JupyterCreateNotebookRequest {
  path: string;
  name: string;
  kernel?: string;
  cells?: Array<{
    cellType: "code" | "markdown" | "raw";
    source: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface JupyterCreateNotebookResponse {
  path: string;
  name: string;
  createdAt: string;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class JupyterClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.JUPYTER_URL;
    if (!baseURL) {
      throw new Error("JUPYTER_URL environment variable is not set");
    }

    this.client = axios.create({
      baseURL,
      timeout: 120000,
      headers: {
        "Content-Type": "application/json",
        "X-Organization-ID": organizationId,
      },
    });
  }

  async listNotebooks(
    request?: JupyterListNotebooksRequest
  ): Promise<JupyterListNotebooksResponse> {
    try {
      const response = await this.client.get<JupyterListNotebooksResponse>("/api/v1/notebooks", {
        params: request,
      });
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Jupyter listNotebooks");
    }
  }

  async executeNotebook(
    request: JupyterExecuteNotebookRequest
  ): Promise<JupyterExecuteNotebookResponse> {
    try {
      const response = await this.client.post<JupyterExecuteNotebookResponse>(
        "/api/v1/notebooks/execute",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Jupyter executeNotebook");
    }
  }

  async getExecutionResult(executionId: string): Promise<JupyterExecutionResult> {
    try {
      const response = await this.client.get<JupyterExecutionResult>(
        `/api/v1/executions/${executionId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Jupyter getExecutionResult");
    }
  }

  async createNotebook(
    request: JupyterCreateNotebookRequest
  ): Promise<JupyterCreateNotebookResponse> {
    try {
      const response = await this.client.post<JupyterCreateNotebookResponse>(
        "/api/v1/notebooks",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Jupyter createNotebook");
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get("/health");
      const latency = Date.now() - start;
      return {
        status: response.data?.status === "ok" ? "healthy" : "degraded",
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
