import { AxiosInstance, AxiosError } from "axios";
import { createResilientClient } from "./resilient-client";

// --- Interfaces ---

export interface SandboxExecuteCodeRequest {
  language: string;
  code: string;
  stdin?: string;
  timeout?: number;
  memoryLimit?: number;
  env?: Record<string, string>;
}

export interface SandboxExecuteCodeResponse {
  executionId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  memoryUsedBytes: number;
}

export interface SandboxExecuteFileRequest {
  fileUrl: string;
  language: string;
  args?: string[];
  timeout?: number;
}

export interface SandboxExecuteFileResponse {
  executionId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  memoryUsedBytes: number;
}

export interface SandboxCreateRequest {
  name: string;
  language: string;
  packages?: string[];
  env?: Record<string, string>;
  ttl?: number;
}

export interface SandboxCreateResponse {
  sandboxId: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface SandboxDestroyResponse {
  destroyed: boolean;
}

export interface SandboxListItem {
  sandboxId: string;
  name: string;
  language: string;
  status: string;
  createdAt: string;
}

export interface SandboxListResponse {
  sandboxes: SandboxListItem[];
}

export interface SandboxInstallPackagesResponse {
  installed: string[];
  failed: string[];
}

export interface SandboxSecurityVulnerability {
  severity: string;
  rule: string;
  line: number;
  message: string;
  suggestion: string;
}

export interface SandboxScanCodeRequest {
  code: string;
  language: string;
  rules?: string[];
}

export interface SandboxScanCodeResponse {
  vulnerabilities: SandboxSecurityVulnerability[];
  riskScore: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class SandboxClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.SANDBOX_URL || "http://nexus-sandbox:9092";

    this.client = createResilientClient({
      serviceName: 'sandbox',
      baseURL,
      timeout: 120000,
      headers: {
        "Content-Type": "application/json",
        "X-Organization-ID": organizationId,
      },
    });
  }

  async executeCode(
    request: SandboxExecuteCodeRequest
  ): Promise<SandboxExecuteCodeResponse> {
    try {
      const response = await this.client.post<SandboxExecuteCodeResponse>(
        "/api/v1/execute",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox executeCode");
    }
  }

  async executeFile(
    request: SandboxExecuteFileRequest
  ): Promise<SandboxExecuteFileResponse> {
    try {
      const response = await this.client.post<SandboxExecuteFileResponse>(
        "/api/v1/execute/file",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox executeFile");
    }
  }

  async createSandbox(
    request: SandboxCreateRequest
  ): Promise<SandboxCreateResponse> {
    try {
      const response = await this.client.post<SandboxCreateResponse>(
        "/api/v1/sandboxes",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox createSandbox");
    }
  }

  async destroySandbox(sandboxId: string): Promise<SandboxDestroyResponse> {
    try {
      const response = await this.client.delete<SandboxDestroyResponse>(
        `/api/v1/sandboxes/${sandboxId}`
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox destroySandbox");
    }
  }

  async listSandboxes(): Promise<SandboxListResponse> {
    try {
      const response =
        await this.client.get<SandboxListResponse>("/api/v1/sandboxes");
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox listSandboxes");
    }
  }

  async installPackages(
    sandboxId: string,
    packages: string[]
  ): Promise<SandboxInstallPackagesResponse> {
    try {
      const response =
        await this.client.post<SandboxInstallPackagesResponse>(
          `/api/v1/sandboxes/${sandboxId}/packages`,
          { packages }
        );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox installPackages");
    }
  }

  async scanCode(
    request: SandboxScanCodeRequest
  ): Promise<SandboxScanCodeResponse> {
    try {
      const response = await this.client.post<SandboxScanCodeResponse>(
        "/api/v1/security/scan",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "Sandbox scanCode");
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get("/api/health");
      const latency = Date.now() - start;
      return {
        status: ["ok", "healthy"].includes(response.data?.status)
          ? "healthy"
          : "degraded",
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
