import type { Locator } from '../shared/schema/types';
import { FlowError } from '../shared/errors';

// Resolves a Locator to elements. Supports CSS selectors, XPath, visible text
// and accessible labels. None of these evaluate page or workflow code.

// Tag-based guards work across realms (iframes, separate test documents),
// unlike instanceof checks against the global constructors.
export const isInput = (el: Element): el is HTMLInputElement => el.tagName === 'INPUT';
export const isTextArea = (el: Element): el is HTMLTextAreaElement => el.tagName === 'TEXTAREA';
export const isSelect = (el: Element): el is HTMLSelectElement => el.tagName === 'SELECT';

const normalize = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function visibleText(el: Element): string {
  if (isInput(el) || isTextArea(el)) return el.value;
  if (isSelect(el)) return el.selectedOptions[0]?.text ?? '';
  const html = el as HTMLElement;
  // innerText respects CSS visibility; jsdom does not implement it.
  const text = typeof html.innerText === 'string' ? html.innerText : el.textContent;
  return (text ?? '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function isVisible(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: (o?: object) => boolean };
  if (typeof anyEl.checkVisibility === 'function') {
    if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    // Real browsers lay out elements; zero-area elements cannot be seen or clicked.
    const rects = el.getClientRects();
    return rects.length > 0 && Array.from(rects).some((r) => r.width > 0 || r.height > 0);
  }
  // Fallback (older engines, jsdom): walk the ancestor chain checking styles.
  const view = el.ownerDocument.defaultView;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if ((node as HTMLElement).hidden) return false;
    if (isInput(node) && node.type === 'hidden') return false;
    const style = view?.getComputedStyle(node);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
  }
  return true;
}

export function isEnabled(el: Element): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('fieldset:disabled')) return false;
  return el.getAttribute('aria-disabled') !== 'true';
}

function byCss(doc: Document, selector: string): Element[] {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch {
    throw new FlowError('INVALID_SELECTOR', `"${selector}" is not a valid CSS selector`, true);
  }
}

function byXPath(doc: Document, expression: string): Element[] {
  let snapshot: XPathResult;
  try {
    snapshot = doc.evaluate(expression, doc, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
  } catch {
    throw new FlowError('INVALID_SELECTOR', `"${expression}" is not a valid XPath expression`, true);
  }
  const out: Element[] = [];
  for (let i = 0; i < snapshot.snapshotLength; i++) {
    const node = snapshot.snapshotItem(i);
    if (node && node.nodeType === 1) out.push(node as Element);
  }
  return out;
}

const CLICKABLE = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], input[type="reset"], label, summary, option';

function byText(doc: Document, text: string): Element[] {
  const target = normalize(text);
  if (!target) return [];
  const root = doc.body ?? doc.documentElement;
  const exact: Element[] = [];
  const partial: Element[] = [];

  const textOf = (el: Element) =>
    isInput(el) && (el.type === 'submit' || el.type === 'button' || el.type === 'reset')
      ? normalize(el.value)
      : normalize(el.textContent);

  // Interactive elements first: "click text=Save" should hit the button, not its wrapper.
  for (const el of Array.from(root.querySelectorAll(CLICKABLE))) {
    const t = textOf(el);
    if (t === target) exact.push(el);
    else if (t.includes(target)) partial.push(el);
  }
  if (exact.length) return exact;

  // Otherwise the deepest elements whose text matches.
  const all = Array.from(root.querySelectorAll('*')).filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(el.tagName));
  const deepest = (els: Element[]) => els.filter((el) => !els.some((other) => other !== el && el.contains(other)));
  const exactAny = deepest(all.filter((el) => textOf(el) === target));
  if (exactAny.length) return exactAny;
  if (partial.length) return partial;
  return deepest(all.filter((el) => textOf(el).includes(target)));
}

function byLabel(doc: Document, label: string): Element[] {
  const target = normalize(label);
  if (!target) return [];
  const results = new Set<Element>();
  const add = (el: Element | null | undefined) => el && results.add(el);

  for (const el of Array.from(doc.querySelectorAll('[aria-label]'))) {
    if (normalize(el.getAttribute('aria-label')) === target) add(el);
  }
  for (const el of Array.from(doc.querySelectorAll('[aria-labelledby]'))) {
    const text = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (normalize(text) === target) add(el);
  }
  for (const lab of Array.from(doc.querySelectorAll('label'))) {
    if (normalize(lab.textContent) === target || normalize(lab.textContent).startsWith(target)) {
      add(lab.control ?? (lab.htmlFor ? doc.getElementById(lab.htmlFor) : lab.querySelector('input, select, textarea')));
    }
  }
  for (const el of Array.from(doc.querySelectorAll('[placeholder], [title]'))) {
    if (normalize(el.getAttribute('placeholder')) === target || normalize(el.getAttribute('title')) === target) add(el);
  }
  return Array.from(results);
}

export function findAll(doc: Document, locator: Locator): Element[] {
  switch (locator.strategy) {
    case 'css':
      return byCss(doc, locator.value);
    case 'xpath':
      return byXPath(doc, locator.value);
    case 'text':
      return byText(doc, locator.value);
    case 'label':
      return byLabel(doc, locator.value);
  }
}

/** First visible match, else first match, else null. */
export function findOne(doc: Document, locator: Locator): Element | null {
  const all = findAll(doc, locator);
  return all.find(isVisible) ?? all[0] ?? null;
}
