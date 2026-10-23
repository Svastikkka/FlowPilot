import { describe, expect, it } from 'vitest';
import { scopeAt, validateWorkflow } from '../../src/shared/schema/validate';
import { findSensitiveSteps } from '../../src/shared/safety';
import type { Step } from '../../src/shared/schema/types';
import { css, step, wf } from '../helpers/fakes';

const block = <T extends Step>(s: T, children: Step[], elseChildren?: Step[]): T => ({ ...s, children, ...(elseChildren ? { elseChildren } : {}) });
const open = () => step('openUrl', { url: 'https://a.com' });
const messages = (w: ReturnType<typeof wf>) => validateWorkflow(w).errors.map((e) => e.message);

describe('validation of logic blocks', () => {
  it('accepts a valid nested workflow', () => {
    const w = wf([
      open(),
      block(step('forEachElement', { locator: css('li'), loopVariable: 'item' }), [
        block(step('if', { condition: 'variable', variable: 'item', operator: 'contains', value: 'x' }), [step('continue')]),
        step('addRow', { columns: [{ name: 'text', value: '{{item}} #{{item_index}} {{item_selector}}' }] }),
      ]),
    ]);
    expect(validateWorkflow(w).errors).toEqual([]);
  });

  it('scopes loop variables to the loop body', () => {
    const after = step('type', { locator: css('#q'), text: '{{item}}' });
    const w = wf([open(), block(step('forEachElement', { locator: css('li'), loopVariable: 'item' }), []), after]);
    expect(validateWorkflow(w).errors).toContainEqual(expect.objectContaining({ stepId: after.id, message: expect.stringContaining('{{item}} is set by step 2') }));
  });

  it('keeps values set inside blocks available after them', () => {
    const w = wf([
      open(),
      block(step('if', { condition: 'elementExists', locator: css('#x') }), [step('extractText', { locator: css('#x'), variable: 'found' })]),
      step('type', { locator: css('#q'), text: '{{found}}' }),
    ]);
    expect(validateWorkflow(w).errors).toEqual([]);
  });

  it('requires break/continue to be inside a loop (an If alone is not enough)', () => {
    const w = wf([open(), block(step('if', { condition: 'elementExists', locator: css('#x') }), [step('break')])]);
    expect(messages(w)).toContain('“Break loop” only works inside a loop');
  });

  it('requires data for "For each data row" and exposes its columns', () => {
    const loop = block(step('forEachRow', { loopVariable: 'row' }), [step('type', { locator: css('#q'), text: '{{row_email}}' })]);
    expect(messages(wf([open(), loop]))).toContain('Add data on the Data tab (or import a CSV) for this loop to use');
    const withData = wf([open(), loop], { data: { columns: ['email'], rows: [['a@b.c']] } });
    expect(validateWorkflow(withData).errors).toEqual([]);
    expect(scopeAt(withData, loop.children![0].id)).toEqual(expect.arrayContaining(['row_email', 'row_index']));
  });

  it('checks loop limits, regexes and result columns', () => {
    const w = wf([
      open(),
      step('setVariable', { variable: 'v', operation: 'regexExtract', pattern: '(' }),
      block(step('repeat', { times: 0 }), []),
      block(step('while', { condition: 'variable', variable: 'v', operator: 'matches', value: '[', maxIterations: 0 }), []),
      step('addRow', { columns: [{ name: 'a', value: '' }, { name: 'a', value: '' }, { name: '', value: '' }] }),
    ]);
    const m = messages(w);
    expect(m).toEqual(
      expect.arrayContaining([
        'Invalid regular expression: /(/',
        'Repeat at least once',
        'Allow at least 1 iteration',
        'Invalid regular expression: /[/',
        'Every column needs a name',
        'Column names must be unique',
      ]),
    );
  });

  it('limits nesting depth and total step count', () => {
    let deep: Step = step('click', { locator: css('#x') });
    for (let i = 0; i < 9; i++) deep = block(step('repeat', { times: 1 }), [deep]);
    expect(messages(wf([open(), deep])).some((m) => m.includes('nested at most 8 levels'))).toBe(true);
    const many = Array.from({ length: 501 }, () => step('clear', { locator: css('#x') }));
    expect(messages(wf([open(), block(step('repeat', { times: 1 }), many)])).some((m) => m.includes('at most 500 steps'))).toBe(true);
  });

  it('finds sensitive steps inside blocks', () => {
    const buy = step('click', { locator: { strategy: 'text', value: 'Buy now' } });
    expect(findSensitiveSteps({ steps: [block(step('repeat'), [buy])] }).map((f) => f.stepId)).toEqual([buy.id]);
  });

  it('ignores references inside disabled blocks', () => {
    const w = wf([open(), block(step('repeat', { times: 1 }, { disabled: true }), [step('type', { locator: css('#q'), text: '{{nothing}}' })])]);
    expect(validateWorkflow(w).errors).toEqual([]);
  });
});
