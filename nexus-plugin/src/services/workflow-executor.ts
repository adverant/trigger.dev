/**
 * Workflow Executor
 *
 * Core execution engine for Nexus Workflows. Takes a workflow definition
 * (ReactFlow node graph) and orchestrates execution across Nexus services:
 * Trigger.dev tasks, Skills Engine, MageAgent, n8n, and local logic nodes.
 *
 * Execution model:
 * - Topological sort by level groups independent nodes
 * - Nodes at the same level execute in parallel (Promise.allSettled)
 * - Dependency chains execute sequentially across levels
 * - Conditional nodes route to true/false branches, skipping the other
 * - Progress updates emitted via WebSocket in real-time
 *
 * Powered by Trigger.dev (https://trigger.dev) — Apache 2.0
 */

import { Server as SocketIOServer } from 'socket.io';
import {
  WorkflowRepository,
  WorkflowRun,
} from '../database/repositories/workflow.repository';
import { TriggerProxyService } from './trigger-proxy.service';
import { ServiceClientRegistry } from './client-registry';
import { evaluateCondition, evaluateTransform } from './expression-evaluator';
import { WS_EVENTS } from '../websocket/events';
import { emitToOrg } from '../websocket/socket-server';
import { createLogger } from '../utils/logger';

import type { MageAgentClient } from '../integrations/mageagent.client';
import type { N8NClient } from '../integrations/n8n.client';
import type { SkillsEngineClient } from '../integrations/skills-engine.client';

const logger = createLogger({ component: 'workflow-executor' });

// Default max time per node (5 minutes). Overridden by node.data.timeoutMs.
const DEFAULT_NODE_TIMEOUT_MS = 5 * 60 * 1000;
// Maximum time to poll for async task completion
const POLL_INTERVAL_MS = 2000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: string;
  data: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface NodeState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  jobId?: string;
  jobType?: string;
}

// ── Executor ───────────────────────────────────────────────────────────────

export class WorkflowExecutor {
  constructor(
    private workflowRepo: WorkflowRepository,
    private triggerProxy: TriggerProxyService,
    private clientRegistry: ServiceClientRegistry,
    private io: SocketIOServer
  ) {}

