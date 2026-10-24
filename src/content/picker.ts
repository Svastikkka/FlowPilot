import type { Locator } from '../shared/schema/types';
import type { PickMode } from '../shared/pickerProtocol';
import { bestLocator, cssEscape, cssPath } from './recorder';
import { isInput, isSelect, isTextArea, visibleText } from './locator';

// Point-and-click element picker. Shows an outline and a plain-language label
// for the element under the mouse; a click picks it, Esc cancels. While
// picking, clicks never reach the page.

const HOST_ID = 'flowpilot-picker';
const MAX_BOXES = 200;
const normalize = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A description a non-technical user recognises, e.g. Button “Save”. */
export function describeElement(el: Element): string {
  const text = short(normalize(isInput(el) ? el.value || el.placeholder : visibleText(el).split('\n')[0]));
  const label = short(normalize((isInput(el) || isSelect(el) || isTextArea(el) ? el.labels?.[0]?.textContent : '') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name')));
  const quoted = (kind: string, value: string) => (value ? `${kind} “${value}”` : kind);
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  if (isInput(el) && el.type === 'checkbox') return quoted('Checkbox', label || text);
  if (isInput(el) && el.type === 'radio') return quoted('Option', label || el.value);
  if (isInput(el) && ['submit', 'button', 'reset'].includes(el.type)) return quoted('Button', el.value);
  if (isInput(el) || isTextArea(el)) return quoted('Field', label);
  if (isSelect(el)) return quoted('Dropdown', label);
  if (tag === 'button' || role === 'button') return quoted('Button', text || label);
  if (tag === 'a') return quoted('Link', text || label);
  if (tag === 'img') return quoted('Image', normalize(el.getAttribute('alt')));
  if (/^h[1-6]$/.test(tag)) return quoted('Heading', text);
  if (tag === 'tr') return quoted('Table row', text);
  if (tag === 'li') return quoted('List item', text);
  return text ? quoted('Text', text) : `“${tag}” element`;
}

/** Stable class names only (skip generated ones like css-1x2y3z or sc-abc123). */
function stableClasses(el: Element): string[] {
  return Array.from(el.classList)
    .filter((c) => /^[A-Za-z][\w-]*$/.test(c) && !/\d{3,}|^(css|sc|jsx|emotion|svelte)-|^_/.test(c))
    .slice(0, 2);
}

const segment = (el: Element) => el.tagName.toLowerCase() + stableClasses(el).map((c) => `.${cssEscape(c)}`).join('');

function containerSelector(doc: Document, el: Element): string {
  const best = bestLocator(doc, el);
  return best.strategy === 'css' ? best.value : cssPath(doc, el);
}

/**
 * Generalises a picked element to "all items like it": finds the nearest
 * ancestor (or the element itself) that repeats among its siblings, and
 * returns a selector for all of those siblings.
 */
export function similarLocator(doc: Document, el: Element): { locator: Locator; count: number; item: Element } {
  let node: Element | null = el;
  for (let depth = 0; node && node.parentElement && depth < 6; depth++, node = node.parentElement) {
    const seg = segment(node);
    const siblings = Array.from(node.parentElement.children).filter((c) => c.matches(seg));
    if (siblings.length >= 2 && node.parentElement !== doc.body && node.parentElement !== doc.documentElement) {
      const selector = `${containerSelector(doc, node.parentElement)} > ${seg}`;
      const count = doc.querySelectorAll(selector).length;
      if (count >= 2) return { locator: { strategy: 'css', value: selector }, count, item: node };
    }
  }
  return { locator: bestLocator(doc, el), count: 1, item: el };
}

export interface PickResultData {
  locator: Locator;
  description: string;
  count: number;
}

export interface PickerHandle {
  stop(): void;
}

export function startPicker(doc: Document, mode: PickMode, onPick: (r: PickResultData) => void, onCancel: () => void): PickerHandle {
  doc.getElementById(HOST_ID)?.remove();
  const host = doc.createElement('div');
  host.id = HOST_ID;
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:10px 12px 10px 16px;border-radius:12px;background:#1f1d2e;color:#fff;font:600 14px/1.3 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:auto;max-width:90vw}
    .bar small{display:block;font-weight:400;opacity:.8;font-size:12px}
    button{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:#4f46e5;font-weight:700}
    button:focus-visible{outline:2px solid #fff}
    .box{position:fixed;border:2px solid #6366f1;background:rgba(99,102,241,.14);border-radius:4px;pointer-events:none}
    .box.extra{border-style:dashed;background:rgba(99,102,241,.07)}
    .tip{position:fixed;padding:4px 8px;border-radius:6px;background:#4f46e5;color:#fff;font:600 12px/1.2 system-ui,sans-serif;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
  </style>
  <div class="bar" role="dialog" aria-label="FlowPilot element picker"><div>🎯 ${mode === 'multiple' ? 'Click one of the items to repeat over' : 'Click the element to use'}<small>Esc to cancel · clicks won't reach the page</small></div><button type="button">Cancel</button></div>
  <div class="layer"></div>`;
  const layer = root.querySelector('.layer')!;
  root.querySelector('button')!.addEventListener('click', (e) => {
    e.stopPropagation();
    finish();
    onCancel();
  });
  doc.documentElement.appendChild(host);

  const ours = (e: Event) => e.composedPath().includes(host);
  const targetOf = (e: Event) => {
    const t = e.target as Element | null;
    return t && t.nodeType === 1 && t !== doc.documentElement && t !== doc.body ? t : null;
  };

  const box = (el: Element, extra = false) => {
    const r = el.getBoundingClientRect();
    const d = doc.createElement('div');
    d.className = extra ? 'box extra' : 'box';
    Object.assign(d.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    layer.appendChild(d);
    return r;
  };

  let current: Element | null = null;
  const show = (el: Element) => {
    if (el === current) return;
    current = el;
    layer.replaceChildren();
    let label = describeElement(el);
    let focus = el;
    if (mode === 'multiple') {
      const sim = similarLocator(doc, el);
      focus = sim.item;
      Array.from(doc.querySelectorAll(sim.locator.value))
        .slice(0, MAX_BOXES)
        .forEach((m) => m !== focus && box(m, true));
      label = sim.count > 1 ? `${sim.count} similar items — ${describeElement(focus)}` : `${describeElement(focus)} (no similar items found)`;
    }
    const r = box(focus);
    const tip = doc.createElement('div');
    tip.className = 'tip';
    tip.textContent = label;
    Object.assign(tip.style, { left: `${Math.max(4, r.left)}px`, top: `${r.top > 30 ? r.top - 26 : r.bottom + 6}px` });
    layer.appendChild(tip);
  };

  const swallow = (e: Event) => {
    if (ours(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  const onMove = (e: Event) => {
    if (ours(e)) return;
    const el = targetOf(e);
    if (el) show(el);
  };
  const onClick = (e: Event) => {
    if (ours(e)) return;
    swallow(e);
    const el = targetOf(e);
    if (!el) return;
    finish();
    if (mode === 'multiple') {
      const sim = similarLocator(doc, el);
      onPick({ locator: sim.locator, description: sim.count > 1 ? `${sim.count} items like ${describeElement(sim.item)}` : describeElement(sim.item), count: sim.count });
    } else {
      onPick({ locator: bestLocator(doc, el), description: describeElement(el), count: 1 });
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    swallow(e);
    finish();
    onCancel();
  };

  const types = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu', 'submit'];
  doc.addEventListener('mouseover', onMove, true);
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  types.forEach((t) => doc.addEventListener(t, swallow, true));

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    doc.removeEventListener('mouseover', onMove, true);
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    types.forEach((t) => doc.removeEventListener(t, swallow, true));
    host.remove();
  }
  return { stop: finish };
}
