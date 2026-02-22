/**
 * Trigger.dev Client Factory
 *
 * Creates and configures:
 * - Trigger.dev SDK client via configure() for task triggering
 * - Axios REST client for Trigger.dev Management API (runs, tasks, schedules, envvars)
 *
 * Supports both self-hosted and external Trigger.dev instances.
 */

import axios, { AxiosInstance } from 'axios';
import { TriggerConfig } from './index';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'trigger-client' });

export interface TriggerClients {
  managementApi: AxiosInstance;
}

/**
 * Initialize the Trigger.dev SDK config.
 * The plugin server uses the Management REST API, not the SDK task runner.
 * SDK configure() is only needed by Trigger.dev worker processes.
 */
export function initializeTriggerSdk(config: TriggerConfig): void {
  if (!config.secretKey) {
    logger.warn('TRIGGER_SECRET_KEY not set - SDK task triggering will fail');
    return;
  }

  logger.info('Trigger.dev SDK config loaded (REST API mode)', {
    apiUrl: config.apiUrl,
    environment: config.environment,
    mode: config.mode,
    projectRef: config.projectRef || '(not set)',
  });
}

/**
 * Create an Axios client for the Trigger.dev Management REST API.
 * Uses the Personal Access Token (PAT) for cross-project access.
 *
 * API base: {apiUrl}/api/v1
 * Auth: Bearer <PAT>
 */
export function createManagementApiClient(config: TriggerConfig): AxiosInstance {
  const baseURL = `${config.apiUrl.replace(/\/$/, '')}/api/v1`;

  const client = axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.personalAccessToken}`,
    },
  });

  client.interceptors.request.use(
    (reqConfig) => {
      logger.debug('Trigger Management API request', {
        method: reqConfig.method?.toUpperCase(),
        url: reqConfig.url,
      });
      return reqConfig;
    },
    (error) => {
      logger.error('Trigger Management API request error', { error: error.message });
      return Promise.reject(error);
    }
  );

  client.interceptors.response.use(
    (response) => {
      logger.debug('Trigger Management API response', {
        status: response.status,
        url: response.config.url,
      });
      return response;
    },
    (error) => {
      if (axios.isAxiosError(error)) {
        logger.error('Trigger Management API error', {
          status: error.response?.status,
          url: error.config?.url,
          message: error.response?.data?.error || error.message,
        });
      }
      return Promise.reject(error);
    }
  );

  logger.info('Trigger.dev Management API client created', { baseURL });
  return client;
}

/**
 * Create all Trigger.dev clients: initialize SDK and build Management API client.
 */
export function createTriggerClients(config: TriggerConfig): TriggerClients {
  initializeTriggerSdk(config);
  const managementApi = createManagementApiClient(config);

  return { managementApi };
}

export default createTriggerClients;
