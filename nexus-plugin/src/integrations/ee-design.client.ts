/**
 * EE Design Partner Integration Client
 *
 * HTTP client for communicating with the EE Design Partner backend
 * from Trigger.dev tasks. Handles:
 * - Triggering MAPO pipeline phases via Python executor
 * - Fetching operation status and quality gate results
 * - File management (inject files, retrieve artifacts)
 * - Parameter updates for running operations
 */

import axios, { AxiosInstance, AxiosError } from 'axios';

// ─── Interfaces ──────────────────────────────────────────────────────────

export interface MAPOPipelineInput {
  projectId: string;
  projectName: string;
  operationId: string;
  subsystems: Array<{
    id: string;
    name: string;
    category: string;
    description?: string;
  }>;
  ideationArtifacts?: Array<{
    artifact_type: string;
    category: string;
    name: string;
    content: string;
    subsystem_ids?: string[];
  }>;
  aiProvider?: string;
  resumeFromCheckpoint?: boolean;
  parameters?: Record<string, unknown>;
}

export interface MAPOPhaseResult {
  success: boolean;
  phase: string;
  output?: Record<string, unknown>;
  errors?: string[];
  warnings?: string[];
  durationMs: number;
  artifacts?: Array<{
    name: string;
    path: string;
    type: string;
    size: number;
  }>;
}

export interface QualityGateResult {
  name: string;
  passed: boolean;
  threshold: number;
  actual: number;
  unit: string;
  critical: boolean;
  details?: string;
}

export interface PipelineResult {
  success: boolean;
  schematicPath?: string;
  bomPath?: string;
  netlistPath?: string;
  qualityGates: QualityGateResult[];
  phaseResults: MAPOPhaseResult[];
  totalDurationMs: number;
  iteration?: number;
  errors: string[];
  warnings: string[];
}

export interface OperationStatus {
  operationId: string;
  status: string;
  progress: number;
  currentStep: string;
  phase?: string;
  qualityGates?: QualityGateResult[];
}

// ─── Client ──────────────────────────────────────────────────────────────

export class EEDesignClient {
  private http: AxiosInstance;
  private organizationId: string;

  constructor(organizationId: string) {
    this.organizationId = organizationId;

    const baseURL = process.env.EE_DESIGN_API_URL
      || 'http://nexus-ee-design.nexus.svc.cluster.local:3400';

    this.http = axios.create({
      baseURL: `${baseURL}/api/v1`,
      timeout: 7200000, // 2 hour timeout — pipeline phases can take 2-80 min
      headers: {
        'Content-Type': 'application/json',
        'X-Organization-ID': organizationId,
      },
    });
  }

  /**
   * Trigger a MAPO pipeline run
   * Returns the operation ID for tracking
   */
  async triggerPipeline(input: MAPOPipelineInput): Promise<string> {
    const res = await this.http.post(
      `/projects/${input.projectId}/schematic/generate`,
      {
        architecture: {
          subsystems: input.subsystems,
        },
        components: [],
        name: input.projectName,
        resume_from_checkpoint: input.resumeFromCheckpoint || false,
      },
      {
        headers: {
          'X-AI-Provider': input.aiProvider || 'claude_code_max',
        },
      }
    );

    return res.data?.data?.operationId || '';
  }

  /**
   * Get operation status
   */
  async getOperationStatus(operationId: string): Promise<OperationStatus> {
    const res = await this.http.get(`/operations/${operationId}`);
    const data = res.data?.data;

    return {
      operationId: data?.id || operationId,
      status: data?.status || 'unknown',
      progress: data?.progress ?? 0,
      currentStep: data?.currentStep || '',
      phase: data?.phase,
      qualityGates: data?.qualityGates,
    };
  }

  /**
   * Update operation parameters mid-run
   */
  async updateParams(operationId: string, params: Record<string, unknown>): Promise<void> {
    await this.http.patch(`/operations/${operationId}/params`, {
      parameters: params,
    });
  }

  /**
   * Cancel a running operation
   */
  async cancelOperation(operationId: string): Promise<void> {
    await this.http.post(`/operations/${operationId}/cancel`);
  }

  /**
   * Get project details
   */
  async getProject(projectId: string): Promise<Record<string, unknown>> {
    const res = await this.http.get(`/projects/${projectId}`);
    return res.data?.data || {};
  }

  /**
   * Fetch quality gate results for an operation
   */
  async getQualityGates(operationId: string): Promise<QualityGateResult[]> {
    const res = await this.http.get(`/operations/${operationId}`);
    return res.data?.data?.qualityGates || [];
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ status: string; latency: number }> {
    const start = Date.now();
    try {
      await this.http.get('/health');
      return { status: 'healthy', latency: Date.now() - start };
    } catch {
      return { status: 'unhealthy', latency: Date.now() - start };
    }
  }
}
