import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JSDOM } from 'jsdom';
import { appendEvent, newSession, RECORDING_KEY } from '../../src/shared/recorder';
import type { RecordingSession } from '../../src/shared/recorder';
import { startRecorder } from '../../src/content/recorder';
import { newWorkflow } from '../../src/shared/schema/factory';
import { validateWorkflow } from '../../src/shared/schema/validate';
import { App } from '../../src/ui/app/App';
import { getWorkflow, listWorkflows } from '../../src/storage/workflows';
import { JsdomBrowser } from '../helpers/jsdomBrowser';
import { runWorkflow } from '../helpers/run';
import { FAST_SETTINGS } from '../helpers/fakes';
import type { ChromeMock } from '../helpers/chromeMock';

const SIGNUP = `<!doctype html><html><head><title>Sign up</title></head><body>
  <form action="/done">
    <label for="name">Full name</label><input id="name" name="name">
    <label for="pw">Password</label><input id="pw" name="pw" type="password">
    <select name="plan"><option>Free</option><option>Team</option></select>
    <label><input type="checkbox" name="news"> Newsletter</label>
    <button>Create account</button>
  </form></body></html>`;

describe('record → replay round trip', () => {
  it('replays a recorded session and reproduces the same submission, asking for the password at run time', async () => {
    // 1. Record a user filling in the form.
    const dom = new JSDOM(SIGNUP, { url: 'https://app.test/signup' });
    const doc = dom.window.document;
    const session = newSession('r', 1, 'https://app.test/signup', 1000);
    let t = 2000;
    const handle = startRecorder(doc, (e) => appendEvent(session, { ...e, at: (t += 100) }), () => undefined, { requireTrusted: false });
    const change = (el: Element) => el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const name = doc.getElementById('name') as HTMLInputElement;
    name.value = 'Ada Lovelace';
    change(name);
    const pw = doc.getElementById('pw') as HTMLInputElement;
    pw.value = 'correct horse';
    change(pw);
    const plan = doc.querySelector('select')!;
    plan.selectedIndex = 1;
    change(plan);
    (doc.querySelector('input[type=checkbox]') as HTMLInputElement).click();
    doc.querySelector('form')!.addEventListener('submit', (e) => e.preventDefault());
    doc.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    handle.stop();

    expect(session.steps.map((s) => s.type)).toEqual(['openUrl', 'type', 'type', 'select', 'check', 'click']);
    expect(JSON.stringify(session)).not.toContain('correct horse');

    // 2. Save as a workflow and replay it against a fresh page.
    const workflow = { ...newWorkflow({ steps: session.steps, variables: session.variables }), settings: { ...FAST_SETTINGS, defaultTimeoutMs: 500 } };
    expect(validateWorkflow(workflow).errors).toEqual([]);
    const submissions: URLSearchParams[] = [];
    const browser = new JsdomBrowser({
      'https://app.test/signup': SIGNUP,
      'https://app.test/done': (url) => (submissions.push(url.searchParams), '<h1>Welcome</h1>'),
    });
    const { result } = await runWorkflow(workflow, browser, { inputs: { password: 'run-time secret' } });
    expect(result.status).toBe('succeeded');
    expect(Object.fromEntries(submissions[0])).toEqual({ name: 'Ada Lovelace', pw: 'run-time secret', plan: 'Team', news: 'on' });
  });
});

// ---------------------------------------------------------------------------
// Recorder page

const mock = () => (chrome as unknown as { __state: ChromeMock }).__state;
const commands = () =>
  (chrome.runtime.sendMessage as unknown as { mock: { calls: [{ command: { type: string } }][] } }).mock.calls.map(([m]) => m.command);

function renderAt(hash: string) {
  history.replaceState(null, '', hash);
  return render(<App />);
}

function stoppedSession(): RecordingSession {
  const s = newSession('rec_1', 9, 'https://app.test/signup', Date.parse('2026-10-23T10:00:00Z'));
  appendEvent(s, { kind: 'input', locator: { strategy: 'css', value: '#name' }, value: 'Ada', sensitive: false, field: 'Full name', at: s.startedAt + 1000 });
  appendEvent(s, { kind: 'input', locator: { strategy: 'css', value: '#pw' }, value: '', sensitive: true, field: 'Password', at: s.startedAt + 2000 });
  appendEvent(s, { kind: 'click', locator: { strategy: 'text', value: 'Create account' }, label: 'Create account', at: s.startedAt + 3000 });
  return { ...s, status: 'stopped' };
}

describe('Recorder page', () => {
  it('starts a recording after getting access to the site', async () => {
    const user = userEvent.setup();
    mock().onCommand = () => ({ ok: true, data: { sessionId: 'rec_1' } });
    renderAt('#/recorder');
    const url = await screen.findByLabelText('Page to start on');
    await user.clear(url);
    await user.type(url, 'https://app.test/signup');
    await user.click(screen.getByRole('button', { name: /Start recording/ }));
    await waitFor(() => expect(commands()).toContainEqual({ type: 'recorder.start', url: 'https://app.test/signup' }));
    expect(mock().permissionPrompts).toEqual([{ origins: ['https://app.test/*'] }]);
    expect(screen.getByText(/Never recorded:/)).toBeInTheDocument();
  });

  it('shows live steps while recording and can stop', async () => {
    const user = userEvent.setup();
    mock().sessionData[RECORDING_KEY] = { ...stoppedSession(), status: 'recording', blockedHost: 'login.other.test' };
    renderAt('#/recorder');
    expect(await screen.findByText('4 so far')).toBeInTheDocument();
    expect(screen.getByText(/can't record on login.other.test/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '■ Stop' }));
    expect(commands()).toContainEqual({ type: 'recorder.stop' });
  });

  it('reviews, edits and saves a recording as a workflow', async () => {
    const user = userEvent.setup();
    mock().sessionData[RECORDING_KEY] = stoppedSession();
    mock().onCommand = () => ({ ok: true, data: null });
    renderAt('#/recorder');
    expect(await screen.findByText('4 recorded steps')).toBeInTheDocument();
    expect(screen.getByText(/asks for \{\{password\}\} at run time/)).toBeInTheDocument();

    const text = screen.getByLabelText('Step 2 text');
    await user.clear(text);
    await user.type(text, 'Grace');
    await user.click(screen.getByRole('button', { name: 'Move step 4 up' }));
    await user.click(screen.getByRole('button', { name: 'Remove step 1' }));
    const name = screen.getByLabelText('Workflow name');
    await user.clear(name);
    await user.type(name, 'Sign up a user');
    await user.click(screen.getByRole('button', { name: 'Save as workflow' }));

    await waitFor(() => expect(location.hash).toMatch(/^#\/workflows\/wf_/));
    const [saved] = await listWorkflows();
    const full = (await getWorkflow(saved.id))!;
    expect(full.name).toBe('Sign up a user');
    expect(full.steps.map((s) => s.type)).toEqual(['type', 'click', 'type']);
    expect(full.steps[0]).toMatchObject({ params: { text: 'Grace' } });
    expect(full.variables).toEqual([expect.objectContaining({ name: 'password', secret: true, askAtRunStart: true })]);
    expect(commands()).toContainEqual({ type: 'recorder.discard' });
  });

  it('discards a recording after confirmation', async () => {
    const user = userEvent.setup();
    mock().sessionData[RECORDING_KEY] = stoppedSession();
    renderAt('#/recorder');
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Discard this recording?' })).getByRole('button', { name: 'Discard' }));
    expect(commands()).toContainEqual({ type: 'recorder.discard' });
  });
});
