/**
 * Skills Engine Task Handler — Bridge between Trigger.dev task execution
 * and Skills Engine generation.
 *
 * When a `skills-engine-generate` task is triggered, this handler:
 * 1. POSTs to Skills Engine /api/v1/skills/generate (startGeneration)
 * 2. Returns jobId/operationId immediately for progress tracking
 * 3. Polls /api/v1/skills/jobs/:jobId with exponential backoff (pollJobUntilDone)
 * 4. Returns final result (skillEntityId, jobId, operationId) as run output
 */

import { AxiosInstance, AxiosError } from 'axios';
import { createResilientClient } from '../integrations/resilient-client';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'skills-engine-task-handler' });

// Polling config (matches workflow-executor.ts pattern)
const POLL_INITIAL_MS = 2000;
const POLL_BACKOFF_FACTOR = 2;
const POLL_MAX_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled']);

export interface SkillsEngineGeneratePayload {
  prompt: string;
  category?: string;
  model?: string;
  artifacts?: Array<{
    filename: string;
    content: string;
    mimeType?: string;
  }>;
  constraints?: Record<string, unknown>;
  skipPublish?: boolean;
}

export interface SkillsEngineGenerateResult {
  jobId: string;
  operationId: string;
  skillEntityId?: string;
  status: string;
  phases?: Record<string, unknown>;
  error?: string;
}

export interface SkillsEngineBatchResult {
  jobIds: string[];
  total: number;
  skipped: string[];
}

export class SkillsEngineTaskHandler {
  private client: AxiosInstance;

  constructor(organizationId: string, userId: string) {
    const baseURL = process.env.SKILLS_ENGINE_URL;
    if (!baseURL) {
      throw new Error('SKILLS_ENGINE_URL environment variable is not set');
    }

    this.client = createResilientClient({
      serviceName: 'skills-engine-task',
      baseURL,
      timeout: 120_000, // 2 min per request (generation can be slow)
      headers: {
        'Content-Type': 'application/json',
        'X-Organization-ID': organizationId,
        'X-User-Id': userId,
      },
    });
  }

  // ===========================================================================
  // START methods — kick off generation, return jobId/operationId immediately
  // ===========================================================================

  /**
   * Start skill generation: POST to Skills Engine, return jobId/operationId.
   * Does NOT poll — returns as soon as Skills Engine acknowledges the request.
   */
  async startGeneration(
    payload: SkillsEngineGeneratePayload
  ): Promise<{ jobId: string; operationId: string }> {
    logger.info('Starting skill generation', { prompt: payload.prompt?.substring(0, 100) });

    const response = await this.client.post('/api/v1/skills/generate', {
      prompt: payload.prompt,
      category: payload.category,
      model: payload.model,
      artifacts: payload.artifacts,
      constraints: payload.constraints,
      skipPublish: payload.skipPublish,
    });

    const { jobId, operationId } = response.data?.data || response.data;
    if (!jobId) {
      throw new Error('Skills Engine did not return a jobId');
    }

    logger.info('Skill generation started', { jobId, operationId });
    return { jobId, operationId };
  }

  /**
   * Start skill regeneration: POST to Skills Engine, return jobId/operationId.
   */
  async startRegeneration(
    payload: { skillId: string; force?: boolean }
  ): Promise<{ jobId: string; operationId: string }> {
    logger.info('Starting skill regeneration', { skillId: payload.skillId });

    const response = await this.client.post(`/api/v1/skills/${payload.skillId}/regenerate`, {
      force: payload.force ?? false,
    });

    const { jobId, operationId } = response.data?.data || response.data;
    if (!jobId) {
      throw new Error('Skills Engine did not return a jobId for regeneration');
    }

    logger.info('Skill regeneration started', { jobId, operationId, skillId: payload.skillId });
    return { jobId, operationId };
  }

  // ===========================================================================
  // COMBINED methods — start + poll (used when called standalone, not via task.service)
  // ===========================================================================

  /**
   * Full generate flow: start generation + poll until done.
   */
  async handleGenerate(
    payload: SkillsEngineGeneratePayload,
    onProgress?: (update: { jobId: string; status: string; phase?: string }) => void
  ): Promise<SkillsEngineGenerateResult> {
    const { jobId, operationId } = await this.startGeneration(payload);
    onProgress?.({ jobId, status: 'started' });
    return this.pollJobUntilDone(jobId, operationId, onProgress);
  }

