import { useState } from 'react';
import type { Dispatch } from 'react';
import type { ErrorPolicy, Workflow } from '../../shared/schema/types';
import type { EditorAction } from './state';

export function SettingsPanel({ workflow, dispatch }: { workflow: Workflow; dispatch: Dispatch<EditorAction> }) {
  const s = workflow.settings;
  const [tagDraft, setTagDraft] = useState('');
  const num = (v: string, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (tag && !workflow.tags.includes(tag) && workflow.tags.length < 20) dispatch({ type: 'patch', patch: { tags: [...workflow.tags, tag] } });
    setTagDraft('');
  };
  return (
    <div className="stack card-pad">
      <h2>Workflow settings</h2>
      <div className="field">
        <label htmlFor="wf-desc">Description</label>
        <textarea id="wf-desc" value={workflow.description} onChange={(e) => dispatch({ type: 'patch', patch: { description: e.target.value } })} />
      </div>
      <div className="field">
        <label htmlFor="wf-tag">Tags</label>
        <div className="row">
          {workflow.tags.map((t) => (
            <button key={t} className="tag-chip" onClick={() => dispatch({ type: 'patch', patch: { tags: workflow.tags.filter((x) => x !== t) } })} aria-label={`Remove tag ${t}`}>
              {t} ✕
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            addTag();
          }}
        >
          <input id="wf-tag" value={tagDraft} maxLength={40} placeholder="Add a tag and press Enter" onChange={(e) => setTagDraft(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-sm" type="submit" disabled={!tagDraft.trim()}>
            Add
          </button>
        </form>
      </div>
      <h3>Defaults for every step</h3>
      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-timeout">Step timeout (ms)</label>
          <input id="wf-timeout" type="number" min={100} max={600000} value={s.defaultTimeoutMs} onChange={(e) => dispatch({ type: 'settings', patch: { defaultTimeoutMs: num(e.target.value, 100, 600000) } })} />
        </div>
        <div className="field">
          <label htmlFor="wf-retries">Retries</label>
          <input id="wf-retries" type="number" min={0} max={10} value={s.defaultRetries} onChange={(e) => dispatch({ type: 'settings', patch: { defaultRetries: num(e.target.value, 0, 10) } })} />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="wf-onerror">If a step fails</label>
          <select id="wf-onerror" value={s.defaultOnError} onChange={(e) => dispatch({ type: 'settings', patch: { defaultOnError: e.target.value as ErrorPolicy } })}>
            <option value="stop">Stop the run</option>
            <option value="skip">Skip and continue</option>
            <option value="ask">Ask me</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="wf-delay">Delay between steps (ms)</label>
          <input id="wf-delay" type="number" min={0} max={60000} value={s.stepDelayMs} onChange={(e) => dispatch({ type: 'settings', patch: { stepDelayMs: num(e.target.value, 0, 60000) } })} />
        </div>
      </div>
      <p className="muted small">
        Steps that interact with elements wait automatically until the element is ready, up to the timeout. Retries apply before the failure rule.
      </p>
    </div>
  );
}
