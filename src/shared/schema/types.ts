// Workflow schema. Bump SCHEMA_VERSION and add a migration in
// importExport.ts whenever a persisted shape changes.
// v2: nested logic blocks (children / elseChildren), data tables.
export const SCHEMA_VERSION = 2 as const;

export type ErrorPolicy = 'stop' | 'skip' | 'ask';

export type LocatorStrategy = 'css' | 'text' | 'label' | 'xpath';

export interface Locator {
  strategy: LocatorStrategy;
  value: string;
}

export interface StepBase {
  id: string;
  name?: string;
  notes?: string;
  disabled?: boolean;
  timeoutMs?: number;
  retries?: number;
  onError?: ErrorPolicy;
  confirmBefore?: boolean;
  /** Body of a block step (If → "then", loops → body). */
  children?: Step[];
  /** "Else" branch of an If step. */
  elseChildren?: Step[];
}

export interface OpenUrlParams {
  url: string;
}
export interface NavigateParams {
  direction: 'back' | 'forward' | 'reload';
}
export interface ClickParams {
  locator: Locator;
}
export interface TypeParams {
  locator: Locator;
  text: string;
  clearFirst: boolean;
  pressEnter: boolean;
}
export interface ClearParams {
  locator: Locator;
}
export interface SelectParams {
  locator: Locator;
  by: 'value' | 'label' | 'index';
  value: string;
}
export interface CheckParams {
  locator: Locator;
  checked: boolean;
}
export type WaitMode = 'element' | 'elementHidden' | 'duration' | 'pageLoad' | 'urlContains' | 'textPresent';
export interface WaitParams {
  mode: WaitMode;
  locator?: Locator;
  durationMs?: number;
  value?: string;
}
export interface ExtractTextParams {
  locator: Locator;
  variable: string;
  all: boolean;
}
export interface CapturePageParams {
  what: 'url' | 'title';
  variable: string;
}
export interface ScrollParams {
  mode: 'element' | 'position' | 'top' | 'bottom';
  locator?: Locator;
  x?: number;
  y?: number;
}
export interface ScreenshotParams {
  label: string;
}
export interface ConfirmParams {
  message: string;
}
export interface CopyToClipboardParams {
  template: string;
}
export interface StopParams {
  outcome: 'failed' | 'succeeded';
  message: string;
}

export type ConditionKind = 'elementExists' | 'elementVisible' | 'elementMissing' | 'textPresent' | 'urlContains' | 'variable';
export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'greaterThan'
  | 'lessThan'
  | 'isEmpty'
  | 'isNotEmpty';

/** Flat so the editor can render it with the generic field forms. */
export interface ConditionParams {
  condition: ConditionKind;
  locator: Locator;
  value: string;
  variable: string;
  operator: ConditionOperator;
}
export type IfParams = ConditionParams;
export interface WhileParams extends ConditionParams {
  maxIterations: number;
  loopVariable: string;
}
export interface RepeatParams {
  times: number;
  loopVariable: string;
}
export interface ForEachElementParams {
  locator: Locator;
  loopVariable: string;
  maxItems: number;
}
export interface ForEachRowParams {
  loopVariable: string;
  maxRows: number;
}
export type EmptyParams = Record<string, never>;
export type SetVariableOperation =
  | 'set'
  | 'append'
  | 'increment'
  | 'slice'
  | 'regexExtract'
  | 'regexReplace'
  | 'trim'
  | 'upperCase'
  | 'lowerCase'
  | 'length';
export interface SetVariableParams {
  variable: string;
  operation: SetVariableOperation;
  value: string;
  pattern: string;
  replacement: string;
  start?: number;
  end?: number;
}
export interface TableColumn {
  name: string;
  value: string;
}
export interface AddRowParams {
  columns: TableColumn[];
}

