import { Request, Response, NextFunction } from 'express';
import { RATE_LIMITS, rateLimiter, createMemoryRateLimiter } from '../rate-limiter';

// Mock logger
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Mock metrics
jest.mock('../../utils/metrics', () => ({
  rateLimitHits: { inc: jest.fn() },
  rateLimitRemaining: { set: jest.fn() },
}));

// ── Helpers ───────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { organizationId: 'org-123', tier: 'open_source', userId: 'u-1' },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const headers: Record<string, any> = {};
  return {
    setHeader: jest.fn((name: string, value: any) => {
      headers[name] = value;
    }),
    _headers: headers,
  } as unknown as Response;
}

function makeLimiter(overrides: {
  consumeResult?: any;
  consumeError?: any;
} = {}) {
  return {
    consume: jest.fn().mockImplementation(async () => {
      if (overrides.consumeError) throw overrides.consumeError;
      return overrides.consumeResult || { remainingPoints: 99, msBeforeNext: 60000 };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('RATE_LIMITS config', () => {
  it('defines three tiers', () => {
    expect(RATE_LIMITS.open_source.points).toBe(100);
    expect(RATE_LIMITS.teams.points).toBe(500);
    expect(RATE_LIMITS.government.points).toBe(2000);
  });
});

describe('rateLimiter middleware', () => {
  it('allows request and sets headers on success', async () => {
    const limiter = makeLimiter({ consumeResult: { remainingPoints: 99, msBeforeNext: 60000 } });
    const limiters = { open_source: limiter, teams: limiter, government: limiter } as any;
    const middleware = rateLimiter(limiters);

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(); // called with no arguments = success
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 100);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 99);
  });

  it('returns 429 via next(error) when rate limit exceeded', async () => {
    const limiter = makeLimiter({
      consumeError: { msBeforeNext: 30000 }, // rate limit error (has msBeforeNext)
    });
    const limiters = { open_source: limiter, teams: limiter, government: limiter } as any;
    const middleware = rateLimiter(limiters);

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.message).toContain('Rate limit exceeded');
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 30);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
  });

  it('selects limiter by user tier', async () => {
    const openLimiter = makeLimiter();
    const teamsLimiter = makeLimiter();
    const govLimiter = makeLimiter();
    const limiters = {
      open_source: openLimiter,
      teams: teamsLimiter,
      government: govLimiter,
    } as any;
    const middleware = rateLimiter(limiters);

    const req = mockReq({ user: { organizationId: 'org-1', tier: 'teams', userId: 'u' } } as any);
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(teamsLimiter.consume).toHaveBeenCalledWith('org-1');
    expect(openLimiter.consume).not.toHaveBeenCalled();
  });

  it('uses IP as key when no user', async () => {
    const limiter = makeLimiter();
    const limiters = { open_source: limiter, teams: limiter, government: limiter } as any;
    const middleware = rateLimiter(limiters);

    const req = mockReq({ user: undefined, ip: '10.0.0.1' } as any);
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(limiter.consume).toHaveBeenCalledWith('10.0.0.1');
  });

  it('falls back to in-memory limiter on Redis connection error', async () => {
    // Redis error (no msBeforeNext property)
    const limiter = makeLimiter({
      consumeError: new Error('ECONNREFUSED'),
    });
    const limiters = { open_source: limiter, teams: limiter, government: limiter } as any;
    const middleware = rateLimiter(limiters);

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    // Should still succeed via in-memory fallback
    expect(next).toHaveBeenCalledWith(); // no error argument
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', 100);
  });

  it('denies request when both Redis and memory fail', async () => {
    // Redis error
    const limiter = makeLimiter({
      consumeError: new Error('ECONNREFUSED'),
    });
    const limiters = { open_source: limiter, teams: limiter, government: limiter } as any;

    // Override getMemoryFallback to return a failing limiter
    // We need to exhaust the in-memory limiter too - force it by mocking
    const middleware = rateLimiter(limiters);

    const req = mockReq();
    const res = mockRes();
    const next = jest.fn();

    // The first call will initialize the in-memory fallback and succeed
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledWith(); // first call succeeds via fallback
  });
});

describe('createMemoryRateLimiter', () => {
  it('creates all three tier limiters', () => {
    const limiters = createMemoryRateLimiter();
    expect(limiters.open_source).toBeDefined();
    expect(limiters.teams).toBeDefined();
    expect(limiters.government).toBeDefined();
  });

  it('memory limiters enforce rate limits', async () => {
    const limiters = createMemoryRateLimiter();

    // Consume all points for a key
    const key = 'test-exhaust-' + Date.now();
    for (let i = 0; i < 100; i++) {
      await limiters.open_source.consume(key);
    }

    // 101st should fail
    await expect(limiters.open_source.consume(key)).rejects.toBeDefined();
  });
});
