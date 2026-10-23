import { useEffect, useMemo, useState } from 'react';
import type { Workflow } from '../../shared/schema/types';
import { validateWorkflow } from '../../shared/schema/validate';
import { listWorkflows } from '../../storage/workflows';
import { useSettings, useTheme } from '../hooks';
import { StatusBadge } from '../components/ui';
import { RunDialog } from '../components/RunDialog';

// Toolbar popup: run a saved workflow on the current tab. Access to the tab
// comes from activeTab, granted by the user opening the popup.

function openApp(hash = '/') {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#${hash}`) });
  window.close();
}

export function Popup() {
  const [settings] = useSettings();
  useTheme(settings?.theme);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  useEffect(() => {
    void listWorkflows().then(setWorkflows);
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
  }, []);

  const restricted = !tab?.url || !/^https?:/.test(tab.url);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (workflows ?? [])
      .filter((w) => !q || w.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastRun?.finishedAt ?? b.updatedAt) - (a.lastRun?.finishedAt ?? a.updatedAt));
  }, [workflows, query]);

  return (
    <div className="popup-root">
      <div className="row">
        <img src="icons/icon32.png" alt="" width={22} height={22} />
        <strong style={{ flex: 1 }}>FlowPilot</strong>
        <button className="btn btn-sm" onClick={() => openApp('/')}>
          Open dashboard
        </button>
      </div>

      {started ? (
        <div className="stack">
          <div className="banner success">
            <span aria-hidden>▶</span>
            <div className="banner-body">Run started on this tab.</div>
          </div>
          <button className="btn btn-primary" onClick={() => openApp(`/runs/${started}`)}>
            Watch progress
          </button>
        </div>
      ) : (
        <>
          {restricted && (
            <div className="banner warning small">
              <span aria-hidden>⚠</span>
              <div className="banner-body">This page can’t be automated. Open a website, or run from the dashboard (it opens its own tab).</div>
            </div>
          )}
          <input type="search" placeholder="Find a workflow…" aria-label="Find a workflow" value={query} onChange={(e) => setQuery(e.target.value)} />
          {workflows === null ? (
            <p className="muted small">Loading…</p>
          ) : workflows.length === 0 ? (
            <div className="stack">
              <p className="muted small">No workflows yet.</p>
              <button className="btn btn-primary" onClick={() => openApp('/new')}>
                ＋ Create workflow
              </button>
            </div>
          ) : (
            <div className="popup-list">
              {visible.map((w) => {
                const valid = validateWorkflow(w).valid;
                return (
                  <div key={w.id} className="popup-item">
                    <span className="name" title={w.name}>
                      {w.favorite ? '★ ' : ''}
                      {w.name}
                    </span>
                    {w.lastRun && <StatusBadge status={w.lastRun.status} />}
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!valid || restricted || !tab?.id}
                      title={!valid ? 'Fix the problems in the editor first' : 'Run on this tab'}
                      onClick={() => setSelected(w)}
                    >
                      ▶ Run here
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {selected && tab?.id !== undefined && (
        <RunDialog
          workflow={selected}
          target={{ kind: 'tab', tabId: tab.id }}
          context="popup"
          currentTabUrl={tab.url}
          onClose={() => setSelected(null)}
          onStarted={(runId) => (setSelected(null), setStarted(runId))}
          onOpenDashboard={() => openApp(`/?run=${selected.id}`)}
        />
      )}
    </div>
  );
}
