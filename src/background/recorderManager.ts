import { appendEvent, newSession, RECORDER_CHANNEL } from '../shared/recorder';
import type { RecordedEvent, RecordingSession, RecorderControl } from '../shared/recorder';
import { FlowError } from '../shared/errors';
import { newId } from '../shared/ids';

// Owns the (single) recording session. State lives in chrome.storage.session
// so it survives service-worker restarts during a long recording, and the
// Recorder page can follow it live via storage change events.

export interface RecorderDeps {
  load(): Promise<RecordingSession | undefined>;
  save(session: RecordingSession | undefined): Promise<void>;
  createTab(url: string): Promise<number>;
  /** Injects the content script and tells it to start/stop recording. */
  control(tabId: number, control: RecorderControl): Promise<void>;
  tabUrl(tabId: number): Promise<string | undefined>;
  setBadge(tabId: number, recording: boolean): void;
  now(): number;
}

export class RecorderManager {
  /** Serializes read-modify-write of the stored session. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Tab being recorded (null = none), cached so tab events from other tabs are cheap. */
  private recordingTab: number | null | undefined;

  private readonly deps: RecorderDeps;

  constructor(deps: RecorderDeps) {
    const { load, save } = deps;
    this.deps = {
      ...deps,
      load: async () => {
        const session = await load();
        this.recordingTab = session?.status === 'recording' ? session.tabId : null;
        return session;
      },
      save: async (session) => {
        this.recordingTab = session?.status === 'recording' ? session.tabId : null;
        await save(session);
      },
    };
  }

  /** Cheap check used to ignore events from tabs that aren't being recorded. */
  async isRecordingTab(tabId: number): Promise<boolean> {
    if (this.recordingTab === undefined) await this.deps.load();
    return this.recordingTab === tabId;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  current(): Promise<RecordingSession | undefined> {
    return this.deps.load();
  }

  /** Starts recording in a new tab at `url`, or in an existing tab. */
  start(target: { url: string } | { tabId: number }): Promise<RecordingSession> {
    return this.exclusive(async () => {
      const existing = await this.deps.load();
      if (existing?.status === 'recording') throw new FlowError('UNKNOWN', 'A recording is already in progress — stop it first', true);
      let tabId: number;
      let startUrl: string;
      if ('url' in target) {
        startUrl = target.url;
        tabId = await this.deps.createTab(target.url);
      } else {
        tabId = target.tabId;
        startUrl = (await this.deps.tabUrl(tabId)) ?? '';
      }
      const session = newSession(newId('rec'), tabId, startUrl, this.deps.now());
      await this.deps.save(session);
      this.deps.setBadge(tabId, true);
      // A new tab attaches when it finishes loading (onTabComplete); an existing one now.
      if (!('url' in target)) await this.attach(session);
      return session;
    });
  }

  stop(): Promise<RecordingSession | undefined> {
    return this.exclusive(async () => {
      const session = await this.deps.load();
      if (!session || session.status !== 'recording') return session;
      session.status = 'stopped';
      session.blockedHost = undefined;
      await this.deps.save(session);
      this.deps.setBadge(session.tabId, false);
      await this.deps.control(session.tabId, { channel: RECORDER_CHANNEL, cmd: 'stop' }).catch(() => undefined);
      return session;
    });
  }

  discard(): Promise<void> {
    return this.exclusive(async () => {
      const session = await this.deps.load();
      if (session?.status === 'recording') {
        this.deps.setBadge(session.tabId, false);
        await this.deps.control(session.tabId, { channel: RECORDER_CHANNEL, cmd: 'stop' }).catch(() => undefined);
      }
      await this.deps.save(undefined);
    });
  }

  /** Records an event reported by the content script of `tabId`. */
  record(tabId: number, event: RecordedEvent): Promise<void> {
    return this.exclusive(async () => {
      const session = await this.deps.load();
      // Never record anything outside the active session's tab.
      if (!session || session.status !== 'recording' || session.tabId !== tabId) return;
      appendEvent(session, event);
      await this.deps.save(session);
    });
  }

  /** The recorded tab navigated to a new URL (typed in the address bar, link, redirect…). */
  onTabUrl(tabId: number, url: string): Promise<void> {
    if (!/^https?:/i.test(url)) return Promise.resolve();
    return this.record(tabId, { kind: 'navigate', url, at: this.deps.now() });
  }

  /** The recorded tab finished loading: attach the recorder to the new page. */
  onTabComplete(tabId: number): Promise<void> {
    return this.exclusive(async () => {
      const session = await this.deps.load();
      if (session?.status === 'recording' && session.tabId === tabId) await this.attach(session);
    });
  }

  /** Re-attach after the user granted access to a blocked site. */
  reattach(): Promise<void> {
    return this.exclusive(async () => {
      const session = await this.deps.load();
      if (session?.status === 'recording') await this.attach(session);
    });
  }

  onTabClosed(tabId: number): Promise<void> {
    return this.exclusive(async () => {
      const session = await this.deps.load();
      if (session?.status === 'recording' && session.tabId === tabId) {
        session.status = 'stopped';
        await this.deps.save(session);
      }
    });
  }

  private async attach(session: RecordingSession): Promise<void> {
    try {
      await this.deps.control(session.tabId, { channel: RECORDER_CHANNEL, cmd: 'start' });
      if (session.blockedHost) {
        session.blockedHost = undefined;
        await this.deps.save(session);
      }
    } catch (err) {
      const e = err instanceof FlowError ? err : new FlowError('UNKNOWN', String(err));
      if (e.code === 'PERMISSION_DENIED' || e.code === 'RESTRICTED_PAGE') {
        const url = await this.deps.tabUrl(session.tabId).catch(() => undefined);
        session.blockedHost = url ? safeHost(url) : 'this page';
        await this.deps.save(session);
        return;
      }
      throw e;
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
