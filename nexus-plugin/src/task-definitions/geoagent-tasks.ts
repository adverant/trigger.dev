/**
 * GeoAgent Task Definitions
 *
 * Trigger.dev tasks for Nexus GeoAgent service:
 * - earthEngineAnalysis: Run Earth Engine spatial analysis tasks
 * - bigQueryGIS: Execute BigQuery GIS queries
 * - satelliteProcessing: Process satellite imagery with multiple operations
 * - scheduledSatelliteMonitoring: Daily scheduled satellite monitoring for change detection
 */

import { task, schedules } from '@trigger.dev/sdk/v3';
import { GeoAgentClient } from '../integrations/geoagent.client';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getClient(organizationId: string): GeoAgentClient {
  return new GeoAgentClient(organizationId);
}

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

export interface EarthEngineAnalysisPayload {
  organizationId: string;
  region: {
    type: string;
    coordinates: number[][] | number[];
  };
  dataset: string;
  dateRange: {
    start: string;
    end: string;
  };
  analysis: 'ndvi' | 'landcover' | 'change-detection' | 'water-bodies' | 'custom';
  customScript?: string;
  scale?: number;
}

export interface BigQueryGISPayload {
  organizationId: string;
  query: string;
  parameters?: Record<string, unknown>;
  outputFormat?: 'geojson' | 'csv' | 'json';
}

export interface SatelliteProcessingPayload {
  organizationId: string;
  imageUrls: string[];
  operations: Array<'calibrate' | 'composite' | 'classify' | 'panSharpen' | 'cloudMask'>;
  outputFormat?: string;
  resolution?: number;
}

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

export interface EarthEngineAnalysisResult {
  analysisId: string;
  results: Record<string, unknown>;
  coveragePercent: number;
  outputUrl: string;
  processingTimeMs: number;
}

export interface BigQueryGISResult {
  queryId: string;
  rows: number;
  data: unknown[];
  bytesProcessed: number;
  queryTimeMs: number;
}

export interface SatelliteProcessingResult {
  outputUrls: string[];
  metadata: Record<string, unknown>;
  processingTimeMs: number;
}

export interface ScheduledSatelliteMonitoringResult {
  regionsChecked: number;
  changesDetected: number;
  alertsSent: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const earthEngineAnalysis = task({
  id: 'geoagent-earth-engine-analysis',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: EarthEngineAnalysisPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const scale = payload.scale ?? 10;

    console.log(
      `[geoagent] Starting Earth Engine analysis: type=${payload.analysis}, dataset=${payload.dataset}, dateRange=${payload.dateRange.start} to ${payload.dateRange.end}`
    );

    // Map the task analysis types to client analysis types
    const analysisTypeMap: Record<string, 'ndvi' | 'land_cover' | 'change_detection' | 'water_detection' | 'custom'> = {
      'ndvi': 'ndvi',
      'landcover': 'land_cover',
      'change-detection': 'change_detection',
      'water-bodies': 'water_detection',
      'custom': 'custom',
    };

    const clientAnalysisType = analysisTypeMap[payload.analysis] || 'custom';

    // Map region type
    const regionType = payload.region.type === 'polygon' ? 'polygon' as const
      : payload.region.type === 'bbox' ? 'bbox' as const
      : 'point_buffer' as const;

    // Execute Earth Engine analysis
    const eeResult = await client.earthEngineAnalysis({
      analysisType: clientAnalysisType,
      region: {
        type: regionType,
        coordinates: payload.region.coordinates,
      },
      dateRange: payload.dateRange,
      satellite: payload.dataset,
      scale,
      customScript: payload.customScript,
    });

    console.log(
      `[geoagent] Earth Engine job submitted: jobId=${eeResult.jobId}, status=${eeResult.status}`
    );

    // If the job is async, we compute results from what's returned
    const analysisId = eeResult.jobId;
    const results: Record<string, unknown> = {};
    let coveragePercent = 0;
    let outputUrl = '';

    if (eeResult.result) {
      results.statistics = eeResult.result.statistics;
      results.geoJson = eeResult.result.geoJson;
      results.metadata = eeResult.result.metadata;
      outputUrl = eeResult.result.imageUrl || '';

      // Compute coverage from metadata if available
      if (eeResult.result.metadata?.coveragePercent) {
        coveragePercent = eeResult.result.metadata.coveragePercent as number;
      } else if (eeResult.result.statistics) {
        // Estimate coverage from statistics (non-null pixel percentage)
        const stats = eeResult.result.statistics;
        if (stats.validPixels !== undefined && stats.totalPixels !== undefined) {
          coveragePercent = ((stats.validPixels as number) / (stats.totalPixels as number)) * 100;
        } else {
          coveragePercent = 100; // Assume full coverage if not reported
        }
      }
    }

    const processingTimeMs = Date.now() - startTime;

    console.log(
      `[geoagent] Earth Engine analysis complete: analysisId=${analysisId}, coverage=${coveragePercent.toFixed(1)}%, duration=${processingTimeMs}ms`
    );

    return {
      analysisId,
      results,
      coveragePercent,
      outputUrl,
      processingTimeMs,
    } satisfies EarthEngineAnalysisResult;
  },
});

