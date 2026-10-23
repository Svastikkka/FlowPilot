import type { BrowserDriver, RunPersistence } from '../engine/driver';
import { createRunRecord, initialVariables, SECRET_MASK, WorkflowRunner } from '../engine/runner';
import type { MonitorEvent } from '../shared/messages';
import type { DataTable, PromptResponse, RunRecord, RunStatus, RunTarget, Workflow } from '../shared/schema/types';
import { validateWorkflow } from '../shared/schema/validate';
import { stepTitle } from '../shared/schema/actions';
import { findStep } from '../shared/schema/tree';
import { dataTableSchema } from '../shared/schema/zod';
import { FlowError } from '../shared/errors';

// Owns active runners in the service worker, broadcasts updates to UI pages,
// keeps the worker alive during runs and recovers runs interrupted by worker
// termination.

const KEEPALIVE_MS = 20_000;
const LIVE_STATUSES: RunStatus[] = ['queued', 'running', 'paused', 'waiting_for_user'];

export interface RunManagerDeps {
  driver: BrowserDriver;
  persistence: RunPersistence;
  getWorkflow(id: string): Promise<Workflow | undefined>;
  getRun(id: string): Promise<RunRecord | undefined>;
  listRuns(): Promise<RunRecord[]>;
  recordLastRun(run: RunRecord): Promise<void>;
  pruneHistory(keep: number): Promise<unknown>;
  getSettings(): Promise<{ highlightElements: boolean; historyLimit: number }>;
  /** Opens the execution monitor for a run (used when a prompt needs an answer and no UI is open). */
  openMonitor(runId: string): void;
  tabExists(tabId: number): Promise<boolean>;
  keepAlive(): void;
}

export interface MonitorPort {
  postMessage(event: MonitorEvent): void;
}

