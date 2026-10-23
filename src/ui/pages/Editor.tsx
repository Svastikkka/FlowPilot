import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ActionType, RunRecord, Workflow } from '../../shared/schema/types';
import { TERMINAL_STATUSES } from '../../shared/schema/types';
import { scopeAt, validateWorkflow } from '../../shared/schema/validate';
import { findStep, stepNumbers } from '../../shared/schema/tree';
import type { Location } from '../../shared/schema/tree';
import { exportWorkflows } from '../../shared/schema/importExport';
import { deleteWorkflow, getWorkflow, saveWorkflow } from '../../storage/workflows';
import { getRun } from '../../storage/runs';
import { downloadFile, originPattern, requestAccess, sendCommand, slugify, subscribeToRuns } from '../api';
import { navigate, setNavigationGuard } from '../router';
import { ConfirmDialog, EmptyState, Loading, Menu, StatusBadge, useToast } from '../components/ui';
import { RunDialog } from '../components/RunDialog';
import { editorReducer, initEditor } from '../editor/state';
import { StepList } from '../editor/StepList';
import { StepConfig } from '../editor/StepConfig';
import { ActionPalette } from '../editor/ActionPalette';
import { VariablesPanel } from '../editor/VariablesPanel';
import { SettingsPanel } from '../editor/SettingsPanel';
import { DataPanel } from '../editor/DataPanel';

type Tab = 'step' | 'variables' | 'data' | 'settings';

const TAB_LABEL: Record<Tab, string> = { step: 'Step', variables: 'Variables', data: 'Data', settings: 'Settings' };

