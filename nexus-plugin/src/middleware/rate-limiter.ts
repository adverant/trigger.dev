/**
 * Tiered Rate Limiting Middleware
 *
 * Provides:
 * - Rate limiting using rate-limiter-flexible with Redis
 * - Tier-based limits: open_source 100/min, teams 500/min, government 2000/min
 * - Response headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 * - Block excessive requests with 429 and Retry-After
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger';
import { rateLimitHits, rateLimitRemaining } from '../utils/metrics';
import { RateLimitError } from './error-handler';

const logger = createLogger({ component: 'rate-limiter' });

export const RATE_LIMITS = {
  open_source: {
    points: 100,
    duration: 60,
    blockDuration: 60,
  },
  teams: {
    points: 500,
    duration: 60,
    blockDuration: 60,
  },
  government: {
    points: 2000,
    duration: 60,
    blockDuration: 30,
  },
};

/**
 * Create a Redis-backed rate limiter for a given tier
 */
export function createRateLimiter(redis: Redis): {
  open_source: RateLimiterRedis;
  teams: RateLimiterRedis;
  government: RateLimiterRedis;
} {
  return {
    open_source: new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: 'trigger:rate_limit:open_source',
      points: RATE_LIMITS.open_source.points,
      duration: RATE_LIMITS.open_source.duration,
      blockDuration: RATE_LIMITS.open_source.blockDuration,
    }),
    teams: new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: 'trigger:rate_limit:teams',
      points: RATE_LIMITS.teams.points,
      duration: RATE_LIMITS.teams.duration,
      blockDuration: RATE_LIMITS.teams.blockDuration,
    }),
    government: new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: 'trigger:rate_limit:government',
      points: RATE_LIMITS.government.points,
      duration: RATE_LIMITS.government.duration,
      blockDuration: RATE_LIMITS.government.blockDuration,
    }),
  };
}

/**
 * Create in-memory rate limiters (fallback when Redis unavailable)
 */
export function createMemoryRateLimiter(): {
  open_source: RateLimiterMemory;
  teams: RateLimiterMemory;
  government: RateLimiterMemory;
} {
  return {
    open_source: new RateLimiterMemory({
      keyPrefix: 'trigger:rate_limit:open_source',
      points: RATE_LIMITS.open_source.points,
      duration: RATE_LIMITS.open_source.duration,
      blockDuration: RATE_LIMITS.open_source.blockDuration,
    }),
    teams: new RateLimiterMemory({
      keyPrefix: 'trigger:rate_limit:teams',
      points: RATE_LIMITS.teams.points,
      duration: RATE_LIMITS.teams.duration,
      blockDuration: RATE_LIMITS.teams.blockDuration,
    }),
    government: new RateLimiterMemory({
      keyPrefix: 'trigger:rate_limit:government',
      points: RATE_LIMITS.government.points,
      duration: RATE_LIMITS.government.duration,
      blockDuration: RATE_LIMITS.government.blockDuration,
    }),
  };
}

type TierLimiters = {
  open_source: RateLimiterRedis | RateLimiterMemory;
  teams: RateLimiterRedis | RateLimiterMemory;
  government: RateLimiterRedis | RateLimiterMemory;
};

/**
 * HTTP rate limiting middleware
 */
export function rateLimiter(limiters: TierLimiters) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = req.user;
      const tier = user?.tier || 'open_source';
      const key = user?.organizationId || req.ip || req.socket.remoteAddress || 'unknown';
      const limiter = limiters[tier as keyof TierLimiters] || limiters.open_source;
      const config = RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.open_source;

      try {
        const rateLimitInfo = await limiter.consume(key);

        res.setHeader('X-RateLimit-Limit', config.points);
        res.setHeader('X-RateLimit-Remaining', rateLimitInfo.remainingPoints);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimitInfo.msBeforeNext).toISOString());

        rateLimitRemaining.set(
          {
            organization_id: user?.organizationId || 'anonymous',
            tier,
            limit_type: 'http',
          },
          rateLimitInfo.remainingPoints
        );

        logger.debug('Rate limit check passed', {
          organizationId: user?.organizationId,
          tier,
          remaining: rateLimitInfo.remainingPoints,
        });

        next();
      } catch (rateLimitError: any) {
        const retryAfter = Math.ceil(rateLimitError.msBeforeNext / 1000);

        logger.warn('Rate limit exceeded', {
          organizationId: user?.organizationId || 'anonymous',
          tier,
          retryAfter,
        });

        rateLimitHits.inc({
          organization_id: user?.organizationId || 'anonymous',
          tier,
          limit_type: 'http',
        });

        res.setHeader('Retry-After', retryAfter);
        res.setHeader('X-RateLimit-Limit', config.points);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rateLimitError.msBeforeNext).toISOString());

        next(
          new RateLimitError('Rate limit exceeded. Please try again later.', {
            retryAfter,
            tier,
          })
        );
      }
    } catch (error) {
      logger.error('Rate limiter error', { error });
      next();
    }
  };
}

export default rateLimiter;