export class RunManager {
  private readonly runners = new Map<string, WorkflowRunner>();
  private readonly ports = new Set<MonitorPort>();
  private readonly testTabs = new Map<string, number>();
  private readonly testVariables = new Map<string, Record<string, string>>();
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: RunManagerDeps) {}

  activeRunIds(): string[] {
    return [...this.runners.keys()];
  }

  addPort(port: MonitorPort): () => void {
    this.ports.add(port);
    port.postMessage({ type: 'hello', activeRunIds: this.activeRunIds() });
    return () => this.ports.delete(port);
  }

  async start(workflowId: string, target: RunTarget, inputs: Record<string, string>, table?: DataTable): Promise<string> {
    const stored = await this.requireWorkflow(workflowId);
    let workflow = stored;
    if (table) {
      const parsed = dataTableSchema.safeParse(table);
      if (!parsed.success) throw new FlowError('INVALID_WORKFLOW', 'The data provided for this run is not a valid table', true);
      workflow = { ...stored, data: parsed.data };
    }
    const validation = validateWorkflow(workflow);
    if (!validation.valid) {
      const n = validation.errors.length;
      throw new FlowError('INVALID_WORKFLOW', `Fix ${n} problem${n === 1 ? '' : 's'} in the editor before running`, true);
    }
    const run = createRunRecord(workflow, { target });
    await this.launch(run, initialVariables(workflow, inputs));
    return run.id;
  }

  async testStep(workflowId: string, stepId: string, inputs: Record<string, string> = {}): Promise<string> {
    const workflow = await this.requireWorkflow(workflowId);
    const step = findStep(workflow.steps, stepId);
    if (!step) throw new FlowError('INVALID_WORKFLOW', 'Step not found — save the workflow first', true);
    const stepErrors = validateWorkflow(workflow).errors.filter((e) => e.stepId === stepId);
    if (stepErrors.length) throw new FlowError('INVALID_WORKFLOW', `Fix this step first: ${stepErrors[0].message}`, true);

    const testWorkflow: Workflow = {
      ...workflow,
      name: `Test: ${stepTitle(step)}`,
      steps: [{ ...step, disabled: false, confirmBefore: false }],
      settings: { ...workflow.settings, stepDelayMs: 0 },
    };
    const tabId = this.testTabs.get(workflowId);
    const target: RunTarget = tabId !== undefined && (await this.deps.tabExists(tabId)) ? { kind: 'tab', tabId } : { kind: 'newTab' };
    const run = createRunRecord(testWorkflow, { target, mode: 'testStep' });
    const vars = { ...initialVariables(workflow, inputs), ...this.testVariables.get(workflowId) };
    await this.launch(run, vars);
    return run.id;
  }

  pause(runId: string): void {
    this.requireRunner(runId).pause();
  }

  resume(runId: string): void {
    this.requireRunner(runId).resume();
  }

  stop(runId: string): void {
    this.requireRunner(runId).stop();
  }

  respond(runId: string, promptId: string, response: PromptResponse): void {
    if (!this.requireRunner(runId).respond(promptId, response)) {
      throw new FlowError('UNKNOWN', 'That question has already been answered', true);
    }
  }

  /** Marks runs left in a live state by a terminated worker as interrupted. */
  async recover(): Promise<RunRecord[]> {
    const runs = await this.deps.listRuns();
    const interrupted: RunRecord[] = [];
    for (const run of runs) {
      if (!LIVE_STATUSES.includes(run.status) || this.runners.has(run.id)) continue;
      const updated: RunRecord = {
        ...run,
        status: 'interrupted',
        finishedAt: run.finishedAt ?? Date.now(),
        pendingPrompt: undefined,
        steps: run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'pending', message: 'Interrupted — may have partially run' } : s)),
        summary: `Chrome stopped FlowPilot's background process before the run finished (at step ${run.currentStepIndex + 1}). You can resume from that step.`,
      };
      await this.deps.persistence.saveRun(updated);
      await this.deps.recordLastRun(updated);
      interrupted.push(updated);
    }
    return interrupted;
  }

  async resumeInterrupted(runId: string, inputs: Record<string, string> = {}): Promise<string> {
    const previous = await this.deps.getRun(runId);
    if (!previous) throw new FlowError('UNKNOWN', 'Run not found', true);
    if (previous.status !== 'interrupted') throw new FlowError('UNKNOWN', 'Only interrupted runs can be resumed', true);

    const workflow = previous.workflow;
    const defaults = initialVariables(workflow, inputs);
    const vars: Record<string, string> = { ...defaults };
    for (const [k, v] of Object.entries(previous.variables)) {
      // Secret values are never persisted; fall back to defaults / fresh input.
      if (v !== SECRET_MASK) vars[k] = v;
    }
    Object.assign(vars, inputs);

    const tabAlive = previous.tabId !== undefined && (await this.deps.tabExists(previous.tabId));
    const run: RunRecord = {
      ...createRunRecord(workflow, { target: tabAlive ? { kind: 'tab', tabId: previous.tabId! } : { kind: 'newTab' }, mode: previous.mode }),
      workflowId: previous.workflowId,
      currentStepIndex: previous.currentStepIndex,
      steps: previous.steps.map((s) => ({ ...s })),
      results: [...previous.results],
      resumedFrom: previous.id,
    };
    await this.launch(run, vars);
    return run.id;
  }

  private async launch(run: RunRecord, vars: Record<string, string>): Promise<void> {
    const settings = await this.deps.getSettings();
    await this.deps.persistence.saveRun(run);
    const runner = new WorkflowRunner(run, vars, {
      driver: this.deps.driver,
      persistence: this.deps.persistence,
      options: { highlightElements: settings.highlightElements },
      onUpdate: (r) => this.broadcast(r),
      onPrompt: (r) => {
        if (this.ports.size === 0) this.deps.openMonitor(r.id);
      },
    });
    this.runners.set(run.id, runner);
    this.updateKeepAlive();

    void runner
      .execute()
      .then(async (final) => {
        if (final.mode === 'testStep') {
          if (final.tabId !== undefined) this.testTabs.set(final.workflowId, final.tabId);
          this.testVariables.set(final.workflowId, { ...this.testVariables.get(final.workflowId), ...runner.variables() });
        }
        await this.deps.recordLastRun(final);
        await this.deps.pruneHistory(settings.historyLimit);
      })
      .catch((err) => console.error('[FlowPilot] run crashed', err))
      .finally(() => {
        this.runners.delete(run.id);
        this.updateKeepAlive();
      });
  }

  private broadcast(run: RunRecord): void {
    for (const port of this.ports) {
      try {
        port.postMessage({ type: 'run.update', run });
      } catch {
        this.ports.delete(port);
      }
    }
  }

  private updateKeepAlive(): void {
    if (this.runners.size > 0 && !this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(() => this.deps.keepAlive(), KEEPALIVE_MS);
    } else if (this.runners.size === 0 && this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private async requireWorkflow(id: string): Promise<Workflow> {
    const wf = await this.deps.getWorkflow(id);
    if (!wf) throw new FlowError('INVALID_WORKFLOW', 'Workflow not found', true);
    return wf;
  }

  private requireRunner(runId: string): WorkflowRunner {
    const runner = this.runners.get(runId);
    if (!runner) throw new FlowError('UNKNOWN', 'This run is no longer active', true);
    return runner;
  }
}
