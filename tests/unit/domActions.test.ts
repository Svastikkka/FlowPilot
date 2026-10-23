import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performDomRequest } from '../../src/content/domActions';
import { findAll, findOne } from '../../src/content/locator';
import { FlowError } from '../../src/shared/errors';
import type { Locator } from '../../src/shared/schema/types';

const css = (value: string): Locator => ({ strategy: 'css', value });

function render(html: string) {
  document.body.innerHTML = html;
}

function expectFlowError(fn: () => unknown, code: string, fatal?: boolean) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).code).toBe(code);
    if (fatal !== undefined) expect((err as FlowError).fatal).toBe(fatal);
    return err as FlowError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('locator', () => {
  beforeEach(() =>
    render(`
      <div class="card"><span>Save changes</span><button id="save">Save</button></div>
      <label for="email">E-mail address</label><input id="email" />
      <label>Phone <input id="phone" /></label>
      <input aria-label="Search the site" id="search" />
      <input placeholder="Your city" id="city" />
      <span id="lbl">Postcode</span><input aria-labelledby="lbl" id="zip" />
      <input type="submit" value="Send it" id="send" />
      <ul><li>One</li><li>Two</li></ul>
    `),
  );

  it('finds by CSS selector', () => {
    expect(findOne(document, css('#save'))?.id).toBe('save');
    expect(findAll(document, css('li'))).toHaveLength(2);
  });

  it('rejects invalid CSS as a fatal error', () => {
    expectFlowError(() => findAll(document, css('div[')), 'INVALID_SELECTOR', true);
  });

  it('finds by XPath', () => {
    expect(findOne(document, { strategy: 'xpath', value: '//li[2]' })?.textContent).toBe('Two');
    expectFlowError(() => findAll(document, { strategy: 'xpath', value: '//[' }), 'INVALID_SELECTOR', true);
  });

  it('finds by visible text, preferring interactive elements and exact matches', () => {
    expect(findOne(document, { strategy: 'text', value: 'save' })?.id).toBe('save');
    expect(findOne(document, { strategy: 'text', value: 'Send it' })?.id).toBe('send');
    expect(findOne(document, { strategy: 'text', value: 'Two' })?.tagName).toBe('LI');
  });

  it('finds form controls by label, aria-label, aria-labelledby and placeholder', () => {
    const byLabel = (value: string) => findOne(document, { strategy: 'label', value })?.id;
    expect(byLabel('E-mail address')).toBe('email');
    expect(byLabel('phone')).toBe('phone');
    expect(byLabel('Search the site')).toBe('search');
    expect(byLabel('Your city')).toBe('city');
    expect(byLabel('Postcode')).toBe('zip');
  });

  it('prefers a visible match over a hidden one', () => {
    render('<button style="display:none" id="a">Go</button><button id="b">Go</button>');
    expect(findOne(document, { strategy: 'text', value: 'Go' })?.id).toBe('b');
  });
});

describe('probe', () => {
  it('reports count, visibility and enabled state', () => {
    render('<button id="a" disabled>A</button><div hidden><button id="b">B</button></div>');
    expect(performDomRequest(document, { op: 'probe', locator: css('#a') })).toEqual({ count: 1, visible: true, enabled: false });
    expect(performDomRequest(document, { op: 'probe', locator: css('#b') })).toEqual({ count: 1, visible: false, enabled: true });
    expect(performDomRequest(document, { op: 'probe', locator: css('#c') })).toEqual({ count: 0, visible: false, enabled: false });
  });
});

describe('click', () => {
  it('dispatches pointer and mouse events and activates the element', () => {
    render('<button id="go">Go</button>');
    const events: string[] = [];
    const btn = document.getElementById('go')!;
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click']) btn.addEventListener(t, () => events.push(t));
    const result = performDomRequest(document, { op: 'click', locator: css('#go') });
    expect(events).toEqual(['pointerdown', 'mousedown', 'mouseup', 'click']);
    expect(result.message).toBe('Clicked #go');
  });

  it('refuses hidden and disabled elements', () => {
    render('<button id="h" style="visibility:hidden">H</button><button id="d" disabled>D</button>');
    expectFlowError(() => performDomRequest(document, { op: 'click', locator: css('#h') }), 'ELEMENT_NOT_VISIBLE');
    expectFlowError(() => performDomRequest(document, { op: 'click', locator: css('#d') }), 'ELEMENT_DISABLED');
    expectFlowError(() => performDomRequest(document, { op: 'click', locator: css('#nope') }), 'ELEMENT_NOT_FOUND');
  });

  it('treats elements inside a disabled fieldset as disabled', () => {
    render('<fieldset disabled><button id="b">B</button></fieldset>');
    expectFlowError(() => performDomRequest(document, { op: 'click', locator: css('#b') }), 'ELEMENT_DISABLED');
  });
});

