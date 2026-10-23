import { describe, expect, it } from 'vitest';
import { builtinValues, interpolate, MissingVariableError, referencedVariables } from '../../src/shared/interpolate';
import { findSensitiveSteps, looksLikeCredentialField } from '../../src/shared/safety';
import { css, step } from '../helpers/fakes';

describe('interpolate', () => {
  it('substitutes variables with optional whitespace', () => {
    expect(interpolate('Hi {{ name }}, {{name}}!', { name: 'Ada' })).toBe('Hi Ada, Ada!');
  });

  it('leaves non-variable braces alone', () => {
    expect(interpolate('{{ 1 + 1 }} {name} {{}}', {})).toBe('{{ 1 + 1 }} {name} {{}}');
  });

  it('does not evaluate code or recurse into values', () => {
    expect(interpolate('{{a}}', { a: '{{b}}', b: 'nope' })).toBe('{{b}}');
    expect(interpolate('{{constructor}}', { constructor: 'own' })).toBe('own');
    expect(() => interpolate('{{toString}}', {})).toThrow(MissingVariableError);
  });

  it('throws for unknown variables', () => {
    expect(() => interpolate('{{missing}}', {})).toThrow('Variable "missing" has no value yet');
  });

  it('lists referenced variables', () => {
    expect(referencedVariables('{{a}} and {{ b_2 }} and {{a}}')).toEqual(['a', 'b_2', 'a']);
  });

  it('computes built-in date values', () => {
    const v = builtinValues(new Date(2026, 0, 5, 9, 3, 7), 'run_1');
    expect(v).toEqual({ date: '2026-01-05', time: '09:03:07', datetime: '2026-01-05 09:03:07', timestamp: String(new Date(2026, 0, 5, 9, 3, 7).getTime()), runId: 'run_1' });
  });
});

describe('safety heuristics', () => {
  it('flags clicks that look like submit / buy / delete and Enter presses', () => {
    const steps = [
      step('click', { locator: { strategy: 'text', value: 'Delete account' } }),
      step('click', { locator: css('button[type="submit"]') }),
      step('click', { locator: css('#next-page') }),
      step('type', { locator: css('#q'), text: 'x', pressEnter: true }),
      step('click', { locator: css('#checkout') }, { disabled: true }),
    ];
    expect(findSensitiveSteps({ steps }).map((f) => f.stepId)).toEqual([steps[0].id, steps[1].id, steps[3].id]);
  });

  it('detects literal credentials typed into credential-looking fields', () => {
    expect(looksLikeCredentialField(step('type', { locator: css('#password'), text: 'abc' }))).toBe(true);
    expect(looksLikeCredentialField(step('type', { locator: css('#password'), text: '{{pw}}' }))).toBe(false);
    expect(looksLikeCredentialField(step('type', { locator: css('#name'), text: 'abc' }))).toBe(false);
  });
});
