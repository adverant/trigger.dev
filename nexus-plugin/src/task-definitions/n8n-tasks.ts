/**
 * N8N Task Definitions
 *
 * Trigger.dev tasks for Nexus N8N workflow automation service:
 * - triggerN8NWorkflow: Trigger an N8N workflow with optional wait for completion
 * - n8nWebhookReceiver: Process incoming N8N webhook payloads
 * - scheduledWorkflowSync: Sync N8N workflow states with Nexus DB every 30 minutes
 * - workflowChain: Execute multiple N8N workflows in sequence or parallel
 */

import { task, schedules } from '@trigger.dev/sdk/v3';
import { N8NClient } from '../integrations/n8n.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): N8NClient {
  return new N8NClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface TriggerN8NWorkflowPayload {
  organizationId: string;
  workflowId: string;
  data?: Record<string, unknown>;
  waitForCompletion?: boolean;
  timeoutMs?: number;
}

export interface N8NWebhookReceiverPayload {
  organizationId: string;
  webhookId: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface WorkflowChainPayload {
  organizationId: string;
  workflows: Array<{
    workflowId: string;
    data?: Record<string, unknown>;
    condition?: string;
  }>;
  mode: 'sequential' | 'parallel';
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface TriggerN8NWorkflowResult {
  executionId: string;
  workflowId: string;
  status: string;
  data?: unknown;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
}

export interface N8NWebhookReceiverResult {
  processed: boolean;
  action: string;
  result: unknown;
}

export interface ScheduledWorkflowSyncResult {
  workflowsSynced: number;
  executionsSynced: number;
  errors: number;
  durationMs: number;
}

export interface WorkflowChainResult {
  completed: number;
  failed: number;
  results: Array<{
    workflowId: string;
    executionId: string;
    status: string;
    output?: unknown;
  }>;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const triggerN8NWorkflow = task({
  id: 'n8n-trigger-workflow',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 15000,
    factor: 2,
  },
  run: async (payload: TriggerN8NWorkflowPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const waitForCompletion = payload.waitForCompletion ?? true;
    const timeoutMs = payload.timeoutMs ?? 120000;

    console.log(
      `[n8n] Triggering workflow: id=${payload.workflowId}, wait=${waitForCompletion}, timeout=${timeoutMs}ms`
    );

    // Step 1: Trigger the workflow
    const triggerResult = await client.triggerWorkflow({
      workflowId: payload.workflowId,
      data: payload.data,
    });

    console.log(
      `[n8n] Workflow triggered: executionId=${triggerResult.executionId}, status=${triggerResult.status}`
    );

    if (!waitForCompletion) {
      const durationMs = Date.now() - startTime;
      return {
        executionId: triggerResult.executionId,
        workflowId: payload.workflowId,
        status: triggerResult.status,
        startedAt: triggerResult.startedAt,
        durationMs,
      } satisfies TriggerN8NWorkflowResult;
    }

    // Step 2: Poll for completion
    console.log(`[n8n] Waiting for workflow completion (timeout=${timeoutMs}ms)`);
    const pollIntervalMs = 2000;
    const pollStart = Date.now();

    let execution = await client.getExecution(triggerResult.executionId);

    while (
      (execution.status === 'running' || execution.status === 'waiting') &&
      Date.now() - pollStart < timeoutMs
    ) {
      console.log(
        `[n8n] Execution ${triggerResult.executionId}: status=${execution.status}`
      );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      execution = await client.getExecution(triggerResult.executionId);
    }

    const durationMs = Date.now() - startTime;

    if (execution.status === 'running' || execution.status === 'waiting') {
      console.warn(`[n8n] Workflow execution timed out after ${timeoutMs}ms`);
      return {
        executionId: triggerResult.executionId,
        workflowId: payload.workflowId,
        status: 'timeout',
        startedAt: execution.startedAt,
        durationMs,
      } satisfies TriggerN8NWorkflowResult;
    }

    console.log(
      `[n8n] Workflow execution complete: status=${execution.status}, duration=${durationMs}ms`
    );

    return {
      executionId: triggerResult.executionId,
      workflowId: payload.workflowId,
      status: execution.status,
      data: execution.data,
      startedAt: execution.startedAt,
      finishedAt: execution.finishedAt,
      durationMs,
    } satisfies TriggerN8NWorkflowResult;
  },
});

export const n8nWebhookReceiver = task({
  id: 'n8n-webhook-receiver',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: N8NWebhookReceiverPayload) => {
    const client = getClient(payload.organizationId);

    console.log(
      `[n8n] Processing webhook: webhookId=${payload.webhookId}, method=${payload.method}`
    );

    // Step 1: Determine the action from the webhook payload
    let action = 'unknown';
    let result: unknown = null;

    // Parse the webhook body to determine the appropriate Nexus action
    const body = payload.body as Record<string, unknown> | null;

    if (body && typeof body === 'object') {
      // Check for common N8N webhook event types
      const eventType = (body.event as string) || (body.type as string) || (body.action as string);

      if (eventType) {
        action = eventType;
        console.log(`[n8n] Webhook event type: ${eventType}`);
      }

      // Route based on action
      switch (action) {
        case 'workflow.completed':
        case 'execution.completed': {
          // A workflow completed -- get the execution details
          const executionId = body.executionId as string;
          if (executionId) {
            const execution = await client.getExecution(executionId);
            result = {
              executionId: execution.executionId,
              workflowId: execution.workflowId,
              status: execution.status,
              data: execution.data,
            };
            console.log(`[n8n] Processed completion webhook for execution ${executionId}`);
          }
          break;
        }

        case 'workflow.error':
        case 'execution.error': {
          const executionId = body.executionId as string;
          if (executionId) {
            const execution = await client.getExecution(executionId);
            result = {
              executionId: execution.executionId,
              workflowId: execution.workflowId,
              status: 'error',
              error: execution.error,
            };
            console.error(`[n8n] Processed error webhook for execution ${executionId}: ${execution.error}`);
          }
          break;
        }

        case 'workflow.trigger': {
          // Incoming trigger request -- trigger a workflow
          const workflowId = body.workflowId as string;
          if (workflowId) {
            const triggerResult = await client.triggerWorkflow({
              workflowId,
              data: body.data as Record<string, unknown>,
            });
            result = {
              executionId: triggerResult.executionId,
              status: triggerResult.status,
            };
            action = `trigger:${workflowId}`;
            console.log(`[n8n] Triggered workflow ${workflowId} from webhook`);
          }
          break;
        }

        default: {
          // Generic webhook -- forward data to a default workflow if configured
          const defaultWorkflowId = process.env.N8N_DEFAULT_WEBHOOK_WORKFLOW;
          if (defaultWorkflowId) {
            const triggerResult = await client.triggerWorkflow({
              workflowId: defaultWorkflowId,
              data: body as Record<string, unknown>,
            });
            result = {
              executionId: triggerResult.executionId,
              status: triggerResult.status,
              forwardedTo: defaultWorkflowId,
            };
            action = `forward:${defaultWorkflowId}`;
            console.log(`[n8n] Forwarded webhook to default workflow ${defaultWorkflowId}`);
          } else {
            action = 'noop';
            result = { message: 'No handler configured for this webhook type', body };
            console.warn(`[n8n] No handler for webhook action: ${action}`);
          }
          break;
        }
      }
    } else {
      action = 'noop';
      result = { message: 'Empty or invalid webhook body' };
      console.warn('[n8n] Received webhook with empty or non-object body');
    }

    const processed = action !== 'noop' && action !== 'unknown';

    console.log(`[n8n] Webhook processing complete: action=${action}, processed=${processed}`);

    return {
      processed,
      action,
      result,
    } satisfies N8NWebhookReceiverResult;
  },
});

export const scheduledWorkflowSync = schedules.task({
  id: 'n8n-scheduled-workflow-sync',
  cron: '*/30 * * * *',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async () => {
    const startTime = Date.now();
    console.log('[n8n] Starting scheduled workflow sync');

    const systemOrgId = process.env.SYSTEM_ORGANIZATION_ID || 'system';
    const client = getClient(systemOrgId);

    let workflowsSynced = 0;
    let executionsSynced = 0;
    let errors = 0;

    try {
      // Step 1: Sync workflows -- get current state from N8N
      console.log('[n8n] Fetching workflows from N8N');
      const workflowList = await client.listWorkflows();

      console.log(`[n8n] Found ${workflowList.workflows.length} workflows to sync`);

      for (const workflow of workflowList.workflows) {
        try {
          // Get detailed workflow info
          const workflowDetail = await client.getWorkflow(workflow.id);

          console.log(
            `[n8n] Syncing workflow: id=${workflow.id}, name=${workflow.name}, active=${workflow.active}, nodes=${workflowDetail.nodes.length}`
          );

          workflowsSynced++;
        } catch (error) {
          errors++;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[n8n] Failed to sync workflow ${workflow.id}: ${msg}`);
        }
      }

      // Step 2: Sync recent executions
      console.log('[n8n] Fetching recent executions');
      const executionList = await client.listExecutions({
        limit: 100,
      });

      console.log(`[n8n] Found ${executionList.executions.length} recent executions to sync`);

      for (const execution of executionList.executions) {
        try {
          // Record execution status
          executionsSynced++;

          if (execution.status === 'error' || execution.status === 'failed') {
            console.warn(
              `[n8n] Execution ${execution.executionId} for workflow ${execution.workflowId} failed: ${execution.error || 'Unknown error'}`
            );
          }
        } catch (error) {
          errors++;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[n8n] Failed to sync execution ${execution.executionId}: ${msg}`);
        }
      }
    } catch (error) {
      errors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[n8n] Workflow sync failed: ${msg}`);
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[n8n] Workflow sync complete: workflows=${workflowsSynced}, executions=${executionsSynced}, errors=${errors}, duration=${durationMs}ms`
    );

    return {
      workflowsSynced,
      executionsSynced,
      errors,
      durationMs,
    } satisfies ScheduledWorkflowSyncResult;
  },
});

