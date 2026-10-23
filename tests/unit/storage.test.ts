import { describe, expect, it } from 'vitest';
import { deleteWorkflow, duplicateWorkflow, getWorkflow, listWorkflows, recordLastRun, saveWorkflow } from '../../src/storage/workflows';
import { clearAllData, clearHistory, deleteRun, getArtifact, getRun, listRuns, pruneHistory, saveArtifact, saveRun } from '../../src/storage/runs';
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged, updateSettings } from '../../src/storage/settings';
import { createRunRecord } from '../../src/engine/runner';
import { css, step, wf } from '../helpers/fakes';

describe('workflow repository', () => {
  it('saves, lists (newest first), duplicates and deletes', async () => {
    const a = await saveWorkflow(wf([step('click', { locator: css('#a') })], { name: 'A' }), 1000);
    const b = await saveWorkflow(wf([], { name: 'B' }), 2000);
    expect((await listWorkflows()).map((w) => w.name)).toEqual(['B', 'A']);

    const copy = await duplicateWorkflow(a.id);
    expect(copy).toMatchObject({ name: 'A (copy)', favorite: false });
    expect(copy!.steps[0].id).not.toBe(a.steps[0].id);

    await deleteWorkflow(b.id);
    expect(await getWorkflow(b.id)).toBeUndefined();
    expect(await listWorkflows()).toHaveLength(2);
  });

  it('records the last run status of full runs only', async () => {
    const w = await saveWorkflow(wf([]));
    const run = { ...createRunRecord(w, { target: { kind: 'newTab' } }), status: 'failed' as const, finishedAt: 5 };
    await recordLastRun({ ...run, mode: 'testStep' });
    expect((await getWorkflow(w.id))!.lastRun).toBeUndefined();
    await recordLastRun(run);
    expect((await getWorkflow(w.id))!.lastRun).toEqual({ runId: run.id, status: 'failed', finishedAt: 5 });
  });
});

describe('run history', () => {
  const makeRun = (startedAt: number, workflowId = 'w1') => ({
    ...createRunRecord(wf([]), { target: { kind: 'newTab' }, now: startedAt }),
    workflowId,
  });

  it('lists runs newest first, filtered by workflow', async () => {
    await saveRun(makeRun(1));
    await saveRun(makeRun(3));
    await saveRun(makeRun(2, 'w2'));
    expect((await listRuns()).map((r) => r.startedAt)).toEqual([3, 2, 1]);
    expect((await listRuns({ workflowId: 'w1' })).map((r) => r.startedAt)).toEqual([3, 1]);
    expect(await listRuns({ limit: 1 })).toHaveLength(1);
  });

  it('deletes runs together with their artifacts', async () => {
    const run = makeRun(1);
    await saveRun(run);
    const art = await saveArtifact(run.id, 'data:image/png;base64,AA', 'shot');
    expect(await getArtifact(art)).toMatchObject({ label: 'shot', runId: run.id });
    await deleteRun(run.id);
    expect(await getRun(run.id)).toBeUndefined();
    expect(await getArtifact(art)).toBeUndefined();
  });

  it('prunes to the newest N runs', async () => {
    for (let i = 1; i <= 5; i++) await saveRun(makeRun(i));
    expect(await pruneHistory(2)).toBe(3);
    expect((await listRuns()).map((r) => r.startedAt)).toEqual([5, 4]);
  });

  it('clears history but keeps workflows', async () => {
    await saveWorkflow(wf([]));
    await saveRun(makeRun(1));
    await clearHistory();
    expect(await listRuns()).toEqual([]);
    expect(await listWorkflows()).toHaveLength(1);
  });

  it('deletes all local data, including settings', async () => {
    await saveWorkflow(wf([]));
    await saveRun(makeRun(1));
    await updateSettings({ theme: 'dark' });
    await clearAllData();
    expect(await listWorkflows()).toEqual([]);
    expect(await listRuns()).toEqual([]);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('settings', () => {
  it('merges stored values over defaults and notifies listeners', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    const seen: string[] = [];
    const off = onSettingsChanged((s) => seen.push(s.theme));
    await updateSettings({ theme: 'dark', historyLimit: 10 });
    expect(await getSettings()).toMatchObject({ theme: 'dark', historyLimit: 10, highlightElements: true });
    expect(seen).toEqual(['dark']);
    off();
  });
});
