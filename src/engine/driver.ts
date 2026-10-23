import type { DomRequest, DomResult } from '../shared/messages';
import type { NavigateParams, RunRecord, RunTarget } from '../shared/schema/types';

// Ports between the environment-agnostic engine and its host. The background
// service worker implements them with chrome.* APIs; tests use fakes or a
// jsdom-backed browser.

export interface BrowserDriver {
  /** Returns the tab id the run will drive (creating a tab for newTab targets). */
  prepareTab(target: RunTarget): Promise<number>;
  /** Loads a URL and resolves once the tab has finished loading. */
  navigate(tabId: number, url: string, timeoutMs: number, signal: AbortSignal): Promise<void>;
  history(tabId: number, direction: NavigateParams['direction'], timeoutMs: number, signal: AbortSignal): Promise<void>;
  /**
   * Resolves once any navigation triggered by the previous action has
   * finished. Resolves quickly when no navigation started.
   */
  waitForSettle(tabId: number, timeoutMs: number, signal: AbortSignal): Promise<void>;
  /** Performs a DOM operation in the tab, injecting the content script if needed. */
  dom<R extends DomRequest>(tabId: number, request: R): Promise<DomResult<R['op']>>;
  /** Captures the visible area of the tab as a PNG data URL. */
  screenshot(tabId: number): Promise<string>;
}

export interface RunPersistence {
  saveRun(run: RunRecord): Promise<void>;
  saveArtifact(runId: string, dataUrl: string, label: string): Promise<string>;
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface EngineOptions {
  /** Outline elements briefly before interacting with them. */
  highlightElements: boolean;
  /** Poll interval for waits and auto-waiting, in ms. */
  pollIntervalMs: number;
  /** Base back-off between retries, in ms (multiplied by attempt number). */
  retryBackoffMs: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  highlightElements: true,
  pollIntervalMs: 200,
  retryBackoffMs: 500,
};

export function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
