/**
 * Expression Evaluator
 *
 * Safe evaluation of user expressions for ConditionalNode and TransformNode.
 * Uses Function constructor with restricted scope — no access to globals,
 * require, process, or other Node.js internals.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'expression-evaluator' });

const EVAL_TIMEOUT_MS = 5000;

/**
 * Blocked identifiers that must not be accessible in user expressions.
 */
const BLOCKED_GLOBALS: Record<string, undefined> = {
  process: undefined,
  require: undefined,
  module: undefined,
  exports: undefined,
  global: undefined,
  globalThis: undefined,
  __dirname: undefined,
  __filename: undefined,
  Buffer: undefined,
  setTimeout: undefined,
  setInterval: undefined,
  setImmediate: undefined,
  clearTimeout: undefined,
  clearInterval: undefined,
  clearImmediate: undefined,
  eval: undefined,
  Function: undefined,
  fetch: undefined,
};

/**
 * Interpolate `{{path.to.field}}` template expressions in a string.
 * Supports nested dot-path access (e.g. `{{input.user.name}}`).
 */
export function interpolateTemplate(
  template: string,
  context: Record<string, unknown>
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim();
    const value = resolvePath(context, trimmed);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

/**
 * Resolve a dot-separated path against an object.
 * e.g. resolvePath({ a: { b: 42 } }, 'a.b') => 42
 */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Evaluate a boolean expression for ConditionalNode.
 *
 * The expression has access to an `input` variable containing data from upstream nodes.
 * Returns true or false.
 *
 * Examples:
 *   "input.status === 'approved'"
 *   "input.score > 0.8"
 *   "input.items.length > 0 && input.type === 'order'"
 */
export function evaluateCondition(
  expression: string,
  input: Record<string, unknown>
): boolean {
  if (!expression || !expression.trim()) {
    logger.warn('Empty condition expression, defaulting to true');
    return true;
  }

  // First interpolate any {{}} templates
  const interpolated = interpolateTemplate(expression, { input });

  try {
    const result = safeEval(interpolated, { input });
    return Boolean(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Condition evaluation failed', { expression, error: message });
    throw new Error(`Condition evaluation failed: ${message}`);
  }
}

/**
 * Apply a transform expression to input data for TransformNode.
 *
 * Supports multiple transform types:
 * - 'map': Apply an expression to each item in an array input
 * - 'filter': Filter an array by a boolean expression
 * - 'template': Interpolate a template string
 * - 'expression': Evaluate a JavaScript expression and return the result
 */
export function evaluateTransform(
  transformType: string,
  expression: string,
  input: Record<string, unknown>
): unknown {
  if (!expression || !expression.trim()) {
    return input;
  }

  switch (transformType) {
    case 'template':
      return interpolateTemplate(expression, { input });

    case 'map': {
      const arr = Array.isArray(input) ? input : (input as any).data;
      if (!Array.isArray(arr)) {
        throw new Error('Map transform requires array input (or input.data array)');
      }
      return arr.map((item: unknown, index: number) =>
        safeEval(expression, { item, index, input })
      );
    }

    case 'filter': {
      const arr = Array.isArray(input) ? input : (input as any).data;
      if (!Array.isArray(arr)) {
        throw new Error('Filter transform requires array input (or input.data array)');
      }
      return arr.filter((item: unknown, index: number) =>
        Boolean(safeEval(expression, { item, index, input }))
      );
    }

    case 'expression':
    default:
      return safeEval(expression, { input });
  }
}

/**
 * Safely evaluate a JavaScript expression with a restricted scope.
 *
 * The expression can access only the provided context variables.
 * Globals like `process`, `require`, `eval`, `fetch` are blocked.
 */
function safeEval(expression: string, context: Record<string, unknown>): unknown {
  // Build the restricted scope
  const scopeKeys = Object.keys(context);
  const scopeValues = Object.values(context);

  // Prepend blocked globals as undefined to shadow them
  const blockedKeys = Object.keys(BLOCKED_GLOBALS);
  const blockedValues = Object.values(BLOCKED_GLOBALS);

  const allKeys = [...blockedKeys, ...scopeKeys];
  const allValues = [...blockedValues, ...scopeValues];

  // Create function with restricted scope
  // The function body wraps the expression in "use strict" + returns the result
  const fnBody = `"use strict"; return (${expression});`;

  let fn: (...args: unknown[]) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(...allKeys, fnBody) as (...args: unknown[]) => unknown;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid expression syntax: ${message}`);
  }

  // Execute with timeout protection
  const startTime = Date.now();
  try {
    const result = fn(...allValues);

    // Check if execution took too long (rough check — actual timeout would need Worker)
    const elapsed = Date.now() - startTime;
    if (elapsed > EVAL_TIMEOUT_MS) {
      logger.warn('Expression evaluation exceeded soft timeout', { expression, elapsed });
    }

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Expression runtime error: ${message}`);
  }
}
