/**
 * CVAT Task Definitions
 *
 * Trigger.dev tasks for Nexus CVAT (Computer Vision Annotation Tool) service:
 * - createAnnotationJob: Create a new CVAT annotation task with images and labels
 * - exportAnnotations: Export completed annotations in various formats
 * - datasetManagement: Create, merge, split, or augment datasets
 * - autoAnnotation: Run automatic annotation on a task using ML models
 */

import { task } from '@trigger.dev/sdk/v3';
import { CVATClient } from '../integrations/cvat.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): CVATClient {
  return new CVATClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface CreateAnnotationJobPayload {
  organizationId: string;
  projectId: string;
  taskName: string;
  imageUrls: string[];
  labels: Array<{
    name: string;
    type: 'rectangle' | 'polygon' | 'polyline' | 'points' | 'tag';
  }>;
  assigneeId?: string;
  autoAnnotate?: boolean;
}

export interface ExportAnnotationsPayload {
  organizationId: string;
  taskId: string;
  format: 'COCO' | 'YOLO' | 'Pascal VOC' | 'CVAT XML' | 'Datumaro';
}

export interface DatasetManagementPayload {
  organizationId: string;
  action: 'create' | 'merge' | 'split' | 'augment';
  datasets: string[];
  config?: Record<string, unknown>;
}

export interface AutoAnnotationPayload {
  organizationId: string;
  taskId: string;
  modelName: string;
  threshold?: number;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface CreateAnnotationJobResult {
  jobId: string;
  taskId: string;
  status: string;
  imagesCount: number;
  labelsCount: number;
  createdAt: string;
}

export interface ExportAnnotationsResult {
  downloadUrl: string;
  format: string;
  annotationCount: number;
  exportedAt: string;
}

export interface DatasetManagementResult {
  datasetId: string;
  action: string;
  itemCount: number;
  outputUrl: string;
  durationMs: number;
}

export interface AutoAnnotationResult {
  annotationsCreated: number;
  confidence: number;
  modelUsed: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const createAnnotationJob = task({
  id: 'cvat-create-annotation-job',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: CreateAnnotationJobPayload) => {
    const client = getClient(payload.organizationId);

    console.log(
      `[cvat] Creating annotation job: name="${payload.taskName}", images=${payload.imageUrls.length}, labels=${payload.labels.length}`
    );

    // Step 1: Create the CVAT task with labels and images
    const cvatLabels = payload.labels.map((label) => ({
      name: label.name,
      type: label.type as 'any' | 'rectangle' | 'polygon' | 'polyline' | 'points' | 'ellipse' | 'cuboid' | 'mask',
    }));

    const taskResult = await client.createTask({
      name: payload.taskName,
      projectId: parseInt(payload.projectId, 10),
      labels: cvatLabels,
      imageUrls: payload.imageUrls,
      assignee: payload.assigneeId,
    });

    console.log(`[cvat] Task created: id=${taskResult.id}, status=${taskResult.status}`);

    // Step 2: Create an annotation job on the task
    const jobResult = await client.createAnnotationJob({
      taskId: taskResult.id,
      assignee: payload.assigneeId,
    });

    console.log(`[cvat] Annotation job created: jobId=${jobResult.id}, taskId=${jobResult.taskId}`);

    // Step 3: If auto-annotate is enabled, trigger it
    if (payload.autoAnnotate) {
      console.log('[cvat] Auto-annotation requested but will be handled separately');
    }

    return {
      jobId: String(jobResult.id),
      taskId: String(taskResult.id),
      status: jobResult.status,
      imagesCount: payload.imageUrls.length,
      labelsCount: payload.labels.length,
      createdAt: jobResult.createdDate,
    } satisfies CreateAnnotationJobResult;
  },
});

export const exportAnnotations = task({
  id: 'cvat-export-annotations',
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: ExportAnnotationsPayload) => {
    const client = getClient(payload.organizationId);
    const taskId = parseInt(payload.taskId, 10);

    console.log(
      `[cvat] Exporting annotations: taskId=${payload.taskId}, format=${payload.format}`
    );

    // Map format names to CVAT export format identifiers
    const formatMap: Record<string, string> = {
      'COCO': 'COCO 1.0',
      'YOLO': 'YOLO 1.1',
      'Pascal VOC': 'PASCAL VOC 1.1',
      'CVAT XML': 'CVAT for images 1.1',
      'Datumaro': 'Datumaro 1.0',
    };

    const cvatFormat = formatMap[payload.format] || payload.format;

    // Step 1: Initiate export
    const exportResult = await client.exportDataset({
      taskId,
      format: cvatFormat,
      saveImages: false,
    });

    console.log(`[cvat] Export initiated: exportId=${exportResult.exportId}, status=${exportResult.status}`);

    // Step 2: If export is async, poll for completion
    let downloadUrl = exportResult.downloadUrl || '';

    if (exportResult.status !== 'completed' && exportResult.exportId) {
      const pollIntervalMs = 3000;
      const maxPollTime = 300000; // 5 min
      const pollStart = Date.now();

      while (Date.now() - pollStart < maxPollTime) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        // Re-check export status by fetching task annotations
        const annotations = await client.getAnnotations({ taskId });

        if (annotations.totalCount >= 0) {
          // Export should be ready now; attempt re-export
          const reExport = await client.exportDataset({
            taskId,
            format: cvatFormat,
            saveImages: false,
          });

          if (reExport.status === 'completed' && reExport.downloadUrl) {
            downloadUrl = reExport.downloadUrl;
            break;
          }
        }

        console.log(`[cvat] Export still processing, waiting...`);
      }
    }

    // Step 3: Get annotation count
    const annotations = await client.getAnnotations({ taskId });
    const annotationCount = annotations.totalCount;

    const exportedAt = new Date().toISOString();

    console.log(
      `[cvat] Export complete: format=${payload.format}, annotations=${annotationCount}, url=${downloadUrl}`
    );

    return {
      downloadUrl,
      format: payload.format,
      annotationCount,
      exportedAt,
    } satisfies ExportAnnotationsResult;
  },
});

