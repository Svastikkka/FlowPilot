import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function addStep(app: Page, action: RegExp) {
  await app.getByRole('button', { name: /^＋ Add (first )?step$/ }).click();
  await app.getByRole('dialog', { name: 'Add a step' }).getByRole('button', { name: action }).click();
}

const config = (app: Page) => app.getByRole('complementary', { name: 'Configuration' });

test('builds a workflow in the editor and runs it end to end', async ({ app, site, context }) => {
  await expect(app.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '＋ Create workflow' }).first().click();
  await app.getByRole('textbox', { name: 'Workflow name' }).fill('E2E signup');

  await addStep(app, /^Open URL/);
  await config(app).getByLabel(/^URL( \*)?$/).fill(`${site.url}/form`);

  await addStep(app, /^Wait/);
  await config(app).getByLabel(/^Element( \*)?$/).fill('#ready');

  await addStep(app, /^Enter text/);
  await config(app).getByLabel(/^Field( \*)?$/).fill('#name');
  await config(app).getByLabel(/^Text( \*)?$/).fill('{{who}}');

  await addStep(app, /^Select option/);
  await config(app).getByLabel(/^Dropdown( \*)?$/).fill('#country');
  await config(app).getByLabel(/^Option( \*)?$/).fill('India');

  await addStep(app, /^Check/);
  await config(app).getByLabel(/^Checkbox( \*)?$/).fill('#terms');

  await addStep(app, /^Click/);
  await config(app).getByLabel('Element locator type').selectOption('text');
  await config(app).getByLabel(/^Element( \*)?$/).fill('Send');

  await addStep(app, /^Wait/);
  await config(app).getByLabel('Wait for').selectOption('textPresent');
  await config(app).getByLabel(/^Text( \*)?$/).fill('Thanks');

  await addStep(app, /^Extract text/);
  await config(app).getByLabel(/^Element( \*)?$/).fill('h1');
  await config(app).getByLabel(/^Save as variable( \*)?$/).fill('heading');

  // The {{who}} variable is undefined, so the workflow cannot run yet.
  await expect(app.getByText(/problem.? to fix before this workflow can run/)).toBeVisible();
  await config(app).getByRole('tab', { name: /Variables/ }).click();
  await config(app).getByRole('button', { name: '＋ Add variable' }).click();
  await config(app).getByLabel(/^Name( \*)?$/).fill('who');
  await config(app).getByLabel('Default value').fill('Ada');
  await config(app).getByLabel('Ask at run start').check();
  await expect(app.getByText(/problem.? to fix before this workflow can run/)).toBeHidden();

  await app.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(app.getByText('All changes saved')).toBeVisible();

  // Run: provide the input, acknowledge the "Send" click warning.
  await app.getByRole('button', { name: '▶ Run' }).click();
  const dialog = app.getByRole('dialog', { name: /Run “E2E signup”/ });
  await expect(dialog.getByText('Access granted')).toBeVisible();
  await dialog.getByLabel(/who/).fill('Ada Lovelace');
  const start = dialog.getByRole('button', { name: /Start run/ });
  await expect(start).toBeDisabled();
  await dialog.getByLabel('I understand and want to run it').check();
  await start.click();

  // Monitor (the run opens its own tab; the monitor stays on the app page).
  await expect(app.getByRole('heading', { name: 'E2E signup' })).toBeVisible();
  await expect(app.locator('.page-header .badge').first()).toHaveText('Succeeded', { timeout: 30_000 });
  await expect(app.getByText('8 of 8 steps processed')).toBeVisible();
  await expect(app.getByRole('cell', { name: 'Thanks, Ada Lovelace' })).toBeVisible();
  await expect(app.getByRole('region', { name: 'Steps' }).getByText('Entered 12 characters into #name (verified)')).toBeVisible();
  await expect(app.getByRole('region', { name: 'Steps' }).getByText('Selected "India" (verified)')).toBeVisible();

  expect(site.submissions).toHaveLength(1);
  expect(Object.fromEntries(site.submissions[0])).toEqual({ name: 'Ada Lovelace', country: 'in', terms: 'on' });
  expect(context.pages().some((p) => p.url().startsWith(`${site.url}/thanks`))).toBe(true);

  // History lists the run; dashboard shows its status.
  await app.getByRole('link', { name: 'Run history' }).click();
  await expect(app.getByRole('link', { name: 'E2E signup' })).toBeVisible();
  await app.getByRole('link', { name: 'Workflows' }).click();
  await expect(app.getByRole('article').filter({ hasText: 'E2E signup' }).getByText('Succeeded')).toBeVisible();
});

