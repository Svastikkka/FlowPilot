import type { DomRequest, DomResultMap } from '../shared/messages';
import type { Locator } from '../shared/schema/types';
import { describeLocator } from '../shared/schema/actions';
import { FlowError } from '../shared/errors';
import { findAll, findOne, isEnabled, isInput, isSelect, isTextArea, isVisible, visibleText } from './locator';

// Fixed set of DOM operations performed in the run tab. Each operation
// verifies its effect where the DOM allows it and reports only what it could
// verify. Typed text is never included in results.

type Editable = HTMLInputElement | HTMLTextAreaElement;

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'hidden', 'range', 'color']);
const SENSITIVE_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/;

function requireElement(doc: Document, locator: Locator, opts: { visible?: boolean; enabled?: boolean } = {}): Element {
  const el = findOne(doc, locator);
  if (!el) throw new FlowError('ELEMENT_NOT_FOUND', `No element matches ${describeLocator(locator)}`);
  if (opts.visible && !isVisible(el)) throw new FlowError('ELEMENT_NOT_VISIBLE', `${describeLocator(locator)} exists but is not visible`);
  if (opts.enabled && !isEnabled(el)) throw new FlowError('ELEMENT_DISABLED', `${describeLocator(locator)} is disabled`);
  return el;
}

function scrollIntoView(el: Element) {
  // jsdom and some embedded documents lack scrollIntoView.
  if (typeof (el as HTMLElement).scrollIntoView === 'function') {
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  }
}

function highlight(el: Element) {
  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const box = doc.createElement('div');
  box.setAttribute('data-flowpilot-highlight', '');
  Object.assign(box.style, {
    position: 'fixed',
    left: `${rect.left - 3}px`,
    top: `${rect.top - 3}px`,
    width: `${rect.width + 6}px`,
    height: `${rect.height + 6}px`,
    border: '2px solid #6366f1',
    borderRadius: '4px',
    background: 'rgba(99,102,241,0.12)',
    zIndex: '2147483647',
    pointerEvents: 'none',
  });
  doc.documentElement.appendChild(box);
  setTimeout(() => box.remove(), 700);
}

function fire(el: Element, type: string, init: EventInit = {}) {
  const view = el.ownerDocument.defaultView!;
  let event: Event;
  if (type.startsWith('pointer') && typeof view.PointerEvent === 'function') {
    event = new view.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  } else if (type.startsWith('mouse')) {
    event = new view.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  } else if (type.startsWith('key')) {
    event = new view.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  } else if (type === 'input' && typeof view.InputEvent === 'function') {
    event = new view.InputEvent(type, { bubbles: true, composed: true, ...init });
  } else {
    event = new view.Event(type, { bubbles: true, ...init });
  }
  return el.dispatchEvent(event);
}

