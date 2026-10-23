import { useEffect, useMemo, useRef, useState } from 'react';
import type { Workflow } from '../../shared/schema/types';
import { validateWorkflow } from '../../shared/schema/validate';
import { countSteps } from '../../shared/schema/tree';
import { exportWorkflows, ImportError, parseImport } from '../../shared/schema/importExport';
import type { ImportResult } from '../../shared/schema/importExport';
import { newWorkflow } from '../../shared/schema/factory';
import { deleteWorkflow, duplicateWorkflow, putWorkflowMeta, saveWorkflow, saveWorkflows } from '../../storage/workflows';
import { getSettings } from '../../storage/settings';
import { useRuns, useWorkflows, relativeTime } from '../hooks';
import { downloadFile, slugify } from '../api';
import { navigate } from '../router';
import { ConfirmDialog, EmptyState, ErrorState, Loading, Menu, Modal, PromptDialog, StatusBadge, useToast } from '../components/ui';
import { RunDialog } from '../components/RunDialog';

type Sort = 'updated' | 'name' | 'lastRun' | 'created';

export async function createWorkflow(): Promise<Workflow> {
  const s = await getSettings();
  const wf = newWorkflow({
    settings: { defaultTimeoutMs: s.defaultTimeoutMs, defaultRetries: s.defaultRetries, defaultOnError: s.defaultOnError, stepDelayMs: s.stepDelayMs },
  });
  return saveWorkflow(wf);
}

