/**
 * RLS Context Tests
 *
 * Validates that the org-scoped query methods on DatabaseService
 * correctly set the RLS context via SET LOCAL before executing queries.
 */

import { DatabaseService } from '../database.service';

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
  dbQueryDuration: { observe: jest.fn() },
  dbConnectionsActive: { set: jest.fn() },
  dbErrors: { inc: jest.fn() },
}));

// ── Mock pg Pool ──────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mockClient = {
  query: mockQuery,
  release: mockRelease,
};

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    end: jest.fn(),
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
  })),
}));

// ── Tests ─────────────────────────────────────────────────────────────

describe('DatabaseService org-scoped methods', () => {
  let db: DatabaseService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ id: 1, name: 'test' }], rowCount: 1 });

    db = new DatabaseService({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
      ssl: false,
      maxConnections: 5,
    });
  });

  describe('queryWithOrg', () => {
    it('sets RLS context before executing query', async () => {
      await db.queryWithOrg('org-abc', 'SELECT * FROM trigger.projects', []);

      const calls = mockQuery.mock.calls;

      // Should be: BEGIN, set_config, actual query, COMMIT
      expect(calls.length).toBe(4);
      expect(calls[0][0]).toBe('BEGIN');
      expect(calls[1][0]).toContain('set_config');
      expect(calls[1][1]).toEqual(['org-abc']);
      expect(calls[2][0]).toBe('SELECT * FROM trigger.projects');
      expect(calls[3][0]).toBe('COMMIT');
    });

    it('passes query params to the actual query', async () => {
      await db.queryWithOrg('org-abc', 'SELECT * FROM trigger.projects WHERE status = $1', [
        'active',
      ]);

      const actualQuery = mockQuery.mock.calls[2];
      expect(actualQuery[1]).toEqual(['active']);
    });

    it('rolls back and throws on query error', async () => {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config
        .mockRejectedValueOnce(new Error('table not found')) // actual query
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(db.queryWithOrg('org-abc', 'SELECT * FROM bad_table', [])).rejects.toThrow(
        'table not found'
      );

      // Verify ROLLBACK was called
      const rollbackCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0] === 'ROLLBACK'
      );
      expect(rollbackCall).toBeDefined();
    });

    it('releases client even on error', async () => {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config
        .mockRejectedValueOnce(new Error('fail'));

      await expect(db.queryWithOrg('org-abc', 'SELECT 1', [])).rejects.toThrow();
      expect(mockRelease).toHaveBeenCalled();
    });

    it('returns query result rows', async () => {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config
        .mockResolvedValueOnce({ rows: [{ id: 'p1' }, { id: 'p2' }], rowCount: 2 }) // query
        .mockResolvedValueOnce({}); // COMMIT

      const result = await db.queryWithOrg('org-abc', 'SELECT * FROM trigger.projects', []);
      expect(result.rows).toEqual([{ id: 'p1' }, { id: 'p2' }]);
      expect(result.rowCount).toBe(2);
    });
  });

  describe('queryOneWithOrg', () => {
    it('returns first row', async () => {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config
        .mockResolvedValueOnce({ rows: [{ id: 'first' }], rowCount: 1 })
        .mockResolvedValueOnce({}); // COMMIT

      const result = await db.queryOneWithOrg('org-abc', 'SELECT * FROM trigger.projects LIMIT 1');
      expect(result).toEqual({ id: 'first' });
    });

    it('returns null when no rows', async () => {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({}); // COMMIT

      const result = await db.queryOneWithOrg('org-abc', 'SELECT * FROM trigger.projects WHERE 1=0');
      expect(result).toBeNull();
    });
  });

  describe('queryManyWithOrg', () => {
    it('returns all rows', async () => {
      mockQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config
        .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], rowCount: 3 })
        .mockResolvedValueOnce({}); // COMMIT

      const result = await db.queryManyWithOrg('org-abc', 'SELECT * FROM trigger.projects');
      expect(result).toHaveLength(3);
    });
  });

  describe('transactionWithOrg', () => {
    it('sets RLS context before callback', async () => {
      mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

      await db.transactionWithOrg('org-xyz', async (client) => {
        await client.query('INSERT INTO trigger.projects (name) VALUES ($1)', ['test']);
        return true;
      });

      const calls = mockQuery.mock.calls;
      expect(calls[0][0]).toBe('BEGIN');
      expect(calls[1][0]).toContain('set_config');
      expect(calls[1][1]).toEqual(['org-xyz']);
      // callback query
      expect(calls[2][0]).toContain('INSERT INTO trigger.projects');
      expect(calls[3][0]).toBe('COMMIT');
    });

    it('rolls back on callback error', async () => {
      mockQuery.mockResolvedValue({});

      await expect(
        db.transactionWithOrg('org-xyz', async () => {
          throw new Error('callback failed');
        })
      ).rejects.toThrow('callback failed');

      const rollbackCall = mockQuery.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0] === 'ROLLBACK'
      );
      expect(rollbackCall).toBeDefined();
    });

    it('releases client after transaction', async () => {
      mockQuery.mockResolvedValue({});

      await db.transactionWithOrg('org-xyz', async () => 'done');
      expect(mockRelease).toHaveBeenCalled();
    });
  });
});

describe('DatabaseService base methods', () => {
  let db: DatabaseService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    db = new DatabaseService({
      host: 'localhost',
      port: 5432,
      database: 'test',
      user: 'test',
      password: 'test',
      ssl: false,
      maxConnections: 5,
    });
  });

  describe('namedQuery', () => {
    it('substitutes named params to positional', async () => {
      // The pool.query is called by the base query method
      const pool = (db as any).pool;
      pool.query = jest.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });

      await db.namedQuery('SELECT * FROM trigger.projects WHERE org = :orgId AND status = :status', {
        orgId: 'org-abc',
        status: 'active',
      });

      const call = pool.query.mock.calls[0];
      expect(call[0]).toBe('SELECT * FROM trigger.projects WHERE org = $1 AND status = $2');
      expect(call[1]).toEqual(['org-abc', 'active']);
    });

    it('reuses param index for repeated named params', async () => {
      const pool = (db as any).pool;
      pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

      await db.namedQuery('SELECT * FROM t WHERE a = :x OR b = :x', { x: 'val' });

      const call = pool.query.mock.calls[0];
      expect(call[0]).toBe('SELECT * FROM t WHERE a = $1 OR b = $1');
      expect(call[1]).toEqual(['val']);
    });
  });

  describe('getPoolStats', () => {
    it('returns pool statistics', () => {
      const stats = db.getPoolStats();
      expect(stats).toEqual({ total: 5, idle: 3, waiting: 0 });
    });
  });
});
