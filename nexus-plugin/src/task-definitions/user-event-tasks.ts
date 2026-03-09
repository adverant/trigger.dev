import type { TaskRegistryEntry } from './registry';

export const USER_EVENT_TASKS: TaskRegistryEntry[] = [
  {
    taskIdentifier: 'user-event-notification',
    description: 'Process and send user event notification emails (signup, login, subscription changes)',
    nexusService: 'auth',
    retryConfig: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 10000, factor: 2 },
  },
  {
    taskIdentifier: 'user-event-daily-digest',
    description: 'Daily summary of platform user activity, signups, and security events',
    nexusService: 'auth',
    retryConfig: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 60000, factor: 2 },
    queueName: 'cron',
  },
];
