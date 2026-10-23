import { describe, expect, it, vi } from 'vitest';
import type { BrowserDriver } from '../../src/engine/driver';
import { createRunRecord, initialVariables, SECRET_MASK, WorkflowRunner } from '../../src/engine/runner';
import type { DomRequest } from '../../src/shared/messages';
import type { Workflow } from '../../src/shared/schema/types';
import { FlowError } from '../../src/shared/errors';
import { css, FAST_ENGINE, MemoryPersistence, step, UpdateBus, wf } from '../helpers/fakes';

type DomHandler = (req: DomRequest) => unknown | Promise<unknown>;

/** Driver whose DOM behaviour is scripted per operation. */
function scriptedDriver(handlers: Partial<Record<DomRequest['op'], DomHandler>> = {}) {
  const calls: DomRequest[] = [];
  const driver: BrowserDriver = {
    prepareTab: vi.fn(async () => 7),
    navigate: vi.fn(async () => undefined),
    history: vi.fn(async () => undefined),
    waitForSettle: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => 'data:image/png;base64,AAAA'),
    dom: vi.fn(async (_tabId: number, req: DomRequest) => {
      calls.push(req);
      const h = handlers[req.op];
      if (h) return h(req);
      switch (req.op) {
        case 'probe':
          return { count: 1, visible: true, enabled: true };
        case 'pageInfo':
          return { url: 'https://example.com/', title: 'Example', readyState: 'complete' };
        case 'extractText':
          return { text: 'extracted', count: 1 };
        case 'textPresent':
          return { present: true };
        default:
          return { message: `did ${req.op}`, sensitive: false };
      }
    }) as BrowserDriver['dom'],
  };
  return { driver, calls };
}

function setup(workflow: Workflow, driver: BrowserDriver, inputs: Record<string, string> = {}) {
  const persistence = new MemoryPersistence();
  const bus = new UpdateBus();
  const run = createRunRecord(workflow, { target: { kind: 'newTab' } });
  const runner = new WorkflowRunner(run, initialVariables(workflow, inputs), {
    driver,
    persistence,
    options: FAST_ENGINE,
    onUpdate: bus.emit,
  });
  return { runner, persistence, bus, run };
}

describe('WorkflowRunner — sequencing', () => {
  it('runs every step in order and reports success', async () => {
    const { driver, calls } = scriptedDriver();
    const workflow = wf([
      step('openUrl', { url: 'https://example.com' }),
      step('click', { locator: css('#go') }),
      step('type', { locator: css('#q'), text: 'hello' }),
    ]);
    const { runner, persistence } = setup(workflow, driver);
    const result = await runner.execute();

    expect(result.status).toBe('succeeded');
    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(driver.navigate).toHaveBeenCalledWith(7, 'https://example.com', 300, expect.anything());
    expect(calls.filter((c) => c.op !== 'probe' && c.op !== 'pageInfo').map((c) => c.op)).toEqual(['click', 'type']);
    expect(result.summary).toContain('3 of 3 steps succeeded');
    // Checkpoints were persisted, ending with the terminal state.
    expect(persistence.saves.length).toBeGreaterThanOrEqual(2);
    expect(persistence.runs.get(result.id)?.status).toBe('succeeded');
  });

  it('records disabled steps as skipped without executing them', async () => {
    const { driver, calls } = scriptedDriver();
    const workflow = wf([step('click', { locator: css('#a') }), step('click', { locator: css('#b') }, { disabled: true })]);
    const result = await setup(workflow, driver).runner.execute();
    expect(result.steps[1]).toMatchObject({ status: 'skipped', message: 'Disabled' });
    expect(calls.some((c) => 'locator' in c && c.locator?.value === '#b')).toBe(false);
  });

  it('waits for the settle after navigating actions only', async () => {
    const { driver } = scriptedDriver();
    const workflow = wf([step('click', { locator: css('#a') }), step('clear', { locator: css('#b') })]);
    await setup(workflow, driver).runner.execute();
    expect(driver.waitForSettle).toHaveBeenCalledTimes(1);
  });

  it('resumes from a saved step index', async () => {
    const { driver, calls } = scriptedDriver();
    const workflow = wf([step('click', { locator: css('#1') }), step('click', { locator: css('#2') }), step('click', { locator: css('#3') })]);
    const run = createRunRecord(workflow, { target: { kind: 'tab', tabId: 3 } });
    run.currentStepIndex = 2;
    run.tabId = 3;
    run.steps[0].status = 'succeeded';
    run.steps[1].status = 'succeeded';
    const runner = new WorkflowRunner(run, {}, { driver, persistence: new MemoryPersistence(), options: FAST_ENGINE });
    const result = await runner.execute();
    expect(result.status).toBe('succeeded');
    expect(driver.prepareTab).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === 'click').map((c) => (c as { locator: { value: string } }).locator.value)).toEqual(['#3']);
  });
});

