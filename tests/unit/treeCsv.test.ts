import { describe, expect, it } from 'vitest';
import { cloneWithNewIds, countSteps, findLocation, flatten, maxDepth, moveStep, stepNumbers } from '../../src/shared/schema/tree';
import { CsvError, parseCsv, parseCsvRows, toColumnName, toCsv } from '../../src/shared/csv';
import { parseImport, upgradeStoredWorkflow } from '../../src/shared/schema/importExport';
import { performDomRequest } from '../../src/content/domActions';
import type { Step, Workflow } from '../../src/shared/schema/types';
import { css, step, wf } from '../helpers/fakes';

const sample = () => {
  const inner = { ...step('repeat', { times: 2 }), children: [step('click', { locator: css('#c') })] } as Step;
  const ifStep = { ...step('if'), children: [inner], elseChildren: [step('clear', { locator: css('#e') })] } as Step;
  return [step('openUrl', { url: 'https://a.com' }), ifStep, step('wait', { mode: 'duration', durationMs: 1 })];
};

describe('step tree', () => {
  it('flattens in document order, counts and measures depth', () => {
    const steps = sample();
    expect(flatten(steps).map((s) => s.type)).toEqual(['openUrl', 'if', 'repeat', 'click', 'clear', 'wait']);
    expect(countSteps(steps)).toBe(6);
    expect(maxDepth(steps)).toBe(3);
  });

  it('numbers steps for display', () => {
    const steps = sample();
    const n = stepNumbers(steps);
    expect(flatten(steps).map((s) => n.get(s.id))).toEqual(['1', '2', '2.1', '2.1.1', '2.e1', '3']);
  });

  it('locates and moves steps across branches', () => {
    const steps = sample();
    const clear = flatten(steps).find((s) => s.type === 'clear')!;
    const ifStep = steps[1];
    expect(findLocation(steps, clear.id)).toEqual({ parentId: ifStep.id, branch: 'elseChildren', index: 0 });
    const moved = moveStep(steps, clear.id, { parentId: null, branch: 'children', index: 0 });
    expect(moved.map((s) => s.type)).toEqual(['clear', 'openUrl', 'if', 'wait']);
    expect(moved[2].elseChildren).toEqual([]);
    // Moving a block into its own descendant is refused.
    const repeat = ifStep.children![0];
    expect(moveStep(steps, ifStep.id, { parentId: repeat.id, branch: 'children', index: 0 })).toBe(steps);
  });

  it('clones a subtree with fresh ids', () => {
    const ifStep = sample()[1];
    const copy = cloneWithNewIds(ifStep);
    const before = flatten([ifStep]).map((s) => s.id);
    const after = flatten([copy]).map((s) => s.id);
    expect(after).toHaveLength(before.length);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });
});

describe('CSV', () => {
  it('parses quoted fields, escaped quotes, CRLF, BOM and blank lines', () => {
    const text = '﻿Name,"Note, with comma",Quote\r\nAda,"multi\nline","He said ""hi"""\r\n\r\nGrace,,x\r\n';
    expect(parseCsvRows(text)).toEqual([
      ['Name', 'Note, with comma', 'Quote'],
      ['Ada', 'multi\nline', 'He said "hi"'],
      ['Grace', '', 'x'],
    ]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsvRows('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsvRows('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('turns headers into unique variable-safe column names and pads short rows', () => {
    const parsed = parseCsv('E-mail Address,First name,first name,2nd,\nx@y.z,Ada');
    expect(parsed.columns).toEqual(['e_mail_address', 'first_name', 'first_name_2', '_2nd', 'column_5']);
    expect(parsed.rows).toEqual([['x@y.z', 'Ada', '', '', '']]);
    expect(toColumnName('  ', 0)).toBe('column_1');
  });

  it('rejects empty files and unclosed quotes', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
    expect(() => parseCsv('a\n"oops')).toThrow('Unclosed quote');
  });

  it('serializes with quoting and neutralises spreadsheet formulas but not negative numbers', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['=SUM(A1)', '-5'], ['-cmd', '@x']])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n\'=SUM(A1),-5\r\n\'-cmd,\'@x',
    );
  });

  it('round-trips', () => {
    const rows = [['1', 'multi\nline'], ['2', 'q"uote']];
    expect(parseCsv(toCsv(['id', 'text'], rows)).rows).toEqual(rows);
  });
});

describe('schema migration', () => {
  it('imports v1 files and upgrades stored v1 workflows', () => {
    const v1 = { ...wf([step('openUrl', { url: 'https://a.com' })]), schemaVersion: 1 } as unknown as Workflow;
    const { imported } = parseImport(JSON.stringify({ format: 'flowpilot.workflows', schemaVersion: 1, workflows: [v1] }));
    expect(imported[0].workflow.schemaVersion).toBe(2);
    expect(upgradeStoredWorkflow(v1).schemaVersion).toBe(2);
  });

  it('reassigns nested step ids on import', () => {
    const w = wf(sample());
    const { imported } = parseImport(JSON.stringify(w));
    const before = flatten(w.steps).map((s) => s.id);
    const after = flatten(imported[0].workflow.steps).map((s) => s.id);
    expect(after).toHaveLength(6);
    expect(after.some((id) => before.includes(id))).toBe(false);
  });

  it('rejects deeply nested script URLs in imports', () => {
    const evil = wf([{ ...step('repeat'), children: [step('openUrl', { url: 'javascript:alert(1)' })] } as Step]);
    const { rejected } = parseImport(JSON.stringify(evil));
    expect(rejected).toHaveLength(1);
  });
});

describe('markNth DOM operation', () => {
  it('tags the nth match, moves the tag on later iterations and reports the end', () => {
    document.body.innerHTML = '<ul><li>One</li><li>Two</li></ul><input type="password" class="pw" value="secret">';
    expect(performDomRequest(document, { op: 'markNth', locator: css('li'), index: 0, mark: 's_1' })).toEqual({ found: true, total: 2, text: 'One' });
    expect(document.querySelectorAll('[data-flowpilot-item="s_1"]')).toHaveLength(1);
    expect(performDomRequest(document, { op: 'markNth', locator: css('li'), index: 1, mark: 's_1' })).toEqual({ found: true, total: 2, text: 'Two' });
    expect(document.querySelector('[data-flowpilot-item="s_1"]')!.textContent).toBe('Two');
    expect(performDomRequest(document, { op: 'markNth', locator: css('li'), index: 2, mark: 's_1' })).toEqual({ found: false, total: 2, text: '' });
    // Password values are never returned.
    expect(performDomRequest(document, { op: 'markNth', locator: css('.pw'), index: 0, mark: 's_2' }).text).toBe('');
  });
});
