import type { Locator } from '../shared/schema/types';
import type { RecordedEvent } from '../shared/recorderProtocol';
import { findAll, isInput, isSelect, isTextArea, visibleText } from './locator';

// Records user actions in the page while a recording session is active.
// Only attached to the tab being recorded, only between start and stop.

const BADGE_ID = 'flowpilot-recording-badge';
const SENSITIVE_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-|csc/i;
const SENSITIVE_NAME = /pass(word|wd)?|\bpin\b|otp|one.?time|secret|token|cvv|cvc|card.?num|security.?code/i;
const CLICK_TARGET = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], summary';
const TEXT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week', '']);

export const cssEscape = (value: string) =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
const attrValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const normalize = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** IDs that look generated (long digit runs, hashes) change between page loads. */
/**
 * IDs written by people look like words ("email", "user-name", "step2").
 * Generated ones (frameworks, CSS-in-JS, bundlers) mix letters and digits
 * ("f-1q2vb91", ":r3:", "ember412") or carry long digit runs and hashes.
 */
export const stableId = (id: string) =>
  /^[A-Za-z][\w-]{0,50}$/.test(id) &&
  !/\d{4,}|[0-9a-f]{8,}|^(ember|react|radix|mui|headlessui)/i.test(id) &&
  id.split(/[-_]/).every((part) => /^[A-Za-z]+\d{0,2}$|^\d{1,3}$/.test(part));

