/**
 * Skills Engine Task Handler — Bridge between Trigger.dev task execution
 * and Skills Engine generation.
 *
 * When a `skills-engine-generate` task is triggered, this handler:
 * 1. POSTs to Skills Engine /api/v1/skills/generate
 * 2. Polls /api/v1/skills/jobs/:jobId with exponential backoff
 * 3. Returns final result (skillEntityId, jobId, operationId) as run output
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

export class SkillsEngineTaskHandler {
  private client: AxiosInstance;

  constructor(organizationId: string) {
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
        'X-User-Id': organizationId,
      },
    });
  }

  /**
   * Handle a skills-engine-generate task: POST to generate, poll for completion.
   */
  async handleGenerate(
    payload: SkillsEngineGeneratePayload,
    onProgress?: (update: { jobId: string; status: string; phase?: string }) => void
  ): Promise<SkillsEngineGenerateResult> {
    // 1. Kick off generation
    logger.info('Starting skill generation', { prompt: payload.prompt?.substring(0, 100) });

    const generateResponse = await this.client.post('/api/v1/skills/generate', {
      prompt: payload.prompt,
      category: payload.category,
      model: payload.model,
      artifacts: payload.artifacts,
      constraints: payload.constraints,
      skipPublish: payload.skipPublish,
    });

    const { jobId, operationId } = generateResponse.data?.data || generateResponse.data;
    if (!jobId) {
      throw new Error('Skills Engine did not return a jobId');
    }

    logger.info('Skill generation started', { jobId, operationId });
    onProgress?.({ jobId, status: 'started' });

    // 2. Poll for completion with exponential backoff
    return this.pollJobUntilDone(jobId, operationId, onProgress);
  }

  /**
   * Handle a skills-engine-regenerate task.
   */
  async handleRegenerate(
    payload: { skillId: string; force?: boolean },
    onProgress?: (update: { jobId: string; status: string; phase?: string }) => void
  ): Promise<SkillsEngineGenerateResult> {
    logger.info('Starting skill regeneration', { skillId: payload.skillId });

    const response = await this.client.post(`/api/v1/skills/${payload.skillId}/regenerate`, {
      force: payload.force ?? false,
    });

    const { jobId, operationId } = response.data?.data || response.data;
    if (!jobId) {
      throw new Error('Skills Engine did not return a jobId for regeneration');
    }

    logger.info('Skill regeneration started', { jobId, operationId, skillId: payload.skillId });
    onProgress?.({ jobId, status: 'started' });

    return this.pollJobUntilDone(jobId, operationId, onProgress);
  }

  /**
   * Poll Skills Engine /jobs/:jobId until terminal state.
   */
  private async pollJobUntilDone(
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
