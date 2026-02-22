import axios, { AxiosInstance, AxiosError } from "axios";

// --- Interfaces ---

export interface GeoAgentEarthEngineRequest {
  analysisType:
    | "ndvi"
    | "land_cover"
    | "change_detection"
    | "elevation"
    | "water_detection"
    | "custom";
  region: GeoAgentRegion;
  dateRange: { start: string; end: string };
  satellite?: string;
  bands?: string[];
  scale?: number;
  customScript?: string;
}

export interface GeoAgentRegion {
  type: "polygon" | "bbox" | "point_buffer";
  coordinates: number[][] | number[];
  bufferRadius?: number;
}

export interface GeoAgentEarthEngineResponse {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  result?: {
    imageUrl?: string;
    statistics?: Record<string, number>;
    geoJson?: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
}

export interface GeoAgentVertexAIRequest {
  model: string;
  inputData: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  region?: string;
  geoContext?: {
    location?: { lat: number; lng: number };
    region?: GeoAgentRegion;
  };
}

export interface GeoAgentVertexAIResponse {
  predictionId: string;
  predictions: unknown[];
  metadata: Record<string, unknown>;
  latency: number;
}

export interface GeoAgentBigQueryGISRequest {
  query: string;
  parameters?: Record<string, unknown>;
  maxResults?: number;
  location?: string;
  outputFormat?: "json" | "geojson" | "csv";
}

export interface GeoAgentBigQueryGISResponse {
  jobId: string;
  status: "completed" | "failed";
  rows: Record<string, unknown>[];
  totalRows: number;
  schema: Array<{ name: string; type: string }>;
  bytesProcessed: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class GeoAgentClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.GEOAGENT_URL;
    if (!baseURL) {
      throw new Error("GEOAGENT_URL environment variable is not set");
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

  async earthEngineAnalysis(
    request: GeoAgentEarthEngineRequest
  ): Promise<GeoAgentEarthEngineResponse> {
    try {
      const response = await this.client.post<GeoAgentEarthEngineResponse>(
        "/api/v1/earth-engine/analyze",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GeoAgent earthEngineAnalysis");
    }
  }

  async vertexAIInference(request: GeoAgentVertexAIRequest): Promise<GeoAgentVertexAIResponse> {
    try {
      const response = await this.client.post<GeoAgentVertexAIResponse>(
        "/api/v1/vertex-ai/infer",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GeoAgent vertexAIInference");
    }
  }

  async bigQueryGIS(request: GeoAgentBigQueryGISRequest): Promise<GeoAgentBigQueryGISResponse> {
    try {
      const response = await this.client.post<GeoAgentBigQueryGISResponse>(
        "/api/v1/bigquery-gis/query",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GeoAgent bigQueryGIS");
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
