import { describe, expect, it } from 'vitest';
import { editorReducer, initEditor } from '../../src/ui/editor/state';
import type { EditorState } from '../../src/ui/editor/state';
import { css, step, wf } from '../helpers/fakes';
import { findLocation, findStep, flatten } from '../../src/shared/schema/tree';

const start = () => {
  const steps = [step('openUrl', { url: 'https://a.com' }), step('click', { locator: css('#a') }), step('click', { locator: css('#b') })];
  return initEditor(wf(steps));
};
const ids = (s: EditorState) => s.workflow.steps.map((x) => x.id);

describe('editorReducer', () => {
  it('starts clean with the first step selected', () => {
    const s = start();
    expect(s.dirty).toBe(false);
    expect(s.selectedId).toBe(s.workflow.steps[0].id);
  });

  it('adds a step after the selected one and selects it', () => {
    const s0 = start();
    const s1 = editorReducer(s0, { type: 'addStep', stepType: 'wait' });
    expect(s1.workflow.steps.map((x) => x.type)).toEqual(['openUrl', 'wait', 'click', 'click']);
    expect(s1.selectedId).toBe(s1.workflow.steps[1].id);
    expect(s1.dirty).toBe(true);
  });

  it('moves, duplicates, disables and removes steps', () => {
    const s0 = start();
    const [a, b, c] = ids(s0);
    const moved = editorReducer(s0, { type: 'moveStep', id: c, to: { parentId: null, branch: 'children', index: 0 } });
    expect(ids(moved)).toEqual([c, a, b]);
    expect(ids(editorReducer(s0, { type: 'shiftStep', id: a, delta: 1 }))).toEqual([b, a, c]);
    expect(ids(editorReducer(s0, { type: 'shiftStep', id: c, delta: -1 }))).toEqual([a, c, b]);
    expect(editorReducer(s0, { type: 'shiftStep', id: a, delta: -1 })).toBe(s0);

    const dup = editorReducer(s0, { type: 'duplicateStep', id: b });
    expect(dup.workflow.steps).toHaveLength(4);
    expect(dup.workflow.steps[2]).toMatchObject({ type: 'click', params: { locator: { value: '#a' } } });
    expect(dup.workflow.steps[2].id).not.toBe(b);
    expect(dup.selectedId).toBe(dup.workflow.steps[2].id);

    const toggled = editorReducer(s0, { type: 'toggleStep', id: b });
    expect(toggled.workflow.steps[1].disabled).toBe(true);

    const selected = editorReducer(s0, { type: 'select', id: b });
    const removed = editorReducer(selected, { type: 'removeStep', id: b });
    expect(ids(removed)).toEqual([a, c]);
    expect(removed.selectedId).toBe(c);
  });

  it('updates params and keeps the target when changing between element actions', () => {
    const s0 = start();
    const id = s0.workflow.steps[1].id;
    const typed = editorReducer(s0, { type: 'changeType', id, stepType: 'type' });
    expect(typed.workflow.steps[1]).toMatchObject({ type: 'type', params: { locator: { value: '#a' }, text: '', clearFirst: true } });
    const edited = editorReducer(typed, { type: 'updateParams', id, patch: { text: 'hi' } });
    expect(edited.workflow.steps[1].params).toMatchObject({ text: 'hi', locator: { value: '#a' } });
    const wait = editorReducer(edited, { type: 'changeType', id, stepType: 'confirm' });
    expect(wait.workflow.steps[1]).toMatchObject({ type: 'confirm', params: { message: 'Continue?' } });
  });

  it('manages variables with unique default names', () => {
    let s = start();
    s = editorReducer(s, { type: 'addVariable' });
    s = editorReducer(s, { type: 'addVariable' });
    expect(s.workflow.variables.map((v) => v.name)).toEqual(['var1', 'var2']);
    s = editorReducer(s, { type: 'updateVariable', index: 0, patch: { name: 'email', askAtRunStart: true } });
    s = editorReducer(s, { type: 'removeVariable', index: 1 });
    expect(s.workflow.variables).toEqual([{ name: 'email', defaultValue: '', askAtRunStart: true }]);
  });

  it('clears the dirty flag when saved', () => {
    const s1 = editorReducer(start(), { type: 'patch', patch: { name: 'Renamed' } });
    expect(s1.dirty).toBe(true);
    const s2 = editorReducer(s1, { type: 'saved', workflow: s1.workflow });
    expect(s2.dirty).toBe(false);
    expect(s2.workflow.name).toBe('Renamed');
  });
});

