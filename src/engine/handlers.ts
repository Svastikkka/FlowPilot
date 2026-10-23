import type { ActionParamsMap, ActionType, ConditionParams, DataTable, ExtractedResult, Locator, PromptKind, PromptResponse } from '../shared/schema/types';
import type { DomRequest, DomResult, ProbeResult } from '../shared/messages';
import type { BrowserDriver } from './driver';
import { describeCondition, describeLocator } from '../shared/schema/actions';
import { applySetVariable, compareValues } from '../shared/dataOps';
import { checkUrl } from '../shared/schema/validate';
import { FlowError } from '../shared/errors';

// One handler per action type. Handlers report only what they verified.

export interface ActionContext {
  tabId: number;
  driver: BrowserDriver;
  signal: AbortSignal;
  timeoutMs: number;
  /** Absolute time (clock.now()) after which the attempt has timed out. */
  deadline: number;
  highlight: boolean;
  stepId: string;
  stepIndex: number;
  /** 0-based iteration, when evaluating a loop step. */
  iteration: number;
  /** The run's data table (For each data row). */
  dataTable?: DataTable;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Interpolates {{variables}}; throws MISSING_VARIABLE for unknown names. */
  resolve(template: string): string;
  resolveLocator(locator: Locator): Locator;
  setVariable(name: string, value: string): void;
  getVariable(name: string): string | undefined;
  addTableRow(row: Record<string, string>): number;
  addResult(result: Omit<ExtractedResult, 'stepId' | 'stepIndex'>): void;
  prompt(kind: PromptKind, message: string, text?: string): Promise<PromptResponse>;
  saveArtifact(dataUrl: string, label: string): Promise<string>;
  /** Polls until the element satisfies the requirements or the deadline passes. */
  waitForElement(locator: Locator, require: { visible?: boolean; enabled?: boolean }): Promise<ProbeResult>;
  /** Polls a condition until it returns true or the deadline passes. */
  pollUntil(check: () => Promise<boolean>, describe: () => string): Promise<void>;
  dom<R extends DomRequest>(request: R): Promise<DomResult<R['op']>>;
}

export interface StepOutcome {
  message: string;
  /** Set by the stop action. */
  stopRun?: { outcome: 'succeeded' | 'failed'; message: string };
  /** If: which branch to take. Loops: whether to run another iteration. */
  conditionMet?: boolean;
  /** Loop variables to set before running the loop body. */
  bindings?: Record<string, string>;
}

export type ActionHandler<T extends ActionType> = (ctx: ActionContext, params: ActionParamsMap[T]) => Promise<StepOutcome>;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

async function interact<T extends Exclude<DomRequest['op'], 'probe' | 'pageInfo' | 'textPresent' | 'extractText' | 'scroll'>>(
  ctx: ActionContext,
  locator: Locator,
  build: (resolved: Locator) => Extract<DomRequest, { op: T }>,
  requireVisible = true,
): Promise<StepOutcome> {
  const resolved = ctx.resolveLocator(locator);
  await ctx.waitForElement(resolved, { visible: requireVisible, enabled: true });
  const result = (await ctx.dom(build(resolved))) as { message: string };
  return { message: result.message };
}

async function evaluateCondition(ctx: ActionContext, p: ConditionParams): Promise<{ met: boolean; description: string }> {
  switch (p.condition) {
    case 'elementExists':
    case 'elementVisible':
    case 'elementMissing': {
      const locator = ctx.resolveLocator(p.locator);
      const r = await ctx.dom({ op: 'probe', locator });
      const shown = r.count > 0 && r.visible;
      const met = p.condition === 'elementExists' ? r.count > 0 : p.condition === 'elementVisible' ? shown : !shown;
      return { met, description: describeCondition({ ...p, locator }) };
    }
    case 'textPresent': {
      const text = ctx.resolve(p.value);
      return { met: (await ctx.dom({ op: 'textPresent', text })).present, description: describeCondition({ ...p, value: text }) };
    }
    case 'urlContains': {
      const text = ctx.resolve(p.value);
      return { met: (await ctx.dom({ op: 'pageInfo' })).url.includes(text), description: describeCondition({ ...p, value: text }) };
    }
    case 'variable': {
      const value = ctx.resolve(p.value);
      return { met: compareValues(ctx.getVariable(p.variable) ?? '', p.operator, value), description: describeCondition({ ...p, value }) };
    }
  }
}

const iterationLabel = (n: number) => `iteration ${n}`;

