import { useEffect, useState } from 'react';
import type { ErrorPolicy } from '../../shared/schema/types';
import { exportWorkflows } from '../../shared/schema/importExport';
import { isFeatureEnabled } from '../../shared/features';
import { listWorkflows } from '../../storage/workflows';
import { clearAllData, clearHistory } from '../../storage/runs';
import { updateSettings } from '../../storage/settings';
import type { AppSettings } from '../../storage/settings';
import { useSettings } from '../hooks';
import { ALL_SITES, downloadFile, hostOf } from '../api';
import { ConfirmDialog, Loading, useToast } from '../components/ui';

export const PERMISSIONS: { name: string; why: string }[] = [
  { name: 'storage', why: 'Save your settings in this browser.' },
  { name: 'unlimitedStorage', why: 'Keep workflows, run history and screenshots locally without the default storage quota.' },
  { name: 'scripting', why: 'Inject FlowPilot’s page helper into the tab a run controls, only on sites you allowed.' },
  { name: 'activeTab', why: 'Run a workflow on the page you are viewing when you start it from the toolbar button, without granting permanent access.' },
  { name: 'Site access (optional)', why: 'Requested per site when you run a workflow that opens it. You can revoke it below at any time.' },
];

export function SettingsPage() {
  const [settings] = useSettings();
  const [origins, setOrigins] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'history' | 'all' | null>(null);
  const toast = useToast();

  const refreshOrigins = () => chrome.permissions.getAll().then((p) => setOrigins(p.origins ?? []));
  useEffect(() => {
    void refreshOrigins();
  }, []);

  if (!settings) return <Loading />;
  const set = (patch: Partial<AppSettings>) => void updateSettings(patch);
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Preferences are stored in this browser only.</p>
        </div>
      </div>

      <section className="card card-pad stack">
        <h2>Appearance</h2>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="theme">Theme</label>
          <select id="theme" value={settings.theme} onChange={(e) => set({ theme: e.target.value as AppSettings['theme'] })}>
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>

      <section className="card card-pad stack">
        <h2>Execution</h2>
        <label className="check">
          <input type="checkbox" checked={settings.highlightElements} onChange={(e) => set({ highlightElements: e.target.checked })} />
          Briefly outline elements before interacting with them
        </label>
        <h3>Defaults for new workflows</h3>
        <div className="field-row" style={{ maxWidth: 560 }}>
          <div className="field">
            <label htmlFor="d-timeout">Step timeout (ms)</label>
            <input id="d-timeout" type="number" min={100} max={600000} value={settings.defaultTimeoutMs} onChange={(e) => set({ defaultTimeoutMs: num(e.target.value, 100, 600000) })} />
          </div>
          <div className="field">
            <label htmlFor="d-retries">Retries</label>
            <input id="d-retries" type="number" min={0} max={10} value={settings.defaultRetries} onChange={(e) => set({ defaultRetries: num(e.target.value, 0, 10) })} />
          </div>
          <div className="field">
            <label htmlFor="d-onerror">If a step fails</label>
            <select id="d-onerror" value={settings.defaultOnError} onChange={(e) => set({ defaultOnError: e.target.value as ErrorPolicy })}>
              <option value="stop">Stop the run</option>
              <option value="skip">Skip and continue</option>
              <option value="ask">Ask me</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="d-delay">Delay between steps (ms)</label>
            <input id="d-delay" type="number" min={0} max={60000} value={settings.stepDelayMs} onChange={(e) => set({ stepDelayMs: num(e.target.value, 0, 60000) })} />
          </div>
        </div>
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="d-history">Keep the most recent runs</label>
          <input id="d-history" type="number" min={10} max={5000} value={settings.historyLimit} onChange={(e) => set({ historyLimit: num(e.target.value, 10, 5000) })} />
          <span className="help">Older runs and their screenshots are deleted automatically.</span>
        </div>
      </section>

      <section className="card card-pad stack" aria-labelledby="site-access">
        <h2 id="site-access">Site access</h2>
        <p className="small muted">FlowPilot can only automate sites listed here, plus the current tab when you start a run from the toolbar button.</p>
        {origins.length === 0 ? (
          <p className="small">No sites granted yet. FlowPilot asks when a workflow needs one.</p>
        ) : (
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
            {origins.map((o) => (
              <li key={o} className="row">
                <span className="mono" style={{ flex: 1 }}>
                  {hostOf(o)}
                </span>
                <button className="btn btn-sm btn-danger" onClick={() => void chrome.permissions.remove({ origins: [o] }).then(refreshOrigins)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
        {!origins.includes(ALL_SITES) && (
          <div>
            <button className="btn btn-sm" onClick={() => void chrome.permissions.request({ origins: [ALL_SITES] }).then(refreshOrigins)}>
              Allow all sites…
            </button>
            <span className="help small muted" style={{ marginLeft: 8 }}>
              Needed for screenshots and workflows whose URLs come from variables.
            </span>
          </div>
        )}
      </section>

      <section className="card card-pad stack">
        <h2>Permissions FlowPilot uses</h2>
        <table className="table perm-table">
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card card-pad stack">
        <h2>Your data</h2>
        <p className="small muted">
          Workflows, run history and screenshots are stored unencrypted in this browser profile. Nothing is sent to FlowPilot or any other server.
        </p>
        <div className="row">
          <button className="btn" onClick={() => void listWorkflows().then((w) => downloadFile(`flowpilot-workflows-${new Date().toISOString().slice(0, 10)}.json`, exportWorkflows(w)))}>
            Export all workflows
          </button>
          <button className="btn btn-danger" onClick={() => setConfirm('history')}>
            Delete run history
          </button>
          <button className="btn btn-danger solid" onClick={() => setConfirm('all')}>
            Delete all FlowPilot data
          </button>
        </div>
      </section>

      <section className="card card-pad stack">
        <h2>About</h2>
        <p className="small">
          FlowPilot {chrome.runtime.getManifest().version} · {isFeatureEnabled('advancedLogic') ? 'All features included' : 'Core features'} · No account
          required.
        </p>
      </section>

      {confirm === 'history' && (
        <ConfirmDialog
          title="Delete run history?"
          message="All run records, extracted results and screenshots will be deleted. Workflows are kept."
          confirmLabel="Delete history"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => void clearHistory().then(() => (setConfirm(null), toast('Run history deleted')))}
        />
      )}
      {confirm === 'all' && (
        <ConfirmDialog
          title="Delete all FlowPilot data?"
          message="This permanently deletes every workflow, run, extracted result, screenshot and setting stored by FlowPilot in this browser. Export your workflows first if you want to keep them."
          confirmLabel="Delete everything"
          danger
          requireText="DELETE"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void clearAllData().then(() => (setConfirm(null), toast('All FlowPilot data deleted')))}
        />
      )}
    </div>
  );
}
