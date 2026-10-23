import type { RunRecord, Workflow } from '../shared/schema/types';
import { cloneWorkflow } from '../shared/schema/factory';
import { upgradeStoredWorkflow } from '../shared/schema/importExport';
import { getDb } from './db';

export async function listWorkflows(): Promise<Workflow[]> {
  const db = await getDb();
  const all = (await db.getAll('workflows')).map(upgradeStoredWorkflow);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getWorkflow(id: string): Promise<Workflow | undefined> {
  const wf = await (await getDb()).get('workflows', id);
  return wf && upgradeStoredWorkflow(wf);
}

export async function saveWorkflow(workflow: Workflow, now = Date.now()): Promise<Workflow> {
  const saved = { ...workflow, updatedAt: now };
  await (await getDb()).put('workflows', saved);
  return saved;
}

/** Writes without touching updatedAt (favorites, last-run status). */
export async function putWorkflowMeta(workflow: Workflow): Promise<void> {
  await (await getDb()).put('workflows', workflow);
}

export async function saveWorkflows(workflows: Workflow[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction('workflows', 'readwrite');
  await Promise.all([...workflows.map((w) => tx.store.put(w)), tx.done]);
}

export async function deleteWorkflow(id: string): Promise<void> {
  await (await getDb()).delete('workflows', id);
}

export async function duplicateWorkflow(id: string): Promise<Workflow | undefined> {
  const original = await getWorkflow(id);
  if (!original) return undefined;
  const copy = cloneWorkflow(original, { name: `${original.name} (copy)`, favorite: false });
  await (await getDb()).put('workflows', copy);
  return copy;
}

export async function recordLastRun(run: RunRecord): Promise<void> {
  if (run.mode !== 'full' || !run.finishedAt) return;
  const db = await getDb();
  const tx = db.transaction('workflows', 'readwrite');
  const wf = await tx.store.get(run.workflowId);
  if (wf) await tx.store.put({ ...wf, lastRun: { runId: run.id, status: run.status, finishedAt: run.finishedAt } });
  await tx.done;
}