export const bigQueryGIS = task({
  id: 'geoagent-bigquery-gis',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: BigQueryGISPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const outputFormat = payload.outputFormat ?? 'json';

    console.log(
      `[geoagent] Executing BigQuery GIS query: format=${outputFormat}`
    );

    const queryResult = await client.bigQueryGIS({
      query: payload.query,
      parameters: payload.parameters,
      outputFormat,
    });

    const queryTimeMs = Date.now() - startTime;

    console.log(
      `[geoagent] BigQuery GIS query complete: rows=${queryResult.totalRows}, bytes=${queryResult.bytesProcessed}, duration=${queryTimeMs}ms`
    );

    return {
      queryId: queryResult.jobId,
      rows: queryResult.totalRows,
      data: queryResult.rows,
      bytesProcessed: queryResult.bytesProcessed,
      queryTimeMs,
    } satisfies BigQueryGISResult;
  },
});

export const satelliteProcessing = task({
  id: 'geoagent-satellite-processing',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload: SatelliteProcessingPayload) => {
    const startTime = Date.now();
    const client = getClient(payload.organizationId);
    const resolution = payload.resolution ?? 10;

    console.log(
      `[geoagent] Starting satellite processing: images=${payload.imageUrls.length}, operations=${payload.operations.join(',')}, resolution=${resolution}m`
    );

    const outputUrls: string[] = [];
    const metadata: Record<string, unknown> = {
      imagesProcessed: 0,
      operationsApplied: payload.operations,
      resolution,
    };

    // Process each image through the operations pipeline
    for (let i = 0; i < payload.imageUrls.length; i++) {
      const imageUrl = payload.imageUrls[i];
      console.log(`[geoagent] Processing image ${i + 1}/${payload.imageUrls.length}: ${imageUrl}`);

      try {
        // Use Vertex AI inference for satellite image processing operations
        // Each operation is a processing step applied to the imagery
        let currentData: Record<string, unknown> = {
          imageUrl,
          resolution,
          outputFormat: payload.outputFormat ?? 'geotiff',
        };

        for (const operation of payload.operations) {
          console.log(`[geoagent] Applying operation: ${operation}`);

          const opResult = await client.vertexAIInference({
            model: `satellite-${operation}`,
            inputData: {
              ...currentData,
              operation,
            },
            parameters: {
              resolution,
              outputFormat: payload.outputFormat,
            },
          });

          // Chain the operation result into the next step
          currentData = {
            ...currentData,
            previousResult: opResult.predictions,
            operationApplied: operation,
          };

          if (opResult.metadata?.outputUrl) {
            currentData.imageUrl = opResult.metadata.outputUrl as string;
          }
        }

        // Collect the final output URL
        const finalUrl = (currentData.imageUrl as string) || imageUrl;
        outputUrls.push(finalUrl);
        (metadata.imagesProcessed as number)++;

        console.log(`[geoagent] Image ${i + 1} processing complete: outputUrl=${finalUrl}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[geoagent] Failed to process image ${imageUrl}: ${msg}`);
        // Continue processing remaining images
      }
    }

    const processingTimeMs = Date.now() - startTime;

    console.log(
      `[geoagent] Satellite processing complete: outputUrls=${outputUrls.length}, duration=${processingTimeMs}ms`
    );

    return {
      outputUrls,
      metadata,
      processingTimeMs,
    } satisfies SatelliteProcessingResult;
  },
});

