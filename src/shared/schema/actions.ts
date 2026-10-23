import type { ActionParamsMap, ActionType, ConditionParams, Locator, Step, StepOf } from './types';
import { newId } from '../ids';

// The action catalogue drives the editor (palette, generated forms, step
// summaries) and the engine (navigation/settling behaviour). Adding an action
// means adding one entry here plus a handler in engine/handlers.ts.

export type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'locator' | 'variable' | 'columns';

export interface FieldDef<P> {
  key: keyof P & string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** Field supports {{variables}}. */
  templated?: boolean;
  showIf?: (params: P) => boolean;
}

export type ActionCategory = 'Navigation' | 'Interaction' | 'Waiting' | 'Data' | 'Logic' | 'Control';

export interface ActionDef<T extends ActionType> {
  type: T;
  label: string;
  description: string;
  category: ActionCategory;
  icon: string;
  defaults: () => ActionParamsMap[T];
  fields: FieldDef<ActionParamsMap[T]>[];
  summary: (params: ActionParamsMap[T]) => string;
  /** Action interacts with the page and needs host access. */
  needsPage: boolean;
  /** Action may trigger a navigation; the engine waits for the tab to settle. */
  mayNavigate: boolean;
  /** Block steps contain other steps. */
  block?: 'body' | 'ifElse';
}

const css = (value = ''): Locator => ({ strategy: 'css', value });

export function describeLocator(l?: Locator): string {
  if (!l || !l.value) return '(no target)';
  switch (l.strategy) {
    case 'css':
      return l.value;
    case 'text':
      return `text "${l.value}"`;
    case 'label':
      return `label "${l.value}"`;
    case 'xpath':
      return `xpath ${l.value}`;
  }
}

const truncate = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const OPERATOR_LABEL: Record<ConditionParams['operator'], string> = {
  equals: 'equals',
  notEquals: 'does not equal',
  contains: 'contains',
  notContains: 'does not contain',
  matches: 'matches regex',
  greaterThan: '>',
  lessThan: '<',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
};

export function describeCondition(p: ConditionParams): string {
  switch (p.condition) {
    case 'elementExists':
      return `${describeLocator(p.locator)} exists`;
    case 'elementVisible':
      return `${describeLocator(p.locator)} is visible`;
    case 'elementMissing':
      return `${describeLocator(p.locator)} is absent or hidden`;
    case 'textPresent':
      return `page shows "${truncate(p.value, 24)}"`;
    case 'urlContains':
      return `URL contains "${truncate(p.value, 24)}"`;
    case 'variable':
      return p.operator === 'isEmpty' || p.operator === 'isNotEmpty'
        ? `{{${p.variable}}} ${OPERATOR_LABEL[p.operator]}`
        : `{{${p.variable}}} ${OPERATOR_LABEL[p.operator]} "${truncate(p.value, 20)}"`;
  }
}

const conditionDefaults = (): ConditionParams => ({
  condition: 'elementExists',
  locator: { strategy: 'css', value: '' },
  value: '',
  variable: '',
  operator: 'equals',
});

function conditionFields<P extends ConditionParams>(): FieldDef<P>[] {
  const isElement = (p: P) => p.condition === 'elementExists' || p.condition === 'elementVisible' || p.condition === 'elementMissing';
  return [
    {
      key: 'condition',
      label: 'Condition',
      kind: 'select',
      options: [
        { value: 'elementExists', label: 'Element exists' },
        { value: 'elementVisible', label: 'Element is visible' },
        { value: 'elementMissing', label: 'Element is absent or hidden' },
        { value: 'textPresent', label: 'Page shows text' },
        { value: 'urlContains', label: 'URL contains' },
        { value: 'variable', label: 'Variable comparison' },
      ],
    },
    { key: 'locator', label: 'Element', kind: 'locator', showIf: isElement },
    { key: 'variable', label: 'Variable', kind: 'variable', showIf: (p) => p.condition === 'variable' },
    {
      key: 'operator',
      label: 'Operator',
      kind: 'select',
      showIf: (p) => p.condition === 'variable',
      options: (Object.keys(OPERATOR_LABEL) as ConditionParams['operator'][]).map((k) => ({ value: k, label: OPERATOR_LABEL[k] })),
    },
    {
      key: 'value',
      label: 'Value',
      kind: 'text',
      templated: true,
      showIf: (p) => p.condition === 'textPresent' || p.condition === 'urlContains' || (p.condition === 'variable' && p.operator !== 'isEmpty' && p.operator !== 'isNotEmpty'),
      help: 'For "matches regex", enter a regular expression.',
    },
  ];
}

