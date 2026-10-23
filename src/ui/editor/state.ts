import type { ActionType, DataTable, Step, StepBase, VariableDef, Workflow, WorkflowSettings } from '../../shared/schema/types';
import { actionDef, createStep } from '../../shared/schema/actions';
import type { Location } from '../../shared/schema/tree';
import { cloneWithNewIds, findLocation, findStep, getList, insertStep, isBlock, mapList, moveStep, removeStep, updateStep } from '../../shared/schema/tree';

// Pure editor state. Every change marks the draft dirty until it is saved.

export interface EditorState {
  workflow: Workflow;
  selectedId: string | null;
  dirty: boolean;
}

export type EditorAction =
  | { type: 'load'; workflow: Workflow }
  | { type: 'saved'; workflow: Workflow }
  | { type: 'patch'; patch: Partial<Pick<Workflow, 'name' | 'description' | 'tags' | 'favorite'>> }
  | { type: 'settings'; patch: Partial<WorkflowSettings> }
  | { type: 'setData'; data: DataTable | undefined }
  | { type: 'select'; id: string | null }
  /** Without a location the step goes after the selected step (or at the end). */
  | { type: 'addStep'; stepType: ActionType; location?: Location }
  | { type: 'updateStep'; id: string; patch: Partial<StepBase> }
  | { type: 'updateParams'; id: string; patch: Record<string, unknown> }
  | { type: 'changeType'; id: string; stepType: ActionType }
  | { type: 'removeStep'; id: string }
  | { type: 'duplicateStep'; id: string }
  | { type: 'moveStep'; id: string; to: Location }
  /** Move up (-1) or down (+1) within the same list. */
  | { type: 'shiftStep'; id: string; delta: -1 | 1 }
  /** Move into the block directly above (as its last step). */
  | { type: 'indentStep'; id: string }
  /** Move out of the enclosing block (to just after it). */
  | { type: 'outdentStep'; id: string }
  | { type: 'toggleStep'; id: string }
  | { type: 'addVariable' }
  | { type: 'updateVariable'; index: number; patch: Partial<VariableDef> }
  | { type: 'removeVariable'; index: number };

export function initEditor(workflow: Workflow): EditorState {
  return { workflow, selectedId: workflow.steps[0]?.id ?? null, dirty: false };
}

function withSteps(state: EditorState, steps: Step[], selectedId = state.selectedId): EditorState {
  return { workflow: { ...state.workflow, steps }, selectedId, dirty: true };
}

