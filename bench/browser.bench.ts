import { test, chromium } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RunRecord, Step } from '../src/shared/schema/types';
import { DEFAULT_WORKFLOW_SETTINGS } from '../src/shared/schema/factory';
import { startBenchSite } from './site';
import type { BenchSite } from './site';
import { SCENARIOS } from './scenarios';
import type { Scenario } from './scenarios';

// Reliability + speed benchmark: runs every scenario several times through the
// real, built extension (service worker, content script, IndexedDB) in
// Chromium, and writes bench/results/browser.json.

const ATTEMPTS = Number(process.env.BENCH_ATTEMPTS ?? 3);
const RUN_TIMEOUT_MS = 120_000;
const OUT = resolve('bench/results');

export interface AttemptResult {
  passed: boolean;
  reason?: string;
  status: string;
  durationMs: number;
  steps: number;
}

export interface ScenarioResult {
  id: string;
  title: string;
  category: string;
  expected: Scenario['expected'];
  attempts: AttemptResult[];
}

async function launch(): Promise<{ context: BrowserContext; base: string; cleanup(): void }> {
  const ext = mkdtempSync(join(tmpdir(), 'fp-bench-ext-'));
  cpSync(resolve('dist'), ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
  const profile = mkdtempSync(join(tmpdir(), 'fp-bench-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  return {
    context,
    base: `chrome-extension://${new URL(worker.url()).host}`,
    cleanup: () => {
      rmSync(ext, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Helpers that run inside the extension's own page (same origin as its storage). */
const ext = {
  saveWorkflow: (app: Page, workflow: unknown) =>
    app.evaluate(
      (wf) =>
        new Promise<void>((ok, fail) => {
          const req = indexedDB.open('flowpilot');
          req.onerror = () => fail(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction('workflows', 'readwrite');
            tx.objectStore('workflows').put(wf);
            tx.oncomplete = () => (req.result.close(), ok());
            tx.onerror = () => fail(tx.error);
          };
        }),
      workflow,
    ),
  getRun: (app: Page, runId: string) =>
    app.evaluate(
      (id) =>
        new Promise<RunRecord | undefined>((ok, fail) => {
          const req = indexedDB.open('flowpilot');
          req.onerror = () => fail(req.error);
          req.onsuccess = () => {
            const get = req.result.transaction('runs').objectStore('runs').get(id);
            get.onsuccess = () => (req.result.close(), ok(get.result as RunRecord | undefined));
            get.onerror = () => fail(get.error);
          };
        }),
      runId,
    ),
  command: <T>(app: Page, command: unknown) =>
    app.evaluate(async (cmd) => {
      const res = (await chrome.runtime.sendMessage({ channel: 'flowpilot.command', command: cmd })) as { ok: boolean; data?: unknown; error?: { message: string } };
      if (!res?.ok) throw new Error(res?.error?.message ?? 'no response');
      return res.data;
    }, command) as Promise<T>,
  recording: (app: Page) =>
    app.evaluate(async () => (await chrome.storage.session.get('recording')).recording as { steps: Step[]; variables: unknown[]; status: string } | undefined),
};

async function closeOtherPages(context: BrowserContext, keep: Page) {
  for (const p of context.pages()) if (p !== keep) await p.close().catch(() => undefined);
}

async function recordSteps(context: BrowserContext, app: Page, scenario: Scenario, base: string): Promise<Step[]> {
  const rec = scenario.record!;
  const url = rec.url(base);
  await ext.command(app, { type: 'recorder.start', url });
  // Find the recording tab by address: other tabs (e.g. the welcome page) can open at the same time.
  let tab: Page | undefined;
  for (const deadline = Date.now() + 15_000; !tab && Date.now() < deadline; ) {
    tab = context.pages().find((p) => p.url().startsWith(url));
    if (!tab) await app.waitForTimeout(100);
  }
  if (!tab) throw new Error('the recording tab did not open');
  await tab.waitForLoadState();
  try {
    await tab.locator('#flowpilot-recording-badge').waitFor({ state: 'attached', timeout: 15_000 });
  } catch (err) {
    if (process.env.BENCH_DEBUG) {
      const session = await ext.recording(app);
      const info = await app.evaluate(async (tabUrl) => {
        const tabs = await chrome.tabs.query({});
        return tabs.map((t) => ({ id: t.id, status: t.status, url: t.url, match: t.url === tabUrl }));
      }, tab.url());
      console.log('DEBUG initial attach failed', JSON.stringify({ url: tab.url(), session: session && { status: session.status, steps: session.steps.length, tabId: (session as { tabId?: number }).tabId, blocked: (session as { blockedHost?: string }).blockedHost }, tabs: info }));
    }
    throw err;
  }
  await rec.perform(tab);
  try {
    await tab.locator('#flowpilot-recording-badge').waitFor({ state: 'attached', timeout: 15_000 });
  } catch (err) {
    if (process.env.BENCH_DEBUG) {
      const session = await ext.recording(app);
      console.log('DEBUG reattach failed', { url: tab.url(), status: session?.status, steps: session?.steps.map((s) => s.type), blocked: (session as { blockedHost?: string } | undefined)?.blockedHost });
    }
    throw err;
  }
  await ext.command(app, { type: 'recorder.stop' });
  const session = await ext.recording(app);
  await ext.command(app, { type: 'recorder.discard' });
  const steps = session?.steps ?? [];
  // Replay on the target page.
  const first = steps.find((s) => s.type === 'openUrl');
  if (first && first.type === 'openUrl') first.params.url = rec.replayUrl(base);
  return steps;
}

async function runAttempt(context: BrowserContext, app: Page, site: BenchSite, scenario: Scenario, attempt: number): Promise<AttemptResult> {
  site.reset();
  const started = Date.now();
  try {
    const parts = scenario.record ? { steps: await recordSteps(context, app, scenario, site.url) } : scenario.workflow(site.url);
    site.reset(); // ignore the recording's own submission
    const now = Date.now();
    const workflow = {
      schemaVersion: 2,
      id: `bench-${scenario.id}-${attempt}`,
      name: `Bench: ${scenario.title}`,
      description: '',
      tags: ['benchmark'],
      favorite: false,
      variables: [],
      settings: { ...DEFAULT_WORKFLOW_SETTINGS },
      createdAt: now,
      updatedAt: now,
      ...parts,
    };
    await ext.saveWorkflow(app, workflow);
    const { runId } = await ext.command<{ runId: string }>(app, { type: 'run.start', workflowId: workflow.id, target: { kind: 'newTab' }, inputs: {} });
    let run: RunRecord | undefined;
    for (const deadline = Date.now() + RUN_TIMEOUT_MS; Date.now() < deadline; ) {
      run = await ext.getRun(app, runId);
      if (run && ['succeeded', 'failed', 'stopped', 'interrupted'].includes(run.status)) break;
      await app.waitForTimeout(150);
    }
    if (!run || !run.finishedAt) return { passed: false, reason: 'timed out', status: run?.status ?? 'unknown', durationMs: Date.now() - started, steps: 0 };
    const reason = scenario.verify(run, site);
    const executed = run.steps.reduce((sum, s) => sum + (s.executions ?? (s.status === 'pending' ? 0 : 1)), 0);
    return { passed: reason === null, reason: reason ?? undefined, status: run.status, durationMs: run.finishedAt - run.startedAt, steps: executed };
  } catch (err) {
    return { passed: false, reason: `harness error: ${(err as Error).message.split('\n')[0]}`, status: 'error', durationMs: Date.now() - started, steps: 0 };
  } finally {
    await closeOtherPages(context, app);
  }
}

test('FlowPilot browser benchmark', async () => {
  test.setTimeout(30 * 60_000);
  const only = process.env.BENCH_ONLY?.split(',');
  const site = await startBenchSite();
  const { context, base, cleanup } = await launch();
  const results: ScenarioResult[] = [];
  try {
    const app = await context.newPage();
    await app.goto(`${base}/app.html#/`);
    await app.waitForLoadState();
    for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
      const attempts: AttemptResult[] = [];
      // Known-unsupported scenarios only need one attempt to show whether they still fail.
      const count = scenario.expected === 'unsupported' ? 1 : ATTEMPTS;
      for (let i = 0; i < count; i++) attempts.push(await runAttempt(context, app, site, scenario, i));
      const passed = attempts.filter((a) => a.passed).length;
      console.log(`${passed === attempts.length ? '✓' : passed ? '~' : '✗'} ${scenario.id}: ${passed}/${attempts.length}${attempts.find((a) => !a.passed)?.reason ? ` — ${attempts.find((a) => !a.passed)!.reason}` : ''}`);
      results.push({ id: scenario.id, title: scenario.title, category: scenario.category, expected: scenario.expected, attempts });
    }
  } finally {
    await context.close();
    site.server.close();
    cleanup();
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, 'browser.json'),
    JSON.stringify({ kind: 'browser', createdAt: new Date().toISOString(), chromium: chromium.name(), attemptsPerScenario: ATTEMPTS, scenarios: results }, null, 2),
  );
});
