import { useEffect } from 'react';
import { useRoute, navigate } from '../router';
import type { Route } from '../router';
import { useSettings, useTheme } from '../hooks';
import { EmptyState, Loading, ToastProvider } from '../components/ui';
import { Dashboard, createWorkflow } from '../pages/Dashboard';
import { EditorPage } from '../pages/Editor';
import { MonitorPage } from '../pages/Monitor';
import { TemplatesPage } from '../pages/Templates';
import { HistoryPage } from '../pages/History';
import { SettingsPage } from '../pages/Settings';
import { PrivacyPage } from '../pages/Privacy';
import { RecorderPage } from '../pages/Recorder';
import { templateById } from '../../templates';
import { saveWorkflow } from '../../storage/workflows';

const NAV: { path: string; label: string; icon: string; match: Route['name'][]; tag?: string }[] = [
  { path: '/', label: 'Workflows', icon: '▤', match: ['dashboard', 'editor', 'new'] },
  { path: '/templates', label: 'Templates', icon: '❖', match: ['templates'] },
  { path: '/history', label: 'Run history', icon: '🕘', match: ['history', 'run'] },
  { path: '/recorder', label: 'Recorder', icon: '⏺', match: ['recorder'] },
  { path: '/settings', label: 'Settings', icon: '⚙', match: ['settings'] },
  { path: '/privacy', label: 'Privacy', icon: '🛡', match: ['privacy'] },
];

function NewWorkflow({ template }: { template?: string }) {
  useEffect(() => {
    const t = template ? templateById(template) : undefined;
    const created = t ? saveWorkflow(t.build()) : createWorkflow();
    void created.then((w) => navigate(`/workflows/${w.id}`, { replace: true, force: true }));
  }, [template]);
  return <Loading label="Creating workflow…" />;
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'dashboard':
      return <Dashboard />;
    case 'new':
      return <NewWorkflow template={route.template} />;
    case 'editor':
      return <EditorPage id={route.id} />;
    case 'run':
      return <MonitorPage id={route.id} />;
    case 'templates':
      return <TemplatesPage />;
    case 'history':
      return <HistoryPage />;
    case 'recorder':
      return <RecorderPage />;
    case 'settings':
      return <SettingsPage />;
    case 'privacy':
      return <PrivacyPage />;
    case 'notFound':
      return <EmptyState icon="🧭" title="Page not found" actions={<a className="btn" href="#/">Go to workflows</a>} />;
  }
}

export function App() {
  const route = useRoute();
  const [settings] = useSettings();
  useTheme(settings?.theme);

  return (
    <ToastProvider>
      <div className="shell">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <img src="icons/icon48.png" alt="" />
            <div>
              <strong>FlowPilot</strong>
              <small>Your browser. Your workflow.</small>
            </div>
          </div>
          {NAV.map((item) => (
            <a
              key={item.path}
              href={`#${item.path}`}
              className="nav-link"
              aria-current={item.match.includes(route.name) ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.path);
              }}
            >
              <span className="icon" aria-hidden>
                {item.icon}
              </span>
              {item.label}
              {item.tag && <span className="tag">{item.tag}</span>}
            </a>
          ))}
          <div className="sidebar-footer">Local only · no account · no tracking</div>
        </nav>
        <main className="main" id="main">
          <Page route={route} />
        </main>
      </div>
    </ToastProvider>
  );
}