function uniqueVariableName(existing: VariableDef[]): string {
  const names = new Set(existing.map((v) => v.name));
  let i = existing.length + 1;
  while (names.has(`var${i}`)) i++;
  return `var${i}`;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const steps = state.workflow.steps;

  switch (action.type) {
    case 'load':
      return initEditor(action.workflow);
    case 'saved':
      return { ...state, workflow: action.workflow, dirty: false };
    case 'patch':
      return { ...state, workflow: { ...state.workflow, ...action.patch }, dirty: true };
    case 'settings':
      return { ...state, workflow: { ...state.workflow, settings: { ...state.workflow.settings, ...action.patch } }, dirty: true };
    case 'setData':
      return { ...state, workflow: { ...state.workflow, data: action.data }, dirty: true };
    case 'select':
      return { ...state, selectedId: action.id };

    case 'addStep': {
      const step = createStep(action.stepType) as Step;
      let location = action.location;
      if (!location) {
        const selected = state.selectedId ? findLocation(steps, state.selectedId) : undefined;
        location = selected ? { ...selected, index: selected.index + 1 } : { parentId: null, branch: 'children', index: steps.length };
      }
      return withSteps(state, insertStep(steps, location, step), step.id);
    }

    case 'updateStep':
      return withSteps(state, updateStep(steps, action.id, (s) => ({ ...s, ...action.patch }) as Step));

    case 'updateParams':
      return withSteps(state, updateStep(steps, action.id, (s) => ({ ...s, params: { ...s.params, ...action.patch } }) as Step));

    case 'changeType': {
      const current = findStep(steps, action.id);
      const loc = findLocation(steps, action.id);
      if (!current || !loc || current.type === action.stepType) return state;
      const fresh = createStep(action.stepType) as Step;
      // Keep the target element when switching between element actions.
      const oldLocator = (current.params as { locator?: unknown }).locator;
      const params = { ...fresh.params } as Record<string, unknown>;
      if (oldLocator && 'locator' in params) params.locator = oldLocator;
      const { children, elseChildren, ...rest } = current;
      const def = actionDef(action.stepType);
      const next = {
        ...rest,
        type: action.stepType,
        params,
        ...(def.block ? { children: children ?? [] } : {}),
        ...(def.block === 'ifElse' ? { elseChildren: elseChildren ?? [] } : {}),
      } as unknown as Step;
      let tree = updateStep(steps, action.id, () => next);
      // Never drop nested steps: move the ones the new type can't hold out after it.
      const orphans = [...(def.block ? [] : children ?? []), ...(def.block === 'ifElse' ? [] : elseChildren ?? [])];
      if (orphans.length) tree = mapList(tree, loc, (list) => [...list.slice(0, loc.index + 1), ...orphans, ...list.slice(loc.index + 1)]);
      return withSteps(state, tree);
    }

    case 'removeStep': {
      const loc = findLocation(steps, action.id);
      if (!loc) return state;
      const siblings = getList(steps, loc) ?? [];
      const next = removeStep(steps, action.id);
      let selectedId = state.selectedId;
      if (selectedId && findStep(next, selectedId) === undefined) {
        selectedId = (siblings[loc.index + 1] ?? siblings[loc.index - 1])?.id ?? loc.parentId ?? next[0]?.id ?? null;
      }
      return withSteps(state, next, selectedId);
    }

    case 'duplicateStep': {
      const original = findStep(steps, action.id);
      const loc = findLocation(steps, action.id);
      if (!original || !loc) return state;
      const copy = cloneWithNewIds(original);
      if (copy.name) copy.name = `${copy.name} (copy)`;
      return withSteps(state, insertStep(steps, { ...loc, index: loc.index + 1 }, copy), copy.id);
    }

    case 'moveStep': {
      const next = moveStep(steps, action.id, action.to);
      return next === steps ? state : withSteps(state, next);
    }

    case 'shiftStep': {
      const loc = findLocation(steps, action.id);
      if (!loc) return state;
      const list = getList(steps, loc) ?? [];
      const target = loc.index + action.delta;
      if (target < 0 || target >= list.length) return state;
      return withSteps(state, moveStep(steps, action.id, { ...loc, index: action.delta > 0 ? target + 1 : target }));
    }

    case 'indentStep': {
      const loc = findLocation(steps, action.id);
      if (!loc || loc.index === 0) return state;
      const above = (getList(steps, loc) ?? [])[loc.index - 1];
      if (!above || !isBlock(above)) return state;
      const branch = above.type === 'if' && (above.elseChildren?.length ?? 0) > 0 ? 'elseChildren' : 'children';
      return withSteps(state, moveStep(steps, action.id, { parentId: above.id, branch, index: (above[branch] ?? []).length }));
    }

    case 'outdentStep': {
      const loc = findLocation(steps, action.id);
      if (!loc || loc.parentId === null) return state;
      const parentLoc = findLocation(steps, loc.parentId);
      if (!parentLoc) return state;
      return withSteps(state, moveStep(steps, action.id, { ...parentLoc, index: parentLoc.index + 1 }));
    }

    case 'toggleStep':
      return withSteps(state, updateStep(steps, action.id, (s) => ({ ...s, disabled: !s.disabled }) as Step));

    case 'addVariable': {
      const variables = [...state.workflow.variables, { name: uniqueVariableName(state.workflow.variables), defaultValue: '' }];
      return { ...state, workflow: { ...state.workflow, variables }, dirty: true };
    }
    case 'updateVariable': {
      const variables = state.workflow.variables.map((v, i) => (i === action.index ? { ...v, ...action.patch } : v));
      return { ...state, workflow: { ...state.workflow, variables }, dirty: true };
    }
    case 'removeVariable': {
      const variables = state.workflow.variables.filter((_, i) => i !== action.index);
      return { ...state, workflow: { ...state.workflow, variables }, dirty: true };
    }
  }
}
