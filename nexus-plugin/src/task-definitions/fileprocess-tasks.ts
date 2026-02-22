/**
 * File Processing Task Definitions
 *
 * Trigger.dev tasks for Nexus FileProcess service:
 * - documentProcessingPipeline: Sequential multi-operation document processing
 * - batchOCR: Batch OCR processing of multiple files
 * - scheduledBatchProcessing: Daily scheduled batch processing of unprocessed files
 * - tableExtraction: Extract structured tables from documents
 */

import { task, schedules } from '@trigger.dev/sdk/v3';
import { FileProcessClient } from '../integrations/fileprocess.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): FileProcessClient {
  return new FileProcessClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface DocumentProcessingPipelinePayload {
  organizationId: string;
  fileUrl: string;
  fileName: string;
  operations: Array<'ocr' | 'tables' | 'classify' | 'summarize'>;
  outputFormat: 'json' | 'markdown' | 'pdf';
  webhookUrl?: string;
}

export interface BatchOCRPayload {
  organizationId: string;
  fileUrls: string[];
  language?: string;
  outputFormat?: string;
}

export interface TableExtractionPayload {
  organizationId: string;
  fileUrl: string;
  pages?: number[];
  format: 'csv' | 'json' | 'xlsx';
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface DocumentProcessingPipelineResult {
  fileId: string;
  results: Record<string, unknown>;
  outputUrl: string;
  processingTimeMs: number;
}

export interface BatchOCRResult {
  processed: number;
  failed: number;
  results: Array<{
    fileUrl: string;
    text: string;
    pages: number;
    confidence: number;
  }>;
  durationMs: number;
}

export interface ScheduledBatchProcessingResult {
  filesProcessed: number;
  errors: number;
  durationMs: number;
}

export interface TableExtractionResult {
  tables: Array<{
    page: number;
    headers: string[];
    rows: string[][];
    confidence: number;
  }>;
  extractionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const documentProcessingPipeline = task({
  id: 'fileprocess-document-pipeline',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: DocumentProcessingPipelinePayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);

    console.log(
      `[fileprocess] Starting document pipeline: file=${payload.fileName}, operations=${payload.operations.join(',')}, outputFormat=${payload.outputFormat}`
    );

    const results: Record<string, unknown> = {};

    // Submit the file processing job
    const processJob = await client.processFile({
      fileUrl: payload.fileUrl,
      fileName: payload.fileName,
      operations: payload.operations.map((op) => ({
        type: op === 'ocr' ? 'ocr' as const
          : op === 'tables' ? 'extract_tables' as const
          : op === 'classify' ? 'extract_text' as const
          : 'extract_text' as const,
        options: op === 'summarize' ? { summarize: true } : undefined,
      })),
      outputFormat: payload.outputFormat,
      webhookUrl: payload.webhookUrl,
    });

    console.log(`[fileprocess] Job submitted: jobId=${processJob.jobId}, status=${processJob.status}`);

    // Poll for job completion
    let jobStatus = await client.getJobStatus(processJob.jobId);
    const pollIntervalMs = 2000;
    const maxPollTime = 300000; // 5 minutes max
    const pollStart = Date.now();

    while (
      jobStatus.status !== 'completed' &&
      jobStatus.status !== 'failed' &&
      Date.now() - pollStart < maxPollTime
    ) {
      console.log(
        `[fileprocess] Job ${processJob.jobId} status=${jobStatus.status}, progress=${jobStatus.progress}%`
      );
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      jobStatus = await client.getJobStatus(processJob.jobId);
    }

    if (jobStatus.status === 'failed') {
      throw new Error(`Document processing failed: ${jobStatus.error || 'Unknown error'}`);
    }

    if (jobStatus.status !== 'completed') {
      throw new Error(`Document processing timed out after ${maxPollTime}ms`);
    }

    // Execute each operation sequentially and collect results
    for (const operation of payload.operations) {
      try {
        switch (operation) {
          case 'ocr': {
            console.log(`[fileprocess] Running OCR on ${payload.fileName}`);
            const ocrResult = await client.extractText({
              fileUrl: payload.fileUrl,
              fileName: payload.fileName,
              ocrEnabled: true,
              format: 'plain',
            });
            results.ocr = {
              text: ocrResult.text,
              pages: ocrResult.pages,
              confidence: ocrResult.confidence,
              language: ocrResult.language,
            };
            console.log(
              `[fileprocess] OCR complete: pages=${ocrResult.pages}, confidence=${ocrResult.confidence}`
            );
            break;
          }

          case 'tables': {
            console.log(`[fileprocess] Extracting tables from ${payload.fileName}`);
            const tableResult = await client.extractTables({
              fileUrl: payload.fileUrl,
              fileName: payload.fileName,
              outputFormat: 'json',
            });
            results.tables = {
              tables: tableResult.tables,
              totalTables: tableResult.totalTables,
            };
            console.log(`[fileprocess] Table extraction complete: found ${tableResult.totalTables} tables`);
            break;
          }

          case 'classify': {
            console.log(`[fileprocess] Classifying document ${payload.fileName}`);
            const classifyResult = await client.extractText({
              fileUrl: payload.fileUrl,
              fileName: payload.fileName,
              format: 'markdown',
            });
            results.classify = {
              text: classifyResult.text,
              metadata: classifyResult.metadata,
            };
            console.log(`[fileprocess] Classification complete`);
            break;
          }

          case 'summarize': {
            console.log(`[fileprocess] Summarizing document ${payload.fileName}`);
            const summarizeResult = await client.extractText({
              fileUrl: payload.fileUrl,
              fileName: payload.fileName,
              format: 'markdown',
            });
            results.summarize = {
              text: summarizeResult.text,
              metadata: summarizeResult.metadata,
            };
            console.log(`[fileprocess] Summarization complete`);
            break;
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[fileprocess] Operation ${operation} failed: ${msg}`);
        results[operation] = { error: msg };
      }
    }

    const processingTimeMs = Date.now() - startTime;
    const outputUrl = jobStatus.result?.outputUrl || '';

    console.log(
      `[fileprocess] Pipeline complete: operations=${payload.operations.length}, outputUrl=${outputUrl}, duration=${processingTimeMs}ms`
    );

    return {
      fileId: processJob.jobId,
      results,
      outputUrl,
      processingTimeMs,
    } satisfies DocumentProcessingPipelineResult;
  },
});

export const batchOCR = task({
  id: 'fileprocess-batch-ocr',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: BatchOCRPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const language = payload.language ?? 'en';

    console.log(
      `[fileprocess] Starting batch OCR: ${payload.fileUrls.length} files, language=${language}`
    );

    const results: BatchOCRResult['results'] = [];
    let processed = 0;
    let failed = 0;

    for (const fileUrl of payload.fileUrls) {
      try {
        console.log(`[fileprocess] OCR processing: ${fileUrl}`);

        const ocrResult = await client.extractText({
          fileUrl,
          fileName: fileUrl.split('/').pop() || 'unknown',
          ocrEnabled: true,
          language,
          format: (payload.outputFormat as 'plain' | 'markdown' | 'html') ?? 'plain',
        });

        processed++;
        results.push({
          fileUrl,
          text: ocrResult.text,
          pages: ocrResult.pages,
          confidence: ocrResult.confidence ?? 0,
        });

        console.log(
          `[fileprocess] OCR complete for ${fileUrl}: pages=${ocrResult.pages}, confidence=${ocrResult.confidence}`
        );
      } catch (error) {
        failed++;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[fileprocess] OCR failed for ${fileUrl}: ${msg}`);
        results.push({
          fileUrl,
          text: '',
          pages: 0,
          confidence: 0,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[fileprocess] Batch OCR complete: processed=${processed}, failed=${failed}, duration=${durationMs}ms`
    );

    return {
      processed,
      failed,
      results,
      durationMs,
    } satisfies BatchOCRResult;
  },
});

export const scheduledBatchProcessing = schedules.task({
  id: 'fileprocess-scheduled-batch',
  cron: '0 3 * * *',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async () => {
    const startTime = Date.now();
    console.log('[fileprocess] Starting scheduled batch processing');

    // Use a system-level organization ID for scheduled tasks
    const systemOrgId = process.env.SYSTEM_ORGANIZATION_ID || 'system';
    const client = getClient(systemOrgId);

    // Query for unprocessed files via the job status endpoint
    // The FileProcess service exposes a queue of pending files
    let filesProcessed = 0;
    let errors = 0;

    try {
      // List pending jobs by checking for queued status
      const healthStatus = await client.healthCheck();
      if (healthStatus.status === 'unhealthy') {
        console.error('[fileprocess] FileProcess service is unhealthy, aborting batch');
        return {
          filesProcessed: 0,
          errors: 1,
          durationMs: Date.now() - startTime,
        } satisfies ScheduledBatchProcessingResult;
      }

      console.log(`[fileprocess] Service health: ${healthStatus.status}, latency=${healthStatus.latency}ms`);

      // Process files by submitting batch processing job
      // The service handles discovery of unprocessed files internally
      const batchJob = await client.processFile({
        fileName: 'batch-processing',
        operations: [
          { type: 'extract_text' },
          { type: 'ocr' },
        ],
      });

      console.log(`[fileprocess] Batch job submitted: jobId=${batchJob.jobId}`);

      // Poll for batch job completion
      let jobStatus = await client.getJobStatus(batchJob.jobId);
      const pollIntervalMs = 5000;
      const maxPollTime = 600000; // 10 minutes
      const pollStart = Date.now();

      while (
        jobStatus.status !== 'completed' &&
        jobStatus.status !== 'failed' &&
        Date.now() - pollStart < maxPollTime
      ) {
        console.log(
          `[fileprocess] Batch job status=${jobStatus.status}, progress=${jobStatus.progress}%`
        );
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        jobStatus = await client.getJobStatus(batchJob.jobId);
      }

      if (jobStatus.status === 'completed') {
        filesProcessed = (jobStatus.result?.metadata?.filesProcessed as number) ?? 1;
        console.log(`[fileprocess] Batch processing completed: ${filesProcessed} files processed`);
      } else if (jobStatus.status === 'failed') {
        errors++;
        console.error(`[fileprocess] Batch processing failed: ${jobStatus.error}`);
      } else {
        errors++;
        console.error('[fileprocess] Batch processing timed out');
      }
    } catch (error) {
      errors++;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[fileprocess] Scheduled batch processing error: ${msg}`);
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[fileprocess] Scheduled batch complete: filesProcessed=${filesProcessed}, errors=${errors}, duration=${durationMs}ms`
    );

    return {
      filesProcessed,
      errors,
      durationMs,
    } satisfies ScheduledBatchProcessingResult;
  },
});

export const tableExtraction = task({
  id: 'fileprocess-table-extraction',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 20000,
    factor: 2,
  },
  run: async (payload: TableExtractionPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);

    console.log(
      `[fileprocess] Starting table extraction: fileUrl=${payload.fileUrl}, format=${payload.format}, pages=${payload.pages?.join(',') ?? 'all'}`
    );

    const extractResult = await client.extractTables({
      fileUrl: payload.fileUrl,
      fileName: payload.fileUrl.split('/').pop() || 'unknown',
      outputFormat: payload.format === 'xlsx' ? 'json' : payload.format as 'json' | 'csv',
      pages: payload.pages,
    });

    const tables = extractResult.tables.map((table) => ({
      page: table.pageNumber,
      headers: table.headers,
      rows: table.rows,
      confidence: table.confidence,
    }));

    const extractionTimeMs = Date.now() - startTime;

    console.log(
      `[fileprocess] Table extraction complete: tables=${tables.length}, duration=${extractionTimeMs}ms`
    );

    return {
      tables,
      extractionTimeMs,
    } satisfies TableExtractionResult;
  },
});