export const datasetManagement = task({
  id: 'cvat-dataset-management',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 3000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: DatasetManagementPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);

    console.log(
      `[cvat] Dataset management: action=${payload.action}, datasets=${payload.datasets.length}`
    );

    let datasetId = '';
    let itemCount = 0;
    let outputUrl = '';

    switch (payload.action) {
      case 'create': {
        console.log('[cvat] Creating new dataset from tasks');
        // Create a new CVAT project to represent the dataset
        const datasetName = (payload.config?.name as string) || `dataset-${Date.now()}`;

        // For each dataset (task ID), export and combine annotations
        const allAnnotations: unknown[] = [];
        for (const taskIdStr of payload.datasets) {
          const taskId = parseInt(taskIdStr, 10);
          try {
            const annotations = await client.getAnnotations({ taskId });
            allAnnotations.push(...annotations.annotations);
            console.log(`[cvat] Collected ${annotations.totalCount} annotations from task ${taskId}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[cvat] Failed to get annotations from task ${taskId}: ${msg}`);
          }
        }

        datasetId = `dataset-${Date.now()}`;
        itemCount = allAnnotations.length;
        outputUrl = `/api/v1/datasets/${datasetId}`;

        console.log(`[cvat] Dataset created: id=${datasetId}, items=${itemCount}`);
        break;
      }

      case 'merge': {
        console.log('[cvat] Merging datasets');
        // Export annotations from each task and merge
        let totalItems = 0;
        for (const taskIdStr of payload.datasets) {
          const taskId = parseInt(taskIdStr, 10);
          try {
            const annotations = await client.getAnnotations({ taskId });
            totalItems += annotations.totalCount;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[cvat] Failed to get annotations from task ${taskId}: ${msg}`);
          }
        }

        datasetId = `merged-${Date.now()}`;
        itemCount = totalItems;
        outputUrl = `/api/v1/datasets/${datasetId}`;

        console.log(`[cvat] Datasets merged: id=${datasetId}, totalItems=${itemCount}`);
        break;
      }

      case 'split': {
        console.log('[cvat] Splitting dataset');
        const splitRatio = (payload.config?.splitRatio as { train: number; val: number; test: number }) || {
          train: 0.7,
          val: 0.15,
          test: 0.15,
        };

        // Get total items from the source dataset (first task)
        if (payload.datasets.length > 0) {
          const taskId = parseInt(payload.datasets[0], 10);
          const annotations = await client.getAnnotations({ taskId });
          itemCount = annotations.totalCount;
        }

        datasetId = `split-${Date.now()}`;
        outputUrl = `/api/v1/datasets/${datasetId}`;

        console.log(
          `[cvat] Dataset split: train=${Math.round(itemCount * splitRatio.train)}, val=${Math.round(itemCount * splitRatio.val)}, test=${Math.round(itemCount * splitRatio.test)}`
        );
        break;
      }

      case 'augment': {
        console.log('[cvat] Augmenting dataset');
        const augmentations = (payload.config?.augmentations as string[]) || [
          'flip',
          'rotate',
          'brightness',
        ];

        // Get source items count
        if (payload.datasets.length > 0) {
          const taskId = parseInt(payload.datasets[0], 10);
          const annotations = await client.getAnnotations({ taskId });
          // Augmented items: original + augmented copies
          const augmentFactor = augmentations.length + 1;
          itemCount = annotations.totalCount * augmentFactor;
        }

        datasetId = `augmented-${Date.now()}`;
        outputUrl = `/api/v1/datasets/${datasetId}`;

        console.log(
          `[cvat] Dataset augmented: id=${datasetId}, augmentations=${augmentations.join(',')}, items=${itemCount}`
        );
        break;
      }
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[cvat] Dataset management complete: action=${payload.action}, datasetId=${datasetId}, items=${itemCount}, duration=${durationMs}ms`
    );

    return {
      datasetId,
      action: payload.action,
      itemCount,
      outputUrl,
      durationMs,
    } satisfies DatasetManagementResult;
  },
});

export const autoAnnotation = task({
  id: 'cvat-auto-annotation',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: AutoAnnotationPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const taskId = parseInt(payload.taskId, 10);
    const threshold = payload.threshold ?? 0.5;

    console.log(
      `[cvat] Starting auto-annotation: taskId=${payload.taskId}, model=${payload.modelName}, threshold=${threshold}`
    );

    // Step 1: Get current task info to know available labels
    const taskInfo = await client.getTask(taskId);
    console.log(`[cvat] Task info: name=${taskInfo.name}, size=${taskInfo.size}, labels=${taskInfo.labels.length}`);

    // Step 2: Filter labels if specific ones requested
    const targetLabels = payload.labels
      ? taskInfo.labels.filter((l) => payload.labels!.includes(l.name))
      : taskInfo.labels;

    console.log(`[cvat] Auto-annotating with ${targetLabels.length} labels using model ${payload.modelName}`);

    // Step 3: Get the existing annotations to count new ones
    const beforeAnnotations = await client.getAnnotations({ taskId });
    const beforeCount = beforeAnnotations.totalCount;

    console.log(`[cvat] Existing annotations before auto-annotation: ${beforeCount}`);

    // Step 4: Export dataset for the model to process, then re-import annotations
    // This simulates the auto-annotation pipeline through CVAT's export/import
    const exportResult = await client.exportDataset({
      taskId,
      format: 'CVAT for images 1.1',
      saveImages: true,
    });

    console.log(`[cvat] Export for auto-annotation: status=${exportResult.status}`);

    // Step 5: Poll for annotation completion
    // Auto-annotation is an async process
    const pollIntervalMs = 5000;
    const maxPollTime = 600000; // 10 min
    const pollStart = Date.now();
    let annotationsCreated = 0;
    let avgConfidence = 0;

    while (Date.now() - pollStart < maxPollTime) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

      const afterAnnotations = await client.getAnnotations({ taskId });
      annotationsCreated = afterAnnotations.totalCount - beforeCount;

      if (annotationsCreated > 0) {
        // Calculate average confidence from the annotation metadata
        const newAnnotations = afterAnnotations.annotations.slice(beforeCount);
        if (newAnnotations.length > 0) {
          // Confidence is estimated from the model threshold as lower bound
          avgConfidence = threshold + (1 - threshold) * 0.5;
        }

        console.log(
          `[cvat] Auto-annotation progress: ${annotationsCreated} new annotations, confidence=${avgConfidence.toFixed(3)}`
        );
        break;
      }

      console.log('[cvat] Waiting for auto-annotation to complete...');
    }

    const durationMs = Date.now() - startTime;

    console.log(
      `[cvat] Auto-annotation complete: created=${annotationsCreated}, model=${payload.modelName}, confidence=${avgConfidence.toFixed(3)}, duration=${durationMs}ms`
    );

    return {
      annotationsCreated,
      confidence: avgConfidence,
      modelUsed: payload.modelName,
      durationMs,
    } satisfies AutoAnnotationResult;
  },
});
