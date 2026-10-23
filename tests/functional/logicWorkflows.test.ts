import { describe, expect, it, vi } from 'vitest';
import type { Step, Workflow } from '../../src/shared/schema/types';
import { validateWorkflow } from '../../src/shared/schema/validate';
import { templateById } from '../../src/templates';
import { RunManager } from '../../src/background/runManager';
import { JsdomBrowser } from '../helpers/jsdomBrowser';
import { runWorkflow } from '../helpers/run';
import { css, FAST_SETTINGS, MemoryPersistence, step, wf } from '../helpers/fakes';

// Logic & data features end to end: real engine + real content-script DOM
// code against jsdom sites.

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const fast = (w: Workflow): Workflow => ({ ...w, settings: { ...w.settings, ...FAST_SETTINGS, defaultTimeoutMs: 500 } });
const block = <T extends Step>(s: T, children: Step[], elseChildren?: Step[]): T => ({ ...s, children, ...(elseChildren ? { elseChildren } : {}) });

const ORDER_FORM = page(
  'Order form',
  `<form action="/post"><input name="custname"><input name="custemail"><textarea name="comments"></textarea><button>Submit order</button></form>`,
);

describe('templates with loops', () => {
  it('Scrape a list into a table: collects every item into the results table', async () => {
    const browser = new JsdomBrowser({
      'https://news.ycombinator.com/': page(
        'Hacker News',
        `<table>${['  First story ', 'Second story', 'Third story']
          .map((t, i) => `<tr><td><span class="titleline"><a href="/item?id=${i}">${t}</a></span></td></tr>`)
          .join('')}</table>`,
      ),
    });
    const template = fast(templateById('scrape-list')!.build());
    expect(validateWorkflow(template).errors).toEqual([]);
    const { result } = await runWorkflow(template, browser);
    expect(result.status).toBe('succeeded');
    expect(result.table).toEqual({
      columns: ['rank', 'title'],
      rows: [
        { rank: '1', title: 'First story' },
        { rank: '2', title: 'Second story' },
        { rank: '3', title: 'Third story' },
      ],
    });
    const loop = template.steps[1];
    expect(result.steps.find((s) => s.stepId === loop.id)!.message).toContain('3 iterations');
  });

  it('Fill a form for each CSV row: submits once per row and records each', async () => {
    const submissions: URLSearchParams[] = [];
    const browser = new JsdomBrowser({
      'https://httpbin.org/forms/post': ORDER_FORM,
      'https://httpbin.org/post': (url) => {
        submissions.push(url.searchParams);
        return page('Done', '<h1>Thanks</h1>');
      },
    });
    const template = fast(templateById('csv-form-fill')!.build());
    expect(validateWorkflow(template).errors).toEqual([]);
    const { result } = await runWorkflow(template, browser);
    expect(result.status).toBe('succeeded');
    expect(submissions.map((p) => [p.get('custname'), p.get('custemail'), p.get('comments')])).toEqual([
      ['Ada Lovelace', 'ada@example.com', 'First row'],
      ['Grace Hopper', 'grace@example.com', 'Second row'],
    ]);
    expect(result.table!.rows).toEqual([
      { row: '1', email: 'ada@example.com', status: 'submitted' },
      { row: '2', email: 'grace@example.com', status: 'submitted' },
    ]);
  });

  it('Fill a form for each CSV row: stops with a clear message when the site reports an error', async () => {
    const browser = new JsdomBrowser({
      'https://httpbin.org/forms/post': ORDER_FORM,
      'https://httpbin.org/post': (url) => page('Result', url.searchParams.get('custemail')!.startsWith('grace') ? '<p>Validation error: email taken</p>' : '<h1>Thanks</h1>'),
    });
    const { result } = await runWorkflow(fast(templateById('csv-form-fill')!.build()), browser);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'STOPPED_BY_STEP', message: 'The site reported an error for row 2' });
    expect(result.table!.rows).toHaveLength(1);
  });
});

