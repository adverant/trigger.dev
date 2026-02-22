/**
 * Redis Service
 *
 * Provides:
 * - Connection management with retry strategy and exponential backoff
 * - Key namespacing (trigger:*)
 * - Health check method
 * - Graceful shutdown
 */

import Redis, { RedisOptions } from 'ioredis';
import { createLogger } from '../utils/logger';
import { redisCommandDuration, redisErrors } from '../utils/metrics';

const logger = createLogger({ component: 'redis-service' });

let redisClient: Redis | null = null;

/**
 * Initialize Redis client from connection URL with exponential backoff retry strategy.
 */
export function initializeRedis(url: string): Redis {
  if (redisClient) {
    logger.warn('Redis client already initialized, returning existing instance');
    return redisClient;
  }

  const options: RedisOptions = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    keyPrefix: 'trigger:',
    retryStrategy: (times: number) => {
      if (times > 10) {
        logger.error('Redis retry limit exceeded, giving up', { attempts: times });
        return null;
      }
      const delay = Math.min(times * 100, 5000);
      logger.warn(`Redis connection retry attempt ${times}`, { delay });
      return delay;
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
      return targetErrors.some((e) => err.message.includes(e));
    },
  };

  redisClient = new Redis(url, options);

  redisClient.on('connect', () => {
    logger.info('Redis connection established');
  });

  redisClient.on('ready', () => {
    logger.info('Redis client ready');
  });

  redisClient.on('error', (error) => {
    logger.error('Redis client error', { error: error.message });
    redisErrors.inc({ command: 'connection', error_type: error.name });
  });

  redisClient.on('close', () => {
    logger.warn('Redis connection closed');
  });

  redisClient.on('reconnecting', () => {
    logger.info('Redis reconnecting...');
  });

  return redisClient;
}

/**
 * Get the initialized Redis client
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call initializeRedis first.');
  }
  return redisClient;
}

/**
 * Health check for Redis connectivity
 */
export async function redisHealthCheck(client: Redis): Promise<{
  healthy: boolean;
  latency?: number;
  error?: string;
}> {
  const start = Date.now();

  try {
    await client.ping();
    const latency = Date.now() - start;
    redisCommandDuration.observe({ command: 'PING' }, latency / 1000);

    logger.debug('Redis health check passed', { latency });
    return { healthy: true, latency };
  } catch (error) {
    const latency = Date.now() - start;
    logger.error('Redis health check failed', { error, latency });

    return {
      healthy: false,
      latency,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Graceful shutdown - close Redis connection cleanly
 */
export async function shutdownRedis(): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    logger.info('Closing Redis connection...');
    await redisClient.quit();
    redisClient = null;
    logger.info('Redis connection closed');
  } catch (error) {
    logger.error('Failed to close Redis connection gracefully, forcing disconnect', { error });
    try {
      redisClient.disconnect();
    } catch {
      // Already disconnected
    }
    redisClient = null;
  }
}

export default initializeRedis;
