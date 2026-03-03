/**
 * WebSocket event type definitions for the Nexus Trigger plugin.
 * All events are emitted via Socket.IO to connected clients.
 */

export const WS_EVENTS = {
  // Task events
  TASK_TRIGGERED: 'task.triggered',
  TASK_BATCH_TRIGGERED: 'task.batch_triggered',

  // Run events
  RUN_STARTED: 'run.started',
  RUN_LOG: 'run.log',
  RUN_STATUS: 'run.status',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_CANCELLED: 'run.cancelled',

  // Schedule events
  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_DELETED: 'schedule.deleted',
  SCHEDULE_TRIGGERED: 'schedule.triggered',

  // Waitpoint events
  WAITPOINT_CREATED: 'waitpoint.created',
  WAITPOINT_COMPLETED: 'waitpoint.completed',
  WAITPOINT_EXPIRED: 'waitpoint.expired',

  // Deployment events
  DEPLOYMENT_STARTED: 'deployment.started',
  DEPLOYMENT_COMPLETED: 'deployment.completed',
  DEPLOYMENT_FAILED: 'deployment.failed',

  // Integration events
  INTEGRATION_HEALTH_CHANGED: 'integration.health_changed',
  INTEGRATION_CONFIGURED: 'integration.configured',

  // Queue events
  QUEUE_PAUSED: 'queue.paused',
  QUEUE_RESUMED: 'queue.resumed',

  // Workflow events
  WORKFLOW_CREATED: 'workflow.created',
  WORKFLOW_RUN_STARTED: 'workflow_run.started',
  WORKFLOW_RUN_PROGRESS: 'workflow_run.progress',
  WORKFLOW_RUN_COMPLETED: 'workflow_run.completed',
  WORKFLOW_RUN_FAILED: 'workflow_run.failed',
  WORKFLOW_RUN_CANCELLED: 'workflow_run.cancelled',

  // Connection lifecycle
  JOIN: 'join',
  LEAVE: 'leave',
  SUBSCRIBE_RUN: 'subscribe_run',
  UNSUBSCRIBE_RUN: 'unsubscribe_run',
} as const;

export interface TaskTriggeredEvent {
  taskId: string;
  runId: string;
  status: string;
  timestamp: string;
}

export interface TaskBatchTriggeredEvent {
  count: number;
  batchId: string;
  taskIdentifiers: string[];
  timestamp: string;
}

export interface RunStartedEvent {
  runId: string;
  triggerRunId: string;
  taskIdentifier: string;
  status: string;
  timestamp: string;
}

export interface RunLogEvent {
  runId: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
  data?: any;
}

export interface RunStatusEvent {
  runId: string;
  triggerRunId: string;
  taskIdentifier: string;
  previousStatus: string;
  status: string;
  durationMs?: number;
  timestamp: string;
}

export interface RunCompletedEvent {
  runId: string;
  triggerRunId: string;
  taskIdentifier: string;
  status: 'COMPLETED';
  durationMs: number;
  output?: any;
  timestamp: string;
}

export interface RunFailedEvent {
  runId: string;
  triggerRunId: string;
  taskIdentifier: string;
  status: 'FAILED' | 'CRASHED' | 'SYSTEM_FAILURE' | 'TIMED_OUT';
  errorMessage?: string;
  durationMs?: number;
  timestamp: string;
}

export interface ScheduleCreatedEvent {
  scheduleId: string;
  taskIdentifier: string;
  cronExpression: string;
  timezone: string;
  timestamp: string;
}

export interface ScheduleTriggeredEvent {
  scheduleId: string;
  taskIdentifier: string;
  runId: string;
  timestamp: string;
}

export interface WaitpointCreatedEvent {
  waitpointId: string;
  tokenId: string;
  taskIdentifier: string;
  description?: string;
  expiresAt?: string;
  timestamp: string;
}

export interface WaitpointCompletedEvent {
  waitpointId: string;
  tokenId: string;
  completedBy: string;
  output?: any;
  timestamp: string;
}

export interface IntegrationHealthEvent {
  serviceName: string;
  previousStatus: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  latencyMs?: number;
  timestamp: string;
}

export interface QueueEvent {
  queueId: string;
  queueName: string;
  action: 'paused' | 'resumed';
  timestamp: string;
}
