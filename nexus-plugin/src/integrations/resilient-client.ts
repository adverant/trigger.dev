/**
 * Resilient Axios Client Factory
 *
 * Wraps axios.create() with:
 * - Automatic retry with exponential backoff (configurable)
 * - Circuit breaker pattern (prevents cascading failures)
 * - Request/response logging
 *
 * Used by all integration clients for consistent reliability behavior.
 */

import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosError,
  InternalAxiosRequestConfig,
} from 'axios';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'resilient-client' });

export interface ResilientClientConfig extends AxiosRequestConfig {
  /** Service name for logging */
  serviceName: string;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial retry delay in ms (default: 1000) */
  retryDelay?: number;
  /** Circuit breaker: consecutive failures before opening (default: 5) */
  circuitBreakerThreshold?: number;
  /** Circuit breaker: ms to wait before half-open probe (default: 30000) */
  circuitBreakerResetMs?: number;
}

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  threshold: number;
  resetMs: number;
}

/** Status codes that should NOT trigger a retry */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 409, 422]);

/** Per-service circuit breaker state */
const circuitBreakers = new Map<string, CircuitBreakerState>();

function getCircuitBreaker(
  serviceName: string,
  threshold: number,
  resetMs: number
): CircuitBreakerState {
  let cb = circuitBreakers.get(serviceName);
  if (!cb) {
    cb = {
      state: 'closed',
      failures: 0,
      lastFailure: 0,
      threshold,
      resetMs,
    };
    circuitBreakers.set(serviceName, cb);
  }
  return cb;
}

function checkCircuitBreaker(cb: CircuitBreakerState): void {
  if (cb.state === 'open') {
    const elapsed = Date.now() - cb.lastFailure;
    if (elapsed >= cb.resetMs) {
      cb.state = 'half-open';
      logger.info('Circuit breaker half-open, allowing probe request', {
        elapsed,
      });
    } else {
      throw new Error(
        `Circuit breaker OPEN — service unavailable (resets in ${Math.ceil((cb.resetMs - elapsed) / 1000)}s)`
      );
    }
  }
}

function recordSuccess(cb: CircuitBreakerState): void {
  if (cb.state === 'half-open') {
    logger.info('Circuit breaker closing after successful probe');
  }
  cb.state = 'closed';
  cb.failures = 0;
}

function recordFailure(cb: CircuitBreakerState, serviceName: string): void {
  cb.failures++;
  cb.lastFailure = Date.now();

  if (cb.failures >= cb.threshold) {
    cb.state = 'open';
    logger.warn('Circuit breaker OPEN', {
      serviceName,
      failures: cb.failures,
      threshold: cb.threshold,
      resetMs: cb.resetMs,
    });
  }
}

function isRetryable(error: AxiosError): boolean {
  // Network errors are retryable
  if (!error.response) return true;
  // Server errors (5xx) are retryable, client errors (4xx) generally aren't
  if (NON_RETRYABLE_STATUS.has(error.response.status)) return false;
  return error.response.status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an Axios instance with retry + circuit breaker behavior.
 *
 * Usage:
 *   const client = createResilientClient({
 *     serviceName: 'graphrag',
 *     baseURL: 'http://nexus-graphrag:8090',
 *     timeout: 30000,
 *   });
 */
export function createResilientClient(config: ResilientClientConfig): AxiosInstance {
  const {
    serviceName,
    maxRetries = 3,
    retryDelay = 1000,
    circuitBreakerThreshold = 5,
    circuitBreakerResetMs = 30000,
    ...axiosConfig
  } = config;

  const client = axios.create(axiosConfig);
  const cb = getCircuitBreaker(serviceName, circuitBreakerThreshold, circuitBreakerResetMs);

  // Response interceptor: retry on failure
  client.interceptors.response.use(
    (response) => {
      recordSuccess(cb);
      return response;
    },
    async (error: AxiosError) => {
      const requestConfig = error.config as InternalAxiosRequestConfig & { _retryCount?: number };
      if (!requestConfig) {
        recordFailure(cb, serviceName);
        return Promise.reject(error);
      }

      const retryCount = requestConfig._retryCount || 0;

      if (retryCount >= maxRetries || !isRetryable(error)) {
        recordFailure(cb, serviceName);
        return Promise.reject(error);
      }

      requestConfig._retryCount = retryCount + 1;
      const delay = retryDelay * Math.pow(2, retryCount); // exponential backoff

      logger.warn('Retrying request', {
        serviceName,
        attempt: retryCount + 1,
        maxRetries,
        delay,
        url: requestConfig.url,
        status: error.response?.status,
        message: error.message,
      });

      await sleep(delay);

      // Check circuit breaker before retry
      try {
        checkCircuitBreaker(cb);
      } catch (cbError) {
        return Promise.reject(cbError);
      }

      return client.request(requestConfig);
    }
  );

  // Request interceptor: check circuit breaker before sending
  client.interceptors.request.use(
    (requestConfig) => {
      checkCircuitBreaker(cb);
      return requestConfig;
    },
    (error) => Promise.reject(error)
  );

  return client;
}

/**
 * Get circuit breaker status for a service (used by health endpoints).
 */
export function getCircuitBreakerStatus(serviceName: string): {
  state: CircuitState;
  failures: number;
  lastFailure: number;
} | null {
  const cb = circuitBreakers.get(serviceName);
  if (!cb) return null;
  return {
    state: cb.state,
    failures: cb.failures,
    lastFailure: cb.lastFailure,
  };
}

/**
 * Reset circuit breaker for a service (e.g., after manual verification).
 */
export function resetCircuitBreaker(serviceName: string): void {
  const cb = circuitBreakers.get(serviceName);
  if (cb) {
    cb.state = 'closed';
    cb.failures = 0;
    cb.lastFailure = 0;
    logger.info('Circuit breaker manually reset', { serviceName });
  }
}
