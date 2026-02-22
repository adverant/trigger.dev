import { AxiosInstance } from 'axios';
import { createLogger } from '../utils/logger';
import { TriggerApiError } from '../utils/errors';
import { externalServiceDuration, externalServiceErrors } from '../utils/metrics';

const logger = createLogger({ component: 'trigger-proxy-service' });

export interface TriggerTaskOptions {
  idempotencyKey?: string;
  delay?: string;
  ttl?: string;
  tags?: string[];
  metadata?: Record<string, any>;
  queue?: { name: string; concurrencyKey?: string };
}

export interface BatchTriggerItem {
  taskIdentifier: string;
  payload: any;
  options?: TriggerTaskOptions;
}

export interface RunFilters {
  status?: string[];
  taskIdentifier?: string;
  limit?: number;
  after?: string;
  before?: string;
  period?: string;
  bulkAction?: string;
}

export interface CreateScheduleData {
  task: string;
  cron: string;
  externalId?: string;
  deduplicationKey?: string;
  timezone?: string;
  environments?: string[];
}

export class TriggerProxyService {
  private api: AxiosInstance;

  constructor(managementApiClient: AxiosInstance) {
    this.api = managementApiClient;
  }

  // =========================================================================
  // Tasks
  // =========================================================================

  async triggerTask(taskId: string, payload: any, options?: TriggerTaskOptions): Promise<any> {
    return this.callApi('POST', `/tasks/${taskId}/trigger`, {
      payload,
      options: options ? {
        idempotencyKey: options.idempotencyKey,
        delay: options.delay,
        ttl: options.ttl,
        tags: options.tags,
        metadata: options.metadata,
        queue: options.queue,
      } : undefined,
    }, 'triggerTask');
  }

  async batchTrigger(items: BatchTriggerItem[]): Promise<any> {
    return this.callApi('POST', '/tasks/batch', {
      items: items.map((item) => ({
        task: item.taskIdentifier,
        payload: item.payload,
        options: item.options,
      })),
    }, 'batchTrigger');
  }

  // =========================================================================
  // Runs
  // =========================================================================

  async listRuns(filters?: RunFilters): Promise<any> {
    const params: Record<string, any> = {};
    if (filters) {
      if (filters.status && filters.status.length > 0) params['filter[status]'] = filters.status.join(',');
      if (filters.taskIdentifier) params['filter[taskIdentifier]'] = filters.taskIdentifier;
      if (filters.limit) params['page[size]'] = filters.limit;
      if (filters.after) params['page[after]'] = filters.after;
      if (filters.before) params['page[before]'] = filters.before;
      if (filters.period) params['filter[period]'] = filters.period;
      if (filters.bulkAction) params['filter[bulkAction]'] = filters.bulkAction;
    }
    return this.callApi('GET', '/runs', undefined, 'listRuns', params);
  }

  async getRun(runId: string): Promise<any> {
    return this.callApi('GET', `/runs/${runId}`, undefined, 'getRun');
  }

  async cancelRun(runId: string): Promise<any> {
    return this.callApi('POST', `/runs/${runId}/cancel`, undefined, 'cancelRun');
  }

  async replayRun(runId: string): Promise<any> {
    return this.callApi('POST', `/runs/${runId}/replay`, undefined, 'replayRun');
  }

  async rescheduleRun(runId: string, delay: string): Promise<any> {
    return this.callApi('POST', `/runs/${runId}/reschedule`, { delay }, 'rescheduleRun');
  }

  // =========================================================================
  // Schedules
  // =========================================================================

  async listSchedules(params?: { page?: number; perPage?: number }): Promise<any> {
    const queryParams: Record<string, any> = {};
    if (params?.page) queryParams['page[number]'] = params.page;
    if (params?.perPage) queryParams['page[size]'] = params.perPage;
    return this.callApi('GET', '/schedules', undefined, 'listSchedules', queryParams);
  }

  async createSchedule(data: CreateScheduleData): Promise<any> {
    return this.callApi('POST', '/schedules', data, 'createSchedule');
  }

  async updateSchedule(scheduleId: string, data: Partial<CreateScheduleData>): Promise<any> {
    return this.callApi('PUT', `/schedules/${scheduleId}`, data, 'updateSchedule');
  }

