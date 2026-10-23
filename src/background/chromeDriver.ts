import type { BrowserDriver } from '../engine/driver';
import { abortError } from '../engine/driver';
import { DOM_CHANNEL } from '../shared/messages';
import type { DomMessage, DomRequest, DomResponse, DomResult } from '../shared/messages';
import type { NavigateParams, RunTarget } from '../shared/schema/types';
import { FlowError } from '../shared/errors';

// BrowserDriver backed by chrome.tabs / chrome.scripting. Works with the
// minimal permission set: host access comes from optional host permissions
// granted per site, or from activeTab for runs started from the popup.

const CONTENT_SCRIPT = 'content.js';
/** How long to wait for a navigation to start after an action before assuming none will. */
const NAVIGATION_START_GRACE_MS = 400;
const TAB_POLL_MS = 250;
/** How long to wait for back/forward to start before concluding there is no such page. */
const HISTORY_START_GRACE_MS = 1_500;

export function mapChromeError(err: unknown): FlowError {
  if (err instanceof FlowError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/No tab with id|tab was closed|Tabs cannot be edited right now/i.test(message)) {
    return /Tabs cannot be edited/i.test(message)
      ? new FlowError('NAVIGATION_FAILED', 'Chrome is busy (e.g. a tab is being dragged); will retry')
      : new FlowError('TAB_CLOSED', 'The tab used by this run was closed', true);
  }
  if (/about:blank/i.test(message)) {
    return new FlowError('RESTRICTED_PAGE', 'The run tab has no web page loaded yet. Start the workflow with an "Open URL" step.', true);
  }
  if (/chrome:\/\/|chrome-extension:\/\/|cannot be scripted|extensions gallery|webstore|Cannot access a chrome/i.test(message)) {
    return new FlowError('RESTRICTED_PAGE', 'Chrome does not allow extensions to automate this page (browser, extension or Web Store pages)', true);
  }
  if (/Cannot access contents of|must request permission|Missing host permission|permission is required|activeTab/i.test(message)) {
    return new FlowError(
      'PERMISSION_DENIED',
      'FlowPilot does not have access to this site. Grant site access when you start the run, or manage it under Settings → Site access.',
      true,
    );
  }
  if (/message port closed|Frame with ID 0 was removed|back\/forward cache|Receiving end does not exist/i.test(message)) {
    return new FlowError('NAVIGATION_FAILED', 'The page navigated while the step was running');
  }
  if (/Cannot find a next page in history|no previous page/i.test(message)) {
    return new FlowError('NAVIGATION_FAILED', 'There is no page to go to in that direction', true);
  }
  return new FlowError('UNKNOWN', message || 'Unexpected browser error');
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.get(tabId);
  } catch (err) {
    throw mapChromeError(err);
  }
}

