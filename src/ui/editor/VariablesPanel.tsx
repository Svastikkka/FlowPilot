import type { Dispatch } from 'react';
import type { Workflow } from '../../shared/schema/types';
import { BUILTIN_VARIABLES } from '../../shared/interpolate';
import { loopBindings, producedVariables } from '../../shared/schema/validate';
import { flatten } from '../../shared/schema/tree';
import type { ValidationIssue } from '../../shared/schema/validate';
import type { EditorAction } from './state';

export function VariablesPanel({ workflow, issues, dispatch }: { workflow: Workflow; issues: ValidationIssue[]; dispatch: Dispatch<EditorAction> }) {
  const all = flatten(workflow.steps);
  const extracted = [...new Set(all.flatMap(producedVariables))];
  const loopVars = [...new Set(all.flatMap((s) => loopBindings(s, workflow.data)))];
  const varIssues = issues.filter((i) => !i.stepId && i.field?.startsWith('variables'));
  return (
    <div className="stack card-pad">
      <div className="row">
        <h2 style={{ flex: 1 }}>Variables</h2>
        <button className="btn btn-sm" onClick={() => dispatch({ type: 'addVariable' })}>
          ＋ Add variable
        </button>
      </div>
      <p className="muted small">
        Use <code>{'{{name}}'}</code> in any text field. Variables asked at run start let you enter values each time. Secret values are never
        saved in run history.
      </p>
      {varIssues.map((i, n) => (
        <span key={n} className="error small" role="alert" style={{ color: 'var(--danger)' }}>
          {i.message}
        </span>
      ))}
      {workflow.variables.length === 0 ? (
        <p className="muted small">No variables yet.</p>
      ) : (
        <div className="stack">
          {workflow.variables.map((v, index) => (
            <div key={index} className="card card-pad stack" style={{ gap: 8, boxShadow: 'none' }}>
              <div className="field-row">
                <div className="field">
                  <label htmlFor={`vname-${index}`}>Name</label>
                  <input
                    id={`vname-${index}`}
                    className="mono"
                    value={v.name}
                    spellCheck={false}
                    onChange={(e) => dispatch({ type: 'updateVariable', index, patch: { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '') } })}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`vdef-${index}`}>Default value</label>
                  <input
                    id={`vdef-${index}`}
                    type={v.secret ? 'password' : 'text'}
                    autoComplete="off"
                    value={v.defaultValue}
                    onChange={(e) => dispatch({ type: 'updateVariable', index, patch: { defaultValue: e.target.value } })}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor={`vdesc-${index}`}>Description</label>
                <input
                  id={`vdesc-${index}`}
                  value={v.description ?? ''}
                  onChange={(e) => dispatch({ type: 'updateVariable', index, patch: { description: e.target.value || undefined } })}
                />
              </div>
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={!!v.askAtRunStart} onChange={(e) => dispatch({ type: 'updateVariable', index, patch: { askAtRunStart: e.target.checked || undefined } })} />
                  Ask at run start
                </label>
                <label className="check">
                  <input type="checkbox" checked={!!v.secret} onChange={(e) => dispatch({ type: 'updateVariable', index, patch: { secret: e.target.checked || undefined } })} />
                  Secret
                </label>
                <span className="spacer" />
                <button className="btn btn-sm btn-danger" onClick={() => dispatch({ type: 'removeVariable', index })} aria-label={`Remove variable ${v.name}`}>
                  Remove
                </button>
              </div>
              {v.secret && v.defaultValue && !v.askAtRunStart && (
                <span className="help small" style={{ color: 'var(--warning)' }}>
                  Default values are stored unencrypted with the workflow. For real secrets, leave this empty and enable “Ask at run start”.
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="stack" style={{ gap: 6 }}>
        <h3>Built-in values</h3>
        <div className="var-chips">
          {BUILTIN_VARIABLES.map((n) => (
            <code key={n} className="var-chip">{`{{${n}}}`}</code>
          ))}
        </div>
        {loopVars.length > 0 && (
          <>
            <h3 style={{ marginTop: 8 }}>Inside loops</h3>
            <div className="var-chips">
              {loopVars.map((n) => (
                <code key={n} className="var-chip">{`{{${n}}}`}</code>
              ))}
            </div>
          </>
        )}
        {extracted.length > 0 && (
          <>
            <h3 style={{ marginTop: 8 }}>Set by steps</h3>
            <div className="var-chips">
              {extracted.map((n) => (
                <code key={n} className="var-chip">{`{{${n}}}`}</code>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
