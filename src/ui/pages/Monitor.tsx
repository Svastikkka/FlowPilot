import { useEffect, useState } from 'react';
import type { ExtractedResult, PendingPrompt, PromptResponse, RunRecord, Step, StepResult, Workflow } from '../../shared/schema/types';
import { actionDef, stepSummary, stepTitle } from '../../shared/schema/actions';
import { findStep, stepNumbers } from '../../shared/schema/tree';
import { toCsv as tableToCsv } from '../../shared/csv';
import { getArtifact } from '../../storage/runs';
import { getWorkflow } from '../../storage/workflows';
import { duration, relativeTime, useRun } from '../hooks';
import { downloadFile, sendCommand, slugify } from '../api';
import { navigate } from '../router';
import { EmptyState, Loading, Modal, STEP_ICON, StatusBadge, useToast } from '../components/ui';
import { RunDialog } from '../components/RunDialog';

const LIVE = ['queued', 'running', 'paused', 'waiting_for_user'];

export function MonitorPage({ id }: { id: string }) {
  const { run, loading } = useRun(id);
  if (loading && !run) return <Loading label="Loading run…" />;
  if (!run)
    return (
      <div className="page">
        <EmptyState icon="🔍" title="Run not found" actions={<a className="btn" href="#/history">Run history</a>}>
          It may have been removed from history.
        </EmptyState>
      </div>
    );
  return <Monitor run={run} />;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Monitor({ run }: { run: RunRecord }) {
  const live = LIVE.includes(run.status);
  const now = useNow(live);
  const toast = useToast();
  const [pauseRequested, setPauseRequested] = useState(false);
  const [workflow, setWorkflow] = useState<Workflow | null | undefined>(undefined);
  const [rerun, setRerun] = useState(false);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    void getWorkflow(run.workflowId).then((w) => setWorkflow(w ?? null));
  }, [run.workflowId, run.status]);
  useEffect(() => {
    if (run.status !== 'running') setPauseRequested(false);
  }, [run.status]);

  const steps = run.workflow.steps;
  const numbers = stepNumbers(steps);
  const results = new Map(run.steps.map((r) => [r.stepId, r]));
  const total = run.steps.length;
  const done = run.steps.filter((s) => s.status === 'succeeded' || s.status === 'failed' || s.status === 'skipped').length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const current = (run.currentStepId && findStep(steps, run.currentStepId)) || steps[run.currentStepIndex];
  const elapsed = (run.finishedAt ?? now) - run.startedAt;

  const command = (type: 'run.pause' | 'run.resume' | 'run.stop') =>
    sendCommand({ type, runId: run.id }).catch((e: Error) => toast(e.message, 'error'));

  const respond = (prompt: PendingPrompt, response: PromptResponse) =>
    sendCommand({ type: 'prompt.respond', runId: run.id, promptId: prompt.id, response }).catch((e: Error) => toast(e.message, 'error'));

  return (
    <div className="page">
      <div className="page-header">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <a href="#/history" className="btn btn-ghost btn-sm" aria-label="Back to history">
              ←
            </a>
            <h1>{run.workflowName}</h1>
            <StatusBadge status={run.status} />
            {run.mode === 'testStep' && <span className="badge">Step test</span>}
            {run.resumedFrom && (
              <a className="badge" href={`#/runs/${run.resumedFrom}`}>
                Resumed run
              </a>
            )}
          </div>
          <p className="muted small">
            Started {relativeTime(run.startedAt)} · {duration(elapsed)}
            {run.target.kind === 'tab' ? ' · on an existing tab' : ''}
          </p>
        </div>
        <div className="row">
          {live && (
            <>
              {run.status === 'paused' ? (
                <button className="btn" onClick={() => void command('run.resume')}>
                  ▶ Resume
                </button>
              ) : (
                <button className="btn" disabled={pauseRequested || run.status === 'waiting_for_user'} onClick={() => (setPauseRequested(true), void command('run.pause'))}>
                  ❚❚ {pauseRequested ? 'Pausing after this step…' : 'Pause'}
                </button>
              )}
              <button className="btn btn-danger" onClick={() => void command('run.stop')}>
                ■ Stop
              </button>
            </>
          )}
          {!live && run.status === 'interrupted' && (
            <button className="btn btn-primary" onClick={() => setResuming(true)}>
              ↻ Resume from step {current ? numbers.get(current.id) : run.currentStepIndex + 1}
            </button>
          )}
          {!live && run.mode === 'full' && (
            <button className="btn" disabled={!workflow} onClick={() => setRerun(true)} title={workflow ? 'Run the current version again' : 'The workflow was deleted'}>
              ↻ Rerun
            </button>
          )}
          {workflow && (
            <a className="btn" href={`#/workflows/${workflow.id}`}>
              Edit workflow
            </a>
          )}
        </div>
      </div>

      <div className="card card-pad stack" style={{ gap: 10 }}>
        <div className="row">
          <strong>
            {done} of {total} steps processed
          </strong>
          <span className="spacer" />
          <span className="muted small">{pct}%</span>
        </div>
        <div
          className={`progress ${run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'succeeded' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Run progress"
        >
          <div style={{ width: `${pct}%` }} />
        </div>
        {live && current && (
          <p className="small" aria-live="polite">
            {run.status === 'paused' ? 'Paused before' : run.status === 'waiting_for_user' ? 'Waiting for you at' : 'Now running'} step {numbers.get(current.id)}:{' '}
            <strong>
              {actionDef(current.type).icon} {stepTitle(current)}
            </strong>{' '}
            <span className="mono muted">{stepSummary(current)}</span>
          </p>
        )}
      </div>

      {run.pendingPrompt && <PromptCard prompt={run.pendingPrompt} onRespond={(r) => void respond(run.pendingPrompt!, r)} />}

      {!live && <Summary run={run} />}

      <section className="card" aria-label="Steps">
        <div className="card-header">
          <h2>Steps</h2>
        </div>
        <RunStepTree steps={steps} results={results} numbers={numbers} currentId={live ? current?.id : undefined} />
      </section>

      <ResultsTable run={run} />
      <ActivityLog run={run} />
      <Results run={run} />

      {rerun && workflow && (
        <RunDialog workflow={workflow} target={{ kind: 'newTab' }} context="dashboard" onClose={() => setRerun(false)} onStarted={(id) => (setRerun(false), navigate(`/runs/${id}`))} />
      )}
      {resuming && <ResumeDialog run={run} onClose={() => setResuming(false)} />}
    </div>
  );
}

function PromptCard({ prompt, onRespond }: { prompt: PendingPrompt; onRespond: (r: PromptResponse) => void }) {
  const [copyError, setCopyError] = useState<string | null>(null);
  const copy = () => {
    setCopyError(null);
    navigator.clipboard.writeText(prompt.text ?? '').then(
      () => onRespond({ action: 'copied' }),
      (e: Error) => setCopyError(`Copy failed: ${e.message}. Select the text and copy it manually, then choose “I copied it”.`),
    );
  };
  return (
    <section className="card card-pad stack prompt-card" role="alertdialog" aria-label="The run needs your input">
      <div className="row">
        <span aria-hidden>✋</span>
        <h2>
          {prompt.kind === 'error' ? 'A step failed' : prompt.kind === 'clipboard' ? 'Ready to copy' : prompt.kind === 'confirmBefore' ? 'Confirm this step' : 'Confirmation needed'}
        </h2>
      </div>
      <p>{prompt.message}</p>
      {prompt.kind === 'clipboard' && <pre>{prompt.text}</pre>}
      {copyError && <p className="small" style={{ color: 'var(--danger)' }}>{copyError}</p>}
      <div className="row">
        {prompt.kind === 'confirm' && (
          <>
            <button className="btn btn-primary" onClick={() => onRespond({ action: 'continue' })}>
              Continue
            </button>
            <button className="btn" onClick={() => onRespond({ action: 'cancel' })}>
              Stop the run
            </button>
          </>
        )}
        {prompt.kind === 'confirmBefore' && (
          <>
            <button className="btn btn-primary" onClick={() => onRespond({ action: 'continue' })}>
              Run this step
            </button>
            <button className="btn" onClick={() => onRespond({ action: 'skip' })}>
              Skip it
            </button>
            <button className="btn btn-danger" onClick={() => onRespond({ action: 'stop' })}>
              Stop the run
            </button>
          </>
        )}
        {prompt.kind === 'error' && (
          <>
            <button className="btn btn-primary" onClick={() => onRespond({ action: 'retry' })}>
              Retry
            </button>
            <button className="btn" onClick={() => onRespond({ action: 'skip' })}>
              Skip step
            </button>
            <button className="btn btn-danger" onClick={() => onRespond({ action: 'stop' })}>
              Stop the run
            </button>
          </>
        )}
        {prompt.kind === 'clipboard' && (
          <>
            <button className="btn btn-primary" onClick={copy}>
              📋 Copy to clipboard
            </button>
            {copyError && (
              <button className="btn" onClick={() => onRespond({ action: 'copied' })}>
                I copied it
              </button>
            )}
            <button className="btn" onClick={() => onRespond({ action: 'cancel' })}>
              Don’t copy
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function Summary({ run }: { run: RunRecord }) {
  const numbers = stepNumbers(run.workflow.steps);
  const failedStep = run.error?.stepId
    ? findStep(run.workflow.steps, run.error.stepId)
    : run.error?.stepIndex !== undefined
      ? run.workflow.steps[run.error.stepIndex]
      : undefined;
  const resumeStep = (run.currentStepId && findStep(run.workflow.steps, run.currentStepId)) || run.workflow.steps[run.currentStepIndex];
  const counts = { succeeded: 0, failed: 0, skipped: 0, pending: 0 };
  for (const s of run.steps) if (s.status in counts) counts[s.status as keyof typeof counts]++;
  const tone = run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : 'warning';
  return (
    <section className="stack" aria-label="Summary">
      <div className={`banner ${tone}`} role={run.status === 'failed' ? 'alert' : 'status'}>
        <span aria-hidden>{run.status === 'succeeded' ? '✓' : run.status === 'failed' ? '✕' : '!'}</span>
        <div className="banner-body">
          {failedStep ? (
            <>
              <strong>
                Step {numbers.get(failedStep.id)} “{stepTitle(failedStep)}” failed.
              </strong>{' '}
              {run.error!.message}
            </>
          ) : (
            <strong>{run.summary ?? run.status}</strong>
          )}
          {failedStep && run.summary && <p className="small muted">{run.summary}</p>}
          {run.status === 'interrupted' && (
            <p className="small">
              Resuming re-runs step {resumeStep ? numbers.get(resumeStep.id) : run.currentStepIndex + 1}. If that step had already taken effect on the page (for example a click), check the page
              first.
            </p>
          )}
        </div>
      </div>
      <div className="stats">
        {(['succeeded', 'failed', 'skipped', 'pending'] as const).map((k) => (
          <div key={k} className="card stat">
            <div className="label">{k === 'pending' ? 'Not run' : k[0].toUpperCase() + k.slice(1)}</div>
            <div className="value">{counts[k]}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function toCsv(results: ExtractedResult[], label: (r: ExtractedResult) => string): string {
  return tableToCsv(
    ['step', 'variable', 'kind', 'value'],
    results.map((r) => [label(r), r.variable, r.kind, r.kind === 'text' ? r.value : `[screenshot ${r.artifactId}]`]),
  );
}

function Results({ run }: { run: RunRecord }) {
  const toast = useToast();
  if (run.results.length === 0) return null;
  const numbers = stepNumbers(run.workflow.steps);
  const label = (r: ExtractedResult) => numbers.get(r.stepId) ?? String(r.stepIndex + 1);
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast('Copied to clipboard'),
      () => toast('Copy failed', 'error'),
    );
  const base = `${slugify(run.workflowName)}-${new Date(run.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  return (
    <section className="card" aria-label="Results">
      <div className="card-header">
        <h2>Results</h2>
        <div className="row">
          <button className="btn btn-sm" onClick={() => downloadFile(`${base}.json`, JSON.stringify(run.results.filter((r) => r.kind === 'text').map((r) => ({ step: label(r), variable: r.variable, value: r.value })), null, 2))}>
            Download JSON
          </button>
          <button className="btn btn-sm" onClick={() => downloadFile(`${base}.csv`, toCsv(run.results, label), 'text/csv')}>
            Download CSV
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="results-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Variable</th>
              <th>Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {run.results.map((r, i) => (
              <tr key={i}>
                <td>{label(r)}</td>
                <td className="mono">{r.kind === 'text' ? `{{${r.variable}}}` : r.variable}</td>
                <td className="value">{r.kind === 'screenshot' && r.artifactId ? <Screenshot id={r.artifactId} label={r.variable} /> : r.value}</td>
                <td>
                  {r.kind === 'text' && (
                    <button className="btn btn-sm" onClick={() => void copy(r.value)} aria-label={`Copy ${r.variable}`}>
                      Copy
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Screenshot({ id, label }: { id: string; label: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    void getArtifact(id).then((a) => setSrc(a?.dataUrl ?? null));
  }, [id]);
  if (src === undefined) return <span className="muted">Loading…</span>;
  if (src === null) return <span className="muted">Screenshot was deleted</span>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <img className="shot" src={src} alt={`Screenshot: ${label}`} style={{ maxHeight: 280 }} />
      <a href={src} download={`${slugify(label)}.png`} className="small">
        Download PNG
      </a>
    </div>
  );
}

function ResumeDialog({ run, onClose }: { run: RunRecord; onClose: () => void }) {
  const secretInputs = run.workflow.variables.filter((v) => v.secret && v.askAtRunStart);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const step = (run.currentStepId && findStep(run.workflow.steps, run.currentStepId)) || run.workflow.steps[run.currentStepIndex];
  const numbers = stepNumbers(run.workflow.steps);
  const resume = () => {
    setBusy(true);
    sendCommand({ type: 'run.resumeInterrupted', runId: run.id, inputs })
      .then(({ runId }) => (onClose(), navigate(`/runs/${runId}`)))
      .catch((e: Error) => (setError(e.message), setBusy(false)));
  };
  return (
    <Modal
      title="Resume interrupted run"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={resume} disabled={busy}>
            Resume
          </button>
        </>
      }
    >
      <p>
        The run continues from step {step ? numbers.get(step.id) : run.currentStepIndex + 1}
        {step ? ` “${stepTitle(step)}”` : ''} with the values captured so far, in the original tab if it is still open.
      </p>
      {secretInputs.length > 0 && (
        <div className="stack">
          <p className="small muted">Secret values are never stored, so enter them again:</p>
          {secretInputs.map((v) => (
            <div className="field" key={v.name}>
              <label htmlFor={`resume-${v.name}`}>{v.description || v.name}</label>
              <input id={`resume-${v.name}`} type="password" autoComplete="off" value={inputs[v.name] ?? ''} onChange={(e) => setInputs({ ...inputs, [v.name]: e.target.value })} />
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="banner danger" role="alert">
          <div className="banner-body">{error}</div>
        </div>
      )}
    </Modal>
  );
}

function RunStepTree({
  steps,
  results,
  numbers,
  currentId,
}: {
  steps: Step[];
  results: Map<string, StepResult>;
  numbers: Map<string, string>;
  currentId?: string;
}) {
  const branchLabel = (step: Step, branch: 'children' | 'elseChildren') => (step.type === 'if' ? (branch === 'children' ? 'Then' : 'Else') : undefined);
  const renderList = (list: Step[], nested: boolean) => (
    <ol className={`run-steps${nested ? ' nested' : ''}`}>
      {list.map((step) => {
        const r = results.get(step.id);
        const isCurrent = step.id === currentId;
        const branches = (['children', 'elseChildren'] as const).filter((b) => step[b] !== undefined && (b === 'children' || step.type === 'if'));
        return (
          <li key={step.id} className={`run-step-item${isCurrent ? ' current' : ''}`} aria-current={isCurrent ? 'step' : undefined}>
            <div className="run-step">
              <span className={`status-icon ${r?.status ?? 'pending'}`} aria-label={r?.status ?? 'pending'}>
                {r?.status === 'running' ? <span className="spinner" style={{ width: 10, height: 10 }} aria-hidden /> : STEP_ICON[r?.status ?? 'pending']}
              </span>
              <div style={{ minWidth: 0 }}>
                <div>
                  <span className="muted">{numbers.get(step.id)}.</span> {actionDef(step.type).icon} <strong>{stepTitle(step)}</strong>{' '}
                  <span className="mono muted small">{stepSummary(step)}</span>
                </div>
                {r?.message && <div className={`msg${r.status === 'failed' ? ' err' : ''}`}>{r.message}</div>}
              </div>
              <div className="muted small" style={{ textAlign: 'right' }}>
                {r && (r.executions ?? 0) > 1 && !actionDef(step.type).block && <div>ran {r.executions}×</div>}
                {r && r.attempts > 1 && <div>{r.attempts} attempts</div>}
                {r?.startedAt && r.finishedAt && <div>{duration(r.finishedAt - r.startedAt)}</div>}
              </div>
            </div>
            {branches.map((b) =>
              (step[b]?.length ?? 0) > 0 ? (
                <div key={b} className="run-branch">
                  {branchLabel(step, b) && <div className="branch-label">{branchLabel(step, b)}</div>}
                  {renderList(step[b]!, true)}
                </div>
              ) : null,
            )}
          </li>
        );
      })}
    </ol>
  );
  return renderList(steps, false);
}

function ResultsTable({ run }: { run: RunRecord }) {
  const table = run.table;
  const [showAll, setShowAll] = useState(false);
  if (!table || table.rows.length === 0) return null;
  const rows = showAll ? table.rows : table.rows.slice(0, 100);
  const base = `${slugify(run.workflowName)}-table-${new Date(run.startedAt).toISOString().slice(0, 10)}`;
  return (
    <section className="card" aria-label="Results table">
      <div className="card-header">
        <h2>
          Results table <span className="muted small">({table.rows.length} rows)</span>
        </h2>
        <div className="row">
          <button className="btn btn-sm" onClick={() => downloadFile(`${base}.csv`, tableToCsv(table.columns, table.rows.map((r) => table.columns.map((c) => r[c] ?? ''))), 'text/csv')}>
            Download CSV
          </button>
          <button className="btn btn-sm" onClick={() => downloadFile(`${base}.json`, JSON.stringify(table.rows, null, 2))}>
            Download JSON
          </button>
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 480, overflow: 'auto' }}>
        <table className="results-table">
          <thead>
            <tr>
              <th>#</th>
              {table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="muted">{i + 1}</td>
                {table.columns.map((c) => (
                  <td key={c} className="value">
                    {r[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > rows.length && (
        <div className="card-pad">
          <button className="btn btn-sm" onClick={() => setShowAll(true)}>
            Show all {table.rows.length} rows
          </button>
        </div>
      )}
    </section>
  );
}

function ActivityLog({ run }: { run: RunRecord }) {
  const log = run.log ?? [];
  if (log.length === 0) return null;
  const numbers = stepNumbers(run.workflow.steps);
  const titles = new Map<string, string>();
  for (const s of run.steps) {
    const step = findStep(run.workflow.steps, s.stepId);
    if (step) titles.set(s.stepId, stepTitle(step));
  }
  return (
    <details className="card activity">
      <summary className="card-header">
        <h2>Activity log</h2>
        <span className="muted small">{log.length >= 500 ? 'last 500 events' : `${log.length} events`}</span>
      </summary>
      <ol className="log-list">
        {[...log].reverse().map((e, i) => (
          <li key={i} className={`log-${e.status}`}>
            <span className="muted mono small">{new Date(e.at).toLocaleTimeString()}</span>
            <span className={`status-icon ${e.status}`} aria-label={e.status}>
              {STEP_ICON[e.status]}
            </span>
            <span>
              <strong>
                {numbers.get(e.stepId)} {titles.get(e.stepId)}
              </strong>
              {e.context && <span className="muted"> · {e.context}</span>} — {e.message}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