function uniqueCss(doc: Document, selector: string, el: Element): boolean {
  try {
    const found = doc.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

function matchesOnly(doc: Document, locator: Locator, el: Element): boolean {
  try {
    const found = findAll(doc, locator);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

export function cssPath(doc: Document, el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== doc.documentElement && parts.length < 6; node = node.parentElement) {
    // Anchor at an ancestor id only if it is really unique (some sites reuse ids).
    if (node !== el && node.id && stableId(node.id) && uniqueCss(doc, `#${cssEscape(node.id)}`, node)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    const selector = parts.join(' > ');
    if (uniqueCss(doc, selector, el)) return selector;
  }
  return parts.join(' > ');
}

/** The most stable locator that matches exactly this element. */
export function bestLocator(doc: Document, el: Element): Locator {
  for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(attr);
    if (v) {
      const selector = `[${attr}="${attrValue(v)}"]`;
      if (uniqueCss(doc, selector, el)) return { strategy: 'css', value: selector };
    }
  }
  // Form fields: the name is what the server receives, so it rarely changes.
  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  if (name && (isInput(el) || isSelect(el) || isTextArea(el) || tag === 'button')) {
    const type = isInput(el) && (el.type === 'radio' || el.type === 'checkbox') ? `[value="${attrValue(el.value)}"]` : '';
    const selector = `${tag}[name="${attrValue(name)}"]${type}`;
    if (uniqueCss(doc, selector, el)) return { strategy: 'css', value: selector };
  }

  if (el.id && stableId(el.id) && uniqueCss(doc, `#${cssEscape(el.id)}`, el)) return { strategy: 'css', value: `#${cssEscape(el.id)}` };

  // Links are best identified by where they go.
  const href = el.tagName === 'A' ? el.getAttribute('href') : null;
  if (href && href.length <= 300 && !/^(#|javascript:)/i.test(href)) {
    const selector = `a[href="${attrValue(href)}"]`;
    if (uniqueCss(doc, selector, el)) return { strategy: 'css', value: selector };
  }

  const aria = normalize(el.getAttribute('aria-label'));
  if (aria && aria.length <= 60 && matchesOnly(doc, { strategy: 'label', value: aria }, el)) return { strategy: 'label', value: aria };

  if (el.matches(CLICK_TARGET)) {
    const text = isInput(el) ? normalize(el.value) : normalize(el.textContent);
    if (text && text.length <= 40 && matchesOnly(doc, { strategy: 'text', value: text }, el)) return { strategy: 'text', value: text };
  }

  if (isInput(el) || isSelect(el) || isTextArea(el)) {
    const label = normalize(el.labels?.[0]?.textContent ?? el.getAttribute('placeholder'));
    if (label && label.length <= 60 && matchesOnly(doc, { strategy: 'label', value: label }, el)) return { strategy: 'label', value: label };
  }

  return { strategy: 'css', value: cssPath(doc, el) };
}

function isSensitive(el: Element): boolean {
  if (isInput(el) && el.type === 'password') return true;
  if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')) return true;
  return SENSITIVE_NAME.test(`${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''}`);
}

const isTextField = (el: Element) =>
  (isInput(el) && TEXT_TYPES.has(el.type)) || isTextArea(el) || (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true';

function fieldName(el: Element): string {
  return normalize(
    (isInput(el) || isTextArea(el) || isSelect(el) ? el.labels?.[0]?.textContent : '') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      el.id ||
      el.tagName.toLowerCase(),
  ).slice(0, 60);
}

function showBadge(doc: Document, onStop: () => void) {
  if (doc.getElementById(BADGE_ID)) return;
  const host = doc.createElement('div');
  host.id = BADGE_ID;
  Object.assign(host.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647' });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .b{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 12px;border-radius:999px;background:#1f1d2e;color:#fff;font:600 13px/1 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    .d{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:p 1.4s ease-in-out infinite}
    @keyframes p{50%{opacity:.35}} @media (prefers-reduced-motion: reduce){.d{animation:none}}
    button{all:unset;cursor:pointer;padding:5px 10px;border-radius:999px;background:#ef4444;font-weight:700}
    button:focus-visible{outline:2px solid #fff}
  </style><div class="b" role="status" aria-live="polite"><span class="d" aria-hidden="true"></span>Recording · FlowPilot<button type="button">Stop</button></div>`;
  root.querySelector('button')!.addEventListener('click', (e) => {
    e.stopPropagation();
    onStop();
  });
  doc.documentElement.appendChild(host);
}

export interface RecorderHandle {
  stop(): void;
}

/**
 * Starts listening. `emit` receives every recorded action; `onStopRequested`
 * fires when the user presses Stop on the page badge.
 */
export function startRecorder(
  doc: Document,
  emit: (event: RecordedEvent) => void,
  onStopRequested: () => void,
  /** Ignore events the page dispatches itself (tests disable this). */
  { requireTrusted = true }: { requireTrusted?: boolean } = {},
): RecorderHandle {
  const win = doc.defaultView!;
  const untrusted = (e: Event) => requireTrusted && !e.isTrusted;
  const now = () => Date.now();
  const fromBadge = (e: Event) => e.composedPath().some((n) => (n as Element).id === BADGE_ID);

  const onClick = (e: MouseEvent) => {
    if (untrusted(e) || fromBadge(e) || !(e.target instanceof win.Element)) return;
    const target = e.target as Element;
    // Fields, dropdowns and checkboxes are recorded from their change events.
    if (target.closest('input, textarea, select, option, [contenteditable="true"]')) {
      const input = target.closest('input');
      if (!input || !['submit', 'button', 'reset', 'image'].includes((input as HTMLInputElement).type)) return;
    }
    const label = target.closest('label');
    if (label && ((label as HTMLLabelElement).control || label.querySelector('input'))) return;
    const el = target.closest(CLICK_TARGET) ?? target;
    const href = el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined;
    emit({
      kind: 'click',
      locator: bestLocator(doc, el),
      label: (isInput(el) ? normalize(el.value) : visibleText(el).split('\n')[0]).slice(0, 60),
      at: now(),
      ...(href && /^https?:/i.test(href) ? { href } : {}),
    });
  };

  const onChange = (e: Event) => {
    if (untrusted(e) || fromBadge(e)) return;
    const el = e.target as Element;
    if (isSelect(el)) {
      emit({ kind: 'select', locator: bestLocator(doc, el), label: normalize(el.selectedOptions[0]?.text ?? el.value), at: now() });
    } else if (isInput(el) && (el.type === 'checkbox' || el.type === 'radio')) {
      emit({ kind: 'check', locator: bestLocator(doc, el), checked: el.checked, at: now() });
    } else if (isTextField(el)) {
      emitInput(el);
    }
  };

  const emitInput = (el: Element) => {
    const sensitive = isSensitive(el);
    const value = sensitive ? '' : isInput(el) || isTextArea(el) ? el.value : normalize(el.textContent);
    emit({ kind: 'input', locator: bestLocator(doc, el), value, sensitive, field: fieldName(el), at: now() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (untrusted(e) || e.key !== 'Enter' || fromBadge(e)) return;
    const el = e.target as Element;
    if (!isTextField(el) || isTextArea(el)) return;
    // Enter may submit before "change" fires, so record the value first.
    emitInput(el);
    emit({ kind: 'enter', locator: bestLocator(doc, el), at: now() });
  };

  // Contenteditable elements don't fire "change"; record them when focus leaves.
  const onFocusOut = (e: FocusEvent) => {
    const el = e.target as Element;
    if (!untrusted(e) && el && !isInput(el) && !isTextArea(el) && isTextField(el) && !fromBadge(e)) emitInput(el);
  };

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('change', onChange, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusout', onFocusOut, true);
  showBadge(doc, onStopRequested);

  return {
    stop() {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('focusout', onFocusOut, true);
      doc.getElementById(BADGE_ID)?.remove();
    },
  };
}
