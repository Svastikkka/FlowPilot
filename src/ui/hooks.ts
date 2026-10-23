import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunRecord, Workflow } from '../shared/schema/types';
import { listWorkflows } from '../storage/workflows';
import { getRun, listRuns } from '../storage/runs';
import { getSettings, onSettingsChanged } from '../storage/settings';
import type { AppSettings } from '../storage/settings';
import { subscribeToRuns } from './api';

export interface AsyncState<T> {
  data?: T;
  error?: Error;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      const data = await loadRef.current();
      setState({ data, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error as Error, loading: false }));
    }
  }, []);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...state, reload };
}

/** Workflows, refreshed when any run finishes (last-run badges). */
export function useWorkflows(): AsyncState<Workflow[]> {
  const state = useAsync(listWorkflows, []);
  const { reload } = state;
  useEffect(
    () =>
      subscribeToRuns((e) => {
        if (e.type === 'run.update' && e.run.finishedAt) void reload();
      }),
    [reload],
  );
  return state;
}

export function useRuns(opts: { limit?: number } = {}): AsyncState<RunRecord[]> {
  const state = useAsync(() => listRuns(opts), [opts.limit]);
  const { reload } = state;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return subscribeToRuns(() => {
      // Coalesce bursts of step updates.
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 300);
    });
  }, [reload]);
  return state;
}

/** A single run, live-updated from the service worker. */
export function useRun(runId: string): { run: RunRecord | undefined; loading: boolean; activeRunIds: string[] } {
  const [run, setRun] = useState<RunRecord>();
  const [loading, setLoading] = useState(true);
  const [activeRunIds, setActive] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = () =>
      getRun(runId).then((r) => {
        if (!cancelled) {
          setRun(r);
          setLoading(false);
        }
      });
    void load();
    const unsubscribe = subscribeToRuns((e) => {
      if (e.type === 'run.update' && e.run.id === runId) setRun(e.run);
      if (e.type === 'hello') {
        setActive(e.activeRunIds);
        void load(); // the worker may have restarted and recovered this run
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [runId]);
  return { run, loading, activeRunIds };
}

export function useSettings(): [AppSettings | undefined, (s: AppSettings) => void] {
  const [settings, setSettings] = useState<AppSettings>();
  useEffect(() => {
    void getSettings().then(setSettings);
    return onSettingsChanged(setSettings);
  }, []);
  return [settings, setSettings];
}

export function useTheme(theme: AppSettings['theme'] | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  if (!rtf) return new Date(ts).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(ts).toLocaleDateString();
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
