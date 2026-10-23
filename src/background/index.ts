import { ChromeDriver } from './chromeDriver';
import { RunManager } from './runManager';
import { COMMAND_CHANNEL, MONITOR_PORT } from '../shared/messages';
import type { Command, CommandResponse, CommandResultMap } from '../shared/messages';
import { serializeError } from '../shared/errors';
import { getRun, listRuns, pruneHistory, saveArtifact, saveRun } from '../storage/runs';
import { getWorkflow, recordLastRun } from '../storage/workflows';
import { getSettings } from '../storage/settings';

// Service worker entry. Everything here must be registered synchronously at
// top level so Chrome can wake the worker for these events.

const manager = new RunManager({
  driver: new ChromeDriver(),
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

const ready = manager.recover().catch((err) => console.error('[FlowPilot] recovery failed', err));

async function handle(command: Command): Promise<CommandResultMap[Command['type']]> {
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
  }
}

const extensionOrigin = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== COMMAND_CHANNEL) return false;
  // Only extension pages may issue commands; content scripts and web pages may not.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(extensionOrigin)) return false;
  handle(message.command as Command).then(
    (data) => sendResponse({ ok: true, data } satisfies CommandResponse<Command['type']>),
    (err) => sendResponse({ ok: false, error: serializeError(err) } satisfies CommandResponse<Command['type']>),
  );
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MONITOR_PORT || !port.sender?.url?.startsWith(extensionOrigin)) return;
  const remove = manager.addPort(port);
  port.onDisconnect.addListener(remove);
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('app.html#/') });
});
