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
 * In-memory fallback limiters for when Redis is unavailable.
 * Lazily initialized on first Redis failure.
 */
let memoryFallback: TierLimiters | null = null;

function getMemoryFallback(): TierLimiters {
  if (!memoryFallback) {
    logger.warn('Initializing in-memory rate limiter fallback (Redis unavailable)');
    memoryFallback = createMemoryRateLimiter();
  }
  return memoryFallback;
}

/**
 * HTTP rate limiting middleware.
 * On Redis failure, falls back to in-memory limiter (fail-closed, not fail-open).
 */
export function rateLimiter(limiters: TierLimiters) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    const tier = user?.tier || 'open_source';
    const key = user?.organizationId || req.ip || req.socket.remoteAddress || 'unknown';
    const config = RATE_LIMITS[tier as keyof typeof RATE_LIMITS] || RATE_LIMITS.open_source;

    // Try primary limiters first, fall back to in-memory on error
    let activeLimiter = limiters[tier as keyof TierLimiters] || limiters.open_source;

    try {
      const rateLimitInfo = await activeLimiter.consume(key);

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

      next();
    } catch (rateLimitError: any) {
      // Check if this is a rate limit exceeded error (has msBeforeNext) vs a Redis error
      if (rateLimitError.msBeforeNext !== undefined) {
        // Rate limit exceeded
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
      } else {
        // Redis connection error — fall back to in-memory limiter (fail-closed)
        logger.error('Redis rate limiter failed, falling back to in-memory', {
          error: rateLimitError.message || rateLimitError,
        });

        try {
          const fallback = getMemoryFallback();
          activeLimiter = fallback[tier as keyof TierLimiters] || fallback.open_source;
          const fallbackInfo = await activeLimiter.consume(key);

          res.setHeader('X-RateLimit-Limit', config.points);
          res.setHeader('X-RateLimit-Remaining', fallbackInfo.remainingPoints);
          res.setHeader('X-RateLimit-Reset', new Date(Date.now() + fallbackInfo.msBeforeNext).toISOString());

          next();
        } catch (fallbackError: any) {
          if (fallbackError.msBeforeNext !== undefined) {
            const retryAfter = Math.ceil(fallbackError.msBeforeNext / 1000);
            res.setHeader('Retry-After', retryAfter);
            next(
              new RateLimitError('Rate limit exceeded. Please try again later.', {
                retryAfter,
                tier,
              })
            );
          } else {
            // Both Redis and memory failed — deny request (fail-closed)
            logger.error('All rate limiters failed, denying request', { error: fallbackError });
            next(new RateLimitError('Service temporarily unavailable', { retryAfter: 10, tier }));
          }
        }
      }
    }
  };
}

export default rateLimiter;
