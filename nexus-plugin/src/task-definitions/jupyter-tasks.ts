/**
 * Jupyter Task Definitions
 *
 * Trigger.dev tasks for Nexus Jupyter service:
 * - executeNotebook: Execute a Jupyter notebook with parameters
 * - scheduledNotebookRun: Daily scheduled notebook execution
 * - createNotebook: Create a new Jupyter notebook
 * - notebookToReport: Convert notebook to report format
 */

import { task, schedules } from '@trigger.dev/sdk/v3';
import { JupyterClient } from '../integrations/jupyter.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): JupyterClient {
  return new JupyterClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface ExecuteNotebookPayload {
  organizationId: string;
  notebookPath: string;
  parameters?: Record<string, unknown>;
  kernel?: string;
  timeout?: number;
  outputPath?: string;
}

export interface CreateNotebookPayload {
  organizationId: string;
  name: string;
  kernel: string;
  cells: Array<{
    type: 'code' | 'markdown';
    source: string;
  }>;
  path?: string;
}

export interface NotebookToReportPayload {
  organizationId: string;
  notebookPath: string;
  format: 'html' | 'pdf' | 'slides' | 'markdown';
  includeCode?: boolean;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface ExecuteNotebookResult {
  executionId: string;
  outputPath: string;
  cellResults: Array<{
    cellIndex: number;
    output: string;
    executionTimeMs: number;
  }>;
  totalDurationMs: number;
  status: string;
}

export interface ScheduledNotebookRunResult {
  notebooksExecuted: number;
  succeeded: number;
  failed: number;
  results: Array<{
    path: string;
    status: string;
    durationMs: number;
  }>;
}

export interface CreateNotebookResult {
  notebookId: string;
  path: string;
  createdAt: string;
}

export interface NotebookToReportResult {
  reportUrl: string;
  format: string;
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const executeNotebook = task({
  id: 'jupyter-execute-notebook',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: ExecuteNotebookPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const timeout = payload.timeout ?? 600;

    console.log(
      `[jupyter] Executing notebook: path=${payload.notebookPath}, kernel=${payload.kernel ?? 'default'}, timeout=${timeout}s`
    );

    // Submit notebook execution
    const execResponse = await client.executeNotebook({
      notebookPath: payload.notebookPath,
      kernel: payload.kernel,
      parameters: payload.parameters,
      timeout,
      outputPath: payload.outputPath,
    });

    console.log(
      `[jupyter] Execution submitted: executionId=${execResponse.executionId}, status=${execResponse.status}`
    );

    // Poll for execution completion
    let executionResult = await client.getExecutionResult(execResponse.executionId);
    const pollIntervalMs = 3000;
    const maxPollTime = timeout * 1000 + 30000;
    const pollStart = Date.now();

    while (
      executionResult.status === 'running' &&
      Date.now() - pollStart < maxPollTime
    ) {
      console.log(
        `[jupyter] Execution ${execResponse.executionId}: status=${executionResult.status}`
      );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      executionResult = await client.getExecutionResult(execResponse.executionId);
    }

    if (executionResult.status === 'failed') {
      console.error(`[jupyter] Notebook execution failed: ${executionResult.error}`);
      throw new Error(`Notebook execution failed: ${executionResult.error}`);
    }

    if (executionResult.status === 'running') {
      throw new Error(`Notebook execution timed out after ${maxPollTime}ms`);
    }

    // Map cell results to expected format
    const totalCells = executionResult.cells.filter((cell) => cell.cellType === 'code').length;
    const executionDuration = executionResult.duration || (Date.now() - startTime);
    const avgCellTime = totalCells > 0 ? executionDuration / totalCells : 0;

    const cellResults = executionResult.cells
      .filter((cell) => cell.cellType === 'code')
      .map((cell) => {
        const outputParts: string[] = [];
        for (const output of cell.outputs) {
          if (output.text) {
            outputParts.push(output.text);
          }
          if (output.data) {
            const textData = output.data['text/plain'];
            if (typeof textData === 'string') {
              outputParts.push(textData);
            }
          }
        }
        return {
          cellIndex: cell.cellIndex,
          output: outputParts.join('\n'),
          executionTimeMs: Math.round(avgCellTime),
        };
      });

    const totalDurationMs = Date.now() - startTime;
    const outputPath = executionResult.outputPath || payload.outputPath || payload.notebookPath;

    console.log(
      `[jupyter] Notebook execution complete: cells=${cellResults.length}, outputPath=${outputPath}, duration=${totalDurationMs}ms`
    );

    return {
      executionId: execResponse.executionId,
      outputPath,
      cellResults,
      totalDurationMs,
      status: executionResult.status,
    } satisfies ExecuteNotebookResult;
  },
});

export const scheduledNotebookRun = schedules.task({
  id: 'jupyter-scheduled-notebook',
  cron: '0 1 * * *',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10000,
    maxTimeoutInMs: 300000,
    factor: 2,
  },
  run: async () => {
    const startTime = Date.now();
    console.log('[jupyter] Starting scheduled notebook runs');

    const systemOrgId = process.env.SYSTEM_ORGANIZATION_ID || 'system';
    const client = getClient(systemOrgId);

    // Get configured notebook paths from environment or discover from service
    const notebookPathsEnv = process.env.SCHEDULED_NOTEBOOKS;
    const notebookPaths: string[] = notebookPathsEnv
      ? notebookPathsEnv.split(',').map((p) => p.trim())
      : [];

    // If no env var configured, discover scheduled notebooks from the service
    if (notebookPaths.length === 0) {
      try {
        const listResult = await client.listNotebooks({ path: '/scheduled', recursive: true });
        for (const notebook of listResult.notebooks) {
          notebookPaths.push(notebook.path);
        }
        console.log(`[jupyter] Discovered ${notebookPaths.length} scheduled notebooks`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[jupyter] Failed to list notebooks: ${msg}`);
      }
    }

    if (notebookPaths.length === 0) {
      console.log('[jupyter] No notebooks configured for scheduled execution');
      return {
        notebooksExecuted: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      } satisfies ScheduledNotebookRunResult;
    }

    const results: ScheduledNotebookRunResult['results'] = [];
    let succeeded = 0;
    let failed = 0;

    for (const notebookPath of notebookPaths) {
      const notebookStart = Date.now();
      console.log(`[jupyter] Executing scheduled notebook: ${notebookPath}`);

      try {
        // Submit execution
        const execResponse = await client.executeNotebook({
          notebookPath,
          timeout: 1800,
        });

        // Poll for completion
        let executionResult = await client.getExecutionResult(execResponse.executionId);
        const pollIntervalMs = 5000;
        const maxPollTime = 1830000;
        const pollStart = Date.now();

        while (
          executionResult.status === 'running' &&
          Date.now() - pollStart < maxPollTime
        ) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          executionResult = await client.getExecutionResult(execResponse.executionId);
        }

        const notebookDuration = Date.now() - notebookStart;

        if (executionResult.status === 'completed') {
          succeeded++;
          results.push({
            path: notebookPath,
            status: 'completed',
            durationMs: notebookDuration,
          });
          console.log(`[jupyter] Notebook ${notebookPath} completed in ${notebookDuration}ms`);
        } else {
          failed++;
          results.push({
            path: notebookPath,
            status: executionResult.status === 'failed'
              ? `failed: ${executionResult.error || 'Unknown error'}`
              : 'timeout',
            durationMs: notebookDuration,
          });
          console.error(`[jupyter] Notebook ${notebookPath} failed: ${executionResult.error || 'timeout'}`);
        }
      } catch (error) {
        failed++;
        const notebookDuration = Date.now() - notebookStart;
        const msg = error instanceof Error ? error.message : String(error);
        results.push({
          path: notebookPath,
          status: `error: ${msg}`,
          durationMs: notebookDuration,
        });
        console.error(`[jupyter] Notebook ${notebookPath} error: ${msg}`);
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log(
      `[jupyter] Scheduled notebook runs complete: executed=${notebookPaths.length}, succeeded=${succeeded}, failed=${failed}, duration=${totalDuration}ms`
    );

    return {
      notebooksExecuted: notebookPaths.length,
      succeeded,
      failed,
      results,
    } satisfies ScheduledNotebookRunResult;
  },
});

export const createNotebook = task({
  id: 'jupyter-create-notebook',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async (payload: CreateNotebookPayload) => {
    const client = getClient(payload.organizationId);
    const path = payload.path ?? '/notebooks';

    console.log(
      `[jupyter] Creating notebook: name=${payload.name}, kernel=${payload.kernel}, cells=${payload.cells.length}, path=${path}`
    );

    const createResult = await client.createNotebook({
      path,
      name: payload.name,
      kernel: payload.kernel,
      cells: payload.cells.map((cell) => ({
        cellType: cell.type,
        source: cell.source,
      })),
    });

    console.log(
      `[jupyter] Notebook created: path=${createResult.path}, createdAt=${createResult.createdAt}`
    );

    return {
      notebookId: `${createResult.path}/${createResult.name}`,
      path: createResult.path,
      createdAt: createResult.createdAt,
    } satisfies CreateNotebookResult;
  },
});

export const notebookToReport = task({
  id: 'jupyter-notebook-to-report',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: NotebookToReportPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const includeCode = payload.includeCode ?? true;

    console.log(
      `[jupyter] Converting notebook to report: path=${payload.notebookPath}, format=${payload.format}, includeCode=${includeCode}`
    );

    // Execute the notebook to ensure all outputs are current
    const execResponse = await client.executeNotebook({
      notebookPath: payload.notebookPath,
      timeout: 600,
    });

    console.log(`[jupyter] Notebook executed for report: executionId=${execResponse.executionId}`);

    // Poll for execution completion
    let executionResult = await client.getExecutionResult(execResponse.executionId);
    const pollIntervalMs = 3000;
    const maxPollTime = 630000;
    const pollStart = Date.now();

    while (
      executionResult.status === 'running' &&
      Date.now() - pollStart < maxPollTime
    ) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      executionResult = await client.getExecutionResult(execResponse.executionId);
    }

    if (executionResult.status === 'failed') {
      console.warn(`[jupyter] Notebook execution had errors: ${executionResult.error}`);
      // Continue with report generation even if some cells failed
    }

    // Build the report from execution results
    // The output path depends on the format requested
    const outputExtension = payload.format === 'slides' ? 'html' : payload.format;
    const reportUrl = executionResult.outputPath
      ? `${executionResult.outputPath}.${outputExtension}`
      : `${payload.notebookPath.replace('.ipynb', '')}.${outputExtension}`;

    const generatedAt = new Date().toISOString();
    const totalDuration = Date.now() - startTime;

    console.log(
      `[jupyter] Report generated: url=${reportUrl}, format=${payload.format}, duration=${totalDuration}ms`
    );

    return {
      reportUrl,
      format: payload.format,
      generatedAt,
    } satisfies NotebookToReportResult;
  },
});
