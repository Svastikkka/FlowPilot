import { useMemo, useState } from 'react';
import type { RunStatus } from '../../shared/schema/types';
import { clearHistory, deleteRun } from '../../storage/runs';
import { duration, relativeTime, useRuns } from '../hooks';
import { ConfirmDialog, EmptyState, ErrorState, Loading, StatusBadge, useToast } from '../components/ui';

export function HistoryPage() {
  const { data: runs, loading, error, reload } = useRuns();
  const [status, setStatus] = useState<RunStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();

  const visible = useMemo(
    () =>
      (runs ?? []).filter(
        (r) => (status === 'all' || r.status === status) && (!query.trim() || r.workflowName.toLowerCase().includes(query.trim().toLowerCase())),
      ),
    [runs, status, query],
  );
  const live = (s: RunStatus) => ['queued', 'running', 'paused', 'waiting_for_user'].includes(s);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Run history</h1>
          <p>Every run is recorded locally with step results and errors. Typed text and secret values are never recorded.</p>
        </div>
        <button className="btn btn-danger" onClick={() => setConfirmClear(true)} disabled={!runs?.length}>
          Clear history
        </button>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !runs ? (
        <Loading />
      ) : !runs?.length ? (
        <div className="card">
          <EmptyState icon="🕘" title="No runs yet" actions={<a className="btn" href="#/">Go to workflows</a>}>
            Runs appear here once you run a workflow or test a step.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <input type="search" placeholder="Filter by workflow…" aria-label="Filter by workflow" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | 'all')}>
              <option value="all">All statuses</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="stopped">Stopped</option>
              <option value="interrupted">Interrupted</option>
              <option value="running">Running</option>
            </select>
            <span className="muted small">{visible.length} runs</span>
          </div>
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Result</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`#/runs/${r.id}`}>{r.workflowName}</a>
                      {r.mode === 'testStep' && <span className="badge" style={{ marginLeft: 6 }}>Step test</span>}
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td title={new Date(r.startedAt).toLocaleString()}>{relativeTime(r.startedAt)}</td>
                    <td>{r.finishedAt ? duration(r.finishedAt - r.startedAt) : '—'}</td>
                    <td className="small muted" style={{ maxWidth: 380 }}>
                      {r.error ? (
                        <span style={{ color: 'var(--danger)' }}>
                          Step {(r.error.stepIndex ?? 0) + 1}: {r.error.message}
                        </span>
                      ) : (
                        r.summary ?? '—'
                      )}
                    </td>
                    <td>
                      <button
                        className="icon-btn"
                        aria-label={`Delete run of ${r.workflowName}`}
                        disabled={live(r.status)}
                        onClick={() => void deleteRun(r.id).then(reload)}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {confirmClear && (
        <ConfirmDialog
          title="Clear run history?"
          message="All run records, extracted results and screenshots stored by FlowPilot will be deleted. Workflows are kept."
          confirmLabel="Clear history"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearHistory().then(() => (setConfirmClear(false), toast('History cleared'), reload()))}
        />
      )}
    </div>
  );
}
