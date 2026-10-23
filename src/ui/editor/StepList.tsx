import { useMemo, useState } from 'react';
import type { Dispatch, DragEvent, KeyboardEvent } from 'react';
import type { Step } from '../../shared/schema/types';
import { actionDef, stepSummary, stepTitle } from '../../shared/schema/actions';
import type { Branch, ListRef, Location } from '../../shared/schema/tree';
import { branchesOf, flatten, isBlock, stepNumbers } from '../../shared/schema/tree';
import type { EditorAction } from './state';

interface Props {
  steps: Step[];
  selectedId: string | null;
  errorCounts: Map<string, number>;
  warningIds: Set<string>;
  dispatch: Dispatch<EditorAction>;
  /** Opens the action palette; the new step goes to `location` (or after the selection). */
  onAddStep: (location?: Location) => void;
}

type DropTarget = { kind: 'card'; id: string; after: boolean; location: Location } | { kind: 'empty'; ref: ListRef };

const BRANCH_LABEL: Record<string, string> = { 'if:children': 'Then', 'if:elseChildren': 'Else' };

export function StepList({ steps, selectedId, errorCounts, warningIds, dispatch, onAddStep }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  const numbers = useMemo(() => stepNumbers(steps), [steps]);
  // Visible order for arrow-key navigation (collapsed blocks hide their children).
  const visibleOrder = useMemo(() => {
    const out: Step[] = [];
    const visit = (list: Step[]) =>
      list.forEach((s) => {
        out.push(s);
        if (!collapsed.has(s.id)) for (const b of branchesOf(s)) visit(s[b] ?? []);
      });
    visit(steps);
    return out;
  }, [steps, collapsed]);

  const announce = (text: string) => setAnnouncement(text);
  const focusStep = (id: string) => requestAnimationFrame(() => document.getElementById(`step-${id}`)?.focus());

  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragId && drop) {
      const to: Location = drop.kind === 'card' ? { ...drop.location, index: drop.location.index + (drop.after ? 1 : 0) } : { ...drop.ref, index: 0 };
      dispatch({ type: 'moveStep', id: dragId, to });
      announce(`Moved step to ${drop.kind === 'card' ? `${drop.after ? 'after' : 'before'} step ${numbers.get(drop.id)}` : 'an empty block'}`);
    }
    endDrag();
  };

  const onKeyDown = (e: KeyboardEvent, step: Step) => {
    if (e.target !== e.currentTarget) return;
    const act = (action: EditorAction, message: string) => {
      e.preventDefault();
      dispatch(action);
      announce(message);
      focusStep(step.id);
    };
    if (e.altKey && e.key === 'ArrowUp') act({ type: 'shiftStep', id: step.id, delta: -1 }, 'Moved up');
    else if (e.altKey && e.key === 'ArrowDown') act({ type: 'shiftStep', id: step.id, delta: 1 }, 'Moved down');
    else if (e.altKey && e.key === 'ArrowRight') act({ type: 'indentStep', id: step.id }, 'Moved into the block above');
    else if (e.altKey && e.key === 'ArrowLeft') act({ type: 'outdentStep', id: step.id }, 'Moved out of the block');
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const i = visibleOrder.findIndex((s) => s.id === step.id);
      const next = visibleOrder[i + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) {
        dispatch({ type: 'select', id: next.id });
        focusStep(next.id);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dispatch({ type: 'select', id: step.id });
    } else if (e.key === 'Delete') {
      e.preventDefault();
      dispatch({ type: 'removeStep', id: step.id });
    }
  };

  const renderList = (list: Step[], ref: ListRef, depth: number) => (
    <ol className="steps" role={ref.parentId ? 'none' : 'tree'} aria-label={ref.parentId ? undefined : 'Workflow steps'}>
      {list.map((step, index) => renderStep(step, { ...ref, index }, list, depth))}
    </ol>
  );

  const renderStep = (step: Step, location: Location, siblings: Step[], depth: number) => {
    const def = actionDef(step.type);
    const errors = errorCounts.get(step.id) ?? 0;
    const block = isBlock(step);
    const childCount = block ? flatten(branchesOf(step).flatMap((b) => step[b] ?? [])).length : 0;
    const isCollapsed = collapsed.has(step.id);
    const canIndent = location.index > 0 && isBlock(siblings[location.index - 1]);
    const label = numbers.get(step.id);
    const classes = [
      'step-card',
      block && 'block-card',
      step.id === selectedId && 'selected',
      step.disabled && 'disabled',
      errors > 0 && 'has-error',
      dragId === step.id && 'dragging',
      drop?.kind === 'card' && drop.id === step.id && (drop.after ? 'drop-after' : 'drop-before'),
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <li
        key={step.id}
        id={`step-${step.id}`}
        className="step-item"
        role="treeitem"
        tabIndex={step.id === selectedId || (!selectedId && depth === 0 && location.index === 0) ? 0 : -1}
        aria-selected={step.id === selectedId}
        aria-expanded={block ? !isCollapsed : undefined}
        aria-label={`Step ${label}: ${stepTitle(step)}${step.disabled ? ' (disabled)' : ''}${errors ? `, ${errors} problem${errors > 1 ? 's' : ''}` : ''}`}
        onKeyDown={(e) => onKeyDown(e, step)}
        onClick={(e) => {
          // Ignore clicks bubbling up from nested steps.
          if ((e.target as Element).closest('.step-item') === e.currentTarget) dispatch({ type: 'select', id: step.id });
        }}
      >
        <div
          className={classes}
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            setDragId(step.id);
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', step.id);
          }}
          onDragEnd={endDrag}
          onDragOver={(e) => {
            if (!dragId || dragId === step.id) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setDrop({ kind: 'card', id: step.id, after: e.clientY > rect.top + rect.height / 2, location });
          }}
          onDrop={onDrop}
        >
          <span className="drag-handle" aria-hidden title="Drag to reorder">
            ⠿
          </span>
          <span className="step-num">{label}</span>
          <div className="step-body">
            <div className="step-title">
              {block && (
                <button
                  className="icon-btn collapse-btn"
                  aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} step ${label}`}
                  aria-expanded={!isCollapsed}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(step.id)) next.delete(step.id);
                      else next.add(step.id);
                      return next;
                    });
                  }}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              )}
              <span className="icon" aria-hidden>
                {def.icon}
              </span>
              <span>{stepTitle(step)}</span>
              {step.name && <span className="badge">{def.label}</span>}
              {block && isCollapsed && <span className="badge">{childCount} inside</span>}
              {step.disabled && <span className="badge">Disabled</span>}
              {step.confirmBefore && <span className="badge waiting_for_user">Asks first</span>}
              {errors > 0 && <span className="badge failed">{errors} problem{errors > 1 ? 's' : ''}</span>}
              {errors === 0 && warningIds.has(step.id) && <span className="badge paused">Check</span>}
            </div>
            <div className="step-summary">{stepSummary(step)}</div>
          </div>
          <div className="step-actions" onClick={(e) => e.stopPropagation()}>
            {location.parentId !== null && (
              <button className="icon-btn" aria-label={`Move step ${label} out of its block`} title="Move out of block (Alt+←)" onClick={() => dispatch({ type: 'outdentStep', id: step.id })}>
                ⇤
              </button>
            )}
            {canIndent && (
              <button className="icon-btn" aria-label={`Move step ${label} into the block above`} title="Move into block above (Alt+→)" onClick={() => dispatch({ type: 'indentStep', id: step.id })}>
                ⇥
              </button>
            )}
            <button className="icon-btn" aria-label={`Move step ${label} up`} disabled={location.index === 0} onClick={() => dispatch({ type: 'shiftStep', id: step.id, delta: -1 })}>
              ↑
            </button>
            <button
              className="icon-btn"
              aria-label={`Move step ${label} down`}
              disabled={location.index === siblings.length - 1}
              onClick={() => dispatch({ type: 'shiftStep', id: step.id, delta: 1 })}
            >
              ↓
            </button>
            <button className="icon-btn" aria-label={`Duplicate step ${label}`} title="Duplicate" onClick={() => dispatch({ type: 'duplicateStep', id: step.id })}>
              ⧉
            </button>
            <button
              className="icon-btn"
              aria-label={`${step.disabled ? 'Enable' : 'Disable'} step ${label}`}
              title={step.disabled ? 'Enable' : 'Disable'}
              onClick={() => dispatch({ type: 'toggleStep', id: step.id })}
            >
              {step.disabled ? '◯' : '◉'}
            </button>
            <button className="icon-btn" aria-label={`Delete step ${label}`} title="Delete" onClick={() => dispatch({ type: 'removeStep', id: step.id })}>
              🗑
            </button>
          </div>
        </div>
        {block && !isCollapsed && branchesOf(step).map((branch) => renderBranch(step, branch, depth))}
      </li>
    );
  };

  const renderBranch = (step: Step, branch: Branch, depth: number) => {
    const list = step[branch] ?? [];
    const ref: ListRef = { parentId: step.id, branch };
    const label = BRANCH_LABEL[`${step.type}:${branch}`];
    const isDropTarget = drop?.kind === 'empty' && drop.ref.parentId === step.id && drop.ref.branch === branch;
    return (
      <div key={branch} className={`block-body${step.disabled ? ' disabled' : ''}`} aria-label={`${label ?? 'Inside'} step ${numbers.get(step.id)}`} role="group">
        {label && <div className="branch-label">{label}</div>}
        {list.length > 0 ? (
          renderList(list, ref, depth + 1)
        ) : (
          <div
            className={`drop-zone${isDropTarget ? ' active' : ''}`}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.stopPropagation();
              setDrop({ kind: 'empty', ref });
            }}
            onDrop={onDrop}
          >
            {label === 'Else' ? 'Optional: steps to run when the condition is false' : 'Drop steps here or add one'}
          </div>
        )}
        <button className="btn btn-ghost btn-sm add-inside" onClick={() => onAddStep({ ...ref, index: list.length })}>
          ＋ Add step {label ? `to ${label}` : 'inside'}
        </button>
      </div>
    );
  };

  return (
    <div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <p className="muted small" style={{ marginBottom: 8 }}>
        Drag to reorder or nest. Keyboard: Alt+↑/↓ move, Alt+→ into the block above, Alt+← out of a block.
      </p>
      {renderList(steps, { parentId: null, branch: 'children' }, 0)}
      <div className="add-step">
        <button className="btn" onClick={() => onAddStep()}>
          ＋ Add step
        </button>
      </div>
    </div>
  );
}
