import { AxiosInstance, AxiosError } from "axios";
import { createResilientClient } from "./resilient-client";

// --- Interfaces ---

export interface FileProcessRequest {
  fileUrl?: string;
  fileBase64?: string;
  fileName: string;
  mimeType?: string;
  operations: FileProcessOperation[];
  outputFormat?: string;
  webhookUrl?: string;
}

export interface FileProcessOperation {
  type: "extract_text" | "extract_tables" | "convert" | "compress" | "split" | "merge" | "ocr";
  options?: Record<string, unknown>;
}

export interface FileProcessResponse {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  estimatedDuration?: number;
}

export interface FileProcessJobStatus {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  result?: FileProcessResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileProcessResult {
  outputUrl?: string;
  outputBase64?: string;
  metadata: Record<string, unknown>;
  pages?: number;
  size?: number;
}

export interface FileExtractTextRequest {
  fileUrl?: string;
  fileBase64?: string;
  fileName: string;
  mimeType?: string;
  language?: string;
  ocrEnabled?: boolean;
  format?: "plain" | "markdown" | "html";
}

export interface FileExtractTextResponse {
  text: string;
  pages: number;
  language?: string;
  confidence?: number;
  metadata: Record<string, unknown>;
}

export interface FileExtractTablesRequest {
  fileUrl?: string;
  fileBase64?: string;
  fileName: string;
  mimeType?: string;
  outputFormat?: "json" | "csv" | "markdown";
  pages?: number[];
}

export interface FileExtractTablesResponse {
  tables: FileExtractedTable[];
  totalTables: number;
}

export interface FileExtractedTable {
  pageNumber: number;
  tableIndex: number;
  headers: string[];
  rows: string[][];
  confidence: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class FileProcessClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.FILEPROCESS_URL;
    if (!baseURL) {
      throw new Error("FILEPROCESS_URL environment variable is not set");
    }

    this.client = createResilientClient({
      serviceName: 'fileprocess',
      baseURL,
      timeout: 60000,
      headers: {
        "Content-Type": "application/json",
        "X-Organization-ID": organizationId,
      },
    });
  }

  async processFile(request: FileProcessRequest): Promise<FileProcessResponse> {
    try {
      const response = await this.client.post<FileProcessResponse>("/api/v1/process", request);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "FileProcess processFile");
    }
  }

  async getJobStatus(jobId: string): Promise<FileProcessJobStatus> {
    try {
      const response = await this.client.get<FileProcessJobStatus>(`/api/v1/jobs/${jobId}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "FileProcess getJobStatus");
    }
  }

  async extractText(request: FileExtractTextRequest): Promise<FileExtractTextResponse> {
    try {
      const response = await this.client.post<FileExtractTextResponse>(
        "/api/v1/extract/text",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "FileProcess extractText");
    }
  }

  async extractTables(request: FileExtractTablesRequest): Promise<FileExtractTablesResponse> {
    try {
      const response = await this.client.post<FileExtractTablesResponse>(
        "/api/v1/extract/tables",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "FileProcess extractTables");
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