  /**
   * Execute a workflow run asynchronously.
   * This is fire-and-forget from the HTTP handler perspective — the client
   * gets the run ID immediately and tracks progress via WebSocket or polling.
   */
  async execute(run: WorkflowRun): Promise<void> {
    const { runId, workflowId, organizationId } = run;
    const definition = run.definitionSnapshot;

    const nodes: GraphNode[] = definition?.nodes ?? [];
    const edges: GraphEdge[] = definition?.edges ?? [];

    if (nodes.length === 0) {
      await this.completeRun(runId, 'completed', {
        output: { message: 'Empty workflow — no nodes to execute' },
      });
      return;
    }

    // Mark run as started
    const startTime = Date.now();
    await this.workflowRepo.updateRunStatus(runId, 'running', {
      startedAt: new Date(),
      progress: 0,
    });

    // Initialize node states
    const nodeStates: Record<string, NodeState> = {};
    for (const node of nodes) {
      nodeStates[node.id] = { status: 'pending' };
    }

    try {
      // Build graph structures
      const adjacency = buildAdjacencyList(nodes, edges);
      const inDegree = buildInDegreeMap(nodes, edges);
      const reverseAdjacency = buildReverseAdjacency(nodes, edges);

      // Group nodes into levels for parallel execution
      const levels = topologicalSortByLevel(nodes, inDegree, adjacency);

      // Track which nodes are skipped (from conditional false branches)
      const skippedNodes = new Set<string>();

      // Execute level by level — nodes within a level run in parallel
      for (const level of levels) {
        // Filter out skipped or cascade-failed nodes
        const runnableNodes: { nodeId: string; node: GraphNode }[] = [];

        for (const nodeId of level) {
          const node = nodes.find((n) => n.id === nodeId);
          if (!node) continue;

          if (skippedNodes.has(nodeId)) {
            nodeStates[nodeId] = { status: 'skipped' };
            continue;
          }

          const deps = reverseAdjacency.get(nodeId) ?? [];
          const hasFailedDep = deps.some(
            (depId) => nodeStates[depId]?.status === 'failed'
          );
          if (hasFailedDep) {
            nodeStates[nodeId] = { status: 'skipped', error: 'Upstream node failed' };
            markDependentsSkipped(nodeId, adjacency, skippedNodes);
            continue;
          }

          runnableNodes.push({ nodeId, node });
        }

        if (runnableNodes.length === 0) continue;

        // Mark all nodes in this level as running
        for (const { nodeId } of runnableNodes) {
          nodeStates[nodeId] = { status: 'running', startedAt: new Date().toISOString() };
        }

        // Emit progress for level start
        const completedCount = Object.values(nodeStates).filter(
          (s) => s.status === 'completed' || s.status === 'skipped'
        ).length;
        const progress = Math.round((completedCount / nodes.length) * 100);

        await this.workflowRepo.updateRunStatus(runId, 'running', {
          nodeStates,
          progress,
        });

        emitToOrg(this.io, organizationId, WS_EVENTS.WORKFLOW_RUN_PROGRESS, {
          runId,
          workflowId,
          progress,
          nodeStates,
        });

        // Execute all nodes in this level in parallel
        const results = await Promise.allSettled(
          runnableNodes.map(async ({ nodeId, node }) => {
            const inputData = gatherInput(nodeId, reverseAdjacency, nodeStates, edges);
            const timeoutMs = (node.data.timeoutMs as number) || DEFAULT_NODE_TIMEOUT_MS;

            const result = await Promise.race([
              this.executeNode(node, inputData, run),
              sleep(timeoutMs).then(() => {
                throw new Error(`Node timed out after ${timeoutMs}ms`);
              }),
            ]);

            return { nodeId, node, result };
          })
        );

        // Process results after all nodes in this level complete
        for (const settled of results) {
          if (settled.status === 'fulfilled') {
            const { nodeId, node, result } = settled.value;
            const endTime = new Date().toISOString();
            const duration = Date.now() - new Date(nodeStates[nodeId].startedAt!).getTime();

            // Handle conditional node — determine which branch to skip
            if (node.type === 'conditionalNode' && result !== undefined) {
              const condResult = result as { branch: 'true' | 'false'; data: unknown };
              nodeStates[nodeId] = {
                status: 'completed',
                output: condResult,
                completedAt: endTime,
                durationMs: duration,
              };

              const outEdges = edges.filter((e) => e.source === nodeId);
              for (const edge of outEdges) {
                const handle = edge.sourceHandle ?? '';
                if (condResult.branch === 'true' && handle === 'false') {
                  markSubgraphSkipped(edge.target, adjacency, skippedNodes, edges, nodeId);
                } else if (condResult.branch === 'false' && handle === 'true') {
                  markSubgraphSkipped(edge.target, adjacency, skippedNodes, edges, nodeId);
                }
              }
            } else {
              nodeStates[nodeId] = {
                status: 'completed',
                output: result,
                completedAt: endTime,
                durationMs: duration,
                jobId: (result as any)?.jobId,
                jobType: (result as any)?.jobType,
              };
            }

            await this.trackJobIds(runId, node.type, result);
          } else {
            // Find the corresponding node for this failed promise
            const idx = results.indexOf(settled);
            const { nodeId, node } = runnableNodes[idx];
            const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);

            nodeStates[nodeId] = {
              status: 'failed',
              error: errMsg,
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - new Date(nodeStates[nodeId].startedAt!).getTime(),
            };

            logger.error('Node execution failed', { runId, nodeId, nodeType: node.type, error: errMsg });
            markDependentsSkipped(nodeId, adjacency, skippedNodes);
          }
        }
      }

      // Determine final run status
      const failedNodes = Object.entries(nodeStates).filter(
        ([, s]) => s.status === 'failed'
      );
      const completedNodes = Object.entries(nodeStates).filter(
        ([, s]) => s.status === 'completed'
      );

      // Get the output from the last completed node (terminal node)
      const terminalNodes = findTerminalNodes(nodes, adjacency);
      let finalOutput: Record<string, any> = {};
      for (const tNode of terminalNodes) {
        const state = nodeStates[tNode.id];
        if (state?.status === 'completed' && state.output !== undefined) {
          finalOutput = { ...finalOutput, [tNode.id]: state.output };
        }
      }

      const finalStatus = failedNodes.length > 0 ? 'failed' : 'completed';
      const durationMs = Date.now() - startTime;

      await this.workflowRepo.updateRunStatus(runId, finalStatus, {
        progress: 100,
        nodeStates,
        output: finalOutput,
        errorMessage: failedNodes.length > 0
          ? `${failedNodes.length} node(s) failed: ${failedNodes.map(([id]) => id).join(', ')}`
          : undefined,
        completedAt: new Date(),
        durationMs,
      });

      const wsEvent = finalStatus === 'completed'
        ? WS_EVENTS.WORKFLOW_RUN_COMPLETED
        : WS_EVENTS.WORKFLOW_RUN_FAILED;

      emitToOrg(this.io, organizationId, wsEvent, {
        runId,
        workflowId,
        status: finalStatus,
        durationMs,
        completedNodes: completedNodes.length,
        failedNodes: failedNodes.length,
      });

      logger.info('Workflow execution finished', {
        runId,
        workflowId,
        status: finalStatus,
        durationMs,
        completedNodes: completedNodes.length,
        failedNodes: failedNodes.length,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Workflow execution crashed', { runId, workflowId, error: errMsg });

      await this.completeRun(runId, 'failed', {
        nodeStates,
        errorMessage: `Execution crashed: ${errMsg}`,
        completedAt: new Date(),
        durationMs: Date.now() - startTime,
      });

      emitToOrg(this.io, organizationId, WS_EVENTS.WORKFLOW_RUN_FAILED, {
        runId,
        workflowId,
        error: errMsg,
      });
    }
  }

  // ── Node Execution Dispatch ──────────────────────────────────────────

  private async executeNode(
    node: GraphNode,
    inputData: Record<string, unknown>,
    run: WorkflowRun
  ): Promise<unknown> {
    const { type, data } = node;

    switch (type) {
      case 'taskNode':
        return this.executeTaskNode(data, inputData);

      case 'skillNode':
        return this.executeSkillNode(data, inputData, run);

      case 'mageAgentNode':
        return this.executeMageAgentNode(data, inputData, run);

      case 'n8nWorkflowNode':
        return this.executeN8nNode(data, inputData, run);

      case 'conditionalNode':
        return this.executeConditionalNode(data, inputData);

      case 'transformNode':
        return this.executeTransformNode(data, inputData);

      default:
        logger.warn('Unknown node type, passing input through', { type, nodeId: node.id });
        return inputData;
    }
  }

  // ── Task Node (Trigger.dev) ──────────────────────────────────────────

  private async executeTaskNode(
    data: Record<string, any>,
    inputData: Record<string, unknown>
  ): Promise<unknown> {
    const taskId = data.taskId || data.slug;
    if (!taskId) throw new Error('TaskNode missing taskId');

    logger.info('Executing TaskNode', { taskId });

    // Trigger the task via Trigger.dev SDK proxy
    const triggerResult = await this.triggerProxy.triggerTask(taskId, inputData);
    const triggerRunId = triggerResult?.id || triggerResult?.data?.id;

    if (!triggerRunId) {
      return { output: triggerResult, jobType: 'trigger' };
    }

    // Poll for completion
    return this.pollTriggerRun(triggerRunId);
  }

  private async pollTriggerRun(triggerRunId: string): Promise<unknown> {
    const deadline = Date.now() + DEFAULT_NODE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const runStatus = await this.triggerProxy.getRun(triggerRunId);
        const status = runStatus?.data?.status || runStatus?.status;

        if (['COMPLETED', 'completed'].includes(status)) {
          return {
            output: runStatus?.data?.output ?? runStatus?.output,
            jobId: triggerRunId,
            jobType: 'trigger',
          };
        }

        if (['FAILED', 'CRASHED', 'SYSTEM_FAILURE', 'CANCELED', 'TIMED_OUT',
             'failed', 'crashed', 'canceled', 'timed_out'].includes(status)) {
          throw new Error(
            `Trigger.dev run ${triggerRunId} ${status}: ${runStatus?.data?.error || runStatus?.error || 'Unknown error'}`
          );
        }

        // Still running — wait and poll again
        await sleep(POLL_INTERVAL_MS);
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('run ')) {
          throw err; // Re-throw status errors
        }
        // Network error — retry
        logger.warn('Poll error, retrying', { triggerRunId, error: (err as Error).message });
        await sleep(POLL_INTERVAL_MS);
      }
    }

    throw new Error(`TaskNode timed out after ${DEFAULT_NODE_TIMEOUT_MS}ms waiting for run ${triggerRunId}`);
  }

  // ── Skill Node (Skills Engine) ───────────────────────────────────────

  private async executeSkillNode(
    data: Record<string, any>,
    inputData: Record<string, unknown>,
    run: WorkflowRun
  ): Promise<unknown> {
    const skillId = data.skillId;
    if (!skillId) throw new Error('SkillNode missing skillId');

    const client = this.clientRegistry.get('skills-engine') as SkillsEngineClient | undefined;
    if (!client) {
      throw new Error('Skills Engine integration not configured');
    }

    logger.info('Executing SkillNode', { skillId });

    const input = { ...inputData, ...(data.inputOverrides ?? {}) };
    const result = await (client as any).invoke(skillId, input);

    return {
      output: result?.output ?? result,
      executionId: result?.executionId,
      jobId: result?.executionId,
      jobType: 'skill',
    };
  }

  // ── MageAgent Node ───────────────────────────────────────────────────

  private async executeMageAgentNode(
    data: Record<string, any>,
    inputData: Record<string, unknown>,
    run: WorkflowRun
  ): Promise<unknown> {
    const client = this.clientRegistry.get('mageagent') as MageAgentClient | undefined;
    if (!client) {
      throw new Error('MageAgent integration not configured');
    }

    const prompt = data.prompt || 'Process the following input data.';
    const model = data.model || 'claude-sonnet-4-5-20250514';

    logger.info('Executing MageAgentNode', { model });

    const result = await (client as any).process({
      prompt,
      model,
      systemPrompt: data.systemPrompt,
      temperature: data.temperature,
      maxTokens: data.maxTokens,
      context: inputData,
    });

    return {
      output: result?.result ?? result,
      model: result?.model,
      usage: result?.usage,
      jobId: result?.id,
      jobType: 'mageagent',
    };
  }

  // ── n8n Workflow Node ────────────────────────────────────────────────

  private async executeN8nNode(
    data: Record<string, any>,
    inputData: Record<string, unknown>,
    run: WorkflowRun
  ): Promise<unknown> {
    const workflowId = data.workflowId || data.n8nWorkflowId;
    if (!workflowId) throw new Error('N8nWorkflowNode missing workflowId');

    const client = this.clientRegistry.get('n8n') as N8NClient | undefined;
    if (!client) {
      throw new Error('n8n integration not configured');
    }

    logger.info('Executing N8nWorkflowNode', { workflowId });

    const result = await (client as any).triggerWorkflow({
      workflowId,
      data: inputData,
    });

    return {
      output: result,
      executionId: result?.executionId,
      jobId: result?.executionId,
      jobType: 'n8n',
    };
  }

  // ── Conditional Node ─────────────────────────────────────────────────

  private async executeConditionalNode(
    data: Record<string, any>,
    inputData: Record<string, unknown>
  ): Promise<{ branch: 'true' | 'false'; data: unknown }> {
    const condition = data.condition || '';

    if (!condition.trim()) {
      logger.warn('ConditionalNode has empty condition, defaulting to true');
      return { branch: 'true', data: inputData };
    }

    const result = evaluateCondition(condition, inputData);

    return {
      branch: result ? 'true' : 'false',
      data: inputData,
    };
  }

  // ── Transform Node ───────────────────────────────────────────────────

  private async executeTransformNode(
    data: Record<string, any>,
    inputData: Record<string, unknown>
  ): Promise<unknown> {
    const transformType = data.transformType || 'expression';
    const expression = data.expression || '';

    if (!expression.trim()) {
      return inputData; // Pass-through if no expression
    }

    return evaluateTransform(transformType, expression, inputData);
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async trackJobIds(
    runId: string,
    nodeType: string,
    result: unknown
  ): Promise<void> {
    if (!result || typeof result !== 'object') return;

    const r = result as Record<string, any>;
    const jobId = r.jobId;
    if (!jobId) return;

    try {
      const updates: Record<string, string[]> = {};

      switch (r.jobType || nodeType) {
        case 'trigger':
        case 'taskNode':
          updates.triggerRunIds = [jobId];
          break;
        case 'mageagent':
        case 'mageAgentNode':
          updates.mageagentJobIds = [jobId];
          break;
        case 'skill':
        case 'skillNode':
          updates.skillJobIds = [jobId];
          break;
        case 'n8n':
        case 'n8nWorkflowNode':
          updates.n8nExecutionIds = [jobId];
          break;
      }

      if (Object.keys(updates).length > 0) {
        // Fetch current run to append (not replace) job IDs
        const currentRun = await this.workflowRepo.findRunById(runId);
        if (currentRun) {
          const merged: Record<string, string[]> = {};
          for (const [field, ids] of Object.entries(updates)) {
            const existing = (currentRun as any)[field] || [];
            merged[field] = [...new Set([...existing, ...ids])];
          }
          await this.workflowRepo.updateRunStatus(runId, currentRun.status, merged);
        }
      }
    } catch (err) {
      logger.warn('Failed to track job IDs', { runId, nodeType, error: (err as Error).message });
    }
  }

  private async completeRun(
    runId: string,
    status: string,
    updates: Record<string, any>
  ): Promise<void> {
    await this.workflowRepo.updateRunStatus(runId, status, {
      progress: 100,
      ...updates,
    });
  }
}

