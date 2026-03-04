import { AxiosInstance, AxiosError } from "axios";
import { createResilientClient } from "./resilient-client";

// --- Interfaces ---

export interface CVATCreateTaskRequest {
  name: string;
  projectId?: number;
  labels: CVATLabel[];
  imageUrls?: string[];
  videoUrl?: string;
  segmentSize?: number;
  overlapSize?: number;
  assignee?: string;
}

export interface CVATLabel {
  name: string;
  color?: string;
  type?: "any" | "rectangle" | "polygon" | "polyline" | "points" | "ellipse" | "cuboid" | "mask";
  attributes?: Array<{
    name: string;
    inputType: "select" | "radio" | "checkbox" | "number" | "text";
    values: string[];
    defaultValue?: string;
  }>;
}

export interface CVATTask {
  id: number;
  name: string;
  status: "annotation" | "validation" | "completed";
  mode: "annotation" | "interpolation";
  size: number;
  labels: CVATLabel[];
  assignee?: string;
  createdDate: string;
  updatedDate: string;
  projectId?: number;
}

export interface CVATCreateTaskResponse {
  id: number;
  name: string;
  status: string;
  createdDate: string;
}

export interface CVATListTasksRequest {
  projectId?: number;
  status?: string;
  assignee?: string;
  page?: number;
  pageSize?: number;
}

export interface CVATListTasksResponse {
  tasks: CVATTask[];
  count: number;
  next?: string;
  previous?: string;
}

export interface CVATCreateAnnotationJobRequest {
  taskId: number;
  assignee?: string;
  startFrame?: number;
  stopFrame?: number;
  type?: "annotation" | "ground_truth";
}

export interface CVATAnnotationJob {
  id: number;
  taskId: number;
  assignee?: string;
  status: "new" | "in_progress" | "completed" | "rejected";
  startFrame: number;
  stopFrame: number;
  createdDate: string;
}

export interface CVATAnnotation {
  id: number;
  frame: number;
  label: string;
  type: "rectangle" | "polygon" | "polyline" | "points" | "ellipse" | "cuboid" | "mask";
  points: number[];
  attributes?: Record<string, string>;
  occluded: boolean;
  zOrder: number;
}

export interface CVATGetAnnotationsRequest {
  taskId: number;
  frame?: number;
  label?: string;
  type?: string;
}

export interface CVATGetAnnotationsResponse {
  annotations: CVATAnnotation[];
  totalCount: number;
  taskId: number;
}

export interface CVATExportDatasetRequest {
  taskId: number;
  format: "CVAT for images 1.1" | "COCO 1.0" | "PASCAL VOC 1.1" | "YOLO 1.1" | "LabelMe 3.0" | string;
  saveImages?: boolean;
}

export interface CVATExportDatasetResponse {
  exportId: string;
  status: "queued" | "processing" | "completed" | "failed";
  downloadUrl?: string;
}

export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  latency: number;
}

// --- Client ---

export class CVATClient {
  private client: AxiosInstance;

  constructor(organizationId: string) {
    const baseURL = process.env.CVAT_URL;
    if (!baseURL) {
      throw new Error("CVAT_URL environment variable is not set");
    }

    this.client = createResilientClient({
      serviceName: 'cvat',
      baseURL,
      timeout: 60000,
      headers: {
        "Content-Type": "application/json",
        "X-Organization-ID": organizationId,
      },
    });
  }

  async createTask(request: CVATCreateTaskRequest): Promise<CVATCreateTaskResponse> {
    try {
      const response = await this.client.post<CVATCreateTaskResponse>("/api/v1/tasks", request);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "CVAT createTask");
    }
  }

  async getTask(taskId: number): Promise<CVATTask> {
    try {
      const response = await this.client.get<CVATTask>(`/api/v1/tasks/${taskId}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error, "CVAT getTask");
    }
  }

  async listTasks(request?: CVATListTasksRequest): Promise<CVATListTasksResponse> {
    try {
      const response = await this.client.get<CVATListTasksResponse>("/api/v1/tasks", {
        params: request,
      });
      return response.data;
    } catch (error) {
      throw this.handleError(error, "CVAT listTasks");
    }
  }

  async createAnnotationJob(request: CVATCreateAnnotationJobRequest): Promise<CVATAnnotationJob> {
    try {
      const response = await this.client.post<CVATAnnotationJob>(
        `/api/v1/tasks/${request.taskId}/jobs`,
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "CVAT createAnnotationJob");
    }
  }

  async getAnnotations(request: CVATGetAnnotationsRequest): Promise<CVATGetAnnotationsResponse> {
    try {
      const { taskId, ...params } = request;
      const response = await this.client.get<CVATGetAnnotationsResponse>(
        `/api/v1/tasks/${taskId}/annotations`,
        { params }
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "CVAT getAnnotations");
    }
  }

  async exportDataset(request: CVATExportDatasetRequest): Promise<CVATExportDatasetResponse> {
    try {
      const { taskId, ...body } = request;
      const response = await this.client.post<CVATExportDatasetResponse>(
        `/api/v1/tasks/${taskId}/dataset/export`,
        body
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, "CVAT exportDataset");
    }
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const start = Date.now();
    try {
      const response = await this.client.get("/api/server/about");
      const latency = Date.now() - start;
      return {
        status: response.data?.version ? "healthy" : "degraded",
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
