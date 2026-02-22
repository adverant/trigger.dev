/**
 * Authentication Middleware
 *
 * Provides:
 * - JWT validation using NexusAuthClient
 * - Attach user to request object
 * - Optional authentication (allows unauthenticated)
 * - Tier-based authorization
 */

import { Request, Response, NextFunction } from 'express';
import { NexusAuthClient } from '../auth/nexus-auth-client';
import { createLogger } from '../utils/logger';
import { UnauthorizedError } from './error-handler';

const logger = createLogger({ component: 'auth-middleware' });

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        organizationId: string;
        tier: 'open_source' | 'teams' | 'government';
        email?: string;
        name?: string;
      };
      requestId?: string;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    return match[1];
  }

  return authHeader;
}

/**
 * Authentication middleware (required) - validates JWT and attaches req.user
 */
export function requireAuth(authClient: NexusAuthClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractToken(req);

      if (!token) {
        logger.warn('Missing authentication token', {
          path: req.path,
          method: req.method,
        });
        throw new UnauthorizedError('Authentication token required');
      }

      const user = await authClient.validateToken(token);

      if (!user) {
        logger.warn('Invalid authentication token', {
          path: req.path,
          method: req.method,
        });
        throw new UnauthorizedError('Invalid or expired token');
      }

      // Validate organizationId is a valid UUID (Postgres UUID column will reject non-UUIDs)
      let orgId = user.organizationId;
      if (!orgId || !UUID_REGEX.test(orgId)) {
        // Fallback: if orgId is not a valid UUID, try userId
        if (user.userId && UUID_REGEX.test(user.userId)) {
          logger.warn('organizationId is not a valid UUID, falling back to userId', {
            organizationId: orgId,
            userId: user.userId,
          });
          orgId = user.userId;
        } else {
          logger.error('Neither organizationId nor userId is a valid UUID', {
            organizationId: orgId,
            userId: user.userId,
          });
          throw new UnauthorizedError('Invalid organization context');
        }
      }

      req.user = {
        userId: user.userId,
        organizationId: orgId,
        tier: user.tier,
        email: user.email,
        name: user.name,
      };

      logger.debug('Authentication successful', {
        userId: user.userId,
        organizationId: orgId,
        tier: user.tier,
      });

      next();
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        next(error);
      } else {
        logger.error('Authentication error', { error });
        next(new UnauthorizedError('Authentication failed'));
      }
    }
  };
}

/**
 * Optional authentication middleware - allows unauthenticated requests
 */
export function optionalAuth(authClient: NexusAuthClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractToken(req);

      if (!token) {
        next();
        return;
      }

      const user = await authClient.validateToken(token);

      if (user) {
        req.user = {
          userId: user.userId,
          organizationId: user.organizationId,
          tier: user.tier,
          email: user.email,
          name: user.name,
        };

        logger.debug('Optional authentication successful', {
          userId: user.userId,
          organizationId: user.organizationId,
        });
      } else {
        logger.debug('Optional authentication failed - invalid token', {
          path: req.path,
        });
      }

      next();
    } catch (error) {
      logger.warn('Optional authentication error', { error });
      next();
    }
  };
}

/**
 * Tier-based authorization middleware - requires specific tier level
 */
export function requireTier(...allowedTiers: Array<'open_source' | 'teams' | 'government'>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!allowedTiers.includes(req.user.tier)) {
      logger.warn('Insufficient tier for access', {
        userId: req.user.userId,
        userTier: req.user.tier,
        requiredTiers: allowedTiers,
        path: req.path,
      });

      next(
        new UnauthorizedError('Insufficient permissions', {
          userTier: req.user.tier,
          requiredTiers: allowedTiers,
        })
      );
      return;
    }

    logger.debug('Tier authorization successful', {
      userId: req.user.userId,
      tier: req.user.tier,
    });

    next();
  };
}

/**
 * API key authentication middleware (alternative to JWT)
 */
export function apiKeyAuth(authClient: NexusAuthClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const apiKey = req.headers['x-api-key'] as string;

      if (!apiKey) {
        logger.warn('Missing API key', {
          path: req.path,
          method: req.method,
        });
        throw new UnauthorizedError('API key required');
      }

      const user = await authClient.validateApiKey(apiKey);

      if (!user) {
        logger.warn('Invalid API key', {
          path: req.path,
          method: req.method,
        });
        throw new UnauthorizedError('Invalid API key');
      }

      req.user = {
        userId: user.userId,
        organizationId: user.organizationId,
        tier: user.tier,
        email: user.email,
        name: user.name,
      };

      logger.debug('API key authentication successful', {
        userId: user.userId,
        organizationId: user.organizationId,
      });

      next();
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        next(error);
      } else {
        logger.error('API key authentication error', { error });
        next(new UnauthorizedError('Authentication failed'));
      }
    }
  };
}

export default requireAuth;