describe('WorkflowRunner — failures and policies', () => {
  it('retries a failing step up to the retry limit', async () => {
    let failures = 2;
    const { driver } = scriptedDriver({
      click: () => {
        if (failures-- > 0) throw new FlowError('ELEMENT_NOT_VISIBLE', 'not visible');
        return { message: 'Clicked' };
      },
    });
    const workflow = wf([step('click', { locator: css('#a') }, { retries: 2 })]);
    const result = await setup(workflow, driver).runner.execute();
    expect(result.status).toBe('succeeded');
    expect(result.steps[0].attempts).toBe(3);
  });

  it('stops the run on failure with policy "stop" and identifies the step', async () => {
    const { driver } = scriptedDriver({ click: () => Promise.reject(new FlowError('ELEMENT_DISABLED', '#b is disabled')) });
    const workflow = wf([step('clear', { locator: css('#a') }), step('click', { locator: css('#b') }), step('clear', { locator: css('#c') })]);
    const result = await setup(workflow, driver).runner.execute();
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ stepIndex: 1, stepId: workflow.steps[1].id, code: 'ELEMENT_DISABLED' });
    expect(result.steps.map((s) => s.status)).toEqual(['succeeded', 'failed', 'pending']);
    expect(result.summary).toContain('#b is disabled');
  });

  it('skips the failed step and continues with policy "skip"', async () => {
    const { driver } = scriptedDriver({ click: () => Promise.reject(new FlowError('UNKNOWN', 'boom')) });
    const workflow = wf([step('click', { locator: css('#a') }, { onError: 'skip' }), step('clear', { locator: css('#b') })]);
    const result = await setup(workflow, driver).runner.execute();
    expect(result.status).toBe('succeeded');
    expect(result.steps[0]).toMatchObject({ status: 'skipped', errorCode: 'UNKNOWN' });
    expect(result.steps[0].message).toContain('Skipped after error: boom');
    expect(result.summary).toContain('1 skipped');
  });

  it.each([
    ['retry', 'succeeded', 'succeeded'],
    ['skip', 'succeeded', 'skipped'],
    ['stop', 'failed', 'failed'],
  ] as const)('asks the user with policy "ask" — answer %s', async (answer, runStatus, stepStatus) => {
    let fail = true;
    const { driver } = scriptedDriver({
      click: () => {
        if (fail) {
          fail = false;
          throw new FlowError('UNKNOWN', 'first attempt fails');
        }
        return { message: 'Clicked' };
      },
    });
    const workflow = wf([step('click', { locator: css('#a') }, { onError: 'ask' })]);
    const { runner, bus } = setup(workflow, driver);
    const done = runner.execute();
    const waiting = await bus.next((r) => r.status === 'waiting_for_user');
    expect(waiting.pendingPrompt).toMatchObject({ kind: 'error', stepIndex: 0 });
    expect(waiting.pendingPrompt!.message).toContain('first attempt fails');
    runner.respond(waiting.pendingPrompt!.id, { action: answer });
    const result = await done;
    expect(result.status).toBe(runStatus);
    expect(result.steps[0].status).toBe(stepStatus);
    expect(result.pendingPrompt).toBeUndefined();
  });

  it('does not retry fatal errors', async () => {
    const { driver } = scriptedDriver({
      probe: () => Promise.reject(new FlowError('INVALID_SELECTOR', 'bad selector', true)),
    });
    const workflow = wf([step('click', { locator: css('##') }, { retries: 5 })]);
    const result = await setup(workflow, driver).runner.execute();
    expect(result.status).toBe('failed');
    expect(result.steps[0].attempts).toBe(1);
    expect(result.error?.code).toBe('INVALID_SELECTOR');
  });

  it('auto-waits for an element that appears later', async () => {
    let probes = 0;
    const { driver } = scriptedDriver({
      probe: () => (++probes < 4 ? { count: 0, visible: false, enabled: false } : { count: 1, visible: true, enabled: true }),
    });
    const result = await setup(wf([step('click', { locator: css('#late') })]), driver).runner.execute();
    expect(result.status).toBe('succeeded');
    expect(probes).toBe(4);
  });

  it('reports a clear error when the element never appears', async () => {
    const { driver } = scriptedDriver({ probe: () => ({ count: 0, visible: false, enabled: false }) });
    const result = await setup(wf([step('click', { locator: css('#missing') })]), driver).runner.execute();
    expect(result.error).toMatchObject({ code: 'ELEMENT_NOT_FOUND', stepIndex: 0 });
    expect(result.error!.message).toMatch(/No element matches #missing after waiting 0.3s/);
  });

  it('times out a step that hangs', async () => {
    const { driver } = scriptedDriver({ click: () => new Promise(() => undefined) });
    const workflow = wf([step('click', { locator: css('#a') }, { timeoutMs: 100 })]);
    const result = await setup(workflow, driver).runner.execute();
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('TIMEOUT');
  });

  it('fails when the tab is closed and does not retry', async () => {
    const { driver } = scriptedDriver({ probe: () => Promise.reject(new FlowError('TAB_CLOSED', 'The tab used by this run was closed', true)) });
    const result = await setup(wf([step('click', { locator: css('#a') }, { retries: 3 })]), driver).runner.execute();
    expect(result.error?.code).toBe('TAB_CLOSED');
    expect(result.steps[0].attempts).toBe(1);
  });
});

