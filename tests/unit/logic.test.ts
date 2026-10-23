import { describe, expect, it, vi } from 'vitest';
import type { BrowserDriver } from '../../src/engine/driver';
import { createRunRecord, initialVariables, WorkflowRunner } from '../../src/engine/runner';
import type { DomRequest } from '../../src/shared/messages';
import type { RunRecord, Step, Workflow } from '../../src/shared/schema/types';
import { applySetVariable, compareValues } from '../../src/shared/dataOps';
import { FlowError } from '../../src/shared/errors';
import { css, FAST_ENGINE, MemoryPersistence, step, UpdateBus, wf } from '../helpers/fakes';

/** Driver with a tiny scriptable "page": a list of item texts and a visibility map. */
function pageDriver(page: { items?: string[]; visible?: Record<string, boolean>; text?: string } = {}) {
  const calls: DomRequest[] = [];
  const driver: BrowserDriver = {
    prepareTab: vi.fn(async () => 1),
    navigate: vi.fn(async () => undefined),
    history: vi.fn(async () => undefined),
    waitForSettle: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => 'data:,'),
    dom: vi.fn(async (_t: number, req: DomRequest) => {
      calls.push(req);
      switch (req.op) {
        case 'probe': {
          const v = page.visible?.[req.locator.value];
          return v === undefined ? { count: 1, visible: true, enabled: true } : { count: v ? 1 : 0, visible: v, enabled: true };
        }
        case 'markNth': {
          const items = page.items ?? [];
          return req.index < items.length ? { found: true, total: items.length, text: items[req.index] } : { found: false, total: items.length, text: '' };
        }
        case 'textPresent':
          return { present: (page.text ?? '').includes(req.text) };
        case 'pageInfo':
          return { url: 'https://site.test/', title: 'T', readyState: 'complete' };
        case 'extractText':
          return { text: 'x', count: 1 };
        default:
          return { message: `did ${req.op}`, sensitive: false };
      }
    }) as BrowserDriver['dom'],
  };
  return { driver, calls };
}

async function run(workflow: Workflow, driver: BrowserDriver, opts: { record?: RunRecord; inputs?: Record<string, string> } = {}) {
  const bus = new UpdateBus();
  const runner = new WorkflowRunner(opts.record ?? createRunRecord(workflow, { target: { kind: 'newTab' } }), initialVariables(workflow, opts.inputs), {
    driver,
    persistence: new MemoryPersistence(),
    options: FAST_ENGINE,
    onUpdate: bus.emit,
  });
  return { result: await runner.execute(), bus, runner };
}

const typed = (calls: DomRequest[]) => calls.filter((c) => c.op === 'type').map((c) => (c as { text: string }).text);
const block = <T extends Step>(s: T, children: Step[], elseChildren?: Step[]): T => ({ ...s, children, ...(elseChildren ? { elseChildren } : {}) });

describe('If / Else', () => {
  it.each([
    [true, ['then']],
    [false, ['else']],
  ])('takes the right branch when the element visibility is %s', async (visible, expected) => {
    const { driver, calls } = pageDriver({ visible: { '#banner': visible } });
    const ifStep = block(step('if', { condition: 'elementVisible', locator: css('#banner') }), [step('type', { locator: css('#q'), text: 'then' })], [
      step('type', { locator: css('#q'), text: 'else' }),
    ]);
    const { result } = await run(wf([ifStep, step('type', { locator: css('#q'), text: 'after' })]), driver);
    expect(result.status).toBe('succeeded');
    expect(typed(calls)).toEqual([...expected, 'after']);
    const notTaken = visible ? ifStep.elseChildren![0] : ifStep.children![0];
    expect(result.steps.find((s) => s.stepId === notTaken.id)).toMatchObject({ status: 'skipped', message: 'Branch not taken' });
    expect(result.steps.find((s) => s.stepId === ifStep.id)!.message).toContain(visible ? '→ Then' : '→ Else');
  });

  it('compares variables', async () => {
    const { driver, calls } = pageDriver();
    const wfx = wf(
      [
        block(step('if', { condition: 'variable', variable: 'total', operator: 'greaterThan', value: '100' }), [step('type', { locator: css('#q'), text: 'big' })], [
          step('type', { locator: css('#q'), text: 'small' }),
        ]),
      ],
      { variables: [{ name: 'total', defaultValue: '250' }] },
    );
    await run(wfx, driver);
    expect(typed(calls)).toEqual(['big']);
  });

  it('can end the run with a failing Stop step (user-defined failure condition)', async () => {
    const { driver } = pageDriver({ text: 'Error: card declined' });
    const guard = block(step('if', { condition: 'textPresent', value: 'Error' }), [step('stop', { outcome: 'failed', message: 'The site reported an error' })]);
    const { result } = await run(wf([guard, step('click', { locator: css('#next') })]), driver);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'STOPPED_BY_STEP', message: 'The site reported an error', stepId: guard.children![0].id });
  });
});