export interface ActionParamsMap {
  openUrl: OpenUrlParams;
  navigate: NavigateParams;
  click: ClickParams;
  type: TypeParams;
  clear: ClearParams;
  select: SelectParams;
  check: CheckParams;
  wait: WaitParams;
  extractText: ExtractTextParams;
  capturePage: CapturePageParams;
  scroll: ScrollParams;
  screenshot: ScreenshotParams;
  confirm: ConfirmParams;
  copyToClipboard: CopyToClipboardParams;
  stop: StopParams;
  if: IfParams;
  repeat: RepeatParams;
  while: WhileParams;
  forEachElement: ForEachElementParams;
  forEachRow: ForEachRowParams;
  break: EmptyParams;
  continue: EmptyParams;
  setVariable: SetVariableParams;
  addRow: AddRowParams;
}

export type ActionType = keyof ActionParamsMap;

export type StepOf<T extends ActionType> = StepBase & { type: T; params: ActionParamsMap[T] };

export type Step = { [K in ActionType]: StepOf<K> }[ActionType];

export interface VariableDef {
  name: string;
  defaultValue: string;
  description?: string;
  askAtRunStart?: boolean;
  secret?: boolean;
}

export interface WorkflowSettings {
  defaultTimeoutMs: number;
  defaultRetries: number;
  defaultOnError: ErrorPolicy;
  stepDelayMs: number;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export const TERMINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed', 'stopped', 'interrupted'];

/** A workflow's input data (e.g. imported from CSV). Column names are valid variable names. */
export interface DataTable {
  columns: string[];
  rows: string[][];
}

export interface Workflow {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  tags: string[];
  favorite: boolean;
  variables: VariableDef[];
  settings: WorkflowSettings;
  steps: Step[];
  data?: DataTable;
  createdAt: number;
  updatedAt: number;
  lastRun?: { runId: string; status: RunStatus; finishedAt: number };
}

// ---------------------------------------------------------------------------
// Execution records

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface StepResult {
  stepId: string;
  status: StepStatus;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  /** Human-readable summary of what was verified. Never contains typed values. */
  message?: string;
  errorCode?: string;
  /** How many times the step ran (> 1 inside loops). */
  executions?: number;
}

/** One level of the execution position, used to resume nested runs. */
export interface CursorFrame {
  index: number;
  iteration?: number;
  branch?: 'then' | 'else';
}

export interface LogEntry {
  at: number;
  stepId: string;
  status: StepStatus;
  message: string;
  /** Loop position, e.g. "For each row #3". */
  context?: string;
}

export interface ResultsTable {
  columns: string[];
  rows: Record<string, string>[];
}

export interface ExtractedResult {
  stepId: string;
  stepIndex: number;
  variable: string;
  value: string;
  kind: 'text' | 'screenshot';
  /** For screenshots: id of the artifact in the artifacts store. */
  artifactId?: string;
}

export type PromptKind = 'confirm' | 'clipboard' | 'error' | 'confirmBefore';

export interface PendingPrompt {
  id: string;
  kind: PromptKind;
  stepId: string;
  stepIndex: number;
  message: string;
  /** For clipboard prompts: the text to copy. */
  text?: string;
  createdAt: number;
}

export type PromptResponse =
  | { action: 'continue' }
  | { action: 'cancel' }
  | { action: 'copied' }
  | { action: 'retry' }
  | { action: 'skip' }
  | { action: 'stop' };

export interface RunError {
  stepId?: string;
  /** Index of the top-level step containing the failure. */
  stepIndex?: number;
  code: string;
  message: string;
}

export type RunTarget = { kind: 'newTab' } | { kind: 'tab'; tabId: number };

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  /** Copy of the workflow as it was when the run started. */
  workflow: Workflow;
  status: RunStatus;
  mode: 'full' | 'testStep';
  target: RunTarget;
  tabId?: number;
  startedAt: number;
  finishedAt?: number;
  /** Index of the current top-level step. */
  currentStepIndex: number;
  currentStepId?: string;
  /** Full execution position (top level first); absent on records from schema v1. */
  cursor?: CursorFrame[];
  /** Results for every step in the tree, in document order. */
  steps: StepResult[];
  /** Variable values; values of secret variables are masked when persisted. */
  variables: Record<string, string>;
  results: ExtractedResult[];
  /** Rows added by "Add row" steps. */
  table?: ResultsTable;
  /** Most recent step events (capped). */
  log?: LogEntry[];
  pendingPrompt?: PendingPrompt;
  error?: RunError;
  summary?: string;
  resumedFrom?: string;
}
