import axios, { AxiosInstance, AxiosError } from "axios";

// --- Interfaces ---

export interface MageAgentProcessRequest {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: MageAgentTool[];
  context?: Record<string, unknown>;
}

export interface MageAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface MageAgentProcessResponse {
  id: string;
  result: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: MageAgentToolCall[];
  finishReason: string;
}

export interface MageAgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

export interface MageAgentOrchestrateRequest {
  goal: string;
  agents?: string[];
  strategy?: "sequential" | "parallel" | "adaptive";
  maxSteps?: number;
  context?: Record<string, unknown>;
  timeout?: number;
}

export interface MageAgentOrchestrateResponse {
  orchestrationId: string;
  status: "running" | "completed" | "failed";
  steps: MageAgentOrchestrateStep[];
  finalResult?: string;
}

export interface MageAgentOrchestrateStep {
  stepNumber: number;
  agent: string;
  action: string;
  result: string;
  duration: number;
}

export interface MageAgentCompeteRequest {
  prompt: string;
  models: string[];
  evaluationCriteria?: string;
  temperature?: number;
}

export interface MageAgentCompeteResponse {
  competitionId: string;
  results: MageAgentCompeteResult[];
  winner: string;
  evaluation: string;
}

export interface MageAgentCompeteResult {
  model: string;
  response: string;
  score: number;
  latency: number;
}

export interface MageAgentTaskStatusResponse {
  taskId: string;
  status: "pending" | "running" | "completed" | "failed";
  progress?: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MageAgentVisionExtractTextRequest {
  imageUrl?: string;
  imageBase64?: string;
  language?: string;
  format?: "plain" | "markdown" | "structured";
}

export interface MageAgentVisionExtractTextResponse {
  text: string;
  confidence: number;
  regions?: Array<{
    text: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
}

export interface MageAgentVisionAnalyzeRequest {
  imageUrl?: string;
  imageBase64?: string;
  prompt?: string;
  analysisType?: "describe" | "classify" | "detect" | "custom";
}

export interface MageAgentVisionAnalyzeResponse {
  analysis: string;
  labels?: Array<{ name: string; confidence: number }>;
  objects?: Array<{
    name: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
}

export interface MageAgentEmbeddingRequest {
  text: string | string[];
  model?: string;
}

export interface MageAgentEmbeddingResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class MageAgentClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.MAGEAGENT_URL;
    if (!baseURL) {
      throw new Error("MAGEAGENT_URL environment variable is not set");
    }

    this.client = axios.create({
      baseURL,
      timeout: 60000,
      headers: {
        "Content-Type": "application/json",
        "X-Organization-ID": organizationId,
      },
    });
  }

  async process(request: MageAgentProcessRequest): Promise<MageAgentProcessResponse> {
    try {
      const response = await this.client.post<MageAgentProcessResponse>(
        "/api/v1/process",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent process");
    }
  }

  async orchestrate(request: MageAgentOrchestrateRequest): Promise<MageAgentOrchestrateResponse> {
    try {
      const response = await this.client.post<MageAgentOrchestrateResponse>(
        "/api/v1/orchestrate",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent orchestrate");
    }
  }

  async compete(request: MageAgentCompeteRequest): Promise<MageAgentCompeteResponse> {
    try {
      const response = await this.client.post<MageAgentCompeteResponse>(
        "/api/v1/compete",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent compete");
    }
  }

  async getTaskStatus(taskId: string): Promise<MageAgentTaskStatusResponse> {
    try {
      const response = await this.client.get<MageAgentTaskStatusResponse>(
        `/api/v1/tasks/${taskId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent getTaskStatus");
    }
  }

  async visionExtractText(
    request: MageAgentVisionExtractTextRequest
  ): Promise<MageAgentVisionExtractTextResponse> {
    try {
      const response = await this.client.post<MageAgentVisionExtractTextResponse>(
        "/api/v1/vision/extract-text",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent visionExtractText");
    }
  }

  async visionAnalyze(
    request: MageAgentVisionAnalyzeRequest
  ): Promise<MageAgentVisionAnalyzeResponse> {
    try {
      const response = await this.client.post<MageAgentVisionAnalyzeResponse>(
        "/api/v1/vision/analyze",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent visionAnalyze");
    }
  }

  async generateEmbedding(request: MageAgentEmbeddingRequest): Promise<MageAgentEmbeddingResponse> {
    try {
      const response = await this.client.post<MageAgentEmbeddingResponse>(
        "/api/v1/embeddings",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "MageAgent generateEmbedding");
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