/** Resolves when the tab reports status "complete". Rejects on timeout, closure or abort. */
function waitForComplete(tabId: number, timeoutMs: number, signal: AbortSignal, requireLoadingFirst: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sawLoading = !requireLoadingFirst;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish();
    };
    const onRemoved = (id: number) => id === tabId && finish(new FlowError('TAB_CLOSED', 'The tab used by this run was closed', true));
    const onAbort = () => finish(abortError());
    const timer = setTimeout(
      () => finish(new FlowError('TIMEOUT', `Page did not finish loading within ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    // onUpdated can be missed if the load completes before we subscribe.
    const poller = setInterval(() => {
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === 'loading') sawLoading = true;
          else if (tab.status === 'complete' && sawLoading) finish();
        },
        () => finish(new FlowError('TAB_CLOSED', 'The tab used by this run was closed', true)),
      );
    }, TAB_POLL_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ChromeDriver implements BrowserDriver {
  async prepareTab(target: RunTarget): Promise<number> {
    if (target.kind === 'tab') {
      await getTab(target.tabId);
      return target.tabId;
    }
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    if (tab.id === undefined) throw new FlowError('UNKNOWN', 'Could not open a tab for the run');
    return tab.id;
  }

  async navigate(tabId: number, url: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    await getTab(tabId);
    const loaded = waitForComplete(tabId, timeoutMs, signal, true);
    try {
      await chrome.tabs.update(tabId, { url });
    } catch (err) {
      loaded.catch(() => undefined);
      throw mapChromeError(err);
    }
    await loaded;
  }

  async history(tabId: number, direction: NavigateParams['direction'], timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (direction === 'reload') {
      const loaded = waitForComplete(tabId, timeoutMs, signal, true);
      try {
        await chrome.tabs.reload(tabId);
      } catch (err) {
        loaded.catch(() => undefined);
        throw mapChromeError(err);
      }
      return loaded;
    }
    // chrome.tabs.goBack skips entries created without a user gesture (every
    // page an automation opens), so navigate from inside the page instead.
    const before = (await this.dom(tabId, { op: 'pageInfo' })).url;
    let started = false;
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && info.status === 'loading') started = true;
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    try {
      await this.dom(tabId, { op: 'historyGo', direction });
      const graceEnd = Date.now() + HISTORY_START_GRACE_MS;
      for (;;) {
        if (signal.aborted) throw abortError();
        if (started) break;
        let url: string | undefined;
        try {
          url = (await this.dom(tabId, { op: 'pageInfo' })).url;
        } catch {
          url = undefined; // the page is being replaced
        }
        if (url === undefined || url !== before) break;
        if (Date.now() > graceEnd) throw new FlowError('NAVIGATION_FAILED', 'There is no page to go to in that direction', true);
        await new Promise((r) => setTimeout(r, TAB_POLL_MS));
      }
    } finally {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    }
    await this.waitForSettle(tabId, timeoutMs, signal);
  }

  async waitForSettle(tabId: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const tab = await getTab(tabId);
    if (tab.status === 'loading') return waitForComplete(tabId, timeoutMs, signal, false);
    // Give a just-triggered navigation a moment to start.
    const started = await new Promise<boolean>((resolve) => {
      const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (id === tabId && info.status === 'loading') done(true);
      };
      const timer = setTimeout(() => done(false), NAVIGATION_START_GRACE_MS);
      const done = (value: boolean) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(value);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    if (signal.aborted) throw abortError();
    if (started) await waitForComplete(tabId, timeoutMs, signal, false);
  }

  async dom<R extends DomRequest>(tabId: number, request: R): Promise<DomResult<R['op']>> {
    const message: DomMessage = { channel: DOM_CHANNEL, request };
    let response: DomResponse | undefined;
    try {
      response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (!/Receiving end does not exist|Could not establish connection/i.test(text)) throw mapChromeError(err);
      await this.inject(tabId);
      try {
        response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
      } catch (retryErr) {
        throw mapChromeError(retryErr);
      }
    }
    if (!response) throw new FlowError('NAVIGATION_FAILED', 'The page did not respond (it may have navigated)');
    if (!response.ok) throw new FlowError(response.error.code, response.error.message, !!response.error.fatal);
    return response.data as DomResult<R['op']>;
  }

  private async inject(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [CONTENT_SCRIPT] });
    } catch (err) {
      throw mapChromeError(err);
    }
  }

  async screenshot(tabId: number): Promise<string> {
    const tab = await getTab(tabId);
    try {
      if (!tab.active) await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      const mapped = mapChromeError(err);
      if (mapped.code === 'UNKNOWN') throw new FlowError('SCREENSHOT_FAILED', `Screenshot failed: ${mapped.message}`);
      if (mapped.code === 'PERMISSION_DENIED') {
        throw new FlowError(
          'PERMISSION_DENIED',
          'Screenshots need access to all sites (Settings → Site access), or start the run from the toolbar popup.',
          true,
        );
      }
      throw mapped;
    }
  }
}
