/**
 * GraphRAG Task Definitions
 *
 * Trigger.dev tasks for Nexus GraphRAG Enhanced service:
 * - storeRunResultsInGraphRAG: Persist task run outputs into the knowledge graph
 * - buildTaskDependencyGraph: Analyze and build dependency relationships between tasks
 * - searchTaskLogs: Semantic search across task execution logs
 * - nightlyMemorySync: Scheduled nightly synchronization of graph memory state
 */

import { task, schedules } from '@trigger.dev/sdk/v3';
import { GraphRAGClient } from '../integrations/graphrag-client';

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface StoreRunResultsPayload {
  runId: string;
  taskId: string;
  projectId: string;
  output: Record<string, unknown>;
  metadata: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    status: 'completed' | 'failed' | 'cancelled';
    tags?: string[];
  };
  organizationId: string;
}

export interface BuildDependencyGraphPayload {
  projectId: string;
  organizationId: string;
  taskIds?: string[];
  depth?: number;
  includeScheduled?: boolean;
}

export interface SearchTaskLogsPayload {
  query: string;
  organizationId: string;
  projectId?: string;
  taskId?: string;
  limit?: number;
  dateRange?: {
    from: string;
    to: string;
  };
  filters?: {
    status?: string[];
    tags?: string[];
  };
}

export interface NightlyMemorySyncPayload {
  organizationId?: string;
  fullResync?: boolean;
  pruneStaleDays?: number;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface StoreRunResultsResult {
  entityId: string;
  graphNodeCount: number;
  edgesCreated: number;
  storedAt: string;
}

export interface DependencyGraphResult {
  nodeCount: number;
  edgeCount: number;
  rootTasks: string[];
  leafTasks: string[];
  cycles: string[][];
  graphId: string;
  builtAt: string;
}

export interface SearchResult {
  results: Array<{
    runId: string;
    taskId: string;
    score: number;
    snippet: string;
    timestamp: string;
  }>;
  totalMatches: number;
  queryTimeMs: number;
}

export interface MemorySyncResult {
  organizationsProcessed: number;
  nodesSync: number;
  edgesSynced: number;
  nodesPruned: number;
  errors: string[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

const graphrag = new GraphRAGClient();

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const storeRunResultsInGraphRAG = task({
  id: 'graphrag-store-run-results',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: StoreRunResultsPayload) => {
    console.log(`[graphrag] Storing run results for runId=${payload.runId}, taskId=${payload.taskId}`);

    const entities = await graphrag.storeEntities({
      organizationId: payload.organizationId,
      projectId: payload.projectId,
      entities: [
        {
          type: 'task-run',
          id: payload.runId,
          attributes: {
            taskId: payload.taskId,
            status: payload.metadata.status,
            startedAt: payload.metadata.startedAt,
            completedAt: payload.metadata.completedAt,
            durationMs: payload.metadata.durationMs,
            tags: payload.metadata.tags || [],
          },
          data: payload.output,
        },
      ],
    });

    console.log(`[graphrag] Created entity ${entities.entityId}, nodes=${entities.graphNodeCount}`);

    const edges = await graphrag.createRelationships({
      organizationId: payload.organizationId,
      sourceId: payload.runId,
      sourceType: 'task-run',
      relationships: [
        {
          targetId: payload.taskId,
          targetType: 'task-definition',
          relation: 'instance-of',
        },
        {
          targetId: payload.projectId,
          targetType: 'project',
          relation: 'belongs-to',
        },
      ],
    });

    console.log(`[graphrag] Created ${edges.edgesCreated} edges for runId=${payload.runId}`);

    return {
      entityId: entities.entityId,
      graphNodeCount: entities.graphNodeCount,
      edgesCreated: edges.edgesCreated,
      storedAt: new Date().toISOString(),
    } satisfies StoreRunResultsResult;
  },
});

export const buildTaskDependencyGraph = task({
  id: 'graphrag-build-dependency-graph',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 15000,
    factor: 2,
  },
  run: async (payload: BuildDependencyGraphPayload) => {
    console.log(`[graphrag] Building dependency graph for project=${payload.projectId}`);

    const tasks = await graphrag.queryEntities({
      organizationId: payload.organizationId,
      projectId: payload.projectId,
      entityType: 'task-definition',
      ids: payload.taskIds,
      includeScheduled: payload.includeScheduled ?? true,
    });

    console.log(`[graphrag] Found ${tasks.entities.length} task definitions to analyze`);

    const graph = await graphrag.buildDependencyGraph({
      organizationId: payload.organizationId,
      projectId: payload.projectId,
      entityIds: tasks.entities.map((e: { id: string }) => e.id),
      depth: payload.depth ?? 5,
    });

    console.log(
      `[graphrag] Dependency graph built: nodes=${graph.nodeCount}, edges=${graph.edgeCount}, cycles=${graph.cycles.length}`
    );

    if (graph.cycles.length > 0) {
      console.warn(
        `[graphrag] WARNING: Detected ${graph.cycles.length} circular dependencies in project=${payload.projectId}`
      );
    }

    return {
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      rootTasks: graph.rootTasks,
      leafTasks: graph.leafTasks,
      cycles: graph.cycles,
      graphId: graph.graphId,
      builtAt: new Date().toISOString(),
    } satisfies DependencyGraphResult;
  },
});

export const searchTaskLogs = task({
  id: 'graphrag-search-task-logs',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 5000,
    factor: 2,
  },
  run: async (payload: SearchTaskLogsPayload) => {
    const limit = payload.limit ?? 50;
    console.log(`[graphrag] Searching task logs: query="${payload.query}", limit=${limit}`);

    const startTime = Date.now();

    const searchResponse = await graphrag.semanticSearch({
      organizationId: payload.organizationId,
      query: payload.query,
      entityTypes: ['task-run', 'task-log'],
      projectId: payload.projectId,
      taskId: payload.taskId,
      limit,
      dateRange: payload.dateRange,
      filters: payload.filters,
    });

    const queryTimeMs = Date.now() - startTime;

    console.log(
      `[graphrag] Search returned ${searchResponse.results.length} of ${searchResponse.totalMatches} total matches in ${queryTimeMs}ms`
    );

    return {
      results: searchResponse.results.map((r: { entityId: string; taskId: string; score: number; snippet: string; timestamp: string }) => ({
        runId: r.entityId,
        taskId: r.taskId,
        score: r.score,
        snippet: r.snippet,
        timestamp: r.timestamp,
      })),
      totalMatches: searchResponse.totalMatches,
      queryTimeMs,
    } satisfies SearchResult;
  },
});