describe('loops', () => {
  it('repeats a fixed number of times and binds the iteration number', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('repeat', { times: 3, loopVariable: 'n' }), [step('type', { locator: css('#q'), text: 'pass {{n_index}}' })]);
    const { result } = await run(wf([loop]), driver);
    expect(typed(calls)).toEqual(['pass 1', 'pass 2', 'pass 3']);
    expect(result.steps.find((s) => s.stepId === loop.id)).toMatchObject({ status: 'succeeded', message: expect.stringContaining('3 iterations') });
    expect(result.steps.find((s) => s.stepId === loop.children![0].id)!.executions).toBe(3);
  });

  it('runs While until the condition is false, using Set variable to count', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('while', { condition: 'variable', variable: 'count', operator: 'lessThan', value: '3', maxIterations: 50 }), [
      step('setVariable', { variable: 'count', operation: 'increment', value: '1' }),
      step('type', { locator: css('#q'), text: '{{count}}' }),
    ]);
    const { result } = await run(wf([loop], { variables: [{ name: 'count', defaultValue: '0' }] }), driver);
    expect(typed(calls)).toEqual(['1', '2', '3']);
    expect(result.variables.count).toBe('3');
  });

  it('stops a While loop at its iteration limit', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('while', { condition: 'elementExists', locator: css('#always'), maxIterations: 4 }), [step('click', { locator: css('#more') })]);
    const { result } = await run(wf([loop]), driver);
    expect(calls.filter((c) => c.op === 'click')).toHaveLength(4);
    expect(result.steps.find((s) => s.stepId === loop.id)!.message).toContain('limit of 4 iterations');
  });

  it('iterates over matching elements, exposing text, selector and index', async () => {
    const { driver, calls } = pageDriver({ items: ['Apple', 'Banana'] });
    const loop = block(step('forEachElement', { locator: css('li'), loopVariable: 'fruit' }), [
      step('click', { locator: css('{{fruit_selector}} button') }),
      step('addRow', { columns: [{ name: 'n', value: '{{fruit_index}}' }, { name: 'name', value: '{{fruit}}' }] }),
    ]);
    const { result } = await run(wf([loop]), driver);
    expect(calls.filter((c) => c.op === 'markNth').map((c) => (c as { index: number }).index)).toEqual([0, 1, 2]);
    expect(calls.filter((c) => c.op === 'click').map((c) => (c as { locator: { value: string } }).locator.value)).toEqual([
      `[data-flowpilot-item="${loop.id}"] button`,
      `[data-flowpilot-item="${loop.id}"] button`,
    ]);
    expect(result.table).toEqual({ columns: ['n', 'name'], rows: [{ n: '1', name: 'Apple' }, { n: '2', name: 'Banana' }] });
    expect(result.summary).toContain('2 result rows');
  });

  it('iterates over data rows with column bindings, and the table can be replaced per run', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('forEachRow', { loopVariable: 'row', maxRows: 10 }), [step('type', { locator: css('#email'), text: '{{row_index}}:{{row_email}}' })]);
    const workflow = wf([loop], { data: { columns: ['email'], rows: [['a@x.test'], ['b@x.test']] } });
    await run(workflow, driver);
    expect(typed(calls)).toEqual(['1:a@x.test', '2:b@x.test']);
  });

  it('honours maxRows', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('forEachRow', { loopVariable: 'r', maxRows: 1 }), [step('type', { locator: css('#q'), text: '{{r_v}}' })]);
    await run(wf([loop], { data: { columns: ['v'], rows: [['1'], ['2'], ['3']] } }), driver);
    expect(typed(calls)).toEqual(['1']);
  });

  it('supports Break and Next iteration inside nested If blocks', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('repeat', { times: 10, loopVariable: 'i' }), [
      block(step('if', { condition: 'variable', variable: 'i_index', operator: 'equals', value: '2' }), [step('continue')]),
      block(step('if', { condition: 'variable', variable: 'i_index', operator: 'equals', value: '4' }), [step('break')]),
      step('type', { locator: css('#q'), text: '{{i_index}}' }),
    ]);
    const { result } = await run(wf([loop, step('type', { locator: css('#q'), text: 'done' })]), driver);
    expect(typed(calls)).toEqual(['1', '3', 'done']);
    expect(result.steps.find((s) => s.stepId === loop.id)!.message).toBe('Left the loop after 4 iterations');
  });

  it('handles nested loops', async () => {
    const { driver, calls } = pageDriver();
    const inner = block(step('repeat', { times: 2, loopVariable: 'b' }), [step('type', { locator: css('#q'), text: '{{a_index}}.{{b_index}}' })]);
    const outer = block(step('repeat', { times: 2, loopVariable: 'a' }), [inner]);
    await run(wf([outer]), driver);
    expect(typed(calls)).toEqual(['1.1', '1.2', '2.1', '2.2']);
  });

  it('propagates a Stop step out of a loop', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('repeat', { times: 5, loopVariable: 'i' }), [
      step('type', { locator: css('#q'), text: '{{i_index}}' }),
      block(step('if', { condition: 'variable', variable: 'i_index', operator: 'equals', value: '2' }), [step('stop', { outcome: 'succeeded', message: 'Found it' })]),
    ]);
    const { result } = await run(wf([loop, step('click', { locator: css('#never') })]), driver);
    expect(result.status).toBe('succeeded');
    expect(typed(calls)).toEqual(['1', '2']);
    expect(calls.some((c) => c.op === 'click')).toBe(false);
  });

  it('applies the skip policy per iteration', async () => {
    let n = 0;
    const { driver } = pageDriver();
    const original = driver.dom;
    driver.dom = vi.fn(async (tab: number, req: DomRequest) => {
      if (req.op === 'click' && ++n === 2) throw new FlowError('UNKNOWN', 'flaky');
      return original(tab, req);
    }) as BrowserDriver['dom'];
    const loop = block(step('repeat', { times: 3, loopVariable: 'i' }), [step('click', { locator: css('#x') }, { onError: 'skip' })]);
    const { result, bus } = await run(wf([loop]), driver);
    expect(result.status).toBe('succeeded');
    const log = result.log!.filter((e) => e.stepId === loop.children![0].id);
    expect(log.map((e) => [e.status, e.context])).toEqual([
      ['succeeded', 'Repeat #1'],
      ['skipped', 'Repeat #2'],
      ['succeeded', 'Repeat #3'],
    ]);
    expect(bus.history.length).toBeGreaterThan(0);
  });

  it('guards against runaway loops across nested blocks', async () => {
    const { driver } = pageDriver();
    const inner = block(step('repeat', { times: 10_000, loopVariable: 'b' }), [step('setVariable', { variable: 'x', operation: 'set', value: '1' })]);
    const outer = block(step('repeat', { times: 10_000, loopVariable: 'a' }), [inner]);
    const { result } = await run(wf([outer]), driver);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('LIMIT_EXCEEDED');
  }, 30_000);

  it('skips a disabled block and everything inside it', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('repeat', { times: 3, loopVariable: 'i' }, { disabled: true }), [step('click', { locator: css('#x') })]);
    const { result } = await run(wf([loop]), driver);
    expect(calls.some((c) => c.op === 'click')).toBe(false);
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
  });
});