describe('WorkflowRunner — controls', () => {
  it('pauses between steps and resumes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { driver } = scriptedDriver({ clear: async () => (await gate, { message: 'Cleared' }) });
    const workflow = wf([step('clear', { locator: css('#a') }), step('click', { locator: css('#b') })]);
    const { runner, bus } = setup(workflow, driver);
    const done = runner.execute();
    await bus.next((r) => r.steps[0].status === 'running');
    runner.pause();
    release();
    const paused = await bus.next((r) => r.status === 'paused');
    expect(paused.steps.map((s) => s.status)).toEqual(['succeeded', 'pending']);
    runner.resume();
    expect((await done).status).toBe('succeeded');
  });

  it('stops immediately, even mid-wait', async () => {
    const workflow = wf([step('wait', { mode: 'duration', durationMs: 10_000 }), step('click', { locator: css('#b') })]);
    const { runner, bus } = setup(workflow, scriptedDriver().driver);
    const done = runner.execute();
    await bus.next((r) => r.steps[0].status === 'running');
    runner.stop();
    const result = await done;
    expect(result.status).toBe('stopped');
    expect(result.summary).toContain('Stopped by you');
    expect(result.steps.map((s) => s.status)).toEqual(['skipped', 'pending']);
  });
});

describe('WorkflowRunner — variables and data', () => {
  it('passes extracted values to later steps and records results', async () => {
    const { driver, calls } = scriptedDriver({ extractText: () => ({ text: 'ORD-42', count: 1 }) });
    const workflow = wf([
      step('extractText', { locator: css('#order'), variable: 'order' }),
      step('type', { locator: css('#q'), text: 'Order {{order}} on {{date}}' }),
    ]);
    const result = await setup(workflow, driver).runner.execute();
    const typed = calls.find((c) => c.op === 'type') as { text: string };
    expect(typed.text).toMatch(/^Order ORD-42 on \d{4}-\d{2}-\d{2}$/);
    expect(result.variables.order).toBe('ORD-42');
    expect(result.results).toEqual([{ stepId: workflow.steps[0].id, stepIndex: 0, variable: 'order', value: 'ORD-42', kind: 'text' }]);
  });

  it('uses run-start inputs over defaults', async () => {
    const { driver, calls } = scriptedDriver();
    const workflow = wf([step('type', { locator: css('#q'), text: '{{name}}' })], {
      variables: [{ name: 'name', defaultValue: 'default', askAtRunStart: true }],
    });
    await setup(workflow, driver, { name: 'from input' }).runner.execute();
    expect((calls.find((c) => c.op === 'type') as { text: string }).text).toBe('from input');
  });

  it('fails without retrying when a variable has no value', async () => {
    const { driver } = scriptedDriver();
    const result = await setup(wf([step('type', { locator: css('#q'), text: '{{nope}}' }, { retries: 3 })]), driver).runner.execute();
    expect(result.error?.code).toBe('MISSING_VARIABLE');
    expect(result.steps[0].attempts).toBe(1);
  });

  it('never persists secret values or typed text', async () => {
    const { driver } = scriptedDriver({ type: () => ({ message: 'Entered a value into #pw (verified)', sensitive: true }) });
    const workflow = wf([step('type', { locator: css('#pw'), text: '{{password}}' }), step('type', { locator: css('#note'), text: 'plain-typed-text' })], {
      variables: [{ name: 'password', defaultValue: '', secret: true, askAtRunStart: true }],
    });
    const { runner, persistence, bus } = setup(workflow, driver, { password: 'hunter2-SECRET' });
    const result = await runner.execute();
    expect(result.status).toBe('succeeded');
    expect(result.variables.password).toBe(SECRET_MASK);
    const everything = JSON.stringify([persistence.saves, bus.history]);
    expect(everything).not.toContain('hunter2-SECRET');
    // Typed text lives only in the workflow definition snapshot, never in step results.
    expect(JSON.stringify(result.steps)).not.toContain('plain-typed-text');
  });

  it('rejects javascript: URLs produced by variables at run time', async () => {
    const { driver } = scriptedDriver();
    const workflow = wf([step('openUrl', { url: '{{target}}' })], { variables: [{ name: 'target', defaultValue: 'javascript:alert(1)' }] });
    const result = await setup(workflow, driver).runner.execute();
    expect(result.error?.code).toBe('INVALID_URL');
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it('stores screenshots as artifacts', async () => {
    const { driver } = scriptedDriver();
    const { runner, persistence } = setup(wf([step('screenshot', { label: 'home' })]), driver);
    const result = await runner.execute();
    expect(result.results[0]).toMatchObject({ kind: 'screenshot', variable: 'home', artifactId: 'art_1' });
    expect(persistence.artifacts.get('art_1')).toMatchObject({ runId: result.id, label: 'home' });
  });
});

describe('WorkflowRunner — user interaction steps', () => {
  it('continues after the user confirms', async () => {
    const { runner, bus } = setup(wf([step('confirm', { message: 'Proceed?' }), step('clear', { locator: css('#a') })]), scriptedDriver().driver);
    const done = runner.execute();
    const waiting = await bus.next((r) => !!r.pendingPrompt);
    expect(waiting.pendingPrompt).toMatchObject({ kind: 'confirm', message: 'Proceed?' });
    runner.respond(waiting.pendingPrompt!.id, { action: 'continue' });
    expect((await done).status).toBe('succeeded');
  });

  it('stops (not fails) when the user declines', async () => {
    const { runner, bus } = setup(wf([step('confirm', { message: 'Proceed?' }), step('clear', { locator: css('#a') })]), scriptedDriver().driver);
    const done = runner.execute();
    const waiting = await bus.next((r) => !!r.pendingPrompt);
    runner.respond(waiting.pendingPrompt!.id, { action: 'cancel' });
    const result = await done;
    expect(result.status).toBe('stopped');
    expect(result.steps[1].status).toBe('pending');
  });

  it('does not time out while waiting for the user', async () => {
    const workflow = wf([step('confirm', { message: 'Slow user' }, { timeoutMs: 100 })]);
    const { runner, bus } = setup(workflow, scriptedDriver().driver);
    const done = runner.execute();
    const waiting = await bus.next((r) => !!r.pendingPrompt);
    await new Promise((r) => setTimeout(r, 1_800));
    runner.respond(waiting.pendingPrompt!.id, { action: 'continue' });
    expect((await done).status).toBe('succeeded');
  });

  it('asks before a step flagged confirmBefore and honours skip', async () => {
    const { driver, calls } = scriptedDriver();
    const { runner, bus } = setup(wf([step('click', { locator: css('#buy') }, { confirmBefore: true })]), driver);
    const done = runner.execute();
    const waiting = await bus.next((r) => !!r.pendingPrompt);
    expect(waiting.pendingPrompt!.kind).toBe('confirmBefore');
    runner.respond(waiting.pendingPrompt!.id, { action: 'skip' });
    const result = await done;
    expect(result.steps[0]).toMatchObject({ status: 'skipped', message: 'Skipped by you' });
    expect(calls.some((c) => c.op === 'click')).toBe(false);
  });

  it('offers interpolated text for copying and completes only after the user copies', async () => {
    const { driver } = scriptedDriver({ extractText: () => ({ text: 'Total: 9', count: 1 }) });
    const workflow = wf([step('extractText', { locator: css('#t'), variable: 'total' }), step('copyToClipboard', { template: 'Result — {{total}}' })]);
    const { runner, bus } = setup(workflow, driver);
    const done = runner.execute();
    const waiting = await bus.next((r) => r.pendingPrompt?.kind === 'clipboard');
    expect(waiting.pendingPrompt!.text).toBe('Result — Total: 9');
    runner.respond(waiting.pendingPrompt!.id, { action: 'copied' });
    const result = await done;
    expect(result.steps[1]).toMatchObject({ status: 'succeeded' });
  });

  it('ends the run from a stop step with the configured outcome', async () => {
    const failing = await setup(
      wf([step('stop', { outcome: 'failed', message: 'Nothing to do' }), step('clear', { locator: css('#a') })]),
      scriptedDriver().driver,
    ).runner.execute();
    expect(failing.status).toBe('failed');
    expect(failing.error).toMatchObject({ code: 'STOPPED_BY_STEP', message: 'Nothing to do', stepIndex: 0 });
    expect(failing.steps[1].status).toBe('pending');

    const ok = await setup(wf([step('stop', { outcome: 'succeeded', message: 'Done early' })]), scriptedDriver().driver).runner.execute();
    expect(ok.status).toBe('succeeded');
  });
});
