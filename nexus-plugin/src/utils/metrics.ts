/**
 * Prometheus Metrics
 *
 * Provides comprehensive metrics collection for:
 * - HTTP request duration and counts
 * - WebSocket connections
 * - Database query performance
 * - Trigger.dev task and run tracking
 * - Rate limiting and quota enforcement
 */

import client, { Counter, Histogram, Gauge, Registry } from 'prom-client';

export const register = new Registry();

client.collectDefaultMetrics({ register });

/**
 * HTTP Metrics
 */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestErrors = new Counter({
  name: 'http_request_errors_total',
  help: 'Total number of HTTP request errors',
  labelNames: ['method', 'route', 'error_type'],
  registers: [register],
});

/**
 * WebSocket Metrics
 */
export const wsConnections = new Gauge({
  name: 'websocket_connections_active',
  help: 'Number of active WebSocket connections',
  labelNames: ['organization_id'],
  registers: [register],
});

/**
 * Database Metrics
 */
export const dbQueryDuration = new Histogram({
  name: 'database_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register],
});

export const dbErrors = new Counter({
  name: 'database_errors_total',
  help: 'Total number of database errors',
  labelNames: ['operation', 'error_type'],
  registers: [register],
});

export const dbConnectionsActive = new Gauge({
  name: 'database_connections_active',
  help: 'Number of active database connections',
  labelNames: ['pool'],
  registers: [register],
});

/**
 * Trigger.dev Task & Run Metrics
 */
export const triggerTasksTriggered = new Counter({
  name: 'trigger_tasks_triggered_total',
  help: 'Total number of Trigger.dev tasks triggered',
  labelNames: ['task_id', 'organization_id'],
  registers: [register],
});

export const triggerRunsCompleted = new Counter({
  name: 'trigger_runs_completed_total',
  help: 'Total number of Trigger.dev runs completed successfully',
  labelNames: ['task_id', 'organization_id'],
  registers: [register],
});

export const triggerRunsFailed = new Counter({
  name: 'trigger_runs_failed_total',
  help: 'Total number of Trigger.dev runs that failed',
  labelNames: ['task_id', 'organization_id', 'error_type'],
  registers: [register],
});

/**
 * Rate Limiting Metrics
 */
export const rateLimitHits = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['organization_id', 'tier', 'limit_type'],
  registers: [register],
});

export const rateLimitRemaining = new Gauge({
  name: 'rate_limit_remaining',
  help: 'Remaining rate limit quota',
  labelNames: ['organization_id', 'tier', 'limit_type'],
  registers: [register],
});

/**
 * Quota Metrics
 */
export const quotaUsage = new Gauge({
  name: 'quota_usage',
  help: 'Current quota usage',
  labelNames: ['organization_id', 'tier', 'quota_type'],
  registers: [register],
});

export const quotaLimit = new Gauge({
  name: 'quota_limit',
  help: 'Quota limit',
  labelNames: ['organization_id', 'tier', 'quota_type'],
  registers: [register],
});

export const quotaExceeded = new Counter({
  name: 'quota_exceeded_total',
  help: 'Total number of quota exceeded events',
  labelNames: ['organization_id', 'tier', 'quota_type'],
  registers: [register],
});

/**
 * Redis Metrics
 */
export const redisCommandDuration = new Histogram({
  name: 'redis_command_duration_seconds',
  help: 'Duration of Redis commands in seconds',
  labelNames: ['command'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

export const redisErrors = new Counter({
  name: 'redis_errors_total',
  help: 'Total number of Redis errors',
  labelNames: ['command', 'error_type'],
  registers: [register],
});

/**
 * External Service Metrics
 */
export const externalServiceDuration = new Histogram({
  name: 'external_service_duration_seconds',
  help: 'Duration of external service calls in seconds',
  labelNames: ['service', 'operation'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const externalServiceErrors = new Counter({
  name: 'external_service_errors_total',
  help: 'Total number of external service errors',
  labelNames: ['service', 'operation', 'error_type'],
  registers: [register],
});

/**
 * Usage Tracking Metrics
 */
export const usageMetricsRecorded = new Counter({
  name: 'usage_metrics_recorded_total',
  help: 'Total number of usage metric records written',
  labelNames: ['organization_id', 'metric_type'],
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export async function getMetricsJSON(): Promise<any> {
  return register.getMetricsAsJSON();
}

export function resetMetrics(): void {
  register.resetMetrics();
}

export default {
  register,
  getMetrics,
  getMetricsJSON,
  resetMetrics,
};