describe('resume inside blocks', () => {
  it('continues from the saved loop iteration and child step', async () => {
    const { driver, calls } = pageDriver();
    const loop = block(step('repeat', { times: 3, loopVariable: 'i' }), [
      step('type', { locator: css('#a'), text: 'a{{i_index}}' }),
      step('type', { locator: css('#b'), text: 'b{{i_index}}' }),
    ]);
    const workflow = wf([step('click', { locator: css('#start') }), loop]);
    const record = createRunRecord(workflow, { target: { kind: 'tab', tabId: 1 } });
    record.tabId = 1;
    // Interrupted at iteration 2 (0-based 1), second child.
    record.cursor = [{ index: 1, iteration: 1 }, { index: 1 }];
    record.currentStepIndex = 1;
    const { result } = await run(workflow, driver, { record });
    expect(calls.some((c) => c.op === 'click')).toBe(false);
    expect(typed(calls)).toEqual(['b2', 'a3', 'b3']);
    expect(result.status).toBe('succeeded');
  });

  it('resumes in the recorded If branch without re-evaluating the condition', async () => {
    const { driver, calls } = pageDriver({ visible: { '#flag': false } });
    const ifStep = block(step('if', { condition: 'elementVisible', locator: css('#flag') }), [
      step('type', { locator: css('#q'), text: 't1' }),
      step('type', { locator: css('#q'), text: 't2' }),
    ]);
    const workflow = wf([ifStep]);
    const record = createRunRecord(workflow, { target: { kind: 'tab', tabId: 1 } });
    record.tabId = 1;
    record.cursor = [{ index: 0, branch: 'then' }, { index: 1 }];
    await run(workflow, driver, { record });
    expect(typed(calls)).toEqual(['t2']);
    expect(calls.some((c) => c.op === 'probe' && c.locator.value === '#flag')).toBe(false);
  });
});

