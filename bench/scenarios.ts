import type { Page } from '@playwright/test';
import type { RunRecord } from '../src/shared/schema/types';
import type { BenchSite } from './site';

// Benchmark scenarios. Each one is a workflow built the way a user would build
// it (default settings, no special tuning), plus a check of what "worked"
// means. Scenarios marked `unsupported` document known limits: they are
// reported but never fail the benchmark, and are flagged if they start passing.

export type Category = 'waiting' | 'forms' | 'data' | 'robustness' | 'limits';

export interface Scenario {
  id: string;
  title: string;
  category: Category;
  expected: 'pass' | 'unsupported';
  /** Workflow parts; ids, timestamps and default settings are filled in by the harness. */
  workflow(base: string): { steps: unknown[]; data?: { columns: string[]; rows: string[][] }; variables?: unknown[] };
  /** Robustness scenarios: record these actions first, then replay the recording on `replayUrl`. */
  record?: { url(base: string): string; perform(page: Page): Promise<void>; replayUrl(base: string): string };
  /** Returns null when the run did what it should, otherwise the reason it didn't. */
  verify(run: RunRecord, site: BenchSite): string | null;
}

let n = 0;
const id = () => `b${++n}`;
const css = (value: string) => ({ strategy: 'css', value });
const text = (value: string) => ({ strategy: 'text', value });
const label = (value: string) => ({ strategy: 'label', value });
const s = (type: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: id(), type, params, ...extra });
const open = (url: string) => s('openUrl', { url });
const click = (locator: unknown) => s('click', { locator });
const type = (locator: unknown, value: string) => s('type', { locator, text: value, clearFirst: true, pressEnter: false });
const waitText = (value: string) => s('wait', { mode: 'textPresent', value });
const cond = (c: Record<string, unknown>) => ({ condition: 'elementExists', locator: css(''), value: '', variable: '', operator: 'equals', ...c });

const succeeded = (run: RunRecord) => (run.status === 'succeeded' ? null : `run ${run.status}: ${run.error?.message ?? run.summary ?? ''}`);
const lastSubmission = (site: BenchSite) => site.submissions.at(-1)?.params;

const record = (customer: string) => ({
  url: (base: string) => `${base}/record?variant=a`,
  async perform(page: Page) {
    await page.getByLabel('Name on order').click();
    await page.keyboard.type(customer);
    await page.getByText('Gift wrap').click();
    await page.getByRole('button', { name: 'Place order' }).click();
    await page.waitForURL(/\/submitted/);
  },
});

