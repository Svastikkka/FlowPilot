import { DOM_CHANNEL } from '../shared/messages';
import type { DomMessage, DomResponse } from '../shared/messages';
import { serializeError } from '../shared/errors';
import { performDomRequest } from './domActions';

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

const listener: Listener = (message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
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
