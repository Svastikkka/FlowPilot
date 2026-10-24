import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, newSession } from '../../src/shared/recorder';
import type { RecordedEvent, RecordingSession } from '../../src/shared/recorder';
import { bestLocator, startRecorder } from '../../src/content/recorder';
import { findAll } from '../../src/content/locator';
import { RecorderManager } from '../../src/background/recorderManager';
import type { RecorderDeps } from '../../src/background/recorderManager';
import { FlowError } from '../../src/shared/errors';
import { validateWorkflow } from '../../src/shared/schema/validate';
import { newWorkflow } from '../../src/shared/schema/factory';

const css = (value: string) => ({ strategy: 'css' as const, value });

describe('appendEvent', () => {
  const session = () => newSession('r1', 1, 'https://shop.test/', 1_000);

  it('starts with an Open URL step for the start page', () => {
    expect(session().steps.map((s) => s.type)).toEqual(['openUrl']);
  });

  it('merges repeated edits of one field and records Enter on it', () => {
    const s = session();
    appendEvent(s, { kind: 'input', locator: css('#q'), value: 'soc', sensitive: false, field: 'Search', at: 2000 });
    appendEvent(s, { kind: 'input', locator: css('#q'), value: 'socks', sensitive: false, field: 'Search', at: 2100 });
    appendEvent(s, { kind: 'enter', locator: css('#q'), at: 2200 });
    expect(s.steps).toHaveLength(2);
    expect(s.steps[1]).toMatchObject({ type: 'type', name: 'Type in Search', params: { text: 'socks', pressEnter: true, clearFirst: true } });
  });

  it('never stores sensitive values: they become secret variables asked at run time', () => {
    const s = session();
    appendEvent(s, { kind: 'input', locator: css('#pw'), value: '', sensitive: true, field: 'Password', at: 2000 });
    appendEvent(s, { kind: 'input', locator: css('#pw'), value: '', sensitive: true, field: 'Password', at: 2050 });
    appendEvent(s, { kind: 'input', locator: css('#pw2'), value: '', sensitive: true, field: 'Password', at: 2100 });
    expect(s.steps.slice(1).map((x) => x.type === 'type' && x.params.text)).toEqual(['{{password}}', '{{password_2}}']);
    expect(s.variables).toEqual([
      expect.objectContaining({ name: 'password', secret: true, askAtRunStart: true, defaultValue: '' }),
      expect.objectContaining({ name: 'password_2', secret: true }),
    ]);
  });

  it('ignores navigations caused by a recorded click or Enter, but records typed addresses', () => {
    const s = session();
    appendEvent(s, { kind: 'click', locator: { strategy: 'text', value: 'Shop' }, label: 'Shop', at: 2000 });
    appendEvent(s, { kind: 'navigate', url: 'https://shop.test/products', at: 2600 });
    appendEvent(s, { kind: 'navigate', url: 'https://other.test/', at: 9000 });
    expect(s.steps.map((x) => x.type)).toEqual(['openUrl', 'click', 'openUrl']);
    expect(s.steps[1].name).toBe('Click “Shop”');
  });

  it('collapses single-page-app address rewrites and link navigations (sequence from a real YouTube recording)', () => {
    const s = newSession('r', 1, 'https://www.youtube.com/@Svastikkka/shorts', 1_000);
    const nav = (url: string, at: number) => appendEvent(s, { kind: 'navigate', url, at });
    nav('https://www.youtube.com/@Svastikkka/shorts', 1_100); // load of the start page
    nav('https://www.youtube.com/@Svastikkka/shorts?ab_channel=Svastikkka', 1_400); // rewrite
    appendEvent(s, {
      kind: 'click',
      locator: { strategy: 'css', value: 'a[href="/shorts/UkDF4knpM0g"]' },
      label: '',
      href: 'https://www.youtube.com/shorts/UkDF4knpM0g',
      at: 10_000,
    });
    nav('https://www.youtube.com/shorts/UkDF4knpM0g', 13_500); // SPA navigation, slower than 2.5 s
    nav('https://www.youtube.com/shorts/UkDF4knpM0g?ab_channel=Svastikkka', 13_700); // rewrite
    nav('https://www.youtube.com/shorts/XbG5E3UmUUA', 30_000); // user scrolled to the next Short
    nav('https://www.youtube.com/shorts/XbG5E3UmUUA?ab_channel=Svastikkka', 30_200); // rewrite
    expect(s.steps.map((x) => (x.type === 'openUrl' ? `open ${x.params.url}` : x.type))).toEqual([
      'open https://www.youtube.com/@Svastikkka/shorts',
      'click',
      'open https://www.youtube.com/shorts/XbG5E3UmUUA',
    ]);
  });

  it('still records a genuinely new address on the same site', () => {
    const s = newSession('r', 1, 'https://shop.test/search?q=socks', 1_000);
    appendEvent(s, { kind: 'navigate', url: 'https://shop.test/cart', at: 20_000 });
    expect(s.steps.map((x) => x.type === 'openUrl' && x.params.url)).toEqual(['https://shop.test/search?q=socks', 'https://shop.test/cart']);
  });

  it('drops double clicks, merges select and checkbox changes', () => {
    const s = session();
    appendEvent(s, { kind: 'click', locator: css('#b'), label: 'B', at: 2000 });
    appendEvent(s, { kind: 'click', locator: css('#b'), label: 'B', at: 2100 });
    appendEvent(s, { kind: 'select', locator: css('#size'), label: 'Small', at: 3000 });
    appendEvent(s, { kind: 'select', locator: css('#size'), label: 'Large', at: 3100 });
    appendEvent(s, { kind: 'check', locator: css('#t'), checked: true, at: 4000 });
    appendEvent(s, { kind: 'check', locator: css('#t'), checked: false, at: 4100 });
    expect(s.steps.slice(1).map((x) => [x.type, x.type === 'select' ? x.params.value : x.type === 'check' ? x.params.checked : '-'])).toEqual([
      ['click', '-'],
      ['select', 'Large'],
      ['check', false],
    ]);
  });

  it('caps the number of recorded steps', () => {
    const s = session();
    for (let i = 0; i < 600; i++) appendEvent(s, { kind: 'click', locator: css(`#b${i}`), label: '', at: 2000 + i * 1000 });
    expect(s.steps).toHaveLength(500);
    expect(s.truncated).toBe(true);
  });

  it('produces workflows that pass validation', () => {
    const s = session();
    appendEvent(s, { kind: 'input', locator: css('#user'), value: 'ada', sensitive: false, field: 'User', at: 2000 });
    appendEvent(s, { kind: 'input', locator: css('#pw'), value: '', sensitive: true, field: 'Password', at: 2100 });
    appendEvent(s, { kind: 'click', locator: { strategy: 'text', value: 'Sign in' }, label: 'Sign in', at: 2200 });
    expect(validateWorkflow(newWorkflow({ steps: s.steps, variables: s.variables })).errors).toEqual([]);
  });
});

