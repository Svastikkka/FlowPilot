import type {
  CursorFrame,
  ExtractedResult,
  LogEntry,
  PendingPrompt,
  PromptKind,
  PromptResponse,
  RunRecord,
  RunStatus,
  RunTarget,
  Step,
  StepResult,
  Workflow,
} from '../shared/schema/types';
import type { ProbeResult } from '../shared/messages';
import { FlowError, toFlowError } from '../shared/errors';
import { builtinValues, interpolate, MissingVariableError } from '../shared/interpolate';
import { actionDef, describeLocator, stepSummary, stepTitle } from '../shared/schema/actions';
import { flatten, isLoop, stepNumbers } from '../shared/schema/tree';
import { LIMITS } from '../shared/schema/zod';
import { newId } from '../shared/ids';
import { abortError, DEFAULT_ENGINE_OPTIONS, realClock } from './driver';
import type { BrowserDriver, Clock, EngineOptions, RunPersistence } from './driver';
import { HANDLERS } from './handlers';
import type { ActionContext, ActionHandler, StepOutcome } from './handlers';

export const SECRET_MASK = '••••••';

/** Grace period so polling helpers report a descriptive error before the hard timeout fires. */
const HARD_TIMEOUT_GRACE_MS = 1_500;

/** Actions that wait for the user and therefore have no timeout or retries. */
const INTERACTIVE = new Set<Step['type']>(['confirm', 'copyToClipboard']);

/** Errors that retrying cannot fix. */
const NON_RETRYABLE = new Set([
  'PERMISSION_DENIED',
  'RESTRICTED_PAGE',
  'TAB_CLOSED',
  'INVALID_SELECTOR',
  'MISSING_VARIABLE',
  'USER_CANCELLED',
  'INVALID_VALUE',
  'LIMIT_EXCEEDED',
]);

const MAX_LOG_ENTRIES = 500;

/**
 * Snapshots (persist + broadcast) are throttled so tight loops don't flood
 * IndexedDB or the UI. Status changes, prompts and the final state are always
 * written immediately; otherwise at most one snapshot per interval.
 */
const SNAPSHOT_INTERVAL_MS = 100;

export interface RunnerDeps {
  driver: BrowserDriver;
  persistence: RunPersistence;
  clock?: Clock;
  options?: Partial<EngineOptions>;
  /** Called with a (secret-masked) copy of the record after every change. */
  onUpdate?: (run: RunRecord) => void;
  /** Called when the run starts waiting for the user. */
  onPrompt?: (run: RunRecord) => void;
}

export interface CreateRunOptions {
  mode?: RunRecord['mode'];
  target: RunTarget;
  now?: number;
  id?: string;
}

export function createRunRecord(workflow: Workflow, opts: CreateRunOptions): RunRecord {
  return {
    id: opts.id ?? newId('run'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflow: structuredClone(workflow),
    status: 'queued',
    mode: opts.mode ?? 'full',
    target: opts.target,
    startedAt: opts.now ?? Date.now(),
    currentStepIndex: 0,
    steps: flatten(workflow.steps).map((s) => ({ stepId: s.id, status: 'pending', attempts: 0 })),
    variables: {},
    results: [],
  };
}

/** Initial variable values: defaults overridden by run-start inputs. */
export function initialVariables(workflow: Workflow, inputs: Record<string, string> = {}): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const v of workflow.variables) vars[v.name] = Object.prototype.hasOwnProperty.call(inputs, v.name) ? inputs[v.name] : v.defaultValue;
  return vars;
}

class StepFailure extends Error {
  constructor(public readonly error: FlowError, public readonly stepId: string) {
    super(error.message);
  }
}

/** Control-flow signals that unwind nested blocks. */
type Signal = { kind: 'break' } | { kind: 'continue' } | { kind: 'stop'; outcome: 'succeeded' | 'failed'; message: string; stepId: string };