export const HANDLERS: { [K in ActionType]: ActionHandler<K> } = {
  async openUrl(ctx, p) {
    const url = ctx.resolve(p.url).trim();
    const problem = checkUrl(url);
    if (problem) throw new FlowError('INVALID_URL', `${problem}: ${url.slice(0, 120)}`, true);
    await ctx.driver.navigate(ctx.tabId, url, ctx.timeoutMs, ctx.signal);
    const info = await ctx.dom({ op: 'pageInfo' });
    return { message: `Loaded ${info.url}` };
  },

  async navigate(ctx, p) {
    await ctx.driver.history(ctx.tabId, p.direction, ctx.timeoutMs, ctx.signal);
    const info = await ctx.dom({ op: 'pageInfo' });
    const verb = { back: 'Went back', forward: 'Went forward', reload: 'Reloaded' }[p.direction];
    return { message: `${verb} — now at ${info.url}` };
  },

  click: (ctx, p) => interact(ctx, p.locator, (locator) => ({ op: 'click', locator, highlight: ctx.highlight })),

  type: (ctx, p) =>
    interact(ctx, p.locator, (locator) => ({
      op: 'type',
      locator,
      text: ctx.resolve(p.text),
      clearFirst: p.clearFirst,
      pressEnter: p.pressEnter,
      highlight: ctx.highlight,
    })),

  clear: (ctx, p) => interact(ctx, p.locator, (locator) => ({ op: 'clear', locator, highlight: ctx.highlight })),

  select: (ctx, p) =>
    interact(ctx, p.locator, (locator) => ({ op: 'select', locator, by: p.by, value: ctx.resolve(p.value), highlight: ctx.highlight })),

  // Custom checkboxes are often visually hidden behind a styled label.
  check: (ctx, p) =>
    interact(ctx, p.locator, (locator) => ({ op: 'check', locator, checked: p.checked, highlight: ctx.highlight }), false),

  async wait(ctx, p) {
    switch (p.mode) {
      case 'duration': {
        const ms = p.durationMs ?? 0;
        await ctx.sleep(ms);
        return { message: `Waited ${seconds(ms)}` };
      }
      case 'element': {
        const locator = ctx.resolveLocator(p.locator!);
        await ctx.waitForElement(locator, { visible: true });
        return { message: `${describeLocator(locator)} is visible` };
      }
      case 'elementHidden': {
        const locator = ctx.resolveLocator(p.locator!);
        await ctx.pollUntil(
          async () => {
            const r = await ctx.dom({ op: 'probe', locator });
            return r.count === 0 || !r.visible;
          },
          () => `${describeLocator(locator)} is still visible`,
        );
        return { message: `${describeLocator(locator)} is gone` };
      }
      case 'textPresent': {
        const text = ctx.resolve(p.value ?? '');
        await ctx.pollUntil(
          async () => (await ctx.dom({ op: 'textPresent', text })).present,
          () => `Text "${text}" did not appear on the page`,
        );
        return { message: `Found text "${text}"` };
      }
      case 'urlContains': {
        const text = ctx.resolve(p.value ?? '');
        let last = '';
        await ctx.pollUntil(
          async () => {
            last = (await ctx.dom({ op: 'pageInfo' })).url;
            return last.includes(text);
          },
          () => `URL never contained "${text}" (last: ${last})`,
        );
        return { message: `URL contains "${text}"` };
      }
      case 'pageLoad': {
        await ctx.driver.waitForSettle(ctx.tabId, Math.max(0, ctx.deadline - ctx.now()), ctx.signal);
        await ctx.pollUntil(
          async () => (await ctx.dom({ op: 'pageInfo' })).readyState === 'complete',
          () => 'Page did not finish loading',
        );
        return { message: 'Page finished loading' };
      }
    }
  },

  async extractText(ctx, p) {
    const locator = ctx.resolveLocator(p.locator);
    await ctx.waitForElement(locator, { visible: true });
    const { text, count } = await ctx.dom({ op: 'extractText', locator, all: p.all });
    ctx.setVariable(p.variable, text);
    ctx.addResult({ variable: p.variable, value: text, kind: 'text' });
    const preview = text.length > 60 ? `${text.slice(0, 59)}…` : text;
    return { message: `Saved ${p.all ? `${count} item${count === 1 ? '' : 's'}` : `"${preview}"`} to {{${p.variable}}}` };
  },

  async capturePage(ctx, p) {
    const info = await ctx.dom({ op: 'pageInfo' });
    const value = p.what === 'url' ? info.url : info.title;
    ctx.setVariable(p.variable, value);
    ctx.addResult({ variable: p.variable, value, kind: 'text' });
    return { message: `Saved page ${p.what} to {{${p.variable}}}` };
  },

  async scroll(ctx, p) {
    let locator: Locator | undefined;
    if (p.mode === 'element') {
      locator = ctx.resolveLocator(p.locator!);
      await ctx.waitForElement(locator, {});
    }
    const r = await ctx.dom({ op: 'scroll', mode: p.mode, locator, x: p.x, y: p.y });
    return { message: r.message };
  },

  async screenshot(ctx, p) {
    const dataUrl = await ctx.driver.screenshot(ctx.tabId);
    const label = ctx.resolve(p.label || 'screenshot');
    const artifactId = await ctx.saveArtifact(dataUrl, label);
    ctx.addResult({ variable: label, value: label, kind: 'screenshot', artifactId });
    return { message: `Captured screenshot "${label}" (stored locally)` };
  },

  async confirm(ctx, p) {
    const response = await ctx.prompt('confirm', ctx.resolve(p.message));
    if (response.action !== 'continue') throw new FlowError('USER_CANCELLED', 'You chose not to continue', true);
    return { message: 'You confirmed' };
  },

  async copyToClipboard(ctx, p) {
    const text = ctx.resolve(p.template);
    const response = await ctx.prompt('clipboard', 'Copy the result to your clipboard', text);
    if (response.action !== 'copied') throw new FlowError('USER_CANCELLED', 'Copy was cancelled', true);
    return { message: `Copied ${text.length} characters to the clipboard` };
  },

  async stop(ctx, p) {
    const message = ctx.resolve(p.message || 'Stopped by workflow');
    return { message, stopRun: { outcome: p.outcome, message } };
  },
  async if(ctx, p) {
    const { met, description } = await evaluateCondition(ctx, p);
    return { conditionMet: met, message: `${met ? 'True' : 'False'}: ${description} → ${met ? 'Then' : 'Else'}` };
  },

  async repeat(ctx, p) {
    const met = ctx.iteration < p.times;
    return {
      conditionMet: met,
      message: met ? `Starting ${iterationLabel(ctx.iteration + 1)} of ${p.times}` : '',
      bindings: met ? { [`${p.loopVariable}_index`]: String(ctx.iteration + 1) } : undefined,
    };
  },

  async while(ctx, p) {
    if (ctx.iteration >= p.maxIterations) return { conditionMet: false, message: `Stopped at the limit of ${p.maxIterations} iterations` };
    const { met, description } = await evaluateCondition(ctx, p);
    return {
      conditionMet: met,
      message: met ? `True: ${description}` : `Condition no longer true: ${description}`,
      bindings: met ? { [`${p.loopVariable}_index`]: String(ctx.iteration + 1) } : undefined,
    };
  },

  async forEachElement(ctx, p) {
    if (ctx.iteration >= p.maxItems) return { conditionMet: false, message: `Stopped at the limit of ${p.maxItems} elements` };
    const locator = ctx.resolveLocator(p.locator);
    const r = await ctx.dom({ op: 'markNth', locator, index: ctx.iteration, mark: ctx.stepId });
    if (!r.found) {
      return { conditionMet: false, message: ctx.iteration === 0 ? `No elements match ${describeLocator(locator)}` : '' };
    }
    const v = p.loopVariable;
    return {
      conditionMet: true,
      message: `Element ${ctx.iteration + 1} of ${r.total}`,
      bindings: { [v]: r.text, [`${v}_selector`]: `[data-flowpilot-item="${ctx.stepId.replace(/[^A-Za-z0-9_-]/g, '')}"]`, [`${v}_index`]: String(ctx.iteration + 1) },
    };
  },

  async forEachRow(ctx, p) {
    const table = ctx.dataTable ?? { columns: [], rows: [] };
    const limit = Math.min(p.maxRows, table.rows.length);
    if (ctx.iteration >= limit) {
      return { conditionMet: false, message: table.rows.length === 0 ? 'The data table is empty' : limit < table.rows.length ? `Stopped at the limit of ${limit} rows` : '' };
    }
    const row = table.rows[ctx.iteration];
    const bindings: Record<string, string> = { [`${p.loopVariable}_index`]: String(ctx.iteration + 1) };
    table.columns.forEach((c, i) => (bindings[`${p.loopVariable}_${c}`] = row[i] ?? ''));
    return { conditionMet: true, message: `Row ${ctx.iteration + 1} of ${limit}`, bindings };
  },

  // Break / continue are handled by the runner; these only describe them.
  break: async () => ({ message: 'Left the loop' }),
  continue: async () => ({ message: 'Skipped to the next iteration' }),

  async setVariable(ctx, p) {
    const value = applySetVariable(ctx.getVariable(p.variable) ?? '', {
      operation: p.operation,
      pattern: p.pattern,
      start: p.start,
      end: p.end,
      value: ['set', 'append', 'increment'].includes(p.operation) ? ctx.resolve(p.value) : '',
      replacement: p.operation === 'regexReplace' ? ctx.resolve(p.replacement) : '',
    });
    ctx.setVariable(p.variable, value);
    const preview = value.length > 60 ? `${value.slice(0, 59)}…` : value;
    return { message: `{{${p.variable}}} = "${preview}"` };
  },

  async addRow(ctx, p) {
    const row: Record<string, string> = {};
    for (const c of p.columns) row[c.name] = ctx.resolve(c.value);
    const count = ctx.addTableRow(row);
    return { message: `Added row ${count} (${p.columns.map((c) => c.name).join(', ')})` };
  },
};
