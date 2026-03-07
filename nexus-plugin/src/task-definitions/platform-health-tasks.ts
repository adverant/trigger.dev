/**
 * Platform Health Monitor task definitions.
 *
 * Tasks:
 * - platform-health-monitor: Scheduled every 30 minutes. No AI. Dynamically
 *   discovers and checks ALL K8s resources, services, databases, certs, DNS,
 *   plugins, and Istio. Triggers remediation when issues exceed baseline.
 *
 * - platform-health-remediation: On-demand, triggered by the monitor when
 *   issues are detected. Uses Gemini 2.5 Pro for root-cause analysis.
 *   Generates markdown + XML remediation reports, stores to DB/NFS/GraphRAG,
 *   and sends email notification.
 */

import { schedules, task } from '@trigger.dev/sdk/v3';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import type { TaskRegistryEntry } from './registry';
import { PlatformHealthMonitor } from '../services/platform-health-monitor';
import { PlatformHealthRemediation } from '../services/platform-health-remediation';
import type { PlatformHealthReport, RemediationReport } from '../types/health-monitor';

// ---------------------------------------------------------------------------
// Shared logic — exported for direct invocation by task.service.ts
// ---------------------------------------------------------------------------

/**
 * Run the full platform health check. Returns the health report.
 * The caller (task.service.ts) decides whether to trigger remediation.
 */
export async function runPlatformHealthCheck(
  db: Pool,
  redis: Redis,
): Promise<PlatformHealthReport> {
  const monitor = new PlatformHealthMonitor(db, redis);
  return monitor.runFullHealthCheck();
}

/**
 * Check whether remediation should be triggered for the given report.
 */
export async function shouldTriggerRemediation(
  db: Pool,
  redis: Redis,
  report: PlatformHealthReport,
): Promise<boolean> {
  const monitor = new PlatformHealthMonitor(db, redis);
  return monitor.shouldTriggerRemediation(report);
}

/**
 * Run the AI remediation analysis on a health report.
 */
export async function runPlatformHealthRemediation(
  db: Pool,
  healthReport: PlatformHealthReport,
): Promise<RemediationReport> {
  const remediation = new PlatformHealthRemediation(db);
  return remediation.analyzeAndRemediate(healthReport);
}

// ---------------------------------------------------------------------------
// Scheduled Task: Every 30 minutes
// ---------------------------------------------------------------------------

export const platformHealthMonitor = schedules.task({
  id: 'platform-health-monitor',
  cron: '*/30 * * * *',
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 120000,
    factor: 2,
  },
  run: async (payload) => {
    // Note: When invoked via Trigger.dev SDK directly (not through our
    // task.service.ts handler), DB/Redis are not available. The handler in
    // task.service.ts provides these and calls runPlatformHealthCheck directly.
    console.log('[platform-health] Scheduled health check triggered via SDK');
    return { message: 'Use task.service.ts handler for full execution' };
  },
});

// ---------------------------------------------------------------------------
// On-demand Task: Triggered by monitor when issues found
// ---------------------------------------------------------------------------

export const platformHealthRemediation = task({
  id: 'platform-health-remediation',
  retry: {
    maxAttempts: 1, // No retry — AI analysis is expensive
  },
  run: async (payload: { healthReport: PlatformHealthReport }) => {
    console.log('[platform-health] Remediation analysis triggered via SDK');
    return { message: 'Use task.service.ts handler for full execution' };
  },
});

// ---------------------------------------------------------------------------
// Registry export
// ---------------------------------------------------------------------------

export const PLATFORM_HEALTH_TASKS: TaskRegistryEntry[] = [
  {
    taskIdentifier: 'platform-health-monitor',
    description: 'Scheduled platform-wide health check: dynamically discovers and monitors all K8s pods, deployments, services, databases, certs, DNS, Istio, and plugins (every 30 min, no AI)',
    nexusService: 'platform',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 120000, factor: 2 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'platform-health-remediation',
    description: 'AI-powered remediation analysis using Gemini 2.5 Pro — triggered when health issues exceed baseline thresholds. Generates markdown + XML reports, stores to DB/NFS/GraphRAG, sends email.',
    nexusService: 'platform',
    retryConfig: { maxAttempts: 1 },
  },
];
