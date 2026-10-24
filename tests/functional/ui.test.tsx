import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/ui/app/App';
import { listWorkflows, saveWorkflow, getWorkflow } from '../../src/storage/workflows';
import { saveRun } from '../../src/storage/runs';
import { createRunRecord } from '../../src/engine/runner';
import { COMMAND_CHANNEL, MONITOR_PORT } from '../../src/shared/messages';
import type { Command } from '../../src/shared/messages';
import { exportWorkflows } from '../../src/shared/schema/importExport';
import { templateById } from '../../src/templates';
import type { ChromeMock } from '../helpers/chromeMock';
import { css, step, wf } from '../helpers/fakes';

// UI flows rendered with React Testing Library against fake-indexeddb and a
// mocked chrome API (the service worker is simulated via onCommand).

function mock(): ChromeMock {
  return (chrome as unknown as { __state?: ChromeMock }).__state!;
}

function renderAt(hash: string) {
  history.replaceState(null, '', hash);
  return render(<App />);
}

function commands(): Command[] {
  return (chrome.runtime.sendMessage as unknown as { mock: { calls: [{ channel: string; command: Command }][] } }).mock.calls
    .filter(([m]) => m.channel === COMMAND_CHANNEL)
    .map(([m]) => m.command);
}

describe('dashboard', () => {
  it('shows an empty state and creates a workflow that opens in the editor', async () => {
    const user = userEvent.setup();
    renderAt('#/');
    expect(await screen.findByText('No workflows yet')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: '＋ Create workflow' })[0]);
    expect(await screen.findByRole('textbox', { name: 'Workflow name' })).toHaveValue('Untitled workflow');
    expect(location.hash).toMatch(/^#\/workflows\/wf_/);
    expect(await listWorkflows()).toHaveLength(1);
  });

  it('lists, searches, favorites and filters workflows by tag', async () => {
    const user = userEvent.setup();
    await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' })], { name: 'Invoice export', tags: ['finance'] }));
    await saveWorkflow(wf([step('openUrl', { url: 'https://b.com' })], { name: 'QA smoke test', tags: ['qa'] }));
    renderAt('#/');
    expect(await screen.findByRole('link', { name: 'Invoice export' })).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search workflows' }), 'smoke');
    expect(screen.queryByRole('link', { name: 'Invoice export' })).not.toBeInTheDocument();
    await user.clear(screen.getByRole('searchbox', { name: 'Search workflows' }));

    await user.click(screen.getByRole('button', { name: 'finance' }));
    expect(screen.queryByRole('link', { name: 'QA smoke test' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'finance' }));

    await user.click(screen.getByRole('button', { name: 'Favorite QA smoke test' }));
    await user.click(await screen.findByRole('button', { name: '★ Favorites' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Invoice export' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'QA smoke test' })).toBeInTheDocument();
  });

  it('imports a file and reports rejected workflows', async () => {
    const user = userEvent.setup();
    renderAt('#/');
    await screen.findByText('No workflows yet');
    const good = wf([step('openUrl', { url: 'https://a.com' })], { name: 'Good one' });
    const json = JSON.parse(exportWorkflows([good]));
    json.workflows.push({ ...good, name: 'Bad one', steps: [{ id: 'x', type: 'eval', params: {} }] });
    const file = new File([JSON.stringify(json)], 'w.json', { type: 'application/json' });
    await user.upload(screen.getByLabelText('Import workflow file'), file);
    const dialog = await screen.findByRole('dialog', { name: 'Import complete' });
    expect(within(dialog).getByText('Imported 1 workflow, rejected 1.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Bad one:/)).toBeInTheDocument();
    expect((await listWorkflows()).map((w) => w.name)).toEqual(['Good one']);
  });

  it('shows an error toast for files that are not FlowPilot exports', async () => {
    const user = userEvent.setup();
    renderAt('#/');
    await screen.findByText('No workflows yet');
    await user.upload(screen.getByLabelText('Import workflow file'), new File(['{oops'], 'x.json', { type: 'application/json' }));
    expect(await screen.findByText('Import failed: File is not valid JSON')).toBeInTheDocument();
  });

  it('deletes a workflow after confirmation', async () => {
    const user = userEvent.setup();
    await saveWorkflow(wf([], { name: 'Temporary' }));
    renderAt('#/');
    await user.click(await screen.findByRole('button', { name: 'More actions for Temporary' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Delete workflow?' })).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No workflows yet')).toBeInTheDocument();
  });
});

describe('editor', () => {
  it('builds steps, shows validation feedback and saves', async () => {
    const user = userEvent.setup();
    const created = await saveWorkflow(wf([], { name: 'New flow' }));
    renderAt(`#/workflows/${created.id}`);

    await user.click(await screen.findByRole('button', { name: '＋ Add first step' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Add a step' })).getByRole('button', { name: /^Open URL/ }));
    const panel = screen.getByRole('complementary', { name: 'Configuration' });
    const url = within(panel).getByLabelText(/^URL/);
    await user.clear(url);
    await user.type(url, 'https://shop.test/cart');

    await user.click(screen.getByRole('button', { name: '＋ Add step' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Add a step' })).getByRole('button', { name: /^Click/ }));
    // A click without a target is invalid.
    expect(await within(panel).findByText('Target element is required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▶ Run' })).toBeDisabled();
    await user.type(within(panel).getByLabelText(/^Element/, { selector: 'input' }), 'button.checkout');
    await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run' })).toBeEnabled());
    // "checkout" is flagged as sensitive.
    expect(within(panel).getByText(/may submit, buy, delete or send/)).toBeInTheDocument();

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    const saved = await getWorkflow(created.id);
    expect(saved!.steps.map((s) => [s.type, s.type === 'openUrl' ? s.params.url : (s.params as { locator: { value: string } }).locator.value])).toEqual([
      ['openUrl', 'https://shop.test/cart'],
      ['click', 'button.checkout'],
    ]);
  });

  it('reorders steps with the keyboard and the move buttons', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(
      wf([step('openUrl', { url: 'https://a.com' }, { name: 'First' }), step('click', { locator: css('#b') }, { name: 'Second' }), step('click', { locator: css('#c') }, { name: 'Third' })]),
    );
    renderAt(`#/workflows/${w.id}`);
    const third = await screen.findByRole('treeitem', { name: /Step 3: Third/ });
    third.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(screen.getAllByRole('treeitem').map((li) => li.getAttribute('aria-label'))).toEqual(['Step 1: First', 'Step 2: Third', 'Step 3: Second']);
    await user.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(screen.getAllByRole('treeitem').map((li) => li.getAttribute('aria-label'))).toEqual(['Step 1: Third', 'Step 2: First', 'Step 3: Second']);
    await user.click(screen.getByRole('button', { name: 'Disable step 3' }));
    expect(screen.getByRole('treeitem', { name: 'Step 3: Second (disabled)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Duplicate step 1' }));
    expect(screen.getAllByRole('treeitem')).toHaveLength(4);
  });

  it('defines a variable and inserts it into a field', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), step('type', { locator: css('#q'), text: '' })]));
    renderAt(`#/workflows/${w.id}`);
    const panel = await screen.findByRole('complementary', { name: 'Configuration' });
    await user.click(within(panel).getByRole('tab', { name: 'Variables' }));
    await user.click(within(panel).getByRole('button', { name: '＋ Add variable' }));
    const name = within(panel).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'term');
    await user.click(within(panel).getByRole('tab', { name: 'Step' }));
    await user.click(screen.getByRole('treeitem', { name: /Step 2/ }));
    await user.click(within(panel).getByRole('button', { name: '{{term}}' }));
    expect(within(panel).getByLabelText('Text')).toHaveValue('{{term}}');
  });

  it('asks to test a step and shows the result', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com/' })]));
    const run = { ...createRunRecord(w, { target: { kind: 'newTab' }, mode: 'testStep' }), status: 'succeeded' as const, finishedAt: 2 };
    run.steps[0] = { ...run.steps[0], status: 'succeeded', message: 'Loaded https://a.com/' };
    await saveRun(run);
    mock().onCommand = () => ({ ok: true, data: { runId: run.id } });
    renderAt(`#/workflows/${w.id}`);
    await user.click(await screen.findByRole('button', { name: /Test step/ }));
    expect(await screen.findByText(/Loaded https:\/\/a.com\//)).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(mock().permissionPrompts).toEqual([{ origins: ['https://a.com/*'] }]);
    expect(commands()).toContainEqual({ type: 'run.testStep', workflowId: w.id, stepId: w.steps[0].id });
  });
});

describe('run dialog', () => {
  it('collects inputs, requests site access, requires acknowledgement and starts the run', async () => {
    const user = userEvent.setup();
    const template = await saveWorkflow(templateById('form-entry')!.build());
    mock().onCommand = (m) => ((m as { command: Command }).command.type === 'run.start' ? { ok: true, data: { runId: 'run_1' } } : { ok: true, data: null });
    renderAt('#/');
    const card = (await screen.findByRole('link', { name: 'Repetitive form entry' })).closest('article')!;
    await user.click(within(card as HTMLElement).getByRole('button', { name: '▶ Run' }));
    const dialog = await screen.findByRole('dialog', { name: /Run “Repetitive form entry”/ });
    expect(within(dialog).getByText(/This workflow visits: httpbin.org/)).toBeInTheDocument();
    const name = within(dialog).getByLabelText(/Customer name/);
    await user.clear(name);
    await user.type(name, 'Grace');
    const start = within(dialog).getByRole('button', { name: /Start run/ });
    expect(start).toBeDisabled();
    await user.click(within(dialog).getByLabelText('I understand and want to run it'));
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(location.hash).toBe('#/runs/run_1'));
    expect(mock().permissionPrompts).toEqual([{ origins: ['https://httpbin.org/*'] }]);
    expect(commands()).toContainEqual({
      type: 'run.start',
      workflowId: template.id,
      target: { kind: 'newTab' },
      inputs: { customerName: 'Grace', email: 'ada@example.com' },
    });
  });

  it('does not start when site access is refused', async () => {
    const user = userEvent.setup();
    await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' })], { name: 'Plain' }));
    mock().grantNextPermissionRequest = false;
    renderAt('#/');
    const card = (await screen.findByRole('link', { name: 'Plain' })).closest('article') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: '▶ Run' }));
    const dialog = await screen.findByRole('dialog');
    const start = within(dialog).getByRole('button', { name: /Start run/ });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    expect(await within(dialog).findByText(/Site access was not granted/)).toBeInTheDocument();
    expect(commands().some((c) => c.type === 'run.start')).toBe(false);
  });
});