describe('bestLocator', () => {
  const unique = (el: Element) => {
    const loc = bestLocator(document, el);
    const found = findAll(document, loc);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(el);
    return loc;
  };

  it('prefers test ids, then stable ids, then form names', () => {
    document.body.innerHTML = `
      <button data-testid="save-btn">Save</button>
      <input id="email"><input id="react-select-48213-input">
      <form><input name="city"><input type="radio" name="size" value="s"><input type="radio" name="size" value="m"></form>`;
    expect(unique(document.querySelector('[data-testid]')!)).toEqual(css('[data-testid="save-btn"]'));
    expect(unique(document.getElementById('email')!)).toEqual(css('#email'));
    expect(unique(document.querySelector('[name="city"]')!)).toEqual(css('input[name="city"]'));
    expect(unique(document.querySelectorAll('[name="size"]')[1])).toEqual(css('input[name="size"][value="m"]'));
    // Generated-looking ids are skipped.
    expect(unique(document.getElementById('react-select-48213-input')!).value).not.toContain('48213');
  });

  it('identifies links by where they go, and ignores duplicate ids when building CSS paths', () => {
    document.body.innerHTML = `
      <div id="content"><div class="card"><a href="/shorts/aaa"><span>One</span></a></div></div>
      <div id="content"><div class="card"><a href="/shorts/bbb"><span>Two</span></a></div></div>
      <div id="content"><div class="card"><span class="x">plain</span></div></div>
      <div id="content"><div class="card"><span class="x">plain</span></div></div>`;
    expect(unique(document.querySelectorAll('a')[1])).toEqual(css('a[href="/shorts/bbb"]'));
    const second = document.querySelectorAll('span.x')[1];
    expect(unique(second).value).not.toMatch(/^#content/);
  });

  it('uses visible text for buttons and links, and labels for fields', () => {
    document.body.innerHTML = `
      <nav><a href="/a">Pricing</a><a href="/b">Docs</a></nav>
      <label for="x-1234567">Company name</label><input id="x-1234567">
      <button>Go</button><button>Go</button><button>Checkout</button>`;
    expect(unique(document.querySelector('a[href="/b"]')!)).toEqual(css('a[href="/b"]'));
    expect(unique(document.getElementById('x-1234567')!)).toEqual({ strategy: 'label', value: 'Company name' });
    expect(unique(document.querySelectorAll('button')[2])).toEqual({ strategy: 'text', value: 'Checkout' });
    // Two identical buttons: falls back to a unique CSS path.
    const second = document.querySelectorAll('button')[1];
    expect(unique(second).strategy).toBe('css');
  });
});

describe('startRecorder', () => {
  let events: RecordedEvent[];
  let stopRequested: number;
  const handles: { stop(): void }[] = [];
  const record = () => {
    const h = startRecorder(document, (e) => events.push(e), () => stopRequested++, { requireTrusted: false });
    handles.push(h);
    return h;
  };
  afterEach(() => handles.splice(0).forEach((h) => h.stop()));

  beforeEach(() => {
    events = [];
    stopRequested = 0;
    document.body.innerHTML = `
      <form id="f">
        <label for="name">Name</label><input id="name">
        <input id="pw" type="password">
        <select id="plan"><option>Free</option><option>Pro</option></select>
        <label><input id="terms" type="checkbox"> I agree</label>
        <button id="send" type="submit">Send</button>
      </form>`;
    document.getElementById('f')!.addEventListener('submit', (e) => e.preventDefault());
  });

  const fire = (el: Element, type: string, init: EventInit & { key?: string } = {}) =>
    el.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { bubbles: true, ...init }) : type === 'click' ? new MouseEvent(type, { bubbles: true, ...init }) : new Event(type, { bubbles: true, ...init }));

  it('captures typing, choices and clicks, and shows a badge while recording', () => {
    const handle = record();
    expect(document.getElementById('flowpilot-recording-badge')).not.toBeNull();
    const name = document.getElementById('name') as HTMLInputElement;
    name.value = 'Ada';
    fire(name, 'change');
    const plan = document.getElementById('plan') as HTMLSelectElement;
    plan.selectedIndex = 1;
    fire(plan, 'change');
    // A click toggles the checkbox; it's recorded from the resulting change event, not as a click.
    fire(document.getElementById('terms')!, 'click');
    fire(document.getElementById('send')!, 'click');
    expect(events.map((e) => e.kind)).toEqual(['input', 'select', 'check', 'click']);
    expect(events[0]).toMatchObject({ value: 'Ada', sensitive: false, field: 'Name', locator: css('#name') });
    expect(events[1]).toMatchObject({ label: 'Pro' });
    expect(events[2]).toMatchObject({ checked: true, locator: css('#terms') });
    expect(events[3]).toMatchObject({ locator: css('#send'), label: 'Send' });
    handle.stop();
    expect(document.getElementById('flowpilot-recording-badge')).toBeNull();
    fire(document.getElementById('send')!, 'click');
    expect(events).toHaveLength(4);
  });

  it('never reads password values', () => {
    record();
    const pw = document.getElementById('pw') as HTMLInputElement;
    pw.value = 'hunter2';
    fire(pw, 'change');
    expect(events).toEqual([expect.objectContaining({ kind: 'input', sensitive: true, value: '' })]);
    expect(JSON.stringify(events)).not.toContain('hunter2');
  });

  it('records the value before Enter submits', () => {
    record();
    const name = document.getElementById('name') as HTMLInputElement;
    name.value = 'Grace';
    fire(name, 'keydown', { key: 'Enter' });
    expect(events.map((e) => e.kind)).toEqual(['input', 'enter']);
  });

  it('ignores clicks on its own badge and lets it request stop', () => {
    record();
    const badge = document.getElementById('flowpilot-recording-badge')!;
    (badge.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
    expect(stopRequested).toBe(1);
    expect(events).toEqual([]);
  });

  it('ignores page-dispatched events when trusted events are required', () => {
    handles.push(startRecorder(document, (e) => events.push(e), () => undefined));
    fire(document.getElementById('send')!, 'click');
    expect(events).toEqual([]);
  });
});

