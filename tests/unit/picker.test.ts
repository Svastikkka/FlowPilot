import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeElement, similarLocator, startPicker } from '../../src/content/picker';
import type { PickResultData } from '../../src/content/picker';
import { findAll } from '../../src/content/locator';
import { PickerManager } from '../../src/background/pickerManager';
import type { PickerDeps } from '../../src/background/pickerManager';
import type { PickResult } from '../../src/shared/pickerProtocol';
import { FlowError } from '../../src/shared/errors';

describe('describeElement', () => {
  it('names elements the way a non-technical user would', () => {
    document.body.innerHTML = `
      <button id="b">  Save changes </button>
      <a id="a" href="/docs">Documentation</a>
      <label for="e">Work e-mail</label><input id="e" type="email">
      <label><input id="c" type="checkbox"> I agree</label>
      <select id="s" aria-label="Plan"><option>Free</option></select>
      <input id="sub" type="submit" value="Send">
      <h2 id="h">Pricing</h2>
      <img id="i" alt="Company logo">
      <div id="d">Some text</div>`;
    const d = (id: string) => describeElement(document.getElementById(id)!);
    expect(d('b')).toBe('Button “Save changes”');
    expect(d('a')).toBe('Link “Documentation”');
    expect(d('e')).toBe('Field “Work e-mail”');
    expect(d('c')).toBe('Checkbox “I agree”');
    expect(d('s')).toBe('Dropdown “Plan”');
    expect(d('sub')).toBe('Button “Send”');
    expect(d('h')).toBe('Heading “Pricing”');
    expect(d('i')).toBe('Image “Company logo”');
    expect(d('d')).toBe('Text “Some text”');
  });
});

describe('similarLocator', () => {
  it('generalises one clicked item (or something inside it) to all similar items', () => {
    document.body.innerHTML = `
      <main><ul class="results">
        <li class="result"><h3>One</h3><span class="price">1</span></li>
        <li class="result"><h3>Two</h3><span class="price">2</span></li>
        <li class="result"><h3>Three</h3><span class="price">3</span></li>
      </ul><ul class="other"><li class="result">elsewhere</li></ul></main>`;
    const clickedInside = document.querySelectorAll('.price')[1];
    const sim = similarLocator(document, clickedInside);
    expect(sim.count).toBe(3);
    expect(sim.item.textContent).toContain('Two');
    // Scoped to the list that was clicked, not every li.result on the page.
    expect(findAll(document, sim.locator).map((e) => e.querySelector('h3')!.textContent)).toEqual(['One', 'Two', 'Three']);
  });

  it('handles table rows and custom elements', () => {
    document.body.innerHTML = `
      <table class="wikitable"><tbody><tr><td>A</td></tr><tr><td>B</td></tr></tbody></table>
      <div id="grid"><x-card>1</x-card><x-card>2</x-card><x-card>3</x-card><x-card>4</x-card></div>`;
    expect(similarLocator(document, document.querySelectorAll('td')[1]).count).toBe(2);
    const cards = similarLocator(document, document.querySelectorAll('x-card')[2]);
    expect(cards).toMatchObject({ count: 4, locator: { strategy: 'css', value: '#grid > x-card' } });
  });

  it('ignores generated class names and falls back to one element when nothing repeats', () => {
    document.body.innerHTML = `<div id="wrap"><p class="css-1x9q2z note">only</p></div>`;
    const sim = similarLocator(document, document.querySelector('p')!);
    expect(sim.count).toBe(1);
    expect(sim.locator.value).not.toContain('css-1x9q2z');
  });
});

