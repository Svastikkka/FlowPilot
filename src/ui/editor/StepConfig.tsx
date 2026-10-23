import { useRef } from 'react';
import type { Dispatch } from 'react';
import type { ErrorPolicy, Locator, LocatorStrategy, Step, TableColumn, Workflow } from '../../shared/schema/types';
import type { FieldDef } from '../../shared/schema/actions';
import { ACTIONS, ACTION_TYPES, actionDef } from '../../shared/schema/actions';
import type { ValidationIssue } from '../../shared/schema/validate';
import type { EditorAction } from './state';

const LOCATOR_HELP: Record<LocatorStrategy, string> = {
  css: 'CSS selector, e.g. #email or button.primary. Tip: right-click the element → Inspect → Copy → Copy selector.',
  text: 'Visible text of the element, e.g. “Sign in”. Buttons and links are matched first.',
  label: 'Field label, aria-label or placeholder, e.g. “Email address”.',
  xpath: 'XPath expression, e.g. //table//tr[2]/td[1].',
};

interface Props {
  step: Step;
  /** Display number, e.g. "3" or "2.1". */
  label: string;
  workflow: Workflow;
  issues: ValidationIssue[];
  availableVariables: string[];
  dispatch: Dispatch<EditorAction>;
  onTest: () => void;
  testing: boolean;
  testResult: { status: string; message?: string; runId?: string } | null;
}

function VariableChips({ names, onInsert }: { names: string[]; onInsert: (name: string) => void }) {
  if (!names.length) return null;
  return (
    <div className="var-chips" aria-label="Insert variable">
      {names.map((n) => (
        <button type="button" key={n} className="var-chip" onClick={() => onInsert(n)} title={`Insert {{${n}}}`}>
          {`{{${n}}}`}
        </button>
      ))}
    </div>
  );
}