export const SCENARIOS: Scenario[] = [
  // --- waiting ---------------------------------------------------------------
  {
    id: 'delayed-element',
    title: 'Button appears 1.5 s after load',
    category: 'waiting',
    expected: 'pass',
    workflow: (b) => ({ steps: [open(`${b}/delayed`), click(css('#go')), waitText('continued')] }),
    verify: succeeded,
  },
  {
    id: 'slow-page',
    title: 'Server responds after 2 s',
    category: 'waiting',
    expected: 'pass',
    workflow: (b) => ({ steps: [open(`${b}/slow`), s('extractText', { locator: css('#title'), variable: 'title', all: false })] }),
    verify: (run) => succeeded(run) ?? (run.variables.title === 'Loaded slowly' ? null : `title was "${run.variables.title}"`),
  },
  {
    id: 'rerender',
    title: 'Button re-created by the page after load (framework re-render)',
    category: 'waiting',
    expected: 'pass',
    workflow: (b) => ({ steps: [open(`${b}/rerender`), click(text('Save')), waitText('saved')] }),
    verify: succeeded,
  },
  {
    id: 'spa-navigation',
    title: 'Single-page-app navigation renders after 400 ms',
    category: 'waiting',
    expected: 'pass',
    workflow: (b) => ({
      steps: [open(`${b}/spa`), click(text('Orders')), s('extractText', { locator: css('#count'), variable: 'count', all: false })],
    }),
    verify: (run) => succeeded(run) ?? (run.variables.count === '42' ? null : `count was "${run.variables.count}"`),
  },

  // --- forms -----------------------------------------------------------------
  {
    id: 'form-validation',
    title: 'Form with client-side validation, by field labels',
    category: 'forms',
    expected: 'pass',
    workflow: (b) => ({
      steps: [
        open(`${b}/form`),
        type(label('Full name'), 'Ada Lovelace'),
        type(label('E-mail'), 'ada@example.test'),
        s('select', { locator: label('Plan'), by: 'label', value: 'Pro' }),
        s('check', { locator: css('#terms'), checked: true }),
        click(text('Create account')),
        waitText('Thanks'),
      ],
    }),
    verify: (run, site) => {
      const sub = lastSubmission(site);
      return succeeded(run) ?? (sub?.name === 'Ada Lovelace' && sub.email === 'ada@example.test' && sub.plan === 'pro' && sub.terms === 'on' ? null : `submitted ${JSON.stringify(sub)}`);
    },
  },
  {
    id: 'controlled-input',
    title: 'Input whose value the page tracks in its own state (React-style)',
    category: 'forms',
    expected: 'pass',
    workflow: (b) => ({ steps: [open(`${b}/controlled`), type(css('#q'), 'flowpilot'), click(css('#save')), waitText('Thanks')] }),
    verify: (run, site) => succeeded(run) ?? (lastSubmission(site)?.state === 'flowpilot' ? null : `state was "${lastSubmission(site)?.state}"`),
  },

  // --- data & logic ----------------------------------------------------------
  {
    id: 'pagination',
    title: 'Scrape 5 pages by following “Next”',
    category: 'data',
    expected: 'pass',
    workflow: (b) => ({
      steps: [
        open(`${b}/list?page=1`),
        s('repeat', { times: 10, loopVariable: 'page' }, {
          children: [
            s('forEachElement', { locator: css('#results > .item'), loopVariable: 'it', maxItems: 100 }, {
              children: [
                s('extractText', { locator: css('{{it_selector}} .name'), variable: 'name', all: false }),
                s('addRow', { columns: [{ name: 'name', value: '{{name}}' }] }),
              ],
            }),
            s('if', cond({ condition: 'elementMissing', locator: css('a.next') }), { children: [s('break', {})], elseChildren: [] }),
            click(css('a.next')),
          ],
        }),
      ],
    }),
    verify: (run) => {
      const rows = run.table?.rows ?? [];
      return succeeded(run) ?? (rows.length === 50 && rows[49]?.name === 'Item 50' ? null : `${rows.length} rows, last "${rows.at(-1)?.name}"`);
    },
  },
  {
    id: 'infinite-scroll',
    title: 'Load all 60 posts from an infinite-scroll feed',
    category: 'data',
    expected: 'pass',
    workflow: (b) => ({
      steps: [
        open(`${b}/infinite`),
        s('repeat', { times: 10, loopVariable: 'load' }, {
          children: [
            s('if', cond({ condition: 'textPresent', value: 'No more posts' }), { children: [s('break', {})], elseChildren: [] }),
            s('scroll', { mode: 'bottom' }),
            s('wait', { mode: 'duration', durationMs: 600 }),
          ],
        }),
        s('forEachElement', { locator: css('#feed > .item'), loopVariable: 'post', maxItems: 200 }, {
          children: [s('addRow', { columns: [{ name: 'post', value: '{{post}}' }] })],
        }),
      ],
    }),
    verify: (run) => succeeded(run) ?? ((run.table?.rows.length ?? 0) === 60 ? null : `${run.table?.rows.length ?? 0} posts`),
  },
  {
    id: 'csv-25-rows',
    title: 'Submit a form once per row of a 25-row CSV',
    category: 'data',
    expected: 'pass',
    workflow: (b) => ({
      data: {
        columns: ['name', 'email', 'plan'],
        rows: Array.from({ length: 25 }, (_, i) => [`Person ${i + 1}`, `p${i + 1}@example.test`, i % 2 ? 'team' : 'pro']),
      },
      steps: [
        s('forEachRow', { loopVariable: 'row', maxRows: 100 }, {
          children: [
            open(`${b}/form`),
            type(label('Full name'), '{{row_name}}'),
            type(label('E-mail'), '{{row_email}}'),
            s('select', { locator: label('Plan'), by: 'value', value: '{{row_plan}}' }),
            s('check', { locator: css('#terms'), checked: true }),
            click(text('Create account')),
            waitText('Thanks'),
          ],
        }),
      ],
    }),
    verify: (run, site) => {
      const subs = site.submissions.filter((x) => x.params.name?.startsWith('Person '));
      const ok = subs.length === 25 && subs.every((x, i) => x.params.name === `Person ${i + 1}` && x.params.terms === 'on');
      return succeeded(run) ?? (ok ? null : `${subs.length} of 25 rows submitted correctly`);
    },
  },
  {
    id: 'random-banner',
    title: 'Cookie banner on about half the loads (If / Else)',
    category: 'data',
    expected: 'pass',
    workflow: (b) => ({
      steps: [
        open(`${b}/banner`),
        s('if', cond({ condition: 'elementVisible', locator: css('#cookies') }), { children: [click(css('#accept'))], elseChildren: [] }),
        click(css('#continue')),
        waitText('continued'),
      ],
    }),
    verify: succeeded,
  },

  // --- robustness ------------------------------------------------------------
  {
    id: 'record-replay',
    title: 'Record a checkout, replay it on the same page',
    category: 'robustness',
    expected: 'pass',
    workflow: () => ({ steps: [] }),
    record: { ...record('Grace Hopper'), replayUrl: (b) => `${b}/record?variant=a` },
    verify: (run, site) => succeeded(run) ?? (lastSubmission(site)?.customer === 'Grace Hopper' && lastSubmission(site)?.gift === 'on' ? null : `submitted ${JSON.stringify(lastSubmission(site))}`),
  },
  {
    id: 'record-replay-changed-page',
    title: 'Record a checkout, replay after the site changed ids, classes, wrappers and button order',
    category: 'robustness',
    expected: 'pass',
    workflow: () => ({ steps: [] }),
    record: { ...record('Grace Hopper'), replayUrl: (b) => `${b}/record?variant=b` },
    verify: (run, site) => succeeded(run) ?? (lastSubmission(site)?.customer === 'Grace Hopper' && lastSubmission(site)?.gift === 'on' ? null : `submitted ${JSON.stringify(lastSubmission(site))}`),
  },

  // --- known limits ----------------------------------------------------------
  {
    id: 'shadow-dom',
    title: 'Button inside a shadow root',
    category: 'limits',
    expected: 'unsupported',
    workflow: (b) => ({ steps: [open(`${b}/shadow`), click(text('Inside shadow')), waitText('clicked')] }),
    verify: succeeded,
  },
  {
    id: 'iframe',
    title: 'Form inside an iframe',
    category: 'limits',
    expected: 'unsupported',
    workflow: (b) => ({ steps: [open(`${b}/iframe`), type(css('#inner'), 'x'), click(text('Send')), waitText('Thanks')] }),
    verify: succeeded,
  },
];
