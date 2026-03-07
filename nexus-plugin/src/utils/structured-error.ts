/**
 * Structured Error — carries actionable error context from upstream services
 * all the way to the user's dashboard UI.
 *
 * Used by: ProseCreatorTaskHandler, SkillsEngineTaskHandler, task.service.ts
 */

import { AxiosError } from 'axios';

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'service_down'
  | 'timeout'
  | 'validation'
  | 'internal';

export interface StructuredError {
  code: string;
  message: string;
  category: ErrorCategory;
  service?: string;
  suggestion?: string;
  retryable: boolean;
  detail?: string;
  httpStatus?: number;
}

// ---------------------------------------------------------------------------
// Claude Code Proxy error type → classification
// ---------------------------------------------------------------------------

interface Classification {
  code: string;
  category: ErrorCategory;
  suggestion: string;
  retryable: boolean;
}

const PROXY_ERROR_MAP: Record<string, Classification> = {
  auth_error: {
    code: 'CLAUDE_PROXY_AUTH_EXPIRED',
    category: 'auth',
    suggestion:
      'Claude CLI session has expired. Re-authenticate the Claude Max proxy pod.',
    retryable: false,
  },
  rate_limit: {
    code: 'CLAUDE_PROXY_RATE_LIMITED',
    category: 'rate_limit',
    suggestion: 'Rate limit reached. The task will be retried automatically.',
    retryable: true,
  },
  service_overloaded: {
    code: 'CLAUDE_PROXY_OVERLOADED',
    category: 'service_down',
    suggestion: 'Claude API is overloaded. Try again in a few minutes.',
    retryable: true,
  },
  cli_error: {
    code: 'CLAUDE_PROXY_CLI_ERROR',
    category: 'internal',
    suggestion:
      'Claude CLI encountered an internal error. If this persists, re-authenticate the proxy.',
    retryable: true,
  },
};

// ---------------------------------------------------------------------------
// HTTP status → fallback classification
// ---------------------------------------------------------------------------

function classifyByStatus(status: number): Partial<Classification> {
  if (status === 401 || status === 403) {
    return {
      code: 'UPSTREAM_AUTH_ERROR',
      category: 'auth',
      suggestion: 'Authentication failed. Check API credentials or re-authenticate.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: 'UPSTREAM_RATE_LIMITED',
      category: 'rate_limit',
      suggestion: 'Rate limit reached. The task will be retried automatically.',
      retryable: true,
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      code: 'UPSTREAM_UNAVAILABLE',
      category: 'service_down',
      suggestion: 'Upstream service is unavailable. Try again shortly.',
      retryable: true,
    };
  }
  return {
    code: 'UPSTREAM_ERROR',
    category: 'internal',
    retryable: status >= 500,
  };
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

function classifyAxiosError(
  error: AxiosError,
  service: string,
): StructuredError {
  const status = error.response?.status;
  const body = error.response?.data as Record<string, any> | undefined;

  // Claude proxy returns { error: { type, message, code, detail } }
  const proxyError = body?.error;
  const proxyType: string | undefined =
    proxyError?.type || proxyError?.code;

  // Try proxy error type mapping first
  if (proxyType && PROXY_ERROR_MAP[proxyType]) {
    const cls = PROXY_ERROR_MAP[proxyType];
    return {
      code: cls.code,
      message: proxyError?.message || error.message,
      category: cls.category,
      service,
      suggestion: cls.suggestion,
      retryable: cls.retryable,
      detail: proxyError?.detail || undefined,
      httpStatus: status,
    };
  }

  // Fall back to HTTP status classification
  if (status) {
    const cls = classifyByStatus(status);
    return {
      code: cls.code || 'UPSTREAM_ERROR',
      message: proxyError?.message || body?.message || error.message,
      category: cls.category || 'internal',
      service,
      suggestion: cls.suggestion,
      retryable: cls.retryable ?? true,
      detail: proxyError?.detail || undefined,
      httpStatus: status,
    };
  }

  // Network-level errors (ECONNREFUSED, ENOTFOUND, ETIMEDOUT)
  const errCode = (error as any).code;
  if (errCode === 'ECONNABORTED' || errCode === 'ETIMEDOUT' || error.message?.includes('timeout')) {
    return {
      code: 'LLM_TIMEOUT',
      message: `Request to ${service} timed out.`,
      category: 'timeout',
      service,
      suggestion: 'The LLM request exceeded the time limit. Try again or use a simpler prompt.',
      retryable: true,
      detail: error.message,
    };
  }

  if (errCode === 'ECONNREFUSED' || errCode === 'ENOTFOUND') {
    return {
      code: 'CLAUDE_PROXY_UNREACHABLE',
      message: `Cannot reach ${service} — connection refused.`,
      category: 'service_down',
      service,
      suggestion: 'The Claude proxy pod appears to be offline. Check pod status.',
      retryable: true,
      detail: error.message,
    };
  }

  return {
    code: 'UPSTREAM_ERROR',
    message: error.message,
    category: 'internal',
    service,
    retryable: true,
    detail: error.message,
  };
}

function classifyGenericError(
  error: Error,
  service: string,
): StructuredError {
  const msg = error.message.toLowerCase();

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return {
      code: 'LLM_TIMEOUT',
      message: error.message,
      category: 'timeout',
      service,
      suggestion: 'The operation timed out. Try again or reduce the input size.',
      retryable: true,
    };
  }

  if (msg.includes('unauthorized') || msg.includes('auth') || msg.includes('expired')) {
    return {
      code: 'UPSTREAM_AUTH_ERROR',
      message: error.message,
      category: 'auth',
      service,
      suggestion: 'Authentication failed. Re-authenticate the relevant service.',
      retryable: false,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: error.message,
    category: 'internal',
    service,
    retryable: false,
    detail: error.stack?.split('\n').slice(0, 5).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function classifyError(
  error: unknown,
  service: string,
): StructuredError {
  if (error instanceof AxiosError) {
    return classifyAxiosError(error, service);
  }
  if (error instanceof Error) {
    // Check for a pre-attached structuredError (propagated from inner handler)
    const attached = (error as any).structuredError;
    if (attached && typeof attached === 'object' && attached.code) {
      return attached as StructuredError;
    }
    return classifyGenericError(error, service);
  }
  return {
    code: 'UNKNOWN_ERROR',
    message: typeof error === 'string' ? error : 'An unknown error occurred',
    category: 'internal',
    service,
    retryable: false,
  };
}