  async deleteSchedule(scheduleId: string): Promise<any> {
    return this.callApi('DELETE', `/schedules/${scheduleId}`, undefined, 'deleteSchedule');
  }

  async activateSchedule(scheduleId: string): Promise<any> {
    return this.callApi('POST', `/schedules/${scheduleId}/activate`, undefined, 'activateSchedule');
  }

  async deactivateSchedule(scheduleId: string): Promise<any> {
    return this.callApi('POST', `/schedules/${scheduleId}/deactivate`, undefined, 'deactivateSchedule');
  }

  async getTimezones(): Promise<any> {
    return this.callApi('GET', '/schedules/timezones', undefined, 'getTimezones');
  }

  // =========================================================================
  // Environment Variables
  // =========================================================================

  async listEnvVars(): Promise<any> {
    return this.callApi('GET', '/envvars', undefined, 'listEnvVars');
  }

  async createEnvVar(name: string, value: string): Promise<any> {
    return this.callApi('POST', '/envvars', { name, value }, 'createEnvVar');
  }

  async updateEnvVar(name: string, value: string): Promise<any> {
    return this.callApi('PUT', `/envvars/${encodeURIComponent(name)}`, { value }, 'updateEnvVar');
  }

  async deleteEnvVar(name: string): Promise<any> {
    return this.callApi('DELETE', `/envvars/${encodeURIComponent(name)}`, undefined, 'deleteEnvVar');
  }

  async importEnvVars(variables: Array<{ name: string; value: string }>, override?: boolean): Promise<any> {
    return this.callApi('POST', '/envvars/import', {
      variables,
      override: override ?? false,
    }, 'importEnvVars');
  }

  // =========================================================================
  // Queues
  // =========================================================================

  async listQueues(params?: { page?: number; perPage?: number }): Promise<any> {
    const queryParams: Record<string, any> = {};
    if (params?.page) queryParams['page[number]'] = params.page;
    if (params?.perPage) queryParams['page[size]'] = params.perPage;
    return this.callApi('GET', '/queues', undefined, 'listQueues', queryParams);
  }

  async pauseQueue(queueId: string): Promise<any> {
    return this.callApi('POST', `/queues/${queueId}/pause`, undefined, 'pauseQueue');
  }

  async resumeQueue(queueId: string): Promise<any> {
    return this.callApi('POST', `/queues/${queueId}/resume`, undefined, 'resumeQueue');
  }

  // =========================================================================
  // Deployments
  // =========================================================================

  async getLatestDeployment(): Promise<any> {
    return this.callApi('GET', '/deployments/latest', undefined, 'getLatestDeployment');
  }

  // =========================================================================
  // Waitpoints (Tokens)
  // =========================================================================

  async completeWaitpointToken(tokenId: string, output: any): Promise<any> {
    return this.callApi('POST', `/waitpoint-tokens/${tokenId}/complete`, {
      output,
    }, 'completeWaitpointToken');
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  private async callApi(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data?: any,
    operation: string = 'unknown',
    params?: Record<string, any>
  ): Promise<any> {
    const start = Date.now();
    try {
      const response = await this.api.request({
        method,
        url: path,
        data,
        params,
      });

      const duration = (Date.now() - start) / 1000;
      externalServiceDuration.observe({ service: 'trigger-dev', operation }, duration);

      logger.debug('Trigger.dev API call succeeded', {
        method,
        path,
        operation,
        status: response.status,
        duration,
      });

      return response.data;
    } catch (error: any) {
      const duration = (Date.now() - start) / 1000;
      externalServiceErrors.inc({
        service: 'trigger-dev',
        operation,
        error_type: error.response?.status?.toString() || 'network_error',
      });

      const status = error.response?.status;
      const triggerError = error.response?.data;

      logger.error('Trigger.dev API call failed', {
        method,
        path,
        operation,
        status,
        error: triggerError?.error || error.message,
        duration,
      });

      throw new TriggerApiError(
        `Trigger.dev API error on ${method} ${path}: ${triggerError?.error || error.message}`,
        status,
        triggerError
      );
    }
  }
}