describe('logic against real DOM', () => {
  it('dismisses an optional cookie banner only when it is shown', async () => {
    const withBanner = new JsdomBrowser({
      'https://site.test/': page('Site', '<div id="cookies">We use cookies <button id="accept">Accept</button></div><main id="content">Hello</main>'),
    });
    withBanner.onLoad = (_u, w) => w.document.getElementById('accept')!.addEventListener('click', () => w.document.getElementById('cookies')!.remove());
    const noBanner = new JsdomBrowser({ 'https://site.test/': page('Site', '<main id="content">Hello</main>') });
    const workflow = wf([
      step('openUrl', { url: 'https://site.test/' }),
      block(step('if', { condition: 'elementVisible', locator: css('#cookies') }), [step('click', { locator: css('#accept') })]),
      step('extractText', { locator: css('#content'), variable: 'text' }),
    ]);
    const a = await runWorkflow(workflow, withBanner);
    const b = await runWorkflow(workflow, noBanner);
    expect([a.result.status, b.result.status]).toEqual(['succeeded', 'succeeded']);
    expect(withBanner.document(a.tabId).getElementById('cookies')).toBeNull();
    expect(b.result.steps.find((s) => s.stepId === workflow.steps[1].children![0].id)!.status).toBe('skipped');
  });

  it('pages through results with While + "next" link until there is no next page', async () => {
    const pageHtml = (n: number) =>
      page(`Page ${n}`, `<ul>${[1, 2].map((i) => `<li class="r">p${n}-${i}</li>`).join('')}</ul>${n < 3 ? `<a id="next" href="/list?page=${n + 1}">Next</a>` : ''}`);
    const browser = new JsdomBrowser({ 'https://shop.test/list': (url) => pageHtml(Number(url.searchParams.get('page') ?? 1)) });
    const workflow = wf([
      step('openUrl', { url: 'https://shop.test/list?page=1' }),
      block(step('repeat', { times: 10, loopVariable: 'pg' }), [
        block(step('forEachElement', { locator: css('li.r'), loopVariable: 'item' }), [step('addRow', { columns: [{ name: 'item', value: '{{item}}' }] })]),
        block(step('if', { condition: 'elementMissing', locator: css('#next') }), [step('break')]),
        step('click', { locator: css('#next') }),
      ]),
    ]);
    const { result } = await runWorkflow(workflow, browser);
    expect(result.status).toBe('succeeded');
    expect(result.table!.rows.map((r) => r.item)).toEqual(['p1-1', 'p1-2', 'p2-1', 'p2-2', 'p3-1', 'p3-2']);
  });

  it('acts on each element through {{item_selector}}', async () => {
    const browser = new JsdomBrowser({
      'https://todo.test/': page('Todo', '<ul><li><input type="checkbox"> Milk</li><li><input type="checkbox"> Eggs</li><li><input type="checkbox"> Bread</li></ul>'),
    });
    const workflow = wf([
      step('openUrl', { url: 'https://todo.test/' }),
      block(step('forEachElement', { locator: css('li'), loopVariable: 'todo' }), [
        block(step('if', { condition: 'variable', variable: 'todo', operator: 'notContains', value: 'eggs' }), [
          step('check', { locator: css('{{todo_selector}} input'), checked: true }),
        ]),
      ]),
    ]);
    const { result, tabId } = await runWorkflow(workflow, browser);
    expect(result.status).toBe('succeeded');
    const boxes = Array.from(browser.document(tabId).querySelectorAll('input')).map((i) => (i as HTMLInputElement).checked);
    expect(boxes).toEqual([true, false, true]);
  });
});

describe('run-time data', () => {
  it('runs against a CSV supplied at run start instead of the stored table', async () => {
    const submissions: string[] = [];
    const browser = new JsdomBrowser({
      'https://httpbin.org/forms/post': ORDER_FORM,
      'https://httpbin.org/post': (url) => (submissions.push(url.searchParams.get('custname')!), page('Done', '<h1>Thanks</h1>')),
    });
    const workflow = fast(templateById('csv-form-fill')!.build());
    const persistence = new MemoryPersistence();
    const manager = new RunManager({
      driver: browser,
      persistence,
      getWorkflow: async () => workflow,
      getRun: async (id) => persistence.runs.get(id),
      listRuns: async () => [...persistence.runs.values()],
      recordLastRun: async () => undefined,
      pruneHistory: async () => 0,
      getSettings: async () => ({ highlightElements: false, historyLimit: 50 }),
      openMonitor: vi.fn(),
      tabExists: async () => true,
      keepAlive: vi.fn(),
    });
    const runId = await manager.start(workflow.id, { kind: 'newTab' }, {}, { columns: ['name', 'email', 'comments'], rows: [['Katherine Johnson', 'kj@nasa.test', 'x']] });
    await vi.waitFor(() => expect(persistence.runs.get(runId)?.status).toBe('succeeded'), { timeout: 5000 });
    expect(submissions).toEqual(['Katherine Johnson']);
    await expect(manager.start(workflow.id, { kind: 'newTab' }, {}, { columns: ['bad column!'], rows: [] })).rejects.toThrow('not a valid table');
  });
});