export const workflowChain = task({
  id: 'n8n-workflow-chain',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: WorkflowChainPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);

    console.log(
      `[n8n] Starting workflow chain: workflows=${payload.workflows.length}, mode=${payload.mode}`
    );

    const results: WorkflowChainResult['results'] = [];
    let completed = 0;
    let failed = 0;

    if (payload.mode === 'parallel') {
      // Execute all workflows in parallel
      console.log(`[n8n] Executing ${payload.workflows.length} workflows in parallel`);

      const promises = payload.workflows.map(async (wf) => {
        try {
          // Evaluate condition if present
          if (wf.condition) {
            // Simple condition evaluation: check if it's a truthy string
            const conditionMet = wf.condition !== 'false' && wf.condition !== '0' && wf.condition !== '';
            if (!conditionMet) {
              console.log(`[n8n] Workflow ${wf.workflowId} skipped: condition not met`);
              return {
                workflowId: wf.workflowId,
                executionId: '',
                status: 'skipped',
                output: undefined,
              };
            }
          }

          const triggerResult = await client.triggerWorkflow({
            workflowId: wf.workflowId,
            data: wf.data,
          });

          // Wait for each workflow to complete
          const pollIntervalMs = 3000;
          const maxPollTime = 300000; // 5 min per workflow
          const pollStart = Date.now();

          let execution = await client.getExecution(triggerResult.executionId);

          while (
            (execution.status === 'running' || execution.status === 'waiting') &&
            Date.now() - pollStart < maxPollTime
          ) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            execution = await client.getExecution(triggerResult.executionId);
          }

          return {
            workflowId: wf.workflowId,
            executionId: triggerResult.executionId,
            status: execution.status,
            output: execution.data,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            workflowId: wf.workflowId,
            executionId: '',
            status: `error: ${msg}`,
            output: undefined,
          };
        }
      });

      const settledResults = await Promise.allSettled(promises);

      for (const settled of settledResults) {
        if (settled.status === 'fulfilled') {
          const result = settled.value;
          results.push(result);

          if (result.status === 'completed' || result.status === 'success') {
            completed++;
          } else if (result.status !== 'skipped') {
            failed++;
          }
        } else {
          failed++;
          results.push({
            workflowId: 'unknown',
            executionId: '',
            status: `error: ${settled.reason}`,
          });
        }
      }
    } else {
      // Execute workflows sequentially
      console.log(`[n8n] Executing ${payload.workflows.length} workflows sequentially`);

      let previousOutput: unknown = undefined;

      for (let i = 0; i < payload.workflows.length; i++) {
        const wf = payload.workflows[i];

        console.log(`[n8n] Executing workflow ${i + 1}/${payload.workflows.length}: ${wf.workflowId}`);

        // Evaluate condition if present
        if (wf.condition) {
          const conditionMet = wf.condition !== 'false' && wf.condition !== '0' && wf.condition !== '';
          if (!conditionMet) {
            console.log(`[n8n] Workflow ${wf.workflowId} skipped: condition not met`);
            results.push({
              workflowId: wf.workflowId,
              executionId: '',
              status: 'skipped',
            });
            continue;
          }
        }

        try {
          // Merge previous output into data if available
          const workflowData = {
            ...(wf.data || {}),
            ...(previousOutput && typeof previousOutput === 'object' ? { previousOutput } : {}),
          };

          const triggerResult = await client.triggerWorkflow({
            workflowId: wf.workflowId,
            data: workflowData,
          });

          // Wait for completion
          const pollIntervalMs = 3000;
          const maxPollTime = 300000;
          const pollStart = Date.now();

          let execution = await client.getExecution(triggerResult.executionId);

          while (
            (execution.status === 'running' || execution.status === 'waiting') &&
            Date.now() - pollStart < maxPollTime
          ) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            execution = await client.getExecution(triggerResult.executionId);
          }

          results.push({
            workflowId: wf.workflowId,
            executionId: triggerResult.executionId,
            status: execution.status,
            output: execution.data,
          });

          if (execution.status === 'completed' || execution.status === 'success') {
            completed++;
            previousOutput = execution.data;
            console.log(`[n8n] Workflow ${wf.workflowId} completed`);
          } else {
            failed++;
            console.error(`[n8n] Workflow ${wf.workflowId} failed: ${execution.error || execution.status}`);
            // Stop sequential chain on failure
            break;
          }
        } catch (error) {
          failed++;
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[n8n] Workflow ${wf.workflowId} error: ${msg}`);
          results.push({
            workflowId: wf.workflowId,
            executionId: '',
            status: `error: ${msg}`,
          });
          // Stop sequential chain on error
          break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;

    console.log(
      `[n8n] Workflow chain complete: mode=${payload.mode}, completed=${completed}, failed=${failed}, duration=${totalDurationMs}ms`
    );

    return {
      completed,
      failed,
      results,
      totalDurationMs,
    } satisfies WorkflowChainResult;
  },
});
