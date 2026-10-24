import { PICKER_CHANNEL } from '../shared/pickerProtocol';
import type { PickMode, PickerControl, PickerMessage, PickResult } from '../shared/pickerProtocol';
import { toFlowError } from '../shared/errors';

// Runs the element picker for an editor: opens (or reuses) a page to pick on,
// starts the picker there, and hands the result back to the editor tab.

export interface PickerDeps {
  tabAlive(tabId: number): Promise<boolean>;
  createTab(url: string): Promise<number>;
  waitLoaded(tabId: number): Promise<void>;
  activate(tabId: number): Promise<void>;
  control(tabId: number, control: PickerControl): Promise<void>;
  saveResult(result: PickResult): Promise<void>;
}

export class PickerManager {
  /** Tab used for picking; kept open and reused so you can navigate to the right page once. */
  private pickerTab: number | undefined;
  private pending: { requestId: string; editorTab?: number } | undefined;

  constructor(private readonly deps: PickerDeps) {}

  async start(opts: { url?: string; mode: PickMode; requestId: string; editorTab?: number }): Promise<void> {
    let tabId = this.pickerTab;
    if (tabId !== undefined && (await this.deps.tabAlive(tabId))) {
      await this.deps.activate(tabId);
    } else {
      if (!opts.url) throw new Error('Enter the page to pick on');
      tabId = await this.deps.createTab(opts.url);
      this.pickerTab = tabId;
      await this.deps.waitLoaded(tabId);
    }
    this.pending = { requestId: opts.requestId, editorTab: opts.editorTab };
    try {
      await this.deps.control(tabId, { channel: PICKER_CHANNEL, cmd: 'start', mode: opts.mode });
    } catch (err) {
      const message = toFlowError(err).message;
      await this.finish({ requestId: opts.requestId, error: message });
      throw err;
    }
  }

  /** Message from the picker content script. Ignored unless it comes from the picker tab. */
  async onMessage(tabId: number, message: PickerMessage): Promise<void> {
    if (!this.pending || tabId !== this.pickerTab) return;
    const { requestId } = this.pending;
    if (message.type === 'picked') {
      await this.finish({ requestId, locator: message.locator, description: message.description, count: message.count });
    } else {
      await this.finish({ requestId, cancelled: true });
    }
  }

  onTabClosed(tabId: number): Promise<void> | void {
    if (tabId !== this.pickerTab) return;
    this.pickerTab = undefined;
    if (this.pending) return this.finish({ requestId: this.pending.requestId, cancelled: true });
  }

  private async finish(result: PickResult): Promise<void> {
    const editor = this.pending?.editorTab;
    this.pending = undefined;
    await this.deps.saveResult(result);
    if (editor !== undefined) await this.deps.activate(editor).catch(() => undefined);
  }
}
