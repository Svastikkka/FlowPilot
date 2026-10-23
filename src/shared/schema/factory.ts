import { SCHEMA_VERSION } from './types';
import type { Workflow, WorkflowSettings } from './types';
import { newId } from '../ids';
import { reassignIds } from './tree';

export const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  defaultTimeoutMs: 10_000,
  defaultRetries: 1,
  defaultOnError: 'stop',
  stepDelayMs: 250,
};

export function newWorkflow(partial: Partial<Workflow> = {}, now = Date.now()): Workflow {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId('wf'),
    name: 'Untitled workflow',
    description: '',
    tags: [],
    favorite: false,
    variables: [],
    settings: { ...DEFAULT_WORKFLOW_SETTINGS },
    steps: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

/** Deep copy with fresh workflow and step ids (duplicate, templates, import). */
export function cloneWorkflow(wf: Workflow, overrides: Partial<Workflow> = {}, now = Date.now()): Workflow {
  const copy = structuredClone(wf);
  return {
    ...copy,
    id: newId('wf'),
    steps: reassignIds(copy.steps),
    createdAt: now,
    updatedAt: now,
    lastRun: undefined,
    ...overrides,
  };
}
