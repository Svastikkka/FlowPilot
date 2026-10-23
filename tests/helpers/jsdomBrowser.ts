import { JSDOM } from 'jsdom';
import type { BrowserDriver } from '../../src/engine/driver';
import type { DomRequest, DomResult } from '../../src/shared/messages';
import type { NavigateParams, RunTarget } from '../../src/shared/schema/types';
import { performDomRequest } from '../../src/content/domActions';
import { FlowError, serializeError } from '../../src/shared/errors';

// A small multi-page "browser" for functional tests. Pages are HTML strings
// keyed by URL. It runs the real content-script DOM code against jsdom and
// simulates what jsdom does not implement: link navigation, GET form
// submission and history.

export type PageSource = string | ((url: URL) => string);

interface Tab {
  id: number;
  history: string[];
  index: number;
  dom: JSDOM | null;
  pendingNavigation: string | null;
  closed: boolean;
}

export class JsdomBrowser implements BrowserDriver {
  readonly tabs = new Map<number, Tab>();
  private nextTabId = 1;
  /** Hook for tests to modify a page after it loads (e.g. delayed elements). */
  onLoad?: (url: string, window: JSDOM['window']) => void;
  screenshots = 0;
  restricted = new Set<string>();

  constructor(private readonly pages: Record<string, PageSource>) {}

  openTab(url?: string): number {
    const tab: Tab = { id: this.nextTabId++, history: [], index: -1, dom: null, pendingNavigation: null, closed: false };
    this.tabs.set(tab.id, tab);
    if (url) this.load(tab, url, true);
    return tab.id;
  }

  closeTab(id: number) {
    const tab = this.tabs.get(id);
    if (tab) {
      tab.closed = true;
      tab.dom?.window.close();
    }
  }

  document(tabId: number): Document {
    return this.tab(tabId).dom!.window.document;
  }

  currentUrl(tabId: number): string {
    return this.tab(tabId).history[this.tab(tabId).index];
  }

  private tab(id: number): Tab {
    const tab = this.tabs.get(id);
    if (!tab || tab.closed) throw new FlowError('TAB_CLOSED', 'The tab used by this run was closed', true);
    return tab;
  }

  private load(tab: Tab, rawUrl: string, push: boolean) {
    const parsed = new URL(rawUrl);
    const url = parsed.href;
    const key = `${parsed.origin}${parsed.pathname}`;
    const source = this.pages[url] ?? this.pages[rawUrl] ?? this.pages[key];
    if (source === undefined) throw new FlowError('NAVIGATION_FAILED', `404: ${url}`);
    const html = typeof source === 'function' ? source(parsed) : source;
    tab.dom?.window.close();
    const dom = new JSDOM(html, { url, pretendToBeVisual: true });
    tab.dom = dom;
    if (push) {
      tab.history = tab.history.slice(0, tab.index + 1);
      tab.history.push(url);
      tab.index = tab.history.length - 1;
    }
    const doc = dom.window.document;
    // Simulate link clicks and GET form submissions (not implemented by jsdom).
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (a && !e.defaultPrevented && !a.getAttribute('href')!.startsWith('#')) {
        e.preventDefault();
        tab.pendingNavigation = a.href;
      }
    });
    doc.addEventListener('submit', (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const params = new dom.window.URLSearchParams(new dom.window.FormData(form) as unknown as Record<string, string>);
      const action = new URL(form.getAttribute('action') || url, url);
      action.search = params.toString();
      tab.pendingNavigation = action.href;
    });
    this.onLoad?.(url, dom.window);
  }

  async prepareTab(target: RunTarget): Promise<number> {
    if (target.kind === 'tab') return this.tab(target.tabId).id;
    return this.openTab();
  }

  async navigate(tabId: number, url: string): Promise<void> {
    const tab = this.tab(tabId);
    if (this.restricted.has(new URL(url).origin)) {
      throw new FlowError('PERMISSION_DENIED', 'FlowPilot does not have access to this site.', true);
    }
    this.load(tab, url, true);
  }

  async history(tabId: number, direction: NavigateParams['direction']): Promise<void> {
    const tab = this.tab(tabId);
    const next = direction === 'back' ? tab.index - 1 : direction === 'forward' ? tab.index + 1 : tab.index;
    if (next < 0 || next >= tab.history.length) throw new FlowError('NAVIGATION_FAILED', 'There is no page to go to in that direction', true);
    tab.index = next;
    this.load(tab, tab.history[next], false);
  }

  async waitForSettle(tabId: number): Promise<void> {
    const tab = this.tab(tabId);
    const next = tab.pendingNavigation;
    if (next) {
      tab.pendingNavigation = null;
      this.load(tab, next, true);
    }
  }

  async dom<R extends DomRequest>(tabId: number, request: R): Promise<DomResult<R['op']>> {
    const tab = this.tab(tabId);
    if (!tab.dom) throw new FlowError('RESTRICTED_PAGE', 'The run tab has no web page loaded yet. Start the workflow with an "Open URL" step.', true);
    if (this.restricted.has(new URL(this.currentUrl(tabId)).origin)) {
      throw new FlowError('PERMISSION_DENIED', 'FlowPilot does not have access to this site.', true);
    }
    try {
      // Round-trip through the serialized form, as chrome messaging would.
      return structuredClone(performDomRequest(tab.dom.window.document, request));
    } catch (err) {
      const e = serializeError(err);
      throw new FlowError(e.code, e.message, !!e.fatal);
    }
  }

  async screenshot(tabId: number): Promise<string> {
    this.tab(tabId);
    this.screenshots++;
    return 'data:image/png;base64,iVBORw0KGgo=';
  }
}