describe('startPicker', () => {
  const handles: { stop(): void }[] = [];
  afterEach(() => handles.splice(0).forEach((h) => h.stop()));

  const setup = (mode: 'single' | 'multiple') => {
    document.body.innerHTML = `
      <form><button id="buy" type="submit">Buy now</button></form>
      <ul id="list"><li>a</li><li>b</li><li>c</li></ul>`;
    const picks: PickResultData[] = [];
    let cancelled = 0;
    const pageClicks = vi.fn();
    document.getElementById('buy')!.addEventListener('click', pageClicks);
    document.querySelector('form')!.addEventListener('submit', pageClicks);
    handles.push(startPicker(document, mode, (r) => picks.push(r), () => cancelled++));
    return { picks, cancelled: () => cancelled, pageClicks };
  };

  it('picks the clicked element without the page ever seeing the click', () => {
    const { picks, pageClicks } = setup('single');
    const buy = document.getElementById('buy')!;
    buy.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.getElementById('flowpilot-picker')!.shadowRoot!.querySelector('.tip')!.textContent).toBe('Button “Buy now”');
    buy.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(pageClicks).not.toHaveBeenCalled();
    expect(picks).toEqual([{ locator: { strategy: 'css', value: '#buy' }, description: 'Button “Buy now”', count: 1 }]);
    expect(document.getElementById('flowpilot-picker')).toBeNull();
  });

  it('in multiple mode picks all similar items', () => {
    const { picks } = setup('multiple');
    document.querySelectorAll('li')[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(picks[0]).toMatchObject({ locator: { value: '#list > li' }, count: 3, description: '3 items like List item “b”' });
  });

  it('cancels with Escape or the Cancel button', () => {
    const a = setup('single');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(a.cancelled()).toBe(1);
    expect(document.getElementById('flowpilot-picker')).toBeNull();
    const b = setup('single');
    (document.getElementById('flowpilot-picker')!.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
    expect(b.cancelled()).toBe(1);
    expect(b.picks).toEqual([]);
  });
});

describe('PickerManager', () => {
  function setup(opts: { failControl?: Error } = {}) {
    const results: PickResult[] = [];
    const activated: number[] = [];
    const alive = new Set<number>();
    let next = 10;
    const deps: PickerDeps = {
      tabAlive: async (id) => alive.has(id),
      createTab: vi.fn(async () => {
        const id = next++;
        alive.add(id);
        return id;
      }),
      waitLoaded: async () => undefined,
      activate: async (id) => void activated.push(id),
      control: vi.fn(async () => {
        if (opts.failControl) throw opts.failControl;
      }),
      saveResult: async (r) => void results.push(r),
    };
    return { manager: new PickerManager(deps), deps, results, activated, alive };
  }

  it('opens a page, returns the pick to the editor and reuses the tab next time', async () => {
    const { manager, deps, results, activated } = setup();
    await manager.start({ url: 'https://shop.test/', mode: 'single', requestId: 'p1', editorTab: 3 });
    expect(deps.createTab).toHaveBeenCalledWith('https://shop.test/');
    await manager.onMessage(99, { channel: 'flowpilot.picker', type: 'cancelled' }); // other tab: ignored
    await manager.onMessage(10, { channel: 'flowpilot.picker', type: 'picked', locator: { strategy: 'css', value: '#x' }, description: 'Button “X”', count: 1 });
    expect(results).toEqual([{ requestId: 'p1', locator: { strategy: 'css', value: '#x' }, description: 'Button “X”', count: 1 }]);
    expect(activated).toEqual([3]);

    await manager.start({ url: 'https://shop.test/', mode: 'multiple', requestId: 'p2', editorTab: 3 });
    expect(deps.createTab).toHaveBeenCalledTimes(1);
    expect(deps.control).toHaveBeenLastCalledWith(10, { channel: 'flowpilot.picker', cmd: 'start', mode: 'multiple' });
  });

  it('reports cancellation, a closed tab and failures to the editor', async () => {
    const { manager, results, alive } = setup();
    await manager.start({ url: 'https://shop.test/', mode: 'single', requestId: 'p1' });
    await manager.onMessage(10, { channel: 'flowpilot.picker', type: 'cancelled' });
    await manager.start({ mode: 'single', requestId: 'p2' });
    alive.delete(10);
    await manager.onTabClosed(10);
    expect(results).toEqual([
      { requestId: 'p1', cancelled: true },
      { requestId: 'p2', cancelled: true },
    ]);
    await expect(manager.start({ mode: 'single', requestId: 'p3' })).rejects.toThrow('Enter the page to pick on');

    const failing = setup({ failControl: new FlowError('PERMISSION_DENIED', 'FlowPilot does not have access to this site.', true) });
    await expect(failing.manager.start({ url: 'https://bank.test/', mode: 'single', requestId: 'p4' })).rejects.toThrow('does not have access');
    expect(failing.results).toEqual([{ requestId: 'p4', error: 'FlowPilot does not have access to this site.' }]);
  });
});
