import { useEffect, useMemo, useState } from 'react';
import type { DataTable, RunTarget, Workflow } from '../../shared/schema/types';
import { validateWorkflow } from '../../shared/schema/validate';
import { findSensitiveSteps } from '../../shared/safety';
import { stepTitle } from '../../shared/schema/actions';
import { findStep, flatten, stepNumbers } from '../../shared/schema/tree';
import { CsvError, parseCsv } from '../../shared/csv';
import { accessNeeds, ALL_SITES, hasAccess, hostOf, originPattern, requestAccess, sendCommand } from '../api';
import { Modal } from './ui';

interface Props {
  workflow: Workflow;
  target: RunTarget;
  /** Popup runs rely on activeTab for the current page and cannot show permission prompts reliably. */
  context: 'dashboard' | 'popup';
  /** URL of the target tab (popup mode), used to tell which sites activeTab already covers. */
  currentTabUrl?: string;
  onClose: () => void;
  onStarted: (runId: string) => void;
  onOpenDashboard?: () => void;
}

export function RunDialog({ workflow, target, context, currentTabUrl, onClose, onStarted, onOpenDashboard }: Props) {
  const validation = useMemo(() => validateWorkflow(workflow), [workflow]);
  const sensitive = useMemo(() => findSensitiveSteps(workflow), [workflow]);
  const needs = useMemo(() => accessNeeds(workflow), [workflow]);
  const askVars = workflow.variables.filter((v) => v.askAtRunStart);

  const [inputs, setInputs] = useState<Record<string, string>>(() => Object.fromEntries(askVars.map((v) => [v.name, v.defaultValue])));
  const [acknowledged, setAcknowledged] = useState(false);
  const [allowAllSites, setAllowAllSites] = useState(needs.allSitesReasons.length > 0);
  const [granted, setGranted] = useState<{ origins: boolean; all: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usesRows = useMemo(() => flatten(workflow.steps).some((s) => s.type === 'forEachRow' && !s.disabled), [workflow]);
  const [runData, setRunData] = useState<{ table: DataTable; name: string } | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const numbers = useMemo(() => stepNumbers(workflow.steps), [workflow]);

  const pickCsv = async (file: File) => {
    setDataError(null);
    try {
      const parsed = parseCsv(await file.text());
      const missing = (workflow.data?.columns ?? []).filter((c) => !parsed.columns.includes(c));
      if (missing.length) throw new CsvError(`This CSV is missing columns the workflow uses: ${missing.join(', ')}`);
      setRunData({ table: { columns: parsed.columns, rows: parsed.rows }, name: file.name });
    } catch (e) {
      setRunData(null);
      setDataError(e instanceof CsvError ? e.message : 'Could not read the file');
    }
  };

  const currentOrigin = currentTabUrl ? originPattern(currentTabUrl) : null;
  const neededOrigins = needs.origins.filter((o) => o !== currentOrigin);

  useEffect(() => {
    void Promise.all([hasAccess(neededOrigins), hasAccess([ALL_SITES])]).then(([origins, all]) => setGranted({ origins: origins || all, all }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow]);

  const popupMissingAccess = context === 'popup' && granted !== null && !granted.origins && neededOrigins.length > 0;
  const blocked = !validation.valid || (sensitive.length > 0 && !acknowledged) || starting || popupMissingAccess || granted === null;

  const start = () => {
    setError(null);
    setStarting(true);
    // The permission request must happen synchronously inside the click.
    let permission: Promise<boolean> = Promise.resolve(true);
    if (context === 'dashboard' && granted) {
      if (allowAllSites && !granted.all) permission = requestAccess([ALL_SITES]);
      else if (!allowAllSites && !granted.origins) permission = requestAccess(neededOrigins);
    }
    permission
      .then((ok) => {
        if (!ok) throw new Error('Site access was not granted. FlowPilot can only automate sites you allow.');
        return sendCommand({ type: 'run.start', workflowId: workflow.id, target, inputs, table: runData?.table });
      })
      .then(({ runId }) => onStarted(runId))
      .catch((e: Error) => {
        setError(e.message);
        setStarting(false);
      });
  };

  return (
    <Modal
      title={`Run “${workflow.name}”`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={start} disabled={blocked}>
            {starting ? <span className="spinner" aria-hidden /> : '▶'} Start run
          </button>
        </>
      }
    >
      {!validation.valid && (
        <div className="banner danger" role="alert">
          <span aria-hidden>⚠</span>
          <div className="banner-body">
            This workflow has {validation.errors.length} problem{validation.errors.length === 1 ? '' : 's'} to fix in the editor first:
            <ul>
              {validation.errors.slice(0, 4).map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <p className="muted small">
        {target.kind === 'newTab'
          ? 'The run opens in a new tab. Keep it open until the run finishes.'
          : 'The run uses the tab you are on. Keep it open until the run finishes.'}{' '}
        {flatten(workflow.steps).filter((s) => !s.disabled).length} steps.
      </p>

      {usesRows && (
        <div className="stack">
          <h3>Data</h3>
          <p className="small">
            {runData
              ? `Using ${runData.table.rows.length} rows from ${runData.name} for this run.`
              : `Using ${workflow.data?.rows.length ?? 0} rows from the workflow’s Data tab.`}
          </p>
          <label className="small">
            Use a different CSV for this run{' '}
            <input type="file" accept=".csv,text/csv,text/plain" aria-label="CSV for this run" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickCsv(f);
            }} />
          </label>
          {dataError && <span className="small" role="alert" style={{ color: 'var(--danger)' }}>{dataError}</span>}
        </div>
      )}

      {askVars.length > 0 && (
        <div className="stack">
          <h3>Inputs</h3>
          {askVars.map((v) => (
            <div className="field" key={v.name}>
              <label htmlFor={`in-${v.name}`}>
                {v.description || v.name} <span className="mono muted">{`{{${v.name}}}`}</span>
              </label>
              <input
                id={`in-${v.name}`}
                type={v.secret ? 'password' : 'text'}
                autoComplete="off"
                value={inputs[v.name] ?? ''}
                onChange={(e) => setInputs({ ...inputs, [v.name]: e.target.value })}
              />
              {v.secret && <span className="help">Used for this run only. Never saved or logged.</span>}
            </div>
          ))}
        </div>
      )}

      {context === 'dashboard' && (needs.origins.length > 0 || needs.allSitesReasons.length > 0) && (
        <div className="stack">
          <h3>Site access</h3>
          {needs.origins.length > 0 && (
            <p className="small">
              This workflow visits: {needs.origins.map(hostOf).join(', ')}.{' '}
              {granted?.origins ? <span className="badge succeeded">Access granted</span> : 'Chrome will ask you to allow access.'}
            </p>
          )}
          {needs.allSitesReasons.length > 0 && (
            <>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {needs.allSitesReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <label className="check">
                <input type="checkbox" checked={allowAllSites} onChange={(e) => setAllowAllSites(e.target.checked)} disabled={granted?.all} />
                Allow FlowPilot to access all sites {granted?.all && <span className="badge succeeded">Granted</span>}
              </label>
              <span className="help small muted">You can revoke site access at any time under Settings → Site access.</span>
            </>
          )}
        </div>
      )}

      {popupMissingAccess && (
        <div className="banner warning">
          <span aria-hidden>⚠</span>
          <div className="banner-body">
            This workflow opens other sites ({neededOrigins.map(hostOf).join(', ')}) that FlowPilot cannot access yet. Start it from the dashboard
            to grant access.
          </div>
          {onOpenDashboard && (
            <button className="btn btn-sm" onClick={onOpenDashboard}>
              Open dashboard
            </button>
          )}
        </div>
      )}

      {sensitive.length > 0 && (
        <div className="banner warning">
          <span aria-hidden>⚠</span>
          <div className="banner-body">
            <strong>This workflow may submit, buy, delete or send something.</strong>
            <ul>
              {sensitive.map((f) => {
                const s = findStep(workflow.steps, f.stepId)!;
                return (
                  <li key={f.stepId}>
                    Step {numbers.get(s.id)} “{stepTitle(s)}”{s.confirmBefore ? ' — FlowPilot will ask before running it' : ''}
                  </li>
                );
              })}
            </ul>
            <p className="small" style={{ marginTop: 6 }}>
              Websites receive the data entered into their forms. FlowPilot cannot undo actions a website performs.
            </p>
            <label className="check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I understand and want to run it
            </label>
          </div>
        </div>
      )}

      {error && (
        <div className="banner danger" role="alert">
          <span aria-hidden>⚠</span>
          <div className="banner-body">{error}</div>
        </div>
      )}
    </Modal>
  );
}
