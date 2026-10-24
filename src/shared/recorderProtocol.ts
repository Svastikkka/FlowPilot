import type { Locator } from './schema/types';

// Message protocol between the recorder content script and the service
// worker. Kept free of runtime imports so the injected content script stays small.

export const RECORDER_CHANNEL = 'flowpilot.recorder';

export type RecordedEvent =
  | { kind: 'click'; locator: Locator; label: string; at: number; /** Absolute URL, when the click target is a link. */ href?: string }
  | { kind: 'input'; locator: Locator; value: string; sensitive: boolean; field: string; at: number }
  | { kind: 'enter'; locator: Locator; at: number }
  | { kind: 'select'; locator: Locator; label: string; at: number }
  | { kind: 'check'; locator: Locator; checked: boolean; at: number }
  | { kind: 'navigate'; url: string; at: number };

/** Messages from the content script's recorder to the service worker. */
export type RecorderMessage =
  | { channel: typeof RECORDER_CHANNEL; type: 'event'; event: RecordedEvent }
  | { channel: typeof RECORDER_CHANNEL; type: 'stopFromPage' };

/** Commands from the service worker to the content script. */
export type RecorderControl = { channel: typeof RECORDER_CHANNEL; cmd: 'start' | 'stop' };