test('imports workflows, answers a confirmation and reports a failing step', async ({ app, site }) => {
  const file = join(mkdtempSync(join(tmpdir(), 'fp-import-')), 'workflows.json');
  const now = Date.now();
  const base = { schemaVersion: 1, description: '', tags: ['e2e'], favorite: false, variables: [], createdAt: now, updatedAt: now };
  const settings = { defaultTimeoutMs: 1500, defaultRetries: 0, defaultOnError: 'stop', stepDelayMs: 0 };
  writeFileSync(
    file,
    JSON.stringify({
      format: 'flowpilot.workflows',
      schemaVersion: 1,
      workflows: [
        {
          ...base,
          id: 'a',
          name: 'Confirm then read',
          settings,
          steps: [
            { id: '1', type: 'openUrl', params: { url: `${site.url}/thanks?name=Grace` } },
            { id: '2', type: 'confirm', params: { message: 'Read the heading?' } },
            { id: '3', type: 'extractText', params: { locator: { strategy: 'css', value: 'li' }, variable: 'items', all: true } },
          ],
        },
        {
          ...base,
          id: 'b',
          name: 'Broken selector',
          settings,
          steps: [
            { id: '1', type: 'openUrl', params: { url: `${site.url}/form` } },
            { id: '2', type: 'click', name: 'Press missing button', params: { locator: { strategy: 'css', value: '#does-not-exist' } } },
          ],
        },
        { ...base, id: 'c', name: 'Evil', settings, steps: [{ id: '1', type: 'runScript', params: { code: 'alert(1)' } }] },
      ],
    }),
  );

  await app.locator('input[type=file]').setInputFiles(file);
  const summary = app.getByRole('dialog', { name: 'Import complete' });
  await expect(summary.getByText('Imported 2 workflows, rejected 1.')).toBeVisible();
  await expect(summary.getByText(/Evil:/)).toBeVisible();
  await summary.getByRole('button', { name: 'Done' }).click();

  // Confirmation prompt answered from the monitor.
  await app.getByRole('article').filter({ hasText: 'Confirm then read' }).getByRole('button', { name: '▶ Run' }).click();
  await app.getByRole('dialog').getByRole('button', { name: /Start run/ }).click();
  const prompt = app.getByRole('alertdialog', { name: 'The run needs your input' });
  await expect(prompt.getByText('Read the heading?')).toBeVisible({ timeout: 20_000 });
  await prompt.getByRole('button', { name: 'Continue' }).click();
  await expect(app.locator('.page-header .badge').first()).toHaveText('Succeeded', { timeout: 20_000 });
  await expect(app.getByRole('cell', { name: 'One Two' })).toBeVisible();

  // A failing step is identified clearly.
  await app.getByRole('link', { name: 'Workflows' }).click();
  await app.getByRole('article').filter({ hasText: 'Broken selector' }).getByRole('button', { name: '▶ Run' }).click();
  await app.getByRole('dialog').getByRole('button', { name: /Start run/ }).click();
  await expect(app.locator('.page-header .badge').first()).toHaveText('Failed', { timeout: 20_000 });
  await expect(app.getByRole('alert').filter({ hasText: 'Step 2 “Press missing button” failed.' })).toContainText('No element matches #does-not-exist');
  await expect(app.getByText('2 of 2 steps processed')).toBeVisible();
});