export class WorkflowRunner {
  private readonly run: RunRecord;
  private readonly vars: Record<string, string>;
  private readonly secrets: Set<string>;
  private readonly abort = new AbortController();
  private readonly clock: Clock;
  private readonly options: EngineOptions;
  private readonly numbers: Map<string, string>;
  private pauseRequested = false;
  private resumeWaiter?: () => void;
  private promptWaiter?: { id: string; resolve: (r: PromptResponse) => void };
  private saveChain: Promise<void> = Promise.resolve();
  /** Current execution position, one frame per nesting level. */
  private stack: CursorFrame[] = [];
  /** Steps on the current path, parallel to `stack`. */
  private path: Step[] = [];
  /** Position to fast-forward to when resuming an interrupted run. */
  private resumeCursor: CursorFrame[] | null = null;
  private executions = 0;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | undefined;
  private emittedStatus: RunStatus | undefined;
  private emittedPromptId: string | undefined;

  constructor(run: RunRecord, variables: Record<string, string>, private readonly deps: RunnerDeps) {
    this.run = structuredClone(run);
    this.vars = { ...variables };
    this.secrets = new Set(run.workflow.variables.filter((v) => v.secret).map((v) => v.name));
    this.clock = deps.clock ?? realClock;
    this.options = { ...DEFAULT_ENGINE_OPTIONS, ...deps.options };
    this.numbers = stepNumbers(run.workflow.steps);
    // Records written before nested steps existed only have the top-level index.
    const known = new Set(this.run.steps.map((s) => s.stepId));
    for (const s of flatten(run.workflow.steps)) if (!known.has(s.id)) this.run.steps.push({ stepId: s.id, status: 'pending', attempts: 0 });
  }

  get id(): string {
    return this.run.id;
  }

  /** Masked snapshot of the current record. */
  snapshot(): RunRecord {
    const copy = structuredClone(this.run);
    copy.variables = Object.fromEntries(Object.entries(this.vars).map(([k, v]) => [k, this.secrets.has(k) ? SECRET_MASK : v]));
    copy.results = copy.results.map((r) => (this.secrets.has(r.variable) && r.kind === 'text' ? { ...r, value: SECRET_MASK } : r));
    return copy;
  }

  /** Unmasked variable values (kept in memory only). */
  variables(): Record<string, string> {
    return { ...this.vars };
  }

  pause(): void {
    this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    this.resumeWaiter?.();
  }

  stop(): void {
    this.abort.abort();
  }

  respond(promptId: string, response: PromptResponse): boolean {
    if (!this.promptWaiter || this.promptWaiter.id !== promptId) return false;
    this.promptWaiter.resolve(response);
    return true;
  }

  async execute(): Promise<RunRecord> {
    this.update((r) => {
      r.status = 'running';
      r.error = undefined;
    });
    if (this.run.cursor?.length) this.resumeCursor = structuredClone(this.run.cursor);
    else if (this.run.currentStepIndex > 0) this.resumeCursor = [{ index: this.run.currentStepIndex }];
    try {
      if (this.run.tabId === undefined) {
        const tabId = await this.deps.driver.prepareTab(this.run.target);
        this.update((r) => (r.tabId = tabId));
      }
      const signal = await this.runList(this.run.workflow.steps, 0);
      if (signal?.kind === 'stop') {
        const failed = signal.outcome === 'failed';
        return await this.finish(
          failed ? 'failed' : 'succeeded',
          failed ? { stepId: signal.stepId, stepIndex: this.run.currentStepIndex, code: 'STOPPED_BY_STEP', message: signal.message } : undefined,
        );
      }
      return await this.finish('succeeded');
    } catch (err) {
      if (this.abort.signal.aborted) return await this.finish('stopped', undefined, 'Stopped by you');
      const stepId = err instanceof StepFailure ? err.stepId : this.run.currentStepId;
      const flowErr = err instanceof StepFailure ? err.error : toFlowError(err);
      if (flowErr.code === 'USER_CANCELLED') {
        const result = stepId ? this.result(stepId) : undefined;
        if (stepId && result && result.status !== 'failed') this.setStep(stepId, { status: 'skipped', message: flowErr.message });
        return await this.finish('stopped', undefined, `${flowErr.message} at step ${stepId ? this.numbers.get(stepId) : '?'}`);
      }
      return await this.finish('failed', { stepId, stepIndex: this.run.currentStepIndex, code: flowErr.code, message: flowErr.message });
    }
  }