describe('execution monitor', () => {
  it('shows live progress, answers prompts and renders the failure summary', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), step('confirm', { message: 'Go on?' }), step('click', { locator: css('#x') }, { name: 'Press X' })]));
    const run = createRunRecord(w, { target: { kind: 'newTab' } });
    await saveRun({ ...run, status: 'running' });
    renderAt(`#/runs/${run.id}`);
    expect(await screen.findByRole('heading', { name: 'Test workflow' })).toBeInTheDocument();
    const port = mock().ports.find((p) => p.name === MONITOR_PORT)!;

    act(() =>
      port.emit({
        type: 'run.update',
        run: {
          ...run,
          status: 'waiting_for_user',
          currentStepIndex: 1,
          steps: [{ ...run.steps[0], status: 'succeeded', message: 'Loaded https://a.com/' }, { ...run.steps[1], status: 'running' }, run.steps[2]],
          pendingPrompt: { id: 'p1', kind: 'confirm', stepId: run.steps[1].stepId, stepIndex: 1, message: 'Go on?', createdAt: 1 },
        },
      }),
    );
    const prompt = await screen.findByRole('alertdialog', { name: 'The run needs your input' });
    expect(screen.getByText('1 of 3 steps processed')).toBeInTheDocument();
    await user.click(within(prompt).getByRole('button', { name: 'Continue' }));
    expect(commands()).toContainEqual({ type: 'prompt.respond', runId: run.id, promptId: 'p1', response: { action: 'continue' } });

    act(() =>
      port.emit({
        type: 'run.update',
        run: {
          ...run,
          status: 'failed',
          finishedAt: run.startedAt + 4200,
          currentStepIndex: 2,
          steps: [
            { ...run.steps[0], status: 'succeeded' },
            { ...run.steps[1], status: 'succeeded' },
            { ...run.steps[2], status: 'failed', message: 'No element matches #x after waiting 10s', attempts: 2 },
          ],
          error: { stepId: run.steps[2].stepId, stepIndex: 2, code: 'ELEMENT_NOT_FOUND', message: 'No element matches #x after waiting 10s' },
          summary: '2 of 3 steps succeeded, 1 failed',
        },
      }),
    );
    expect(await screen.findByText('Step 3 “Press X” failed.')).toBeInTheDocument();
    expect(screen.getByText('2 attempts')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '↻ Rerun' })).toBeEnabled();
  });

  it('offers to resume interrupted runs', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), step('click', { locator: css('#x') })]));
    const run = { ...createRunRecord(w, { target: { kind: 'newTab' } }), status: 'interrupted' as const, currentStepIndex: 1, finishedAt: 5 };
    await saveRun(run);
    mock().onCommand = () => ({ ok: true, data: { runId: 'run_resumed' } });
    renderAt(`#/runs/${run.id}`);
    await user.click(await screen.findByRole('button', { name: '↻ Resume from step 2' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Resume interrupted run' })).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(location.hash).toBe('#/runs/run_resumed'));
    expect(commands()).toContainEqual({ type: 'run.resumeInterrupted', runId: run.id, inputs: {} });
  });
});

