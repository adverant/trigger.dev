/**
 * Health Check Utilities
 *
 * Provides comprehensive health checks for:
 * - Database connectivity (pool stats + test query)
 * - Redis connectivity (PING)
 * - Trigger.dev instance (GET /health)
 * - System resources (memory, disk)
 */

import { Pool } from 'pg';
import { Redis } from 'ioredis';
import axios from 'axios';
import { defaultLogger as logger } from './logger';

export interface CheckResult {
  status: 'pass' | 'fail';
  message?: string;
  duration?: number;
  error?: string;
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, CheckResult>;
  uptime: number;
  version: string;
  timestamp: string;
}

export class HealthChecker {
  private startTime: number;
  private version: string;

  constructor(version: string = '1.0.0') {
    this.startTime = Date.now();
    this.version = version;
  }

  private getUptime(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  /**
   * Check PostgreSQL connectivity with pool stats and a test query
   */
  async checkDatabase(pool: Pool): Promise<CheckResult> {
    const start = Date.now();
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();

      const duration = Date.now() - start;
      const stats = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };

      logger.debug('Database health check passed', { duration, ...stats });

      return {
        status: 'pass',
        message: `Database is reachable (pool: ${stats.total} total, ${stats.idle} idle, ${stats.waiting} waiting)`,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('Database health check failed', { error, duration });

      return {
        status: 'fail',
        message: 'Database is unreachable',
        duration,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check Redis connectivity via PING
   */
  async checkRedis(redis: Redis): Promise<CheckResult> {
    const start = Date.now();
    try {
      await redis.ping();
      const duration = Date.now() - start;

      logger.debug('Redis health check passed', { duration });

      return {
        status: 'pass',
        message: 'Redis is reachable',
        duration,
      };
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('Redis health check failed', { error, duration });

      return {
        status: 'fail',
        message: 'Redis is unreachable',
        duration,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check Trigger.dev instance health via GET /health
   */
  async checkTriggerDev(apiUrl: string, timeout: number = 5000): Promise<CheckResult> {
    const start = Date.now();
    try {
      const healthUrl = `${apiUrl.replace(/\/$/, '')}/health`;
      const response = await axios.get(healthUrl, {
        timeout,
        validateStatus: (status) => status < 500,
      });

      const duration = Date.now() - start;
      logger.debug('Trigger.dev health check passed', { duration, status: response.status });

      return {
        status: 'pass',
        message: 'Trigger.dev is reachable',
        duration,
      };
    } catch (error) {
      const duration = Date.now() - start;
      logger.error('Trigger.dev health check failed', { error, duration });

      return {
        status: 'fail',
        message: 'Trigger.dev is unreachable',
        duration,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check memory usage
   */
  checkMemory(threshold: number = 90): CheckResult {
    const usage = process.memoryUsage();
    const heapUsedPercent = (usage.heapUsed / usage.heapTotal) * 100;

    if (heapUsedPercent >= threshold) {
      logger.warn('Memory usage warning', { heapUsedPercent, threshold });
      return {
        status: 'fail',
        message: `Heap usage is ${heapUsedPercent.toFixed(2)}% (threshold: ${threshold}%)`,
      };
    }

    return {
      status: 'pass',
      message: `Heap usage is ${heapUsedPercent.toFixed(2)}%`,
    };
  }

  /**
   * Perform comprehensive health check
   */
  async performHealthCheck(options: {
    pool?: Pool;
    redis?: Redis;
    triggerApiUrl?: string;
    memoryThreshold?: number;
  }): Promise<HealthCheckResult> {
    const checks: Record<string, CheckResult> = {};

    if (options.pool) {
      checks.database = await this.checkDatabase(options.pool);
    }

    if (options.redis) {
      checks.redis = await this.checkRedis(options.redis);
    }

    if (options.triggerApiUrl) {
      checks.triggerDev = await this.checkTriggerDev(options.triggerApiUrl);
    }

    checks.memory = this.checkMemory(options.memoryThreshold);

    const failedChecks = Object.values(checks).filter((check) => check.status === 'fail');
    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (failedChecks.length === 0) {
      status = 'healthy';
    } else if (failedChecks.length <= 1) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      checks,
      uptime: this.getUptime(),
      version: this.version,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Simple liveness check
   */
  livenessCheck(): { status: 'pass'; uptime: number } {
    return {
      status: 'pass',
      uptime: this.getUptime(),
    };
  }

  /**
   * Readiness check (critical services only)
   */
  async readinessCheck(options: {
    pool?: Pool;
    redis?: Redis;
  }): Promise<{ status: 'pass' | 'fail'; checks: Record<string, CheckResult> }> {
    const checks: Record<string, CheckResult> = {};

    if (options.pool) {
      checks.database = await this.checkDatabase(options.pool);
    }

    if (options.redis) {
      checks.redis = await this.checkRedis(options.redis);
    }

    const failedChecks = Object.values(checks).filter((check) => check.status === 'fail');
    const status = failedChecks.length === 0 ? 'pass' : 'fail';

    return { status, checks };
  }
}

export const healthChecker = new HealthChecker();

export default healthChecker;
