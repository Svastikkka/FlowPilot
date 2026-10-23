import { z } from 'zod';
import { SCHEMA_VERSION } from './types';
import type { ActionParamsMap, ActionType, Step, Workflow } from './types';

// Structural validation for workflows. Used for every import and before every
// run. Unknown keys are stripped, and every string/array is length-capped so a
// hostile file cannot bloat storage or the UI.

export const LIMITS = {
  /** Total steps in a workflow, counting nested ones. */
  maxSteps: 500,
  maxDepth: 8,
  maxVariables: 100,
  maxTags: 20,
  shortText: 200,
  longText: 10_000,
  maxTimeoutMs: 10 * 60_000,
  maxRetries: 10,
  maxStepDelayMs: 60_000,
  maxWaitMs: 60 * 60_000,
  maxImportBytes: 5 * 1024 * 1024,
  maxWorkflowsPerImport: 200,
  maxIterations: 10_000,
  maxDataColumns: 50,
  maxDataRows: 5_000,
  maxTableRows: 10_000,
  /** Step executions per run, across all loop iterations (runaway-loop guard). */
  maxExecutions: 50_000,
  maxPatternLength: 500,
} as const;

export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const shortText = z.string().max(LIMITS.shortText);
const longText = z.string().max(LIMITS.longText);
const variableName = z.string().regex(VARIABLE_NAME_RE, 'Use letters, digits and underscores; start with a letter or _');

export const locatorSchema = z.object({
  strategy: z.enum(['css', 'text', 'label', 'xpath']),
  value: z.string().max(2_000),
});

const errorPolicy = z.enum(['stop', 'skip', 'ask']);
const iterations = z.number().int().min(0).max(LIMITS.maxIterations);

const conditionFields = {
  condition: z.enum(['elementExists', 'elementVisible', 'elementMissing', 'textPresent', 'urlContains', 'variable']),
  locator: locatorSchema,
  value: z.string().max(2_000),
  variable: z.string().max(64),
  operator: z.enum(['equals', 'notEquals', 'contains', 'notContains', 'matches', 'greaterThan', 'lessThan', 'isEmpty', 'isNotEmpty']),
};

export const paramsSchemas = {
  openUrl: z.object({ url: z.string().max(4_000) }),
  navigate: z.object({ direction: z.enum(['back', 'forward', 'reload']) }),
  click: z.object({ locator: locatorSchema }),
  type: z.object({
    locator: locatorSchema,
    text: longText,
    clearFirst: z.boolean(),
    pressEnter: z.boolean(),
  }),
  clear: z.object({ locator: locatorSchema }),
  select: z.object({ locator: locatorSchema, by: z.enum(['value', 'label', 'index']), value: z.string().max(2_000) }),
  check: z.object({ locator: locatorSchema, checked: z.boolean() }),
  wait: z.object({
    mode: z.enum(['element', 'elementHidden', 'duration', 'pageLoad', 'urlContains', 'textPresent']),
    locator: locatorSchema.optional(),
    durationMs: z.number().int().min(0).max(LIMITS.maxWaitMs).optional(),
    value: z.string().max(2_000).optional(),
  }),
  extractText: z.object({ locator: locatorSchema, variable: z.string().max(64), all: z.boolean() }),
  capturePage: z.object({ what: z.enum(['url', 'title']), variable: z.string().max(64) }),
  scroll: z.object({
    mode: z.enum(['element', 'position', 'top', 'bottom']),
    locator: locatorSchema.optional(),
    x: z.number().int().min(0).max(1_000_000).optional(),
    y: z.number().int().min(0).max(1_000_000).optional(),
  }),
  screenshot: z.object({ label: shortText }),
  confirm: z.object({ message: longText }),
  copyToClipboard: z.object({ template: longText }),
  stop: z.object({ outcome: z.enum(['failed', 'succeeded']), message: longText }),
  if: z.object(conditionFields),
  repeat: z.object({ times: iterations, loopVariable: z.string().max(64) }),
  while: z.object({ ...conditionFields, maxIterations: iterations, loopVariable: z.string().max(64) }),
  forEachElement: z.object({ locator: locatorSchema, loopVariable: z.string().max(64), maxItems: iterations }),
  forEachRow: z.object({ loopVariable: z.string().max(64), maxRows: z.number().int().min(0).max(LIMITS.maxDataRows) }),
  break: z.object({}).strip(),
  continue: z.object({}).strip(),
  setVariable: z.object({
    variable: z.string().max(64),
    operation: z.enum(['set', 'append', 'increment', 'slice', 'regexExtract', 'regexReplace', 'trim', 'upperCase', 'lowerCase', 'length']),
    value: longText,
    pattern: z.string().max(LIMITS.maxPatternLength),
    replacement: z.string().max(2_000),
    start: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    end: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  }),
  addRow: z.object({
    columns: z.array(z.object({ name: z.string().max(64), value: z.string().max(2_000) })).max(LIMITS.maxDataColumns),
  }),
} satisfies Record<ActionType, z.ZodTypeAny>;