  // -------------------------------------------------------------------------
  // Tree execution

  private takeResume(depth: number): CursorFrame | undefined {
    if (!this.resumeCursor || depth >= this.resumeCursor.length) return undefined;
    const frame = this.resumeCursor[depth];
    if (depth === this.resumeCursor.length - 1) this.resumeCursor = null;
    return frame;
  }

  private enter(depth: number, step: Step, frame: CursorFrame): void {
    this.stack.length = depth;
    this.path.length = depth;
    this.stack.push(frame);
    this.path.push(step);
    this.update((r) => {
      r.cursor = structuredClone(this.stack);
      r.currentStepIndex = this.stack[0].index;
      r.currentStepId = step.id;
    });
  }

  private async runList(steps: Step[], depth: number): Promise<Signal | undefined> {
    const resumeFrame = this.takeResume(depth);
    for (let i = resumeFrame?.index ?? 0; i < steps.length; i++) {
      await this.gate();
      const step = steps[i];
      const resuming = resumeFrame && i === resumeFrame.index ? resumeFrame : undefined;
      this.enter(depth, step, { index: i });
      const signal = await this.runOne(step, depth, resuming);
      if (signal) return signal;
      const delay = this.run.workflow.settings.stepDelayMs;
      if (delay > 0 && i < steps.length - 1 && !actionDef(step.type).block) await this.clock.sleep(delay, this.abort.signal);
    }
    return undefined;
  }

  private async runOne(step: Step, depth: number, resuming?: CursorFrame): Promise<Signal | undefined> {
    if (step.disabled) {
      this.markSubtree(step, 'skipped', 'Disabled');
      return undefined;
    }
    if (step.confirmBefore && !resuming) {
      const answer = await this.prompt('confirmBefore', step, `Step ${this.numbers.get(step.id)} — ${stepTitle(step)}: ${stepSummary(step)}. Run this step?`);
      if (answer.action === 'skip') {
        this.markSubtree(step, 'skipped', 'Skipped by you');
        return undefined;
      }
      if (answer.action !== 'continue') throw new StepFailure(new FlowError('USER_CANCELLED', 'You chose not to run this step', true), step.id);
    }

    switch (step.type) {
      case 'break':
      case 'continue':
        this.countExecution(step);
        this.setStep(step.id, { status: 'succeeded', message: step.type === 'break' ? 'Left the loop' : 'Skipped to the next iteration', finishedAt: this.clock.now() });
        this.log(step, 'succeeded', step.type === 'break' ? 'Left the loop' : 'Next iteration');
        return { kind: step.type };
      case 'if':
        return this.runIf(step, depth, resuming);
      default:
        if (isLoop(step)) return this.runLoop(step, depth, resuming);
    }

    const outcome = await this.runStep(step, 0);
    if (outcome?.stopRun) return { kind: 'stop', ...outcome.stopRun, stepId: step.id };
    return undefined;
  }

  private async runIf(step: Step, depth: number, resuming?: CursorFrame): Promise<Signal | undefined> {
    let branch = resuming?.branch;
    if (!branch) {
      const outcome = await this.runStep(step, 0);
      if (!outcome) {
        // Condition could not be evaluated and the step was skipped by policy.
        for (const child of [...(step.children ?? []), ...(step.elseChildren ?? [])]) this.markSubtree(child, 'skipped', 'Block skipped');
        return undefined;
      }
      branch = outcome.conditionMet ? 'then' : 'else';
    }
    this.stack[depth] = { ...this.stack[depth], branch };
    this.update((r) => (r.cursor = structuredClone(this.stack)));
    const [taken, notTaken] = branch === 'then' ? [step.children ?? [], step.elseChildren ?? []] : [step.elseChildren ?? [], step.children ?? []];
    for (const child of notTaken) this.markSubtree(child, 'skipped', 'Branch not taken');
    return this.runList(taken, depth + 1);
  }

