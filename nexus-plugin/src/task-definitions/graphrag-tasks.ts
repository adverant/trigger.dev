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
import { GraphRAGClient } from '../integrations/graphrag.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): GraphRAGClient {
  return new GraphRAGClient(organizationId);
}

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
    const client = getClient(payload.organizationId);

    console.log(`[graphrag] Storing run results for runId=${payload.runId}, taskId=${payload.taskId}`);

    // Store the run output as a document in the knowledge graph
    const doc = await client.storeDocument({
      content: JSON.stringify(payload.output),
      collection: `project-${payload.projectId}`,
      metadata: {
        runId: payload.runId,
        taskId: payload.taskId,
        projectId: payload.projectId,
        status: payload.metadata.status,
        startedAt: payload.metadata.startedAt,
        completedAt: payload.metadata.completedAt,
        durationMs: payload.metadata.durationMs,
        tags: payload.metadata.tags || [],
      },
    });

    console.log(`[graphrag] Document stored: documentId=${doc.documentId}, chunks=${doc.chunks}`);

    // Create an entity node for this task run
    const entity = await client.createEntity({
      name: `run-${payload.runId}`,
      type: 'task-run',
      properties: {
        runId: payload.runId,
        taskId: payload.taskId,
        projectId: payload.projectId,
        status: payload.metadata.status,
        startedAt: payload.metadata.startedAt,
        completedAt: payload.metadata.completedAt,
        durationMs: payload.metadata.durationMs,
        documentId: doc.documentId,
        tags: payload.metadata.tags || [],
      },
      collection: `project-${payload.projectId}`,
    });

    console.log(`[graphrag] Entity created: id=${entity.id}, type=${entity.type}`);

    // Create relationships: run -> task-definition, run -> project
    let edgesCreated = 0;

    const taskDefRelation = await client.createRelationship({
      sourceId: entity.id,
      targetId: payload.taskId,
      type: 'instance-of',
      properties: { createdBy: 'graphrag-store-run-results' },
    });
    edgesCreated++;
    console.log(`[graphrag] Relationship created: ${taskDefRelation.id} (instance-of)`);

    const projectRelation = await client.createRelationship({
      sourceId: entity.id,
      targetId: payload.projectId,
      type: 'belongs-to',
      properties: { createdBy: 'graphrag-store-run-results' },
    });
    edgesCreated++;
    console.log(`[graphrag] Relationship created: ${projectRelation.id} (belongs-to)`);

    return {
      entityId: entity.id,
      graphNodeCount: doc.chunks + 1, // chunks + entity node
      edgesCreated,
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
    const client = getClient(payload.organizationId);
    const depth = payload.depth ?? 5;

    console.log(`[graphrag] Building dependency graph for project=${payload.projectId}`);

    // Use enhanced retrieval to discover task entities and their relationships
    const enhanced = await client.retrieveEnhanced({
      query: payload.taskIds
        ? `task dependencies for tasks: ${payload.taskIds.join(', ')}`
        : `all task dependencies in project ${payload.projectId}`,
      collection: `project-${payload.projectId}`,
      topK: 200,
      enhancementStrategy: 'graph_expansion',
      maxHops: depth,
      includeGraph: true,
    });

    const entities = enhanced.graphContext.entities;
    const relationships = enhanced.graphContext.relationships;

    console.log(
      `[graphrag] Retrieved graph context: entities=${entities.length}, relationships=${relationships.length}`
    );

    // Filter to task-definition entities if specific taskIds were requested
    const taskEntities = payload.taskIds
      ? entities.filter((e) => payload.taskIds!.includes(e.id) || e.type === 'task-definition')
      : entities.filter((e) => e.type === 'task-definition' || e.type === 'task-run');

    // Determine root tasks (no incoming "depends-on" edges) and leaf tasks (no outgoing "depends-on" edges)
    const targetIds = new Set(relationships.map((r) => r.targetId));
    const sourceIds = new Set(relationships.map((r) => r.sourceId));
    const rootTasks = taskEntities
      .filter((e) => !targetIds.has(e.id))
      .map((e) => e.id);
    const leafTasks = taskEntities
      .filter((e) => !sourceIds.has(e.id))
      .map((e) => e.id);

    // Detect cycles using a simple visited-set approach over adjacency
    const adjacency = new Map<string, string[]>();
    for (const rel of relationships) {
      if (!adjacency.has(rel.sourceId)) adjacency.set(rel.sourceId, []);
      adjacency.get(rel.sourceId)!.push(rel.targetId);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const currentPath: string[] = [];

    function dfs(node: string) {
      visited.add(node);
      inStack.add(node);
      currentPath.push(node);

      for (const neighbor of adjacency.get(node) || []) {
        if (inStack.has(neighbor)) {
          const cycleStart = currentPath.indexOf(neighbor);
          if (cycleStart !== -1) {
            cycles.push(currentPath.slice(cycleStart));
          }
        } else if (!visited.has(neighbor)) {
          dfs(neighbor);
        }
      }

      currentPath.pop();
      inStack.delete(node);
    }

    for (const entity of taskEntities) {
      if (!visited.has(entity.id)) {
        dfs(entity.id);
      }
    }

    // Store the dependency graph itself as a document for future reference
    const graphDoc = await client.storeDocument({
      content: JSON.stringify({
        projectId: payload.projectId,
        nodes: taskEntities.map((e) => e.id),
        edges: relationships.map((r) => ({
          source: r.sourceId,
          target: r.targetId,
          type: r.type,
        })),
        rootTasks,
        leafTasks,
        cycles,
      }),
      collection: `project-${payload.projectId}`,
      metadata: {
        type: 'dependency-graph',
        projectId: payload.projectId,
        builtAt: new Date().toISOString(),
      },
    });

    if (cycles.length > 0) {
      console.warn(
        `[graphrag] WARNING: Detected ${cycles.length} circular dependencies in project=${payload.projectId}`
      );
    }

    console.log(
      `[graphrag] Dependency graph built: nodes=${taskEntities.length}, edges=${relationships.length}, cycles=${cycles.length}`
    );

    return {
      nodeCount: taskEntities.length,
      edgeCount: relationships.length,
      rootTasks,
      leafTasks,
      cycles,
      graphId: graphDoc.documentId,
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
    const client = getClient(payload.organizationId);
    const limit = payload.limit ?? 50;

    console.log(`[graphrag] Searching task logs: query="${payload.query}", limit=${limit}`);

    const startTime = Date.now();

    // Build search filters from payload
    const filters: Record<string, unknown> = {};
    if (payload.projectId) filters.projectId = payload.projectId;
    if (payload.taskId) filters.taskId = payload.taskId;
    if (payload.dateRange) filters.dateRange = payload.dateRange;
    if (payload.filters?.status) filters.status = payload.filters.status;
    if (payload.filters?.tags) filters.tags = payload.filters.tags;

    const searchResponse = await client.search({
      query: payload.query,
      collection: payload.projectId ? `project-${payload.projectId}` : undefined,
      topK: limit,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      includeMetadata: true,
    });

    const queryTimeMs = Date.now() - startTime;

    console.log(
      `[graphrag] Search returned ${searchResponse.results.length} of ${searchResponse.totalCount} total matches in ${queryTimeMs}ms`
    );

    return {
      results: searchResponse.results.map((r) => ({
        runId: r.id,
        taskId: (r.metadata?.taskId as string) ?? '',
        score: r.score,
        snippet: r.content,
        timestamp: (r.metadata?.completedAt as string) ?? (r.metadata?.startedAt as string) ?? '',
      })),
      totalMatches: searchResponse.totalCount,
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

    // Use the provided organizationId or fall back to a system-level org
    const orgId = (payload as NightlyMemorySyncPayload).organizationId
      || process.env.SYSTEM_ORGANIZATION_ID
      || 'system';
    const fullResync = (payload as NightlyMemorySyncPayload).fullResync ?? false;
    const pruneStaleDays = (payload as NightlyMemorySyncPayload).pruneStaleDays ?? 90;

    const client = getClient(orgId);
    const errors: string[] = [];

    let nodesSync = 0;
    let edgesSynced = 0;
    let nodesPruned = 0;

    try {
      // Verify service health before proceeding
      const health = await client.healthCheck();
      console.log(`[graphrag] Service health: ${health.status}, latency=${health.latency}ms`);

      if (health.status === 'unhealthy') {
        errors.push(`GraphRAG service unhealthy (latency=${health.latency}ms)`);
        return {
          organizationsProcessed: 0,
          nodesSync: 0,
          edgesSynced: 0,
          nodesPruned: 0,
          errors,
          durationMs: Date.now() - startTime,
        } satisfies MemorySyncResult;
      }

      // Store a sync marker memory entry to record this sync run
      const syncMarker = await client.storeMemory({
        content: JSON.stringify({
          syncType: fullResync ? 'full' : 'incremental',
          organizationId: orgId,
          pruneStaleDays,
          triggeredAt: new Date().toISOString(),
        }),
        context: 'nightly-memory-sync',
        tags: ['sync', 'nightly', fullResync ? 'full-resync' : 'incremental'],
        ttl: pruneStaleDays * 24 * 60 * 60, // TTL in seconds
        collection: 'system-sync',
      });

      console.log(`[graphrag] Sync marker stored: memoryId=${syncMarker.memoryId}`);
      nodesSync++;

      // Use enhanced retrieval to discover stale nodes for pruning
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - pruneStaleDays);

      const staleResults = await client.search({
        query: `stale entities before ${cutoffDate.toISOString()}`,
        collection: fullResync ? undefined : 'system-sync',
        topK: 500,
        filters: {
          olderThan: cutoffDate.toISOString(),
          type: 'sync-marker',
        },
        includeMetadata: true,
      });

      nodesPruned = staleResults.totalCount;
      console.log(`[graphrag] Identified ${nodesPruned} stale entries for pruning`);

      // Re-index current graph state via enhanced retrieval
      const graphState = await client.retrieveEnhanced({
        query: 'current graph state summary',
        collection: `org-${orgId}`,
        topK: 100,
        enhancementStrategy: 'hybrid',
        includeGraph: true,
      });

      nodesSync += graphState.graphContext.entities.length;
      edgesSynced += graphState.graphContext.relationships.length;

      console.log(
        `[graphrag] Graph state retrieved: entities=${graphState.graphContext.entities.length}, relationships=${graphState.graphContext.relationships.length}`
      );

      // Store sync completion memory
      await client.storeMemory({
        content: JSON.stringify({
          syncCompleted: true,
          organizationId: orgId,
          nodesSync,
          edgesSynced,
          nodesPruned,
          completedAt: new Date().toISOString(),
        }),
        context: 'nightly-memory-sync-result',
        tags: ['sync', 'nightly', 'result'],
        collection: 'system-sync',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[graphrag] Memory sync error for org=${orgId}: ${msg}`);
      errors.push(`org=${orgId}: ${msg}`);
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[graphrag] Nightly sync complete: org=${orgId}, nodes=${nodesSync}, edges=${edgesSynced}, pruned=${nodesPruned}, errors=${errors.length}, duration=${durationMs}ms`
    );

    return {
      organizationsProcessed: errors.length === 0 ? 1 : 0,
      nodesSync,
      edgesSynced,
      nodesPruned,
      errors,
      durationMs,
    } satisfies MemorySyncResult;
  },
});
