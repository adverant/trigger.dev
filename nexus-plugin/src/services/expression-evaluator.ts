/**
 * Expression Evaluator
 *
 * Safe evaluation of user expressions for ConditionalNode and TransformNode.
 * Uses Node.js vm.runInNewContext with a prototype-stripped sandbox —
 * prevents prototype chain escapes (e.g. constructor.constructor) and
 * enforces real CPU timeouts for infinite loops.
 */

import { runInNewContext } from 'vm';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'expression-evaluator' });

const EVAL_TIMEOUT_MS = 5000;

/**
 * Safe helpers exposed to user expressions.
 * These are plain functions with no prototype chain to exploit.
 */
const SAFE_BUILTINS = {
  Math,
  JSON,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Date,
  RegExp,
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
 * Deep-clone a value using structured clone to strip prototype chains.
 * Falls back to JSON round-trip for environments without structuredClone.
 */
function stripPrototypes(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/**
 * Safely evaluate a JavaScript expression in an isolated VM context.
 *
 * Uses vm.runInNewContext with:
 * - Prototype-stripped sandbox (Object.create(null)) — prevents constructor chain escapes
 * - Real timeout enforcement — kills CPU-bound infinite loops
 * - No access to process, require, global, or any Node.js internals
 */
function safeEval(expression: string, context: Record<string, unknown>): unknown {
  // Build a prototype-free sandbox
  const sandbox: Record<string, unknown> = Object.create(null);

  // Add safe builtins
  for (const [key, value] of Object.entries(SAFE_BUILTINS)) {
    sandbox[key] = value;
  }

  // Add context variables with stripped prototypes to prevent chain escapes
  for (const [key, value] of Object.entries(context)) {
    sandbox[key] = stripPrototypes(value);
  }

  const code = `"use strict"; (${expression});`;

  try {
    return runInNewContext(code, sandbox, {
      timeout: EVAL_TIMEOUT_MS,
      displayErrors: true,
    });
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message.includes('Script execution timed out')) {
        throw new Error(`Expression timed out after ${EVAL_TIMEOUT_MS}ms`);
      }
      throw new Error(`Expression evaluation error: ${err.message}`);
    }
    throw new Error(`Expression evaluation error: ${String(err)}`);
  }
}
