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
import { MageAgentClient } from '../integrations/mageagent-client';

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
// Client singleton
// ---------------------------------------------------------------------------

const mageagent = new MageAgentClient();

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

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

    const startTime = Date.now();
    let fallbackUsed = false;
    let response;

    try {
      response = await mageagent.chat({
        organizationId: payload.organizationId,
        sessionId: payload.sessionId,
        model: payload.agentConfig.primaryModel,
        prompt: payload.prompt,
        systemPrompt: payload.agentConfig.systemPrompt,
        maxTokens: payload.agentConfig.maxTokens ?? 4096,
        temperature: payload.agentConfig.temperature ?? 0.7,
        conversationHistory: payload.context?.conversationHistory,
        attachments: payload.context?.attachments,
        routing: payload.routing,
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
          response = await mageagent.chat({
            organizationId: payload.organizationId,
            sessionId: payload.sessionId,
            model: fallbackModel,
            prompt: payload.prompt,
            systemPrompt: payload.agentConfig.systemPrompt,
            maxTokens: payload.agentConfig.maxTokens ?? 4096,
            temperature: payload.agentConfig.temperature ?? 0.7,
            conversationHistory: payload.context?.conversationHistory,
            attachments: payload.context?.attachments,
            routing: payload.routing,
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

    console.log(
      `[mageagent] Orchestration complete: model=${response.modelUsed}, tokens=${response.tokensUsed.total}, cost=${response.costCents}c, latency=${latencyMs}ms, fallback=${fallbackUsed}`
    );

    return {
      sessionId: payload.sessionId,
      response: response.content,
      modelUsed: response.modelUsed,
      tokensUsed: response.tokensUsed,
      costCents: response.costCents,
      latencyMs,
      fallbackUsed,
    } satisfies OrchestrationResult;
  },
});

export const mageAgentCompetition = task({
  id: 'mageagent-competition',
  run: async (payload: MageAgentCompetitionPayload) => {
    console.log(
      `[mageagent] Starting competition with ${payload.competitors.length} agents, metrics=${payload.evaluationCriteria.metrics.join(',')}`
    );

    const timeoutMs = payload.timeoutMs ?? 60000;
    const competitorResults: CompetitionResult['scores'] = [];
    let totalCost = 0;

    const competitionPromises = payload.competitors.map(async (competitor) => {
      const startTime = Date.now();
      console.log(`[mageagent] Running competitor agent=${competitor.agentId}, model=${competitor.model}`);

      const result = await mageagent.chat({
        organizationId: payload.organizationId,
        sessionId: `competition-${Date.now()}-${competitor.agentId}`,
        model: competitor.model,
        prompt: payload.prompt,
        systemPrompt: competitor.systemPrompt,
        temperature: competitor.temperature ?? 0.7,
        maxTokens: 4096,
        context: payload.context,
      });

      const latencyMs = Date.now() - startTime;
      return {
        agentId: competitor.agentId,
        model: competitor.model,
        response: result.content,
        latencyMs,
        costCents: result.costCents,
      };
    });

    const rawResults = await Promise.allSettled(competitorPromises);

    for (const result of rawResults) {
      if (result.status === 'fulfilled') {
        totalCost += result.value.costCents;
        competitorResults.push({
          agentId: result.value.agentId,
          model: result.value.model,
          overallScore: 0,
          metricScores: {},
          response: result.value.response,
          latencyMs: result.value.latencyMs,
        });
      } else {
        console.error(`[mageagent] Competitor failed: ${result.reason}`);
      }
    }

    if (competitorResults.length === 0) {
      throw new Error('All competitor agents failed');
    }

    console.log(`[mageagent] Evaluating ${competitorResults.length} responses`);

    const evaluation = await mageagent.evaluate({
      organizationId: payload.organizationId,
      prompt: payload.prompt,
      responses: competitorResults.map((r) => ({
        agentId: r.agentId,
        response: r.response,
      })),
      metrics: payload.evaluationCriteria.metrics,
      evaluatorModel: payload.evaluationCriteria.evaluatorModel,
      customRubric: payload.evaluationCriteria.customRubric,
    });

    for (const score of evaluation.scores) {
      const result = competitorResults.find((r) => r.agentId === score.agentId);
      if (result) {
        result.overallScore = score.overallScore;
        result.metricScores = score.metricScores;
      }
    }

    competitorResults.sort((a, b) => b.overallScore - a.overallScore);
    const winner = competitorResults[0];

    console.log(
      `[mageagent] Competition winner: agent=${winner.agentId}, model=${winner.model}, score=${winner.overallScore}`
    );

    return {
      winnerId: winner.agentId,
      winnerModel: winner.model,
      scores: competitorResults,
      evaluation: evaluation.summary,
      totalCostCents: totalCost,
    } satisfies CompetitionResult;
  },
});

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

    const results = await mageagent.processVision({
      organizationId: payload.organizationId,
      imageUrls: payload.imageUrls,
      analysisType: payload.analysisType,
      model: payload.model,
      customPrompt: payload.customPrompt,
      outputFormat: payload.outputFormat ?? 'json',
      maxTokens: payload.maxTokens ?? 4096,
    });

    console.log(
      `[mageagent] Vision processing complete: ${results.results.length} images analyzed, model=${results.modelUsed}, tokens=${results.totalTokens}`
    );

    return {
      results: results.results.map((r: { imageUrl: string; analysis: string; structuredData?: Record<string, unknown>; confidence: number }) => ({
        imageUrl: r.imageUrl,
        analysis: r.analysis,
        structuredData: r.structuredData,
        confidence: r.confidence,
      })),
      modelUsed: results.modelUsed,
      totalTokens: results.totalTokens,
    } satisfies VisionResult;
  },
});

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
    const dimensions = payload.dimensions ?? 1536;

    console.log(
      `[mageagent] Generating embeddings for ${payload.documents.length} documents, model=${model}, batchSize=${batchSize}`
    );

    const startTime = Date.now();
    const allVectorIds: string[] = [];

    for (let i = 0; i < payload.documents.length; i += batchSize) {
      const batch = payload.documents.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(payload.documents.length / batchSize);

      console.log(`[mageagent] Processing embedding batch ${batchNum}/${totalBatches} (${batch.length} docs)`);

      const embedResult = await mageagent.generateEmbeddings({
        organizationId: payload.organizationId,
        documents: batch,
        model,
        dimensions,
      });

      if (payload.storeInVectorDb) {
        const storeResult = await mageagent.storeVectors({
          organizationId: payload.organizationId,
          collectionName: payload.collectionName ?? 'default',
          vectors: embedResult.embeddings.map((emb: { id: string; vector: number[] }, idx: number) => ({
            id: emb.id,
            vector: emb.vector,
            metadata: batch[idx].metadata || {},
            content: batch[idx].content,
          })),
        });
        allVectorIds.push(...storeResult.vectorIds);
      } else {
        allVectorIds.push(...embedResult.embeddings.map((e: { id: string }) => e.id));
      }
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[mageagent] Embedding generation complete: docs=${payload.documents.length}, vectors=${allVectorIds.length}, stored=${payload.storeInVectorDb ?? false}, duration=${durationMs}ms`
    );

    return {
      documentsProcessed: payload.documents.length,
      embeddingDimensions: dimensions,
      modelUsed: model,
      storedInVectorDb: payload.storeInVectorDb ?? false,
      collectionName: payload.storeInVectorDb ? (payload.collectionName ?? 'default') : undefined,
      vectorIds: allVectorIds,
      durationMs,
    } satisfies EmbeddingResult;
  },
});
