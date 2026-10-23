import { describe, expect, it } from 'vitest';
import { validateWorkflow, checkUrl } from '../../src/shared/schema/validate';
import { exportWorkflows, parseImport, ImportError, EXPORT_FORMAT } from '../../src/shared/schema/importExport';
import { ACTIONS, ACTION_TYPES, createStep, stepSummary } from '../../src/shared/schema/actions';
import { paramsSchemas } from '../../src/shared/schema/zod';
import { cloneWorkflow, newWorkflow } from '../../src/shared/schema/factory';
import { TEMPLATES } from '../../src/templates';
import { css, step, wf } from '../helpers/fakes';
import type { Step } from '../../src/shared/schema/types';

describe('action catalogue', () => {
  it('has defaults that satisfy each action schema', () => {
    for (const type of ACTION_TYPES) {
      expect(paramsSchemas[type].safeParse(ACTIONS[type].defaults()).success, type).toBe(true);
      expect(typeof stepSummary(createStep(type) as Step)).toBe('string');
    }
  });

  it('covers the 15 core actions plus 9 logic and data actions', () => {
    expect(ACTION_TYPES).toHaveLength(24);
  });
});

describe('validateWorkflow', () => {
  it('accepts a well-formed workflow', () => {
    const r = validateWorkflow(wf([step('openUrl', { url: 'https://example.com' }), step('click', { locator: css('#go') })]));
    expect(r).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('requires a name and at least one enabled step', () => {
    expect(validateWorkflow(wf([], { name: '  ' })).errors.map((e) => e.message)).toContain('Name is required');
    expect(validateWorkflow(wf([])).errors.map((e) => e.message)).toContain('Add at least one step');
    expect(validateWorkflow(wf([step('click', { locator: css('#a') }, { disabled: true })])).errors.map((e) => e.message)).toContain(
      'All steps are disabled',
    );
  });

  it('flags missing targets and invalid selectors on the step', () => {
    const s1 = step('click', { locator: css('') });
    const s2 = step('click', { locator: css('div[') });
    const r = validateWorkflow(wf([step('openUrl', { url: 'https://a.com' }), s1, s2]));
    expect(r.errors).toContainEqual({ stepId: s1.id, field: 'locator', message: 'Target element is required' });
    expect(r.errors).toContainEqual({ stepId: s2.id, field: 'locator', message: 'Invalid CSS selector' });
  });

  it('checks variable references against definitions, built-ins and earlier extractions', () => {
    const extract = step('extractText', { locator: css('h1'), variable: 'heading' });
    const usesLater = step('type', { locator: css('#a'), text: '{{heading}}' });
    const unknown = step('type', { locator: css('#b'), text: '{{mystery}} {{date}} {{user}}' });
    const r = validateWorkflow(
      wf([step('openUrl', { url: 'https://a.com' }), usesLater, extract, unknown], { variables: [{ name: 'user', defaultValue: 'x' }] }),
    );
    const messages = r.errors.map((e) => `${e.stepId === usesLater.id ? 'early' : e.stepId === unknown.id ? 'unknown' : '?'}:${e.message}`);
    expect(messages).toContain('early:{{heading}} is set by step 3, which runs later or outside this block');
    expect(messages.some((m) => m.startsWith('unknown:Unknown variable {{mystery}}'))).toBe(true);
    expect(messages.filter((m) => m.includes('{{date}}') || m.includes('{{user}}'))).toEqual([]);
  });

  it('rejects duplicate and built-in variable names', () => {
    const r = validateWorkflow(
      wf([step('openUrl', { url: 'https://a.com' })], {
        variables: [
          { name: 'a', defaultValue: '' },
          { name: 'a', defaultValue: '' },
          { name: 'date', defaultValue: '' },
        ],
      }),
    );
    expect(r.errors.map((e) => e.message)).toEqual(['Variable "a" is defined twice', '"date" is a built-in value and cannot be redefined']);
  });

  it('validates action-specific parameters', () => {
    const wait = step('wait', { mode: 'duration', durationMs: 0 });
    const sel = step('select', { locator: css('#s'), by: 'index', value: 'two' });
    const r = validateWorkflow(wf([step('openUrl', { url: 'https://a.com' }), wait, sel]));
    expect(r.errors).toContainEqual({ stepId: wait.id, field: 'durationMs', message: 'Enter a duration greater than 0' });
    expect(r.errors).toContainEqual({ stepId: sel.id, field: 'value', message: 'Position must be a whole number' });
  });

  it('warns about a first step that is not Open URL, sensitive clicks and credentials', () => {
    const buy = step('click', { locator: { strategy: 'text', value: 'Place order' } });
    const pw = step('type', { locator: css('#password'), text: 'literal' });
    const r = validateWorkflow(wf([buy, pw]));
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.stepId)).toEqual([buy.id, pw.id, buy.id]);
    // Enabling confirmBefore silences the sensitive-click warning.
    const r2 = validateWorkflow(wf([step('openUrl', { url: 'https://a.com' }), { ...buy, confirmBefore: true }]));
    expect(r2.warnings).toEqual([]);
  });

  it('reports structural problems from untrusted input', () => {
    const r = validateWorkflow({ ...newWorkflow(), steps: [{ id: 'x', type: 'runScript', params: { code: 'alert(1)' } }] });
    expect(r.valid).toBe(false);
  });
});