const stepBase = {
  id: z.string().min(1).max(64),
  name: shortText.optional(),
  notes: longText.optional(),
  disabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(LIMITS.maxTimeoutMs).optional(),
  retries: z.number().int().min(0).max(LIMITS.maxRetries).optional(),
  onError: errorPolicy.optional(),
  confirmBefore: z.boolean().optional(),
  children: z.array(z.lazy((): z.ZodType<Step, z.ZodTypeDef, unknown> => stepSchema)).max(LIMITS.maxSteps, `A block can contain at most ${LIMITS.maxSteps} steps`).optional(),
  elseChildren: z.array(z.lazy((): z.ZodType<Step, z.ZodTypeDef, unknown> => stepSchema)).max(LIMITS.maxSteps, `A block can contain at most ${LIMITS.maxSteps} steps`).optional(),
};

function step<T extends ActionType, P extends z.ZodTypeAny>(type: T, params: P) {
  return z.object({ ...stepBase, type: z.literal(type), params });
}

export const stepSchema: z.ZodType<Step, z.ZodTypeDef, unknown> = z.discriminatedUnion('type', [
  step('openUrl', paramsSchemas.openUrl),
  step('navigate', paramsSchemas.navigate),
  step('click', paramsSchemas.click),
  step('type', paramsSchemas.type),
  step('clear', paramsSchemas.clear),
  step('select', paramsSchemas.select),
  step('check', paramsSchemas.check),
  step('wait', paramsSchemas.wait),
  step('extractText', paramsSchemas.extractText),
  step('capturePage', paramsSchemas.capturePage),
  step('scroll', paramsSchemas.scroll),
  step('screenshot', paramsSchemas.screenshot),
  step('confirm', paramsSchemas.confirm),
  step('copyToClipboard', paramsSchemas.copyToClipboard),
  step('stop', paramsSchemas.stop),
  step('if', paramsSchemas.if),
  step('repeat', paramsSchemas.repeat),
  step('while', paramsSchemas.while),
  step('forEachElement', paramsSchemas.forEachElement),
  step('forEachRow', paramsSchemas.forEachRow),
  step('break', paramsSchemas.break),
  step('continue', paramsSchemas.continue),
  step('setVariable', paramsSchemas.setVariable),
  step('addRow', paramsSchemas.addRow),
]) as unknown as z.ZodType<Step, z.ZodTypeDef, unknown>;

export const variableSchema = z.object({
  name: variableName,
  defaultValue: longText,
  description: shortText.optional(),
  askAtRunStart: z.boolean().optional(),
  secret: z.boolean().optional(),
});

export const settingsSchema = z.object({
  defaultTimeoutMs: z.number().int().min(100).max(LIMITS.maxTimeoutMs),
  defaultRetries: z.number().int().min(0).max(LIMITS.maxRetries),
  defaultOnError: errorPolicy,
  stepDelayMs: z.number().int().min(0).max(LIMITS.maxStepDelayMs),
});

export const dataTableSchema = z.object({
  columns: z.array(variableName).max(LIMITS.maxDataColumns),
  rows: z.array(z.array(z.string().max(LIMITS.longText)).max(LIMITS.maxDataColumns)).max(LIMITS.maxDataRows),
});

const runStatus = z.enum(['queued', 'running', 'paused', 'waiting_for_user', 'succeeded', 'failed', 'stopped', 'interrupted']);

export const workflowSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, 'Name is required').max(LIMITS.shortText),
  description: longText,
  tags: z.array(z.string().trim().min(1).max(40)).max(LIMITS.maxTags),
  favorite: z.boolean(),
  variables: z.array(variableSchema).max(LIMITS.maxVariables),
  settings: settingsSchema,
  steps: z.array(stepSchema).max(LIMITS.maxSteps, `A workflow can have at most ${LIMITS.maxSteps} steps`),
  data: dataTableSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastRun: z.object({ runId: z.string().max(64), status: runStatus, finishedAt: z.number() }).optional(),
});

// Compile-time guarantee that the zod output matches the hand-written types.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type ParamsMatch = { [K in ActionType]: MutuallyAssignable<z.infer<(typeof paramsSchemas)[K]>, ActionParamsMap[K]> };
const _paramsMatch: { [K in ActionType]: true } = {} as ParamsMatch;
const _workflowTypesMatch: MutuallyAssignable<z.infer<typeof workflowSchema>, Workflow> = true;
void _paramsMatch;
void _workflowTypesMatch;