export const nightlyMemorySync = schedules.task({
  id: 'graphrag-nightly-memory-sync',
  cron: '0 2 * * *',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload) => {
    const startTime = Date.now();
    console.log('[graphrag] Starting nightly memory sync');

    const organizations = await graphrag.listOrganizations();
    console.log(`[graphrag] Found ${organizations.length} organizations to sync`);

    let totalNodesSynced = 0;
    let totalEdgesSynced = 0;
    let totalNodesPruned = 0;
    const errors: string[] = [];

    for (const org of organizations) {
      try {
        console.log(`[graphrag] Syncing organization ${org.id}`);

        const syncResult = await graphrag.syncMemory({
          organizationId: org.id,
          fullResync: false,
          pruneStaleDays: 90,
        });

        totalNodesSynced += syncResult.nodesSynced;
        totalEdgesSynced += syncResult.edgesSynced;
        totalNodesPruned += syncResult.nodesPruned;

        console.log(
          `[graphrag] Org ${org.id} synced: nodes=${syncResult.nodesSynced}, edges=${syncResult.edgesSynced}, pruned=${syncResult.nodesPruned}`
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[graphrag] Failed to sync org ${org.id}: ${msg}`);
        errors.push(`org=${org.id}: ${msg}`);
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[graphrag] Nightly sync complete: orgs=${organizations.length}, nodes=${totalNodesSynced}, edges=${totalEdgesSynced}, pruned=${totalNodesPruned}, errors=${errors.length}, duration=${durationMs}ms`
    );

    return {
      organizationsProcessed: organizations.length,
      nodesSync: totalNodesSynced,
      edgesSynced: totalEdgesSynced,
      nodesPruned: totalNodesPruned,
      errors,
      durationMs,
    } satisfies MemorySyncResult;
  },
});
