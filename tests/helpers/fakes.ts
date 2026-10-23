import type { RunPersistence } from '../../src/engine/driver';
import type { RunRecord, Step, Workflow } from '../../src/shared/schema/types';
import { newWorkflow } from '../../src/shared/schema/factory';
import { createStep } from '../../src/shared/schema/actions';
import type { ActionParamsMap, ActionType, StepOf } from '../../src/shared/schema/types';

export class MemoryPersistence implements RunPersistence {
  runs = new Map<string, RunRecord>();
  artifacts = new Map<string, { runId: string; dataUrl: string; label: string }>();
  saves: RunRecord[] = [];

  async saveRun(run: RunRecord) {
    this.runs.set(run.id, structuredClone(run));
    this.saves.push(structuredClone(run));
  }

  async saveArtifact(runId: string, dataUrl: string, label: string) {
    const id = `art_${this.artifacts.size + 1}`;
    this.artifacts.set(id, { runId, dataUrl, label });
    return id;
  }
}

/** Fast settings so failure paths finish quickly in tests. */
export const FAST_SETTINGS = { defaultTimeoutMs: 300, defaultRetries: 0, defaultOnError: 'stop' as const, stepDelayMs: 0 };
export const FAST_ENGINE = { pollIntervalMs: 10, retryBackoffMs: 5, highlightElements: false };

export function wf(steps: Step[], partial: Partial<Workflow> = {}): Workflow {
  return newWorkflow({ name: 'Test workflow', steps, settings: { ...FAST_SETTINGS }, ...partial });
}

export function step<T extends ActionType>(type: T, params: Partial<ActionParamsMap[T]> = {}, extra: Partial<StepOf<T>> = {}): StepOf<T> {
  const base = createStep(type);
  return { ...base, ...extra, params: { ...base.params, ...params } } as StepOf<T>;
}

export const css = (value: string) => ({ strategy: 'css' as const, value });

/** Resolves when predicate(run) becomes true for a run update. */
export function waitForUpdate(
  updates: { listen(cb: (r: RunRecord) => void): void },
  predicate: (r: RunRecord) => boolean,
): Promise<RunRecord> {
  return new Promise((resolve) => updates.listen((r) => predicate(r) && resolve(r)));
}

export class UpdateBus {
  private listeners: ((r: RunRecord) => void)[] = [];
  history: RunRecord[] = [];
  emit = (r: RunRecord) => {
    this.history.push(r);
    for (const l of this.listeners) l(r);
  };
  listen(cb: (r: RunRecord) => void) {
    this.listeners.push(cb);
  }
  next(predicate: (r: RunRecord) => boolean) {
    return waitForUpdate(this, predicate);
  }
}
