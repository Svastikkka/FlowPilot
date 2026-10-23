import { describe, expect, it, vi } from 'vitest';
import { RunManager } from '../../src/background/runManager';
import type { RunManagerDeps } from '../../src/background/runManager';
import { createRunRecord, SECRET_MASK } from '../../src/engine/runner';
import type { MonitorEvent } from '../../src/shared/messages';
import type { RunRecord, Workflow } from '../../src/shared/schema/types';
import { JsdomBrowser } from '../helpers/jsdomBrowser';
import { css, MemoryPersistence, step, wf } from '../helpers/fakes';

const PAGES = {
  'https://shop.test/': '<h1>Shop</h1><input id="q" /><button id="go">Go</button>',
};

function makeManager(workflows: Workflow[], extra: Partial<RunManagerDeps> = {}) {
  const persistence = new MemoryPersistence();
  const browser = new JsdomBrowser(PAGES);
  const lastRuns: RunRecord[] = [];
  const deps: RunManagerDeps = {
    driver: browser,
    persistence,
    getWorkflow: async (id) => workflows.find((w) => w.id === id),
    getRun: async (id) => persistence.runs.get(id),
    listRuns: async () => [...persistence.runs.values()],
    recordLastRun: async (r) => void lastRuns.push(r),
    pruneHistory: vi.fn(async () => 0),
    getSettings: async () => ({ highlightElements: false, historyLimit: 50 }),
    openMonitor: vi.fn(),
    tabExists: async (id) => browser.tabs.has(id) && !browser.tabs.get(id)!.closed,
    keepAlive: vi.fn(),
    ...extra,
  };
  return { manager: new RunManager(deps), persistence, browser, deps, lastRuns };
}

async function settle(persistence: MemoryPersistence, runId: string): Promise<RunRecord> {
  for (let i = 0; i < 200; i++) {
    const r = persistence.runs.get(runId);
    if (r && ['succeeded', 'failed', 'stopped'].includes(r.status)) {
      await new Promise((res) => setTimeout(res, 5));
      return persistence.runs.get(runId)!;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('run did not finish');
}

describe('RunManager', () => {
  it('refuses to start an invalid workflow', async () => {
    const bad = wf([step('click', { locator: css('') })]);
    const { manager } = makeManager([bad]);
    await expect(manager.start(bad.id, { kind: 'newTab' }, {})).rejects.toThrow('Fix 1 problem in the editor before running');
  });

  it('runs a workflow, broadcasts updates to ports and records the last run', async () => {
    const w = wf([step('openUrl', { url: 'https://shop.test/' }), step('type', { locator: css('#q'), text: 'socks' })]);
    const { manager, persistence, lastRuns, deps } = makeManager([w]);
    const events: MonitorEvent[] = [];
    manager.addPort({ postMessage: (e) => events.push(e) });
    const runId = await manager.start(w.id, { kind: 'newTab' }, {});
    const final = await settle(persistence, runId);
    expect(final.status).toBe('succeeded');
    expect(events[0]).toEqual({ type: 'hello', activeRunIds: [] });
    expect(events.filter((e) => e.type === 'run.update').length).toBeGreaterThanOrEqual(2);
    expect(lastRuns.map((r) => r.id)).toContain(runId);
    expect(deps.pruneHistory).toHaveBeenCalledWith(50);
    expect(manager.activeRunIds()).toEqual([]);
  });

  it('opens the monitor when a prompt needs an answer and no UI is connected', async () => {
    const w = wf([step('openUrl', { url: 'https://shop.test/' }), step('confirm', { message: 'OK?' })]);
    const { manager, persistence, deps } = makeManager([w]);
    const runId = await manager.start(w.id, { kind: 'newTab' }, {});
    await vi.waitFor(() => expect(persistence.runs.get(runId)?.pendingPrompt).toBeDefined());
    expect(deps.openMonitor).toHaveBeenCalledWith(runId);
    manager.respond(runId, persistence.runs.get(runId)!.pendingPrompt!.id, { action: 'continue' });
    expect((await settle(persistence, runId)).status).toBe('succeeded');
    expect(() => manager.respond(runId, 'p_old', { action: 'continue' })).toThrow('no longer active');
  });

  it('tests a single step in a reusable test tab, carrying variables between tests', async () => {
    const extract = step('extractText', { locator: css('h1'), variable: 'title' });
    const typeIt = step('type', { locator: css('#q'), text: '{{title}}' });
    const w = wf([step('openUrl', { url: 'https://shop.test/' }), extract, typeIt]);
    const { manager, persistence, browser } = makeManager([w]);

    const r1 = await settle(persistence, await manager.testStep(w.id, w.steps[0].id));
    expect(r1).toMatchObject({ mode: 'testStep', status: 'succeeded', workflowName: 'Test: Open URL' });
    await settle(persistence, await manager.testStep(w.id, extract.id));
    const r3 = await settle(persistence, await manager.testStep(w.id, typeIt.id));
    expect(r3.status).toBe('succeeded');
    expect(browser.tabs.size).toBe(1);
    expect((browser.document(r1.tabId!).getElementById('q') as HTMLInputElement).value).toBe('Shop');
  });

  it('marks runs orphaned by a worker restart as interrupted and resumes them', async () => {
    const w = wf(
      [step('openUrl', { url: 'https://shop.test/' }), step('type', { locator: css('#q'), text: '{{term}} {{pin}}' }), step('click', { locator: css('#go') })],
      { variables: [{ name: 'term', defaultValue: 'x' }, { name: 'pin', defaultValue: '', secret: true, askAtRunStart: true }] },
    );
    const { manager, persistence, browser, lastRuns } = makeManager([w]);
    const tabId = browser.openTab('https://shop.test/');
    // Simulate a run persisted mid-way by a worker that was then terminated.
    const orphan: RunRecord = {
      ...createRunRecord(w, { target: { kind: 'newTab' } }),
      status: 'running',
      tabId,
      currentStepIndex: 1,
      variables: { term: 'wool', pin: SECRET_MASK },
    };
    orphan.steps[0].status = 'succeeded';
    orphan.steps[1].status = 'running';
    await persistence.saveRun(orphan);

    const recovered = await manager.recover();
    expect(recovered.map((r) => r.id)).toEqual([orphan.id]);
    const saved = persistence.runs.get(orphan.id)!;
    expect(saved.status).toBe('interrupted');
    expect(saved.steps[1].status).toBe('pending');
    expect(saved.summary).toContain('at step 2');
    expect(lastRuns.at(-1)?.status).toBe('interrupted');

    const resumedId = await manager.resumeInterrupted(orphan.id, { pin: '1234' });
    const resumed = await settle(persistence, resumedId);
    expect(resumed).toMatchObject({ status: 'succeeded', resumedFrom: orphan.id, tabId });
    expect(resumed.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect((browser.document(tabId).getElementById('q') as HTMLInputElement).value).toBe('wool 1234');
  });

  it('runs the keep-alive timer only while runs are active', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const w = wf([step('openUrl', { url: 'https://shop.test/' }), step('confirm', { message: 'wait' })]);
      const { manager, persistence, deps } = makeManager([w]);
      const runId = await manager.start(w.id, { kind: 'newTab' }, {});
      await vi.waitFor(() => expect(persistence.runs.get(runId)?.pendingPrompt).toBeDefined());
      vi.advanceTimersByTime(45_000);
      expect(deps.keepAlive).toHaveBeenCalledTimes(2);
      manager.stop(runId);
      await settle(persistence, runId);
      vi.advanceTimersByTime(60_000);
      expect(deps.keepAlive).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