export function EditorPage({ id }: { id: string }) {
  const [loaded, setLoaded] = useState<Workflow | null | undefined>(undefined);
  useEffect(() => {
    void getWorkflow(id).then((w) => setLoaded(w ?? null));
  }, [id]);
  if (loaded === undefined) return <Loading />;
  if (loaded === null)
    return (
      <div className="page">
        <EmptyState icon="🔍" title="Workflow not found" actions={<a className="btn" href="#/">Back to workflows</a>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  return <Editor key={loaded.id} initial={loaded} />;
}

function Editor({ initial }: { initial: Workflow }) {
  const [state, dispatch] = useReducer(editorReducer, initial, initEditor);
  const { workflow, selectedId, dirty } = state;
  const [tab, setTab] = useState<Tab>('step');
  /** Palette open state; holds where the new step should go (undefined = after selection). */
  const [palette, setPalette] = useState<{ location?: Location } | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ stepId: string; runId?: string; status: string; message?: string } | null>(null);
  const toast = useToast();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const validation = useMemo(() => validateWorkflow(workflow), [workflow]);
  const errorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of validation.errors) if (e.stepId) m.set(e.stepId, (m.get(e.stepId) ?? 0) + 1);
    return m;
  }, [validation]);
  const warningIds = useMemo(() => new Set(validation.warnings.map((w) => w.stepId).filter(Boolean) as string[]), [validation]);
  const numbers = useMemo(() => stepNumbers(workflow.steps), [workflow.steps]);
  const selected = selectedId ? findStep(workflow.steps, selectedId) ?? null : null;
  const variableErrors = validation.errors.filter((e) => e.field?.startsWith('variables')).length;
  const settingsErrors = validation.errors.filter((e) => !e.stepId && !e.field?.startsWith('variables')).length;

  // Unsaved-change protection for in-app navigation and tab closing.
  useEffect(() => {
    setNavigationGuard(() => !dirtyRef.current || window.confirm('You have unsaved changes. Leave without saving?'));
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      setNavigationGuard(null);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const save = useCallback(async (): Promise<Workflow> => {
    setSaving(true);
    try {
      const saved = await saveWorkflow({ ...workflow, name: workflow.name.trim() || 'Untitled workflow' });
      dispatch({ type: 'saved', workflow: saved });
      return saved;
    } finally {
      setSaving(false);
    }
  }, [workflow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save().then(() => toast('Workflow saved'));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [save, toast]);

  // Live result for "Test step". Fast steps can finish before the port
  // connects, so also read the stored record once after subscribing.
  useEffect(() => {
    const runId = test?.runId;
    if (!runId) return;
    const apply = (run: RunRecord) => {
      const r = run.steps[0];
      const done = TERMINAL_STATUSES.includes(run.status);
      const status = done
        ? run.status === 'succeeded' ? 'Passed' : run.status === 'failed' ? 'Failed' : 'Stopped'
        : run.status === 'waiting_for_user' ? 'Waiting for you' : 'Running';
      setTest((t) => (t && t.runId === run.id ? { ...t, status, message: r?.message ?? run.error?.message } : t));
    };
    const unsubscribe = subscribeToRuns((e) => {
      if (e.type === 'run.update' && e.run.id === runId) apply(e.run);
    });
    void getRun(runId).then((run) => run && apply(run));
    return unsubscribe;
  }, [test?.runId]);

  const testStep = () => {
    if (!selected) return;
    const stepId = selected.id;
    // Request site access synchronously within the click for Open URL steps.
    const origin = selected.type === 'openUrl' && !selected.params.url.includes('{{') ? originPattern(selected.params.url) : null;
    const permission = origin ? requestAccess([origin]) : Promise.resolve(true);
    setTest({ stepId, status: 'Starting…' });
    permission
      .then(async (ok) => {
        if (!ok) throw new Error('Site access was not granted');
        if (dirtyRef.current) await save();
        return sendCommand({ type: 'run.testStep', workflowId: workflow.id, stepId });
      })
      .then(({ runId }) => setTest((t) => (t?.stepId === stepId ? { ...t, runId, status: 'Running' } : t)))
      .catch((e: Error) => setTest({ stepId, status: 'Could not test', message: e.message }));
  };

  const availableVariables = useMemo(() => (selectedId ? scopeAt(workflow, selectedId) : []), [workflow, selectedId]);

  const addStep = (type: ActionType) => {
    dispatch({ type: 'addStep', stepType: type, location: palette?.location });
    setPalette(null);
    setTab('step');
  };

  const openRun = async () => {
    if (dirty) await save();
    setRunning(true);
  };

  return (
    <div className="page">
      <div className="editor-header">
        <a href="#/" className="btn btn-ghost btn-sm" onClick={(e) => (e.preventDefault(), navigate('/'))} aria-label="Back to workflows">
          ←
        </a>
        <button
          className={`icon-btn${workflow.favorite ? ' on' : ''}`}
          aria-pressed={workflow.favorite}
          aria-label={workflow.favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => dispatch({ type: 'patch', patch: { favorite: !workflow.favorite } })}
        >
          {workflow.favorite ? '★' : '☆'}
        </button>
        <input
          className="title-input"
          aria-label="Workflow name"
          value={workflow.name}
          maxLength={200}
          onChange={(e) => dispatch({ type: 'patch', patch: { name: e.target.value } })}
        />
        {!validation.valid && <StatusBadge status="draft" />}
        <span className={`save-state${dirty ? ' dirty' : ''}`} role="status">
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => void save().then(() => toast(validation.valid ? 'Workflow saved' : 'Saved as draft'))} disabled={!dirty || saving}>
          Save
        </button>
        <button className="btn btn-primary" onClick={() => void openRun()} disabled={!validation.valid} title={validation.valid ? 'Run workflow' : 'Fix the problems first'}>
          ▶ Run
        </button>
        <Menu
          label="More workflow actions"
          items={[
            { label: 'Export as JSON', onSelect: () => downloadFile(`${slugify(workflow.name)}.flowpilot.json`, exportWorkflows([workflow])) },
            { label: 'Run history', onSelect: () => navigate('/history') },
            { label: 'Delete workflow', danger: true, onSelect: () => setConfirmDelete(true) },
          ]}
        />
      </div>

      {!validation.valid && (
        <div className="banner warning">
          <span aria-hidden>⚠</span>
          <div className="banner-body">
            {validation.errors.length} problem{validation.errors.length === 1 ? '' : 's'} to fix before this workflow can run. You can still save it as a draft.
            {validation.errors.some((e) => !e.stepId) && (
              <ul>
                {validation.errors
                  .filter((e) => !e.stepId)
                  .map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="editor">
        <section aria-label="Steps">
          {workflow.steps.length === 0 ? (
            <div className="card">
              <EmptyState icon="🧩" title="No steps yet" actions={<button className="btn btn-primary" onClick={() => setPalette({})}>＋ Add first step</button>}>
                Most workflows start with “Open URL”, then interact with the page.
              </EmptyState>
            </div>
          ) : (
            <StepList steps={workflow.steps} selectedId={selectedId} errorCounts={errorCounts} warningIds={warningIds} dispatch={dispatch} onAddStep={(location) => setPalette({ location })} />
          )}
        </section>

        <aside className="card panel" aria-label="Configuration">
          <div className="tabs" role="tablist">
            {(['step', 'variables', 'data', 'settings'] as Tab[]).map((t) => (
              <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}
                {t === 'variables' && variableErrors > 0 && <span className="count">●</span>}
                {t === 'settings' && settingsErrors > 0 && <span className="count">●</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'step' &&
              (selected ? (
                <StepConfig
                  key={selected.id}
                  step={selected}
                  label={numbers.get(selected.id) ?? ''}
                  workflow={workflow}
                  issues={[...validation.errors, ...validation.warnings].filter((i) => i.stepId === selected.id)}
                  availableVariables={availableVariables}
                  dispatch={dispatch}
                  onTest={testStep}
                  testing={test?.stepId === selected.id && (test.status === 'Starting…' || test.status === 'Running')}
                  testResult={test?.stepId === selected.id ? test : null}
                />
              ) : (
                <div className="card-pad muted">Select a step to configure it.</div>
              ))}
            {tab === 'variables' && <VariablesPanel workflow={workflow} issues={validation.errors} dispatch={dispatch} />}
            {tab === 'data' && <DataPanel workflow={workflow} dispatch={dispatch} />}
            {tab === 'settings' && <SettingsPanel workflow={workflow} dispatch={dispatch} />}
          </div>
        </aside>
      </div>

      {palette && <ActionPalette onPick={addStep} onClose={() => setPalette(null)} />}
      {running && (
        <RunDialog
          workflow={workflow}
          target={{ kind: 'newTab' }}
          context="dashboard"
          onClose={() => setRunning(false)}
          onStarted={(runId) => navigate(`/runs/${runId}`, { force: true })}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete workflow?"
          message={`“${workflow.name}” will be permanently deleted from this browser. Run history is kept until you clear it.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            void deleteWorkflow(workflow.id).then(() => {
              toast('Workflow deleted');
              navigate('/', { force: true });
            })
          }
        />
      )}
    </div>
  );
}
