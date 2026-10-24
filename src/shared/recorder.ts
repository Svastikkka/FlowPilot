import type { Locator, Step, VariableDef } from './schema/types';
import type { RecordedEvent } from './recorderProtocol';

export { RECORDER_CHANNEL } from './recorderProtocol';
export type { RecordedEvent, RecorderControl, RecorderMessage } from './recorderProtocol';
import { createStep, describeLocator } from './schema/actions';
import { VARIABLE_NAME_RE } from './schema/zod';

// Recording: the content script reports user actions in the recorded tab as
// RecordedEvents; the service worker folds them into editable steps here.

export const RECORDING_KEY = 'recording';

/** Maximum steps in one recording (matches the workflow step limit). */
export const MAX_RECORDED_STEPS = 500;

/** A click or Enter this recent probably caused the next navigation. */
const NAVIGATION_CAUSE_WINDOW_MS = 2_500;
/** Address changes this soon after another are redirects or URL rewrites (e.g. tracking parameters). */
const URL_REWRITE_WINDOW_MS = 1_500;
/** A navigation to the page a recently clicked link points at was caused by that click. */
const LINK_CAUSE_WINDOW_MS = 15_000;
const DOUBLE_CLICK_WINDOW_MS = 400;

export interface RecordingSession {
  id: string;
  tabId: number;
  status: 'recording' | 'stopped';
  startUrl: string;
  startedAt: number;
  lastEventAt: number;
  steps: Step[];
  variables: VariableDef[];
  /** Host the recorder couldn't attach to (no site access). */
  blockedHost?: string;
  /** Set when the limit was reached and further actions were ignored. */
  truncated?: boolean;
  /** When the tab's address last changed (recorded or not). */
  lastNavigateAt?: number;
  /** The most recently clicked link, used to attribute single-page-app navigations to it. */
  lastLink?: { url: string; at: number };
}

/** Origin + path: query strings and fragments are often rewritten by sites. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

const sameLocator = (a?: Locator, b?: Locator) => !!a && !!b && a.strategy === b.strategy && a.value === b.value;
const truncate = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A variable name for a sensitive field, e.g. "password" or "password_2". */
function secretVariable(field: string, existing: VariableDef[]): VariableDef {
  let base = field.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'secret';
  if (!VARIABLE_NAME_RE.test(base)) base = `secret_${base}`.slice(0, 60);
  let name = base;
  for (let i = 2; existing.some((v) => v.name === name); i++) name = `${base}_${i}`;
  return { name, defaultValue: '', description: `Recorded from the "${truncate(field, 60)}" field — entered at run start, never saved`, askAtRunStart: true, secret: true };
}

/**
 * Folds one event into the session. Returns the same session object (mutated)
 * for convenience. Consecutive edits to one field become one step.
 */
export function appendEvent(session: RecordingSession, event: RecordedEvent): RecordingSession {
  const steps = session.steps;
  const last = steps[steps.length - 1];
  const sinceLast = event.at - session.lastEventAt;
  const push = (step: Step) => {
    if (steps.length >= MAX_RECORDED_STEPS) {
      session.truncated = true;
      return;
    }
    steps.push(step);
  };

  switch (event.kind) {
    case 'navigate': {
      // Navigations caused by a recorded click or Enter replay on their own.
      const causedByAction = last && (last.type === 'click' || (last.type === 'type' && last.params.pressEnter)) && sinceLast < NAVIGATION_CAUSE_WINDOW_MS;
      const causedByLink = !!session.lastLink && pageKey(session.lastLink.url) === pageKey(event.url) && event.at - session.lastLink.at < LINK_CAUSE_WINDOW_MS;
      const rewrite = session.lastNavigateAt !== undefined && event.at - session.lastNavigateAt < URL_REWRITE_WINDOW_MS;
      const sameAsLast = last?.type === 'openUrl' && pageKey(last.params.url) === pageKey(event.url);
      session.lastNavigateAt = event.at;
      if (causedByLink) session.lastLink = undefined;
      if (!causedByAction && !causedByLink && !rewrite && !sameAsLast) push(createStep('openUrl', { params: { url: event.url } }) as Step);
      break;
    }
    case 'click': {
      if (last?.type === 'click' && sameLocator(last.params.locator, event.locator) && sinceLast < DOUBLE_CLICK_WINDOW_MS) break;
      if (event.href) session.lastLink = { url: event.href, at: event.at };
      push(createStep('click', { name: event.label ? `Click “${truncate(event.label)}”` : undefined, params: { locator: event.locator } }) as Step);
      break;
    }
    case 'input': {
      let text = event.value;
      if (event.sensitive) {
        // Never store the value: ask for it at run time instead.
        const existing = last?.type === 'type' && sameLocator(last.params.locator, event.locator) ? /^\{\{(\w+)\}\}$/.exec(last.params.text)?.[1] : undefined;
        const variable = existing ? session.variables.find((v) => v.name === existing) : undefined;
        const v = variable ?? secretVariable(event.field, session.variables);
        if (!variable) session.variables.push(v);
        text = `{{${v.name}}}`;
      }
      if (last?.type === 'type' && sameLocator(last.params.locator, event.locator)) {
        last.params.text = text;
      } else {
        push(
          createStep('type', {
            name: `Type in ${truncate(event.field || describeLocator(event.locator))}`,
            params: { locator: event.locator, text, clearFirst: true, pressEnter: false },
          }) as Step,
        );
      }
      break;
    }
    case 'enter': {
      if (last?.type === 'type' && sameLocator(last.params.locator, event.locator)) last.params.pressEnter = true;
      break;
    }
    case 'select': {
      if (last?.type === 'select' && sameLocator(last.params.locator, event.locator)) last.params.value = event.label;
      else push(createStep('select', { params: { locator: event.locator, by: 'label', value: event.label } }) as Step);
      break;
    }
    case 'check': {
      if (last?.type === 'check' && sameLocator(last.params.locator, event.locator)) last.params.checked = event.checked;
      else push(createStep('check', { params: { locator: event.locator, checked: event.checked } }) as Step);
      break;
    }
  }
  session.lastEventAt = event.at;
  return session;
}

export function newSession(id: string, tabId: number, startUrl: string, now: number): RecordingSession {
  const session: RecordingSession = { id, tabId, status: 'recording', startUrl, startedAt: now, lastEventAt: 0, steps: [], variables: [] };
  if (/^https?:/i.test(startUrl)) appendEvent(session, { kind: 'navigate', url: startUrl, at: now });
  return session;
}
