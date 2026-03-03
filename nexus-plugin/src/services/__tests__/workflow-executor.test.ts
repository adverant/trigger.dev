/**
 * Unit tests for workflow-executor pure functions.
 *
 * Tests topologicalSortByLevel (parallel execution grouping)
 * and gatherInput (defensive upstream data collection).
 */

import {
  topologicalSortByLevel,
  gatherInput,
  findTerminalNodes,
  markDependentsSkipped,
  GraphNode,
  GraphEdge,
  NodeState,
} from '../workflow-executor';

// ============================================================================
// Helpers
// ============================================================================

function makeNode(id: string, type = 'taskNode'): GraphNode {
  return { id, type, data: { label: id } };
}

function buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  return adj;
}

function buildInDegree(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const deg = new Map<string, number>();
  for (const n of nodes) deg.set(n.id, 0);
  for (const e of edges) deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  return deg;
}

function buildReverseAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const e of edges) {
    if (!rev.has(e.target)) rev.set(e.target, []);
    rev.get(e.target)!.push(e.source);
  }
  return rev;
}

function edge(source: string, target: string, sourceHandle?: string): GraphEdge {
  return { id: `${source}->${target}`, source, target, sourceHandle };
}

// ============================================================================
// topologicalSortByLevel
// ============================================================================

describe('topologicalSortByLevel', () => {
  it('returns a single level for independent nodes', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges: GraphEdge[] = [];
    const result = topologicalSortByLevel(
      nodes,
      buildInDegree(nodes, edges),
      buildAdjacency(edges)
    );
    expect(result).toHaveLength(1);
    expect(result[0].sort()).toEqual(['A', 'B', 'C']);
  });

  it('returns sequential levels for a linear chain', () => {
    // A → B → C
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [edge('A', 'B'), edge('B', 'C')];
    const result = topologicalSortByLevel(
      nodes,
      buildInDegree(nodes, edges),
      buildAdjacency(edges)
    );
    expect(result).toEqual([['A'], ['B'], ['C']]);
  });

  it('groups parallel branches correctly (diamond DAG)', () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')];
    const edges = [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')];
    const result = topologicalSortByLevel(
      nodes,
      buildInDegree(nodes, edges),
      buildAdjacency(edges)
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(['A']);
    expect(result[1].sort()).toEqual(['B', 'C']);
    expect(result[2]).toEqual(['D']);
  });

  it('handles wider parallelism (fan-out)', () => {
    // A → B, A → C, A → D, A → E
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D'), makeNode('E')];
    const edges = [edge('A', 'B'), edge('A', 'C'), edge('A', 'D'), edge('A', 'E')];
    const result = topologicalSortByLevel(
      nodes,
      buildInDegree(nodes, edges),
      buildAdjacency(edges)
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['A']);
    expect(result[1].sort()).toEqual(['B', 'C', 'D', 'E']);
  });

  it('throws on cycle', () => {
    // A → B → C → A (cycle)
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')];
    expect(() =>
      topologicalSortByLevel(
        nodes,
        buildInDegree(nodes, edges),
        buildAdjacency(edges)
      )
    ).toThrow(/cycle/i);
  });

  it('throws and reports cycle nodes', () => {
    // A → B, B → C → B (B-C form a cycle, A is fine)
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'B')];
    expect(() =>
      topologicalSortByLevel(
        nodes,
        buildInDegree(nodes, edges),
        buildAdjacency(edges)
      )
    ).toThrow(/B.*C|C.*B/);
  });

  it('handles empty graph', () => {
    const result = topologicalSortByLevel([], new Map(), new Map());
    expect(result).toEqual([]);
  });

  it('handles single node', () => {
    const nodes = [makeNode('X')];
    const result = topologicalSortByLevel(
      nodes,
      buildInDegree(nodes, []),
      buildAdjacency([])
    );
    expect(result).toEqual([['X']]);
  });
});

// ============================================================================
// gatherInput
// ============================================================================

