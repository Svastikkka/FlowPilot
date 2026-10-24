import { DOM_CHANNEL } from '../shared/messages';
import type { DomMessage, DomResponse } from '../shared/messages';
import { serializeError } from '../shared/errors';
import { performDomRequest } from './domActions';
import { startRecorder } from './recorder';
import type { RecorderHandle } from './recorder';
import { RECORDER_CHANNEL } from '../shared/recorderProtocol';
import { PICKER_CHANNEL } from '../shared/pickerProtocol';
import type { PickerControl, PickerMessage } from '../shared/pickerProtocol';
import { startPicker } from './picker';
import type { PickerHandle } from './picker';
import type { RecorderControl, RecorderMessage } from '../shared/recorderProtocol';

// Injected on demand into the run tab only. Re-injection (e.g. after the
// extension reloads) replaces the previous listener instead of adding another.

type Listener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
const KEY = '__flowpilotDomListener';
const scope = globalThis as unknown as Record<string, Listener | undefined>;

const previous = scope[KEY];
if (previous) {
  try {
    chrome.runtime.onMessage.removeListener(previous);
  } catch {
    // The previous extension context is gone; nothing to remove.
  }
}

const RECORDER_KEY = '__flowpilotRecorder';
const recorderScope = globalThis as unknown as Record<string, RecorderHandle | undefined>;

const sendToWorker = (message: RecorderMessage) => chrome.runtime.sendMessage(message).catch(() => undefined);

function handleRecorder(control: RecorderControl) {
  recorderScope[RECORDER_KEY]?.stop();
  recorderScope[RECORDER_KEY] = undefined;
  if (control.cmd === 'start') {
    recorderScope[RECORDER_KEY] = startRecorder(
      document,
      (event) => void sendToWorker({ channel: RECORDER_CHANNEL, type: 'event', event }),
      () => void sendToWorker({ channel: RECORDER_CHANNEL, type: 'stopFromPage' }),
    );
  }
}

const PICKER_KEY = '__flowpilotPicker';
const pickerScope = globalThis as unknown as Record<string, PickerHandle | undefined>;
const sendPick = (message: PickerMessage) => chrome.runtime.sendMessage(message).catch(() => undefined);

function handlePicker(control: PickerControl) {
  pickerScope[PICKER_KEY]?.stop();
  pickerScope[PICKER_KEY] = undefined;
  if (control.cmd === 'start') {
    pickerScope[PICKER_KEY] = startPicker(
      document,
      control.mode,
      (r) => void sendPick({ channel: PICKER_CHANNEL, type: 'picked', ...r }),
      () => void sendPick({ channel: PICKER_CHANNEL, type: 'cancelled' }),
    );
  }
}

const listener: Listener = (message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message && (message as PickerControl).channel === PICKER_CHANNEL) {
    handlePicker(message as PickerControl);
    sendResponse({ ok: true });
    return false;
  }
  if (message && (message as RecorderControl).channel === RECORDER_CHANNEL) {
    handleRecorder(message as RecorderControl);
    sendResponse({ ok: true });
    return false;
  }
  const msg = message as DomMessage;
  if (!msg || msg.channel !== DOM_CHANNEL) return false;
  let response: DomResponse;
  try {
    response = { ok: true, data: performDomRequest(document, msg.request) };
  } catch (err) {
    response = { ok: false, error: serializeError(err) };
  }
  sendResponse(response);
  return false;
};

scope[KEY] = listener;
chrome.runtime.onMessage.addListener(listener);