test('tests a single step from the editor', async ({ app, site }) => {
  await app.getByRole('button', { name: '＋ Create workflow' }).first().click();
  await addStep(app, /^Open URL/);
  await config(app).getByLabel(/^URL( \*)?$/).fill(`${site.url}/thanks?name=Test`);
  await addStep(app, /^Extract text/);
  await config(app).getByLabel(/^Element( \*)?$/).fill('h1');

  await app.getByRole('treeitem', { name: /Step 1: Open URL/ }).click();
  await config(app).getByRole('button', { name: /Test step/ }).click();
  await expect(config(app).getByRole('status')).toContainText('Passed', { timeout: 20_000 });

  await app.getByRole('treeitem', { name: /Step 2: Extract text/ }).click();
  await config(app).getByRole('button', { name: /Test step/ }).click();
  await expect(config(app).getByRole('status')).toContainText('Saved "Thanks, Test" to {{text}}', { timeout: 20_000 });
});

test('runs loops over data rows and page elements, filling a results table', async ({ app, site }) => {
  const file = join(mkdtempSync(join(tmpdir(), 'fp-logic-')), 'logic.json');
  const now = Date.now();
  const css = (value: string) => ({ strategy: 'css', value });
  writeFileSync(
    file,
    JSON.stringify({
      format: 'flowpilot.workflows',
      schemaVersion: 2,
      workflows: [
        {
          schemaVersion: 2,
          id: 'loop',
          name: 'Sign up everyone',
          description: '',
          tags: [],
          favorite: false,
          variables: [],
          settings: { defaultTimeoutMs: 3000, defaultRetries: 0, defaultOnError: 'stop', stepDelayMs: 0 },
          data: { columns: ['name', 'country'], rows: [['Ada', 'in'], ['Grace', 'nl'], ['Katherine', 'in']] },
          createdAt: now,
          updatedAt: now,
          steps: [
            {
              id: 'rows',
              type: 'forEachRow',
              params: { loopVariable: 'row', maxRows: 100 },
              children: [
                { id: 'o', type: 'openUrl', params: { url: `${site.url}/form` } },
                { id: 't', type: 'type', params: { locator: css('#name'), text: '{{row_name}}', clearFirst: true, pressEnter: false } },
                { id: 's', type: 'select', params: { locator: css('#country'), by: 'value', value: '{{row_country}}' } },
                {
                  id: 'if',
                  type: 'if',
                  params: { condition: 'variable', variable: 'row_country', operator: 'equals', value: 'in', locator: css('') },
                  children: [{ id: 'c', type: 'check', params: { locator: css('#terms'), checked: true } }],
                  elseChildren: [],
                },
                { id: 'go', type: 'click', params: { locator: { strategy: 'text', value: 'Send' } } },
                {
                  id: 'items',
                  type: 'forEachElement',
                  params: { locator: css('li'), loopVariable: 'li', maxItems: 10 },
                  children: [{ id: 'add', type: 'addRow', params: { columns: [{ name: 'person', value: '{{row_name}}' }, { name: 'item', value: '{{li}}' }] } }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  await app.locator('input[type=file]').setInputFiles(file);
  await app.getByRole('dialog', { name: 'Import complete' }).getByRole('button', { name: 'Done' }).click();
  await app.getByRole('article').filter({ hasText: 'Sign up everyone' }).getByRole('button', { name: '▶ Run' }).click();
  const dialog = app.getByRole('dialog', { name: /Run “Sign up everyone”/ });
  await expect(dialog.getByText('Using 3 rows from the workflow’s Data tab.')).toBeVisible();
  await dialog.getByLabel('I understand and want to run it').check();
  await dialog.getByRole('button', { name: /Start run/ }).click();

  await expect(app.locator('.page-header .badge').first()).toHaveText('Succeeded', { timeout: 45_000 });
  expect(site.submissions.map((p) => Object.fromEntries(p))).toEqual([
    { name: 'Ada', country: 'in', terms: 'on' },
    { name: 'Grace', country: 'nl' },
    { name: 'Katherine', country: 'in', terms: 'on' },
  ]);
  const table = app.getByRole('region', { name: 'Results table' });
  await expect(table.getByText('(6 rows)')).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(7);
  await expect(app.getByText('ran 3×').first()).toBeVisible();
});

test('goes back and forward through pages the run opened', async ({ app, site }) => {
  const file = join(mkdtempSync(join(tmpdir(), 'fp-history-')), 'history.json');
  const now = Date.now();
  const base = { schemaVersion: 2, description: '', tags: [], favorite: false, variables: [], createdAt: now, updatedAt: now };
  const settings = { defaultTimeoutMs: 5000, defaultRetries: 0, defaultOnError: 'stop', stepDelayMs: 0 };
  writeFileSync(
    file,
    JSON.stringify({
      format: 'flowpilot.workflows',
      schemaVersion: 2,
      workflows: [
        {
          ...base,
          id: 'h',
          name: 'History round trip',
          settings,
          steps: [
            { id: '1', type: 'openUrl', params: { url: `${site.url}/form` } },
            { id: '2', type: 'openUrl', params: { url: `${site.url}/thanks?name=One` } },
            { id: '3', type: 'openUrl', params: { url: `${site.url}/thanks?name=Two` } },
            { id: '4', type: 'navigate', params: { direction: 'back' } },
            { id: '5', type: 'extractText', params: { locator: { strategy: 'css', value: 'h1' }, variable: 'afterBack', all: false } },
            { id: '6', type: 'navigate', params: { direction: 'back' } },
            { id: '7', type: 'capturePage', params: { what: 'url', variable: 'firstUrl' } },
            { id: '8', type: 'navigate', params: { direction: 'forward' } },
            { id: '9', type: 'extractText', params: { locator: { strategy: 'css', value: 'h1' }, variable: 'afterForward', all: false } },
          ],
        },
        {
          ...base,
          id: 'n',
          name: 'Back with no history',
          settings,
          steps: [
            { id: '1', type: 'openUrl', params: { url: `${site.url}/form` } },
            { id: '2', type: 'navigate', params: { direction: 'forward' } },
          ],
        },
      ],
    }),
  );
  await app.locator('input[type=file]').setInputFiles(file);
  await app.getByRole('dialog', { name: 'Import complete' }).getByRole('button', { name: 'Done' }).click();

  await app.getByRole('article').filter({ hasText: 'History round trip' }).getByRole('button', { name: '▶ Run' }).click();
  await app.getByRole('dialog').getByRole('button', { name: /Start run/ }).click();
  await expect(app.locator('.page-header .badge').first()).toHaveText('Succeeded', { timeout: 30_000 });
  const results = app.getByRole('region', { name: 'Results', exact: true });
  await expect(results.getByRole('cell', { name: 'Thanks, One' }).first()).toBeVisible();
  await expect(results.getByRole('cell', { name: `${site.url}/form` })).toBeVisible();
  await expect(app.getByRole('region', { name: 'Steps' }).getByText(`Went forward — now at ${site.url}/thanks?name=One`)).toBeVisible();

  await app.getByRole('link', { name: 'Workflows', exact: true }).click();
  await app.getByRole('article').filter({ hasText: 'Back with no history' }).getByRole('button', { name: '▶ Run' }).click();
  await app.getByRole('dialog').getByRole('button', { name: /Start run/ }).click();
  await expect(app.locator('.page-header .badge').first()).toHaveText('Failed', { timeout: 30_000 });
  await expect(app.getByRole('alert').filter({ hasText: 'There is no page to go to in that direction' })).toBeVisible();
});
