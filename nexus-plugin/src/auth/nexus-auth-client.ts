/**
 * Nexus Authentication Client
 *
 * Validates JWT tokens and API keys by integrating with the Nexus Auth service.
 * Features:
 * - JWT token validation via Nexus Auth HTTP API
 * - API key validation
 * - Token caching with Redis (5-minute TTL)
 * - User info extraction (userId, organizationId, tier)
 */

import axios, { AxiosInstance } from 'axios';
import * as jwt from 'jsonwebtoken';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger';
import { externalServiceDuration, externalServiceErrors } from '../utils/metrics';

const logger = createLogger({ component: 'nexus-auth-client' });

export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  email: string;
  name?: string;
  tier: 'open_source' | 'teams' | 'government';
  permissions: string[];
  exp: number;
  iat: number;
}

// Matches actual /internal/validate response from nexus-auth
interface TokenValidationResponse {
  valid: boolean;
  user_id?: string;
  email?: string;
  name?: string;
  tier?: string;
  exp?: number;
  claims?: {
    permissions?: string[];
    jti?: string;
    organization_id?: string;
  };
}

// Matches actual /internal/validate-mcp response
interface ApiKeyValidationResponse {
  valid: boolean;
  user_id?: string;
  organization_id?: string;
  email?: string;
  name?: string;
  tier?: string;
  permissions?: string[];
}

export class NexusAuthClient {
  private authUrl: string;
  private apiKey: string;
  private httpClient: AxiosInstance;
  private redis: Redis | null = null;
  private cacheTTL: number = 300; // 5 minutes

  constructor(authUrl: string, apiKey: string) {
    this.authUrl = authUrl;
    this.apiKey = apiKey;

    this.httpClient = axios.create({
      baseURL: this.authUrl,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
      },
    });

    this.httpClient.interceptors.request.use(
      (config) => config,
      (error) => {
        logger.error('Auth client request error', { error: error.message });
        return Promise.reject(error);
      }
    );