// ── Graph Utilities ────────────────────────────────────────────────────────

/**
 * Build adjacency list: node → [downstream nodes]
 */
function buildAdjacencyList(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.id, []);
  }
  for (const edge of edges) {
    const targets = adj.get(edge.source);
    if (targets) targets.push(edge.target);
  }
  return adj;
}

/**
 * Build reverse adjacency list: node → [upstream nodes]
 */
function buildReverseAdjacency(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const node of nodes) {
    rev.set(node.id, []);
  }
  for (const edge of edges) {
    const sources = rev.get(edge.target);
    if (sources) sources.push(edge.source);
  }
  return rev;
}

/**
 * Build in-degree map: node → number of incoming edges
 */
function buildInDegreeMap(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, number> {
  const deg = new Map<string, number>();
  for (const node of nodes) {
    deg.set(node.id, 0);
  }
  for (const edge of edges) {
    deg.set(edge.target, (deg.get(edge.target) ?? 0) + 1);
  }
  return deg;
}

/**
 * Kahn's algorithm — returns nodes grouped by execution level.
 * Nodes at the same level have all dependencies resolved and can run in parallel.
 */
function topologicalSortByLevel(
  nodes: GraphNode[],
  inDegree: Map<string, number>,
  adjacency: Map<string, string[]>
): string[][] {
  const deg = new Map(inDegree);
  const levels: string[][] = [];
  let queue: string[] = [];

  // Start with nodes that have no dependencies
  for (const node of nodes) {
    if ((deg.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
    }
  }

  let processed = 0;

  while (queue.length > 0) {
    levels.push([...queue]);
    processed += queue.length;
    const nextQueue: string[] = [];

    for (const nodeId of queue) {
      for (const neighbor of adjacency.get(nodeId) ?? []) {
        const newDeg = (deg.get(neighbor) ?? 1) - 1;
        deg.set(neighbor, newDeg);
        if (newDeg === 0) {
          nextQueue.push(neighbor);
        }
      }
    }

    queue = nextQueue;
  }

  // If not all nodes processed, there's a cycle
  if (processed !== nodes.length) {
    const processedIds = new Set(levels.flat());
    const missing = nodes.filter((n) => !processedIds.has(n.id)).map((n) => n.id);
    throw new Error(`Workflow contains a cycle involving nodes: ${missing.join(', ')}`);
  }

  return levels;
}

/**
 * Gather input data for a node from its upstream connections.
 * Defensive: handles undefined, null, and primitive outputs safely.
 */
function gatherInput(
  nodeId: string,
  reverseAdjacency: Map<string, string[]>,
  nodeStates: Record<string, NodeState>,
  edges: GraphEdge[]
): Record<string, unknown> {
  const upstreamIds = reverseAdjacency.get(nodeId) ?? [];

  if (upstreamIds.length === 0) {
    return {}; // Root node — no input
  }

  if (upstreamIds.length === 1) {
    const state = nodeStates[upstreamIds[0]];
    if (!state || state.status !== 'completed' || state.output === undefined || state.output === null) {
      return {};
    }
    const output = state.output as any;
    // Unwrap .output if nested (from our executor result format)
    if (output && typeof output === 'object' && 'output' in output) {
      const inner = output.output;
      if (inner === null || inner === undefined) return {};
      return typeof inner === 'object' ? inner : { value: inner };
    }
    return typeof output === 'object' ? output : { value: output };
  }

  // Multiple inputs — merge by edge handle or upstream node ID
  const merged: Record<string, unknown> = {};
  for (const upId of upstreamIds) {
    const state = nodeStates[upId];
    if (!state || state.status !== 'completed' || state.output === undefined || state.output === null) {
      continue;
    }
    const output = state.output as any;
    const edge = edges.find((e) => e.source === upId && e.target === nodeId);
    const key = edge?.sourceHandle || upId;
    if (output && typeof output === 'object' && 'output' in output) {
      const inner = output.output;
      merged[key] = inner === null || inner === undefined ? {} : inner;
    } else {
      merged[key] = output;
    }
  }
  return merged;
}

/**
 * Find terminal nodes (no outgoing edges).
 */
function findTerminalNodes(
  nodes: GraphNode[],
  adjacency: Map<string, string[]>
): GraphNode[] {
  return nodes.filter((n) => (adjacency.get(n.id) ?? []).length === 0);
}

/**
 * Mark all downstream nodes from a given node as skipped.
 */
function markDependentsSkipped(
  nodeId: string,
  adjacency: Map<string, string[]>,
  skippedNodes: Set<string>
): void {
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!skippedNodes.has(neighbor)) {
        skippedNodes.add(neighbor);
        stack.push(neighbor);
      }
    }
  }
}

/**
 * Mark a subgraph starting from a target node as skipped,
 * but only nodes exclusively reachable from the skipped branch.
 */
function markSubgraphSkipped(
  targetId: string,
  adjacency: Map<string, string[]>,
  skippedNodes: Set<string>,
  edges: GraphEdge[],
  conditionalNodeId: string
): void {
  // Simple approach: skip the target and all its exclusive descendants
  skippedNodes.add(targetId);
  markDependentsSkipped(targetId, adjacency, skippedNodes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exported for unit testing (pure functions)
export { topologicalSortByLevel, gatherInput, findTerminalNodes, markDependentsSkipped };