describe('settings and privacy', () => {
  it('revokes site access and deletes all data after typed confirmation', async () => {
    const user = userEvent.setup();
    mock().grantedOrigins.add('https://a.com/*');
    await saveWorkflow(wf([], { name: 'Keep me?' }));
    renderAt('#/settings');
    expect(await screen.findByText('a.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(/No sites granted yet/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete all FlowPilot data' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete all FlowPilot data?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete everything' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Type DELETE to confirm/), 'DELETE');
    await user.click(confirm);
    await waitFor(async () => expect(await listWorkflows()).toEqual([]));
  });

  it('explains local storage and recording on the privacy page, and offers the recorder', async () => {
    renderAt('#/privacy');
    expect(await screen.findByText(/not encrypted/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recording' })).toBeInTheDocument();
    history.replaceState(null, '', '#/recorder');
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    expect(await screen.findByRole('button', { name: /Start recording/ })).toBeInTheDocument();
  });
});

describe('logic & data in the UI', () => {
  it('counts nested steps on dashboard cards', async () => {
    const loop = { ...step('repeat', { times: 2 }), children: [step('clear', { locator: css('#a') }), step('clear', { locator: css('#b') })] };
    await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), loop as never], { name: 'Nested count' }));
    renderAt('#/');
    const card = (await screen.findByRole('link', { name: 'Nested count' })).closest('article') as HTMLElement;
    expect(within(card).getByText('4 steps')).toBeInTheDocument();
  });

  it('adds an If block, puts steps inside it and nests with the keyboard', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' })], { name: 'Logic' }));
    renderAt(`#/workflows/${w.id}`);
    await user.click(await screen.findByRole('button', { name: '＋ Add step' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Add a step' })).getByRole('button', { name: /^If \/ Else/ }));
    const panel = screen.getByRole('complementary', { name: 'Configuration' });
    await user.type(within(panel).getByLabelText(/^Element/, { selector: 'input' }), '#banner');

    await user.click(screen.getByRole('button', { name: '＋ Add step to Then' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Add a step' })).getByRole('button', { name: /^Click/ }));
    await user.type(within(panel).getByLabelText(/^Element/, { selector: 'input' }), '#close');
    expect(screen.getByRole('treeitem', { name: /Step 2\.1: Click/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Then step 2' })).toBeInTheDocument();

    // A new top-level step can be moved into the block with Alt+→ and back with Alt+←.
    await user.click(screen.getAllByRole('button', { name: '＋ Add step' }).at(-1)!);
    await user.click(within(screen.getByRole('dialog', { name: 'Add a step' })).getByRole('button', { name: /^Back \/ Forward/ }));
    // It was added after the selected nested step, inside Then.
    const back = screen.getByRole('treeitem', { name: /Step 2\.2: Back/ });
    back.focus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(screen.getByRole('treeitem', { name: /Step 3: Back/ })).toBeInTheDocument();
    screen.getByRole('treeitem', { name: /Step 3: Back/ }).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(screen.getByRole('treeitem', { name: /Step 2\.2: Back/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('All changes saved');
    const saved = await getWorkflow(w.id);
    expect(saved!.steps[1]).toMatchObject({ type: 'if', children: [{ type: 'click' }, { type: 'navigate' }], elseChildren: [] });
  });

  it('imports a CSV on the Data tab and uses its columns in a row loop', async () => {
    const user = userEvent.setup();
    const loop = { ...step('forEachRow', { loopVariable: 'row' }), children: [step('type', { locator: css('#q'), text: '' })] };
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), loop as never], { name: 'Rows' }));
    renderAt(`#/workflows/${w.id}`);
    expect(await screen.findByRole('treeitem', { name: 'Step 2: For each data row, 1 problem' })).toBeInTheDocument();
    const panel = screen.getByRole('complementary', { name: 'Configuration' });
    await user.click(within(panel).getByRole('tab', { name: /Data/ }));
    await user.upload(within(panel).getByLabelText('Import CSV file'), new File(['Full Name,E-mail\nAda,ada@x.test\nGrace,grace@x.test'], 'p.csv', { type: 'text/csv' }));
    expect(await within(panel).findByLabelText('Row 2 e_mail')).toHaveValue('grace@x.test');
    expect(within(panel).getByText('2 rows · 2 columns')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Step 2: For each data row' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('tab', { name: 'Step' }));
    await user.click(screen.getByRole('treeitem', { name: /Step 2\.1/ }));
    await user.click(within(panel).getByRole('button', { name: '{{row_full_name}}' }));
    expect(within(panel).getByLabelText('Text')).toHaveValue('{{row_full_name}}');
  });

  it('lets a run use a different CSV, rejecting files with missing columns', async () => {
    const user = userEvent.setup();
    const loop = { ...step('forEachRow', { loopVariable: 'row' }), children: [step('type', { locator: css('#q'), text: '{{row_email}}' })] };
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), loop as never], { name: 'Per run CSV', data: { columns: ['email'], rows: [['a@b.c']] } }));
    mock().onCommand = () => ({ ok: true, data: { runId: 'run_csv' } });
    renderAt('#/');
    const card = (await screen.findByRole('link', { name: 'Per run CSV' })).closest('article') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: '▶ Run' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Using 1 rows from the workflow’s Data tab.')).toBeInTheDocument();
    await user.upload(within(dialog).getByLabelText('CSV for this run'), new File(['name\nx'], 'bad.csv', { type: 'text/csv' }));
    expect(await within(dialog).findByText('This CSV is missing columns the workflow uses: email')).toBeInTheDocument();
    await user.upload(within(dialog).getByLabelText('CSV for this run'), new File(['email,extra\nq@w.e,1\nr@t.y,2'], 'good.csv', { type: 'text/csv' }));
    expect(await within(dialog).findByText('Using 2 rows from good.csv for this run.')).toBeInTheDocument();
    const start = within(dialog).getByRole('button', { name: /Start run/ });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(location.hash).toBe('#/runs/run_csv'));
    expect(commands()).toContainEqual(
      expect.objectContaining({ type: 'run.start', workflowId: w.id, table: { columns: ['email', 'extra'], rows: [['q@w.e', '1'], ['r@t.y', '2']] } }),
    );
  });

  it('shows nested steps, run counts, the results table and the activity log in the monitor', async () => {
    const child = step('addRow', { columns: [{ name: 'n', value: '{{loop_index}}' }] });
    const loop = { ...step('repeat', { times: 2 }), children: [child] };
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://a.com' }), loop as never]));
    const run = createRunRecord(w, { target: { kind: 'newTab' } });
    await saveRun({
      ...run,
      status: 'succeeded',
      finishedAt: run.startedAt + 1000,
      steps: [
        { stepId: w.steps[0].id, status: 'succeeded', attempts: 1, executions: 1 },
        { stepId: loop.id, status: 'succeeded', attempts: 1, executions: 3, message: 'Finished 2 iterations — 2 iterations' },
        { stepId: child.id, status: 'succeeded', attempts: 1, executions: 2, message: 'Added row 2 (n)' },
      ],
      table: { columns: ['n'], rows: [{ n: '1' }, { n: '2' }] },
      log: [
        { at: 1, stepId: child.id, status: 'succeeded', message: 'Added row 1 (n)', context: 'Repeat #1' },
        { at: 2, stepId: child.id, status: 'succeeded', message: 'Added row 2 (n)', context: 'Repeat #2' },
      ],
    });
    renderAt(`#/runs/${run.id}`);
    expect(await screen.findByText('2.1.')).toBeInTheDocument();
    expect(screen.getByText('ran 2×')).toBeInTheDocument();
    const table = screen.getByRole('region', { name: 'Results table' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('Activity log')).toBeInTheDocument();
    expect(screen.getByText(/· Repeat #2/)).toBeInTheDocument();
  });
});

describe('element picker in the editor', () => {
  it('fills a target by clicking on the page, using the nearest Open URL', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://shop.test/cart' }), step('click', { locator: css('') })], { name: 'Pick me' }));
    mock().onCommand = () => ({ ok: true, data: null });
    renderAt(`#/workflows/${w.id}`);
    await user.click(await screen.findByRole('treeitem', { name: /Step 2: Click/ }));
    const panel = screen.getByRole('complementary', { name: 'Configuration' });
    await user.click(within(panel).getByRole('button', { name: /Pick on page/ }));

    await waitFor(() => expect(commands().some((c) => c.type === 'picker.start')).toBe(true));
    const start = commands().find((c) => c.type === 'picker.start') as Extract<Command, { type: 'picker.start' }>;
    expect(start).toMatchObject({ url: 'https://shop.test/cart', mode: 'single' });
    expect(mock().permissionPrompts).toEqual([{ origins: ['https://shop.test/*'] }]);
    expect(within(panel).getByText(/Click the element in the page that opened/)).toBeInTheDocument();

    // The service worker reports the user's click.
    await act(() =>
      chrome.storage.session.set({
        pickResult: { requestId: start.requestId, locator: { strategy: 'text', value: 'Checkout' }, description: 'Button “Checkout”', count: 1 },
      }),
    );
    expect(await within(panel).findByText('Picked: Button “Checkout”')).toBeInTheDocument();
    expect(within(panel).getByLabelText(/^Element/, { selector: 'input' })).toHaveValue('Checkout');
    expect(within(panel).getByLabelText('Element locator type')).toHaveValue('text');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => expect((await getWorkflow(w.id))!.steps[1]).toMatchObject({ params: { locator: { strategy: 'text', value: 'Checkout' } } }));
  });

  it('asks which page to open when the workflow has no Open URL yet, and picks similar items for loops', async () => {
    const user = userEvent.setup();
    const loop = { ...step('forEachElement', { locator: css('') }), children: [] };
    const w = await saveWorkflow(wf([loop as never], { name: 'Loop pick' }));
    mock().onCommand = () => ({ ok: true, data: null });
    renderAt(`#/workflows/${w.id}`);
    const panel = await screen.findByRole('complementary', { name: 'Configuration' });
    await user.click(within(panel).getByRole('button', { name: /Pick on page/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Which page should FlowPilot open?' });
    const input = within(dialog).getByLabelText('Page address');
    await user.clear(input);
    await user.type(input, 'https://news.test/');
    await user.click(within(dialog).getByRole('button', { name: 'Open and pick' }));
    await waitFor(() => expect(commands()).toContainEqual(expect.objectContaining({ type: 'picker.start', url: 'https://news.test/', mode: 'multiple' })));
  });

  it('shows cancellation and errors', async () => {
    const user = userEvent.setup();
    const w = await saveWorkflow(wf([step('openUrl', { url: 'https://shop.test/' }), step('click', { locator: css('') })]));
    mock().onCommand = (m) =>
      (m as { command: Command }).command.type === 'picker.start'
        ? { ok: false, error: { code: 'PERMISSION_DENIED', message: 'FlowPilot does not have access to this site.' } }
        : { ok: true, data: null };
    renderAt(`#/workflows/${w.id}`);
    await user.click(await screen.findByRole('treeitem', { name: /Step 2/ }));
    await user.click(screen.getByRole('button', { name: /Pick on page/ }));
    expect(await screen.findByText('FlowPilot does not have access to this site.')).toBeInTheDocument();
  });
});
