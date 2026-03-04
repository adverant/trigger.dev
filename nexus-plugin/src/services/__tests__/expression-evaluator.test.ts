import {
  interpolateTemplate,
  evaluateCondition,
  evaluateTransform,
} from '../expression-evaluator';

// ── interpolateTemplate ───────────────────────────────────────────────

describe('interpolateTemplate', () => {
  it('replaces simple paths', () => {
    expect(interpolateTemplate('Hello {{name}}', { name: 'Alice' })).toBe('Hello Alice');
  });

  it('resolves nested dot paths', () => {
    const ctx = { input: { user: { name: 'Bob' } } };
    expect(interpolateTemplate('Hi {{input.user.name}}', ctx)).toBe('Hi Bob');
  });

  it('returns empty string for undefined paths', () => {
    expect(interpolateTemplate('{{missing.path}}', {})).toBe('');
  });

  it('returns empty string for null values', () => {
    expect(interpolateTemplate('{{val}}', { val: null })).toBe('');
  });

  it('stringifies object values', () => {
    expect(interpolateTemplate('{{data}}', { data: { a: 1 } })).toBe('{"a":1}');
  });

  it('converts numbers to string', () => {
    expect(interpolateTemplate('Count: {{n}}', { n: 42 })).toBe('Count: 42');
  });

  it('handles multiple placeholders', () => {
    expect(interpolateTemplate('{{a}} + {{b}}', { a: '1', b: '2' })).toBe('1 + 2');
  });

  it('returns original text when no placeholders', () => {
    expect(interpolateTemplate('hello world', {})).toBe('hello world');
  });
});

// ── evaluateCondition ─────────────────────────────────────────────────

describe('evaluateCondition', () => {
  it('evaluates simple comparison', () => {
    expect(evaluateCondition("input.status === 'approved'", { status: 'approved' })).toBe(true);
    expect(evaluateCondition("input.status === 'approved'", { status: 'pending' })).toBe(false);
  });

  it('evaluates numeric comparison', () => {
    expect(evaluateCondition('input.score > 0.8', { score: 0.9 })).toBe(true);
    expect(evaluateCondition('input.score > 0.8', { score: 0.5 })).toBe(false);
  });

  it('evaluates compound conditions', () => {
    expect(
      evaluateCondition("input.count > 0 && input.type === 'order'", { count: 5, type: 'order' })
    ).toBe(true);
  });

  it('defaults to true for empty expression', () => {
    expect(evaluateCondition('', { anything: true })).toBe(true);
    expect(evaluateCondition('   ', { anything: true })).toBe(true);
  });

  it('coerces truthy values to boolean', () => {
    expect(evaluateCondition('input.val', { val: 'non-empty' })).toBe(true);
    expect(evaluateCondition('input.val', { val: 0 })).toBe(false);
  });

  it('throws on syntax error', () => {
    expect(() => evaluateCondition('input.+++', { val: 1 })).toThrow('Condition evaluation failed');
  });

  // ── Security tests ────────────────────────────────────────────────

  it('blocks constructor token in expression', () => {
    expect(() =>
      evaluateCondition("input.constructor.constructor('return process')()", { x: 1 })
    ).toThrow(/Blocked token "constructor"/);
  });

  it('blocks process token', () => {
    expect(() => evaluateCondition('process.exit(1)', {})).toThrow(/Blocked token "process"/);
  });

  it('blocks require token', () => {
    expect(() => evaluateCondition("require('fs')", {})).toThrow(/Blocked token "require"/);
  });

  it('blocks globalThis token', () => {
    expect(() => evaluateCondition('globalThis.process', {})).toThrow(/Blocked token "globalThis"/);
  });

  it('blocks Function constructor directly', () => {
    expect(() => evaluateCondition("Function('return 1')()", {})).toThrow(/Blocked token "Function"/);
  });

  it('blocks eval', () => {
    expect(() => evaluateCondition("eval('1+1')", {})).toThrow(/Blocked token "eval"/);
  });

  it('blocks __proto__', () => {
    expect(() => evaluateCondition('input.__proto__', { x: 1 })).toThrow(/Blocked token "__proto__"/);
  });

  it('times out on CPU-bound expression', () => {
    // Use a for-expression (not statement) that runs long
    expect(() =>
      evaluateCondition('(function(){var i=0;while(i<1e12)i++;return true;})()', {})
    ).toThrow(/timed out/i);
  }, 15000);
});

// ── evaluateTransform ─────────────────────────────────────────────────

describe('evaluateTransform', () => {
  describe('template type', () => {
    it('interpolates template string', () => {
      expect(evaluateTransform('template', 'Hello {{input.name}}', { name: 'World' })).toBe(
        'Hello World'
      );
    });
  });

  describe('expression type', () => {
    it('evaluates and returns result', () => {
      expect(evaluateTransform('expression', 'input.a + input.b', { a: 1, b: 2 })).toBe(3);
    });

    it('returns object results', () => {
      expect(evaluateTransform('expression', '({ sum: input.a + input.b })', { a: 1, b: 2 })).toEqual({
        sum: 3,
      });
    });
  });

  describe('map type', () => {
    it('maps over array input', () => {
      const input = [1, 2, 3];
      expect(evaluateTransform('map', 'item * 2', input as any)).toEqual([2, 4, 6]);
    });

    it('maps over input.data array', () => {
      const input = { data: [{ v: 1 }, { v: 2 }] };
      expect(evaluateTransform('map', 'item.v + 10', input as any)).toEqual([11, 12]);
    });

    it('throws if input is not array', () => {
      expect(() => evaluateTransform('map', 'item', { notArray: true } as any)).toThrow(
        'Map transform requires array input'
      );
    });

    it('provides index variable', () => {
      const input = ['a', 'b', 'c'];
      expect(evaluateTransform('map', 'index', input as any)).toEqual([0, 1, 2]);
    });
  });

  describe('filter type', () => {
    it('filters array by condition', () => {
      const input = [1, 2, 3, 4, 5];
      expect(evaluateTransform('filter', 'item > 3', input as any)).toEqual([4, 5]);
    });

    it('filters input.data array', () => {
      const input = { data: [{ active: true }, { active: false }, { active: true }] };
      expect(evaluateTransform('filter', 'item.active', input as any)).toEqual([
        { active: true },
        { active: true },
      ]);
    });

    it('throws if input is not array', () => {
      expect(() => evaluateTransform('filter', 'item', { notArray: true } as any)).toThrow(
        'Filter transform requires array input'
      );
    });
  });

  describe('empty expression', () => {
    it('returns input unchanged', () => {
      const input = { data: 'test' };
      expect(evaluateTransform('expression', '', input)).toBe(input);
      expect(evaluateTransform('expression', '   ', input)).toBe(input);
    });
  });

  describe('unknown type falls through to expression', () => {
    it('evaluates as expression for unknown types', () => {
      expect(evaluateTransform('custom_type', 'input.x', { x: 99 })).toBe(99);
    });
  });
});