  private async runLoop(step: Step, depth: number, resuming?: CursorFrame): Promise<Signal | undefined> {
    const startedAt = this.clock.now();
    let completed = resuming?.iteration ?? 0;
    for (let k = resuming?.iteration ?? 0; ; k++) {
      await this.gate();
      this.stack[depth] = { index: this.stack[depth].index, iteration: k };
      this.stack.length = depth + 1;
      this.path.length = depth + 1;
      this.update((r) => (r.cursor = structuredClone(this.stack)));

      const outcome = await this.runStep(step, k, { quiet: true });
      if (!outcome || !outcome.conditionMet) {
        if (outcome) {
          const done = `Completed ${completed} iteration${completed === 1 ? '' : 's'}`;
          const summary = outcome.message ? `${done} — ${outcome.message}` : done;
          this.setStep(step.id, { status: 'succeeded', message: summary, startedAt, finishedAt: this.clock.now() });
          this.log(step, 'succeeded', summary);
        }
        return undefined;
      }
      for (const [name, value] of Object.entries(outcome.bindings ?? {})) this.vars[name] = value;
      this.setStep(step.id, { status: 'running', message: outcome.message, startedAt });
      for (const child of step.children ?? []) this.resetSubtree(child);

      const signal = await this.runList(step.children ?? [], depth + 1);
      completed = k + 1;
      if (signal?.kind === 'break') {
        const message = `Left the loop after ${completed} iteration${completed === 1 ? '' : 's'}`;
        this.setStep(step.id, { status: 'succeeded', message, finishedAt: this.clock.now() });
        this.log(step, 'succeeded', message);
        return undefined;
      }
      if (signal?.kind === 'stop') {
        this.setStep(step.id, { status: 'succeeded', message: `Ended by a Stop step during iteration ${completed}`, finishedAt: this.clock.now() });
        return signal;
      }
    }
  }

  private countExecution(step: Step): void {
    if (++this.executions > LIMITS.maxExecutions) {
      throw new StepFailure(
        new FlowError('LIMIT_EXCEEDED', `The run exceeded ${LIMITS.maxExecutions.toLocaleString()} step executions — check loop conditions for an endless loop`, true),
        step.id,
      );
    }
    this.setStep(step.id, { executions: (this.result(step.id)?.executions ?? 0) + 1 });
  }

  // -------------------------------------------------------------------------
  // Single step with retries and error policy

  private async runStep(step: Step, iteration: number, opts: { quiet?: boolean } = {}): Promise<StepOutcome | null> {
    const settings = this.run.workflow.settings;
    const interactive = INTERACTIVE.has(step.type);
    const retries = interactive ? 0 : step.retries ?? settings.defaultRetries;
    const policy = step.onError ?? settings.defaultOnError;
    this.countExecution(step);
    this.setStep(step.id, {
      status: 'running',
      attempts: 0,
      ...(opts.quiet ? {} : { startedAt: this.clock.now(), message: undefined }),
      errorCode: undefined,
    });

    for (;;) {
      let lastError: FlowError | undefined;
      for (let a = 0; a <= retries; a++) {
        this.setStep(step.id, { attempts: (this.result(step.id)?.attempts ?? 0) + 1 });
        try {
          const outcome = await this.attempt(step, iteration, interactive);
          let message = outcome.message;
          if (actionDef(step.type).mayNavigate) message += await this.settle();
          if (opts.quiet) {
            this.setStep(step.id, { message });
          } else {
            this.setStep(step.id, { status: 'succeeded', message, finishedAt: this.clock.now() });
            this.log(step, 'succeeded', message);
          }
          return { ...outcome, message };
        } catch (err) {
          if (this.abort.signal.aborted) throw err;
          lastError = toFlowError(err);
          if (lastError.fatal || NON_RETRYABLE.has(lastError.code)) break;
          if (a < retries) {
            this.setStep(step.id, { message: `Attempt ${a + 1} failed: ${lastError.message}. Retrying…` });
            await this.clock.sleep(this.options.retryBackoffMs * (a + 1), this.abort.signal);
          }
        }
      }

      const error = lastError!;
      if (error.code === 'USER_CANCELLED' || error.code === 'LIMIT_EXCEEDED') throw new StepFailure(error, step.id);
      if (policy === 'skip') {
        const message = `Skipped after error: ${error.message}`;
        this.setStep(step.id, { status: 'skipped', message, errorCode: error.code, finishedAt: this.clock.now() });
        this.log(step, 'skipped', message);
        return null;
      }
      this.setStep(step.id, { status: 'failed', message: error.message, errorCode: error.code, finishedAt: this.clock.now() });
      this.log(step, 'failed', error.message);
      if (policy === 'ask') {
        const answer = await this.prompt('error', step, `Step ${this.numbers.get(step.id)} "${stepTitle(step)}" failed: ${error.message}`);
        if (answer.action === 'retry') {
          this.setStep(step.id, { status: 'running', message: 'Retrying…', errorCode: undefined, finishedAt: undefined });
          continue;
        }
        if (answer.action === 'skip') {
          this.setStep(step.id, { status: 'skipped', message: `Skipped after error: ${error.message}` });
          return null;
        }
      }
      throw new StepFailure(error, step.id);
    }
  }

