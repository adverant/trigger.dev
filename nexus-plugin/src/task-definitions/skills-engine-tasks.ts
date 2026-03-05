/**
 * Skills Engine task definitions for the Nexus Trigger.dev plugin.
 *
 * These tasks bridge skill generation workflows into the Trigger.dev
 * run history so they appear on the Workflows → Runs page.
 */

import type { TaskRegistryEntry } from './registry';

export const SKILLS_ENGINE_TASKS: TaskRegistryEntry[] = [
  {
    taskIdentifier: 'skills-engine-generate',
    description: 'Generate a new skill from a natural language prompt with multi-phase LLM pipeline',
    nexusService: 'skills-engine',
    retryConfig: { maxAttempts: 1 }, // No retry — generation is expensive
  },
  {
    taskIdentifier: 'skills-engine-regenerate',
    description: 'Regenerate an existing skill with updated standards compliance',
    nexusService: 'skills-engine',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 300000, factor: 2 },
  },
  {
    taskIdentifier: 'skills-engine-batch-regenerate',
    description: 'Batch regeneration of multiple skills for standards alignment',
    nexusService: 'skills-engine',
    retryConfig: { maxAttempts: 1 },
    queueName: 'cron',
  },
  {
    taskIdentifier: 'skills-engine-sync-local',
    description: 'Sync published skills to local Claude Code workspace',
    nexusService: 'skills-engine',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 30000, factor: 2 },
  },
];