describe('checkUrl', () => {
  it.each([
    ['https://example.com/path?q=1', null],
    ['http://localhost:3000', null],
    ['https://{{host}}/x', null],
    ['', 'URL is required'],
    ['example.com', 'Enter a full URL, e.g. https://example.com'],
    ['javascript:alert(1)', 'This URL scheme is not allowed'],
    ['JavaScript:{{x}}', 'This URL scheme is not allowed'],
    ['data:text/html,hi', 'This URL scheme is not allowed'],
    ['chrome://settings', 'Browsers do not allow extensions to automate this kind of page'],
    ['ftp://files.example.com', 'Only http and https URLs are supported'],
  ])('%s → %s', (url, expected) => {
    expect(checkUrl(url)).toBe(expected);
  });
});

describe('import / export', () => {
  const sample = () => wf([step('openUrl', { url: 'https://example.com' }), step('click', { locator: css('#go') })], { name: 'Sample', tags: ['a'] });

  it('round-trips workflows with fresh ids and without run history', () => {
    const original = { ...sample(), lastRun: { runId: 'r1', status: 'succeeded' as const, finishedAt: 1 } };
    const json = exportWorkflows([original]);
    expect(JSON.parse(json)).toMatchObject({ format: EXPORT_FORMAT, schemaVersion: 2 });
    expect(json).not.toContain('lastRun');
    const { imported, rejected } = parseImport(json);
    expect(rejected).toEqual([]);
    expect(imported).toHaveLength(1);
    const w = imported[0].workflow;
    expect(w.name).toBe('Sample');
    expect(w.id).not.toBe(original.id);
    expect(w.steps[0].id).not.toBe(original.steps[0].id);
    expect(w.steps.map((s) => s.type)).toEqual(['openUrl', 'click']);
  });

  it('accepts a bare workflow object', () => {
    expect(parseImport(JSON.stringify(sample())).imported).toHaveLength(1);
  });

  it('rejects malformed files', () => {
    expect(() => parseImport('not json')).toThrow(ImportError);
    expect(() => parseImport('{"hello":1}')).toThrow('not a FlowPilot export');
    expect(() => parseImport(JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: 99, workflows: [] }))).toThrow('update FlowPilot');
    expect(() => parseImport('x'.repeat(6 * 1024 * 1024))).toThrow('larger than');
  });

  it('rejects workflows with unknown actions or script URLs, keeping valid ones', () => {
    const evil = { ...sample(), name: 'Evil', steps: [{ id: 's', type: 'executeScript', params: { code: 'fetch("https://x")' } }] };
    const jsUrl = { ...sample(), name: 'JS', steps: [{ id: 's', type: 'openUrl', params: { url: 'javascript:alert(document.cookie)' } }] };
    const { imported, rejected } = parseImport(JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: 2, workflows: [evil, jsUrl, sample()] }));
    expect(imported.map((i) => i.workflow.name)).toEqual(['Sample']);
    expect(rejected.map((r) => r.name)).toEqual(['Evil', 'JS']);
  });

  it('strips unknown keys and imports semantically invalid workflows as drafts', () => {
    const draft = { ...sample(), injected: '<script>', steps: [{ ...createStep('click'), extra: true }] };
    const { imported } = parseImport(JSON.stringify(draft));
    expect(JSON.stringify(imported[0].workflow)).not.toContain('injected');
    expect(JSON.stringify(imported[0].workflow)).not.toContain('extra');
    expect(imported[0].draftReasons).toContain('Target element is required');
  });
});

describe('templates', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s is valid and editable', (_name, template) => {
    const built = template.build();
    const result = validateWorkflow(built);
    expect(result.errors).toEqual([]);
    // Each build is independent.
    expect(template.build().id).not.toBe(built.id);
  });

  it('cloneWorkflow gives new ids and leaves the original untouched', () => {
    const original = TEMPLATES[0].build();
    const copy = cloneWorkflow(original, { name: 'Copy' });
    expect(copy.id).not.toBe(original.id);
    expect(copy.steps.map((s) => s.id)).not.toEqual(original.steps.map((s) => s.id));
    expect(original.name).toBe('Repetitive form entry');
  });
});

describe('validation messages', () => {
  it('reports each problem once', () => {
    const s = step('openUrl', { url: '' });
    expect(validateWorkflow(wf([s])).errors).toEqual([{ stepId: s.id, field: 'url', message: 'URL is required' }]);
  });
});
