'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient, ApiError, ApiResponse } from '@/lib/api-client';

interface UseFetchReturn<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

export function useFetch<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  deps: unknown[] = []
): UseFetchReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const mountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<T>(path, params);
      if (mountedRef.current && id === fetchIdRef.current) {
        setData(response.data);
      }
    } catch (err) {
      if (mountedRef.current && id === fetchIdRef.current) {
        setError(err as ApiError);
      }
    } finally {
      if (mountedRef.current && id === fetchIdRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, JSON.stringify(params), ...deps]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}

export interface Task {
  id: string;
  slug: string;
  filePath: string;
  exportName: string;
  version: string;
  queue: string;
  machinePreset?: string;
  triggerSource: string;
  retry?: { maxAttempts: number; minTimeout: number; maxTimeout: number; factor: number };
  schema?: Record<string, unknown>;
  nexusIntegration?: string;
  lastRunStatus?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  taskSlug: string;
  status: string;
  payload?: any;
  output?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  isTest: boolean;
  idempotencyKey?: string;
  version?: string;
}

export interface Schedule {
  id: string;
  taskId: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  payload?: any;
  lastRunId?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  health: string;
  createdAt: string;
  updatedAt: string;
}

export interface Waitpoint {
  id: string;
  taskId: string;
  runId: string;
  description: string;
  inputData?: any;
  outputData?: any;
  status: 'pending' | 'resolved' | 'expired';
  expiresAt?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface Integration {
  id: string;
  service: string;
  displayName: string;
  enabled: boolean;
  url: string;
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastCheckAt?: string;
  taskTemplates: { id: string; name: string; description: string }[];
  config?: Record<string, unknown>;
}

export interface Deployment {
  id: string;
  version: string;
  status: 'active' | 'superseded' | 'failed' | 'deploying';
  deployedAt: string;
  promoted: boolean;
  taskCount: number;
  changelog?: string;
}

export interface RunStatistics {
  totalTasks: number;
  activeRuns: number;
  scheduledJobs: number;
  pendingWaitpoints: number;
  failedLast24h: number;
  runsByHour: { hour: string; count: number; failed: number }[];
  taskHealth: { taskId: string; status: 'healthy' | 'degraded' | 'failing' }[];
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret?: string;
  createdAt: string;
}

export interface Environment {
  id: string;
  name: string;
  slug: string;
  apiUrl?: string;
  current: boolean;
}

export function useTriggerApi() {
  const getTasks = useCallback(
    (params?: { search?: string; limit?: number; offset?: number }) =>
      apiClient.get<Task[]>('/tasks', params),
    []
  );

  const getTask = useCallback(
    (taskId: string) => apiClient.get<Task>(`/tasks/${taskId}`),
    []
  );

  const triggerTask = useCallback(
    (taskId: string, payload?: unknown) =>
      apiClient.post<Run>(`/tasks/${taskId}/trigger`, { payload }),
    []
  );

  const getRuns = useCallback(
    (params?: {
      status?: string;
      taskId?: string;
      tag?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }) => apiClient.get<Run[]>('/runs', params as Record<string, string | number | boolean | undefined>),
    []
  );

  const getRun = useCallback(
    (runId: string) => apiClient.get<Run>(`/runs/${runId}`),
    []
  );

  const cancelRun = useCallback(
    (runId: string) => apiClient.post<void>(`/runs/${runId}/cancel`),
    []
  );

  const replayRun = useCallback(
    (runId: string) => apiClient.post<Run>(`/runs/${runId}/replay`),
    []
  );

  const getRunLogs = useCallback(
    (runId: string) => apiClient.get<{ level: string; message: string; timestamp: string; data?: unknown }[]>(`/runs/${runId}/logs`),
    []
  );

  const getRunTrace = useCallback(
    (runId: string) => apiClient.get<{ spans: unknown[] }>(`/runs/${runId}/trace`),
    []
  );

  const getStatistics = useCallback(
    () => apiClient.get<RunStatistics>('/runs/statistics'),
    []
  );

  const getSchedules = useCallback(
    () => apiClient.get<Schedule[]>('/schedules'),
    []
  );

  const createSchedule = useCallback(
    (data: { taskId: string; cron: string; timezone: string; payload?: unknown }) =>
      apiClient.post<Schedule>('/schedules', data),
    []
  );

  const updateSchedule = useCallback(
    (scheduleId: string, data: Partial<Schedule>) =>
      apiClient.put<Schedule>(`/schedules/${scheduleId}`, data),
    []
  );

  const deleteSchedule = useCallback(
    (scheduleId: string) => apiClient.delete<void>(`/schedules/${scheduleId}`),
    []
  );

  const getWaitpoints = useCallback(
    (params?: { status?: string }) =>
      apiClient.get<Waitpoint[]>('/waitpoints', params),
    []
  );

  const resolveWaitpoint = useCallback(
    (waitpointId: string, data: { approved: boolean; output?: unknown }) =>
      apiClient.post<void>(`/waitpoints/${waitpointId}/resolve`, data),
    []
  );

  const getIntegrations = useCallback(
    () => apiClient.get<Integration[]>('/integrations'),
    []
  );

  const updateIntegration = useCallback(
    (integrationId: string, data: Partial<Integration>) =>
      apiClient.put<Integration>(`/integrations/${integrationId}`, data),
    []
  );

  const testIntegration = useCallback(
    (integrationId: string) =>
      apiClient.post<{ success: boolean; message: string; latencyMs: number }>(`/integrations/${integrationId}/test`),
    []
  );

  const getDeployments = useCallback(
    () => apiClient.get<Deployment[]>('/deployments'),
    []
  );

  const getWebhooks = useCallback(
    () => apiClient.get<Webhook[]>('/settings/webhooks'),
    []
  );

  const createWebhook = useCallback(
    (data: { url: string; events: string[] }) =>
      apiClient.post<Webhook>('/settings/webhooks', data),
    []
  );

  const deleteWebhook = useCallback(
    (webhookId: string) => apiClient.delete<void>(`/settings/webhooks/${webhookId}`),
    []
  );

  const getEnvironments = useCallback(
    () => apiClient.get<Environment[]>('/settings/environments'),
    []
  );

  const getApiKeys = useCallback(
    () => apiClient.get<{ id: string; name: string; maskedKey: string; createdAt: string }[]>('/settings/api-keys'),
    []
  );

  const regenerateApiKey = useCallback(
    (keyId: string) =>
      apiClient.post<{ key: string }>(`/settings/api-keys/${keyId}/regenerate`),
    []
  );

  return {
    getTasks,
    getTask,
    triggerTask,
    getRuns,
    getRun,
    cancelRun,
    replayRun,
    getRunLogs,
    getRunTrace,
    getStatistics,
    getSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    getWaitpoints,
    resolveWaitpoint,
    getIntegrations,
    updateIntegration,
    testIntegration,
    getDeployments,
    getWebhooks,
    createWebhook,
    deleteWebhook,
    getEnvironments,
    getApiKeys,
    regenerateApiKey,
  };
}