describe('type', () => {
  it('sets the value through the native setter, fires input/change and verifies', () => {
    render('<input id="q" value="old" />');
    const input = document.getElementById('q') as HTMLInputElement;
    const seen: string[] = [];
    input.addEventListener('input', () => seen.push(`input:${input.value}`));
    input.addEventListener('change', () => seen.push('change'));
    const r = performDomRequest(document, { op: 'type', locator: css('#q'), text: 'new', clearFirst: true, pressEnter: false });
    expect(input.value).toBe('new');
    expect(seen).toEqual(['input:new', 'change']);
    expect(r).toEqual({ sensitive: false, message: 'Entered 3 characters into #q (verified)' });
  });

  it('appends when clearFirst is false', () => {
    render('<textarea id="t">abc</textarea>');
    performDomRequest(document, { op: 'type', locator: css('#t'), text: 'def', clearFirst: false, pressEnter: false });
    expect((document.getElementById('t') as HTMLTextAreaElement).value).toBe('abcdef');
  });

  it('never echoes typed text and flags password fields as sensitive', () => {
    render('<input id="pw" type="password" />');
    const r = performDomRequest(document, { op: 'type', locator: css('#pw'), text: 'hunter2', clearFirst: true, pressEnter: false });
    expect(r.sensitive).toBe(true);
    expect(r.message).not.toContain('hunter2');
    expect(r.message).toContain('a value');
  });

  it('fails verification when the page rejects the value', () => {
    render('<input id="n" />');
    const input = document.getElementById('n') as HTMLInputElement;
    input.addEventListener('input', () => (input.value = input.value.replace(/\D/g, '')));
    expectFlowError(
      () => performDomRequest(document, { op: 'type', locator: css('#n'), text: 'abc', clearFirst: true, pressEnter: false }),
      'VERIFICATION_FAILED',
    );
  });

  it('presses Enter by submitting the enclosing form', () => {
    render('<form id="f"><input id="q" /></form>');
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.getElementById('f')!.addEventListener('submit', onSubmit);
    const r = performDomRequest(document, { op: 'type', locator: css('#q'), text: 'x', clearFirst: true, pressEnter: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(r.message).toContain('pressed Enter');
  });

  it('does not submit when the page cancels the Enter keydown', () => {
    render('<form id="f"><input id="q" /></form>');
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    document.getElementById('f')!.addEventListener('submit', onSubmit);
    document.getElementById('q')!.addEventListener('keydown', (e) => e.preventDefault());
    performDomRequest(document, { op: 'type', locator: css('#q'), text: 'x', clearFirst: true, pressEnter: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('types into contenteditable elements', () => {
    render('<div id="ed" contenteditable="true">x</div>');
    performDomRequest(document, { op: 'type', locator: css('#ed'), text: 'hello', clearFirst: true, pressEnter: false });
    expect(document.getElementById('ed')!.textContent).toBe('hello');
  });

  it('rejects non-text targets and read-only fields', () => {
    render('<input id="c" type="checkbox" /><div id="d">text</div><input id="r" readonly />');
    expectFlowError(() => performDomRequest(document, { op: 'type', locator: css('#c'), text: 'x', clearFirst: true, pressEnter: false }), 'ELEMENT_WRONG_TYPE', true);
    expectFlowError(() => performDomRequest(document, { op: 'type', locator: css('#d'), text: 'x', clearFirst: true, pressEnter: false }), 'ELEMENT_WRONG_TYPE', true);
    expectFlowError(() => performDomRequest(document, { op: 'type', locator: css('#r'), text: 'x', clearFirst: true, pressEnter: false }), 'ELEMENT_DISABLED');
  });
});

describe('clear', () => {
  it('empties the field and verifies', () => {
    render('<input id="q" value="something" />');
    expect(performDomRequest(document, { op: 'clear', locator: css('#q') }).message).toBe('Cleared #q (verified)');
    expect((document.getElementById('q') as HTMLInputElement).value).toBe('');
  });
});

describe('select', () => {
  beforeEach(() =>
    render(`<select id="s"><option value="">Choose</option><option value="nl">Netherlands</option><option value="in">India</option><option value="x" disabled>Closed</option></select>`),
  );
  const sel = () => document.getElementById('s') as HTMLSelectElement;

  it.each([
    ['label', 'india', 'in'],
    ['label', 'Nether', 'nl'],
    ['value', 'nl', 'nl'],
    ['index', '2', 'in'],
  ] as const)('selects by %s "%s"', (by, value, expected) => {
    const onChange = vi.fn();
    sel().addEventListener('change', onChange);
    performDomRequest(document, { op: 'select', locator: css('#s'), by, value });
    expect(sel().value).toBe(expected);
    expect(onChange).toHaveBeenCalled();
  });

  it('reports missing, disabled and wrong-type targets', () => {
    expectFlowError(() => performDomRequest(document, { op: 'select', locator: css('#s'), by: 'label', value: 'Peru' }), 'OPTION_NOT_FOUND');
    expectFlowError(() => performDomRequest(document, { op: 'select', locator: css('#s'), by: 'value', value: 'x' }), 'ELEMENT_DISABLED');
    render('<input id="i" />');
    expectFlowError(() => performDomRequest(document, { op: 'select', locator: css('#i'), by: 'value', value: 'x' }), 'ELEMENT_WRONG_TYPE', true);
  });
});

describe('check', () => {
  it('checks and unchecks a checkbox with verification', () => {
    render('<input id="c" type="checkbox" />');
    const box = document.getElementById('c') as HTMLInputElement;
    performDomRequest(document, { op: 'check', locator: css('#c'), checked: true });
    expect(box.checked).toBe(true);
    // Idempotent: already checked stays checked.
    performDomRequest(document, { op: 'check', locator: css('#c'), checked: true });
    expect(box.checked).toBe(true);
    performDomRequest(document, { op: 'check', locator: css('#c'), checked: false });
    expect(box.checked).toBe(false);
  });

  it('clicks the label of a visually hidden custom checkbox', () => {
    render('<input id="c" type="checkbox" style="opacity:0" /><label for="c">Agree</label>');
    performDomRequest(document, { op: 'check', locator: css('#c'), checked: true });
    expect((document.getElementById('c') as HTMLInputElement).checked).toBe(true);
  });

  it('refuses to uncheck a radio button', () => {
    render('<input id="r" type="radio" checked />');
    expectFlowError(() => performDomRequest(document, { op: 'check', locator: css('#r'), checked: false }), 'ELEMENT_WRONG_TYPE', true);
  });

  it('fails verification if the page prevents the change', () => {
    render('<input id="c" type="checkbox" />');
    document.getElementById('c')!.addEventListener('click', (e) => e.preventDefault());
    expectFlowError(() => performDomRequest(document, { op: 'check', locator: css('#c'), checked: true }), 'VERIFICATION_FAILED');
  });
});

describe('extractText and page info', () => {
  it('extracts normalized visible text from one or all matches', () => {
    render('<p class="x">  Hello\n   world  </p><p class="x">Second</p><p class="x" hidden>Hidden</p>');
    expect(performDomRequest(document, { op: 'extractText', locator: css('.x'), all: false })).toEqual({ text: 'Hello\nworld', count: 1 });
    expect(performDomRequest(document, { op: 'extractText', locator: css('.x'), all: true })).toEqual({ text: 'Hello\nworld\nSecond', count: 2 });
  });

  it('reads the value of form fields', () => {
    render('<input id="i" value="typed" /><select id="s"><option>A</option><option selected>B</option></select>');
    expect(performDomRequest(document, { op: 'extractText', locator: css('#i'), all: false }).text).toBe('typed');
    expect(performDomRequest(document, { op: 'extractText', locator: css('#s'), all: false }).text).toBe('B');
  });

  it('refuses to read password fields', () => {
    render('<input id="pw" type="password" value="secret" />');
    expectFlowError(() => performDomRequest(document, { op: 'extractText', locator: css('#pw'), all: false }), 'ELEMENT_WRONG_TYPE', true);
  });

  it('returns page info and detects text on the page', () => {
    document.title = 'My page';
    render('<main>Order   confirmed</main>');
    expect(performDomRequest(document, { op: 'pageInfo' })).toMatchObject({ title: 'My page', url: expect.stringContaining('http') });
    expect(performDomRequest(document, { op: 'textPresent', text: 'order confirmed' })).toEqual({ present: true });
    expect(performDomRequest(document, { op: 'textPresent', text: 'failed' })).toEqual({ present: false });
  });

  it('scrolls to an element', () => {
    render('<div id="far">far</div>');
    expect(performDomRequest(document, { op: 'scroll', mode: 'element', locator: css('#far') }).message).toBe('Scrolled to #far');
  });
});
