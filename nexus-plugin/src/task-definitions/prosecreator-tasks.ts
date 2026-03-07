/**
 * ProseCreator Task Definitions
 *
 * Trigger.dev tasks for the ProseCreator creative writing platform:
 * - prosecreatorGenerateBlueprint: Generate a living blueprint from an outline
 * - prosecreatorGenerateChapters: Generate chapters from a blueprint
 * - prosecreatorCharacterAnalysis: Deep character development analysis
 * - prosecreatorContinuityAudit: Cross-chapter continuity checking
 * - prosecreatorCNESAudit: Full CNES (Narrative, Emotional, Structural) audit
 * - prosecreatorQualityAssessment: Manuscript quality scoring
 * - prosecreatorAIDetectionScan: Scan writing for AI-generated content
 * - prosecreatorExportPipeline: Multi-format export (DOCX, EPUB, PDF)
 * - prosecreatorSeriesIntelligenceSync: Cross-book series consistency analysis
 * - prosecreatorDeepInsightGeneration: Semantic-level writing insights
 * - prosecreatorPanelAnalysis: Inspector panel LLM analysis via Claude Code Max proxy
 */

import { task } from '@trigger.dev/sdk/v3';
import { ProseCreatorClient } from '../integrations/prosecreator.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): ProseCreatorClient {
  return new ProseCreatorClient(organizationId);
}

const DEFAULT_N8N_INSTANCE_ID = process.env.DEFAULT_N8N_INSTANCE_ID || '';

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface ProseCreatorWorkflowPayload {
  organizationId: string;
  projectId: string;
  userId: string;
  n8nInstanceId?: string;
  inputData?: Record<string, unknown>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface ProseCreatorSeriesPayload {
  organizationId: string;
  seriesId: string;
  userId: string;
  n8nInstanceId?: string;
  inputData?: Record<string, unknown>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface ProseCreatorExportPayload {
  organizationId: string;
  projectId: string;
  userId: string;
  formats?: Array<'docx' | 'epub' | 'pdf'>;
  n8nInstanceId?: string;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface ProseCreatorWorkflowResult {
  executionId: string;
  templateKey: string;
  status: string;
  wasDeployed: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Shared workflow execution logic
// ---------------------------------------------------------------------------

async function executeProseCreatorWorkflow(
  client: ProseCreatorClient,
  templateKey: string,
  payload: {
    projectId: string;
    userId: string;
    n8nInstanceId?: string;
    inputData?: Record<string, unknown>;
    waitForCompletion?: boolean;
    timeoutMs?: number;
  }
): Promise<ProseCreatorWorkflowResult> {
  const startTime = Date.now();
  const n8nInstanceId = payload.n8nInstanceId || DEFAULT_N8N_INSTANCE_ID;
  const waitForCompletion = payload.waitForCompletion ?? false;
  const timeoutMs = payload.timeoutMs ?? 300000; // 5 min default

  console.log(
    `[prosecreator] Executing workflow: template=${templateKey}, project=${payload.projectId}, wait=${waitForCompletion}`
  );

  // Step 1: Resolve or deploy binding
  const { bindingId, wasDeployed } = await client.resolveBindingForTemplate(
    payload.projectId,
    templateKey,
    n8nInstanceId,
    payload.userId
  );

  if (wasDeployed) {
    console.log(`[prosecreator] Deployed template ${templateKey} for project ${payload.projectId}`);
  }

  // Step 2: Execute the workflow
  const execResult = await client.executeWorkflow(
    bindingId,
    {
      projectId: payload.projectId,
      userId: payload.userId,
      ...payload.inputData,
    },
    payload.userId
  );

  console.log(
    `[prosecreator] Workflow triggered: executionId=${execResult.executionId}, status=${execResult.status}`
  );

  if (!waitForCompletion) {
    return {
      executionId: execResult.executionId,
      templateKey,
      status: execResult.status,
      wasDeployed,
      durationMs: Date.now() - startTime,
    };
  }

  // Step 3: Poll for completion
  console.log(`[prosecreator] Waiting for completion (timeout=${timeoutMs}ms)`);
  const pollIntervalMs = 3000;
  const pollStart = Date.now();

  let lastStatus = execResult.status;
  while (
    (lastStatus === 'queued' || lastStatus === 'running') &&
    Date.now() - pollStart < timeoutMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    try {
      const jobStatus = await client.getJobStatus(execResult.executionId);
      lastStatus = jobStatus.status;

      if (lastStatus === 'completed' || lastStatus === 'failed') {
        const durationMs = Date.now() - startTime;
        console.log(
          `[prosecreator] Workflow ${templateKey} ${lastStatus}: duration=${durationMs}ms`
        );
        return {
          executionId: execResult.executionId,
          templateKey,
          status: lastStatus,
          wasDeployed,
          result: jobStatus.result,
          error: jobStatus.error,
          durationMs,
        };
      }
    } catch {
      // Poll failure is not fatal, keep trying
      console.warn(`[prosecreator] Poll failed for ${execResult.executionId}, retrying...`);
    }
  }

  const durationMs = Date.now() - startTime;
  if (lastStatus === 'queued' || lastStatus === 'running') {
    console.warn(`[prosecreator] Workflow ${templateKey} timed out after ${timeoutMs}ms`);
    return {
      executionId: execResult.executionId,
      templateKey,
      status: 'timeout',
      wasDeployed,
      durationMs,
    };
  }

  return {
    executionId: execResult.executionId,
    templateKey,
    status: lastStatus,
    wasDeployed,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const prosecreatorGenerateBlueprint = task({
  id: 'prosecreator-generate-blueprint',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'outline-to-blueprint', payload);
  },
});

export const prosecreatorGenerateChapters = task({
  id: 'prosecreator-generate-chapters',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'blueprint-to-manuscript', {
      ...payload,
      timeoutMs: payload.timeoutMs ?? 600000, // 10 min for full manuscript
    });
  },
});

export const prosecreatorCharacterAnalysis = task({
  id: 'prosecreator-character-analysis',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'character-development', payload);
  },
});

