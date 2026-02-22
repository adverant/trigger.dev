import axios, { AxiosInstance, AxiosError } from "axios";

// --- Interfaces ---

export interface GPUBridgeAllocateRequest {
  gpuType?: "nvidia-t4" | "nvidia-a100" | "nvidia-v100" | "nvidia-l4" | "any";
  count?: number;
  memoryGb?: number;
  priority?: "low" | "normal" | "high" | "critical";
  maxDuration?: number;
  image: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  volumes?: Array<{ source: string; target: string; readOnly?: boolean }>;
}

export interface GPUBridgeAllocateResponse {
  jobId: string;
  status: "queued" | "allocating" | "running";
  gpuType?: string;
  gpuCount?: number;
  estimatedStartTime?: string;
}

export interface GPUBridgeJobStatus {
  jobId: string;
  status: "queued" | "allocating" | "running" | "completed" | "failed" | "cancelled";
  progress?: number;
  gpuType?: string;
  gpuCount?: number;
  startedAt?: string;
  completedAt?: string;
  result?: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
    outputFiles?: string[];
    metrics?: GPUBridgeJobMetrics;
  };
  error?: string;
}

export interface GPUBridgeJobMetrics {
  gpuUtilization: number;
  memoryUtilization: number;
  peakMemoryGb: number;
  duration: number;
  energyConsumption?: number;
}

export interface GPUBridgeWaitOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface GPUBridgeBatchInferenceRequest {
  model: string;
  modelSource?: "huggingface" | "s3" | "gcs" | "local";
  inputs: Array<{
    id: string;
    data: unknown;
  }>;
  batchSize?: number;
  gpuType?: string;
  parameters?: Record<string, unknown>;
}

export interface GPUBridgeBatchInferenceResponse {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  results?: Array<{
    id: string;
    output: unknown;
    latency: number;
  }>;
  totalLatency?: number;
  error?: string;
}

export interface GPUBridgeAvailableGPU {
  type: string;
  available: number;
  total: number;
  memoryGb: number;
  currentUtilization: number;
  estimatedWaitTime?: number;
}

export interface GPUBridgeListGPUsResponse {
  gpus: GPUBridgeAvailableGPU[];
  totalAvailable: number;
  totalCapacity: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class GPUBridgeClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.GPU_BRIDGE_URL;
    if (!baseURL) {
      throw new Error("GPU_BRIDGE_URL environment variable is not set");
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

  async allocateGPU(request: GPUBridgeAllocateRequest): Promise<GPUBridgeAllocateResponse> {
    try {
      const response = await this.client.post<GPUBridgeAllocateResponse>(
        "/api/v1/gpu/allocate",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GPUBridge allocateGPU");
    }
  }

  async getJobStatus(jobId: string): Promise<GPUBridgeJobStatus> {
    try {
      const response = await this.client.get<GPUBridgeJobStatus>(`/api/v1/gpu/jobs/${jobId}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GPUBridge getJobStatus");
    }
  }

  async waitForCompletion(
    jobId: string,
    options?: GPUBridgeWaitOptions
  ): Promise<GPUBridgeJobStatus> {
    const pollInterval = options?.pollIntervalMs ?? 5000;
    const timeout = options?.timeoutMs ?? 3600000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const status = await this.getJobStatus(jobId);

      if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
        return status;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`GPUBridge waitForCompletion timed out after ${timeout}ms for job ${jobId}`);
  }

  async batchInference(
    request: GPUBridgeBatchInferenceRequest
  ): Promise<GPUBridgeBatchInferenceResponse> {
    try {
      const response = await this.client.post<GPUBridgeBatchInferenceResponse>(
        "/api/v1/gpu/batch-inference",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GPUBridge batchInference");
    }
  }

  async listAvailableGPUs(): Promise<GPUBridgeListGPUsResponse> {
    try {
      const response = await this.client.get<GPUBridgeListGPUsResponse>("/api/v1/gpu/available");
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GPUBridge listAvailableGPUs");
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