describe('RecorderManager', () => {
  function setup(opts: { failAttach?: FlowError } = {}) {
    let stored: RecordingSession | undefined;
    let clock = 0;
    const controls: [number, string][] = [];
    const badges: [number, boolean][] = [];
    const deps: RecorderDeps = {
      load: async () => (stored ? structuredClone(stored) : undefined),
      save: async (s) => void (stored = s && structuredClone(s)),
      createTab: async () => 42,
      control: vi.fn(async (tabId, c) => {
        if (opts.failAttach && c.cmd === 'start') throw opts.failAttach;
        controls.push([tabId, c.cmd]);
      }),
      tabUrl: async () => 'https://bank.test/login',
      setBadge: (tabId, on) => void badges.push([tabId, on]),
      // Each call is 5 s later, so navigations aren't mistaken for instant URL rewrites.
      now: () => (clock += 5_000),
    };
    return { manager: new RecorderManager(deps), get: () => stored, controls, badges };
  }

  it('records only the session tab, re-attaches after loads and stops cleanly', async () => {
    const { manager, get, controls, badges } = setup();
    await manager.start({ url: 'https://shop.test/' });
    expect(get()).toMatchObject({ tabId: 42, status: 'recording', steps: [{ type: 'openUrl' }] });
    expect(await manager.isRecordingTab(42)).toBe(true);
    expect(await manager.isRecordingTab(7)).toBe(false);

    await manager.onTabComplete(42);
    await manager.record(7, { kind: 'click', locator: css('#x'), label: 'other tab', at: 6000 });
    await manager.record(42, { kind: 'click', locator: css('#y'), label: 'mine', at: 6000 });
    expect(get()!.steps.map((s) => s.type)).toEqual(['openUrl', 'click']);

    await manager.stop();
    expect(get()!.status).toBe('stopped');
    expect(await manager.isRecordingTab(42)).toBe(false);
    await manager.record(42, { kind: 'click', locator: css('#z'), label: 'after stop', at: 7000 });
    expect(get()!.steps).toHaveLength(2);
    expect(controls).toEqual([
      [42, 'start'],
      [42, 'stop'],
    ]);
    expect(badges).toEqual([
      [42, true],
      [42, false],
    ]);
  });

  it('refuses a second recording and starts on an existing tab immediately', async () => {
    const { manager, controls, get } = setup();
    await manager.start({ tabId: 3 });
    expect(controls).toEqual([[3, 'start']]);
    expect(get()!.startUrl).toBe('https://bank.test/login');
    await expect(manager.start({ url: 'https://x.test/' })).rejects.toThrow('already in progress');
    await manager.discard();
    expect(get()).toBeUndefined();
  });

  it('reports sites it cannot attach to instead of failing', async () => {
    const { manager, get } = setup({ failAttach: new FlowError('PERMISSION_DENIED', 'no access', true) });
    await manager.start({ tabId: 3 });
    expect(get()).toMatchObject({ status: 'recording', blockedHost: 'bank.test' });
  });

  it('stops when the recorded tab is closed', async () => {
    const { manager, get } = setup();
    await manager.start({ tabId: 3 });
    await manager.onTabClosed(3);
    expect(get()!.status).toBe('stopped');
  });

  it('serializes concurrent events without losing any', async () => {
    const { manager, get } = setup();
    await manager.start({ tabId: 3 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => manager.record(3, { kind: 'click', locator: css(`#b${i}`), label: '', at: 10_000 + i * 1000 })));
    expect(get()!.steps.filter((s) => s.type === 'click')).toHaveLength(20);
  });

  it('only accepts navigation to web pages', async () => {
    const { manager, get } = setup();
    await manager.start({ tabId: 3 });
    await manager.onTabUrl(3, 'chrome://settings');
    await manager.onTabUrl(3, 'https://next.test/');
    expect(get()!.steps.map((s) => s.type === 'openUrl' && s.params.url)).toEqual(['https://bank.test/login', 'https://next.test/']);
  });
});

