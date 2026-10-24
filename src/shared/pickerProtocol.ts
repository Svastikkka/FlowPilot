import type { Locator } from './schema/types';

// Element picker protocol between the editor, the service worker and the
// content script. Runtime-import free so the injected script stays small.

export const PICKER_CHANNEL = 'flowpilot.picker';
export const PICK_RESULT_KEY = 'pickResult';

/** single: one element; multiple: one element generalised to all similar items. */
export type PickMode = 'single' | 'multiple';

export type PickerControl = { channel: typeof PICKER_CHANNEL; cmd: 'start'; mode: PickMode } | { channel: typeof PICKER_CHANNEL; cmd: 'stop' };

export type PickerMessage =
  | { channel: typeof PICKER_CHANNEL; type: 'picked'; locator: Locator; description: string; count: number }
  | { channel: typeof PICKER_CHANNEL; type: 'cancelled' };

/** Written to chrome.storage.session for the editor that asked. */
export interface PickResult {
  requestId: string;
  locator?: Locator;
  description?: string;
  count?: number;
  cancelled?: boolean;
  error?: string;
}
