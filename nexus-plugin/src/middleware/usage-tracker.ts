/**
 * Usage Tracking Middleware
 *
 * Records API usage metrics to the trigger.usage_metrics table.
 * Captures: orgId, metric_type, endpoint, method, status code, duration.
 * Async fire-and-forget: never blocks the request pipeline.
 */

import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { createLogger } from '../utils/logger';
import { usageMetricsRecorded } from '../utils/metrics';

const logger = createLogger({ component: 'usage-tracker' });

const INSERT_USAGE_METRIC = `
  INSERT INTO trigger.usage_metrics (
    organization_id,
    metric_type,
    metadata
  ) VALUES ($1, $2, $3)
`;

/**
 * Record a single usage metric to the database (fire-and-forget)
 */
async function recordUsageMetric(
  pool: Pool,
  data: {
    organizationId: string;
    metricType: string;
    endpoint: string;
    method: string;
    statusCode: number;
    durationMs: number;
    userId?: string;
  }
): Promise<void> {
  try {
    await pool.query(INSERT_USAGE_METRIC, [
      data.organizationId,
      data.metricType,
      JSON.stringify({
        endpoint: data.endpoint,
        method: data.method,
        status_code: data.statusCode,
        duration_ms: data.durationMs,
        user_id: data.userId || null,
      }),
    ]);

    usageMetricsRecorded.inc({
      organization_id: data.organizationId,
      metric_type: data.metricType,
    });
  } catch (error) {
    logger.error('Failed to record usage metric', {
      error,
      organizationId: data.organizationId,
      endpoint: data.endpoint,
    });
  }
}

/**
 * Classify the request into a metric type based on the route
 */
function classifyMetricType(path: string, method: string): string {
  if (path.startsWith('/api/tasks')) return 'task_api';
  if (path.startsWith('/api/runs')) return 'run_api';
  if (path.startsWith('/api/schedules')) return 'schedule_api';
  if (path.startsWith('/api/workflows')) return 'workflow_api';
  if (path.startsWith('/api/deployments')) return 'deployment_api';
  if (path.startsWith('/api/integrations')) return 'integration_api';
  if (path.startsWith('/api/waitpoints')) return 'waitpoint_api';
  if (path.startsWith('/health')) return 'health_check';
  if (path.startsWith('/metrics')) return 'metrics';
  return 'api_call';
}

/**
 * Usage tracking middleware.
 * Attaches a listener to the response finish event to record metrics
 * asynchronously after the response is sent. Never blocks the request.
 */
export function usageTracker(pool: Pool) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = Date.now();

    res.on('finish', () => {
      const user = req.user;
      if (!user) return;

      const durationMs = Date.now() - startTime;
      const endpoint = req.route?.path || req.path;
      const metricType = classifyMetricType(req.path, req.method);

      // Fire-and-forget: do not await, do not block
      recordUsageMetric(pool, {
        organizationId: user.organizationId,
        metricType,
        endpoint,
        method: req.method,
        statusCode: res.statusCode,
        durationMs,
        userId: user.userId,
      }).catch((err) => {
        logger.error('Usage metric recording failed', { error: err });
      });
    });

    next();
  };
}

export default usageTracker;
