import axios, { AxiosInstance, AxiosError } from "axios";

// --- Interfaces ---

export interface LearningAgentStartJobRequest {
  topic: string;
  depth?: "shallow" | "medium" | "deep" | "exhaustive";
  sources?: string[];
  maxSources?: number;
  outputFormat?: "report" | "summary" | "structured" | "raw";
  language?: string;
  constraints?: Record<string, unknown>;
}

export interface LearningAgentStartJobResponse {
  jobId: string;
  status: "queued" | "running";
  estimatedDuration?: number;
}

export interface LearningAgentJobStatus {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  currentStep?: string;
  sourcesProcessed?: number;
  totalSources?: number;
  result?: LearningAgentJobResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LearningAgentJobResult {
  content: string;
  sources: LearningAgentSource[];
  metadata: Record<string, unknown>;
  confidenceScore: number;
}

export interface LearningAgentSource {
  url: string;
  title: string;
  relevanceScore: number;
  excerpt?: string;
}

export interface LearningAgentDiscoverRequest {
  query: string;
  domain?: string;
  maxResults?: number;
  filters?: {
    dateRange?: { from: string; to: string };
    sourceTypes?: string[];
    language?: string;
  };
}

export interface LearningAgentDiscoverResponse {
  discoveries: LearningAgentDiscovery[];
  totalFound: number;
  queryTime: number;
}

export interface LearningAgentDiscovery {
  title: string;
  url: string;
  summary: string;
  relevanceScore: number;
  sourceType: string;
  publishedDate?: string;
}

export interface LearningAgentSynthesizeRequest {
  sources: string[];
  question: string;
  synthesisType?: "compare" | "merge" | "critique" | "summarize";
  maxLength?: number;
  includeReferences?: boolean;
}

export interface LearningAgentSynthesizeResponse {
  synthesis: string;
  references: Array<{
    sourceIndex: number;
    excerpt: string;
    relevance: number;
  }>;
  confidence: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class LearningAgentClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.LEARNINGAGENT_URL;
    if (!baseURL) {
      throw new Error("LEARNINGAGENT_URL environment variable is not set");
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

  async startLearningJob(
    request: LearningAgentStartJobRequest
  ): Promise<LearningAgentStartJobResponse> {
    try {
      const response = await this.client.post<LearningAgentStartJobResponse>(
        "/api/v1/jobs",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "LearningAgent startLearningJob");
    }
  }

  async getJobStatus(jobId: string): Promise<LearningAgentJobStatus> {
    try {
      const response = await this.client.get<LearningAgentJobStatus>(`/api/v1/jobs/${jobId}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "LearningAgent getJobStatus");
    }
  }

  async discover(request: LearningAgentDiscoverRequest): Promise<LearningAgentDiscoverResponse> {
    try {
      const response = await this.client.post<LearningAgentDiscoverResponse>(
        "/api/v1/discover",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "LearningAgent discover");
    }
  }

  async synthesize(
    request: LearningAgentSynthesizeRequest
  ): Promise<LearningAgentSynthesizeResponse> {
    try {
      const response = await this.client.post<LearningAgentSynthesizeResponse>(
        "/api/v1/synthesize",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "LearningAgent synthesize");
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get("/health");
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
