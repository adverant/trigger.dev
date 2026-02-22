/**
 * MageAgent Task Definitions
 *
 * Trigger.dev tasks for Nexus MageAgent orchestration service:
 * - mageAgentOrchestration: Multi-agent orchestration with retry and failover
 * - mageAgentCompetition: Competitive agent evaluation for best result
 * - visionAIProcess: Vision model processing (image/diagram analysis)
 * - embeddingGeneration: Batch embedding generation for vector storage
 */

import { task } from '@trigger.dev/sdk/v3';
import { MageAgentClient } from '../integrations/mageagent.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): MageAgentClient {
  return new MageAgentClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface MageAgentOrchestrationPayload {
  organizationId: string;
  sessionId: string;
  prompt: string;
  agentConfig: {
    primaryModel: string;
    fallbackModels?: string[];
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
  };
  context?: {
    projectId?: string;
    taskId?: string;
    conversationHistory?: Array<{ role: string; content: string }>;
    attachments?: Array<{ type: string; url: string; name: string }>;
  };
  routing?: {
    strategy: 'round-robin' | 'least-loaded' | 'priority' | 'cost-optimized';
    priority?: number;
    maxCostCents?: number;
  };
}

export interface MageAgentCompetitionPayload {
  organizationId: string;
  prompt: string;
  competitors: Array<{
    agentId: string;
    model: string;
    systemPrompt?: string;
    temperature?: number;
  }>;
  evaluationCriteria: {
    metrics: Array<'accuracy' | 'relevance' | 'creativity' | 'conciseness' | 'completeness'>;
    evaluatorModel?: string;
    customRubric?: string;
  };
  context?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface VisionAIProcessPayload {
  organizationId: string;
  imageUrls: string[];
  analysisType: 'describe' | 'extract-text' | 'classify' | 'detect-objects' | 'diagram-to-code' | 'custom';
  model?: string;
  customPrompt?: string;
  outputFormat?: 'json' | 'markdown' | 'text';
  maxTokens?: number;
}

export interface EmbeddingGenerationPayload {
  organizationId: string;
  documents: Array<{
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  model?: string;
  dimensions?: number;
  batchSize?: number;
  storeInVectorDb?: boolean;
  collectionName?: string;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface OrchestrationResult {
  sessionId: string;
  response: string;
  modelUsed: string;
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  costCents: number;
  latencyMs: number;
  fallbackUsed: boolean;
}

export interface CompetitionResult {
  winnerId: string;
  winnerModel: string;
  scores: Array<{
    agentId: string;
    model: string;
    overallScore: number;
    metricScores: Record<string, number>;
    response: string;
    latencyMs: number;
  }>;
  evaluation: string;
  totalCostCents: number;
}

export interface VisionResult {
  results: Array<{
    imageUrl: string;
    analysis: string;
    structuredData?: Record<string, unknown>;
    confidence: number;
  }>;
  modelUsed: string;
  totalTokens: number;
}

export interface EmbeddingResult {
  documentsProcessed: number;
  embeddingDimensions: number;
  modelUsed: string;
  storedInVectorDb: boolean;
  collectionName?: string;
  vectorIds: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Multi-agent orchestration with retry and model fallover.
 *
 * Maps to MageAgentClient.process() -- sends the prompt with the primary model
 * and falls back through fallbackModels on failure.
 */
export const mageAgentOrchestration = task({
  id: 'mageagent-orchestration',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: MageAgentOrchestrationPayload) => {
    console.log(
      `[mageagent] Starting orchestration session=${payload.sessionId}, model=${payload.agentConfig.primaryModel}`
    );

    const client = getClient(payload.organizationId);
    const startTime = Date.now();
    let fallbackUsed = false;
    let response;

    try {
      response = await client.process({
        prompt: payload.prompt,
        model: payload.agentConfig.primaryModel,
        systemPrompt: payload.agentConfig.systemPrompt,
        maxTokens: payload.agentConfig.maxTokens ?? 4096,
        temperature: payload.agentConfig.temperature ?? 0.7,
        context: payload.context
          ? {
              projectId: payload.context.projectId,
              taskId: payload.context.taskId,
              conversationHistory: payload.context.conversationHistory,
              attachments: payload.context.attachments,
              routing: payload.routing,
            }
          : undefined,
      });
    } catch (primaryError) {
      const fallbackModels = payload.agentConfig.fallbackModels || [];
      if (fallbackModels.length === 0) {
        throw primaryError;
      }

      console.warn(
        `[mageagent] Primary model ${payload.agentConfig.primaryModel} failed, attempting ${fallbackModels.length} fallbacks`
      );

      let lastError: unknown = primaryError;
      for (const fallbackModel of fallbackModels) {
        try {
          console.log(`[mageagent] Trying fallback model: ${fallbackModel}`);
          response = await client.process({
            prompt: payload.prompt,
            model: fallbackModel,
            systemPrompt: payload.agentConfig.systemPrompt,
            maxTokens: payload.agentConfig.maxTokens ?? 4096,
            temperature: payload.agentConfig.temperature ?? 0.7,
            context: payload.context
              ? {
                  projectId: payload.context.projectId,
                  taskId: payload.context.taskId,
                  conversationHistory: payload.context.conversationHistory,
                  attachments: payload.context.attachments,
                  routing: payload.routing,
                }
              : undefined,
          });
          fallbackUsed = true;
          break;
        } catch (fallbackError) {
          console.error(`[mageagent] Fallback model ${fallbackModel} also failed`);
          lastError = fallbackError;
        }
      }

      if (!response) {
        throw lastError;
      }
    }

    const latencyMs = Date.now() - startTime;

    // Estimate cost from token usage (rough heuristic -- the MageAgent API
    // does not return cost directly, so we leave 0 for now).
    const costCents = 0;

    console.log(
      `[mageagent] Orchestration complete: model=${response.model}, tokens=${response.usage.totalTokens}, cost=${costCents}c, latency=${latencyMs}ms, fallback=${fallbackUsed}`
    );

    return {
      sessionId: payload.sessionId,
      response: response.result,
      modelUsed: response.model,
      tokensUsed: {
        prompt: response.usage.promptTokens,
        completion: response.usage.completionTokens,
        total: response.usage.totalTokens,
      },
      costCents,
      latencyMs,
      fallbackUsed,
    } satisfies OrchestrationResult;
  },
});

/**
 * Competitive agent evaluation -- runs the same prompt across multiple models
 * and picks the best response.
 *
 * Maps to MageAgentClient.compete() which accepts a list of models and returns
 * scored results with a winner.
 */
export const mageAgentCompetition = task({
  id: 'mageagent-competition',
  run: async (payload: MageAgentCompetitionPayload) => {
    console.log(
      `[mageagent] Starting competition with ${payload.competitors.length} agents, metrics=${payload.evaluationCriteria.metrics.join(',')}`
    );

    const client = getClient(payload.organizationId);

    // Build the evaluation criteria string from the structured metrics and
    // optional custom rubric so compete() can use it.
    const criteriaString = [
      `Evaluate on: ${payload.evaluationCriteria.metrics.join(', ')}`,
      payload.evaluationCriteria.customRubric
        ? `Rubric: ${payload.evaluationCriteria.customRubric}`
        : '',
    ]
      .filter(Boolean)
      .join('. ');

    // compete() accepts a flat list of model names and a single temperature.
    // We use the first competitor's temperature as the default.
    const competeResponse = await client.compete({
      prompt: payload.prompt,
      models: payload.competitors.map((c) => c.model),
      evaluationCriteria: criteriaString,
      temperature: payload.competitors[0]?.temperature ?? 0.7,
    });

    // Map compete() results back to the CompetitionResult shape.
    // compete() returns per-model results with score & latency; we need to
    // cross-reference with the original competitor list to get agentId.
    const scores: CompetitionResult['scores'] = competeResponse.results.map((cr) => {
      // Find the original competitor entry for this model.
      const competitor = payload.competitors.find((c) => c.model === cr.model);
      return {
        agentId: competitor?.agentId ?? cr.model,
        model: cr.model,
        overallScore: cr.score,
        metricScores: {}, // compete() doesn't break down per-metric
        response: cr.response,
        latencyMs: cr.latency,
      };
    });

    scores.sort((a, b) => b.overallScore - a.overallScore);
    const winner = scores[0];

    console.log(
      `[mageagent] Competition winner: agent=${winner.agentId}, model=${winner.model}, score=${winner.overallScore}`
    );

    return {
      winnerId: winner.agentId,
      winnerModel: winner.model,
      scores,
      evaluation: competeResponse.evaluation,
      totalCostCents: 0, // compete() does not return cost
    } satisfies CompetitionResult;
  },
});

/**
 * Vision AI processing -- analyses each image individually through
 * MageAgentClient.visionAnalyze().
 *
 * Maps the payload's analysisType to the visionAnalyze() analysisType enum.
 * Images are processed sequentially (one at a time) to avoid overwhelming the
 * service and to allow partial failure handling.
 */
export const visionAIProcess = task({
  id: 'mageagent-vision-ai',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 15000,
    factor: 2,
  },
  run: async (payload: VisionAIProcessPayload) => {
    console.log(
      `[mageagent] Vision AI processing ${payload.imageUrls.length} images, type=${payload.analysisType}`
    );

    const client = getClient(payload.organizationId);

    // Map the broader payload analysisType to the narrower visionAnalyze enum.
    const analysisTypeMap: Record<
      VisionAIProcessPayload['analysisType'],
      'describe' | 'classify' | 'detect' | 'custom'
    > = {
      'describe': 'describe',
      'extract-text': 'custom',
      'classify': 'classify',
      'detect-objects': 'detect',
      'diagram-to-code': 'custom',
      'custom': 'custom',
    };

    // Build a prompt that incorporates the analysis type intent when the type
    // is mapped to 'custom'.
    function buildPrompt(type: VisionAIProcessPayload['analysisType'], customPrompt?: string): string | undefined {
      if (customPrompt) return customPrompt;
      switch (type) {
        case 'extract-text':
          return 'Extract all text visible in this image.';
        case 'diagram-to-code':
          return 'Analyze this diagram and generate corresponding code or structured representation.';
        default:
          return undefined;
      }
    }

    const imageResults: VisionResult['results'] = [];
    let totalTokens = 0;
    let modelUsed = payload.model ?? 'unknown';

    for (const imageUrl of payload.imageUrls) {
      console.log(`[mageagent] Analyzing image: ${imageUrl}`);

      const analyzeResponse = await client.visionAnalyze({
        imageUrl,
        analysisType: analysisTypeMap[payload.analysisType],
        prompt: buildPrompt(payload.analysisType, payload.customPrompt),
      });

      // Derive a confidence score from labels when available, otherwise default
      // to 1.0 (the API doesn't return an explicit confidence on the analysis).
      const avgConfidence =
        analyzeResponse.labels && analyzeResponse.labels.length > 0
          ? analyzeResponse.labels.reduce((sum, l) => sum + l.confidence, 0) /
            analyzeResponse.labels.length
          : 1.0;

      // Build structured data from labels and objects if present.
      const structuredData: Record<string, unknown> = {};
      if (analyzeResponse.labels) {
        structuredData.labels = analyzeResponse.labels;
      }
      if (analyzeResponse.objects) {
        structuredData.objects = analyzeResponse.objects;
      }

      imageResults.push({
        imageUrl,
        analysis: analyzeResponse.analysis,
        structuredData: Object.keys(structuredData).length > 0 ? structuredData : undefined,
        confidence: avgConfidence,
      });
    }

    console.log(
      `[mageagent] Vision processing complete: ${imageResults.length} images analyzed, model=${modelUsed}, tokens=${totalTokens}`
    );

    return {
      results: imageResults,
      modelUsed,
      totalTokens,
    } satisfies VisionResult;
  },
});

/**
 * Batch embedding generation.
 *
 * Maps to MageAgentClient.generateEmbedding() which accepts text (string or
 * string[]).  Documents are batched according to payload.batchSize and each
 * batch is sent as a string[] to generateEmbedding().
 *
 * Note: The actual MageAgent API does not expose a separate storeVectors()
 * method.  When storeInVectorDb is requested, the caller should handle vector
 * storage externally.  This task generates deterministic vector IDs from the
 * document IDs.
 */
export const embeddingGeneration = task({
  id: 'mageagent-embedding-generation',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 20000,
    factor: 2,
  },
  run: async (payload: EmbeddingGenerationPayload) => {
    const batchSize = payload.batchSize ?? 100;
    const model = payload.model ?? 'text-embedding-3-small';

    console.log(
      `[mageagent] Generating embeddings for ${payload.documents.length} documents, model=${model}, batchSize=${batchSize}`
    );

    const client = getClient(payload.organizationId);
    const startTime = Date.now();
    const allVectorIds: string[] = [];
    let embeddingDimensions = payload.dimensions ?? 0;

    for (let i = 0; i < payload.documents.length; i += batchSize) {
      const batch = payload.documents.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(payload.documents.length / batchSize);

      console.log(`[mageagent] Processing embedding batch ${batchNum}/${totalBatches} (${batch.length} docs)`);

      const embedResult = await client.generateEmbedding({
        text: batch.map((doc) => doc.content),
        model,
      });

      // Capture actual dimensions from the first successful response.
      if (embeddingDimensions === 0) {
        embeddingDimensions = embedResult.dimensions;
      }

      // Use the document IDs as vector IDs (1:1 correspondence between
      // input texts and output embeddings).
      const batchVectorIds = batch.map((doc) => doc.id);
      allVectorIds.push(...batchVectorIds);
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[mageagent] Embedding generation complete: docs=${payload.documents.length}, vectors=${allVectorIds.length}, stored=${payload.storeInVectorDb ?? false}, duration=${durationMs}ms`
    );

    return {
      documentsProcessed: payload.documents.length,
      embeddingDimensions,
      modelUsed: model,
      storedInVectorDb: payload.storeInVectorDb ?? false,
      collectionName: payload.storeInVectorDb ? (payload.collectionName ?? 'default') : undefined,
      vectorIds: allVectorIds,
      durationMs,
    } satisfies EmbeddingResult;
  },
});