describe('data operations', () => {
  const op = (current: string, p: Partial<Parameters<typeof applySetVariable>[1]>) =>
    applySetVariable(current, { operation: 'set', pattern: '', value: '', replacement: '', ...p } as Parameters<typeof applySetVariable>[1]);

  it.each([
    ['', { operation: 'set', value: 'hi' }, 'hi'],
    ['ab', { operation: 'append', value: 'c' }, 'abc'],
    ['', { operation: 'increment', value: '' }, '1'],
    ['1,200.5', { operation: 'increment', value: '-0.5' }, '1200'],
    ['0.1', { operation: 'increment', value: '0.2' }, '0.3'],
    ['abcdef', { operation: 'slice', start: 1, end: 3 }, 'bc'],
    ['abcdef', { operation: 'slice', start: -2 }, 'ef'],
    ['Order #A-123 placed', { operation: 'regexExtract', pattern: '#([A-Z]-\\d+)' }, 'A-123'],
    ['Total: $42', { operation: 'regexExtract', pattern: '\\d+' }, '42'],
    ['none', { operation: 'regexExtract', pattern: '\\d+' }, ''],
    ['a-b-c', { operation: 'regexReplace', pattern: '-', replacement: '+' }, 'a+b+c'],
    ['John Smith', { operation: 'regexReplace', pattern: '(\\w+) (\\w+)', replacement: '$2, $1' }, 'Smith, John'],
    ['  x  ', { operation: 'trim' }, 'x'],
    ['Ab', { operation: 'upperCase' }, 'AB'],
    ['Ab', { operation: 'lowerCase' }, 'ab'],
    ['héllo', { operation: 'length' }, '5'],
  ] as const)('%j with %j → %j', (current, p, expected) => {
    expect(op(current, p as never)).toBe(expected);
  });

  it('rejects non-numeric increments and invalid regex as fatal', () => {
    expect(() => op('abc', { operation: 'increment', value: '1' })).toThrow('is not a number');
    expect(() => op('abc', { operation: 'regexExtract', pattern: '(' })).toThrow('Invalid regular expression');
    try {
      op('abc', { operation: 'regexExtract', pattern: '(' });
    } catch (e) {
      expect((e as FlowError).fatal).toBe(true);
    }
  });

  it.each([
    ['abc', 'equals', 'abc', true],
    ['abc', 'equals', 'ABC', false],
    ['abc', 'notEquals', 'x', true],
    ['Hello World', 'contains', 'world', true],
    ['Hello', 'notContains', 'z', true],
    ['INV-2024-07', 'matches', '^inv-\\d{4}', true],
    ['10', 'greaterThan', '9', true],
    ['1,000', 'greaterThan', '999', true],
    ['3', 'lessThan', '2', false],
    ['  ', 'isEmpty', '', true],
    ['x', 'isNotEmpty', '', true],
  ] as const)('compare %j %s %j → %s', (l, operator, r, expected) => {
    expect(compareValues(l, operator, r)).toBe(expected);
  });
});