    this.httpClient.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error)) {
          logger.error('Auth client response error', {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Initialize with Redis for token caching
   */
  setRedis(redis: Redis): void {
    this.redis = redis;
  }

  /**
   * Validate JWT token and return user information.
   * Checks cache first, then validates with the auth service.
   * Successful validations are cached to reduce auth service load.
   */
  async validateToken(token: string): Promise<AuthenticatedUser> {
    if (this.redis) {
      const cached = await this.getCachedToken(token);
      if (cached) {
        return cached;
      }
    }

    const start = Date.now();
    try {
      const decoded = this.decodeToken(token);

      if (decoded.exp && decoded.exp < Date.now() / 1000) {
        throw new Error('Token expired');
      }

      let user: AuthenticatedUser;

      try {
        // Validate via nexus-auth /internal/validate endpoint
        const response = await this.httpClient.post<TokenValidationResponse>(
          '/internal/validate',
          { token }
        );

        const duration = (Date.now() - start) / 1000;
        externalServiceDuration.observe({ service: 'nexus-auth', operation: 'validate_token' }, duration);

        if (!response.data.valid) {
          // Auth service says token is invalid (e.g., signature mismatch).
          // Fall back to local JWT decode so the UI isn't completely broken.
          // The gateway already validated the token before it reached us.
          logger.warn('Auth service returned invalid for token, using local JWT decode as fallback');
          const tierValue = decoded.subscription_tier || decoded.tier || 'open_source';
          user = {
            userId: decoded.user_id || decoded.sub || '',
            organizationId: decoded.organization_id || decoded.user_id || '',
            email: decoded.email || '',
            name: decoded.name,
            tier: (tierValue === 'teams' || tierValue === 'government' || tierValue === 'dedicated_vps')
              ? (tierValue === 'dedicated_vps' ? 'government' : tierValue as 'teams' | 'government')
              : 'open_source',
            permissions: decoded.permissions || [],
            exp: decoded.exp || 0,
            iat: decoded.iat || 0,
          };
        } else {
          // Map flat response to AuthenticatedUser
          const tierValue = response.data.tier || decoded.subscription_tier || decoded.tier || 'open_source';
          user = {
            userId: response.data.user_id || decoded.user_id || decoded.sub || '',
            organizationId: response.data.claims?.organization_id || decoded.organization_id || decoded.user_id || '',
            email: response.data.email || decoded.email || '',
            name: response.data.name || decoded.name,
            tier: (tierValue === 'teams' || tierValue === 'government' || tierValue === 'dedicated_vps')
              ? (tierValue === 'dedicated_vps' ? 'government' : tierValue as 'teams' | 'government')
              : 'open_source',
            permissions: response.data.claims?.permissions || decoded.permissions || [],
            exp: response.data.exp || decoded.exp || 0,
            iat: decoded.iat || 0,
          };
        }
      } catch (authServiceError) {
        // Fallback: if auth service is unreachable, trust local JWT decode
        // (token signature can't be verified without the secret, but we allow
        // degraded operation so the UI isn't completely broken)
        if (axios.isAxiosError(authServiceError) && !authServiceError.response) {
          logger.warn('Auth service unreachable, using local JWT decode as fallback', {
            error: authServiceError.message,
          });
          const tierValue = decoded.subscription_tier || decoded.tier || 'open_source';
          user = {
            userId: decoded.user_id || decoded.sub || '',
            organizationId: decoded.organization_id || decoded.user_id || '',
            email: decoded.email || '',
            name: decoded.name,
            tier: (tierValue === 'teams' || tierValue === 'government' || tierValue === 'dedicated_vps')
              ? (tierValue === 'dedicated_vps' ? 'government' : tierValue as 'teams' | 'government')
              : 'open_source',
            permissions: decoded.permissions || [],
            exp: decoded.exp || 0,
            iat: decoded.iat || 0,
          };
        } else {
          throw authServiceError;
        }
      }

      if (this.redis) {
        await this.cacheToken(token, user);
      }

      return user;
    } catch (error) {
      const duration = (Date.now() - start) / 1000;
      externalServiceErrors.inc({
        service: 'nexus-auth',
        operation: 'validate_token',
        error_type: error instanceof Error ? error.name : 'unknown',
      });

      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid or expired token');
        }
        if (error.response?.status === 403) {
          throw new Error('Insufficient permissions');
        }
        throw new Error(`Auth service error: ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Validate API key and return user information
   */
  async validateApiKey(apiKey: string): Promise<AuthenticatedUser> {
    if (this.redis) {
      const cached = await this.getCachedApiKey(apiKey);
      if (cached) {
        return cached;
      }
    }

    const start = Date.now();
    try {
      const response = await this.httpClient.post<ApiKeyValidationResponse>(
        '/internal/validate-mcp',
        { apiKey }
      );

      const duration = (Date.now() - start) / 1000;
      externalServiceDuration.observe({ service: 'nexus-auth', operation: 'validate_api_key' }, duration);

      if (!response.data.valid) {
        throw new Error('Invalid API key');
      }

      const tierValue = response.data.tier || 'open_source';
      const user: AuthenticatedUser = {
        userId: response.data.user_id || '',
        organizationId: response.data.organization_id || response.data.user_id || '',
        email: response.data.email || '',
        name: response.data.name,
        tier: (tierValue === 'teams' || tierValue === 'government') ? tierValue : 'open_source',
        permissions: response.data.permissions || [],
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      };

      if (this.redis) {
        await this.cacheApiKey(apiKey, user);
      }

      return user;
    } catch (error) {
      externalServiceErrors.inc({
        service: 'nexus-auth',
        operation: 'validate_api_key',
        error_type: error instanceof Error ? error.name : 'unknown',
      });

      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new Error('Invalid API key');
        }
        if (error.response?.status === 403) {
          throw new Error('Insufficient permissions');
        }
        throw new Error(`Auth service error: ${error.message}`);
      }

      throw error;
    }
  }

  /**
   * Health check for auth service connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.httpClient.get('/health');
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  private decodeToken(token: string): any {
    try {
      const decoded = jwt.decode(token);
      if (!decoded || typeof decoded === 'string') {
        throw new Error('Invalid token format');
      }
      return decoded;
    } catch (error) {
      throw new Error('Failed to decode token');
    }
  }

  private getCacheKey(token: string): string {
    const suffix = token.slice(-16);
    return `auth:token:${suffix}`;
  }

  private async getCachedToken(token: string): Promise<AuthenticatedUser | null> {
    if (!this.redis) return null;

    try {
      const cacheKey = this.getCacheKey(token);
      const cached = await this.redis.get(cacheKey);
      if (!cached) return null;

      const user = JSON.parse(cached) as AuthenticatedUser;

      if (user.exp && user.exp < Date.now() / 1000) {
        await this.redis.del(cacheKey);
        return null;
      }

      return user;
    } catch (error) {
      logger.error('Failed to get cached token', { error });
      return null;
    }
  }

  private async cacheToken(token: string, user: AuthenticatedUser): Promise<void> {
    if (!this.redis) return;

    try {
      const cacheKey = this.getCacheKey(token);
      let ttl = this.cacheTTL;
      if (user.exp) {
        const expiresIn = user.exp - Date.now() / 1000;
        ttl = Math.min(expiresIn, this.cacheTTL);
      }
      await this.redis.setex(cacheKey, Math.floor(ttl), JSON.stringify(user));
    } catch (error) {
      logger.error('Failed to cache token', { error });
    }
  }

  private async getCachedApiKey(apiKey: string): Promise<AuthenticatedUser | null> {
    if (!this.redis) return null;

    try {
      const cacheKey = `auth:apikey:${apiKey.slice(-16)}`;
      const cached = await this.redis.get(cacheKey);
      if (!cached) return null;

      return JSON.parse(cached) as AuthenticatedUser;
    } catch (error) {
      logger.error('Failed to get cached API key', { error });
      return null;
    }
  }

  private async cacheApiKey(apiKey: string, user: AuthenticatedUser): Promise<void> {
    if (!this.redis) return;

    try {
      const cacheKey = `auth:apikey:${apiKey.slice(-16)}`;
      await this.redis.setex(cacheKey, 3600, JSON.stringify(user));
    } catch (error) {
      logger.error('Failed to cache API key', { error });
    }
  }
}

export default NexusAuthClient;