export function Dashboard() {
  const { data: workflows, loading, error, reload } = useWorkflows();
  const { data: runs } = useRuns({ limit: 50 });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const [tag, setTag] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [runTarget, setRunTarget] = useState<Workflow | null>(null);
  const [renaming, setRenaming] = useState<Workflow | null>(null);
  const [deleting, setDeleting] = useState<Workflow | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const toast = useToast();

  // The popup links here with ?run=<id> when a run needs site access granted.
  useEffect(() => {
    const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('run');
    if (id && workflows) {
      const wf = workflows.find((w) => w.id === id);
      if (wf) setRunTarget(wf);
      history.replaceState(null, '', '#/');
    }
  }, [workflows]);

  const tags = useMemo(() => [...new Set((workflows ?? []).flatMap((w) => w.tags))].sort(), [workflows]);
  const activeRuns = (runs ?? []).filter((r) => ['queued', 'running', 'paused', 'waiting_for_user'].includes(r.status));
  const recent = useMemo(
    () =>
      (workflows ?? [])
        .filter((w) => w.lastRun)
        .sort((a, b) => b.lastRun!.finishedAt - a.lastRun!.finishedAt)
        .slice(0, 4),
    [workflows],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (workflows ?? []).filter(
      (w) =>
        (!favoritesOnly || w.favorite) &&
        (!tag || w.tags.includes(tag)) &&
        (!q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q) || w.tags.some((t) => t.includes(q))),
    );
    const by: Record<Sort, (a: Workflow, b: Workflow) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      created: (a, b) => b.createdAt - a.createdAt,
      name: (a, b) => a.name.localeCompare(b.name),
      lastRun: (a, b) => (b.lastRun?.finishedAt ?? 0) - (a.lastRun?.finishedAt ?? 0),
    };
    return list.sort((a, b) => Number(b.favorite) - Number(a.favorite) || by[sort](a, b));
  }, [workflows, query, tag, favoritesOnly, sort]);

  const onImport = async (file: File) => {
    try {
      const result = parseImport(await file.text());
      await saveWorkflows(result.imported.map((i) => i.workflow));
      setImportResult(result);
      await reload();
    } catch (e) {
      toast(e instanceof ImportError ? `Import failed: ${e.message}` : 'Import failed: could not read the file', 'error');
    }
  };

  const toggleFavorite = async (w: Workflow) => {
    await putWorkflowMeta({ ...w, favorite: !w.favorite });
    await reload();
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workflows</h1>
          <p>Build, save and run browser automations. Everything stays on this device.</p>
        </div>
        <div className="row">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Import workflow file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImport(f);
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Import
          </button>
          <a className="btn" href="#/templates">
            Templates
          </a>
          <button className="btn btn-primary" onClick={() => void createWorkflow().then((w) => navigate(`/workflows/${w.id}`))}>
            ＋ Create workflow
          </button>
        </div>
      </div>

      {activeRuns.length > 0 && (
        <div className="banner info" role="status">
          <span className="spinner" aria-hidden />
          <div className="banner-body">
            {activeRuns.length === 1 ? `“${activeRuns[0].workflowName}” is running.` : `${activeRuns.length} workflows are running.`}
          </div>
          <a className="btn btn-sm" href={`#/runs/${activeRuns[0].id}`}>
            View
          </a>
        </div>
      )}

      {recent.length > 0 && (
        <section className="stack" aria-label="Recently run">
          <h2>Recently run</h2>
          <div className="recent-list">
            {recent.map((w) => (
              <a key={w.id} className="recent-item" href={`#/runs/${w.lastRun!.runId}`}>
                <StatusBadge status={w.lastRun!.status} />
                <span>{w.name}</span>
                <span className="muted small">{relativeTime(w.lastRun!.finishedAt)}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !workflows ? (
        <Loading />
      ) : workflows && workflows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="🧭"
            title="No workflows yet"
            actions={
              <>
                <button className="btn btn-primary" onClick={() => void createWorkflow().then((w) => navigate(`/workflows/${w.id}`))}>
                  ＋ Create workflow
                </button>
                <a className="btn" href="#/templates">
                  Browse templates
                </a>
              </>
            }
          >
            Start from scratch, pick a template, or import a workflow file.
          </EmptyState>
        </div>
      ) : (
        <section className="stack" aria-label="All workflows">
          <div className="toolbar">
            <input type="search" placeholder="Search workflows…" aria-label="Search workflows" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="updated">Recently edited</option>
              <option value="lastRun">Recently run</option>
              <option value="created">Newest</option>
              <option value="name">Name</option>
            </select>
            <button className="tag-chip" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly((f) => !f)}>
              ★ Favorites
            </button>
            {tags.map((t) => (
              <button key={t} className="tag-chip" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                {t}
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="muted">No workflows match your filters.</p>
          ) : (
            <div className="wf-grid">
              {visible.map((w) => (
                <WorkflowCard
                  key={w.id}
                  workflow={w}
                  onRun={() => setRunTarget(w)}
                  onFavorite={() => void toggleFavorite(w)}
                  onDuplicate={() => void duplicateWorkflow(w.id).then(() => (toast('Workflow duplicated'), reload()))}
                  onRename={() => setRenaming(w)}
                  onExport={() => downloadFile(`${slugify(w.name)}.flowpilot.json`, exportWorkflows([w]))}
                  onDelete={() => setDeleting(w)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {runTarget && (
        <RunDialog
          workflow={runTarget}
          target={{ kind: 'newTab' }}
          context="dashboard"
          onClose={() => setRunTarget(null)}
          onStarted={(runId) => navigate(`/runs/${runId}`)}
        />
      )}
      {renaming && (
        <PromptDialog
          title="Rename workflow"
          label="Name"
          initial={renaming.name}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => void saveWorkflow({ ...renaming, name }).then(() => (setRenaming(null), reload()))}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete workflow?"
          message={`“${deleting.name}” will be permanently deleted from this browser.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void deleteWorkflow(deleting.id).then(() => (setDeleting(null), toast('Workflow deleted'), reload()))}
        />
      )}
      {importResult && <ImportSummary result={importResult} onClose={() => setImportResult(null)} />}
    </div>
  );
}

function WorkflowCard(props: {
  workflow: Workflow;
  onRun: () => void;
  onFavorite: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const w = props.workflow;
  const valid = useMemo(() => validateWorkflow(w).valid, [w]);
  const stepCount = useMemo(() => countSteps(w.steps), [w.steps]);
  return (
    <article className="card wf-card">
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <h3 style={{ flex: 1, minWidth: 0 }}>
          <a href={`#/workflows/${w.id}`}>{w.name}</a>
        </h3>
        <button className={`icon-btn${w.favorite ? ' on' : ''}`} aria-pressed={w.favorite} aria-label={`${w.favorite ? 'Unfavorite' : 'Favorite'} ${w.name}`} onClick={props.onFavorite}>
          {w.favorite ? '★' : '☆'}
        </button>
      </div>
      <p className="desc">{w.description || <span className="muted">No description</span>}</p>
      <div className="meta">
        <span>
          {stepCount} step{stepCount === 1 ? '' : 's'}
        </span>
        {!valid && <StatusBadge status="draft" />}
        {w.lastRun ? (
          <a href={`#/runs/${w.lastRun.runId}`} className="row" style={{ gap: 6, textDecoration: 'none' }}>
            <StatusBadge status={w.lastRun.status} />
            <span>{relativeTime(w.lastRun.finishedAt)}</span>
          </a>
        ) : (
          <span>Never run</span>
        )}
      </div>
      {w.tags.length > 0 && (
        <div className="row" style={{ gap: 4 }}>
          {w.tags.map((t) => (
            <span key={t} className="badge">
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn btn-sm btn-primary" onClick={props.onRun} disabled={!valid} title={valid ? 'Run' : 'Fix the problems in the editor first'}>
          ▶ Run
        </button>
        <a className="btn btn-sm" href={`#/workflows/${w.id}`}>
          Edit
        </a>
        <span className="spacer" />
        <Menu
          label={`More actions for ${w.name}`}
          items={[
            { label: 'Duplicate', onSelect: props.onDuplicate },
            { label: 'Rename', onSelect: props.onRename },
            { label: 'Export as JSON', onSelect: props.onExport },
            { label: 'Delete', onSelect: props.onDelete, danger: true },
          ]}
        />
      </div>
    </article>
  );
}

function ImportSummary({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const drafts = result.imported.filter((i) => i.draftReasons.length > 0);
  return (
    <Modal title="Import complete" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <p>
        Imported {result.imported.length} workflow{result.imported.length === 1 ? '' : 's'}
        {result.rejected.length > 0 && `, rejected ${result.rejected.length}`}.
      </p>
      {drafts.length > 0 && (
        <div className="banner warning">
          <span aria-hidden>⚠</span>
          <div className="banner-body">
            Saved as drafts (fix in the editor before running):
            <ul>
              {drafts.map((d) => (
                <li key={d.workflow.id}>
                  {d.workflow.name}: {d.draftReasons[0]}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {result.rejected.length > 0 && (
        <div className="banner danger">
          <span aria-hidden>✕</span>
          <div className="banner-body">
            Not imported:
            <ul>
              {result.rejected.map((r, i) => (
                <li key={i}>
                  {r.name}: {r.reasons.join('; ')}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <p className="muted small">Imported workflows can only use FlowPilot's built-in actions; they cannot run their own scripts.</p>
    </Modal>
  );
}
