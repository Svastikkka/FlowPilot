import { useEffect, useState } from 'react';
import type { Step } from '../../shared/schema/types';
import { RECORDING_KEY } from '../../shared/recorder';
import type { RecordingSession } from '../../shared/recorder';
import { actionDef, stepSummary, stepTitle } from '../../shared/schema/actions';
import { checkUrl } from '../../shared/schema/validate';
import { newWorkflow } from '../../shared/schema/factory';
import { saveWorkflow } from '../../storage/workflows';
import { getSettings } from '../../storage/settings';
import { originPattern, requestAccess, sendCommand } from '../api';
import { navigate } from '../router';
import { ConfirmDialog, Loading, useToast } from '../components/ui';

/** Live view of the recording session stored by the service worker. */
export function useRecording(): RecordingSession | null | undefined {
  const [session, setSession] = useState<RecordingSession | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void chrome.storage.session.get(RECORDING_KEY).then((v) => alive && setSession((v[RECORDING_KEY] as RecordingSession | undefined) ?? null));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && RECORDING_KEY in changes) setSession((changes[RECORDING_KEY].newValue as RecordingSession | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);
  return session;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

export function RecorderPage() {
  const session = useRecording();
  if (session === undefined) return <Loading />;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Recorder</h1>
          <p>Record clicks, typing and choices on a page, then turn them into an editable workflow.</p>
        </div>
      </div>
      {!session ? <StartRecording /> : session.status === 'recording' ? <LiveRecording session={session} /> : <ReviewRecording key={session.id} session={session} />}
    </div>
  );
}

function StartRecording() {
  const [url, setUrl] = useState('https://');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = url.trim() === 'https://' ? 'Enter the page to start on' : checkUrl(url);

  const start = () => {
    const origin = originPattern(url.trim());
    if (problem || !origin) return;
    setBusy(true);
    setError(null);
    // Ask for the site inside the click; recording needs it to see the page.
    requestAccess([origin])
      .then((ok) => {
        if (!ok) throw new Error('FlowPilot needs access to this site to record on it.');
        return sendCommand({ type: 'recorder.start', url: url.trim() });
      })
      .catch((e: Error) => {
        setError(e.message);
        setBusy(false);
      });
  };

  return (
    <div className="card card-pad stack">
      <h2>Start a recording</h2>
      <form
        className="row"
        style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="rec-url">Page to start on</label>
          <input id="rec-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/login" aria-invalid={!!error || undefined} />
        </div>
        <button className="btn btn-primary" type="submit" disabled={!!problem || busy} style={{ marginTop: 26 }}>
          ⏺ Start recording
        </button>
      </form>
      {error && (
        <div className="banner danger" role="alert">
          <span aria-hidden>⚠</span>
          <div className="banner-body">{error}</div>
        </div>
      )}
      <p className="small muted">You can also record the page you're on: click the FlowPilot toolbar button and choose <strong>Record this tab</strong>.</p>
      <div className="banner info">
        <span aria-hidden>ℹ</span>
        <div className="banner-body small">
          <strong>What is recorded:</strong> clicks, text you type into fields, dropdown choices, checkboxes, and addresses you type into the address bar —
          only in the tab FlowPilot opens, only until you press Stop. A red “Recording” badge stays on the page the whole time.
          <br />
          <strong>Never recorded:</strong> passwords, one-time codes and card details (the step asks for the value when you run it instead), and anything in
          other tabs.
        </div>
      </div>
    </div>
  );
}