  /**
   * Full regenerate flow: start regeneration + poll until done.
   */
  async handleRegenerate(
    payload: { skillId: string; force?: boolean },
    onProgress?: (update: { jobId: string; status: string; phase?: string }) => void
  ): Promise<SkillsEngineGenerateResult> {
    const { jobId, operationId } = await this.startRegeneration(payload);
    onProgress?.({ jobId, status: 'started' });
    return this.pollJobUntilDone(jobId, operationId, onProgress);
  }

  /**
   * Batch regeneration: POST to Skills Engine regenerate-all endpoint.
   * Returns immediately with jobIds — actual regeneration is fire-and-forget on Skills Engine.
   */
  async handleBatchRegenerate(
    payload: { force?: boolean },
    onProgress?: (update: { jobId: string; status: string; phase?: string }) => void
  ): Promise<SkillsEngineBatchResult> {
    logger.info('Starting batch skill regeneration', { force: payload.force });

    const response = await this.client.post('/api/v1/skills/regenerate-all', {
      force: payload.force ?? false,
    });

    const data = response.data?.data || response.data;
    const result: SkillsEngineBatchResult = {
      jobIds: data.jobIds || [],
      total: data.total || 0,
      skipped: data.skipped || [],
    };

    logger.info('Batch regeneration started', { total: result.total, skipped: result.skipped.length });
    onProgress?.({ jobId: 'batch', status: 'started', phase: `${result.total} skills queued` });

    return result;
  }

  // ===========================================================================
  // POLLING — poll Skills Engine /jobs/:jobId until terminal state
  // ===========================================================================

  /**
   * Poll Skills Engine /jobs/:jobId until terminal state.
   * Public so task.service can call it separately after startGeneration().
   */
  async pollJobUntilDone(
    jobId: string,
    operationId: string,
    onProgress?: (update: { jobId: string; status: string; phase?: string }) => void
  ): Promise<SkillsEngineGenerateResult> {
    const startTime = Date.now();
    let pollInterval = POLL_INITIAL_MS;
    let lastPhase = '';

    while (Date.now() - startTime < DEFAULT_TIMEOUT_MS) {
      await this.sleep(pollInterval);

      try {
        const statusResponse = await this.client.get(`/api/v1/skills/jobs/${jobId}`);
        const jobData = statusResponse.data?.data || statusResponse.data;
        const status = jobData.status?.toLowerCase() || 'unknown';
        const currentPhase = jobData.currentPhase || jobData.phase || '';

        // Emit progress if phase changed
        if (currentPhase && currentPhase !== lastPhase) {
          lastPhase = currentPhase;
          onProgress?.({ jobId, status, phase: currentPhase });
          logger.debug('Skill generation phase update', { jobId, phase: currentPhase, status });
        }

        if (status === 'completed') {
          logger.info('Skill generation completed', {
            jobId,
            operationId,
            skillEntityId: jobData.skillEntityId || jobData.skillId,
            durationMs: Date.now() - startTime,
          });

          return {
            jobId,
            operationId,
            skillEntityId: jobData.skillEntityId || jobData.skillId,
            status: 'completed',
            phases: jobData.phases,
          };
        }

        if (TERMINAL_STATUSES.has(status) && status !== 'completed') {
          const errorMsg = jobData.error || jobData.errorMessage || `Job ended with status: ${status}`;
          logger.error('Skill generation failed', { jobId, status, error: errorMsg });
          throw new Error(errorMsg);
        }
      } catch (error) {
        if (error instanceof AxiosError && error.response?.status === 404) {
          logger.warn('Job not found (may be delayed)', { jobId });
          // Job might not be visible yet, keep polling
        } else if (!(error instanceof AxiosError)) {
          // Re-throw non-Axios errors (like our own thrown errors above)
          throw error;
        } else {
          logger.warn('Poll request failed', { jobId, error: (error as Error).message });
        }
      }

      // Exponential backoff
      pollInterval = Math.min(pollInterval * POLL_BACKOFF_FACTOR, POLL_MAX_INTERVAL_MS);
    }

    throw new Error(`Skill generation timed out after ${DEFAULT_TIMEOUT_MS / 1000}s for job ${jobId}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
