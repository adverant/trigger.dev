/**
 * Quota Enforcement Middleware
 *
 * Provides:
 * - Tier-based quota enforcement via Redis
 * - Quota types: concurrent_runs, schedules, tasks_per_minute
 * - Tier limits: open_source (5/10/10), teams (50/100/100), government (unlimited)
 * - checkQuota and incrementUsage methods
 * - Middleware factory for Express routes
 */

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger';
import { quotaUsage, quotaLimit, quotaExceeded } from '../utils/metrics';
import { ForbiddenError } from './error-handler';

const logger = createLogger({ component: 'quota-enforcer' });

export type QuotaType = 'concurrent_runs' | 'schedules' | 'tasks_per_minute';

export const QUOTA_LIMITS: Record<string, Record<QuotaType, number>> = {
  open_source: {
    concurrent_runs: 5,
    schedules: 10,
    tasks_per_minute: 10,
  },
  teams: {
    concurrent_runs: 50,
    schedules: 100,
    tasks_per_minute: 100,
  },
  government: {
    concurrent_runs: -1, // unlimited
    schedules: -1,
    tasks_per_minute: -1,
  },
};

export class QuotaEnforcer {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Get Redis key for a specific quota
   */
  private getQuotaKey(orgId: string, quotaType: QuotaType): string {
    if (quotaType === 'tasks_per_minute') {
      const now = new Date();
      const minute = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}T${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
      return `trigger:quota:${orgId}:${quotaType}:${minute}`;
    }
    return `trigger:quota:${orgId}:${quotaType}`;
  }

  /**
   * Get the quota limit for a tier and quota type.
   * Returns -1 for unlimited.
   */
  getLimit(tier: string, quotaType: QuotaType): number {
    const tierConfig = QUOTA_LIMITS[tier] || QUOTA_LIMITS.open_source;
    return tierConfig[quotaType];
  }

  /**
   * Check if quota is available for the requested operation
   */
  async checkQuota(
    orgId: string,
    tier: string,
    quotaType: QuotaType,
    amount: number = 1
  ): Promise<{ available: boolean; usage: number; limit: number }> {
    const limit = this.getLimit(tier, quotaType);

    // Unlimited
    if (limit === -1) {
      return { available: true, usage: 0, limit: -1 };
    }

    try {
      const key = this.getQuotaKey(orgId, quotaType);
      const usageStr = await this.redis.get(key);
      const usage = usageStr ? parseInt(usageStr, 10) : 0;
      const available = usage + amount <= limit;

      if (!available) {
        logger.warn('Quota exceeded', {
          orgId,
          tier,
          quotaType,
          usage,
          limit,
          requested: amount,
        });

        quotaExceeded.inc({
          organization_id: orgId,
          tier,
          quota_type: quotaType,
        });
      }

      quotaUsage.set({ organization_id: orgId, tier, quota_type: quotaType }, usage);
      quotaLimit.set({ organization_id: orgId, tier, quota_type: quotaType }, limit);

      return { available, usage, limit };
    } catch (error) {
      logger.error('Failed to check quota', { error, orgId, quotaType });
      // Fail open - don't block on Redis errors
      return { available: true, usage: 0, limit };
    }
  }

  /**
   * Increment usage counter for a quota type
   */
  async incrementUsage(
    orgId: string,
    quotaType: QuotaType,
    amount: number = 1
  ): Promise<number> {
    try {
      const key = this.getQuotaKey(orgId, quotaType);
      const newUsage = await this.redis.incrby(key, amount);

      // Set TTL for time-windowed quotas
      if (quotaType === 'tasks_per_minute') {
        await this.redis.expire(key, 120); // 2 minutes (covers the window plus buffer)
      }

      return newUsage;
    } catch (error) {
      logger.error('Failed to increment quota usage', { error, orgId, quotaType });
      throw error;
    }
  }

  /**
   * Decrement usage counter (for releasing resources like concurrent runs)
   */
  async decrementUsage(
    orgId: string,
    quotaType: QuotaType,
    amount: number = 1
  ): Promise<number> {
    try {
      const key = this.getQuotaKey(orgId, quotaType);
      const newUsage = await this.redis.decrby(key, amount);

      if (newUsage < 0) {
        await this.redis.set(key, '0');
        return 0;
      }

      return newUsage;
    } catch (error) {
      logger.error('Failed to decrement quota usage', { error, orgId, quotaType });
      throw error;
    }
  }

  /**
   * Get current usage for a quota type
   */
  async getUsage(orgId: string, quotaType: QuotaType): Promise<number> {
    try {
      const key = this.getQuotaKey(orgId, quotaType);
      const usage = await this.redis.get(key);
      return usage ? parseInt(usage, 10) : 0;
    } catch (error) {
      logger.error('Failed to get quota usage', { error, orgId, quotaType });
      return 0;
    }
  }

  /**
   * Reset quota (admin function)
   */
  async resetQuota(orgId: string, quotaType: QuotaType): Promise<void> {
    try {
      const key = this.getQuotaKey(orgId, quotaType);
      await this.redis.del(key);
      logger.info('Quota reset', { orgId, quotaType });
    } catch (error) {
      logger.error('Failed to reset quota', { error, orgId, quotaType });
      throw error;
    }
  }
}

/**
 * Quota enforcement middleware factory.
 * Checks quota before allowing the request through.
 */
export function quotaEnforcerMiddleware(enforcer: QuotaEnforcer, quotaType: QuotaType, amount: number = 1) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user;
      if (!user) {
        next();
        return;
      }

      const { organizationId, tier } = user;
      const { available, usage, limit } = await enforcer.checkQuota(organizationId, tier, quotaType, amount);

      if (!available) {
        logger.warn('Request blocked due to quota exceeded', {
          organizationId,
          tier,
          quotaType,
          usage,
          limit,
          path: req.path,
        });

        throw new ForbiddenError(`Quota exceeded for ${quotaType}`, {
          quotaType,
          usage,
          limit,
          tier,
        });
      }

      logger.debug('Quota check passed', {
        organizationId,
        tier,
        quotaType,
        usage,
        limit,
      });

      next();
    } catch (error) {
      if (error instanceof ForbiddenError) {
        next(error);
      } else {
        logger.error('Quota enforcement error', { error });
        next();
      }
    }
  };
}

export default QuotaEnforcer;