export const prosecreatorContinuityAudit = task({
  id: 'prosecreator-continuity-audit',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'continuity-audit', payload);
  },
});

export const prosecreatorCNESAudit = task({
  id: 'prosecreator-cnes-audit',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'cnes-full-audit', {
      ...payload,
      timeoutMs: payload.timeoutMs ?? 600000, // 10 min for full audit
    });
  },
});

export const prosecreatorQualityAssessment = task({
  id: 'prosecreator-quality-assessment',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'quality-assessment', payload);
  },
});

export const prosecreatorAIDetectionScan = task({
  id: 'prosecreator-ai-detection-scan',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'ai-detection-scan', payload);
  },
});

export const prosecreatorExportPipeline = task({
  id: 'prosecreator-export-pipeline',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ProseCreatorExportPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'export-pipeline', {
      projectId: payload.projectId,
      userId: payload.userId,
      n8nInstanceId: payload.n8nInstanceId,
      waitForCompletion: payload.waitForCompletion,
      timeoutMs: payload.timeoutMs,
      inputData: {
        formats: payload.formats || ['docx', 'epub', 'pdf'],
      },
    });
  },
});

export const prosecreatorSeriesIntelligenceSync = task({
  id: 'prosecreator-series-intelligence-sync',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async (payload: ProseCreatorSeriesPayload) => {
    const client = getClient(payload.organizationId);

    // Series tasks use seriesId instead of projectId in the input
    return executeProseCreatorWorkflow(client, 'series-intelligence-sync', {
      projectId: payload.seriesId, // Binding resolved at series level
      userId: payload.userId,
      n8nInstanceId: payload.n8nInstanceId,
      waitForCompletion: payload.waitForCompletion,
      timeoutMs: payload.timeoutMs ?? 600000,
      inputData: {
        seriesId: payload.seriesId,
        ...payload.inputData,
      },
    });
  },
});

export const prosecreatorDeepInsightGeneration = task({
  id: 'prosecreator-deep-insight-generation',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: ProseCreatorWorkflowPayload) => {
    const client = getClient(payload.organizationId);
    return executeProseCreatorWorkflow(client, 'deep-insight-generation', payload);
  },
});

// ---------------------------------------------------------------------------
// Inspector Panel Analysis — generic LLM call via Claude Code Max proxy
// ---------------------------------------------------------------------------

export interface PanelAnalysisPayload {
  organizationId: string;
  analysisType: string;
  systemMessage: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface PanelAnalysisResult {
  content: string;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  analysisType: string;
  durationMs: number;
}

/**
 * Generic inspector panel analysis task.
 * Receives a fully-built prompt and calls Claude Code Max proxy
 * (flat rate, unlimited) instead of MageAgent or OpenRouter.
 */
export const prosecreatorPanelAnalysis = task({
  id: 'prosecreator-panel-analysis',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 180000,
    factor: 2,
  },
  run: async (payload: PanelAnalysisPayload): Promise<PanelAnalysisResult> => {
    const startTime = Date.now();
    const proxyUrl = process.env.CLAUDE_CODE_MAX_PROXY_URL || 'http://claude-code-proxy:3100';

    console.log(
      `[prosecreator] Panel analysis: type=${payload.analysisType}, promptLen=${payload.prompt.length}`
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 150000); // 2.5 min

    try {
      const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4',
          messages: [
            { role: 'system', content: payload.systemMessage },
            { role: 'user', content: payload.prompt },
          ],
          max_tokens: payload.maxTokens || 8000,
          temperature: payload.temperature || 0.3,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Claude Code Max proxy error ${res.status}: ${errText.slice(0, 300)}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await res.json() as any;
      const durationMs = Date.now() - startTime;

      console.log(
        `[prosecreator] Panel analysis complete: type=${payload.analysisType}, duration=${durationMs}ms, model=${data.model || 'unknown'}`
      );

      return {
        content: data.choices?.[0]?.message?.content || '',
        model: data.model || 'unknown',
        usage: data.usage || {},
        analysisType: payload.analysisType,
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
});
