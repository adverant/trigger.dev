/**
 * HTTP Request Logging Middleware
 *
 * Provides:
 * - UUID requestId generation and attachment to response headers
 * - Sanitize sensitive fields (passwords, tokens, keys)
 * - Log request timing and response codes
 * - Prometheus metrics for request duration and totals
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import { httpRequestDuration, httpRequestTotal } from '../utils/metrics';

const logger = createLogger({ component: 'request-logger' });

const SENSITIVE_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /authorization/i,
  /api[-_]?key/i,
  /credit[-_]?card/i,
  /ssn/i,
  /bearer/i,
];

/**
 * Sanitize object to remove sensitive fields
 */
function sanitize(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitize);
  }

  const sanitized: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));

    if (isSensitive) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitize(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Get client IP address from headers or socket
 */
function getClientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
    (req.headers['x-real-ip'] as string) ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

/**
 * Request logging middleware.
 * Generates a UUID requestId, logs request/response, and records Prometheus metrics.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = uuidv4();
  (req as any).requestId = requestId;

  // Attach requestId to response headers for tracing
  res.setHeader('X-Request-ID', requestId);

  const startTime = Date.now();
  const method = req.method;
  const url = req.url;
  const userAgent = req.headers['user-agent'] || 'unknown';
  const clientIp = getClientIp(req);

  const reqLogger = logger.child({
    requestId,
    method,
    url,
    clientIp,
  });

  reqLogger.info('Incoming request', {
    userAgent,
    query: sanitize(req.query),
    body: req.body ? sanitize(req.body) : undefined,
  });

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    const route = req.route?.path || req.path;

    const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
    reqLogger.log(logLevel, 'Request completed', {
      statusCode,
      duration,
      responseSize: res.get('content-length') || 0,
    });

    httpRequestTotal.inc({
      method,
      route,
      status_code: statusCode.toString(),
    });

    httpRequestDuration.observe(
      {
        method,
        route,
        status_code: statusCode.toString(),
      },
      duration / 1000
    );
  });

  res.on('error', (error) => {
    const duration = Date.now() - startTime;
    reqLogger.error('Request error', {
      error,
      duration,
    });
  });

  next();
}

export default requestLogger;
