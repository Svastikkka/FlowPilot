import type { ErrorPolicy } from '../shared/schema/types';
import { DEFAULT_WORKFLOW_SETTINGS } from '../shared/schema/factory';

// Lightweight preferences in chrome.storage.local.

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  highlightElements: boolean;
  /** Maximum number of runs kept in history. */
  historyLimit: number;
  /** Defaults applied to new workflows. */
  defaultTimeoutMs: number;
  defaultRetries: number;
  defaultOnError: ErrorPolicy;
  stepDelayMs: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  highlightElements: true,
  historyLimit: 200,
  ...DEFAULT_WORKFLOW_SETTINGS,
};

const KEY = 'settings';

export async function getSettings(): Promise<AppSettings> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<AppSettings> | undefined) };
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(listener: (settings: AppSettings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && KEY in changes) listener({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue as Partial<AppSettings>) });
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
