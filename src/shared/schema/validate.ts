import type { ZodIssue } from 'zod';
import type { DataTable, Locator, Step, TableColumn, Workflow } from './types';
import { LIMITS, workflowSchema, VARIABLE_NAME_RE } from './zod';
import { branchesOf, flatten, isLoop, stepNumbers } from './tree';
import { compileRegex } from '../dataOps';
import { actionDef, stepTitle } from './actions';
import { BUILTIN_VARIABLES, referencedVariables } from '../interpolate';
import { looksLikeCredentialField, sensitiveReason } from '../safety';

export interface ValidationIssue {
  stepId?: string;
  field?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const BLOCKED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'blob:'];
const RESTRICTED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'file:', 'view-source:', 'devtools:'];

export function checkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return 'URL is required';
  const lower = trimmed.toLowerCase();
  if (BLOCKED_SCHEMES.some((s) => lower.startsWith(s))) return 'This URL scheme is not allowed';
  if (lower.includes('{{')) return null; // resolved at run time
  if (RESTRICTED_SCHEMES.some((s) => lower.startsWith(s))) return 'Browsers do not allow extensions to automate this kind of page';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Only http and https URLs are supported';
    if (!parsed.hostname) return 'URL needs a host name';
  } catch {
    return 'Enter a full URL, e.g. https://example.com';
  }
  return null;
}

export function checkLocator(locator: Locator | undefined): string | null {
  if (!locator || !locator.value.trim()) return 'Target element is required';
  if (locator.value.includes('{{')) return null;
  if (typeof document === 'undefined') return null;
  try {
    if (locator.strategy === 'css') document.createDocumentFragment().querySelector(locator.value);
    if (locator.strategy === 'xpath') document.createExpression(locator.value);
  } catch {
    return locator.strategy === 'css' ? 'Invalid CSS selector' : 'Invalid XPath expression';
  }
  return null;
}

function templatedStrings(step: Step): { field: string; value: string }[] {
  const def = actionDef(step.type);
  const params = step.params as unknown as Record<string, unknown>;
  const out: { field: string; value: string }[] = [];
  for (const f of def.fields) {
    if (f.showIf && !(f.showIf as (p: unknown) => boolean)(params)) continue;
    const v = params[f.key];
    if (f.templated && typeof v === 'string') out.push({ field: f.key, value: v });
    if (f.kind === 'locator' && v && typeof v === 'object') out.push({ field: f.key, value: (v as Locator).value });
    if (f.kind === 'columns' && Array.isArray(v)) for (const c of v as TableColumn[]) out.push({ field: f.key, value: c.value });
  }
  return out;
}

/** Variables that a step writes (visible to later steps). */
export function producedVariables(step: Step): string[] {
  if (step.type === 'extractText' || step.type === 'capturePage' || step.type === 'setVariable') return [step.params.variable];
  return [];
}

/** Variables a loop binds for the steps inside it. */
export function loopBindings(step: Step, data?: DataTable): string[] {
  switch (step.type) {
    case 'repeat':
    case 'while':
      return [`${step.params.loopVariable}_index`];
    case 'forEachElement':
      return [step.params.loopVariable, `${step.params.loopVariable}_selector`, `${step.params.loopVariable}_index`];
    case 'forEachRow':
      return [`${step.params.loopVariable}_index`, ...(data?.columns ?? []).map((c) => `${step.params.loopVariable}_${c}`)];
    default:
      return [];
  }
}

interface ScopeInfo {
  depth: number;
  loopDepth: number;
  /** Step or an enclosing block is disabled. */
  disabled: boolean;
}

/**
 * Visits steps in execution order with the set of variables available before
 * each one: definitions, built-ins, values set by earlier steps (including
 * inside earlier blocks) and the bindings of enclosing loops.
 */
export function scopeWalk(wf: Pick<Workflow, 'steps' | 'variables' | 'data'>, visit: (step: Step, scope: Set<string>, info: ScopeInfo) => void): void {
  const walkList = (list: Step[], scope: Set<string>, info: ScopeInfo) => {
    for (const step of list) {
      const disabled = info.disabled || !!step.disabled;
      visit(step, scope, { ...info, disabled });
      const branches = branchesOf(step);
      if (branches.length) {
        const bindings = loopBindings(step, wf.data);
        const inner = new Set([...scope, ...bindings]);
        const childInfo = { depth: info.depth + 1, loopDepth: info.loopDepth + (isLoop(step) ? 1 : 0), disabled };
        for (const b of branches) {
          const branchScope = new Set(inner);
          walkList(step[b] ?? [], branchScope, childInfo);
          // Values set inside a block remain available after it.
          if (!disabled) for (const v of branchScope) if (!bindings.includes(v)) scope.add(v);
        }
      }
      if (!disabled) for (const v of producedVariables(step)) scope.add(v);
    }
  };
  walkList(wf.steps, new Set([...BUILTIN_VARIABLES, ...wf.variables.map((v) => v.name)]), { depth: 0, loopDepth: 0, disabled: false });
}

