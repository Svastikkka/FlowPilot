import type { Step } from './types';
import { newId } from '../ids';

// Helpers for the nested step tree. Block steps (If, loops) hold child steps
// in `children`; If also has `elseChildren`. All helpers are immutable.

export type Branch = 'children' | 'elseChildren';

export interface ListRef {
  /** Containing block step, or null for the workflow's top level. */
  parentId: string | null;
  branch: Branch;
}

export interface Location extends ListRef {
  index: number;
}

export const LOOP_TYPES = new Set<Step['type']>(['repeat', 'while', 'forEachElement', 'forEachRow']);

export function branchesOf(step: Step): Branch[] {
  if (step.type === 'if') return ['children', 'elseChildren'];
  if (LOOP_TYPES.has(step.type)) return ['children'];
  return [];
}

export const isBlock = (step: Step) => branchesOf(step).length > 0;
export const isLoop = (step: Step) => LOOP_TYPES.has(step.type);

export interface WalkInfo {
  depth: number;
  parent: Step | null;
  branch: Branch;
  index: number;
  /** Enclosing loop steps, outermost first. */
  loops: Step[];
}

/** Depth-first, document order. Return false from `visit` to skip a step's children. */
export function walk(steps: Step[], visit: (step: Step, info: WalkInfo) => void | false, parent: Step | null = null, depth = 0, loops: Step[] = [], branch: Branch = 'children'): void {
  steps.forEach((step, index) => {
    if (visit(step, { depth, parent, branch, index, loops }) === false) return;
    const inner = isLoop(step) ? [...loops, step] : loops;
    for (const b of branchesOf(step)) walk(step[b] ?? [], visit, step, depth + 1, inner, b);
  });
}

export function flatten(steps: Step[]): Step[] {
  const out: Step[] = [];
  walk(steps, (s) => void out.push(s));
  return out;
}

export function countSteps(steps: Step[]): number {
  return flatten(steps).length;
}

export function maxDepth(steps: Step[]): number {
  let max = 0;
  walk(steps, (_s, info) => void (max = Math.max(max, info.depth + 1)));
  return max;
}

export function findStep(steps: Step[], id: string): Step | undefined {
  return flatten(steps).find((s) => s.id === id);
}

export function findLocation(steps: Step[], id: string): Location | undefined {
  let found: Location | undefined;
  walk(steps, (s, info) => {
    if (s.id === id) found = { parentId: info.parent?.id ?? null, branch: info.branch, index: info.index };
  });
  return found;
}

export function getList(steps: Step[], ref: ListRef): Step[] | undefined {
  if (ref.parentId === null) return steps;
  const parent = findStep(steps, ref.parentId);
  return parent ? parent[ref.branch] ?? [] : undefined;
}

/** Replaces the list identified by `ref` with `fn(list)`. */
export function mapList(steps: Step[], ref: ListRef, fn: (list: Step[]) => Step[]): Step[] {
  if (ref.parentId === null) return fn(steps);
  return mapSteps(steps, (s) => (s.id === ref.parentId ? ({ ...s, [ref.branch]: fn(s[ref.branch] ?? []) } as Step) : s));
}

/** Applies fn to every step (bottom-up), rebuilding the tree. */
export function mapSteps(steps: Step[], fn: (step: Step) => Step): Step[] {
  return steps.map((s) => {
    let next = s;
    for (const b of branchesOf(s)) if (s[b]) next = { ...next, [b]: mapSteps(s[b]!, fn) } as Step;
    return fn(next);
  });
}

export function updateStep(steps: Step[], id: string, fn: (step: Step) => Step): Step[] {
  return mapSteps(steps, (s) => (s.id === id ? fn(s) : s));
}

export function removeStep(steps: Step[], id: string): Step[] {
  const loc = findLocation(steps, id);
  if (!loc) return steps;
  return mapList(steps, loc, (list) => list.filter((s) => s.id !== id));
}

export function insertStep(steps: Step[], loc: Location, step: Step): Step[] {
  return mapList(steps, loc, (list) => {
    const next = [...list];
    next.splice(Math.max(0, Math.min(loc.index, list.length)), 0, step);
    return next;
  });
}

/** True if `id` is `step` itself or anywhere inside it. */
export function containsStep(step: Step, id: string): boolean {
  return step.id === id || flatten(branchesOf(step).flatMap((b) => step[b] ?? [])).some((s) => s.id === id);
}

/** Moves a step to a new location. Refuses moves into the step's own subtree. */
export function moveStep(steps: Step[], id: string, to: Location): Step[] {
  const step = findStep(steps, id);
  const from = findLocation(steps, id);
  if (!step || !from) return steps;
  if (to.parentId !== null && containsStep(step, to.parentId)) return steps;
  let index = to.index;
  // Removing first shifts later siblings in the same list.
  if (from.parentId === to.parentId && from.branch === to.branch && from.index < to.index) index -= 1;
  if (from.parentId === to.parentId && from.branch === to.branch && from.index === index) return steps;
  return insertStep(removeStep(steps, id), { ...to, index }, step);
}

/** Deep copy with fresh ids for the step and all of its descendants. */
export function cloneWithNewIds(step: Step): Step {
  const copy = { ...structuredClone(step), id: newId('s') } as Step;
  for (const b of branchesOf(copy)) if (copy[b]) copy[b] = copy[b]!.map(cloneWithNewIds);
  return copy;
}

export function reassignIds(steps: Step[]): Step[] {
  return steps.map(cloneWithNewIds);
}

/** Display numbers: "3", "3.1" (body / then), "3.e1" (else). */
export function stepNumbers(steps: Step[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (list: Step[], prefix: string) =>
    list.forEach((s, i) => {
      const label = `${prefix}${i + 1}`;
      out.set(s.id, label);
      if (s.children) visit(s.children, `${label}.`);
      if (s.elseChildren) visit(s.elseChildren, `${label}.e`);
    });
  visit(steps, '');
  return out;
}