const LOOP_VAR_HELP = 'Inside the loop, {{NAME_index}} is the iteration number (1, 2, 3…).';

type Catalogue = { [K in ActionType]: ActionDef<K> };

export const ACTIONS: Catalogue = {
  openUrl: {
    type: 'openUrl',
    label: 'Open URL',
    description: 'Load a web address in the run tab.',
    category: 'Navigation',
    icon: '🌐',
    defaults: () => ({ url: 'https://' }),
    fields: [{ key: 'url', label: 'URL', kind: 'text', required: true, templated: true, placeholder: 'https://example.com' }],
    summary: (p) => truncate(p.url || '(no URL)'),
    needsPage: true,
    mayNavigate: true,
  },
  navigate: {
    type: 'navigate',
    label: 'Back / Forward',
    description: 'Go back, forward or reload the page.',
    category: 'Navigation',
    icon: '↔',
    defaults: () => ({ direction: 'back' }),
    fields: [
      {
        key: 'direction',
        label: 'Direction',
        kind: 'select',
        options: [
          { value: 'back', label: 'Back' },
          { value: 'forward', label: 'Forward' },
          { value: 'reload', label: 'Reload' },
        ],
      },
    ],
    summary: (p) => ({ back: 'Go back', forward: 'Go forward', reload: 'Reload page' })[p.direction],
    needsPage: true,
    mayNavigate: true,
  },
  click: {
    type: 'click',
    label: 'Click',
    description: 'Click an element.',
    category: 'Interaction',
    icon: '👆',
    defaults: () => ({ locator: css() }),
    fields: [{ key: 'locator', label: 'Element', kind: 'locator', required: true }],
    summary: (p) => describeLocator(p.locator),
    needsPage: true,
    mayNavigate: true,
  },
  type: {
    type: 'type',
    label: 'Enter text',
    description: 'Type text into an input or text area.',
    category: 'Interaction',
    icon: '⌨',
    defaults: () => ({ locator: css(), text: '', clearFirst: true, pressEnter: false }),
    fields: [
      { key: 'locator', label: 'Field', kind: 'locator', required: true },
      { key: 'text', label: 'Text', kind: 'textarea', templated: true, help: 'Use {{variable}} to insert values. Typed text is never written to run logs.' },
      { key: 'clearFirst', label: 'Clear existing value first', kind: 'checkbox' },
      { key: 'pressEnter', label: 'Press Enter afterwards', kind: 'checkbox', help: 'May submit the form.' },
    ],
    summary: (p) => `${describeLocator(p.locator)}${p.pressEnter ? ' ⏎' : ''}`,
    needsPage: true,
    mayNavigate: true,
  },
  clear: {
    type: 'clear',
    label: 'Clear field',
    description: 'Empty an input or text area.',
    category: 'Interaction',
    icon: '⌫',
    defaults: () => ({ locator: css() }),
    fields: [{ key: 'locator', label: 'Field', kind: 'locator', required: true }],
    summary: (p) => describeLocator(p.locator),
    needsPage: true,
    mayNavigate: false,
  },
  select: {
    type: 'select',
    label: 'Select option',
    description: 'Choose an option in a dropdown.',
    category: 'Interaction',
    icon: '☰',
    defaults: () => ({ locator: css(), by: 'label', value: '' }),
    fields: [
      { key: 'locator', label: 'Dropdown', kind: 'locator', required: true },
      {
        key: 'by',
        label: 'Match option by',
        kind: 'select',
        options: [
          { value: 'label', label: 'Visible label' },
          { value: 'value', label: 'Value attribute' },
          { value: 'index', label: 'Position (0-based)' },
        ],
      },
      { key: 'value', label: 'Option', kind: 'text', required: true, templated: true },
    ],
    summary: (p) => `${describeLocator(p.locator)} → ${truncate(p.value || '?', 24)}`,
    needsPage: true,
    mayNavigate: false,
  },
  check: {
    type: 'check',
    label: 'Check / uncheck',
    description: 'Set a checkbox or radio button.',
    category: 'Interaction',
    icon: '☑',
    defaults: () => ({ locator: css(), checked: true }),
    fields: [
      { key: 'locator', label: 'Checkbox', kind: 'locator', required: true },
      { key: 'checked', label: 'Should be checked', kind: 'checkbox' },
    ],
    summary: (p) => `${p.checked ? 'Check' : 'Uncheck'} ${describeLocator(p.locator)}`,
    needsPage: true,
    mayNavigate: false,
  },
  wait: {
    type: 'wait',
    label: 'Wait',
    description: 'Wait for an element, a page condition or a fixed time.',
    category: 'Waiting',
    icon: '⏱',
    defaults: () => ({ mode: 'element', locator: css(), durationMs: 1000, value: '' }),
    fields: [
      {
        key: 'mode',
        label: 'Wait for',
        kind: 'select',
        options: [
          { value: 'element', label: 'Element to appear' },
          { value: 'elementHidden', label: 'Element to disappear' },
          { value: 'textPresent', label: 'Text to appear on page' },
          { value: 'urlContains', label: 'URL to contain' },
          { value: 'pageLoad', label: 'Page to finish loading' },
          { value: 'duration', label: 'Fixed duration' },
        ],
      },
      { key: 'locator', label: 'Element', kind: 'locator', showIf: (p) => p.mode === 'element' || p.mode === 'elementHidden' },
      { key: 'value', label: 'Text', kind: 'text', templated: true, showIf: (p) => p.mode === 'textPresent' || p.mode === 'urlContains' },
      { key: 'durationMs', label: 'Duration (ms)', kind: 'number', showIf: (p) => p.mode === 'duration' },
    ],
    summary: (p) => {
      switch (p.mode) {
        case 'element':
          return `until ${describeLocator(p.locator)} appears`;
        case 'elementHidden':
          return `until ${describeLocator(p.locator)} disappears`;
        case 'textPresent':
          return `until text "${truncate(p.value ?? '', 24)}" appears`;
        case 'urlContains':
          return `until URL contains "${truncate(p.value ?? '', 24)}"`;
        case 'pageLoad':
          return 'until page has loaded';
        case 'duration':
          return `${p.durationMs ?? 0} ms`;
      }
    },
    needsPage: true,
    mayNavigate: false,
  },
  extractText: {
    type: 'extractText',
    label: 'Extract text',
    description: 'Save the visible text of an element into a variable.',
    category: 'Data',
    icon: '⇲',
    defaults: () => ({ locator: css(), variable: 'text', all: false }),
    fields: [
      { key: 'locator', label: 'Element', kind: 'locator', required: true },
      { key: 'variable', label: 'Save as variable', kind: 'variable', required: true },
      { key: 'all', label: 'All matching elements (one per line)', kind: 'checkbox' },
    ],
    summary: (p) => `${describeLocator(p.locator)} → {{${p.variable}}}`,
    needsPage: true,
    mayNavigate: false,
  },
  capturePage: {
    type: 'capturePage',
    label: 'Capture URL / title',
    description: 'Save the current page URL or title into a variable.',
    category: 'Data',
    icon: '🔖',
    defaults: () => ({ what: 'url', variable: 'pageUrl' }),
    fields: [
      {
        key: 'what',
        label: 'Capture',
        kind: 'select',
        options: [
          { value: 'url', label: 'Current URL' },
          { value: 'title', label: 'Page title' },
        ],
      },
      { key: 'variable', label: 'Save as variable', kind: 'variable', required: true },
    ],
    summary: (p) => `${p.what === 'url' ? 'URL' : 'Title'} → {{${p.variable}}}`,
    needsPage: true,
    mayNavigate: false,
  },
  scroll: {
    type: 'scroll',
    label: 'Scroll',
    description: 'Scroll to an element or a page position.',
    category: 'Interaction',
    icon: '↕',
    defaults: () => ({ mode: 'element', locator: css(), x: 0, y: 0 }),
    fields: [
      {
        key: 'mode',
        label: 'Scroll to',
        kind: 'select',
        options: [
          { value: 'element', label: 'Element' },
          { value: 'position', label: 'Position (pixels)' },
          { value: 'top', label: 'Top of page' },
          { value: 'bottom', label: 'Bottom of page' },
        ],
      },
      { key: 'locator', label: 'Element', kind: 'locator', showIf: (p) => p.mode === 'element' },
      { key: 'x', label: 'X (px)', kind: 'number', showIf: (p) => p.mode === 'position' },
      { key: 'y', label: 'Y (px)', kind: 'number', showIf: (p) => p.mode === 'position' },
    ],
    summary: (p) =>
      p.mode === 'element' ? describeLocator(p.locator) : p.mode === 'position' ? `${p.x ?? 0}, ${p.y ?? 0}` : p.mode,
    needsPage: true,
    mayNavigate: false,
  },
  screenshot: {
    type: 'screenshot',
    label: 'Screenshot',
    description: 'Capture the visible part of the run tab (stored locally).',
    category: 'Data',
    icon: '📷',
    defaults: () => ({ label: 'screenshot' }),
    fields: [{ key: 'label', label: 'Label', kind: 'text', help: 'Requires access to all sites, or a run started from the toolbar popup.' }],
    summary: (p) => p.label || 'screenshot',
    needsPage: true,
    mayNavigate: false,
  },
  confirm: {
    type: 'confirm',
    label: 'Ask to continue',
    description: 'Pause and ask for confirmation before continuing.',
    category: 'Control',
    icon: '✋',
    defaults: () => ({ message: 'Continue?' }),
    fields: [{ key: 'message', label: 'Message', kind: 'textarea', templated: true, required: true }],
    summary: (p) => truncate(p.message || ''),
    needsPage: false,
    mayNavigate: false,
  },
  copyToClipboard: {
    type: 'copyToClipboard',
    label: 'Copy to clipboard',
    description: 'Offer text (e.g. extracted results) for you to copy with one click.',
    category: 'Data',
    icon: '📋',
    defaults: () => ({ template: '{{text}}' }),
    fields: [
      {
        key: 'template',
        label: 'Text to copy',
        kind: 'textarea',
        templated: true,
        required: true,
        help: 'The run pauses until you press Copy — browsers only allow clipboard writes after a user action.',
      },
    ],
    summary: (p) => truncate(p.template || ''),
    needsPage: false,
    mayNavigate: false,
  },
  stop: {
    type: 'stop',
    label: 'Stop run',
    description: 'End the run here and report an outcome.',
    category: 'Control',
    icon: '■',
    defaults: () => ({ outcome: 'failed', message: 'Stopped by workflow' }),
    fields: [
      {
        key: 'outcome',
        label: 'Report run as',
        kind: 'select',
        options: [
          { value: 'failed', label: 'Failed (error)' },
          { value: 'succeeded', label: 'Succeeded' },
        ],
      },
      { key: 'message', label: 'Message', kind: 'textarea', templated: true },
    ],
    summary: (p) => `${p.outcome === 'failed' ? 'Fail' : 'Succeed'}: ${truncate(p.message || '', 36)}`,
    needsPage: false,
    mayNavigate: false,
  },
  if: {
    type: 'if',
    label: 'If / Else',
    description: 'Run steps only when a condition is true, otherwise run the Else steps.',
    category: 'Logic',
    icon: '⑂',
    defaults: conditionDefaults,
    fields: conditionFields(),
    summary: (p) => `if ${describeCondition(p)}`,
    needsPage: true,
    mayNavigate: false,
    block: 'ifElse',
  },
  repeat: {
    type: 'repeat',
    label: 'Repeat',
    description: 'Run the steps inside a fixed number of times.',
    category: 'Logic',
    icon: '↻',
    defaults: () => ({ times: 3, loopVariable: 'loop' }),
    fields: [
      { key: 'times', label: 'Times', kind: 'number', required: true },
      { key: 'loopVariable', label: 'Loop name', kind: 'variable', help: LOOP_VAR_HELP },
    ],
    summary: (p) => `${p.times} times`,
    needsPage: false,
    mayNavigate: false,
    block: 'body',
  },
  while: {
    type: 'while',
    label: 'While',
    description: 'Repeat the steps inside while a condition is true (with a safety limit).',
    category: 'Logic',
    icon: '⟳',
    defaults: () => ({ ...conditionDefaults(), maxIterations: 100, loopVariable: 'loop' }),
    fields: [
      ...conditionFields<ActionParamsMap['while']>(),
      { key: 'maxIterations', label: 'Stop after at most (iterations)', kind: 'number', required: true },
      { key: 'loopVariable', label: 'Loop name', kind: 'variable', help: LOOP_VAR_HELP },
    ],
    summary: (p) => `while ${describeCondition(p)} (max ${p.maxIterations})`,
    needsPage: true,
    mayNavigate: false,
    block: 'body',
  },
  forEachElement: {
    type: 'forEachElement',
    label: 'For each element',
    description: 'Run the steps inside once for every element matching a target (e.g. list items, table rows).',
    category: 'Logic',
    icon: '⋮',
    defaults: () => ({ locator: { strategy: 'css', value: '' }, loopVariable: 'item', maxItems: 100 }),
    fields: [
      { key: 'locator', label: 'Elements', kind: 'locator', required: true },
      {
        key: 'loopVariable',
        label: 'Loop name',
        kind: 'variable',
        help: 'Inside the loop: {{NAME}} is the element’s text, {{NAME_selector}} targets it (use it as a CSS target, e.g. “{{NAME_selector}} a”), {{NAME_index}} is its number.',
      },
      { key: 'maxItems', label: 'At most (elements)', kind: 'number', required: true },
    ],
    summary: (p) => `${describeLocator(p.locator)} as {{${p.loopVariable}}}`,
    needsPage: true,
    mayNavigate: false,
    block: 'body',
  },
  forEachRow: {
    type: 'forEachRow',
    label: 'For each data row',
    description: 'Run the steps inside once per row of the workflow’s data table (e.g. an imported CSV).',
    category: 'Logic',
    icon: '▦',
    defaults: () => ({ loopVariable: 'row', maxRows: 1000 }),
    fields: [
      {
        key: 'loopVariable',
        label: 'Loop name',
        kind: 'variable',
        help: 'Inside the loop each column is {{NAME_column}} (e.g. {{row_email}}), and {{NAME_index}} is the row number. Edit the data on the Data tab.',
      },
      { key: 'maxRows', label: 'At most (rows)', kind: 'number', required: true },
    ],
    summary: (p) => `data rows as {{${p.loopVariable}_…}}`,
    needsPage: false,
    mayNavigate: false,
    block: 'body',
  },
  break: {
    type: 'break',
    label: 'Break loop',
    description: 'Leave the innermost loop immediately.',
    category: 'Logic',
    icon: '⤓',
    defaults: () => ({}),
    fields: [],
    summary: () => 'exit the loop',
    needsPage: false,
    mayNavigate: false,
  },
  continue: {
    type: 'continue',
    label: 'Next iteration',
    description: 'Skip the rest of this loop iteration and continue with the next one.',
    category: 'Logic',
    icon: '↷',
    defaults: () => ({}),
    fields: [],
    summary: () => 'skip to the next iteration',
    needsPage: false,
    mayNavigate: false,
  },
  setVariable: {
    type: 'setVariable',
    label: 'Set variable',
    description: 'Set or transform a variable: increment, append, slice, regex extract/replace, trim, case.',
    category: 'Data',
    icon: '𝑥',
    defaults: () => ({ variable: 'value', operation: 'set', value: '', pattern: '', replacement: '' }),
    fields: [
      { key: 'variable', label: 'Variable', kind: 'variable', required: true },
      {
        key: 'operation',
        label: 'Operation',
        kind: 'select',
        options: [
          { value: 'set', label: 'Set to' },
          { value: 'append', label: 'Append' },
          { value: 'increment', label: 'Add a number (use negative to subtract)' },
          { value: 'slice', label: 'Keep characters from … to …' },
          { value: 'regexExtract', label: 'Extract with regex' },
          { value: 'regexReplace', label: 'Replace with regex' },
          { value: 'trim', label: 'Trim whitespace' },
          { value: 'upperCase', label: 'UPPER CASE' },
          { value: 'lowerCase', label: 'lower case' },
          { value: 'length', label: 'Length (number of characters)' },
        ],
      },
      {
        key: 'value',
        label: 'Value',
        kind: 'text',
        templated: true,
        showIf: (p) => p.operation === 'set' || p.operation === 'append' || p.operation === 'increment',
        help: 'For “Add a number”, the amount to add (default 1).',
      },
      { key: 'start', label: 'From (0-based, negative counts from the end)', kind: 'number', showIf: (p) => p.operation === 'slice' },
      { key: 'end', label: 'To (exclusive, empty = end)', kind: 'number', showIf: (p) => p.operation === 'slice' },
      { key: 'pattern', label: 'Regular expression', kind: 'text', showIf: (p) => p.operation === 'regexExtract' || p.operation === 'regexReplace', help: 'Case-insensitive. For extract, the first capture group is used if present.' },
      { key: 'replacement', label: 'Replace with', kind: 'text', templated: true, showIf: (p) => p.operation === 'regexReplace', help: 'Use $1, $2… for capture groups.' },
    ],
    summary: (p) =>
      ({
        set: `{{${p.variable}}} = "${truncate(p.value, 24)}"`,
        append: `{{${p.variable}}} += "${truncate(p.value, 24)}"`,
        increment: `{{${p.variable}}} + ${p.value || 1}`,
        slice: `{{${p.variable}}} [${p.start ?? 0}:${p.end ?? ''}]`,
        regexExtract: `{{${p.variable}}} ← /${truncate(p.pattern, 20)}/`,
        regexReplace: `{{${p.variable}}} /${truncate(p.pattern, 16)}/ → "${truncate(p.replacement, 12)}"`,
        trim: `trim {{${p.variable}}}`,
        upperCase: `upper-case {{${p.variable}}}`,
        lowerCase: `lower-case {{${p.variable}}}`,
        length: `length of {{${p.variable}}}`,
      })[p.operation],
    needsPage: false,
    mayNavigate: false,
  },
  addRow: {
    type: 'addRow',
    label: 'Add row to results',
    description: 'Append a row to the run’s results table (exportable as CSV / JSON).',
    category: 'Data',
    icon: '⊞',
    defaults: () => ({ columns: [{ name: 'value', value: '' }] }),
    fields: [{ key: 'columns', label: 'Columns', kind: 'columns', required: true, help: 'Values can use {{variables}}.' }],
    summary: (p) => p.columns.map((c) => c.name || '?').join(', ') || '(no columns)',
    needsPage: false,
    mayNavigate: false,
  },
};

export const ACTION_TYPES = Object.keys(ACTIONS) as ActionType[];

export function actionDef<T extends ActionType>(type: T): ActionDef<T> {
  return ACTIONS[type] as ActionDef<T>;
}

export function createStep<T extends ActionType>(type: T, overrides: Partial<StepOf<T>> = {}): StepOf<T> {
  const def = actionDef(type);
  const blocks = def.block === 'ifElse' ? { children: [], elseChildren: [] } : def.block === 'body' ? { children: [] } : {};
  return { id: newId('s'), type, params: def.defaults(), ...blocks, ...overrides } as StepOf<T>;
}

export function stepTitle(step: Step): string {
  return step.name?.trim() || actionDef(step.type).label;
}

export function stepSummary(step: Step): string {
  return (actionDef(step.type).summary as (p: unknown) => string)(step.params);
}

export function stepLocator(step: Step): Locator | undefined {
  const p = step.params as { locator?: Locator };
  return p.locator;
}