export const scheduledSatelliteMonitoring = schedules.task({
  id: 'geoagent-scheduled-monitoring',
  cron: '0 4 * * *',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 10000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async () => {
    const startTime = Date.now();
    console.log('[geoagent] Starting scheduled satellite monitoring');

    const systemOrgId = process.env.SYSTEM_ORGANIZATION_ID || 'system';
    const client = getClient(systemOrgId);

    let regionsChecked = 0;
    let changesDetected = 0;
    let alertsSent = 0;

    // Get configured monitoring regions from environment
    const regionsEnv = process.env.MONITORING_REGIONS;
    const monitoringRegions: Array<{
      name: string;
      type: 'polygon' | 'bbox' | 'point_buffer';
      coordinates: number[][] | number[];
    }> = regionsEnv
      ? JSON.parse(regionsEnv)
      : [];

    if (monitoringRegions.length === 0) {
      console.log('[geoagent] No monitoring regions configured, skipping');
      return {
        regionsChecked: 0,
        changesDetected: 0,
        alertsSent: 0,
        durationMs: Date.now() - startTime,
      } satisfies ScheduledSatelliteMonitoringResult;
    }

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    for (const region of monitoringRegions) {
      try {
        console.log(`[geoagent] Monitoring region: ${region.name}`);
        regionsChecked++;

        // Run change detection analysis comparing last week to today
        const analysisResult = await client.earthEngineAnalysis({
          analysisType: 'change_detection',
          region: {
            type: region.type,
            coordinates: region.coordinates,
          },
          dateRange: {
            start: lastWeek.toISOString().split('T')[0],
            end: today.toISOString().split('T')[0],
          },
          scale: 30,
        });

        console.log(
          `[geoagent] Analysis for ${region.name}: jobId=${analysisResult.jobId}, status=${analysisResult.status}`
        );

        // Check for significant changes in the analysis results
        if (analysisResult.result?.statistics) {
          const stats = analysisResult.result.statistics;
          const changeThreshold = 0.1; // 10% change threshold

          // Check each statistic for significant changes
          for (const [metric, value] of Object.entries(stats)) {
            if (typeof value === 'number' && Math.abs(value) > changeThreshold) {
              changesDetected++;
              console.log(
                `[geoagent] Change detected in ${region.name}: metric=${metric}, value=${value}`
              );

              // Send alert notification via Vertex AI for smart alerting
              try {
                await client.vertexAIInference({
                  model: 'geo-alert-classifier',
                  inputData: {
                    regionName: region.name,
                    metric,
                    value,
                    threshold: changeThreshold,
                    analysisResult: analysisResult.result,
                  },
                  parameters: { action: 'alert' },
                });
                alertsSent++;
                console.log(`[geoagent] Alert sent for ${region.name}: ${metric}=${value}`);
              } catch (alertError) {
                const msg = alertError instanceof Error ? alertError.message : String(alertError);
                console.error(`[geoagent] Failed to send alert for ${region.name}: ${msg}`);
              }
            }
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[geoagent] Monitoring failed for region ${region.name}: ${msg}`);
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(
      `[geoagent] Scheduled monitoring complete: regionsChecked=${regionsChecked}, changesDetected=${changesDetected}, alertsSent=${alertsSent}, duration=${durationMs}ms`
    );

    return {
      regionsChecked,
      changesDetected,
      alertsSent,
      durationMs,
    } satisfies ScheduledSatelliteMonitoringResult;
  },
});