describe('editorReducer — nested blocks', () => {
  const tree = () => {
    const s = initEditor(wf([step('openUrl', { url: 'https://a.com' }), step('click', { locator: css('#a') })]));
    return editorReducer(s, { type: 'addStep', stepType: 'repeat', location: { parentId: null, branch: 'children', index: 2 } });
  };

  it('creates block steps with empty bodies and adds steps inside them', () => {
    let s = tree();
    const loop = s.workflow.steps[2];
    expect(loop).toMatchObject({ type: 'repeat', children: [] });
    s = editorReducer(s, { type: 'addStep', stepType: 'type', location: { parentId: loop.id, branch: 'children', index: 0 } });
    expect(findStep(s.workflow.steps, loop.id)!.children!.map((c) => c.type)).toEqual(['type']);
    // Without a location, a new step goes right after the selected (nested) step.
    s = editorReducer(s, { type: 'addStep', stepType: 'clear' });
    expect(findStep(s.workflow.steps, loop.id)!.children!.map((c) => c.type)).toEqual(['type', 'clear']);
  });

  it('indents into the block above and outdents back out', () => {
    let s = tree();
    const loop = s.workflow.steps[2];
    s = editorReducer(s, { type: 'addStep', stepType: 'wait', location: { parentId: null, branch: 'children', index: 3 } });
    const waitId = s.workflow.steps[3].id;
    s = editorReducer(s, { type: 'indentStep', id: waitId });
    expect(findLocation(s.workflow.steps, waitId)).toEqual({ parentId: loop.id, branch: 'children', index: 0 });
    s = editorReducer(s, { type: 'outdentStep', id: waitId });
    expect(findLocation(s.workflow.steps, waitId)).toEqual({ parentId: null, branch: 'children', index: 3 });
    // Indent is a no-op when the step above is not a block.
    expect(editorReducer(s, { type: 'indentStep', id: s.workflow.steps[1].id })).toBe(s);
  });

  it('moves steps between blocks but never into themselves', () => {
    let s = tree();
    const loop = s.workflow.steps[2];
    const clickId = s.workflow.steps[1].id;
    s = editorReducer(s, { type: 'moveStep', id: clickId, to: { parentId: loop.id, branch: 'children', index: 0 } });
    expect(findStep(s.workflow.steps, loop.id)!.children!.map((c) => c.id)).toEqual([clickId]);
    const before = s;
    s = editorReducer(s, { type: 'moveStep', id: loop.id, to: { parentId: loop.id, branch: 'children', index: 0 } });
    expect(s).toBe(before);
  });

  it('duplicates a block with fresh ids throughout', () => {
    let s = tree();
    const loop = s.workflow.steps[2];
    s = editorReducer(s, { type: 'addStep', stepType: 'click', location: { parentId: loop.id, branch: 'children', index: 0 } });
    s = editorReducer(s, { type: 'duplicateStep', id: loop.id });
    const all = flatten(s.workflow.steps);
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
    expect(s.workflow.steps.filter((x) => x.type === 'repeat')).toHaveLength(2);
  });

  it('keeps nested steps when a block is changed to a non-block action', () => {
    let s = tree();
    const loop = s.workflow.steps[2];
    s = editorReducer(s, { type: 'addStep', stepType: 'click', location: { parentId: loop.id, branch: 'children', index: 0 } });
    s = editorReducer(s, { type: 'changeType', id: loop.id, stepType: 'wait' });
    expect(s.workflow.steps.map((x) => x.type)).toEqual(['openUrl', 'click', 'wait', 'click']);
    expect(s.workflow.steps[2].children).toBeUndefined();
  });

  it('gives an If block both branches and removes nested selections cleanly', () => {
    let s = editorReducer(initEditor(wf([])), { type: 'addStep', stepType: 'if' });
    const ifId = s.workflow.steps[0].id;
    expect(s.workflow.steps[0]).toMatchObject({ children: [], elseChildren: [] });
    s = editorReducer(s, { type: 'addStep', stepType: 'click', location: { parentId: ifId, branch: 'elseChildren', index: 0 } });
    const childId = s.selectedId!;
    s = editorReducer(s, { type: 'removeStep', id: childId });
    expect(s.selectedId).toBe(ifId);
    expect(findStep(s.workflow.steps, ifId)!.elseChildren).toEqual([]);
  });

  it('stores data tables', () => {
    const s = editorReducer(tree(), { type: 'setData', data: { columns: ['a'], rows: [['1']] } });
    expect(s.workflow.data).toEqual({ columns: ['a'], rows: [['1']] });
    expect(s.dirty).toBe(true);
  });
});