describe('gatherInput', () => {
  it('returns {} for root node (no upstream)', () => {
    const result = gatherInput('A', new Map(), {}, []);
    expect(result).toEqual({});
  });

  it('returns {} when upstream output is undefined', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: undefined },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({});
  });

  it('returns {} when upstream output is null', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: null },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({});
  });

  it('wraps primitive output in { value }', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: 42 },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({ value: 42 });
  });

  it('wraps string primitive in { value }', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: 'hello' },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({ value: 'hello' });
  });

  it('passes through object output directly', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { foo: 'bar', count: 5 } },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({ foo: 'bar', count: 5 });
  });

  it('unwraps nested .output property', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { output: { name: 'test' } } },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({ name: 'test' });
  });

  it('returns {} for nested .output that is null', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { output: null } },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({});
  });

  it('wraps primitive nested .output in { value }', () => {
    const rev = new Map([['B', ['A']]]);
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { output: 99 } },
    };
    expect(gatherInput('B', rev, states, [])).toEqual({ value: 99 });
  });

  it('skips non-completed upstream in multi-input', () => {
    const rev = new Map([['C', ['A', 'B']]]);
    const edges = [edge('A', 'C'), edge('B', 'C')];
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { x: 1 } },
      B: { status: 'failed', error: 'boom' },
    };
    const result = gatherInput('C', rev, states, edges);
    expect(result).toHaveProperty('A');
    expect(result).not.toHaveProperty('B');
  });

  it('merges multiple upstream outputs by source node ID', () => {
    const rev = new Map([['C', ['A', 'B']]]);
    const edges = [edge('A', 'C'), edge('B', 'C')];
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { val: 'from-a' } },
      B: { status: 'completed', output: { val: 'from-b' } },
    };
    const result = gatherInput('C', rev, states, edges);
    expect(result).toEqual({
      A: { val: 'from-a' },
      B: { val: 'from-b' },
    });
  });

  it('uses sourceHandle as key when available (multi-input)', () => {
    // sourceHandle keying applies in multi-input path
    const rev = new Map([['C', ['A', 'B']]]);
    const edges = [edge('A', 'C', 'true-branch'), edge('B', 'C', 'false-branch')];
    const states: Record<string, NodeState> = {
      A: { status: 'completed', output: { result: 'yes' } },
      B: { status: 'completed', output: { result: 'no' } },
    };
    const result = gatherInput('C', rev, states, edges);
    expect(result).toEqual({
      'true-branch': { result: 'yes' },
      'false-branch': { result: 'no' },
    });
  });
});

// ============================================================================
// findTerminalNodes
// ============================================================================

describe('findTerminalNodes', () => {
  it('finds nodes with no outgoing edges', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')];
    const edges = [edge('A', 'B')];
    const adj = buildAdjacency(edges);
    const terminals = findTerminalNodes(nodes, adj);
    expect(terminals.map((n) => n.id).sort()).toEqual(['B', 'C']);
  });

  it('returns all nodes when no edges exist', () => {
    const nodes = [makeNode('A'), makeNode('B')];
    const terminals = findTerminalNodes(nodes, new Map());
    expect(terminals).toHaveLength(2);
  });
});

// ============================================================================
// markDependentsSkipped
// ============================================================================

describe('markDependentsSkipped', () => {
  it('marks all downstream nodes as skipped', () => {
    // A → B → C → D
    const edges = [edge('A', 'B'), edge('B', 'C'), edge('C', 'D')];
    const adj = buildAdjacency(edges);
    const skipped = new Set<string>();
    markDependentsSkipped('B', adj, skipped);
    expect(skipped.has('C')).toBe(true);
    expect(skipped.has('D')).toBe(true);
    expect(skipped.has('A')).toBe(false);
    expect(skipped.has('B')).toBe(false);
  });

  it('handles diamond correctly', () => {
    //   A → B, A → C, B → D, C → D
    const edges = [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')];
    const adj = buildAdjacency(edges);
    const skipped = new Set<string>();
    markDependentsSkipped('A', adj, skipped);
    expect(skipped.has('B')).toBe(true);
    expect(skipped.has('C')).toBe(true);
    expect(skipped.has('D')).toBe(true);
  });

  it('handles node with no dependents', () => {
    const edges = [edge('A', 'B')];
    const adj = buildAdjacency(edges);
    const skipped = new Set<string>();
    markDependentsSkipped('B', adj, skipped);
    expect(skipped.size).toBe(0);
  });
});
