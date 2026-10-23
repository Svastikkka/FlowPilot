import type { RunRecord } from '../shared/schema/types';
import { newId } from '../shared/ids';
import { getDb } from './db';
import type { Artifact } from './db';

export async function saveRun(run: RunRecord): Promise<void> {
  await (await getDb()).put('runs', run);
}

export async function getRun(id: string): Promise<RunRecord | undefined> {
  return (await getDb()).get('runs', id);
}

export async function listRuns(opts: { workflowId?: string; limit?: number } = {}): Promise<RunRecord[]> {
  const db = await getDb();
  const runs = opts.workflowId
    ? await db.getAllFromIndex('runs', 'workflowId', opts.workflowId)
    : await db.getAll('runs');
  runs.sort((a, b) => b.startedAt - a.startedAt);
  return opts.limit ? runs.slice(0, opts.limit) : runs;
}

export async function deleteRun(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['runs', 'artifacts'], 'readwrite');
  const artifactKeys = await tx.objectStore('artifacts').index('runId').getAllKeys(id);
  await Promise.all([
    tx.objectStore('runs').delete(id),
    ...artifactKeys.map((k) => tx.objectStore('artifacts').delete(k)),
    tx.done,
  ]);
}

export async function clearHistory(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['runs', 'artifacts'], 'readwrite');
  await Promise.all([tx.objectStore('runs').clear(), tx.objectStore('artifacts').clear(), tx.done]);
}

/** Keeps the newest `keep` runs (and their artifacts); returns how many were deleted. */
export async function pruneHistory(keep: number): Promise<number> {
  const runs = await listRuns();
  const old = runs.slice(keep);
  for (const run of old) await deleteRun(run.id);
  return old.length;
}

export async function saveArtifact(runId: string, dataUrl: string, label: string, now = Date.now()): Promise<string> {
  const artifact: Artifact = { id: newId('art'), runId, label, dataUrl, createdAt: now };
  await (await getDb()).put('artifacts', artifact);
  return artifact.id;
}

export async function getArtifact(id: string): Promise<Artifact | undefined> {
  return (await getDb()).get('artifacts', id);
}

export async function clearAllData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['workflows', 'runs', 'artifacts'], 'readwrite');
  await Promise.all([
    tx.objectStore('workflows').clear(),
    tx.objectStore('runs').clear(),
    tx.objectStore('artifacts').clear(),
    tx.done,
  ]);
  await chrome.storage.local.clear();
}