export function StepConfig({ step, label, workflow, issues, availableVariables, dispatch, onTest, testing, testResult }: Props) {
  const def = actionDef(step.type);
  const params = step.params as unknown as Record<string, unknown>;
  const fieldError = (key?: string) => issues.filter((i) => i.field === key).map((i) => i.message);
  const generalIssues = issues.filter((i) => !i.field || !def.fields.some((f) => f.key === i.field));
  const inputRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const setParam = (key: string, value: unknown) => dispatch({ type: 'updateParams', id: step.id, patch: { [key]: value } });
  const loopName = typeof params.loopVariable === 'string' && params.loopVariable ? params.loopVariable : 'NAME';
  const helpText = (help: string) => help.replace(/NAME/g, loopName);
  const settings = workflow.settings;

  const renderField = (field: FieldDef<Record<string, unknown>>) => {
    if (field.showIf && !field.showIf(params)) return null;
    const id = `f-${step.id}-${field.key}`;
    const errors = fieldError(field.key);
    const value = params[field.key];
    const invalid = errors.length > 0 || undefined;
    const insert = (name: string) => {
      const el = inputRefs.current[field.key];
      const current = String(value ?? '');
      const token = `{{${name}}}`;
      if (el && typeof el.selectionStart === 'number') {
        const start = el.selectionStart;
        const end = el.selectionEnd ?? start;
        setParam(field.key, current.slice(0, start) + token + current.slice(end));
      } else setParam(field.key, current + token);
    };

    let control;
    switch (field.kind) {
      case 'text':
      case 'variable':
        control = (
          <input
            id={id}
            ref={(el) => (inputRefs.current[field.key] = el)}
            value={String(value ?? '')}
            placeholder={field.placeholder}
            aria-invalid={invalid}
            list={field.kind === 'variable' ? `vars-${step.id}` : undefined}
            onChange={(e) => setParam(field.key, e.target.value)}
            spellCheck={false}
          />
        );
        break;
      case 'textarea':
        control = (
          <textarea
            id={id}
            ref={(el) => (inputRefs.current[field.key] = el)}
            value={String(value ?? '')}
            aria-invalid={invalid}
            onChange={(e) => setParam(field.key, e.target.value)}
          />
        );
        break;
      case 'number':
        control = (
          <input
            id={id}
            type="number"
            min={field.key === 'start' || field.key === 'end' ? undefined : 0}
            value={value === undefined ? '' : String(value)}
            aria-invalid={invalid}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              const allowNegative = field.key === 'start' || field.key === 'end';
              setParam(field.key, e.target.value === '' || !Number.isFinite(n) ? undefined : allowNegative ? n : Math.max(0, n));
            }}
          />
        );
        break;
      case 'select':
        control = (
          <select id={id} value={String(value)} onChange={(e) => setParam(field.key, e.target.value)}>
            {field.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
        break;
      case 'checkbox':
        return (
          <div className="field" key={field.key}>
            <label className="check">
              <input type="checkbox" checked={!!value} onChange={(e) => setParam(field.key, e.target.checked)} />
              {field.label}
            </label>
            {field.help && <span className="help">{field.help}</span>}
          </div>
        );
      case 'columns': {
        const columns = (value as TableColumn[] | undefined) ?? [];
        const setColumns = (next: TableColumn[]) => setParam(field.key, next);
        control = (
          <div className="stack" style={{ gap: 6 }} id={id}>
            {columns.map((c, i) => (
              <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
                <input
                  aria-label={`Column ${i + 1} name`}
                  className="mono"
                  style={{ width: 130, flex: 'none' }}
                  value={c.name}
                  placeholder="name"
                  onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <input
                  aria-label={`Column ${i + 1} value`}
                  value={c.value}
                  placeholder="{{variable}}"
                  onChange={(e) => setColumns(columns.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                />
                <button type="button" className="icon-btn" aria-label={`Remove column ${i + 1}`} onClick={() => setColumns(columns.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setColumns([...columns, { name: '', value: '' }])} disabled={columns.length >= 50}>
              ＋ Add column
            </button>
            <VariableChips names={availableVariables} onInsert={(n) => columns.length && setColumns(columns.map((x, j) => (j === columns.length - 1 ? { ...x, value: x.value + `{{${n}}}` } : x)))} />
          </div>
        );
        break;
      }
      case 'locator': {
        const loc = (value as Locator | undefined) ?? { strategy: 'css', value: '' };
        control = (
          <>
            <div className="locator">
              <select aria-label={`${field.label} locator type`} value={loc.strategy} onChange={(e) => setParam(field.key, { ...loc, strategy: e.target.value })}>
                <option value="css">CSS</option>
                <option value="text">Text</option>
                <option value="label">Label</option>
                <option value="xpath">XPath</option>
              </select>
              <input
                id={id}
                className="mono"
                value={loc.value}
                aria-invalid={invalid}
                spellCheck={false}
                placeholder={loc.strategy === 'css' ? '#submit' : loc.strategy === 'xpath' ? '//button' : 'Sign in'}
                onChange={(e) => setParam(field.key, { ...loc, value: e.target.value })}
              />
            </div>
            <span className="help">{LOCATOR_HELP[loc.strategy]}</span>
          </>
        );
        break;
      }
    }
    return (
      <div className="field" key={field.key}>
        <label htmlFor={id}>
          {field.label}
          {field.required && <span aria-hidden> *</span>}
        </label>
        {control}
        {field.templated && <VariableChips names={availableVariables} onInsert={insert} />}
        {field.help && field.kind !== 'locator' && <span className="help">{helpText(field.help)}</span>}
        {errors.map((e) => (
          <span className="error" key={e} role="alert">
            {e}
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="stack card-pad">
      <div className="row">
        <h2 style={{ flex: 1 }}>
          Step {label} <span className="muted">· {def.label}</span>
        </h2>
        <button className="btn btn-sm" onClick={onTest} disabled={testing} title="Run only this step in this workflow's test tab">
          {testing ? <span className="spinner" aria-hidden /> : '▷'} Test step
        </button>
      </div>
      {testResult && (
        <div className="test-result" role="status">
          <strong>{testResult.status}</strong>
          {testResult.message && <> — {testResult.message}</>}
          {testResult.runId && (
            <>
              {' '}
              <a href={`#/runs/${testResult.runId}`}>Details</a>
            </>
          )}
        </div>
      )}
      <p className="muted small">{def.description}</p>

      {generalIssues.map((i, n) => (
        <div key={n} className="banner warning small">
          <span aria-hidden>⚠</span>
          <div className="banner-body">{i.message}</div>
        </div>
      ))}

      <div className="field-row">
        <div className="field">
          <label htmlFor={`type-${step.id}`}>Action</label>
          <select id={`type-${step.id}`} value={step.type} onChange={(e) => dispatch({ type: 'changeType', id: step.id, stepType: e.target.value as Step['type'] })}>
            {ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTIONS[t].label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`name-${step.id}`}>Step name</label>
          <input
            id={`name-${step.id}`}
            value={step.name ?? ''}
            placeholder={def.label}
            maxLength={200}
            onChange={(e) => dispatch({ type: 'updateStep', id: step.id, patch: { name: e.target.value || undefined } })}
          />
        </div>
      </div>

      {(def.fields as unknown as FieldDef<Record<string, unknown>>[]).map(renderField)}
      <datalist id={`vars-${step.id}`}>
        {workflow.variables.map((v) => (
          <option key={v.name} value={v.name} />
        ))}
      </datalist>

      <div className="field">
        <label htmlFor={`notes-${step.id}`}>Notes</label>
        <textarea
          id={`notes-${step.id}`}
          value={step.notes ?? ''}
          placeholder="Why this step exists, what to check…"
          style={{ minHeight: 56 }}
          onChange={(e) => dispatch({ type: 'updateStep', id: step.id, patch: { notes: e.target.value || undefined } })}
        />
      </div>

      <details className="advanced">
        <summary>Error handling &amp; timing</summary>
        <div className="stack" style={{ marginTop: 10 }}>
          <div className="field-row">
            <div className="field">
              <label htmlFor={`timeout-${step.id}`}>Timeout (ms)</label>
              <input
                id={`timeout-${step.id}`}
                type="number"
                min={100}
                placeholder={`${settings.defaultTimeoutMs} (workflow default)`}
                value={step.timeoutMs ?? ''}
                onChange={(e) =>
                  dispatch({ type: 'updateStep', id: step.id, patch: { timeoutMs: e.target.value === '' ? undefined : Math.max(100, Number(e.target.value)) } })
                }
              />
            </div>
            <div className="field">
              <label htmlFor={`retries-${step.id}`}>Retries</label>
              <input
                id={`retries-${step.id}`}
                type="number"
                min={0}
                max={10}
                placeholder={`${settings.defaultRetries} (workflow default)`}
                value={step.retries ?? ''}
                onChange={(e) =>
                  dispatch({
                    type: 'updateStep',
                    id: step.id,
                    patch: { retries: e.target.value === '' ? undefined : Math.min(10, Math.max(0, Math.round(Number(e.target.value)))) },
                  })
                }
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor={`onerror-${step.id}`}>If it still fails</label>
            <select
              id={`onerror-${step.id}`}
              value={step.onError ?? ''}
              onChange={(e) => dispatch({ type: 'updateStep', id: step.id, patch: { onError: (e.target.value || undefined) as ErrorPolicy | undefined } })}
            >
              <option value="">Workflow default ({settings.defaultOnError})</option>
              <option value="stop">Stop the run</option>
              <option value="skip">Skip this step and continue</option>
              <option value="ask">Ask me (retry / skip / stop)</option>
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={!!step.confirmBefore} onChange={(e) => dispatch({ type: 'updateStep', id: step.id, patch: { confirmBefore: e.target.checked || undefined } })} />
            Ask before this step runs
          </label>
          <label className="check">
            <input type="checkbox" checked={!!step.disabled} onChange={() => dispatch({ type: 'toggleStep', id: step.id })} />
            Disable this step
          </label>
        </div>
      </details>
    </div>
  );
}
