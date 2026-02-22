/**
 * Learning Agent Task Definitions
 *
 * Trigger.dev tasks for Nexus LearningAgent service:
 * - discoverySearch: Multi-source knowledge discovery and aggregation
 * - knowledgeSynthesis: Synthesize knowledge from multiple documents
 * - learningPipeline: Sequential learning pipeline with configurable steps
 * - scheduledDiscovery: Weekly scheduled discovery on configured topics
 */

import { task, schedules } from '@trigger.dev/sdk/v3';
import { LearningAgentClient } from '../integrations/learningagent.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): LearningAgentClient {
  return new LearningAgentClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface DiscoverySearchPayload {
  organizationId: string;
  query: string;
  sources?: string[];
  depth?: 'shallow' | 'medium' | 'deep';
  maxResults?: number;
}

export interface KnowledgeSynthesisPayload {
  organizationId: string;
  topic: string;
  documents: Array<{
    id: string;
    content: string;
  }>;
  synthesisType: 'summary' | 'comparison' | 'gap-analysis' | 'literature-review';
  outputFormat?: string;
}

export interface LearningPipelinePayload {
  organizationId: string;
  objective: string;
  steps: Array<{
    action: string;
    params: Record<string, unknown>;
  }>;
  storeResults?: boolean;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface DiscoverySearchResult {
  discoveries: Array<{
    title: string;
    summary: string;
    source: string;
    relevanceScore: number;
    citations: string[];
  }>;
  totalSources: number;
  searchTimeMs: number;
}

export interface KnowledgeSynthesisResult {
  synthesis: string;
  keyFindings: string[];
  gaps?: string[];
  citations: string[];
  confidenceScore: number;
}

export interface LearningPipelineResult {
  stepsCompleted: number;
  results: Array<{
    step: string;
    output: unknown;
    durationMs: number;
  }>;
  totalDurationMs: number;
}

export interface ScheduledDiscoveryResult {
  topicsSearched: number;
  newDiscoveries: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const discoverySearch = task({
  id: 'learningagent-discovery-search',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 20000,
    factor: 2,
  },
  run: async (payload: DiscoverySearchPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const depth = payload.depth ?? 'medium';
    const maxResults = payload.maxResults ?? 50;

    console.log(
      `[learningagent] Discovery search: query="${payload.query}", depth=${depth}, maxResults=${maxResults}, sources=${payload.sources?.length ?? 'all'}`
    );

    // Execute discovery search using the LearningAgent discover endpoint
    const discoverResponse = await client.discover({
      query: payload.query,
      domain: payload.sources?.join(','),
      maxResults,
      filters: {
        sourceTypes: payload.sources,
      },
    });

    console.log(
      `[learningagent] Initial discovery: found ${discoverResponse.totalFound} results`
    );

    // For deeper searches, run additional passes with refined queries
    const allDiscoveries = [...discoverResponse.discoveries];

    if (depth === 'deep' && discoverResponse.discoveries.length > 0) {
      console.log('[learningagent] Running deep search with follow-up queries');

      // Extract key terms from initial results for refined follow-up searches
      const topResults = discoverResponse.discoveries.slice(0, 3);
      for (const result of topResults) {
        try {
          const refinedQuery = `${payload.query} ${result.title}`;
          const refinedResponse = await client.discover({
            query: refinedQuery,
            maxResults: Math.ceil(maxResults / 3),
            filters: {
              sourceTypes: payload.sources,
            },
          });

          // Add non-duplicate results
          const existingUrls = new Set(allDiscoveries.map((d) => d.url));
          for (const discovery of refinedResponse.discoveries) {
            if (!existingUrls.has(discovery.url)) {
              allDiscoveries.push(discovery);
              existingUrls.add(discovery.url);
            }
          }

          console.log(
            `[learningagent] Refined search for "${result.title}": found ${refinedResponse.discoveries.length} additional results`
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[learningagent] Refined search failed: ${msg}`);
        }
      }
    }

    // Synthesize results to extract citations
    let synthesizedCitations: string[] = [];
    if (allDiscoveries.length > 0) {
      try {
        const synthesis = await client.synthesize({
          sources: allDiscoveries.map((d) => d.summary),
          question: payload.query,
          synthesisType: 'summarize',
          includeReferences: true,
        });
        synthesizedCitations = synthesis.references.map(
          (ref) => `[${ref.sourceIndex}] ${ref.excerpt}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[learningagent] Citation synthesis failed: ${msg}`);
      }
    }

    // Map discoveries to the result format
    const discoveries = allDiscoveries.slice(0, maxResults).map((d) => ({
      title: d.title,
      summary: d.summary,
      source: d.sourceType,
      relevanceScore: d.relevanceScore,
      citations: d.url ? [d.url] : [],
    }));

    // Add synthesized citations to the first result if available
    if (discoveries.length > 0 && synthesizedCitations.length > 0) {
      discoveries[0].citations = [
        ...discoveries[0].citations,
        ...synthesizedCitations,
      ];
    }

    const searchTimeMs = Date.now() - startTime;
    const sourcesQueried = payload.sources?.length ?? discoverResponse.totalFound;

    console.log(
      `[learningagent] Discovery search complete: discoveries=${discoveries.length}, totalSources=${sourcesQueried}, duration=${searchTimeMs}ms`
    );

    return {
      discoveries,
      totalSources: sourcesQueried,
      searchTimeMs,
    } satisfies DiscoverySearchResult;
  },
});

export const knowledgeSynthesis = task({
  id: 'learningagent-knowledge-synthesis',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: KnowledgeSynthesisPayload) => {
    const client = getClient(payload.organizationId);

    console.log(
      `[learningagent] Knowledge synthesis: topic="${payload.topic}", type=${payload.synthesisType}, documents=${payload.documents.length}`
    );

    // Map synthesis type to the client's expected format
    const clientSynthesisType =
      payload.synthesisType === 'comparison' ? 'compare' as const
        : payload.synthesisType === 'gap-analysis' ? 'critique' as const
        : payload.synthesisType === 'literature-review' ? 'merge' as const
        : 'summarize' as const;

    // Execute synthesis across all provided documents
    const synthesisResponse = await client.synthesize({
      sources: payload.documents.map((doc) => doc.content),
      question: `${payload.synthesisType} of: ${payload.topic}`,
      synthesisType: clientSynthesisType,
      includeReferences: true,
    });

    console.log(
      `[learningagent] Synthesis complete: confidence=${synthesisResponse.confidence}, references=${synthesisResponse.references.length}`
    );

    // Extract key findings by identifying major sections in the synthesis
    const keyFindings: string[] = [];
    const synthesisLines = synthesisResponse.synthesis.split('\n').filter((line) => line.trim());
    for (const line of synthesisLines) {
      const trimmed = line.trim();
      // Identify findings by bullet points, numbered items, or headers
      if (
        trimmed.startsWith('-') ||
        trimmed.startsWith('*') ||
        trimmed.match(/^\d+\./) ||
        trimmed.startsWith('#')
      ) {
        keyFindings.push(trimmed.replace(/^[-*#\d.]+\s*/, '').trim());
      }
    }

    // If no structured findings found, split the synthesis into logical segments
    if (keyFindings.length === 0 && synthesisResponse.synthesis.length > 0) {
      const sentences = synthesisResponse.synthesis.split('. ');
      for (let i = 0; i < Math.min(sentences.length, 5); i++) {
        keyFindings.push(sentences[i].trim());
      }
    }

    // Extract gaps for gap-analysis type
    let gaps: string[] | undefined;
    if (payload.synthesisType === 'gap-analysis') {
      gaps = synthesisResponse.references
        .filter((ref) => ref.relevance < 0.5)
        .map((ref) => `Gap identified at source ${ref.sourceIndex}: ${ref.excerpt}`);

      if (gaps.length === 0) {
        gaps = ['No significant knowledge gaps identified in the provided documents'];
      }
    }

    // Build citations from references
    const citations = synthesisResponse.references.map(
      (ref) => `[Source ${ref.sourceIndex}] ${ref.excerpt} (relevance: ${ref.relevance.toFixed(2)})`
    );

    console.log(
      `[learningagent] Synthesis results: keyFindings=${keyFindings.length}, gaps=${gaps?.length ?? 0}, citations=${citations.length}`
    );

    return {
      synthesis: synthesisResponse.synthesis,
      keyFindings,
      gaps,
      citations,
      confidenceScore: synthesisResponse.confidence,
    } satisfies KnowledgeSynthesisResult;
  },
});

export const learningPipeline = task({
  id: 'learningagent-learning-pipeline',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: LearningPipelinePayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);

    console.log(
      `[learningagent] Starting learning pipeline: objective="${payload.objective}", steps=${payload.steps.length}, storeResults=${payload.storeResults ?? false}`
    );

    const results: LearningPipelineResult['results'] = [];
    let stepsCompleted = 0;
    let previousOutput: unknown = null;

    for (let i = 0; i < payload.steps.length; i++) {
      const step = payload.steps[i];
      const stepStart = Date.now();

      console.log(`[learningagent] Executing step ${i + 1}/${payload.steps.length}: action=${step.action}`);

      try {
        let output: unknown;

        // Route each step action to the appropriate client method
        switch (step.action) {
          case 'discover': {
            const discoverResult = await client.discover({
              query: (step.params.query as string) || payload.objective,
              maxResults: (step.params.maxResults as number) || 20,
              filters: step.params.filters as Record<string, unknown> | undefined
                ? { sourceTypes: step.params.sourceTypes as string[] }
                : undefined,
            });
            output = discoverResult;
            break;
          }

          case 'learn': {
            const learnResult = await client.startLearningJob({
              topic: (step.params.topic as string) || payload.objective,
              depth: (step.params.depth as 'shallow' | 'medium' | 'deep' | 'exhaustive') || 'medium',
              sources: step.params.sources as string[],
              maxSources: (step.params.maxSources as number) || 50,
              outputFormat: (step.params.outputFormat as 'report' | 'summary' | 'structured' | 'raw') || 'structured',
            });

            // Poll for learning job completion
            let jobStatus = await client.getJobStatus(learnResult.jobId);
            const pollInterval = 3000;
            const maxPoll = 300000; // 5 min
            const pollStart = Date.now();

            while (
              jobStatus.status !== 'completed' &&
              jobStatus.status !== 'failed' &&
              Date.now() - pollStart < maxPoll
            ) {
              await new Promise((resolve) => setTimeout(resolve, pollInterval));
              jobStatus = await client.getJobStatus(learnResult.jobId);
              console.log(
                `[learningagent] Learning job ${learnResult.jobId}: status=${jobStatus.status}, progress=${jobStatus.progress}%`
              );
            }

            if (jobStatus.status === 'failed') {
              throw new Error(`Learning job failed: ${jobStatus.error}`);
            }

            output = jobStatus.result;
            break;
          }

          case 'synthesize': {
            const sources = (step.params.sources as string[]) ||
              (previousOutput && Array.isArray(previousOutput)
                ? (previousOutput as Array<{ content?: string }>)
                    .map((item) => item.content || JSON.stringify(item))
                : [JSON.stringify(previousOutput)]);

            const synthResult = await client.synthesize({
              sources,
              question: (step.params.question as string) || payload.objective,
              synthesisType: (step.params.synthesisType as 'compare' | 'merge' | 'critique' | 'summarize') || 'summarize',
              includeReferences: true,
            });
            output = synthResult;
            break;
          }

          default: {
            // For unknown actions, attempt to use the discovery endpoint with the action as context
            console.warn(`[learningagent] Unknown action "${step.action}", falling back to discover`);
            const fallbackResult = await client.discover({
              query: `${step.action}: ${JSON.stringify(step.params)}`,
              maxResults: 10,
            });
            output = fallbackResult;
            break;
          }
        }

        const stepDuration = Date.now() - stepStart;
        stepsCompleted++;
        previousOutput = output;

        results.push({
          step: step.action,
          output,
          durationMs: stepDuration,
        });

        console.log(
          `[learningagent] Step ${i + 1} complete: action=${step.action}, duration=${stepDuration}ms`
        );
      } catch (error) {
        const stepDuration = Date.now() - stepStart;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[learningagent] Step ${i + 1} failed: action=${step.action}, error=${msg}`);

        results.push({
          step: step.action,
          output: { error: msg },
          durationMs: stepDuration,
        });

        // Stop pipeline on failure
        break;
      }
    }

    const totalDurationMs = Date.now() - startTime;

    console.log(
      `[learningagent] Learning pipeline complete: stepsCompleted=${stepsCompleted}/${payload.steps.length}, duration=${totalDurationMs}ms`
    );

    return {
      stepsCompleted,
      results,
      totalDurationMs,
    } satisfies LearningPipelineResult;
  },
});

export const scheduledDiscovery = schedules.task({
  id: 'learningagent-scheduled-discovery',
  cron: '0 6 * * 1',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async () => {
    const startTime = Date.now();
    console.log('[learningagent] Starting weekly scheduled discovery');

    const systemOrgId = process.env.SYSTEM_ORGANIZATION_ID || 'system';
    const client = getClient(systemOrgId);

    // Get configured discovery topics from environment or defaults
    const topicsEnv = process.env.DISCOVERY_TOPICS;
    const topics: string[] = topicsEnv
      ? topicsEnv.split(',').map((t) => t.trim())
      : ['emerging technology trends', 'industry updates', 'research breakthroughs'];

    let topicsSearched = 0;
    let newDiscoveries = 0;

    for (const topic of topics) {
      try {
        console.log(`[learningagent] Searching topic: "${topic}"`);

        const discoverResponse = await client.discover({
          query: topic,
          maxResults: 20,
          filters: {
            dateRange: {
              from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              to: new Date().toISOString(),
            },
          },
        });

        topicsSearched++;
        newDiscoveries += discoverResponse.discoveries.length;

        console.log(
          `[learningagent] Topic "${topic}": found ${discoverResponse.discoveries.length} discoveries`
        );

        // Store discoveries as a learning job for future reference
        if (discoverResponse.discoveries.length > 0) {
          try {
            await client.startLearningJob({
              topic: `Weekly discovery: ${topic}`,
              depth: 'shallow',
              sources: discoverResponse.discoveries.map((d) => d.url).filter(Boolean),
              maxSources: 20,
              outputFormat: 'structured',
            });
            console.log(`[learningagent] Stored discoveries for topic "${topic}"`);
          } catch (storeError) {
            const msg = storeError instanceof Error ? storeError.message : String(storeError);
            console.warn(`[learningagent] Failed to store discoveries for "${topic}": ${msg}`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[learningagent] Discovery failed for topic "${topic}": ${msg}`);
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[learningagent] Scheduled discovery complete: topicsSearched=${topicsSearched}, newDiscoveries=${newDiscoveries}, duration=${durationMs}ms`
    );

    return {
      topicsSearched,
      newDiscoveries,
      durationMs,
    } satisfies ScheduledDiscoveryResult;
  },
});