  private async attempt(step: Step, iteration: number, interactive: boolean): Promise<StepOutcome> {
    const settings = this.run.workflow.settings;
    let timeoutMs = step.timeoutMs ?? settings.defaultTimeoutMs;
    if (step.type === 'wait' && step.params.mode === 'duration') timeoutMs += step.params.durationMs ?? 0;

    const ctrl = new AbortController();
    const onParentAbort = () => ctrl.abort();
    this.abort.signal.addEventListener('abort', onParentAbort, { once: true });
    const ctx = this.context(step, iteration, ctrl.signal, timeoutMs);
    const handler = HANDLERS[step.type] as ActionHandler<typeof step.type>;

    let timedOut = false;
    const work = handler(ctx, step.params as never);
    const racers: Promise<StepOutcome>[] = [work];
    if (!interactive) {
      racers.push(
        this.clock.sleep(timeoutMs + HARD_TIMEOUT_GRACE_MS, ctrl.signal).then(() => {
          timedOut = true;
          throw new FlowError('TIMEOUT', `Step did not finish within ${Math.round(timeoutMs / 1000)}s`);
        }),
      );
    }
    try {
      return await Promise.race(racers);
    } catch (err) {
      if (timedOut || (!this.abort.signal.aborted && err instanceof Error && err.name === 'AbortError')) {
        throw new FlowError('TIMEOUT', `Step did not finish within ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    } finally {
      ctrl.abort();
      work.catch(() => undefined);
      this.abort.signal.removeEventListener('abort', onParentAbort);
    }
  }

  /** Waits for a navigation started by the last action; never fails the step. */
  private async settle(): Promise<string> {
    const timeout = this.run.workflow.settings.defaultTimeoutMs;
    try {
      await this.deps.driver.waitForSettle(this.run.tabId!, timeout, this.abort.signal);
      return '';
    } catch (err) {
      if (this.abort.signal.aborted) throw err;
      const e = toFlowError(err);
      if (e.code === 'TAB_CLOSED') throw e;
      return ' (page still loading)';
    }
  }

  private context(step: Step, iteration: number, signal: AbortSignal, timeoutMs: number): ActionContext {
    const clock = this.clock;
    const driver = this.deps.driver;
    const tabId = this.run.tabId!;
    const deadline = clock.now() + timeoutMs;
    const poll = this.options.pollIntervalMs;

    const resolve = (template: string) => {
      try {
        return interpolate(template, { ...builtinValues(new Date(clock.now()), this.run.id), ...this.vars });
      } catch (err) {
        if (err instanceof MissingVariableError) {
          throw new FlowError('MISSING_VARIABLE', `{{${err.variable}}} has no value. Define it under Variables or set it in an earlier step.`, true);
        }
        throw err;
      }
    };

    const ctx: ActionContext = {
      tabId,
      driver,
      signal,
      timeoutMs,
      deadline,
      highlight: this.options.highlightElements,
      stepId: step.id,
      stepIndex: this.run.currentStepIndex,
      iteration,
      dataTable: this.run.workflow.data,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms, signal),
      resolve,
      resolveLocator: (l) => ({ strategy: l.strategy, value: resolve(l.value) }),
      setVariable: (name, value) => {
        this.vars[name] = value;
        this.update(() => undefined);
      },
      getVariable: (name) => (Object.prototype.hasOwnProperty.call(this.vars, name) ? this.vars[name] : undefined),
      addTableRow: (row) => {
        const table = (this.run.table ??= { columns: [], rows: [] });
        if (table.rows.length >= LIMITS.maxTableRows) {
          throw new FlowError('LIMIT_EXCEEDED', `The results table is limited to ${LIMITS.maxTableRows.toLocaleString()} rows`, true);
        }
        this.update((r) => {
          const t = r.table!;
          for (const c of Object.keys(row)) if (!t.columns.includes(c)) t.columns.push(c);
          t.rows.push(row);
        });
        return table.rows.length;
      },
      addResult: (r) => {
        const result: ExtractedResult = { ...r, stepId: step.id, stepIndex: this.run.currentStepIndex };
        this.update((run) => run.results.push(result));
      },
      prompt: (kind, message, text) => this.prompt(kind, step, message, text),
      saveArtifact: (dataUrl, label) => this.deps.persistence.saveArtifact(this.run.id, dataUrl, label),
      dom: (request) => {
        if (signal.aborted) return Promise.reject(abortError());
        return driver.dom(tabId, request);
      },
      waitForElement: async (locator, req) => {
        let last: ProbeResult | undefined;
        let lastError: FlowError | undefined;
        for (;;) {
          if (signal.aborted) throw abortError();
          try {
            last = await driver.dom(tabId, { op: 'probe', locator });
            lastError = undefined;
            if (last.count > 0 && (!req.visible || last.visible) && (!req.enabled || last.enabled)) return last;
          } catch (err) {
            const e = toFlowError(err);
            if (e.fatal || NON_RETRYABLE.has(e.code)) throw e;
            lastError = e; // e.g. page mid-navigation; keep polling
          }
          if (clock.now() + poll > deadline) break;
          await clock.sleep(poll, signal);
        }
        const waited = `after waiting ${Math.round(timeoutMs / 100) / 10}s`;
        if (!last && lastError) throw lastError;
        if (!last || last.count === 0) throw new FlowError('ELEMENT_NOT_FOUND', `No element matches ${describeLocator(locator)} ${waited}`);
        if (req.visible && !last.visible) throw new FlowError('ELEMENT_NOT_VISIBLE', `${describeLocator(locator)} exists but is not visible ${waited}`);
        throw new FlowError('ELEMENT_DISABLED', `${describeLocator(locator)} is still disabled ${waited}`);
      },
      pollUntil: async (check, describe) => {
        for (;;) {
          if (signal.aborted) throw abortError();
          try {
            if (await check()) return;
          } catch (err) {
            const e = toFlowError(err);
            if (e.fatal || NON_RETRYABLE.has(e.code)) throw e;
          }
          if (clock.now() + poll > deadline) break;
          await clock.sleep(poll, signal);
        }
        throw new FlowError('TIMEOUT', `${describe()} after ${Math.round(timeoutMs / 100) / 10}s`);
      },
    };
    return ctx;
  }

  // -------------------------------------------------------------------------
  // Pause / prompts / bookkeeping

  private async gate(): Promise<void> {
    if (this.abort.signal.aborted) throw abortError();
    if (!this.pauseRequested) return;
    this.update((r) => (r.status = 'paused'));
    await new Promise<void>((resolve, reject) => {
      if (!this.pauseRequested) return resolve();
      const onAbort = () => reject(abortError());
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      this.resumeWaiter = () => {
        this.abort.signal.removeEventListener('abort', onAbort);
        this.resumeWaiter = undefined;
        resolve();
      };
    });
    this.update((r) => (r.status = 'running'));
  }

  private async prompt(kind: PromptKind, step: Step, message: string, text?: string): Promise<PromptResponse> {
    const prompt: PendingPrompt = {
      id: newId('p'),
      kind,
      stepId: step.id,
      stepIndex: this.run.currentStepIndex,
      message,
      text,
      createdAt: this.clock.now(),
    };
    const previous = this.run.status;
    this.update((r) => {
      r.status = 'waiting_for_user';
      r.pendingPrompt = prompt;
    });
    this.deps.onPrompt?.(this.snapshot());
    try {
      return await new Promise<PromptResponse>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        if (this.abort.signal.aborted) return onAbort();
        this.abort.signal.addEventListener('abort', onAbort, { once: true });
        this.promptWaiter = {
          id: prompt.id,
          resolve: (r) => {
            this.abort.signal.removeEventListener('abort', onAbort);
            resolve(r);
          },
        };
      });
    } finally {
      this.promptWaiter = undefined;
      this.update((r) => {
        r.pendingPrompt = undefined;
        if (r.status === 'waiting_for_user') r.status = previous === 'waiting_for_user' ? 'running' : previous;
      });
    }
  }

  private result(stepId: string): StepResult | undefined {
    return this.run.steps.find((s) => s.stepId === stepId);
  }

  private setStep(stepId: string, patch: Partial<StepResult>): void {
    this.update((r) => {
      const target = r.steps.find((s) => s.stepId === stepId);
      if (target) Object.assign(target, patch);
    });
  }

  private markSubtree(step: Step, status: 'skipped', message: string): void {
    this.update((r) => {
      for (const s of flatten([step])) {
        const target = r.steps.find((x) => x.stepId === s.id);
        if (target) Object.assign(target, { status, message });
      }
    });
  }

  /** Clears per-iteration state so the monitor shows the current iteration. */
  private resetSubtree(step: Step): void {
    this.update((r) => {
      for (const s of flatten([step])) {
        const target = r.steps.find((x) => x.stepId === s.id);
        if (target) Object.assign(target, { status: 'pending', message: undefined, errorCode: undefined, attempts: 0 });
      }
    });
  }

  private log(step: Step, status: LogEntry['status'], message: string): void {
    const context = this.path
      .map((s, d) => ({ s, frame: this.stack[d] }))
      .filter(({ s, frame }) => s.id !== step.id && frame?.iteration !== undefined)
      .map(({ s, frame }) => `${stepTitle(s)} #${frame.iteration! + 1}`)
      .join(' › ');
    this.update((r) => {
      const log = (r.log ??= []);
      log.push({ at: this.clock.now(), stepId: step.id, status, message, context: context || undefined });
      if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
    });
  }

  private async finish(status: RunStatus, error?: RunRecord['error'], summaryPrefix?: string): Promise<RunRecord> {
    const counts = { succeeded: 0, failed: 0, skipped: 0 };
    for (const s of this.run.steps) if (s.status in counts) counts[s.status as keyof typeof counts]++;
    const total = this.run.steps.length;
    const parts = [`${counts.succeeded} of ${total} step${total === 1 ? '' : 's'} succeeded`];
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.failed) parts.push(`${counts.failed} failed`);
    if (this.run.table?.rows.length) parts.push(`${this.run.table.rows.length} result row${this.run.table.rows.length === 1 ? '' : 's'}`);
    this.update((r) => {
      r.status = status;
      r.finishedAt = this.clock.now();
      r.pendingPrompt = undefined;
      r.error = error;
      r.summary = [summaryPrefix ?? (error ? error.message : undefined), parts.join(', ')].filter(Boolean).join(' — ');
      for (const s of r.steps) if (s.status === 'running') s.status = status === 'stopped' ? 'skipped' : status === 'failed' ? 'failed' : 'succeeded';
    });
    await this.saveChain;
    return this.snapshot();
  }

  private update(mutate: (run: RunRecord) => unknown): void {
    mutate(this.run);
    const important = this.run.status !== this.emittedStatus || this.run.pendingPrompt?.id !== this.emittedPromptId;
    const elapsed = Date.now() - this.lastEmit;
    if (important || elapsed >= SNAPSHOT_INTERVAL_MS) this.emit();
    else this.emitTimer ??= setTimeout(() => this.emit(), SNAPSHOT_INTERVAL_MS - elapsed);
  }

  private emit(): void {
    clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.lastEmit = Date.now();
    this.emittedStatus = this.run.status;
    this.emittedPromptId = this.run.pendingPrompt?.id;
    const snapshot = this.snapshot();
    this.saveChain = this.saveChain
      .then(() => this.deps.persistence.saveRun(snapshot))
      .catch((err) => console.warn('[FlowPilot] could not persist run', err));
    this.deps.onUpdate?.(snapshot);
  }
}