function LiveRecording({ session }: { session: RecordingSession }) {
  const toast = useToast();
  const stop = () => void sendCommand({ type: 'recorder.stop' }).catch((e: Error) => toast(e.message, 'error'));
  const showTab = () =>
    void chrome.tabs
      .update(session.tabId, { active: true })
      .then((t) => t && chrome.windows.update(t.windowId, { focused: true }))
      .catch(() => toast('The recorded tab was closed', 'error'));
  const grant = () => {
    const origin = session.blockedHost ? originPattern(`https://${session.blockedHost}/`) : null;
    if (!origin) return;
    void requestAccess([origin, origin.replace('https:', 'http:')]).then((ok) => ok && sendCommand({ type: 'recorder.reattach' }));
  };
  return (
    <>
      <div className="banner danger" role="status">
        <span className="rec-dot" aria-hidden />
        <div className="banner-body">
          <strong>Recording</strong> in the tab FlowPilot opened ({hostOf(session.startUrl) || 'current page'}). Use that page as you normally would, then press Stop.
        </div>
        <button className="btn btn-sm" onClick={showTab}>
          Show tab
        </button>
        <button className="btn btn-sm btn-danger solid" onClick={stop}>
          ■ Stop
        </button>
      </div>
      {session.blockedHost && (
        <div className="banner warning">
          <span aria-hidden>⚠</span>
          <div className="banner-body">FlowPilot can't record on {session.blockedHost} without access to it. Actions there aren't being recorded.</div>
          <button className="btn btn-sm" onClick={grant}>
            Allow {session.blockedHost}
          </button>
        </div>
      )}
      <div className="card">
        <div className="card-header">
          <h2>Recorded steps</h2>
          <span className="muted small">{session.steps.length} so far</span>
        </div>
        {session.steps.length === 0 ? (
          <p className="card-pad muted">Waiting for your first action…</p>
        ) : (
          <ol className="rec-steps">
            {session.steps.map((s, i) => (
              <li key={s.id}>
                <span className="step-num">{i + 1}</span>
                <span aria-hidden>{actionDef(s.type).icon}</span>
                <strong>{stepTitle(s)}</strong>
                <span className="mono muted small">{stepSummary(s)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function ReviewRecording({ session }: { session: RecordingSession }) {
  const toast = useToast();
  const [steps, setSteps] = useState<Step[]>(session.steps);
  const [name, setName] = useState(`Recorded on ${hostOf(session.startUrl) || 'a page'} — ${new Date(session.startedAt).toLocaleDateString()}`);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const secretNames = new Set(session.variables.map((v) => v.name));

  const update = (i: number, patch: (s: Step) => Step) => setSteps((all) => all.map((s, j) => (j === i ? patch(s) : s)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((all) => {
      const next = [...all];
      const [x] = next.splice(i, 1);
      next.splice(i + d, 0, x);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const s = await getSettings();
      const usedVars = session.variables.filter((v) => steps.some((st) => JSON.stringify(st.params).includes(`{{${v.name}}}`)));
      const wf = await saveWorkflow(
        newWorkflow({
          name: name.trim() || 'Recorded workflow',
          description: `Recorded on ${new Date(session.startedAt).toLocaleString()}.`,
          tags: ['recorded'],
          steps,
          variables: usedVars,
          settings: { defaultTimeoutMs: s.defaultTimeoutMs, defaultRetries: s.defaultRetries, defaultOnError: s.defaultOnError, stepDelayMs: s.stepDelayMs },
        }),
      );
      await sendCommand({ type: 'recorder.discard' });
      toast('Saved — review and test it in the editor');
      navigate(`/workflows/${wf.id}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setSaving(false);
    }
  };

  return (
    <>
      <div className="card card-pad stack">
        <h2>Review the recording</h2>
        <p className="small muted">
          Remove steps you don't need, fix targets or text, and reorder. After saving you can add waits, conditions and loops in the editor.
          {session.truncated && ' The recording reached the 500-step limit; later actions were not recorded.'}
        </p>
        <div className="field" style={{ maxWidth: 520 }}>
          <label htmlFor="rec-name">Workflow name</label>
          <input id="rec-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="card">
        <div className="card-header">
          <h2>{steps.length} recorded step{steps.length === 1 ? '' : 's'}</h2>
        </div>
        {steps.length === 0 ? (
          <p className="card-pad muted">Nothing was recorded.</p>
        ) : (
          <ol className="rec-review">
            {steps.map((s, i) => {
              const locator = (s.params as { locator?: { strategy: string; value: string } }).locator;
              const secret = s.type === 'type' && /^\{\{(\w+)\}\}$/.exec(s.params.text)?.[1];
              return (
                <li key={s.id} aria-label={`Recorded step ${i + 1}: ${stepTitle(s)}`}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <span className="step-num">{i + 1}</span>
                    <span aria-hidden>{actionDef(s.type).icon}</span>
                    <strong style={{ flex: 1 }}>{stepTitle(s)}</strong>
                    <button className="icon-btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      ↑
                    </button>
                    <button className="icon-btn" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                      ↓
                    </button>
                    <button className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>
                      🗑
                    </button>
                  </div>
                  <div className="rec-fields">
                    {s.type === 'openUrl' && (
                      <input aria-label={`Step ${i + 1} URL`} className="mono" value={s.params.url} onChange={(e) => update(i, (x) => ({ ...x, params: { ...x.params, url: e.target.value } }) as Step)} />
                    )}
                    {locator && (
                      <input
                        aria-label={`Step ${i + 1} target`}
                        className="mono"
                        value={locator.value}
                        title={`Located by ${locator.strategy}`}
                        onChange={(e) => update(i, (x) => ({ ...x, params: { ...x.params, locator: { ...locator, value: e.target.value } } }) as Step)}
                      />
                    )}
                    {s.type === 'type' &&
                      (secret && secretNames.has(secret) ? (
                        <span className="badge waiting_for_user" title="Sensitive field: the value is asked for when the workflow runs">
                          🔒 asks for {`{{${secret}}}`} at run time
                        </span>
                      ) : (
                        <input aria-label={`Step ${i + 1} text`} value={s.params.text} onChange={(e) => update(i, (x) => ({ ...x, params: { ...x.params, text: e.target.value } }) as Step)} />
                      ))}
                    {s.type === 'select' && (
                      <input aria-label={`Step ${i + 1} option`} value={s.params.value} onChange={(e) => update(i, (x) => ({ ...x, params: { ...x.params, value: e.target.value } }) as Step)} />
                    )}
                    {s.type === 'check' && <span className="muted small">{s.params.checked ? 'checked' : 'unchecked'}</span>}
                    {s.type === 'type' && s.params.pressEnter && <span className="muted small">then Enter</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div className="card-pad row" style={{ borderTop: '1px solid var(--border)' }}>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || steps.length === 0}>
            Save as workflow
          </button>
          <button className="btn btn-danger" onClick={() => setConfirmDiscard(true)}>
            Discard
          </button>
        </div>
      </div>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this recording?"
          message="The recorded steps will be deleted."
          confirmLabel="Discard"
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => void sendCommand({ type: 'recorder.discard' }).then(() => setConfirmDiscard(false))}
        />
      )}
    </>
  );
}