/** Sets a value through the native setter so framework-controlled inputs see it. */
function setNativeValue(el: Editable, value: string) {
  const view = el.ownerDocument.defaultView!;
  const proto = isTextArea(el) ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function asEditable(el: Element, locator: Locator): Editable | HTMLElement {
  if (isTextArea(el)) return el;
  if (isInput(el)) {
    if (NON_TEXT_INPUTS.has(el.type)) {
      throw new FlowError('ELEMENT_WRONG_TYPE', `${describeLocator(locator)} is a ${el.type} input and cannot take text`, true);
    }
    return el;
  }
  const editableAttr = el.getAttribute('contenteditable');
  if ((el as HTMLElement).isContentEditable || (editableAttr !== null && editableAttr !== 'false')) return el as HTMLElement;
  throw new FlowError('ELEMENT_WRONG_TYPE', `${describeLocator(locator)} is not a text field`, true);
}

function isSensitiveField(el: Element): boolean {
  return (
    (isInput(el) && el.type === 'password') ||
    SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') ?? '')
  );
}

function clearValue(el: Editable | HTMLElement) {
  if (isInput(el) || isTextArea(el)) {
    setNativeValue(el, '');
  } else {
    el.textContent = '';
  }
  fire(el, 'input', { inputType: 'deleteContentBackward' } as InputEventInit);
}

function pressEnter(el: Element) {
  const keyInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 } as KeyboardEventInit;
  const notCancelled = fire(el, 'keydown', keyInit);
  fire(el, 'keypress', keyInit);
  fire(el, 'keyup', keyInit);
  // Synthetic key events do not trigger implicit submission; replicate it.
  if (notCancelled && isInput(el) && el.form) {
    if (typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
    else el.form.submit();
  }
}

export function performDomRequest<R extends DomRequest>(doc: Document, req: R): DomResultMap[R['op']] {
  return perform(doc, req) as DomResultMap[R['op']];
}

function perform(doc: Document, req: DomRequest): DomResultMap[keyof DomResultMap] {
  switch (req.op) {
    case 'probe': {
      const all = findAll(doc, req.locator);
      const first = all.find(isVisible) ?? all[0];
      return { count: all.length, visible: !!first && isVisible(first), enabled: !!first && isEnabled(first) };
    }

    case 'click': {
      const el = requireElement(doc, req.locator, { visible: true, enabled: true });
      scrollIntoView(el);
      if (req.highlight) highlight(el);
      fire(el, 'pointerdown');
      fire(el, 'mousedown');
      if (typeof (el as HTMLElement).focus === 'function') (el as HTMLElement).focus();
      fire(el, 'pointerup');
      fire(el, 'mouseup');
      (el as HTMLElement).click();
      return { message: `Clicked ${describeLocator(req.locator)}` };
    }

    case 'type': {
      const el = asEditable(requireElement(doc, req.locator, { visible: true, enabled: true }), req.locator);
      if ((el as HTMLInputElement).readOnly) throw new FlowError('ELEMENT_DISABLED', `${describeLocator(req.locator)} is read-only`);
      scrollIntoView(el);
      if (req.highlight) highlight(el);
      el.focus();
      const sensitive = isSensitiveField(el);
      if (isInput(el) || isTextArea(el)) {
        const next = req.clearFirst ? req.text : el.value + req.text;
        setNativeValue(el, next);
        fire(el, 'input', { inputType: 'insertText', data: sensitive ? null : req.text } as InputEventInit);
        fire(el, 'change');
        if (el.value !== next) {
          throw new FlowError(
            'VERIFICATION_FAILED',
            `${describeLocator(req.locator)} did not accept the text (the page changed or limited the value)`,
          );
        }
      } else {
        if (req.clearFirst) el.textContent = '';
        el.textContent = (el.textContent ?? '') + req.text;
        fire(el, 'input', { inputType: 'insertText' } as InputEventInit);
        if (!(el.textContent ?? '').includes(req.text)) {
          throw new FlowError('VERIFICATION_FAILED', `${describeLocator(req.locator)} did not accept the text`);
        }
      }
      if (req.pressEnter) pressEnter(el);
      const len = req.text.length;
      return {
        sensitive,
        message: `Entered ${sensitive ? 'a value' : `${len} character${len === 1 ? '' : 's'}`} into ${describeLocator(req.locator)} (verified)${req.pressEnter ? ' and pressed Enter' : ''}`,
      };
    }

    case 'clear': {
      const el = asEditable(requireElement(doc, req.locator, { visible: true, enabled: true }), req.locator);
      if (req.highlight) highlight(el);
      clearValue(el);
      fire(el, 'change');
      const remaining = isInput(el) || isTextArea(el) ? el.value : el.textContent;
      if (remaining) throw new FlowError('VERIFICATION_FAILED', `${describeLocator(req.locator)} still has a value after clearing`);
      return { message: `Cleared ${describeLocator(req.locator)} (verified)` };
    }

    case 'select': {
      const el = requireElement(doc, req.locator, { visible: true, enabled: true });
      if (!isSelect(el)) {
        throw new FlowError('ELEMENT_WRONG_TYPE', `${describeLocator(req.locator)} is not a dropdown (<select>)`, true);
      }
      if (req.highlight) highlight(el);
      const options = Array.from(el.options);
      let index = -1;
      if (req.by === 'index') index = Number(req.value);
      else if (req.by === 'value') index = options.findIndex((o) => o.value === req.value);
      else {
        const want = req.value.trim().toLowerCase();
        index = options.findIndex((o) => o.text.trim().toLowerCase() === want);
        if (index < 0) index = options.findIndex((o) => o.text.trim().toLowerCase().includes(want));
      }
      if (!(index >= 0 && index < options.length)) {
        throw new FlowError('OPTION_NOT_FOUND', `No option matching "${req.value}" (by ${req.by}) in ${describeLocator(req.locator)}`);
      }
      if (options[index].disabled) throw new FlowError('ELEMENT_DISABLED', `Option "${options[index].text}" is disabled`);
      el.focus();
      el.selectedIndex = index;
      fire(el, 'input');
      fire(el, 'change');
      if (el.selectedIndex !== index) throw new FlowError('VERIFICATION_FAILED', 'The page reverted the selection');
      return { message: `Selected "${options[index].text.trim()}" (verified)` };
    }

    case 'check': {
      const el = requireElement(doc, req.locator, { enabled: true });
      if (!(isInput(el)) || (el.type !== 'checkbox' && el.type !== 'radio')) {
        throw new FlowError('ELEMENT_WRONG_TYPE', `${describeLocator(req.locator)} is not a checkbox or radio button`, true);
      }
      if (el.type === 'radio' && !req.checked) {
        throw new FlowError('ELEMENT_WRONG_TYPE', 'A radio button cannot be unchecked directly; select another option instead', true);
      }
      if (req.highlight) highlight(el);
      if (el.checked !== req.checked) {
        // Custom-styled checkboxes are often visually hidden; click the label if so.
        const target = !isVisible(el) && el.labels?.[0] && isVisible(el.labels[0]) ? el.labels[0] : el;
        scrollIntoView(target);
        (target as HTMLElement).click();
      }
      if (el.checked !== req.checked) throw new FlowError('VERIFICATION_FAILED', `${describeLocator(req.locator)} did not change state`);
      return { message: `${req.checked ? 'Checked' : 'Unchecked'} ${describeLocator(req.locator)} (verified)` };
    }

    case 'extractText': {
      const all = findAll(doc, req.locator);
      if (!all.length) throw new FlowError('ELEMENT_NOT_FOUND', `No element matches ${describeLocator(req.locator)}`);
      const els = req.all ? all.filter(isVisible) : [all.find(isVisible) ?? all[0]];
      if (els.some(isSensitiveField)) {
        throw new FlowError('ELEMENT_WRONG_TYPE', 'FlowPilot does not read password or payment fields', true);
      }
      const text = els.map(visibleText).join('\n');
      return { text, count: els.length };
    }

    case 'scroll': {
      const win = doc.defaultView!;
      if (req.mode === 'element') {
        const el = requireElement(doc, req.locator!, {});
        scrollIntoView(el);
        return { message: `Scrolled to ${describeLocator(req.locator)}` };
      }
      const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0);
      const [x, y] = req.mode === 'top' ? [0, 0] : req.mode === 'bottom' ? [0, height] : [req.x ?? 0, req.y ?? 0];
      win.scrollTo({ left: x, top: y, behavior: 'instant' as ScrollBehavior });
      return { message: `Scrolled to ${req.mode === 'position' ? `${x}, ${y}` : `the ${req.mode} of the page`} (now at ${Math.round(win.scrollY)}px)` };
    }

    case 'markNth': {
      // Tags the nth match so steps inside a "For each element" loop can target it.
      const mark = req.mark.replace(/[^A-Za-z0-9_-]/g, '');
      for (const el of Array.from(doc.querySelectorAll(`[data-flowpilot-item="${mark}"]`))) el.removeAttribute('data-flowpilot-item');
      const all = findAll(doc, req.locator);
      const el = all[req.index];
      if (!el) return { found: false, total: all.length, text: '' };
      el.setAttribute('data-flowpilot-item', mark);
      return { found: true, total: all.length, text: isSensitiveField(el) ? '' : visibleText(el) };
    }

    case 'pageInfo':
      return { url: doc.location.href, title: doc.title, readyState: doc.readyState };

    case 'textPresent': {
      const body = doc.body;
      const text = body ? (typeof body.innerText === 'string' ? body.innerText : body.textContent ?? '') : '';
      return { present: text.replace(/\s+/g, ' ').toLowerCase().includes(req.text.replace(/\s+/g, ' ').trim().toLowerCase()) };
    }
  }
}
