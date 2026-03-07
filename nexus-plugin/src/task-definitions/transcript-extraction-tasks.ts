/**
 * Transcript Extraction task definitions for the Nexus Trigger.dev plugin.
 *
 * These tasks handle YouTube transcript extraction with conservative rate
 * limiting, resume support, and respect for YouTube rate limits.
 */

import type { TaskRegistryEntry } from './registry';

export const TRANSCRIPT_EXTRACTION_TASKS: TaskRegistryEntry[] = [
  {
    taskIdentifier: 'transcript-extract-channel',
    description: 'Extract all transcripts from a YouTube channel with conservative rate limiting. Resumes from previous runs, respects YouTube rate limits with 7-10s delays between requests.',
    nexusService: 'skills-engine',
    retryConfig: { maxAttempts: 1 },
    queueName: 'cron',
  },
];
