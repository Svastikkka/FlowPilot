import { ChromeDriver } from './chromeDriver';
import { RunManager } from './runManager';
import { COMMAND_CHANNEL, MONITOR_PORT } from '../shared/messages';
import type { Command, CommandResponse, CommandResultMap } from '../shared/messages';
import { FlowError, serializeError } from '../shared/errors';
import { RecorderManager } from './recorderManager';
import { PickerManager } from './pickerManager';
import { PICKER_CHANNEL, PICK_RESULT_KEY } from '../shared/pickerProtocol';
import type { PickerMessage } from '../shared/pickerProtocol';
import { RECORDER_CHANNEL, RECORDING_KEY } from '../shared/recorder';
import type { RecorderMessage, RecordingSession } from '../shared/recorder';
import { getRun, listRuns, pruneHistory, saveArtifact, saveRun } from '../storage/runs';
import { getWorkflow, recordLastRun } from '../storage/workflows';
import { getSettings } from '../storage/settings';

// Service worker entry. Everything here must be registered synchronously at
// top level so Chrome can wake the worker for these events.

const driver = new ChromeDriver();

const manager = new RunManager({
  driver,
  persistence: { saveRun, saveArtifact },
  getWorkflow,
  getRun,
  listRuns: () => listRuns(),
  recordLastRun,
  pruneHistory,
  getSettings,
  openMonitor: (runId) => void chrome.tabs.create({ url: chrome.runtime.getURL(`app.html#/runs/${runId}`) }),
  tabExists: (tabId) => chrome.tabs.get(tabId).then(() => true, () => false),
  // Any extension API call resets the service worker idle timer.
  keepAlive: () => void chrome.runtime.getPlatformInfo(),
});

const recorder = new RecorderManager({
  load: async () => (await chrome.storage.session.get(RECORDING_KEY))[RECORDING_KEY] as RecordingSession | undefined,
  save: (session) => (session ? chrome.storage.session.set({ [RECORDING_KEY]: session }) : chrome.storage.session.remove(RECORDING_KEY)),
  createTab: async (url) => {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) throw new FlowError('UNKNOWN', 'Could not open a tab for recording');
    return tab.id;
  },
  control: (tabId, control) => driver.control(tabId, control),
  tabUrl: (tabId) => chrome.tabs.get(tabId).then((t) => t.url ?? t.pendingUrl, () => undefined),
  setBadge: (tabId, recording) => {
    void chrome.action.setBadgeText({ tabId, text: recording ? 'REC' : '' }).catch(() => undefined);
    if (recording) void chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => undefined);
  },
  now: () => Date.now(),
});

const picker = new PickerManager({
  tabAlive: (tabId) => chrome.tabs.get(tabId).then(() => true, () => false),
  createTab: async (url) => {
    const tab = await chrome.tabs.create({ url, active: true });
    if (tab.id === undefined) throw new FlowError('UNKNOWN', 'Could not open a tab to pick on');
    return tab.id;
  },
  waitLoaded: async (tabId) => {
    for (let i = 0; i < 120; i++) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
      await new Promise((r) => setTimeout(r, 250));
    }
  },
  activate: async (tabId) => {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
  },
  control: (tabId, control) => driver.control(tabId, control),
  saveResult: (result) => chrome.storage.session.set({ [PICK_RESULT_KEY]: result }),
});

const ready = manager.recover().catch((err) => console.error('[FlowPilot] recovery failed', err));

async function handle(command: Command, senderTab?: number): Promise<CommandResultMap[Command['type']]> {
  await ready;
  switch (command.type) {
    case 'run.start':
      return { runId: await manager.start(command.workflowId, command.target, command.inputs, command.table) };
    case 'run.testStep':
      return { runId: await manager.testStep(command.workflowId, command.stepId, command.inputs) };
    case 'run.pause':
      return manager.pause(command.runId), null;
    case 'run.resume':
      return manager.resume(command.runId), null;
    case 'run.stop':
      return manager.stop(command.runId), null;
    case 'run.resumeInterrupted':
      return { runId: await manager.resumeInterrupted(command.runId, command.inputs) };
    case 'prompt.respond':
      return manager.respond(command.runId, command.promptId, command.response), null;
    case 'runs.active':
      return { runIds: manager.activeRunIds() };
    case 'recorder.start': {
      const target = command.url ? { url: command.url } : command.tabId !== undefined ? { tabId: command.tabId } : null;
      if (!target) throw new FlowError('UNKNOWN', 'Choose a page to record', true);
      return { sessionId: (await recorder.start(target)).id };
    }
    case 'recorder.stop':
      return await recorder.stop(), null;
    case 'recorder.discard':
      return await recorder.discard(), null;
    case 'recorder.reattach':
      return await recorder.reattach(), null;
    case 'picker.start':
      return await picker.start({ url: command.url, mode: command.mode, requestId: command.requestId, editorTab: senderTab }), null;
  }
}

const extensionOrigin = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== COMMAND_CHANNEL) return false;
  // Only extension pages may issue commands; content scripts and web pages may not.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(extensionOrigin)) return false;
  handle(message.command as Command, sender.tab?.id).then(
    (data) => sendResponse({ ok: true, data } satisfies CommandResponse<Command['type']>),
    (err) => sendResponse({ ok: false, error: serializeError(err) } satisfies CommandResponse<Command['type']>),
  );
  return true;
});

// Recorder events come from the content script in the recorded tab only.
chrome.runtime.onMessage.addListener((message, sender) => {
  const msg = message as RecorderMessage;
  if (!msg || msg.channel !== RECORDER_CHANNEL || sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return false;
  if (msg.type === 'event') void recorder.record(sender.tab.id, msg.event);
  else if (msg.type === 'stopFromPage') void recorder.stop();
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  void recorder.isRecordingTab(tabId).then((watched) => {
    if (!watched) return;
    if (info.url) void recorder.onTabUrl(tabId, info.url);
    if (info.status === 'complete') void recorder.onTabComplete(tabId);
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const msg = message as PickerMessage;
  if (!msg || msg.channel !== PICKER_CHANNEL || sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return false;
  void picker.onMessage(sender.tab.id, msg);
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void picker.onTabClosed(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void recorder.isRecordingTab(tabId).then((watched) => {
    if (watched) void recorder.onTabClosed(tabId);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MONITOR_PORT || !port.sender?.url?.startsWith(extensionOrigin)) return;
  const remove = manager.addPort(port);
  port.onDisconnect.addListener(remove);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#/') });
});
