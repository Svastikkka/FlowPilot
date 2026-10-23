import type { ConditionOperator, SetVariableParams } from './schema/types';
import { FlowError } from './errors';
import { LIMITS } from './schema/zod';

// Pure value operations for "Set variable" and variable conditions. Regular
// expressions come from the workflow, so inputs are length-capped to bound the
// cost of a pathological pattern.

const MAX_INPUT = 100_000;

export function compileRegex(pattern: string, flags = 'i'): RegExp {
  if (pattern.length > LIMITS.maxPatternLength) throw new FlowError('INVALID_VALUE', 'Regular expression is too long', true);
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new FlowError('INVALID_VALUE', `Invalid regular expression: /${pattern}/`, true);
  }
}

const capped = (s: string) => (s.length > MAX_INPUT ? s.slice(0, MAX_INPUT) : s);

function toNumber(raw: string, what: string): number {
  const n = Number(raw.trim().replace(/,/g, ''));
  if (raw.trim() === '' || !Number.isFinite(n)) throw new FlowError('INVALID_VALUE', `${what} "${raw.slice(0, 40)}" is not a number`, true);
  return n;
}

/** Computes the new value. `value` and `replacement` must already be interpolated. */
export function applySetVariable(current: string, p: Pick<SetVariableParams, 'operation' | 'pattern' | 'start' | 'end'> & { value: string; replacement: string }): string {
  const input = capped(current);
  switch (p.operation) {
    case 'set':
      return p.value;
    case 'append':
      return input + p.value;
    case 'increment': {
      const base = input.trim() === '' ? 0 : toNumber(input, 'Current value');
      const by = p.value.trim() === '' ? 1 : toNumber(p.value, 'Amount');
      return String(Math.round((base + by) * 1e9) / 1e9);
    }
    case 'slice':
      return input.slice(p.start ?? 0, p.end ?? undefined);
    case 'regexExtract': {
      const m = compileRegex(p.pattern).exec(input);
      return m ? (m[1] ?? m[0]) : '';
    }
    case 'regexReplace':
      return input.replace(compileRegex(p.pattern, 'gi'), p.replacement);
    case 'trim':
      return input.trim();
    case 'upperCase':
      return input.toUpperCase();
    case 'lowerCase':
      return input.toLowerCase();
    case 'length':
      return String(input.length);
  }
}

export function compareValues(left: string, operator: ConditionOperator, right: string): boolean {
  const l = capped(left);
  switch (operator) {
    case 'equals':
      return l === right;
    case 'notEquals':
      return l !== right;
    case 'contains':
      return l.toLowerCase().includes(right.toLowerCase());
    case 'notContains':
      return !l.toLowerCase().includes(right.toLowerCase());
    case 'matches':
      return compileRegex(right).test(l);
    case 'greaterThan':
      return toNumber(l, 'Value') > toNumber(right, 'Comparison value');
    case 'lessThan':
      return toNumber(l, 'Value') < toNumber(right, 'Comparison value');
    case 'isEmpty':
      return l.trim() === '';
    case 'isNotEmpty':
      return l.trim() !== '';
  }
}
