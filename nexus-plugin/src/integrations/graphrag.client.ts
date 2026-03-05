import { AxiosInstance, AxiosError } from "axios";
import { createResilientClient } from "./resilient-client";

// --- Interfaces ---

export interface GraphRAGSearchRequest {
  query: string;
  collection?: string;
  topK?: number;
  filters?: Record<string, unknown>;
  includeMetadata?: boolean;
}

export interface GraphRAGSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  relationships?: GraphRAGRelationship[];
}

export interface GraphRAGSearchResponse {
  results: GraphRAGSearchResult[];
  totalCount: number;
  queryTime: number;
}

export interface GraphRAGStoreDocumentRequest {
  content: string;
  collection?: string;
  metadata?: Record<string, unknown>;
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface GraphRAGStoreDocumentResponse {
  documentId: string;
  chunks: number;
  status: string;
}

export interface GraphRAGIngestUrlRequest {
  url: string;
  collection?: string;
  metadata?: Record<string, unknown>;
  depth?: number;
  maxPages?: number;
}

export interface GraphRAGIngestUrlResponse {
  jobId: string;
  status: string;
  pagesQueued: number;
}

export interface GraphRAGEntity {
  id?: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
  collection?: string;
}

export interface GraphRAGEntityResponse {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  createdAt: string;
}

export interface GraphRAGRelationship {
  id?: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface GraphRAGRelationshipResponse {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  properties: Record<string, unknown>;
  createdAt: string;
}

export interface GraphRAGStoreMemoryRequest {
  content: string;
  context?: string;
  tags?: string[];
  ttl?: number;
  collection?: string;
}

export interface GraphRAGStoreMemoryResponse {
  memoryId: string;
  status: string;
}

export interface GraphRAGRetrieveEnhancedRequest {
  query: string;
  collection?: string;
  topK?: number;
  enhancementStrategy?: "graph_expansion" | "semantic_reranking" | "hybrid";
  maxHops?: number;
  includeGraph?: boolean;
}

export interface GraphRAGRetrieveEnhancedResponse {
  results: GraphRAGSearchResult[];
  graphContext: {
    entities: GraphRAGEntityResponse[];
    relationships: GraphRAGRelationshipResponse[];
  };
  totalCount: number;
  queryTime: number;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class GraphRAGClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.GRAPHRAG_URL;
    if (!baseURL) {
      throw new Error("GRAPHRAG_URL environment variable is not set");
    }

    this.client = createResilientClient({
      serviceName: 'graphrag',
      baseURL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "X-Company-ID": organizationId,
        "X-App-ID": "nexus-trigger",
        "X-Organization-ID": organizationId,
      },
    });
  }

  async search(request: GraphRAGSearchRequest): Promise<GraphRAGSearchResponse> {
    try {
      const response = await this.client.post<GraphRAGSearchResponse>("/api/v1/search", request);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG search");
    }
  }

  async storeDocument(request: GraphRAGStoreDocumentRequest): Promise<GraphRAGStoreDocumentResponse> {
    try {
      const response = await this.client.post<GraphRAGStoreDocumentResponse>(
        "/api/v1/documents",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG storeDocument");
    }
  }

  async ingestUrl(request: GraphRAGIngestUrlRequest): Promise<GraphRAGIngestUrlResponse> {
    try {
      const response = await this.client.post<GraphRAGIngestUrlResponse>(
        "/api/v1/ingest/url",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG ingestUrl");
    }
  }

  async createEntity(entity: GraphRAGEntity): Promise<GraphRAGEntityResponse> {
    try {
      const response = await this.client.post<GraphRAGEntityResponse>("/api/v1/entities", entity);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG createEntity");
    }
  }

  async createRelationship(relationship: GraphRAGRelationship): Promise<GraphRAGRelationshipResponse> {
    try {
      const response = await this.client.post<GraphRAGRelationshipResponse>(
        "/api/v1/relationships",
        relationship
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG createRelationship");
    }
  }

  async storeMemory(request: GraphRAGStoreMemoryRequest): Promise<GraphRAGStoreMemoryResponse> {
    try {
      const response = await this.client.post<GraphRAGStoreMemoryResponse>(
        "/api/v1/memory",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG storeMemory");
    }
  }

  async retrieveEnhanced(
    request: GraphRAGRetrieveEnhancedRequest
  ): Promise<GraphRAGRetrieveEnhancedResponse> {
    try {
      const response = await this.client.post<GraphRAGRetrieveEnhancedResponse>(
        "/api/v1/retrieve/enhanced",
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "GraphRAG retrieveEnhanced");
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