/** Variables available to a given step (for the editor's variable chips). */
export function scopeAt(wf: Pick<Workflow, 'steps' | 'variables' | 'data'>, stepId: string): string[] {
  let result: string[] = [];
  scopeWalk(wf, (step, scope) => {
    if (step.id === stepId) result = [...scope];
  });
  return result;
}

function zodIssueToValidation(issue: ZodIssue, wf: unknown): ValidationIssue {
  const [head, index, ...rest] = issue.path;
  if (head === 'steps' && typeof index === 'number') {
    const steps = (wf as { steps?: { id?: string }[] }).steps;
    const field = rest.filter((p) => p !== 'params').join('.');
    return { stepId: steps?.[index]?.id, field: field || undefined, message: issue.message };
  }
  return { field: issue.path.join('.') || undefined, message: issue.message };
}

export function validateWorkflow(input: unknown): ValidationResult {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((i) => zodIssueToValidation(i, input)), warnings: [] };
  }
  const wf = parsed.data as Workflow;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const seenVars = new Set<string>();
  for (const v of wf.variables) {
    if (seenVars.has(v.name)) errors.push({ field: 'variables', message: `Variable "${v.name}" is defined twice` });
    if ((BUILTIN_VARIABLES as readonly string[]).includes(v.name)) {
      errors.push({ field: 'variables', message: `"${v.name}" is a built-in value and cannot be redefined` });
    }
    seenVars.add(v.name);
  }

  const all = flatten(wf.steps);
  const enabledTop = wf.steps.filter((s) => !s.disabled);
  if (wf.steps.length === 0) errors.push({ message: 'Add at least one step' });
  else if (enabledTop.length === 0) errors.push({ message: 'All steps are disabled' });
  if (all.length > LIMITS.maxSteps) errors.push({ message: `A workflow can have at most ${LIMITS.maxSteps} steps (including steps inside blocks)` });
  const ids = new Set<string>();
  for (const s of all) {
    if (ids.has(s.id)) errors.push({ stepId: s.id, message: 'Duplicate step id' });
    ids.add(s.id);
  }

  const numbers = stepNumbers(wf.steps);
  const producers = new Map<string, string>();
  for (const s of all) for (const v of [...producedVariables(s), ...loopBindings(s, wf.data)]) if (!producers.has(v)) producers.set(v, s.id);

  scopeWalk(wf, (step, scope, info) => {
    const def = actionDef(step.type);
    const params = step.params as unknown as Record<string, unknown>;
    const err = (field: string | undefined, message: string) => errors.push({ stepId: step.id, field, message });

    if (info.depth >= LIMITS.maxDepth) err(undefined, `Blocks can be nested at most ${LIMITS.maxDepth} levels deep`);

    for (const f of def.fields) {
      if (f.showIf && !(f.showIf as (p: unknown) => boolean)(params)) continue;
      const value = params[f.key];
      if (f.kind === 'locator') {
        const problem = checkLocator(value as Locator | undefined);
        if (problem) err(f.key, problem);
      } else if (f.kind === 'variable') {
        if (typeof value !== 'string' || !VARIABLE_NAME_RE.test(value)) err(f.key, 'Use letters, digits and underscores; start with a letter or _');
        else if ((BUILTIN_VARIABLES as readonly string[]).includes(value)) err(f.key, `"${value}" is a built-in value`);
      } else if (f.required && typeof value === 'string' && !value.trim()) {
        err(f.key, `${f.label} is required`);
      }
    }

    switch (step.type) {
      case 'openUrl': {
        const problem = checkUrl(step.params.url);
        if (problem) err('url', problem);
        break;
      }
      case 'wait':
        if (step.params.mode === 'duration' && !(step.params.durationMs && step.params.durationMs > 0)) {
          err('durationMs', 'Enter a duration greater than 0');
        }
        if ((step.params.mode === 'textPresent' || step.params.mode === 'urlContains') && !step.params.value?.trim()) {
          err('value', 'Text is required');
        }
        break;
      case 'select':
        if (step.params.by === 'index' && !/^\d+$/.test(step.params.value) && !step.params.value.includes('{{')) {
          err('value', 'Position must be a whole number');
        }
        break;
      case 'scroll':
        if (step.params.mode === 'position' && step.params.x === undefined && step.params.y === undefined) {
          err('y', 'Enter a position');
        }
        break;
      case 'if':
      case 'while':
        if (step.params.condition === 'variable') {
          if (step.params.operator === 'matches' && !step.params.value.includes('{{')) {
            try {
              compileRegex(step.params.value);
            } catch (e) {
              err('value', (e as Error).message);
            }
          }
        } else if ((step.params.condition === 'textPresent' || step.params.condition === 'urlContains') && !step.params.value.trim()) {
          err('value', 'Value is required');
        }
        if (step.type === 'while' && step.params.maxIterations < 1) err('maxIterations', 'Allow at least 1 iteration');
        break;
      case 'repeat':
        if (step.params.times < 1) err('times', 'Repeat at least once');
        break;
      case 'forEachElement':
        if (step.params.maxItems < 1) err('maxItems', 'Allow at least 1 element');
        break;
      case 'forEachRow':
        if (!wf.data || wf.data.columns.length === 0) err(undefined, 'Add data on the Data tab (or import a CSV) for this loop to use');
        break;
      case 'break':
      case 'continue':
        if (info.loopDepth === 0) err(undefined, `“${def.label}” only works inside a loop`);
        break;
      case 'setVariable':
        if ((step.params.operation === 'regexExtract' || step.params.operation === 'regexReplace')) {
          if (!step.params.pattern) err('pattern', 'Regular expression is required');
          else {
            try {
              compileRegex(step.params.pattern);
            } catch (e) {
              err('pattern', (e as Error).message);
            }
          }
        }
        break;
      case 'addRow': {
        const names = step.params.columns.map((c) => c.name.trim());
        if (names.length === 0) err('columns', 'Add at least one column');
        if (names.some((n) => !n)) err('columns', 'Every column needs a name');
        if (new Set(names).size !== names.length) err('columns', 'Column names must be unique');
        break;
      }
    }

    if (!info.disabled) {
      for (const { field, value } of templatedStrings(step)) {
        for (const name of referencedVariables(value)) {
          if (scope.has(name)) continue;
          const producer = producers.get(name);
          if (producer) {
            err(field, `{{${name}}} is set by step ${numbers.get(producer)}, which runs later or outside this block`);
          } else {
            err(field, `Unknown variable {{${name}}} — define it under Variables or set it in an earlier step`);
          }
        }
      }
      if (step.type === 'setVariable' && ['append', 'increment', 'slice', 'regexExtract', 'regexReplace', 'trim', 'upperCase', 'lowerCase', 'length'].includes(step.params.operation) && !scope.has(step.params.variable) && step.params.variable) {
        warnings.push({ stepId: step.id, field: 'variable', message: `{{${step.params.variable}}} has no value yet here; it starts empty` });
      }

      const reason = sensitiveReason(step);
      if (reason && !step.confirmBefore) {
        warnings.push({ stepId: step.id, message: `${reason} Consider enabling "Ask before this step".` });
      }
      if (looksLikeCredentialField(step)) {
        warnings.push({
          stepId: step.id,
          field: 'text',
          message: 'This looks like a credential. Workflows are stored unencrypted — use a secret variable asked at run start instead.',
        });
      }
    }
  });

  // The first step that actually runs: descend into blocks (If → "then" branch).
  let first = enabledTop[0];
  while (first && branchesOf(first).length && (first.children ?? []).some((c) => !c.disabled)) first = first.children!.find((c) => !c.disabled)!;
  if (first && first.type !== 'openUrl') {
    warnings.push({
      stepId: first.id,
      message: `"${stepTitle(first)}" is the first step. Runs started from the dashboard open a new tab, so start with "Open URL" unless you run from the toolbar popup on the current page.`,
    });
  }

  const unique = (issues: ValidationIssue[]) => {
    const seen = new Set<string>();
    return issues.filter((i) => {
      const key = `${i.stepId}|${i.field}|${i.message}`;
      return !seen.has(key) && !!seen.add(key);
    });
  };
  return { valid: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
}
